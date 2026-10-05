import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { prisma, limparBanco, criarUsuario, criarOrganizacao } from './helpers.mjs';

// ==========================================================================
// O script que existe na imagem e o dado que ele lê precisam viajar juntos.
//
// O importador de campeonatos foi para produção sem o calendário: o Dockerfile
// enumera as cópias uma a uma, `data/` nasceu depois da última edição dele, e
// nada acusou. O deploy subiu verde e o script morreu com ENOENT em
// /app/data/campeonatos-2026.json — a falha só aparece quando alguém roda.
//
// Este arquivo fecha os dois lados: o empacotamento (o diretório entra na
// imagem, e o .dockerignore não o tira do contexto) e o comportamento do
// importador (acha o arquivo de qualquer diretório, e --dry-run não grava).
//
// Docker não está disponível neste ambiente, então a parte de empacotamento é
// verificada lendo o Dockerfile e o .dockerignore, não construindo a imagem.
// É uma prova mais fraca do que um build real e está dita aqui como tal.
// ==========================================================================

const RAIZ = process.cwd();
const dockerfile = readFileSync('Dockerfile', 'utf8');

// O estágio final é o que vira a imagem executada. Copiar no estágio `deps`
// não colocaria nada em produção.
const estagioDeRuntime = (() => {
  const partes = dockerfile.split(/^FROM\s+\S+\s+AS\s+runtime\s*$/m);
  if (partes.length !== 2) throw new Error('Dockerfile sem um único estágio "runtime": este teste precisa ser revisto junto com ele.');
  return partes[1];
})();

// Fontes de cada COPY do estágio de runtime — a última palavra da linha é o
// destino.
const origensCopiadas = [...estagioDeRuntime.matchAll(/^COPY(?:\s+--from=\S+)?\s+(.+)$/gm)]
  .flatMap(linha => linha[1].trim().split(/\s+/).slice(0, -1));

// Reprodução simplificada do casamento de padrões do .dockerignore: basta para
// os padrões que este repositório usa (nomes literais e `*` dentro de um
// segmento). Não substitui o build real; serve para acusar o dia em que
// alguém acrescentar uma linha que apague `data/` do contexto.
function excluidoDoContexto(caminho) {
  const escapar = texto => texto.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const segmentos = caminho.split('/');
  const prefixos = segmentos.map((_, i) => segmentos.slice(0, i + 1).join('/'));

  let excluido = false;
  for (const linha of readFileSync('.dockerignore', 'utf8').split('\n').map(l => l.trim())) {
    if (!linha || linha.startsWith('#')) continue;
    const negacao = linha.startsWith('!');
    const padrao = negacao ? linha.slice(1) : linha;
    const regex = new RegExp(`^${padrao.split('/').map(seg => seg.split('*').map(escapar).join('[^/]*')).join('/')}$`);
    if (prefixos.some(prefixo => regex.test(prefixo))) excluido = !negacao;
  }
  return excluido;
}

// O caminho não é redigitado aqui: a expressão é extraída do próprio
// importador e avaliada com o __dirname que ele teria. Se alguém mover o
// arquivo, o teste segue a mudança em vez de testar uma cópia desatualizada.
const caminhoQueOImportadorLe = (() => {
  const fonte = readFileSync('scripts/importar-campeonatos.js', 'utf8');
  const expressao = fonte.match(/^const ARQUIVO = (.+);$/m)?.[1];
  if (!expressao) throw new Error('constante ARQUIVO não encontrada no importador');
  return vm.runInNewContext(expressao, { path, __dirname: path.join(RAIZ, 'scripts') });
})();

describe('empacotamento do importador de campeonatos', () => {
  it('o arquivo que o importador lê existe no repositório e tem os 47 campeonatos', () => {
    const dados = JSON.parse(readFileSync(caminhoQueOImportadorLe, 'utf8'));
    expect(dados.eventos).toHaveLength(47);
  });

  it('o diretório desse arquivo é copiado para a imagem no estágio de runtime', () => {
    const relativo = path.relative(RAIZ, caminhoQueOImportadorLe);
    expect(relativo.startsWith('..'), `${relativo} está fora do repositório`).toBe(false);

    const diretorioDeTopo = relativo.split(path.sep)[0];
    expect(origensCopiadas, `o Dockerfile não copia "${diretorioDeTopo}": o script iria para a imagem sem o dado que lê`)
      .toContain(diretorioDeTopo);
  });

  it('o .dockerignore não tira esse arquivo do contexto de build', () => {
    const relativo = path.relative(RAIZ, caminhoQueOImportadorLe).split(path.sep).join('/');
    expect(excluidoDoContexto(relativo), `${relativo} está excluído do contexto: o COPY falharia no build`).toBe(false);
  });

  it('o script que lê o arquivo também é copiado — os dois viajam juntos ou nenhum serve', () => {
    expect(origensCopiadas).toContain('scripts');
    expect(excluidoDoContexto('scripts/importar-campeonatos.js')).toBe(false);
  });
});

describe('importador: localização do arquivo e --dry-run', () => {
  const executar = (args, cwd) => spawnSync(
    process.execPath,
    [path.join(RAIZ, 'scripts', 'importar-campeonatos.js'), ...args],
    { cwd, env: process.env, encoding: 'utf8', timeout: 120000 }
  );

  const contar = async () => ({
    eventos: await prisma.event.count(),
    temporadas: await prisma.rankingSeason.count(),
    auditoria: await prisma.auditLog.count()
  });

  let admin;

  beforeAll(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador da importação' });
    await criarOrganizacao(admin, { name: 'Muscle Contest Brasil' });
  });

  it('acha o arquivo rodando de OUTRO diretório — o caminho é relativo ao script, não ao cwd', async () => {
    const antes = await contar();
    // O diretório temporário do sistema não tem `data/` nenhum: se o importador
    // dependesse do cwd, este é o cenário que quebraria — e é o cenário do
    // Render, onde o processo não parte da raiz do projeto.
    const resultado = executar(['--dry-run'], path.parse(RAIZ).root);

    expect(resultado.stderr, 'o importador não localizou o arquivo').not.toMatch(/ENOENT|no such file/i);
    expect(resultado.status, `stdout: ${resultado.stdout}\nstderr: ${resultado.stderr}`).toBe(0);
    expect(resultado.stdout).toContain('ENSAIO — nada será gravado');
    expect(resultado.stdout).toMatch(/criados 47/);

    // A prova de que o ensaio é ensaio: nenhuma linha a mais em lugar nenhum,
    // nem sequer no log de auditoria.
    expect(await contar()).toEqual(antes);
  });

  it('--dry-run não cria nem a temporada — o efeito colateral mais fácil de passar batido', async () => {
    expect(await prisma.rankingSeason.count()).toBe(0);
    expect(await prisma.event.count()).toBe(0);
  });

  it('com mais de uma organização, recusa escolher sozinho e não grava nada', async () => {
    await criarOrganizacao(admin, { name: 'Segunda federação' });
    const antes = await contar();

    const resultado = executar([], RAIZ);

    expect(resultado.status).not.toBe(0);
    expect(resultado.stderr).toMatch(/Há 2 organizações/);
    expect(resultado.stderr).toMatch(/--organizacao=/);
    expect(await contar()).toEqual(antes);
  });

  it('só aceita DRAFT ou PLANNED: a importação não abre inscrição', () => {
    const resultado = executar(['--status=REGISTRATIONS_OPEN', '--dry-run'], RAIZ);
    expect(resultado.status).not.toBe(0);
    expect(resultado.stderr).toMatch(/--status aceita apenas DRAFT ou PLANNED/);
  });
});

describe('o calendário não pede migration nenhuma', () => {
  it('as migrations continuam sendo exatamente as já homologadas', () => {
    // Carregar o calendário é escrita em tabela existente: `Event` e
    // `RankingSeason` já existem desde 20260906120000. Uma migration nova
    // entrando junto com uma carga de dados seria mudança de schema disfarçada
    // de importação — esta lista só muda de propósito, com revisão.
    const migrations = readdirSync('prisma/migrations').filter(nome => /^\d{14}_/.test(nome)).sort();
    expect(migrations).toEqual([
      '20260906120000_mci_dominio_esportivo',
      '20260906130000_rls',
      '20260906180000_force_rls',
      '20260906190000_rls_conversa_estrita',
      '20260906200000_rls_politicas_por_comando',
      '20260906210000_rls_superficie_publica',
      '20260906220000_rls_autor_ve_o_proprio_conteudo',
      '20260906230000_cpf_em_tabela_propria',
      '20260906240000_pontuacao_overall_desempate',
      '20260906250000_classes_e_super_overall',
      '20260906260000_empresas_competidoras',
      '20260906270000_vinculo_unico_atleta_equipe',
      '20260906280000_pontos_do_campeonato_e_super_overall',
      // Entrou pela revisão que esta lista existe para exigir, e NÃO junto com
      // carga de dados: é a correção da recursão de política que derrubava o
      // messenger com stack depth exceeded. Muda schema (duas colunas de
      // array em "Conversation") porque a política de RLS passou a ler a
      // participação na própria linha, em vez de consultar a tabela que ela
      // protege. Ver o cabeçalho da migration e tests/rls-conversa-recursao.
      '20260913010000_rls_conversa_sem_recursao',
      // Cadastro completo. ADITIVA e nada além disso: dez colunas ANULÁVEIS,
      // nove em "User" (nascimento, telefone, WhatsApp, CEP, logradouro,
      // número, complemento, UF, cidade) e uma em "Athlete" (o número de
      // registro do atleta dentro da entidade de filiação). Sem DROP, sem
      // TRUNCATE, sem UPDATE, sem constraint e sem índice novo.
      //
      // Anuláveis porque as contas que já existem em produção nasceram antes
      // destes campos: a obrigatoriedade mora na validação do cadastro novo,
      // não no banco, e nenhuma linha precisou ser preenchida para trás.
      //
      // CPF NÃO entrou aqui, de propósito: continua isolado em
      // "AthleteIdentity", sob RLS e único por organização.
      '20260913170000_cadastro_completo',
      // Fila de aprovação de perfil de atleta. ADITIVA: um enum, uma tabela
      // nova com RLS FORÇADA desde o nascimento, seus índices e suas
      // políticas. NENHUMA política existente foi tocada — em especial
      // `atleta_criacao`, que continua exigindo `mci_operator_of`. A fila
      // existe justamente para NÃO precisar afrouxá-la: o usuário pede, o
      // operador da federação concede.
      '20260913190000_fila_de_perfil_de_atleta',
      // Descoberta de filiações para autocadastro. ADITIVA: UMA coluna em
      // `Organization` (`selfRegistrationOpen`, padrão `false`) e um índice
      // parcial. Nenhuma tabela criada, nenhuma apagada, nenhuma política de
      // RLS tocada.
      //
      // O padrão `false` é o ponto: a migration NÃO torna nenhuma federação
      // publicamente descobrível. Cada uma decide, por rota administrativa e
      // com auditoria. Reaproveitar `active` teria aberto todas de uma vez,
      // como efeito colateral de uma migration — que é exatamente o que não se
      // quer.
      '20260913220000_autocadastro_de_filiacao',
      // Filiação da época gravada no ponto de ranking. ADITIVA: DUAS colunas
      // ANULÁVEIS em "RankingPoint" (`affiliationId` e `affiliationNumber`),
      // um índice e uma chave estrangeira com ON DELETE SET NULL. Sem DROP,
      // sem TRUNCATE, sem UPDATE de linha existente, sem política de RLS
      // tocada.
      //
      // Anuláveis e SEM preenchimento retroativo, de propósito: os pontos que
      // já existem foram ganhos antes de a filiação ser registrada, e nulo é a
      // verdade sobre eles. Preenchê-los com a filiação ATUAL do atleta seria
      // exatamente o defeito que a coluna existe para corrigir — a troca de
      // federação reescrevendo o passado.
      '20260915190000_filiacao_no_ponto_de_ranking',
      // Reconhecimento por filiação + matrícula. ADITIVA: duas colunas
      // ANULÁVEIS em "MuscleWarImportItem" (`memberNumber` e
      // `suggestedAthleteId`), uma chave estrangeira com ON DELETE SET NULL e
      // dois índices — um deles em "Athlete"(affiliationId, affiliationNumber),
      // que é a chave de reconhecimento dos arquivos oficiais.
      //
      // `suggestedAthleteId` é coluna SEPARADA de `athleteId` de propósito:
      // sugestão por semelhança de nome não é vínculo, e mantê-las distintas
      // impede que algum caminho de aplicação confunda as duas.
      //
      // Nenhum DROP, nenhum UPDATE de linha existente, nenhuma política de RLS
      // tocada. Lotes já importados ficam exatamente como estão.
      '20260915210000_sugestao_de_atleta_na_importacao',
      // Critério do matching na revisão. ADITIVA: duas colunas ANULÁVEIS em
      // "MuscleWarImportItem" — `matchedBy` (qual chave reconheceu) e
      // `matchCandidates` (quem disputava, em CONFLICT). Sem índice, sem chave
      // estrangeira, sem UPDATE de linha existente, sem RLS tocada.
      //
      // Lotes já importados ficam com os dois campos nulos, que é a verdade
      // sobre eles: foram analisados por um motor que não registrava o
      // critério.
      '20260915230000_criterio_do_matching',
      // Um Overall por recorte, inclusive no recorte do EVENTO INTEIRO.
      // ADITIVA: um índice único PARCIAL em "EventOverallTitle"(eventId) onde
      // `categoryId IS NULL`.
      //
      // A unicidade `(eventId, categoryId)` não cobria esse caso: no
      // PostgreSQL dois NULL são distintos, e dois títulos gerais cabiam na
      // mesma tabela. A proteção mora no BANCO porque verificação em serviço
      // perde a corrida entre duas requisições simultâneas.
      //
      // Nenhuma coluna criada, nenhuma linha alterada, nenhuma RLS tocada.
      '20260916010000_um_overall_por_recorte',
      // Índice do ranking por posição. ADITIVA: um índice em
      // "Ranking"(seasonId, position, totalPoints, id), espelhando o ORDER BY
      // da leitura pública.
      //
      // Justificativa MEDIDA com EXPLAIN ANALYZE, e não presumida: a rota
      // pública fazia Seq Scan na temporada inteira para devolver cinco linhas
      // (2,43ms contra 0,045ms). A varredura cresce com a temporada; o índice
      // não. Nenhum índice removido, nenhuma linha alterada.
      '20260916120000_indice_do_ranking_por_posicao',
      // NS deixou de ser recusa e virou participação de zero ponto; a classe
      // composta da origem passou a ser lida como categoria + divisão + classe.
      '20260916130000_ns_e_classe_decomposta',
      // Invalidação administrativa de lançamento publicado. ADITIVA e nada
      // além disso: quatro colunas ANULÁVEIS em "RankingPoint" (voidedAt,
      // voidedById, voidReason, placingOriginal) e um índice PARCIAL sobre
      // voidedAt. Sem DROP, sem TRUNCATE, sem UPDATE de linha existente, sem
      // constraint nova e sem RLS tocada.
      //
      // Entrou pela revisão que esta lista existe para exigir, e NÃO junto com
      // carga de dados: o caminho interno já corrigia resultado publicado por
      // `ResultVersion`, mas o lançamento IMPORTADO não tinha como ser
      // corrigido nem invalidado sem apagar a participação do histórico. As
      // colunas são o registro de quem invalidou, por quê, e de onde a
      // colocação partiu — as duas peças de que a restauração precisa para
      // devolver o estado anterior em vez de recalcular às cegas.
      //
      // Anuláveis porque todo lançamento que já existe em produção nasceu
      // válido: nulo em voidedAt É o estado válido, e nenhuma linha precisou
      // ser preenchida para trás.
      '20260918030000_lancamento_invalidado',
      // Invalidar um lote de importação já aplicado. ADITIVA: um valor novo no
      // enum `ImportStatus` (INVALIDATED), três colunas ANULÁVEIS em
      // "MuscleWarImport" (quando, por quem, por quê), a chave estrangeira do
      // autor com ON DELETE SET NULL e um índice. Sem DROP, sem TRUNCATE, sem
      // UPDATE em linha existente, sem política de RLS tocada.
      //
      // INVALIDATED não substitui REJECTED, e a distinção é o motivo de a
      // migration existir: rejeitar é recusar ANTES de publicar; invalidar é
      // desfazer DEPOIS, e o lote precisa continuar no histórico dizendo qual
      // das duas coisas aconteceu. Um lote antigo segue válido com os três
      // campos nulos.
      '20260919160000_importacao_invalidada',
      // ADICIONADA na fase do histórico anterior ao cadastro. Ela é
      // estrutural e não cosmética, e por isso precisa de justificativa aqui:
      //
      // `ExternalResult.athleteId` e `RankingPoint.athleteId` eram NOT NULL.
      // Isso tornava IMPOSSÍVEL carregar o histórico oficial de um campeonato
      // antigo antes de os atletas se cadastrarem — e a única saída sem
      // migration seria criar atleta automaticamente, com CPF inventado e
      // carreiras de homônimos fundidas.
      //
      // A migration cria `ExternalAthlete` (a identidade esportiva externa,
      // separada da identidade de usuário do MCI), dá `organizationId` PRÓPRIO
      // às três tabelas do ledger — porque a tenancy delas era deduzida do
      // atleta, e o atleta passou a poder não existir —, cria a projeção
      // pública `PublicRankingEntry` e liga RLS com FORCE nas cinco.
      //
      // Nenhum dado é apagado: sem DROP de tabela, sem TRUNCATE, sem DELETE.
      // Cada backfill termina num bloco que conta órfãs e ABORTA a migration
      // se achar alguma, em vez de ligar RLS sobre linha sem dono.
      '20260920000000_identidade_externa_e_rls_do_ledger',
      // ADICIONADA para consertar um defeito da anterior, e o registro disso
      // importa mais do que o conserto: ao fechar o ledger para não-operadores,
      // a migration acima fechou também o ATLETA — e `GET /me/history` lê
      // `RankingPoint` com a sessão dele. A tela da carreira passou a devolver
      // vazio.
      //
      // Esta reabre a leitura para o DONO da linha, pelo mesmo padrão que
      // `AthleteProfileRequest` já usa. Só SELECT; escrita segue de operador.
      // `athleteId` nulo NÃO passa — e há teste dedicado a isso, porque o
      // resultado histórico sem dono não pode virar visível a qualquer
      // pessoa autenticada.
      '20260920120000_o_dono_le_o_proprio_historico',
      // Duas cláusulas incondicionais fechadas, e nenhuma coluna tocada.
      //
      // `AthleteTeamMembership` tinha `USING (true)` na leitura: o histórico de
      // equipe inteiro — datas, motivo de saída, quem registrou — era legível
      // por qualquer um, anônimo inclusive. `AuditLog` tinha `WITH CHECK
      // (true)`: a leitura era restrita e a ESCRITA não era conferida, então
      // uma linha podia ser gravada com o `userId` de outra pessoa.
      //
      // A auditoria também virou append-only: sem política de UPDATE e sem
      // política de DELETE, e sob FORCE RLS comando sem política é comando
      // negado — para o dono do schema inclusive.
      '20260921000000_vinculo_privado_e_auditoria_inforjavel',
      // A matrícula identifica UM atleta por (organização, filiação). Entra
      // pela revisão que esta lista existe para exigir.
      //
      // ADITIVA e DEFENSIVA: um índice único PARCIAL em ("organizationId",
      // "affiliationId", "affiliationNumber"), restrito às linhas em que os
      // dois últimos não são nulos — atleta sem filiação registrada continua
      // existindo aos montes, e nenhum deles é afetado. Nenhuma coluna criada,
      // nenhuma apagada, nenhuma política de RLS tocada.
      //
      // E ela NÃO CORRIGE DADO SOZINHA: antes de criar o índice, um bloco
      // `DO` procura duplicatas e ABORTA com a contagem e até vinte exemplos
      // se encontrar alguma. Em base que já carrega ambiguidade, qual dos dois
      // cadastros fica é decisão humana — a migration para e mostra, em vez de
      // escolher.
      '20260921120000_matricula_identifica_um_atleta',
      '20260922120000_taxonomia_de_categoria_e_classe',
      '20260922180000_ajuste_administrativo_de_pontos',
      // O CATÁLOGO OFICIAL DE CATEGORIAS. Ele estava só no seed, e `render.yaml`
      // roda `prisma migrate deploy` no pre-deploy — o seed nunca rodou em
      // produção, e `Category` nasceu vazia lá. A migration é `INSERT ... ON
      // CONFLICT DO NOTHING` com id fixo: não apaga, não reescreve, não toca
      // `RankingPoint`, e rodar de novo não duplica.
      '20260922210000_catalogo_oficial_de_categorias',
      // O TÍTULO OVERALL ALCANÇA O COMPETIDOR SEM CADASTRO. `athleteId` passa
      // a aceitar nulo, entra `externalAthleteId`, e um CHECK exige
      // EXATAMENTE UM dos dois. Aditiva e reversível: nenhum DROP, nenhum
      // DELETE, e todo título já gravado satisfaz o CHECK.
      '20260922230000_overall_do_historico_importado',
      // O ESTADO DO ATLETA: ATIVO, SUSPENSO, ARQUIVADO. `Athlete` não tinha
      // coluna de estado nenhuma, e a única forma de tirar alguém de
      // circulação era APAGAR — que leva o histórico esportivo junto.
      // Aditiva: `status` nasce ATIVO por default, sem UPDATE, e nenhum
      // cadastro existente muda de comportamento.
      '20260922234500_estado_do_atleta',
      // A MENSAGEM DE ABERTURA DA FEDERAÇÃO AOS SEUS ATLETAS. ADITIVA: duas
      // tabelas NOVAS — `AthleteNotice` e `AthleteNoticeRead` —, seus índices,
      // suas chaves estrangeiras e suas políticas de RLS, mais um helper novo
      // (`mci_atleta_da_organizacao`), que o conjunto não tinha: atleta não é
      // MEMBRO da organização, ele tem CADASTRO nela, e `mci_member_of` não
      // responde essa pergunta.
      //
      // Nenhuma coluna alterada, nenhuma linha tocada, nenhuma política
      // existente mexida. Tudo com IF NOT EXISTS, porque
      // `prisma migrate deploy` é o único passo do deploy em produção e rodar
      // duas vezes não pode quebrar.
      //
      // As duas tabelas nascem com ENABLE + FORCE ROW LEVEL SECURITY — e é por
      // isso que a contagem de `tests/rls-runtime` subiu de 28 para 30, no
      // mesmo commit e pela mesma razão.
      '20260923010000_mensagem_de_abertura_ao_atleta',

      // A CONTA DE SERVIÇO DA FEDERAÇÃO, em duas migrations e não uma.
      //
      // A primeira cria a coluna, a chave estrangeira, o índice único e a
      // restrição de coerência, e acrescenta o valor ao enum `UserRole`. A
      // segunda ensina `mci_operator_of` a reconhecê-lo.
      //
      // Estão SEPARADAS porque o PostgreSQL não deixa usar um valor de enum na
      // mesma transação em que ele foi acrescentado — juntá-las faria o deploy
      // falhar no primeiro ambiente limpo, que é exatamente onde ninguém quer
      // descobrir isso.
      //
      // Nenhuma das duas é destrutiva: só acrescentam. A `mci_operator_of`
      // ganha UM papel na lista e mantém a exigência de membresia NAQUELA
      // organização — nenhuma política foi afrouxada, nenhum FORCE removido.
      '20260923060000_conta_de_servico_da_federacao',
      '20260923060100_operator_of_reconhece_conta_de_servico',
      // F1 e F3 — o banco passa a concordar com o serviço. ADITIVA e de POLÍTICA:
      // substitui `comentario_leitura` e `atleta_alteracao`, e não cria, altera
      // nem apaga coluna, tabela, índice ou dado.
      //
      // `comentario_leitura` ganha as ramificações que `comentario_alteracao` já
      // reconhecia — moderação, autor do comentário e autor da PUBLICAÇÃO. Sem
      // elas, o soft delete gravava a linha que a política proibia e a rota
      // respondia 500 para todo ator autorizado (PostgreSQL 42501, medido).
      //
      // `atleta_alteracao` ganha o DONO no WITH CHECK, que é quem
      // `athleteService.update` já autorizava pela ramificação `ehODono`. Não é
      // afrouxamento: `"userId" = mci_current_user_id()` é avaliado na LINHA NOVA,
      // então o dono também não consegue reatribuir o atleta para outra conta.
      //
      // A proteção por COLUNA (filiação, matrícula, número de atleta, treinador,
      // academia, situação) continua sendo do serviço, via `camposRestritos` —
      // RLS é row-level e não compara coluna a coluna.
      '20260925070000_f1_f3_autorizacao_coerente',
      // T4/S6 — as quatro políticas que tinham `WITH CHECK = true`.
      //
      // `USING` diz quais linhas o ator alcança; `WITH CHECK` diz como a linha
      // NOVA pode ficar. Com `true`, quem alcançava uma linha podia reescrevê-la
      // em qualquer coisa — e, em política `FOR ALL`, inserir sem restrição
      // alguma, porque para o INSERT só o `WITH CHECK` vale.
      //
      // As quatro não tinham o mesmo risco, e espelhar o `USING` só serve em
      // uma: em `Conversation` isso bloquearia SAIR da conversa, em
      // `ConversationMember` não fecharia o auto-ingresso em conversa alheia, e
      // em `Notification` desligaria a notificação da plataforma, que existe
      // justamente para avisar OUTRA pessoa.
      //
      // Sobra UMA escrita ampla, agora declarada e isolada num policy de INSERT
      // (`notificacao_entrega`), com justificativa e controles compensatórios
      // escritos na própria migration. ADITIVA: substitui quatro políticas,
      // acrescenta uma quinta, e não cria, altera nem apaga coluna, tabela,
      // índice ou dado.
      '20260925230000_t4_with_check_coerente',
      // MÓDULO TREINADORES & EQUIPES — o modelo de dados.
      //
      // ADITIVA e reversível por omissão: acrescenta três enums, quatro tabelas
      // (`CoachDocument`, `CoachOrganization`, `TeamMembershipRequest`,
      // `CentralAuthorization`), colunas em `Coach` e `Team`, três CHECK de
      // coerência de estado e as políticas das tabelas novas — que nascem com
      // `ENABLE` e `FORCE ROW LEVEL SECURITY`. Não apaga nem renomeia nada.
      //
      // `Coach.status` nasce com `DEFAULT 'PENDING'` e as linhas EXISTENTES são
      // atualizadas para `APPROVED` na própria migration: os técnicos já
      // cadastrados continuam operando, e só os novos passam pela aprovação
      // central de R-03.
      '20260926020000_modulo_treinadores_equipes',
      // O TREINADOR PASSA A SER UM ATOR QUE O BANCO CONHECE.
      //
      // Cinco correções de política, todas medidas contra o comportamento real e
      // todas ADITIVAS no sentido de acrescentarem cláusula a política
      // existente, sem remover nenhuma das anteriores:
      //
      //   `Athlete` e `AthleteTeamMembership` passam a ser LEGÍVEIS pelo
      //   treinador aprovado e autorizado (antes: lista vazia no painel dele);
      //   `CoachOrganization` passa a ser ESCRITA pelo operador da própria
      //   federação, que é quem autoriza a atuação por R-04 (antes: 42501);
      //   `AthleteTeamMembership` aceita INSERT do PRÓPRIO atleta, porque é a
      //   confirmação dele que cria o vínculo (antes: 42501) — e o `FOR ALL`
      //   virou INSERT/UPDATE/DELETE separados justamente para que ele NÃO possa
      //   encerrar o vínculo sozinho;
      //   `AuditLog` aceita a trilha do treinador na federação em que ele atua
      //   (antes: a busca por matrícula não deixava rastro).
      '20260926040000_treinador_como_ator_de_rls',
      // O VÍNCULO POR CONFIRMAÇÃO EXIGE O CONVITE DAQUELA EQUIPE — achado A-04.
      //
      // Só política, nenhum schema: `vinculo_criacao` deixava o atleta gravar
      // vínculo para si em QUALQUER equipe, porque a cláusula dele não dizia nada
      // sobre `teamId`. Passa a exigir pedido PENDING daquela equipe para aquele
      // atleta. A cláusula do operador é reproduzida byte a byte, e
      // `vinculo_alteracao`/`vinculo_remocao` não são tocadas — o atleta continua
      // sem encerrar o próprio vínculo, que é o poder central de R-02.
      '20260927010000_vinculo_exige_pedido_pendente',
      // A LEITURA DE ATLETA PELO TREINADOR FICA MAIS ESTREITA — achado A-03.
      //
      // Só política e uma função nova: além de cadastro aprovado (R-03) e
      // autorização viva na federação (R-04), o treinador passa a precisar ser
      // RESPONSÁVEL POR ALGUMA EQUIPE daquela federação. Treinador sem equipe não
      // tem a quem listar nem para onde convidar — lia a federação inteira sem uso
      // legítimo para a leitura. As três cláusulas anteriores da política são
      // reproduzidas sem alteração.
      '20260927020000_leitura_de_atleta_pelo_treinador',
      // O CADASTRO LEGADO DE TREINADOR NÃO FICA APROVADO POR MIGRATION — A-05.
      //
      // ESCREVE DADO, e é a única deste conjunto que escreve. Devolve a `PENDING`
      // exatamente as linhas de `Coach` aprovadas SEM revisor e SEM data de
      // revisão — as que a migration 20260926020000 aprovou com um `UPDATE` sem
      // `WHERE`, contra R-03, que diz que quem aprova é a administração central.
      // `reviewedById`/`reviewedAt` só são escritos por `coachService.transicionar`,
      // então o predicado não alcança cadastro aprovado por pessoa. Idempotente.
      // Nenhuma tabela é criada, apagada ou renomeada; nenhuma política é tocada.
      '20260927030000_status_legado_de_treinador',
      // APROVAÇÃO AUTOMÁTICA DO CADASTRO DE TREINADOR (EQUIPE).
      //
      // ADITIVA: uma coluna ANULÁVEL em "Coach" (`autoApprovedAt`) e um índice
      // parcial sobre ela. Sem DROP, sem NOT NULL, sem alteração de tipo, sem
      // política tocada e sem escrita em linha nenhuma — nenhum cadastro antigo
      // é aprovado retroativamente por ela.
      //
      // A coluna existe porque três estados passaram a precisar ser DISTINGUÍVEIS:
      // aprovado por pessoa (tem revisor), aprovado automaticamente (tem esta
      // data e não tem revisor) e o legado que a migration 20260926020000 aprovou
      // sozinha (não tem nem um nem outro). Sem ela, a correção de A-05 não teria
      // como separar o segundo caso do terceiro.
      '20260927040000_aprovacao_automatica_de_treinador',
      // AUTORIZAÇÃO AUTOMÁTICA NA NPC — a federação oficial única.
      //
      // Acrescenta `autoGrantedAt` (coluna ANULÁVEL) e um índice parcial em
      // "CoachOrganization", e cria UMA política de INSERT.
      //
      // A POLÍTICA É O PONTO QUE EXIGE REVISÃO, e é por isso que esta linha tem
      // comentário: ela permite que o próprio treinador insira a autorização
      // dele, o que seria perigoso se não fosse conjuntiva. As cinco condições,
      // todas obrigatórias: status APPROVED, `grantedById` nulo, `autoGrantedAt`
      // preenchido, o treinador é o da conta que insere E está APPROVED, e a
      // organização é a dona da entidade oficial (Affiliation ativa com código
      // NPC) e está ativa. É só de INSERT: com `@@unique([coachId,
      // organizationId])`, autorização revogada não volta sozinha, e alterar a
      // linha continua exigindo operador. Nenhuma política existente foi tocada.
      '20260928010000_autorizacao_automatica_na_npc',
      // FOTO DE PERFIL OBRIGATÓRIA DO TREINADOR.
      //
      // ADITIVA: uma coluna ANULÁVEL em "Coach" (`photoKey`) e um índice parcial
      // de AUSÊNCIA, que serve ao aviso de regularização. Sem DROP, sem NOT NULL,
      // sem política tocada e sem escrita em linha nenhuma.
      //
      // Anulável de propósito: há treinadores cadastrados antes da decisão, e
      // `NOT NULL` recusaria toda linha deles. A obrigatoriedade vive na rota e no
      // serviço, que recusam o autocadastro sem arquivo.
      '20260928020000_foto_obrigatoria_do_treinador',
      // Correção administrativa de filiação: quatro colunas anuláveis em
      // `MuscleWarImportItem`, sem índice novo e sem reescrever linha. Entra
      // nesta lista porque a lista é a revisão — e esta migration foi revisada:
      // ela não muda o schema do calendário, que é o que este arquivo protege.
      '20261005110000_correcao_administrativa_de_filiacao',
      // A entidade também pode faltar na fonte: o caso real do Razor tem
      // `affiliationCode` NULO, porque o cabeçalho oficial de etapa NPC não tem
      // essa coluna e a filiação do lote ficou em branco. Uma coluna anulável,
      // revisada: não toca no schema do calendário.
      '20261005140000_corrigir_entidade_ausente'
    ]);
  });
});

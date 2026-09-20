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
      '20260920120000_o_dono_le_o_proprio_historico'
    ]);
  });
});

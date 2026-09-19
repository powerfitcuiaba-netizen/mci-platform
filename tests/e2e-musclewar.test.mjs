import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// Importação de resultados do MuscleWar: reconhecimento por CPF, confirmação
// por filiação, pré-visualização, vinculação manual, aplicação e idempotência.

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;

const CPF_A = gerarCpf(101010101);
const CPF_B = gerarCpf(202020202);
const CPF_DESCONHECIDO = gerarCpf(303030303);

// ============================================================================
// O LEDGER PASSOU A TER RLS DE OPERADOR.
//
// `prisma` sem contexto é ANÔNIMO, e anônimo não lê `RankingPoint` nem
// `ExternalResult` — antes desta fase essas tabelas não tinham política
// nenhuma, e a conferência direta funcionava por ausência de barreira.
//
// Ler pelo gerente NÃO afrouxa a conferência: é ela falando com a identidade
// que o produto exige para enxergar o ledger. Que o anônimo continua sem ver
// nada é asserção PRÓPRIA, em tests/rls-do-ledger.test.mjs — não se prova
// proteção no mesmo lugar em que se confere funcionalidade.
// ============================================================================
const noLedger = consulta => comoAtor(gerente, consulta);

const csv = linhas => ['external_result_id,cpf,atleta,filiacao,categoria,classe,colocacao,pontos,evento', ...linhas].join('\n');

async function importar(conteudo, extras = {}) {
  return api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId,
    seasonId,
    sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv',
    content: conteudo,
    ...extras
  });
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  const respostaFiliacao = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' });
  filiacao = respostaFiliacao.body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada MuscleWar 2026', year: 2026 });
  seasonId = temporada.body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }] });

  await criarAtleta(gerente, organizationId, { fullName: 'Atleta Reconhecida', cpf: CPF_A, affiliationId: filiacao.id });
  await criarAtleta(gerente, organizationId, { fullName: 'Atleta Sem Filiação', cpf: CPF_B });
});

describe('importação MuscleWar', () => {
  it('a conferência de pontos sabe que o bônus Overall exige a absoluta', async () => {
    // A temporada deste arquivo tem tabela PRÓPRIA (1º=100), cadastrada no
    // beforeAll: a conferência lê a tabela da temporada, não a homologada.
    //
    // REGRA VIGENTE: o +10 só existe na absoluta. Uma linha de Overall na OPEN
    // vale 100 + 10 = 110; a MESMA linha na NOVICE vale 100, porque o bônus
    // não é dela. Conferir sem olhar a classe daria o mesmo número nos dois
    // casos — e acusaria conflito num arquivo correto.
    const comOverall = linhas => ['external_result_id,cpf,atleta,filiacao,categoria,classe,colocacao,pontos,overall,evento', ...linhas].join('\n');

    const resposta = await importar(comOverall([
      `OV-1,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,110,sim,Etapa Overall`,
      `OV-2,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,NOVICE,1,100,sim,Etapa Overall`,
      `OV-3,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,NOVICE,1,110,sim,Etapa Overall`
    ]));
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const porId = Object.fromEntries(resposta.body.items.map(item => [item.externalResultId, item]));

    expect(porId['OV-1'].matchStatus, 'Overall na absoluta: 100 + 10 confere').toBe('MATCHED');
    expect(porId['OV-2'].matchStatus, 'Overall fora da absoluta: 100 confere').toBe('MATCHED');
    expect(porId['OV-3'].matchStatus, 'creditar +10 fora da absoluta é divergência').toBe('CONFLICT');
    expect(porId['OV-3'].reason).toMatch(/Pontuação divergente/);
    expect(porId['OV-3'].reason).toMatch(/calcula 100/);
  });

  it('pré-visualiza classificando cada linha antes de aplicar qualquer coisa', async () => {
    const resposta = await importar(csv([
      `MW-1,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa MuscleWar`,
      `MW-2,${CPF_DESCONHECIDO},Fulana Desconhecida,FED-MT,BIKINI,OPEN,2,80,Etapa MuscleWar`,
      `MW-3,${CPF_B},Atleta Sem Filiação,FED-MT,BIKINI,OPEN,3,60,Etapa MuscleWar`,
      `MW-4,${CPF_A},Atleta Reconhecida,FED-MT,CATEGORIA_INEXISTENTE,OPEN,1,100,Etapa MuscleWar`,
      `MW-5,000.000.000-00,CPF Ruim,FED-MT,BIKINI,OPEN,4,40,Etapa MuscleWar`,
      `,${CPF_A},Sem Identificador,FED-MT,BIKINI,OPEN,5,20,Etapa MuscleWar`
    ]));

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.summary).toEqual({
      totalRecords: 6,
      recognized: 1,
      pending: 1,
      conflicts: 2,
      duplicates: 0,
      rejected: 2,
      applied: 0,
      // MUDANÇA DE REGRA DESTA FASE, e não asserção afrouxada para passar.
      //
      // `valid` era `MATCHED`. O MCI carrega o histórico oficial ANTES de
      // existir cadastro de atleta: pendente de vínculo deixou de significar
      // "não dá para aplicar" e passou a significar "entra no histórico e
      // espera o dono". Com a conta antiga, um arquivo inteiro de um
      // campeonato antigo dava "Aplicar 0 resultado(s)" — o número estava
      // certo para uma regra que não é mais a do produto.
      //
      // O que continua FORA é o que sempre esteve: conflito, duplicata e
      // rejeitado. Aqui: 1 reconhecida + 1 pendente = 2 aplicáveis, e as 2
      // em conflito e as 2 rejeitadas seguem fora.
      applicable: 2,
      pendingLink: 1,
      valid: 2
    });

    const porId = Object.fromEntries(resposta.body.items.map(item => [item.externalResultId, item]));
    expect(porId['MW-1'].matchStatus).toBe('MATCHED');
    expect(porId['MW-2'].matchStatus).toBe('MATCH_PENDING');
    // ATUALIZADO com a cadeia de reconhecimento: o motivo deixou de citar só o
    // CPF porque o CPF deixou de ser a única chave. A linha continua indo para
    // revisão — o que mudou é que ela agora diz TODAS as chaves que falharam.
    expect(porId['MW-2'].reason).toMatch(/não encontrado por CPF, filiação\/matrícula ou nome/);
    // Filiação divergente é conflito para revisão, não descarte.
    expect(porId['MW-3'].matchStatus).toBe('CONFLICT');
    expect(porId['MW-3'].reason).toMatch(/sem filiação/i);
    expect(porId['MW-4'].matchStatus).toBe('CONFLICT');
    expect(porId['MW-4'].reason).toMatch(/Categoria desconhecida/);
    expect(porId['MW-5'].matchStatus).toBe('IMPORT_REJECTED');
    expect(porId['MW-5'].reason).toMatch(/CPF inválido/);

    // Nada foi aplicado na pré-visualização.
    expect(await noLedger(tx => tx.externalResult.count())).toBe(0);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(0);
  });

  it('nunca cria atleta a partir de CPF desconhecido', async () => {
    const antes = await prisma.athlete.count();
    await importar(csv([`MW-10,${CPF_DESCONHECIDO},Fulana Desconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    expect(await prisma.athlete.count()).toBe(antes);
  });

  // ==========================================================================
  // ESTE TESTE MUDOU DE REGRA, e o nome dele mudou junto.
  //
  // Chamava-se "aplica só o reconhecido". Essa era a regra de um sistema que
  // já tinha cadastro de atletas. O MCI é novo e não tem: o histórico oficial
  // dos campeonatos antigos entra PRIMEIRO, e os atletas se cadastram depois.
  //
  // O que ele tranca agora é o contrário do que trancava: o pendente TAMBÉM
  // entra, pontua, e fica sem dono até alguém se cadastrar. E — o ponto que
  // não pode mudar nunca — NENHUM atleta é criado para isso acontecer.
  // ==========================================================================
  it('aplica o reconhecido E o pendente, sem criar atleta nenhum', async () => {
    const atletasAntes = await prisma.athlete.count();
    const lote = await importar(csv([
      `MW-20,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,,Etapa MuscleWar`,
      `MW-21,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,2,80,Etapa MuscleWar`
    ]));
    expect(lote.body.summary.recognized).toBe(1);
    expect(lote.body.summary.pending).toBe(1);
    expect(lote.body.summary.applicable).toBe(2);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
    expect(aplicacao.body.applied).toBe(2);

    // NENHUM ATLETA CRIADO. É a asserção que não pode ceder: a saída fácil
    // para "resultado sem cadastro" seria fabricar cadastro, com CPF inventado
    // e carreiras de homônimos fundidas.
    expect(await prisma.athlete.count()).toBe(atletasAntes);

    const pontos = await noLedger(tx => tx.rankingPoint.findMany({
      include: { externalResult: true }, orderBy: { placing: 'asc' }
    }));
    expect(pontos).toHaveLength(2);
    expect(pontos.every(ponto => ponto.source === 'MUSCLEWAR')).toBe(true);

    // Sem pontuação na origem, vale a tabela da temporada para a colocação.
    expect(pontos[0].points).toBe(100);
    expect(pontos[0].externalResult.externalId).toBe('MW-20');
    // A reconhecida tem dono; a pendente não tem, e tem identidade externa.
    expect(pontos[0].athleteId).not.toBeNull();
    expect(pontos[1].externalResult.externalId).toBe('MW-21');
    expect(pontos[1].athleteId).toBeNull();
    expect(pontos[1].externalAthleteId).not.toBeNull();

    // As duas têm organização PRÓPRIA — a tenancy deixou de ser deduzida do
    // atleta, que agora pode não existir.
    expect(pontos.every(ponto => ponto.organizationId === organizationId)).toBe(true);

    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items[0].totalPoints).toBe(100);
    // O competidor sem cadastro APARECE no ranking, com o nome da fonte.
    const semCadastro = ranking.body.items.find(linha => linha.athlete?.id == null);
    expect(semCadastro, 'o pendente precisa aparecer no ranking').toBeTruthy();
    expect(semCadastro.athlete.fullName).toBe('Fulana');
    expect(semCadastro.athlete.pendingLink).toBe(true);

    const revisao = await api().get(`/api/v1/musclewar/imports/${lote.body.import.id}`).set(gerente.auth());
    expect(revisao.body.summary.applied).toBe(2);
  });

  it('reimportar o mesmo resultado não duplica pontuação', async () => {
    const linha = `MW-30,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa MuscleWar`;

    const primeiro = await importar(csv([linha]));
    await api().post(`/api/v1/musclewar/imports/${primeiro.body.import.id}/apply`).set(gerente.auth());

    // Segundo lote com o mesmo identificador externo: já sai como duplicado.
    const segundo = await importar(csv([linha]));
    expect(segundo.body.summary.duplicates).toBe(1);
    expect(segundo.body.summary.recognized).toBe(0);

    const aplicacaoRecusada = await api().post(`/api/v1/musclewar/imports/${segundo.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacaoRecusada.status).toBe(422);
    expect(aplicacaoRecusada.body.error.code).toBe('NOTHING_TO_APPLY');

    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(1);
    expect(await noLedger(tx => tx.externalResult.count())).toBe(1);

    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items[0].totalPoints).toBe(100);
  });

  it('identificador repetido dentro do mesmo arquivo conta uma vez só', async () => {
    const linha = `MW-40,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`;
    const lote = await importar(csv([linha, linha]));

    expect(lote.body.summary.recognized).toBe(1);
    expect(lote.body.summary.duplicates).toBe(1);

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(1);
  });

  it('vinculação manual resolve a pendência e libera a aplicação', async () => {
    const lote = await importar(csv([`MW-50,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    const pendente = lote.body.items[0];
    expect(pendente.matchStatus).toBe('MATCH_PENDING');

    // O CPF vive em AthleteIdentity, cuja política exige operador da
    // organização — daí o cenário ser montado em nome do gerente.
    const atleta = await comoAtor(gerente, tx => tx.athleteIdentity.findFirst({ where: { cpf: CPF_A } }));

    const vinculo = await api().post(`/api/v1/musclewar/items/${pendente.id}/link`).set(gerente.auth())
      .send({ athleteId: atleta.athleteId });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(200);
    expect(vinculo.body.matchStatus).toBe('MATCHED');
    expect(vinculo.body.reason).toMatch(/CPF da origem difere/);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.body.applied).toBe(1);

    const ponto = await noLedger(tx => tx.rankingPoint.findFirst());
    expect(ponto.athleteId).toBe(atleta.athleteId);
  });

  // ==========================================================================
  // Pendência resolvida DEPOIS de o lote já ter sido aplicado.
  //
  // Achado sondando a plataforma de pé: o `apply` promete no próprio
  // comentário que "pendências e conflitos ficam para revisão e podem ser
  // aplicados depois, no mesmo lote" — mas a vinculação recusava lote
  // aplicado, e a linha ficava presa para sempre. O operador aplicava para
  // aproveitar as linhas boas, cadastrava depois o atleta que faltava, e não
  // tinha como voltar: o resultado se perdia em silêncio.
  // ==========================================================================
  // O CENÁRIO MUDOU DE FORMA, e o defeito que ele guarda mudou junto.
  //
  // Antes: a linha pendente NÃO entrava no apply, e o defeito era ela ficar
  // presa para sempre depois que o lote era aplicado.
  //
  // Agora ela entra — vira resultado histórico SEM DONO. O defeito que este
  // teste guarda passou a ser outro, e pior: vincular o dono depois poderia
  // criar um SEGUNDO lançamento, e o mesmo resultado pontuaria duas vezes.
  // Por isso o que se mede aqui é que o total de lançamentos NÃO MUDA.
  it('resultado aplicado sem dono ganha dono depois, sem virar ponto novo', async () => {
    const lote = await importar(csv([
      `MW-70,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`,
      `MW-71,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,2,80,Etapa`
    ]));
    const importId = lote.body.import.id;

    const primeira = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
    expect(primeira.body.applied).toBe(2);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(2);

    // A linha sem dono está APLICADA — não "pendente de aplicação". A
    // pendência que resta é de VÍNCULO, que é outra coisa.
    const semDono = (await api().get(`/api/v1/musclewar/imports/${importId}`).set(gerente.auth()))
      .body.items.find(item => item.externalResultId === 'MW-71');
    expect(semDono.matchStatus).toBe('APPLIED');
    expect(semDono.athleteId).toBeNull();

    const pontosAntes = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));
    const totalAntes = pontosAntes.reduce((soma, ponto) => soma + ponto.points, 0);

    const atleta = await comoAtor(gerente, tx => tx.athleteIdentity.findFirst({ where: { cpf: CPF_A } }));
    const vinculo = await api().post(`/api/v1/musclewar/items/${semDono.id}/link`).set(gerente.auth())
      .send({ athleteId: atleta.athleteId });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(200);

    // NENHUM LANÇAMENTO NOVO, e nenhum ponto a mais nem a menos.
    const pontosDepois = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));
    expect(pontosDepois).toHaveLength(2);
    expect(pontosDepois.reduce((soma, ponto) => soma + ponto.points, 0)).toBe(totalAntes);
    // O mesmo lançamento, com o mesmo id: ele mudou de dono, não foi refeito.
    expect(pontosDepois.map(ponto => ponto.id).sort())
      .toEqual(pontosAntes.map(ponto => ponto.id).sort());
    expect(pontosDepois.every(ponto => ponto.athleteId != null)).toBe(true);

    // E o apply não tem mais nada para fazer: não sobrou candidato.
    const segunda = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
    expect(segunda.status).toBe(422);
    expect(segunda.body.error.code).toBe('NOTHING_TO_APPLY');
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(2);
  });

  it('reaplicar sem nada novo não pontua de novo', async () => {
    const lote = await importar(csv([`MW-80,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    const importId = lote.body.import.id;

    await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(1);

    const repetida = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());

    expect(repetida.status).toBe(422);
    expect(repetida.body.error.code).toBe('NOTHING_TO_APPLY');
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(1);
  });

  it('lote rejeitado não aceita vinculação', async () => {
    const lote = await importar(csv([`MW-90,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    const importId = lote.body.import.id;
    const pendente = lote.body.items[0];

    await api().post(`/api/v1/musclewar/imports/${importId}/reject`).set(gerente.auth())
      .send({ reason: 'Planilha enviada por engano pela federação' });

    const atleta = await comoAtor(gerente, tx => tx.athleteIdentity.findFirst({ where: { cpf: CPF_A } }));
    const vinculo = await api().post(`/api/v1/musclewar/items/${pendente.id}/link`).set(gerente.auth())
      .send({ athleteId: atleta.athleteId });

    expect(vinculo.status).toBe(422);
    expect(vinculo.body.error.code).toBe('IMPORT_REJECTED');
  });

  it('registra na auditoria quem importou, quem revisou e quem aplicou', async () => {
    const lote = await importar(csv([`MW-60,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const trilha = await api().get('/api/v1/audit').set(admin.auth()).query({ entity: 'MuscleWarImport' });
    const acoes = trilha.body.items.map(item => item.action);

    expect(acoes).toContain('MUSCLEWAR_IMPORT');
    expect(acoes).toContain('MUSCLEWAR_APPLY');

    const aplicacao = trilha.body.items.find(item => item.action === 'MUSCLEWAR_APPLY');
    expect(aplicacao.userEmail).toBe(gerente.email);
    expect(aplicacao.metadata.applied).toBe(1);
    expect(aplicacao.metadata.sourceRef).toBeTruthy();

    // Histórico de importação não é apagado em silêncio.
    const historico = await comoAtor(gerente, async tx => ({
      lotes: await tx.muscleWarImport.count(),
      itens: await tx.muscleWarImportItem.count()
    }));
    expect(historico.lotes).toBe(1);
    expect(historico.itens).toBe(1);
  });

  it('recusa importação de quem não tem a permissão', async () => {
    const intruso = await criarUsuario({ name: 'Atleta comum' });
    const resposta = await api().post('/api/v1/musclewar/imports').set(intruso.auth())
      .send({ organizationId, seasonId, sourceType: 'CSV', sourceRef: 'x.csv', content: csv([`MW-70,${CPF_A},X,FED-MT,BIKINI,OPEN,1,100,E`]) });

    expect(resposta.status).toBe(403);
  });

  it('recusa importação para organização de outro tenant', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Outro Admin' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Outra Federação' });

    const resposta = await api().post('/api/v1/musclewar/imports').set(gerente.auth())
      .send({ organizationId: outraOrg.id, sourceType: 'CSV', sourceRef: 'x.csv', content: csv([`MW-80,${CPF_A},X,FED-MT,BIKINI,OPEN,1,100,E`]) });

    expect(resposta.status).toBe(403);
  });

  it('colocação fora da tabela NÃO é conflito: do 6º em diante vale zero', async () => {
    // REGRA HOMOLOGADA (fase 11.3): a tabela vai até o 5º e a partir do 6º a
    // colocação vale zero. Tratar isso como conflito obrigaria o operador a
    // cadastrar pontuação para colocações que a regra manda não pontuar — e a
    // linha é um resultado legítimo, que precisa entrar no histórico.
    const lote = await importar(csv([`MW-90,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,9,,Etapa`]));
    expect(lote.body.items[0].matchStatus).toBe('MATCHED');

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const [ponto] = await comoAtor(gerente, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(ponto.placing).toBe(9);
    expect(ponto.points, 'do 6º em diante, zero — não um valor extrapolado').toBe(0);
    expect(ponto.superOverallPoints).toBe(0);
  });

  it('temporada SEM tabela nenhuma continua sendo conflito', async () => {
    // O caso que a guarda existe para pegar: não há regra a aplicar, e atribuir
    // zero a todo mundo seria inventar um resultado.
    const semTabela = await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId, name: unico('Temporada sem tabela'), year: 2027 });

    // Temporada nova nasce com a tabela homologada; aqui ela é esvaziada de
    // propósito, para exercitar exatamente o caso que a guarda protege.
    await comoAtor(admin, tx => tx.rankingPointsRule.deleteMany({ where: { seasonId: semTabela.body.id } }));

    const lote = await importar(
      csv([`MW-91,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,,Etapa`]),
      { seasonId: semTabela.body.id }
    );

    expect(lote.body.items[0].matchStatus).toBe('CONFLICT');
    expect(lote.body.items[0].reason).toMatch(/sem tabela de pontuação/);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// CORREÇÃO ADMINISTRATIVA DE FILIAÇÃO — o caso real do Razor.
//
// O QUE ACONTECEU DE VERDADE
//
// No arquivo oficial do Razor o atleta veio como "Lucas Gouveia", filiação
// NPC + 2952. O cadastro correto no MCI é "Lucas Gouveia Lima", NPC + 2932.
// Um dígito trocado na fonte.
//
// O sistema NÃO vinculou, e acertou: nome não identifica ninguém. Vincular
// "Lucas Gouveia" a "Lucas Gouveia Lima" por semelhança creditaria pontos de
// campeonato a quem talvez não fosse a pessoa — e esse erro nenhuma revisão
// posterior desfaz, porque os pontos já estariam somando no ranking de outro.
//
// O QUE ESTE ARQUIVO TRANCA
//
// Que exista uma porta administrativa para corrigir o DÍGITO, e que ela:
//   * NUNCA perca o que a fonte escreveu;
//   * NUNCA use nome como critério;
//   * não crie atleta, resultado, lançamento nem ledger duplicados;
//   * seja idempotente — repetir não pode doer;
//   * funcione em linha JÁ APLICADA, que é o caso difícil e o caso real;
//   * recuse quem não tem permissão, no SERVIDOR.
//
// O QUE ELE NÃO TESTA, de propósito: a regra de identidade em si. Ela já está
// provada em `identidade-por-matricula` e `matricula-identifica-um-atleta`.
// ============================================================================

let admin;
let gerente;
let semPermissao;
let organizationId;
let seasonId;
let npc;

const noLedger = consulta => comoAtor(gerente, consulta);

// O cabeçalho REAL dos arquivos oficiais de etapa NPC não tem coluna de
// entidade — a filiação do lote é que a declara. Aqui ela vem na coluna porque
// o que está sob teste é a CORREÇÃO, não o parser.
const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

async function criarEvento(nome) {
  const evento = await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: nome, slug: unico('ev'),
    startDate: '2026-10-03T12:00:00.000Z', seasonId
  });
  expect(evento.status, JSON.stringify(evento.body).slice(0, 300)).toBe(201);
  return evento.body;
}

async function importarEAplicar(conteudo, { eventId = null } = {}) {
  const criado = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('razor') + '.csv', content: conteudo,
    ...(eventId ? { eventId } : {})
  });
  expect([200, 201], JSON.stringify(criado.body).slice(0, 300)).toContain(criado.status);
  const importId = criado.body.import?.id ?? criado.body.id;
  const aplicado = await api()
    .post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
  expect([200, 201], JSON.stringify(aplicado.body).slice(0, 300)).toContain(aplicado.status);
  return importId;
}

const revisar = importId => api()
  .get(`/api/v1/musclewar/imports/${importId}`).set(gerente.auth());

async function primeiraLinha(importId) {
  const resposta = await revisar(importId);
  expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
  return resposta.body.items[0];
}

const validar = (itemId, corpo, ator = gerente) => api()
  .post(`/api/v1/musclewar/items/${itemId}/affiliation/validate`).set(ator.auth()).send(corpo);

const corrigir = (itemId, corpo, ator = gerente) => api()
  .post(`/api/v1/musclewar/items/${itemId}/affiliation/fix`).set(ator.auth()).send(corpo);

const historicoImportado = athleteId => api()
  .get(`/api/v1/athletes/${athleteId}/imported-history`).set(admin.auth());

// O RETRATO DO LEDGER. É ele que não pode mudar de tamanho por causa de uma
// correção de ponteiro — nem na primeira execução, nem na segunda.
const retratoDoLedger = () => noLedger(async tx => {
  const pontos = await tx.rankingPoint.findMany({
    where: { organizationId },
    select: { id: true, athleteId: true, points: true, externalResultId: true },
    orderBy: { id: 'asc' }
  });
  const resultados = await tx.externalResult.findMany({
    where: { organizationId }, select: { id: true, athleteId: true }, orderBy: { id: 'asc' }
  });
  const identidades = await tx.externalAthlete.findMany({
    where: { organizationId },
    select: { id: true, identityKey: true, affiliationNumber: true, athleteId: true, displayName: true },
    orderBy: { id: 'asc' }
  });
  const atletas = await tx.athlete.count({ where: { organizationId } });
  return {
    pontos: pontos.length,
    idsDosPontos: pontos.map(p => p.id),
    totalDePontos: pontos.reduce((soma, p) => soma + p.points, 0),
    pontosComDono: pontos.filter(p => p.athleteId).length,
    resultados: resultados.length,
    identidades,
    atletas
  };
});

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Correção' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  // Conta da MESMA organização, SEM `musclewar.review`. É ela que prova que a
  // recusa é de PERMISSÃO e não de organização — se fosse de outra federação, a
  // recusa não diria nada sobre o RBAC.
  //
  // `STAFF` foi escolhido por medição, não por palpite: `ROLE_PERMISSIONS` o
  // lista entre os papéis que não têm `musclewar.review`.
  semPermissao = await criarUsuario({ name: 'Sem Revisao' });
  await vincular(organizationId, semPermissao, 'STAFF');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC National Physique Committee', code: 'NPC' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [
      { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }
    ]
  });
});

// A LINHA DO RAZOR, como a fonte escreveu: nome curto, matrícula com o dígito
// trocado, primeiro lugar, campeão do Overall.
const LINHA_DO_RAZOR = (matricula = '2952') =>
  `RAZOR-${matricula}-MENS_BODYBUILDING,,Lucas Gouveia,${npc.code},${matricula},MENS_BODYBUILDING,OPEN,1,,Razor,sim`;

const cadastrarLucas = (extra = {}) => criarAtleta(gerente, organizationId, {
  fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(293293293), sex: 'MALE',
  affiliationId: npc.id, affiliationNumber: '2932', ...extra
});

// A LINHA DO RAZOR COMO ELA É DE VERDADE: sem entidade nenhuma.
//
// O cabeçalho oficial de etapa NPC não tem coluna de entidade, e a filiação do
// lote não foi preenchida — então `affiliationCode` nasce NULO. É este o caso
// que a primeira versão desta funcionalidade recusava.
const LINHA_SEM_ENTIDADE = (matricula = '2952') =>
  `RAZOR-${matricula}-MENS_BODYBUILDING,,Lucas Gouveia,,${matricula},MENS_BODYBUILDING,OPEN,1,,Razor,sim`;

// O cenário REAL: entidade ausente, matrícula com o dígito trocado, APPLIED
// sem dono, e o cadastro correto existindo em NPC + 2932.
async function cenarioRealDoRazor() {
  const lucas = await cadastrarLucas();
  const evento = await criarEvento('Razor');
  const importId = await importarEAplicar(csv([LINHA_SEM_ENTIDADE('2952')]), { eventId: evento.id });
  const item = await primeiraLinha(importId);

  expect(item.affiliationCode, 'ENTIDADE = — (a fonte não declarou)').toBeFalsy();
  expect(item.memberNumber, 'FILIAÇÃO = 2952').toBe('2952');
  expect(item.matchStatus, 'STATUS = APPLIED').toBe('APPLIED');
  expect(item.athleteId, 'e sem dono: o sistema não vinculou pelo nome').toBeFalsy();

  return { lucas, evento, importId, item };
}

// Monta o caso com entidade JÁ declarada pela fonte: só a matrícula está errada.
async function cenarioDoRazor() {
  const lucas = await cadastrarLucas();
  const evento = await criarEvento('Razor');
  const importId = await importarEAplicar(csv([LINHA_DO_RAZOR('2952')]), { eventId: evento.id });
  const item = await primeiraLinha(importId);

  expect(item.memberNumber, 'a fonte disse 2952').toBe('2952');
  expect(item.athleteId, 'e o sistema NÃO vinculou pelo nome').toBeFalsy();
  expect(item.matchStatus, 'a linha entrou no ledger sem dono').toBe('APPLIED');

  return { lucas, evento, importId, item };
}

// ======================================== §10 — O CASO REAL, PONTO A PONTO ===
describe('§10 o caso real: Razor 2952 → 2932', () => {
  it('1-7. vincula ao atleta certo, preserva os dois nomes, mantém 1º lugar e 15 pontos', async () => {
    const { lucas, item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '2932', motivo: 'dígito trocado na planilha da etapa' });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body.estado).toBe('ENCONTRADA');
    expect(resposta.body.athleteId, '1. vinculado ao atleta correto').toBe(lucas.id);

    // 2 e 3. OS DOIS NOMES SOBREVIVEM. O do cadastro é o oficial; o da fonte é
    // o que o arquivo escreveu, e ele é prova documental.
    const perfil = await api().get(`/api/v1/athletes/${lucas.id}`).set(admin.auth());
    expect(perfil.body.athlete.fullName, '2. o nome do cadastro não foi tocado').toBe('Lucas Gouveia Lima');

    const depoisDaLinha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(depoisDaLinha.athleteName, '3. o nome da fonte continua lá').toBe('Lucas Gouveia');
    expect(depoisDaLinha.memberNumber, 'e o número da fonte TAMBÉM').toBe('2952');
    expect(depoisDaLinha.correctedMemberNumber, '4. a filiação efetiva é a corrigida').toBe('2932');
    expect(depoisDaLinha.correctionReason).toBe('dígito trocado na planilha da etapa');
    expect(depoisDaLinha.correctedById).toBe(gerente.id);
    expect(depoisDaLinha.correctedAt).toBeTruthy();

    // 5 e 6. O HISTÓRICO MOSTRA O RAZOR, COM A COLOCAÇÃO.
    const historico = await historicoImportado(lucas.id);
    expect(historico.status).toBe(200);
    const resultados = historico.body.linked.flatMap(i => i.results);
    expect(resultados, '5. um resultado vinculado').toHaveLength(1);
    expect(resultados[0].placing, '6. primeiro lugar').toBe(1);
    expect(resultados[0].event?.name ?? resultados[0].eventName).toBe('Razor');

    // 7. PONTOS: 1º = 5, Overall = +10.
    const depois = await retratoDoLedger();
    expect(depois.totalDePontos, '7. 5 pela colocação + 10 do Overall').toBe(15);
    expect(depois.pontosComDono, 'e o ponto agora tem dono').toBe(1);

    // 8, 9, 10. NADA FOI DUPLICADO — os MESMOS ids, antes e depois.
    expect(depois.atletas, '8. nenhum atleta criado').toBe(antes.atletas);
    expect(depois.pontos, '9. nenhum RankingPoint criado').toBe(antes.pontos);
    expect(depois.idsDosPontos, 'são os MESMOS lançamentos').toEqual(antes.idsDosPontos);
    expect(depois.resultados, '10. nenhum ExternalResult criado').toBe(antes.resultados);
    expect(depois.identidades.length, 'nenhuma identidade nova').toBe(antes.identidades.length);
    expect(depois.totalDePontos, 'a pontuação não mudou de valor').toBe(antes.totalDePontos);
  });

  it('a identidade externa guarda o que a FONTE disse, e não a correção', async () => {
    const { lucas, item } = await cenarioDoRazor();
    await corrigir(item.id, { novaMatricula: '2932' });

    const { identidades } = await retratoDoLedger();
    expect(identidades, 'uma identidade só').toHaveLength(1);
    const [identidade] = identidades;

    // A chave é o RETRATO DA FONTE. Reescrevê-la para 2932 apagaria a evidência
    // do erro de digitação e colidiria com a chave única se já existisse
    // identidade para 2932.
    expect(identidade.affiliationNumber, 'a fonte declarou 2952').toBe('2952');
    expect(identidade.identityKey).toContain('2952');
    expect(identidade.identityKey).not.toContain('2932');
    expect(identidade.displayName, 'e o nome da fonte').toBe('Lucas Gouveia');
    expect(identidade.athleteId, 'o que mudou foi só o DONO').toBe(lucas.id);
  });

  it('11. a segunda execução não duplica nada, e diz que já estava aplicada', async () => {
    const { item } = await cenarioDoRazor();
    await corrigir(item.id, { novaMatricula: '2932' });
    const depoisDaPrimeira = await retratoDoLedger();

    const segunda = await corrigir(item.id, { novaMatricula: '2932' });
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyApplied, 'a segunda reconhece que já foi feita').toBe(true);
    expect(segunda.body.lancamentos).toBe(0);

    const depoisDaSegunda = await retratoDoLedger();
    expect(depoisDaSegunda).toEqual(depoisDaPrimeira);
  });
});

// ============== O CASO REAL, COM A ENTIDADE AUSENTE — É ESTE QUE IMPORTA ====
describe('o caso REAL do Razor: ENTIDADE — + 2952 → NPC + 2932', () => {
  it('1-10. informa a entidade, corrige a matrícula, vincula o APPLIED e não duplica nada', async () => {
    const { lucas, item } = await cenarioRealDoRazor();
    const antes = await retratoDoLedger();

    // A VALIDAÇÃO PRIMEIRO, como o operador faz na tela.
    const validacao = await validar(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    expect(validacao.status, JSON.stringify(validacao.body).slice(0, 400)).toBe(200);
    expect(validacao.body.estado).toBe('ENCONTRADA');
    expect(validacao.body.entity, 'a fonte não declarou entidade').toBeNull();
    expect(validacao.body.entityMissingInSource).toBe(true);
    expect(validacao.body.newEntity, 'a entidade informada pelo operador').toBe('NPC');
    expect(validacao.body.originalAffiliationNumber).toBe('2952');
    expect(validacao.body.newAffiliationNumber).toBe('2932');
    expect(validacao.body.candidatos).toHaveLength(1);
    expect(validacao.body.candidatos[0].fullName, '3. validado contra o cadastro, nunca pelo nome')
      .toBe('Lucas Gouveia Lima');

    // Validar NÃO escreve.
    expect(await retratoDoLedger()).toEqual(antes);

    // A CONFIRMAÇÃO.
    const resposta = await corrigir(item.id, {
      novaMatricula: '2932', novaEntidade: 'NPC',
      motivo: 'etapa sem coluna de entidade e dígito trocado na matrícula'
    });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body.estado).toBe('ENCONTRADA');
    expect(resposta.body.athleteId, '7. vinculado ao atleta correto').toBe(lucas.id);
    expect(resposta.body.originalEntity, 'a fonte não informou nada').toBeNull();
    expect(resposta.body.correctedEntity, '6. NPC registrada como entidade corrigida').toBe('NPC');
    expect(resposta.body.originalAffiliationNumber, '5. 2952 preservado').toBe('2952');
    expect(resposta.body.correctedAffiliationNumber).toBe('2932');

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.affiliationCode, '5. o nulo da fonte é PRESERVADO — é a prova da causa raiz').toBeNull();
    expect(linha.memberNumber, '5. e o 2952 também').toBe('2952');
    expect(linha.correctedAffiliationCode, '2 e 6. entidade corrigida: NPC').toBe('NPC');
    expect(linha.correctedMemberNumber, '2. filiação corrigida: 2932').toBe('2932');
    expect(linha.athleteId, '7. o resultado APPLIED agora tem dono').toBe(lucas.id);
    expect(linha.matchStatus, 'e continua APPLIED — não voltou a ser candidato').toBe('APPLIED');
    expect(linha.athleteName, '4. o nome da fonte não participou de nada').toBe('Lucas Gouveia');

    // 8, 9. NADA DUPLICADO, MESMOS IDs.
    const depois = await retratoDoLedger();
    expect(depois.atletas, '8. nenhum atleta criado').toBe(antes.atletas);
    expect(depois.resultados, '8. nenhum ExternalResult criado').toBe(antes.resultados);
    expect(depois.pontos, '8. nenhum RankingPoint criado').toBe(antes.pontos);
    expect(depois.idsDosPontos, '9. os MESMOS ids de lançamento').toEqual(antes.idsDosPontos);
    expect(depois.identidades.length, 'nenhuma identidade nova').toBe(antes.identidades.length);
    expect(depois.identidades[0].id, '9. a MESMA identidade externa').toBe(antes.identidades[0].id);
    expect(depois.totalDePontos, 'a pontuação não mudou de valor').toBe(antes.totalDePontos);
    expect(depois.totalDePontos, '1º lugar = 5 + Overall = 10').toBe(15);
    expect(depois.pontosComDono, 'e o ponto passou a ter dono').toBe(1);

    // O histórico do atleta mostra o Razor.
    const historico = await historicoImportado(lucas.id);
    const resultados = historico.body.linked.flatMap(i => i.results);
    expect(resultados).toHaveLength(1);
    expect(resultados[0].placing).toBe(1);
    expect(resultados[0].event?.name ?? resultados[0].eventName).toBe('Razor');
  });

  it('a identidade externa continua sendo o retrato da fonte: EXT:, sem entidade e sem número', async () => {
    const { lucas, item } = await cenarioRealDoRazor();
    await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });

    const { identidades } = await retratoDoLedger();
    expect(identidades).toHaveLength(1);
    const [identidade] = identidades;

    // Sem entidade na linha, `chaveDeIdentidade` produziu `EXT:` — e a correção
    // NÃO a reescreve. Reescrever apagaria a prova de que a fonte não declarou
    // entidade, que é a causa raiz de 408 históricos órfãos nesta base.
    expect(identidade.identityKey.startsWith('EXT:'), identidade.identityKey).toBe(true);
    expect(identidade.affiliationNumber, 'a identidade nasceu sem número').toBeNull();
    expect(identidade.displayName).toBe('Lucas Gouveia');
    expect(identidade.athleteId, 'o que mudou foi só o DONO').toBe(lucas.id);
  });

  it('10. a segunda execução não duplica nada e reconhece que já foi feita', async () => {
    const { item } = await cenarioRealDoRazor();
    await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    const depoisDaPrimeira = await retratoDoLedger();

    const segunda = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyApplied).toBe(true);
    expect(segunda.body.correctedEntity).toBe('NPC');
    expect(segunda.body.lancamentos).toBe(0);

    expect(await retratoDoLedger()).toEqual(depoisDaPrimeira);
  });

  it('10b. repetir SEM reinformar a entidade também é idempotente', async () => {
    // A entidade já está gravada na linha; omiti-la na segunda chamada não pode
    // fazer o serviço achar que é outra correção.
    const { item } = await cenarioRealDoRazor();
    await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    const depoisDaPrimeira = await retratoDoLedger();

    const segunda = await corrigir(item.id, { novaMatricula: '2932' });
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyApplied).toBe(true);
    expect(await retratoDoLedger()).toEqual(depoisDaPrimeira);
  });

  it('entidade informada mas matrícula que não existe: registra e não vincula', async () => {
    const { item } = await cenarioRealDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '888888', novaEntidade: 'NPC' });
    expect(resposta.status).toBe(200);
    expect(resposta.body.estado).toBe('NAO_ENCONTRADA');
    expect(resposta.body.athleteId).toBeNull();

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedAffiliationCode, 'a entidade informada fica registrada').toBe('NPC');
    expect(linha.correctedMemberNumber).toBe('888888');
    expect(linha.athleteId, 'e ninguém foi vinculado').toBeNull();
    expect(await retratoDoLedger()).toMatchObject({
      atletas: antes.atletas, pontos: antes.pontos, pontosComDono: antes.pontosComDono
    });
  });

  it('a auditoria registra entidade original NULA e entidade corrigida NPC', async () => {
    const { lucas, item } = await cenarioRealDoRazor();
    await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC', motivo: 'conferido na ficha' });

    const registros = await noLedger(tx => tx.auditLog.findMany({
      where: { organizationId, entityId: item.id }, orderBy: { createdAt: 'desc' }
    }));
    const daCorrecao = registros.find(r => r.metadata?.operacao === 'CORRECAO_DE_FILIACAO');
    expect(daCorrecao).toBeTruthy();
    expect(daCorrecao.metadata.entidadeOriginal, 'a fonte não informou — e isso fica escrito').toBeNull();
    expect(daCorrecao.metadata.entidadeCorrigida).toBe('NPC');
    expect(daCorrecao.metadata.entidade, 'a efetiva').toBe('NPC');
    expect(daCorrecao.metadata.filiacaoOriginal).toBe('2952');
    expect(daCorrecao.metadata.filiacaoCorrigida).toBe('2932');
    expect(daCorrecao.metadata.athleteIdAntes).toBeNull();
    expect(daCorrecao.metadata.athleteIdDepois).toBe(lucas.id);
    expect(daCorrecao.userId).toBe(gerente.id);
  });

  it('operador sem permissão não corrige nem informando a entidade', async () => {
    const { item } = await cenarioRealDoRazor();
    const antes = await retratoDoLedger();

    const operador = await criarUsuario({ name: 'Operador de Resultados' });
    await vincular(organizationId, operador, 'RESULTS_OPERATOR');

    const resposta = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' }, operador);
    expect(resposta.status).toBe(403);
    expect(await retratoDoLedger()).toEqual(antes);
  });
});

// ======================================== §2 — O PASSO DE VALIDAÇÃO ==========
describe('§2 validar antes de confirmar — e validar não escreve', () => {
  it('encontra o cadastro e devolve os dois números, sem gravar nada', async () => {
    const { lucas, item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await validar(item.id, { novaMatricula: '2932' });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
    expect(resposta.body.estado).toBe('ENCONTRADA');
    expect(resposta.body.entity).toBe('NPC');
    expect(resposta.body.originalAffiliationNumber).toBe('2952');
    expect(resposta.body.newAffiliationNumber).toBe('2932');
    expect(resposta.body.athleteNameFromSource).toBe('Lucas Gouveia');
    expect(resposta.body.candidatos).toHaveLength(1);
    expect(resposta.body.candidatos[0]).toMatchObject({ id: lucas.id, fullName: 'Lucas Gouveia Lima' });

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedMemberNumber, 'validar NÃO grava correção').toBeNull();
    expect(linha.athleteId, 'e NÃO vincula').toBeNull();
    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('a validação não devolve CPF nem contato do candidato', async () => {
    const { item } = await cenarioDoRazor();
    const { body } = await validar(item.id, { novaMatricula: '2932' });
    const serializado = JSON.stringify(body);
    expect(serializado).not.toMatch(/cpf/i);
    expect(serializado).not.toMatch(/\d{11}/);
    expect(serializado).not.toMatch(/phone|email/i);
  });

  it('número que não existe: a validação diz NAO_ENCONTRADA sem sugerir ninguém', async () => {
    const { item } = await cenarioDoRazor();
    const { body, status } = await validar(item.id, { novaMatricula: '999999' });
    expect(status).toBe(200);
    expect(body.estado).toBe('NAO_ENCONTRADA');
    expect(body.candidatos).toHaveLength(0);
  });
});

// ======================================== §11 — OS TESTES NEGATIVOS =========
// ============================================================================
// §5 — OS DEZ CASOS NEGATIVOS PEDIDOS, E ONDE CADA UM É MEDIDO.
//
//   1. entidade inválida ............. 'entidade com forma inválida é recusada
//                                      pelo schema' (422 VALIDATION_ERROR)
//   2. filiação inválida ............. 'matrícula vazia ou só espaço é recusada'
//                                      + 'zero à esquerda NÃO é removido'
//   3. entidade ausente obrigatória .. 'a fonte não declarou entidade E o
//                                      operador não informou' (422 ENTITY_REQUIRED)
//   4. conflito entidade+filiação .... 'C. duas identidades candidatas é
//                                      impossível: o banco recusa o par repetido'.
//                                      O ramo CONFLITO do serviço (409
//                                      AFFILIATION_NUMBER_AMBIGUOUS) é defensivo:
//                                      o índice UNIQUE parcial
//                                      Athlete(organizationId, affiliationId,
//                                      affiliationNumber) torna o estado
//                                      inalcançável, e o teste prova a recusa NO
//                                      BANCO em vez de encenar um estado que o
//                                      banco não admite.
//   5. operador sem musclewar.review . 'D. papel que o RLS admite mas o RBAC
//                                      não: 403 limpo, nas duas rotas'
//                                      (+ D1: papel que o RLS nem enxerga = 404)
//   6. sem autenticação .............. 'D2. sem token nenhum, as duas rotas
//                                      recusam antes de dizer se a linha existe'
//   7. cross-organization ............ 'E. operador de OUTRA organização não
//                                      alcança a linha'
//   8. resultado de outro atleta ..... 'B. resultado JÁ vinculado não troca de
//                                      dono' + §2.2 e §2.3 (409 ITEM_ALREADY_LINKED)
//   9. repetição ..................... '10. a segunda execução não duplica nada',
//                                      '10b. repetir SEM reinformar a entidade',
//                                      §2.1 (idempotente)
//  10. organizationId vindo do cliente 'E. … nem mandando organizationId' +
//                                      'G. corrigir não é editar nome'
// ============================================================================
describe('§11 o que a correção RECUSA', () => {
  it('A. nova filiação inexistente: registra a correção como pendente e NÃO vincula', async () => {
    const { item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '777777', motivo: 'conferido na ficha' });
    expect(resposta.status).toBe(200);
    expect(resposta.body.estado).toBe('NAO_ENCONTRADA');
    expect(resposta.body.athleteId, 'ninguém foi vinculado').toBeNull();

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedMemberNumber, 'a correção fica registrada').toBe('777777');
    expect(linha.memberNumber, 'o original continua intocado').toBe('2952');
    expect(linha.athleteId, 'e nenhum vínculo foi criado').toBeNull();

    const depois = await retratoDoLedger();
    expect(depois.atletas, 'nenhum atleta inventado').toBe(antes.atletas);
    expect(depois.pontosComDono, 'nenhum ponto ganhou dono').toBe(antes.pontosComDono);
  });

  it('B. resultado JÁ vinculado não troca de dono por correção de filiação', async () => {
    const lucas = await cadastrarLucas();
    const outro = await criarAtleta(gerente, organizationId, {
      fullName: 'Outro Atleta Qualquer', cpf: gerarCpf(515151515), sex: 'MALE',
      affiliationId: npc.id, affiliationNumber: '8888'
    });
    const evento = await criarEvento('Razor');
    // A linha entra JÁ reconhecida pelo 8888, portanto com dono.
    const importId = await importarEAplicar(csv([
      `RAZOR-8888-MENS_BODYBUILDING,,Outro Atleta,${npc.code},8888,MENS_BODYBUILDING,OPEN,1,,Razor,sim`
    ]), { eventId: evento.id });
    const item = await primeiraLinha(importId);
    expect(item.athleteId, 'a linha já tem dono').toBe(outro.id);

    const antes = await retratoDoLedger();
    const resposta = await corrigir(item.id, { novaMatricula: '2932' });
    expect(resposta.status, 'trocar o dono de um histórico publicado é outra operação').toBe(409);
    expect(resposta.body.error.code).toBe('ITEM_ALREADY_LINKED');

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.athleteId, 'o dono continua o mesmo').toBe(outro.id);
    expect(linha.correctedMemberNumber, 'e nada foi gravado').toBeNull();
    expect(await retratoDoLedger()).toEqual(antes);
    expect(lucas.id).not.toBe(outro.id);
  });

  it('C. duas identidades candidatas é impossível: o banco recusa o par repetido', async () => {
    await cadastrarLucas();
    // A unicidade parcial `(organizationId, affiliationId, affiliationNumber)`
    // existe desde `20260921120000_matricula_identifica_um_atleta`. É ELA que
    // torna AMBIGUOUS estruturalmente impossível pelo lado do cadastro — e é
    // isto que este teste prova, em vez de encenar um estado que o banco não
    // aceita. O ramo CONFLITO no serviço é guarda de falha fechada: se a
    // unicidade desaparecer, ele recusa em vez de escolher ao acaso.
    const duplicado = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'Homônimo Com Mesma Matrícula', cpf: gerarCpf(626262626),
      sex: 'MALE', affiliationId: npc.id, affiliationNumber: '2932'
    });
    expect([409, 422], JSON.stringify(duplicado.body).slice(0, 300)).toContain(duplicado.status);

    const quantos = await noLedger(tx => tx.athlete.count({
      where: { organizationId, affiliationId: npc.id, affiliationNumber: '2932' }
    }));
    expect(quantos, 'um par, um atleta').toBe(1);
  });

  it('D. papel que o RLS admite mas o RBAC não: 403 limpo, nas duas rotas', async () => {
    const { item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    // RESULTS_OPERATOR passa pelo RLS — `mci_operator_of` o lista — e NÃO tem
    // `musclewar.review` em `ROLE_PERMISSIONS`. É exatamente o ator que isola a
    // camada de RBAC: se a recusa viesse do banco, este teste não diria nada
    // sobre a autorização da aplicação.
    const operador = await criarUsuario({ name: 'Operador de Resultados' });
    await vincular(organizationId, operador, 'RESULTS_OPERATOR');

    expect((await validar(item.id, { novaMatricula: '2932' }, operador)).status, 'nem validar').toBe(403);
    expect((await corrigir(item.id, { novaMatricula: '2932' }, operador)).status, 'nem corrigir').toBe(403);

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedMemberNumber).toBeNull();
    expect(linha.athleteId).toBeNull();
    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('D1. papel que o RLS NÃO admite não enxerga a linha: 404, e isso é mais forte', async () => {
    const { item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    // STAFF é membro da organização e NÃO está em `mci_operator_of`. A política
    // de linha esconde o registro, então o serviço responde "não encontrado"
    // ANTES de haver pergunta de autorização.
    //
    // 404 aqui não é falha do RBAC: é defesa em profundidade. O banco recusou
    // primeiro, e a resposta não confirma nem desmente que a linha existe — que
    // é o comportamento desejado para quem não deveria saber.
    for (const caminho of [validar, corrigir]) {
      const resposta = await caminho(item.id, { novaMatricula: '2932' }, semPermissao);
      expect([403, 404], JSON.stringify(resposta.body).slice(0, 200)).toContain(resposta.status);
    }

    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('D2. sem token nenhum, as duas rotas recusam antes de dizer se a linha existe', async () => {
    const { item } = await cenarioDoRazor();
    for (const caminho of ['validate', 'fix']) {
      const resposta = await api()
        .post(`/api/v1/musclewar/items/${item.id}/affiliation/${caminho}`)
        .send({ novaMatricula: '2932' });
      expect(resposta.status, caminho).toBe(401);
    }
  });

  it('E. operador de OUTRA organização não alcança a linha, nem mandando organizationId', async () => {
    const { item } = await cenarioDoRazor();
    const antes = await retratoDoLedger();

    const forasteiro = await criarUsuario({ name: 'Gerente de Fora' });
    const outraOrg = await criarOrganizacao(admin, { name: 'Outra Federação' });
    await vincular(outraOrg.id, forasteiro, 'RANKING_MANAGER');

    // O `organizationId` vai no corpo DE PROPÓSITO: a rota não o aceita, e a
    // autorização é decidida pela organização do LOTE. Se o cliente pudesse
    // escolher, o isolamento de tenant seria decorativo.
    const resposta = await corrigir(item.id,
      { novaMatricula: '2932', organizationId: outraOrg.id }, forasteiro);
    expect([403, 404], JSON.stringify(resposta.body).slice(0, 300)).toContain(resposta.status);

    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('G. corrigir não é editar nome: campo de nome no corpo é ignorado', async () => {
    const { item } = await cenarioDoRazor();

    const resposta = await corrigir(item.id, {
      novaMatricula: '2932',
      athleteName: 'NOME QUE NINGUÉM AUTORIZOU',
      displayName: 'OUTRO NOME'
    });
    expect(resposta.status).toBe(200);

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.athleteName, 'o nome da fonte é intocável por esta porta').toBe('Lucas Gouveia');

    const { identidades } = await retratoDoLedger();
    expect(identidades[0].displayName).toBe('Lucas Gouveia');
  });

  it('matrícula vazia ou só espaço é recusada antes de qualquer consulta', async () => {
    const { item } = await cenarioDoRazor();
    for (const valor of ['', '   ']) {
      const resposta = await corrigir(item.id, { novaMatricula: valor });
      expect([400, 422], `"${valor}"`).toContain(resposta.status);
    }
  });

  it('zero à esquerda NÃO é removido: 02932 não encontra o 2932', async () => {
    const { item } = await cenarioDoRazor();

    // `Number('02932')` é 2932. Se a normalização convertesse para número, esta
    // correção acharia o Lucas — e fundiria duas matrículas que podem ser de
    // duas pessoas diferentes.
    const resposta = await corrigir(item.id, { novaMatricula: '02932' });
    expect(resposta.status).toBe(200);
    expect(resposta.body.estado, '02932 não é 2932').toBe('NAO_ENCONTRADA');
    expect(resposta.body.athleteId).toBeNull();

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedMemberNumber, 'o zero é preservado como vier').toBe('02932');
  });

  it('a fonte não declarou entidade E o operador não informou: recusa pedindo a entidade', async () => {
    // ESTE TESTE SUBSTITUI UM ANTERIOR, e a diferença é de REGRA, não de
    // conveniência: antes a linha sem entidade era INCORRIGÍVEL
    // (`ITEM_WITHOUT_ENTITY`). Isso recusava justamente o caso real do Razor.
    //
    // Agora a recusa só vale quando NINGUÉM informou a entidade — nem a fonte,
    // nem o operador. Continua sendo recusa correta: o número sozinho não
    // identifica ninguém, porque federações diferentes emitem o mesmo número.
    const { item } = await cenarioRealDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '2932' });
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('ENTITY_REQUIRED');

    expect(await retratoDoLedger()).toEqual(antes);
    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.correctedMemberNumber, 'nada foi gravado').toBeNull();
    expect(linha.correctedAffiliationCode).toBeNull();
  });

  it('§1 a fonte DECLAROU a entidade ERRADA: a troca é permitida e registrada', async () => {
    // ESTE TESTE SUBSTITUI UM ANTERIOR, e a mudança é de REGRA, não de
    // conveniência. Antes a troca de uma entidade declarada era recusada com
    // 409, pelo argumento de que "dizer que o resultado foi de outra federação
    // é outra afirmação". O argumento continua verdadeiro — e é por isso que a
    // troca agora é REGISTRADA com os dois valores, o motivo, o operador e a
    // hora, em vez de proibida. Proibir não fazia o erro da fonte desaparecer:
    // fazia o resultado ficar órfão para sempre.
    const outra = (await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: 'IFBB Brasil', code: 'IFBB' })).body;
    expect(outra.code).toBe('IFBB');

    const lucas = await cadastrarLucas();
    const evento = await criarEvento('Razor');
    // A fonte declarou IFBB e o número 7777 — os dois errados.
    const importId = await importarEAplicar(csv([
      `RAZOR-7777-MENS_BODYBUILDING,,Lucas Gouveia,${outra.code},7777,MENS_BODYBUILDING,OPEN,1,,Razor,sim`
    ]), { eventId: evento.id });
    const item = await primeiraLinha(importId);
    expect(item.affiliationCode, 'a fonte declarou IFBB').toBe('IFBB');
    expect(item.athleteId, 'e não casou com ninguém').toBeFalsy();

    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, {
      novaMatricula: '2932', novaEntidade: 'NPC', motivo: 'etapa lançada na federação errada'
    });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body.estado).toBe('ENCONTRADA');
    expect(resposta.body.athleteId).toBe(lucas.id);
    expect(resposta.body.originalEntity, 'a entidade da fonte é devolvida').toBe('IFBB');
    expect(resposta.body.correctedEntity).toBe('NPC');

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.affiliationCode, 'IFBB PRESERVADA como original').toBe('IFBB');
    expect(linha.memberNumber, '7777 PRESERVADO como original').toBe('7777');
    expect(linha.correctedAffiliationCode, 'NPC registrada como corrigida').toBe('NPC');
    expect(linha.correctedMemberNumber, '2932 registrada como corrigida').toBe('2932');
    expect(linha.correctedById).toBe(gerente.id);
    expect(linha.correctedAt).toBeTruthy();
    expect(linha.correctionReason).toBe('etapa lançada na federação errada');

    const depois = await retratoDoLedger();
    expect(depois.atletas, 'nenhum atleta criado').toBe(antes.atletas);
    expect(depois.pontos, 'nenhum lançamento criado').toBe(antes.pontos);
    expect(depois.idsDosPontos, 'os MESMOS ids').toEqual(antes.idsDosPontos);
    expect(depois.resultados).toBe(antes.resultados);
    expect(depois.identidades.length).toBe(antes.identidades.length);
    expect(depois.pontosComDono).toBe(1);

    const registros = await noLedger(tx => tx.auditLog.findMany({
      where: { organizationId, entityId: item.id }
    }));
    const daCorrecao = registros.find(r => r.metadata?.operacao === 'CORRECAO_DE_FILIACAO');
    expect(daCorrecao.metadata.entidadeOriginal, 'a trilha guarda a entidade da fonte').toBe('IFBB');
    expect(daCorrecao.metadata.entidadeCorrigida).toBe('NPC');
    expect(daCorrecao.metadata.filiacaoOriginal).toBe('7777');
    expect(daCorrecao.metadata.filiacaoCorrigida).toBe('2932');
  });

  it('entidade informada que não está cadastrada na organização é recusada', async () => {
    const { item } = await cenarioRealDoRazor();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'WFF' });
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('ENTITY_NOT_REGISTERED');

    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('entidade com forma inválida é recusada pelo schema, antes de qualquer consulta', async () => {
    const { item } = await cenarioRealDoRazor();
    for (const valor of ['n', 'NPC!', 'npc brasil']) {
      const resposta = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: valor });
      expect([400, 422], `"${valor}"`).toContain(resposta.status);
    }
  });
});

// ============ §2 — APPLIED COM DONO: os três desfechos, nenhum silencioso ===
describe('§2 resultado APPLIED que JÁ tem dono', () => {
  // Monta uma linha aplicada e JÁ vinculada: a fonte acertou tudo.
  async function jaVinculado() {
    const lucas = await cadastrarLucas();
    const evento = await criarEvento('Razor');
    const importId = await importarEAplicar(csv([
      `RAZOR-2932-MENS_BODYBUILDING,,Lucas Gouveia,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Razor,sim`
    ]), { eventId: evento.id });
    const item = await primeiraLinha(importId);
    expect(item.athleteId, 'a linha nasceu vinculada').toBe(lucas.id);
    expect(item.matchStatus).toBe('APPLIED');
    return { lucas, item };
  }

  it('1. a correção aponta para o MESMO atleta e já está gravada: idempotente', async () => {
    const { lucas, item } = await jaVinculado();
    // Primeira: grava a correção (mesmo par, nada muda no ledger).
    const primeira = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    expect(primeira.status, JSON.stringify(primeira.body).slice(0, 300)).toBe(200);
    const depoisDaPrimeira = await retratoDoLedger();

    const segunda = await corrigir(item.id, { novaMatricula: '2932', novaEntidade: 'NPC' });
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyApplied).toBe(true);
    expect(segunda.body.athleteId).toBe(lucas.id);
    expect(segunda.body.lancamentos).toBe(0);
    expect(await retratoDoLedger()).toEqual(depoisDaPrimeira);
  });

  it('2. a correção aponta para OUTRO atleta: BLOQUEADA, e nada muda', async () => {
    const { lucas, item } = await jaVinculado();
    const outro = await criarAtleta(gerente, organizationId, {
      fullName: 'Outro Atleta Qualquer', cpf: gerarCpf(515151515), sex: 'MALE',
      affiliationId: npc.id, affiliationNumber: '8888'
    });
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '8888', novaEntidade: 'NPC' });
    expect(resposta.status, 'trocar o dono é outra operação').toBe(409);
    expect(resposta.body.error.code).toBe('ITEM_ALREADY_LINKED');

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.athleteId, 'o dono continua o mesmo').toBe(lucas.id);
    expect(linha.correctedMemberNumber, 'NENHUM desvínculo, NENHUMA gravação').toBeNull();
    expect(linha.correctedAffiliationCode).toBeNull();
    expect(await retratoDoLedger()).toEqual(antes);
    expect(outro.id).not.toBe(lucas.id);
  });

  it('3. a correção aponta para NINGUÉM: BLOQUEADA — não se contradiz um vínculo', async () => {
    // Gravar uma correção que não casa com ninguém deixaria a linha afirmando
    // duas coisas incompatíveis: "pertence ao Lucas" e "a identidade é 999999".
    const { lucas, item } = await jaVinculado();
    const antes = await retratoDoLedger();

    const resposta = await corrigir(item.id, { novaMatricula: '999999', novaEntidade: 'NPC' });
    expect(resposta.status).toBe(409);
    expect(resposta.body.error.code).toBe('ITEM_ALREADY_LINKED');

    const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
    expect(linha.athleteId).toBe(lucas.id);
    expect(linha.correctedMemberNumber).toBeNull();
    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('nenhum desvínculo automático acontece em nenhum dos três caminhos', async () => {
    const { lucas, item } = await jaVinculado();
    for (const corpo of [
      { novaMatricula: '2932', novaEntidade: 'NPC' },
      { novaMatricula: '8888', novaEntidade: 'NPC' },
      { novaMatricula: '999999' }
    ]) {
      await corrigir(item.id, corpo);
      const linha = await noLedger(tx => tx.muscleWarImportItem.findUnique({ where: { id: item.id } }));
      expect(linha.athleteId, `após ${JSON.stringify(corpo)}`).toBe(lucas.id);
    }
    const { pontosComDono } = await retratoDoLedger();
    expect(pontosComDono, 'o ponto nunca ficou órfão').toBe(1);
  });
});

// ======================================== §5 — AUDITORIA =====================
describe('§5 a correção deixa rastro com antes e depois', () => {
  it('registra os dois números, a entidade, o operador e os dois donos', async () => {
    const { lucas, item } = await cenarioDoRazor();
    await corrigir(item.id, { novaMatricula: '2932', motivo: 'conferido com a ficha da federação' });

    const registros = await noLedger(tx => tx.auditLog.findMany({
      where: { organizationId, entityId: item.id },
      orderBy: { createdAt: 'desc' }
    }));

    const daCorrecao = registros.find(r => r.metadata?.operacao === 'CORRECAO_DE_FILIACAO');
    expect(daCorrecao, 'a correção foi auditada').toBeTruthy();
    expect(daCorrecao.metadata.filiacaoOriginal).toBe('2952');
    expect(daCorrecao.metadata.filiacaoCorrigida).toBe('2932');
    expect(daCorrecao.metadata.entidade).toBe('NPC');
    expect(daCorrecao.metadata.motivo).toBe('conferido com a ficha da federação');
    expect(daCorrecao.metadata.athleteIdAntes, 'o dono ANTES: ninguém').toBeNull();
    expect(daCorrecao.metadata.athleteIdDepois, 'o dono DEPOIS').toBe(lucas.id);
    expect(daCorrecao.userId, 'o operador fica registrado').toBe(gerente.id);

    // O rastro não pode carregar dado pessoal que a decisão não usou.
    const serializado = JSON.stringify(daCorrecao.metadata);
    expect(serializado).not.toMatch(/cpf/i);
    expect(serializado).not.toMatch(/\d{11}/);
  });
});

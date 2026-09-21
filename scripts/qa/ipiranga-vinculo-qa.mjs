#!/usr/bin/env node
// ============================================================================
// FIXTURE QA DA ESCALA DO IPIRANGA — 191 resultados, e o vínculo depois.
//
// O ARQUIVO REAL NÃO ESTÁ AQUI, e não deve estar: este repositório é público e
// o arquivo oficial traz nome e matrícula de competidor de verdade. O que se
// reproduz é a ESCALA e a FORMA — 191 linhas, o cabeçalho real de uma etapa —
// com identidades de QA, claramente marcadas como tal.
//
// O QUE ESTE SCRIPT RESPONDE, e que nenhum teste unitário responde:
//
//   1. 191 resultados históricos entram com a base de atletas VAZIA;
//   2. ZERO atletas são criados pela importação;
//   3. depois, 10 pessoas se cadastram com CPF e 10 com filiação + matrícula;
//   4. cada grupo encontra o próprio histórico pela chave que lhe cabe;
//   5. os 171 restantes continuam pendentes — e continuam no ranking;
//   6. a pontuação total da temporada não muda em nenhum momento.
//
// NÃO PUBLICA NADA EM PRODUÇÃO. Roda contra o banco de teste, como a suíte.
// ============================================================================

import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from '../../tests/helpers.mjs';

const { vincularPendentesDoAtleta } = await import('../../src/services/muscleWarService.js');

const TOTAL = 191;
const POR_CPF = 10;
const POR_MATRICULA = 10;

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,cpf,Country,Age,ClassIndex,Total Score,Placing';
const CLASSES = [
  "Women's Bikini - Open Class A",
  "Women's Wellness - Open Class B",
  "Men's Classic Physique - Open Class A",
  "Men's Physique - Open Class B",
  "Men's Bodybuilding - Open Middleweight"
];
const SOBRENOMES = ['DA SILVA SANTOS', 'DE ALMEIDA', 'DOS SANTOS', 'PEREIRA LIMA', 'OLIVEIRA'];

const relato = [];
const diga = texto => { relato.push(texto); console.log(texto); };

garantirCatalogo();
await limparBanco();

const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador QA' });
const org = await criarOrganizacao(admin, { name: 'QA — Federacao de Teste' });
const gerente = await criarUsuario({ name: 'Gerente QA' });
await vincular(org.id, gerente, 'RANKING_MANAGER');
await vincular(org.id, gerente, 'REGISTRATION_OPERATOR');

const npc = (await api().post('/api/v1/affiliations').set(admin.auth())
  .send({ organizationId: org.id, name: 'NPC QA', code: 'NPC' })).body;

const seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
  .send({ organizationId: org.id, name: 'Temporada QA 2026', year: 2026 })).body.id;
await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
  rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
    { placing: 4, points: 2 }, { placing: 5, points: 1 }]
});

// As 191 pessoas de QA. As 10 primeiras terão CPF no arquivo (e se cadastrarão
// por CPF); as 10 seguintes NÃO terão CPF no arquivo (e se cadastrarão por
// filiação + matrícula, que é a única chave que lhes resta).
const pessoas = Array.from({ length: TOTAL }, (_, i) => ({
  primeiro: `QA${i + 1}`,
  ultimo: SOBRENOMES[i % SOBRENOMES.length],
  matricula: `QA-${100000 + i}`,
  // CPF só nas dez primeiras: é assim que o arquivo oficial se comporta —
  // algumas linhas trazem, a maioria não.
  cpf: i < POR_CPF ? gerarCpf(400000000 + i * 7919) : '',
  classe: CLASSES[i % CLASSES.length],
  colocacao: (Math.floor(i / CLASSES.length) % 8) + 1
}));

const linhas = [CABECALHO];
pessoas.forEach((p, i) => {
  const naoCompareceu = p.colocacao === 8;
  linhas.push([
    i + 1, p.classe, p.primeiro, p.ultimo, p.matricula, p.cpf,
    'Brazil', 20 + (i % 25), 1, (95 - (i % 30)).toFixed(1),
    naoCompareceu ? 'NS' : p.colocacao
  ].join(','));
});

diga('\n=================== IMPORTAÇÃO ===================');
const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId: org.id, seasonId, sourceType: 'CSV',
  sourceRef: unico('ipiranga-qa') + '.csv', content: linhas.join('\n'),
  externalIdPrefix: 'IPIRANGA-QA', defaultAffiliationCode: 'NPC'
});
if (lote.status !== 201) { console.error('importação falhou', lote.status, lote.body); process.exit(1); }

const r = lote.body.summary;
diga(`  lidos ................ ${r.totalRecords}`);
diga(`  rejeitados ........... ${r.rejected}`);
diga(`  conflitos ............ ${r.conflicts}`);
diga(`  duplicados ........... ${r.duplicates}`);
diga(`  reconhecidos ......... ${r.recognized}`);
diga(`  pendentes de vínculo . ${r.pendingLink}`);
diga(`  aplicáveis ........... ${r.applicable}`);

const atletasAntes = await prisma.athlete.count();
const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
if (aplicacao.status !== 200) { console.error('aplicação falhou', aplicacao.status, aplicacao.body); process.exit(1); }
diga(`  aplicados ............ ${aplicacao.body.applied}`);
diga(`  atletas criados ...... ${(await prisma.athlete.count()) - atletasAntes}`);

const soma = async () => (await comoAtor(gerente, tx =>
  tx.rankingPoint.aggregate({ _sum: { points: true } })))._sum.points;
const semDono = async () => comoAtor(gerente, tx =>
  tx.rankingPoint.count({ where: { athleteId: null } }));

const somaInicial = await soma();
diga(`  pontos na temporada .. ${somaInicial}`);
diga(`  lançamentos sem dono . ${await semDono()}`);

diga('\n=================== CADASTROS POSTERIORES ===================');
let vinculadosPorCpf = 0;
for (let i = 0; i < POR_CPF; i += 1) {
  const p = pessoas[i];
  const atleta = await criarAtleta(admin, org.id, {
    fullName: `${p.primeiro} ${p.ultimo}`, cpf: p.cpf, sex: 'MALE', birthDate: '1995-03-10'
  });
  const efeito = await comoAtor(gerente, () => vincularPendentesDoAtleta(
    { ...atleta, organizationId: org.id, affiliationId: null, affiliationNumber: null },
    { id: gerente.id }
  ));
  vinculadosPorCpf += efeito.vinculados;
}
diga(`  ${POR_CPF} cadastros por CPF .............. ${vinculadosPorCpf} resultado(s) vinculado(s)`);

let vinculadosPorMatricula = 0;
for (let i = POR_CPF; i < POR_CPF + POR_MATRICULA; i += 1) {
  const p = pessoas[i];
  const atleta = await criarAtleta(admin, org.id, {
    fullName: `${p.primeiro} ${p.ultimo}`, cpf: gerarCpf(500000000 + i * 7919),
    sex: 'MALE', birthDate: '1995-03-10',
    affiliationId: npc.id, affiliationNumber: p.matricula
  });
  const efeito = await comoAtor(gerente, () => vincularPendentesDoAtleta(
    { ...atleta, organizationId: org.id, affiliationId: npc.id, affiliationNumber: p.matricula },
    { id: gerente.id }
  ));
  vinculadosPorMatricula += efeito.vinculados;
}
diga(`  ${POR_MATRICULA} cadastros por filiação+matrícula . ${vinculadosPorMatricula} resultado(s) vinculado(s)`);

diga('\n=================== DEPOIS ===================');
const somaFinal = await soma();
const pendentes = await semDono();
diga(`  pontos na temporada .. ${somaFinal}  (antes: ${somaInicial})`);
diga(`  lançamentos sem dono . ${pendentes}`);
diga(`  atletas na base ...... ${await prisma.athlete.count()}`);

const rankingPublico = await api().get('/api/v1/ranking').query({ seasonId });
const comCadastro = rankingPublico.body.items.filter(l => l.athlete.id).length;
diga(`  ranking público ...... ${rankingPublico.status}, ${rankingPublico.body.items.length} linha(s), ${comCadastro} com cadastro`);

diga('\n=================== VEREDITO ===================');
const problemas = [];
if (r.totalRecords !== TOTAL) problemas.push(`leu ${r.totalRecords} de ${TOTAL}`);
if (r.rejected !== 0) problemas.push(`${r.rejected} rejeitados`);
if (r.conflicts !== 0) problemas.push(`${r.conflicts} conflitos`);
if (r.duplicates !== 0) problemas.push(`${r.duplicates} duplicados`);
if (r.recognized !== 0) problemas.push(`${r.recognized} reconhecidos com a base vazia`);
if (r.applicable !== TOTAL) problemas.push(`${r.applicable} aplicáveis de ${TOTAL}`);
if (aplicacao.body.applied !== TOTAL) problemas.push(`aplicou ${aplicacao.body.applied} de ${TOTAL}`);
if ((await prisma.athlete.count()) !== POR_CPF + POR_MATRICULA) {
  problemas.push('a base de atletas tem gente que ninguém cadastrou');
}
if (vinculadosPorCpf !== POR_CPF) problemas.push(`CPF vinculou ${vinculadosPorCpf} de ${POR_CPF}`);
if (vinculadosPorMatricula !== POR_MATRICULA) problemas.push(`matrícula vinculou ${vinculadosPorMatricula} de ${POR_MATRICULA}`);
if (somaFinal !== somaInicial) problemas.push(`a pontuação mudou: ${somaInicial} → ${somaFinal}`);
if (pendentes !== TOTAL - POR_CPF - POR_MATRICULA) {
  problemas.push(`restaram ${pendentes} sem dono, esperado ${TOTAL - POR_CPF - POR_MATRICULA}`);
}
if (rankingPublico.status !== 200) problemas.push('o ranking público não respondeu');

if (problemas.length) {
  console.error('\nREPROVADO:');
  problemas.forEach(p => console.error('  · ' + p));
  process.exit(1);
}
console.log('\nAPROVADO. NADA FOI PUBLICADO EM PRODUÇÃO — este script não tem esse caminho.');
process.exit(0);

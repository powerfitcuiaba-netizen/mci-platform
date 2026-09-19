#!/usr/bin/env node
// ============================================================================
// PRÉVIA DO IPIRANGA EM QA — a mesma que o operador vê, medida em números.
//
// Não publica nada: vai só até a prévia. `/apply` NÃO é chamado, e o script
// não tem como chamá-lo — o caminho simplesmente não existe aqui.
//
// Para que serve: a prévia de produção depende de QUAIS atletas já estão
// cadastrados lá, e isso este ambiente não sabe. O que ele SABE responder é a
// parte estrutural, que independe da base:
//
//   * 191 registros lidos;
//   * ZERO rejeitados por falta de identificador externo;
//   * 191 identificadores derivados, todos únicos;
//   * o evento acompanha o lote;
//   * NS entra como participação válida de zero ponto.
//
// A base de QA nasce vazia de atletas, então TODA linha cai em MATCH_PENDING.
// Em produção a mesma prévia distribui entre reconhecidos, pendentes e
// conflitos conforme o cadastro real. A comparação honesta é a estrutural.
//
// USO: QA_CSV=<caminho do csv> node scripts/qa/previa-ipiranga.mjs
// ============================================================================

import { readFileSync } from 'node:fs';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, prisma
} from '../../tests/helpers.mjs';

const CSV = process.env.QA_CSV;
if (!CSV) { console.error('Faltou QA_CSV com o caminho do arquivo.'); process.exit(2); }
const conteudo = readFileSync(CSV, 'utf8');

garantirCatalogo();
await limparBanco();

const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin QA' });
const org = await criarOrganizacao(admin, { name: 'QA — Federacao de Teste' });

const operador = await criarUsuario({ name: 'Operador QA' });
for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
  await vincular(org.id, operador, papel);
}

await api().post('/api/v1/affiliations').set(admin.auth())
  .send({ organizationId: org.id, name: 'NPC', code: 'NPC' });

const season = (await api().post('/api/v1/seasons').set(admin.auth())
  .send({ organizationId: org.id, name: 'Temporada QA', year: 2026 })).body.id;
await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
  rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
    { placing: 4, points: 2 }, { placing: 5, points: 1 }]
});

const evento = (await api().post('/api/v1/events').set(operador.auth()).send({
  organizationId: org.id, name: 'Etapa Ipiranga (QA)', slug: unico('ipiranga-qa'),
  startDate: '2026-09-12T12:00:00.000Z', city: 'Sao Paulo', state: 'SP', seasonId: season
})).body;

// O QUE O OPERADOR PREENCHE NA TELA, e nada além disso.
const resposta = await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
  organizationId: org.id,
  seasonId: season,
  eventId: evento.id,
  sourceType: 'CSV',
  sourceRef: 'ipiranga.csv',
  content: conteudo,
  externalIdPrefix: 'IPIRANGA',
  defaultAffiliationCode: 'NPC'
});

if (resposta.status !== 201) {
  console.error(`A criacao do lote falhou: ${resposta.status}`);
  console.error(JSON.stringify(resposta.body, null, 2));
  process.exit(1);
}

const lote = resposta.body.import;
// Dentro do contexto do operador: o cliente cru nao atravessa o RLS, e a
// leitura volta vazia sem erro nenhum — que e exatamente o que o RLS promete.
const itens = await comoAtor(operador, tx => tx.muscleWarImportItem.findMany({
  where: { importId: lote.id },
  orderBy: { rowNumber: 'asc' },
  select: { externalResultId: true, matchStatus: true, reason: true, didNotShow: true,
            placing: true, className: true, memberNumber: true, categoryCode: true }
}));

const porSituacao = itens.reduce((acc, i) => ({ ...acc, [i.matchStatus]: (acc[i.matchStatus] ?? 0) + 1 }), {});
const semIdentificador = itens.filter(i => !i.externalResultId);
const chaves = new Set(itens.map(i => i.externalResultId).filter(Boolean));
const ausencias = itens.filter(i => i.didNotShow);
const motivos = itens.filter(i => i.reason)
  .reduce((acc, i) => ({ ...acc, [i.reason]: (acc[i.reason] ?? 0) + 1 }), {});

console.log('=================== PRÉVIA — RESUMO DO LOTE ===================');
console.log(`evento no lote ......... ${lote.eventId === evento.id ? 'Etapa Ipiranga (QA)' : 'AUSENTE'}`);
console.log(`Registros .............. ${lote.totalRecords}`);
console.log(`Reconhecidos ........... ${resposta.body.summary.recognized}`);
console.log(`Pendentes .............. ${resposta.body.summary.pending}`);
console.log(`Conflitos .............. ${resposta.body.summary.conflicts}`);
console.log(`Duplicados ............. ${resposta.body.summary.duplicates}`);
console.log(`Rejeitados ............. ${resposta.body.summary.rejected}`);
console.log(`Aplicados .............. ${resposta.body.summary.applied}`);
console.log();
console.log('=================== IDENTIFICADOR EXTERNO ===================');
console.log(`linhas SEM identificador ... ${semIdentificador.length}`);
console.log(`chaves distintas ........... ${chaves.size} de ${itens.length}`);
console.log(`exemplo .................... ${itens[0]?.externalResultId ?? '(nenhum)'}`);
console.log();
console.log('=================== NÃO COMPARECIMENTO ===================');
console.log(`linhas NS .................. ${ausencias.length}`);
for (const ns of ausencias.slice(0, 5)) {
  console.log(`  matricula ${ns.memberNumber} · placing=${ns.placing} · didNotShow=${ns.didNotShow} · ${ns.className}`);
}
console.log();
console.log('=================== SITUAÇÕES ===================');
for (const [situacao, n] of Object.entries(porSituacao).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${situacao.padEnd(16)} ${n}`);
}
if (Object.keys(motivos).length) {
  console.log();
  console.log('=================== MOTIVOS ===================');
  for (const [motivo, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${String(n).padStart(4)}x  ${motivo}`);
  }
}
console.log();
console.log('=================== PRIMEIRAS LINHAS ===================');
for (const i of itens.slice(0, 6)) {
  console.log(`  ${i.memberNumber.padEnd(8)} ${String(i.categoryCode ?? '—').padEnd(20)} ` +
    `col=${String(i.placing ?? '—').padEnd(4)} ${i.matchStatus.padEnd(14)} ${i.externalResultId}`);
}
console.log();
console.log('NADA FOI APLICADO. Este script nao chama /apply.');
await prisma.$disconnect();
process.exit(0);

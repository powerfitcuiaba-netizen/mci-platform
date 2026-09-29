#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — AUTORIZAÇÃO AUTOMÁTICA NA NPC E FOTO OBRIGATÓRIA.
//
// As duas decisões novas trouxeram barreiras novas, e barreira só existe se
// alguém a mede. Cada mutante abaixo desfaz UMA delas da forma mais plausível —
// não apagando código, mas "simplificando-o" como faria uma refatoração
// distraída. Mutante que sobrevive é decisão escrita no código e NÃO medida por
// teste, que é a decisão que a próxima refatoração desfaz em silêncio.
//
// O veredito só vale com CONTROLE ANTES e CONTROLE DEPOIS: sem o primeiro,
// "MORREU" pode ser suíte já vermelha; sem o segundo, pode ser arquivo ou banco
// deixado corrompido pela própria rodada.
//
// MUTANTES DE CÓDIGO
//   NF-M1  a autorização automática vira `upsert` — e ressuscita uma REVOGADA
//   NF-M2  ela deixa de gravar `autoGrantedAt`: a trilha perde a distinção
//          entre decisão da regra e decisão de pessoa, e a política do banco,
//          que EXIGE a coluna, passa a recusar a linha
//   NF-M3  criar a equipe própria deixa de exigir autorização na federação
//   NF-M4  criar a equipe própria passa a obedecer o `coachId` do CORPO
//   NF-M5  a foto deixa de ser obrigatória no autocadastro
//   NF-M6  o serializador devolve a CHAVE do objeto ao navegador
//   NF-M7  o ranking oficial deixa de exigir foto
//   NF-M8  a federação oficial passa a ser "a primeira ativa", sem o código NPC
//
// MUTANTES DE POLÍTICA
//   NF-P1  a política da autorização automática perde a condição da federação
//          OFICIAL: o treinador passa a poder se autorizar em qualquer uma
//   NF-P2  ela perde a condição do DONO: o treinador passa a poder autorizar
//          treinador alheio na federação oficial
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const URL_BANCO = 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';
const ENV = `NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 DATABASE_URL="${URL_BANCO}"`;

const SUITE_NPC = 'tests/autorizacao-automatica-npc.test.mjs';
const SUITE_FOTO = 'tests/foto-obrigatoria-do-treinador.test.mjs';
const SUITE_AUTOMATICA = 'tests/aprovacao-automatica-de-treinador.test.mjs';
const SUITE_MODULO = 'tests/modulo-treinadores-equipes.test.mjs';

const MUTANTES_DE_CODIGO = [
  {
    id: 'NF-M1',
    descricao: 'a autorização automática vira `upsert` e ressuscita a REVOGADA',
    suite: SUITE_NPC,
    arquivo: 'src/services/coachService.js',
    de: '    autorizacao = await prisma.coachOrganization.create({',
    para: '    autorizacao = await prisma.coachOrganization.upsert({\n      where: { coachId_organizationId: { coachId: coach.id, organizationId: oficial.id } },\n      update: { status: \'APPROVED\', revokedAt: null, revokedById: null },'
  },
  {
    id: 'NF-M2',
    descricao: 'a autorização automática deixa de gravar `autoGrantedAt`',
    suite: SUITE_NPC,
    arquivo: 'src/services/coachService.js',
    de: '        autoGrantedAt: agora,',
    para: ''
  },
  {
    id: 'NF-M3',
    descricao: 'criar a equipe própria deixa de exigir autorização na federação',
    suite: SUITE_NPC,
    arquivo: 'src/services/coachService.js',
    // A primeira ocorrência é a da CRIAÇÃO; o trecho é colado com a linha
    // anterior para ficar único no arquivo.
    de: '  const estado = await treinadorAtivoDaConta(actor, data.organizationId);\n  if (!estado) throw new AppError(404, \'COACH_NOT_FOUND\', \'Esta conta não possui cadastro de treinador\');\n  if (!estado.autorizado) recusarTreinadorInativo(estado);',
    para: '  const estado = await treinadorAtivoDaConta(actor, data.organizationId);\n  if (!estado) throw new AppError(404, \'COACH_NOT_FOUND\', \'Esta conta não possui cadastro de treinador\');\n  if (false) recusarTreinadorInativo(estado);'
  },
  {
    id: 'NF-M4',
    descricao: 'criar a equipe própria passa a obedecer o `coachId` do corpo',
    suite: SUITE_NPC,
    // MUTANTE COMPOSTO, e a primeira rodada explica por quê: mexer só no serviço
    // não muda comportamento nenhum, porque o Zod DESCARTA `coachId` antes de o
    // serviço ver o corpo (medido: `coachTeamCreate.parse` devolve apenas
    // `organizationId` e `name`). O mutante de uma linha SOBREVIVEU por ser
    // equivalente, não por falta de teste. A barreira real são as duas camadas
    // juntas, então o mutante retira as duas.
    edicoes: [
      {
        arquivo: 'src/utils/schemas.js',
        de: 'const coachTeamCreate = z.object({\n  organizationId: id,',
        para: 'const coachTeamCreate = z.object({\n  coachId: id.optional(),\n  organizationId: id,'
      },
      {
        arquivo: 'src/services/coachService.js',
        de: '        coachId: estado.id,\n        name: data.name,',
        para: '        coachId: data.coachId ?? estado.id,\n        name: data.name,'
      }
    ]
  },
  {
    id: 'NF-M5',
    descricao: 'a foto deixa de ser obrigatória no autocadastro',
    suite: SUITE_FOTO,
    arquivo: 'src/services/coachService.js',
    de: "  if (!arquivo) throw new AppError(422, 'COACH_PHOTO_REQUIRED', FOTO_OBRIGATORIA);",
    para: '  if (!arquivo) return null;'
  },
  {
    id: 'NF-M6',
    descricao: 'o serializador devolve a CHAVE do objeto ao navegador',
    suite: SUITE_FOTO,
    arquivo: 'src/services/coachService.js',
    de: '  const { photoKey, ...resto } = coach;\n  return { ...resto, hasPhoto: Boolean(photoKey) };',
    para: '  return { ...coach, hasPhoto: Boolean(coach.photoKey) };'
  },
  {
    id: 'NF-M7',
    descricao: 'o ranking oficial deixa de exigir foto',
    suite: SUITE_FOTO,
    arquivo: 'src/services/coachRankingService.js',
    de: "  if (!coach.photoKey) {\n    achados.push({ codigo: 'COACH_PHOTO_REQUIRED', mensagem: FOTO_EXIGIDA_NO_RANKING });\n  }",
    para: '  if (false) {\n    achados.push({});\n  }'
  },
  {
    id: 'NF-M8',
    descricao: 'a federação oficial passa a ser "a primeira ativa", sem o código NPC',
    suite: SUITE_NPC,
    arquivo: 'src/services/officialAffiliationService.js',
    de: "    where: { code: { equals: CODIGO_OFICIAL, mode: 'insensitive' }, active: true },",
    para: '    where: { active: true },'
  }
];

// A RESTAURAÇÃO DA POLÍTICA É ESCRITA À MÃO, e não pela reaplicação da migration.
//
// `20260928010000` faz `ALTER TABLE ... ADD COLUMN` antes de criar a política:
// reexecutá-la falharia na coluna que já existe. A lição vem de TE-P1 em
// `mutantes-treinadores.mjs`, onde a restauração incompleta deixou o banco mais
// frouxo do que o encontrou — e o controle depois passou justamente porque a
// política não tinha teste. Aqui o texto abaixo é cópia literal da migration.
const POLITICA_ORIGINAL = `
DROP POLICY IF EXISTS coach_org_autorizacao_automatica ON "CoachOrganization";
CREATE POLICY coach_org_autorizacao_automatica ON "CoachOrganization"
  FOR INSERT
  WITH CHECK (
    "status" = 'APPROVED'
    AND "grantedById" IS NULL
    AND "autoGrantedAt" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Coach" c
       WHERE c.id = "CoachOrganization"."coachId"
         AND c."userId" = mci_current_user_id()
         AND c.status = 'APPROVED'
    )
    AND EXISTS (
      SELECT 1 FROM "Organization" o
       WHERE o.id = "CoachOrganization"."organizationId"
         AND o.active
         AND EXISTS (
           SELECT 1 FROM "Affiliation" a
            WHERE a."organizationId" = o.id
              AND upper(a.code) = 'NPC'
              AND a.active
         )
    )
  );
`;

const MUTANTES_DE_POLITICA = [
  {
    id: 'NF-P1',
    descricao: 'a política perde a condição da federação OFICIAL',
    suite: SUITE_NPC,
    sql: `
DROP POLICY IF EXISTS coach_org_autorizacao_automatica ON "CoachOrganization";
CREATE POLICY coach_org_autorizacao_automatica ON "CoachOrganization"
  FOR INSERT
  WITH CHECK (
    "status" = 'APPROVED'
    AND "grantedById" IS NULL
    AND "autoGrantedAt" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Coach" c
       WHERE c.id = "CoachOrganization"."coachId"
         AND c."userId" = mci_current_user_id()
         AND c.status = 'APPROVED'
    )
  );
`,
    restaurar: POLITICA_ORIGINAL
  },
  {
    id: 'NF-P2',
    descricao: 'a política perde a condição do DONO: autoriza treinador alheio',
    suite: SUITE_NPC,
    sql: `
DROP POLICY IF EXISTS coach_org_autorizacao_automatica ON "CoachOrganization";
CREATE POLICY coach_org_autorizacao_automatica ON "CoachOrganization"
  FOR INSERT
  WITH CHECK (
    "status" = 'APPROVED'
    AND "grantedById" IS NULL
    AND "autoGrantedAt" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Organization" o
       WHERE o.id = "CoachOrganization"."organizationId"
         AND o.active
         AND EXISTS (
           SELECT 1 FROM "Affiliation" a
            WHERE a."organizationId" = o.id
              AND upper(a.code) = 'NPC'
              AND a.active
         )
    )
  );
`,
    restaurar: POLITICA_ORIGINAL
  }
];

function psql(sql) {
  const arquivo = `/tmp/mutante-nf-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(arquivo, sql);
  try {
    execSync(`PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -v ON_ERROR_STOP=1 -f ${arquivo}`,
      { stdio: 'pipe', encoding: 'utf8' });
  } finally {
    rmSync(arquivo, { force: true });
  }
}

function suitePassa(suite) {
  try {
    execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${suite}`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 1_800_000 });
    return { passou: true };
  } catch (erro) {
    const saida = `${erro.stdout ?? ''}`;
    const falhas = (saida.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? '?';
    return { passou: false, falhas };
  }
}

// Um mutante pode precisar de MAIS DE UMA edição, inclusive em arquivos
// diferentes: quando duas camadas sustentam a mesma barreira, retirar só uma
// delas produz mutante equivalente, que sobrevive sem que falte teste. A forma
// de uma edição (`arquivo`/`de`/`para`) continua valendo e virou açúcar.
const edicoesDe = mutante => mutante.edicoes
  ?? [{ arquivo: mutante.arquivo, de: mutante.de, para: mutante.para }];

function rodarCodigo(mutante) {
  const edicoes = edicoesDe(mutante).map(e => ({ ...e, caminho: `${RAIZ}/${e.arquivo}` }));
  // O backup de TODOS os arquivos vem antes de qualquer escrita: se a segunda
  // edição não casar, a primeira já está desfeita no `finally`.
  for (const e of edicoes) copyFileSync(e.caminho, `${e.caminho}.mutante-bak`);
  try {
    for (const e of edicoes) {
      const original = readFileSync(e.caminho, 'utf8');
      const ocorrencias = original.split(e.de).length - 1;
      if (ocorrencias !== 1) {
        return {
          ...mutante, veredito: 'NÃO APLICADO',
          detalhe: `em ${e.arquivo} o trecho aparece ${ocorrencias} vez(es)`
        };
      }
      writeFileSync(e.caminho, original.replace(e.de, e.para));
    }

    const r = suitePassa(mutante.suite);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    for (const e of edicoes) {
      copyFileSync(`${e.caminho}.mutante-bak`, e.caminho);
      rmSync(`${e.caminho}.mutante-bak`, { force: true });
    }
  }
}

function rodarPolitica(mutante) {
  try {
    psql(mutante.sql);
    const r = suitePassa(mutante.suite);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    psql(mutante.restaurar);
  }
}

// A CONFERÊNCIA QUE FECHA O BURACO: depois de tudo, a política do banco é a que
// o repositório declara? O controle depois por suíte só reprova o que algum
// teste mede — e política sem teste é justamente o caso em que o mutante
// sobrevive E FICA.
function conferirPolitica() {
  const saida = execSync(
    'PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -At -c '
    + '"SELECT coalesce(pg_get_expr(polwithcheck, polrelid), \'\') FROM pg_policy '
    + 'WHERE polname = \'coach_org_autorizacao_automatica\'"',
    { encoding: 'utf8' }
  ).trim();

  const exigidos = ['autoGrantedAt', 'mci_current_user_id', "upper(a.code) = 'NPC'", 'grantedById'];
  if (!saida) return ['coach_org_autorizacao_automatica: política AUSENTE'];
  return exigidos.filter(t => !saida.includes(t)).map(t => `a política não contém "${t}"`);
}

// O BANCO RESPONDE, ANTES DE QUALQUER CONCLUSÃO SOBRE TESTE.
//
// Medido nesta sessão: o PostgreSQL do container cai sozinho, e quando cai a
// suíte não REPROVA — ela é PULADA, com `PrismaClientInitializationError` no
// passo de semeadura. O controle antes lia isso como "a suíte já está vermelha",
// que manda quem for investigar caçar defeito de produto onde há infraestrutura
// fora do ar. Distinguir os dois casos custa uma consulta.
function bancoResponde() {
  try {
    execSync('PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -At -c "SELECT 1"',
      { stdio: 'pipe', encoding: 'utf8', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

console.log('=== MUTATION TESTING — NPC AUTOMÁTICA E FOTO OBRIGATÓRIA ===\n');

if (!bancoResponde()) {
  console.log('INFRAESTRUTURA: o banco `mci_test` não responde. Suba o PostgreSQL '
    + '(`service postgresql start`) e rode de novo. Nada abaixo foi executado, e '
    + 'isto NÃO é veredito sobre nenhuma suíte.');
  process.exit(2);
}

const SUITES_DE_CONTROLE = [
  ['autorização automática NPC', SUITE_NPC],
  ['foto obrigatória', SUITE_FOTO],
  ['aprovação automática', SUITE_AUTOMATICA],
  ['módulo treinadores', SUITE_MODULO]
];

for (const [rotulo, suite] of SUITES_DE_CONTROLE) {
  if (!suitePassa(suite).passou) {
    const motivo = bancoResponde()
      ? 'já está vermelha'
      : 'não rodou: o banco caiu no meio do controle';
    console.log(`CONTROLE ANTES FALHOU: a suíte "${rotulo}" ${motivo}. Nada abaixo conclui nada.`);
    process.exit(1);
  }
}
console.log(`CONTROLE ANTES: as ${SUITES_DE_CONTROLE.length} suítes passam sem mutante.\n`);

// FILTRO POR ID: `node scripts/qa/mutantes-npc-foto.mjs NF-M4 NF-P2` reexecuta só
// os mutantes nomeados. Serve para conferir a correção de um sobrevivente sem
// pagar a rodada inteira — e o controle antes, o controle depois e a conferência
// da política continuam rodando, que é o que torna o resultado parcial legível.
const PEDIDOS = process.argv.slice(2).filter(a => /^NF-/i.test(a)).map(a => a.toUpperCase());
const pedido = m => !PEDIDOS.length || PEDIDOS.includes(m.id);
if (PEDIDOS.length) console.log(`RODADA PARCIAL: ${PEDIDOS.join(', ')}\n`);

const resultados = [];
for (const mutante of MUTANTES_DE_CODIGO.filter(pedido)) {
  const r = rodarCodigo(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}
for (const mutante of MUTANTES_DE_POLITICA.filter(pedido)) {
  const r = rodarPolitica(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

console.log('\n--- CONTROLE DEPOIS ---');
const depois = SUITES_DE_CONTROLE.map(([rotulo, suite]) => ({ rotulo, ...suitePassa(suite) }));
for (const d of depois) console.log(`  ${d.passou ? 'PASS  ' : 'FALHOU'}  ${d.rotulo}`);

const divergencias = conferirPolitica();
console.log('\n--- A POLÍTICA DO BANCO É A DO REPOSITÓRIO? ---');
if (divergencias.length) for (const d of divergencias) console.log(`  DIVERGE  ${d}`);
else console.log('  PASS    a política está íntegra depois da rodada');

const sobreviventes = resultados.filter(r => r.veredito === 'SOBREVIVEU');
const naoAplicados = resultados.filter(r => r.veredito === 'NÃO APLICADO');

console.log('\n=== VEREDITO ===');
console.log(`  ${resultados.filter(r => r.veredito === 'MORREU').length} morreram`);
console.log(`  ${sobreviventes.length} sobreviveram`);
console.log(`  ${naoAplicados.length} não aplicados`);

const problema = sobreviventes.length || naoAplicados.length
  || depois.some(d => !d.passou) || divergencias.length;
process.exit(problema ? 1 : 0);

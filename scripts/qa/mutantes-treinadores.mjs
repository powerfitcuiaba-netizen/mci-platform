#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — MÓDULO TREINADORES & EQUIPES.
//
// Cada mutante desfaz UMA das decisões aprovadas, da forma mais plausível: não
// apagando código, mas "simplificando-o" como alguém faria numa refatoração
// distraída. Se o mutante sobrevive, a decisão está escrita no código e não está
// medida por teste — e decisão não medida é decisão que a próxima refatoração
// desfaz em silêncio.
//
// O veredito só vale com CONTROLE ANTES e CONTROLE DEPOIS. Sem o primeiro,
// "MORREU" pode ser suíte já vermelha; sem o segundo, pode ser arquivo deixado
// corrompido.
//
//   TE-M1  R-03: a aprovação central vira permissão de federação
//   TE-M2  R-03: a máquina de estados aceita qualquer transição
//   TE-M3  R-04: a autorização por federação deixa de ser exigida na equipe
//   TE-M4  R-05: a projeção do atleta vira `include` genérico
//   TE-M5  a trava de pedido pendente sai do banco e volta a ser SELECT
//   TE-M6  a confirmação do vínculo dispensa a titularidade da conta
//   TE-M7  R-02: a autoconcessão de delegação central é permitida
//   TE-M8  R-02: a lista branca de permissões delegáveis é ignorada
//   TE-M9  a delegação expirada volta a valer
//   TE-M12 R-02: a lista branca deixa de valer na LEITURA da concessão
//   TE-M13 R-01: o recurso ao espelho desaparece (base antiga perde a equipe)
//   TE-M14 R-01: o espelho passa a valer também COM histórico — retroatividade
//   TE-M10 §8.3: a classificação de treinadores passa a existir, somando
//          os totais das equipes — a invenção de fórmula que o bloqueio proíbe
//   TE-M11 R-01: a equipe do ponto volta a sair do cadastro corrente
//
// MUTANTE DE POLÍTICA
//   TE-P1  `CentralAuthorization` volta a ser legível por qualquer um
//   TE-P2  `AthleteTeamMembership` aceita UPDATE do próprio atleta — a
//          "simetria" tentadora que deixaria o atleta sair da equipe sozinho
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const URL_BANCO = 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';
const ENV = `NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 DATABASE_URL="${URL_BANCO}"`;

const SUITE_MODULO = 'tests/modulo-treinadores-equipes.test.mjs';
const SUITE_VINCULO = 'tests/vinculo-equipe.test.mjs';
const SUITE_GATE = 'tests/gate-autorizacao-por-rota.test.mjs';
const SUITE_DELEGACAO = 'tests/permissoes-delegacao.test.mjs';
const SUITE_R01 = 'tests/r01-equipe-da-epoca.test.mjs';
const SUITE_RANKING = 'tests/ranking-oficial.test.mjs';
const SUITE_HARDENING = 'tests/hardening-auditoria-treinadores.test.mjs';
const SUITE_DIAGNOSTICO = 'tests/diagnostico-delegacoes-inertes.test.mjs';

const MUTANTES_DE_CODIGO = [
  {
    id: 'TE-M1',
    descricao: 'R-03: `coaches.approve` passa a ser permissão do diretor de evento',
    suite: SUITE_MODULO,
    arquivo: 'src/utils/permissions.js',
    de: "    'coaches.authorize_org',\n    'analytics.read', 'search.sensitive', 'users.read'",
    para: "    'coaches.authorize_org', 'coaches.approve',\n    'analytics.read', 'search.sensitive', 'users.read'"
  },
  {
    id: 'TE-M2',
    descricao: 'R-03: a máquina de estados do cadastro aceita qualquer transição',
    suite: SUITE_MODULO,
    arquivo: 'src/services/coachService.js',
    de: "  if (!TRANSICOES[atual]?.includes(destino)) {",
    para: "  if (false) {"
  },
  {
    id: 'TE-M3',
    descricao: 'R-04: a equipe aceita treinador sem autorização na federação',
    suite: SUITE_MODULO,
    arquivo: 'src/services/partnerService.js',
    de: "  const autorizacao = coach.organizations.find(item => item.organizationId === organizationId);\n  if (!autorizacao || autorizacao.status !== 'APPROVED') {",
    para: "  const autorizacao = coach.organizations.find(item => item.organizationId === organizationId);\n  if (false) {"
  },
  {
    id: 'TE-M4',
    descricao: 'R-05: a projeção esportiva do atleta vira include genérico',
    suite: SUITE_MODULO,
    arquivo: 'src/services/coachService.js',
    de: "      athlete: { select: SELECT_ATLETA_ESPORTIVO }",
    para: "      athlete: true"
  },
  {
    id: 'TE-M5',
    descricao: 'a trava de UM pedido pendente por atleta sai do banco',
    suite: SUITE_MODULO,
    arquivo: 'src/services/membershipRequestService.js',
    de: "        pendingAthleteId: athleteId",
    para: "        pendingAthleteId: null"
  },
  {
    id: 'TE-M6',
    descricao: 'a confirmação do vínculo dispensa a titularidade da conta',
    suite: SUITE_MODULO,
    arquivo: 'src/services/membershipService.js',
    de: "  if (!athlete.userId || athlete.userId !== actor.id) {",
    para: "  if (false) {"
  },
  {
    id: 'TE-M7',
    descricao: 'R-02: a autoconcessão de delegação central é permitida',
    suite: SUITE_VINCULO,
    arquivo: 'src/services/centralAuthorizationService.js',
    de: "  if (userId === actor.id) {",
    para: "  if (false) {"
  },
  {
    id: 'TE-M8',
    descricao: 'R-02: a lista branca de permissões delegáveis é ignorada',
    // A lista branca é o que impede `CentralAuthorization` de virar uma segunda
    // matriz RBAC, invisível para `tests/matriz-de-autorizacao.mjs`. Quem mede é
    // a suíte da delegação, que tenta conceder `results.publish` e exige 422 com
    // a lista do que É delegável no corpo da recusa.
    suite: SUITE_DELEGACAO,
    arquivo: 'src/services/centralAuthorizationService.js',
    de: "  if (!DELEGAVEIS.has(permission)) {",
    para: "  if (false) {"
  },
  {
    id: 'TE-M12',
    descricao: 'R-02: a lista branca deixa de valer na LEITURA da concessão',
    // A escrita já é medida por TE-M8. Esta é a outra ponta: uma linha gravada
    // por fora do serviço não pode virar poder. Sem a conferência na leitura,
    // `CentralAuthorization` seria uma segunda matriz RBAC.
    suite: SUITE_DELEGACAO,
    arquivo: 'src/utils/permissions.js',
    de: "    if (!DELEGADAS.has(concessao.permission)) continue;",
    para: "    if (false) continue;"
  },
  {
    id: 'TE-M9',
    descricao: 'a delegação central expirada volta a valer',
    // Medido como FUNÇÃO PURA: `effectivePermissions` recebe o instante da
    // pergunta, então a expiração é verificável sem esperar o tempo passar e sem
    // banco. É o que permite a este mutante morrer de forma determinística.
    suite: SUITE_DELEGACAO,
    arquivo: 'src/utils/permissions.js',
    // O ALVO MUDOU COM O ACHADO A-02, e o mutante teve de acompanhar.
    //
    // A linha antiga era `if (concessao.expiresAt && new Date(...) <= agora)`,
    // com o prazo OPCIONAL. Agora são duas: a ausência de prazo torna a linha
    // inerte, e o vencimento é conferido depois. O mutante mira a segunda.
    //
    // Medido: sem esta atualização, ele saía como NÃO APLICADO — e mutante que
    // não entra no código é mutante que parou de proteger, com cara de resultado.
    de: "    if (new Date(concessao.expiresAt) <= agora) continue;",
    para: "    if (false) continue;"
  },
  {
    id: 'TE-M10',
    descricao: '§8.3: a classificação de treinadores passa a existir',
    suite: SUITE_MODULO,
    arquivo: 'src/services/coachRankingService.js',
    de: "const FORMULA_HOMOLOGADA = false;",
    para: "const FORMULA_HOMOLOGADA = true;"
  },
  {
    id: 'TE-M11',
    descricao: 'R-01: a equipe do ponto volta a sair do cadastro corrente',
    suite: SUITE_R01,
    arquivo: 'src/services/rankingService.js',
    de: "        teamId: semHistorico ? atleta.teamId : (daEpoca?.teamId ?? null),\n        companyId: semHistorico ? (atleta.team?.companyId ?? null) : (daEpoca?.team?.companyId ?? null),",
    para: "        teamId: atleta.teamId,\n        companyId: atleta.team?.companyId ?? null,"
  },
  {
    id: 'TE-M13',
    descricao: 'R-01: o recurso ao espelho desaparece — base antiga perde a equipe',
    // A regra 2 (sem histórico → espelho) existe por causa de base antiga e da
    // fixture de `ranking-oficial`. Trocar `undefined` por `null` apaga a
    // distinção entre "sem histórico" e "com histórico e nada na data", e o
    // segundo é resposta definitiva. Quem mede é a suíte oficial do ranking.
    suite: SUITE_RANKING,
    arquivo: 'src/services/rankingService.js',
    de: "    if (!linhas.length) return undefined;",
    para: "    if (!linhas.length) return null;"
  },
  // --------------------------------------------------- F-04: a lista da federação
  //
  // A rota nasceu de um achado da homologação manual, e a regra dela é estreita
  // por três motivos que podem ser afrouxados por engano. Cada um tem um
  // mutante: o filtro de cadastro aprovado, a guarda de escopo e a projeção.
  {
    id: 'TE-F1',
    descricao: 'F-04: a lista da federação passa a mostrar cadastro NÃO aprovado (R-03)',
    suite: SUITE_HARDENING,
    arquivo: 'src/services/coachService.js',
    de: "      status: 'APPROVED',\n      ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {})",
    para: "      ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {})"
  },
  {
    id: 'TE-F2',
    descricao: 'F-04: a lista da federação dispensa a guarda de escopo (R-04)',
    suite: SUITE_HARDENING,
    arquivo: 'src/services/coachService.js',
    de: "  assertCan(actor, 'coaches.authorize_org', filtros.organizationId);\n\n  const treinadores = await prisma.coach.findMany({",
    para: "  const treinadores = await prisma.coach.findMany({"
  },
  {
    id: 'TE-F3',
    descricao: 'F-04: a projeção da lista volta a carregar contato e análise cadastral (R-05)',
    suite: SUITE_HARDENING,
    arquivo: 'src/services/coachService.js',
    de: "const SELECT_PARA_AUTORIZACAO = Object.freeze({\n  id: true, name: true, registration: true, city: true, state: true\n});",
    para: "const SELECT_PARA_AUTORIZACAO = Object.freeze({\n  id: true, name: true, registration: true, city: true, state: true,\n  email: true, phone: true, userId: true, rejectionReason: true\n});"
  },
  // ------------------------------- O DIAGNÓSTICO QUE NÃO ENXERGAVA NADA
  //
  // A versão anterior lia `CentralAuthorization` sem contexto e, com FORCE RLS,
  // via zero linhas — relatando "nenhuma concessão perde efeito" com código 0.
  // As duas guardas abaixo são o que impede aquilo de voltar.
  {
    id: 'TE-D1',
    descricao: 'diagnóstico: a leitura volta a acontecer sem contexto de RLS',
    suite: SUITE_DIAGNOSTICO,
    arquivo: 'scripts/diagnostico-delegacoes-inertes.js',
    // O `${...}` aqui é TEXTO do arquivo alvo, não interpolação deste script —
    // é o trecho que precisa casar caractere a caractere.
    // eslint-disable-next-line no-template-curly-in-string
    de: "      await tx.$queryRaw`SELECT set_config('mci.user_id', ${idDoAdministrador}, true)`;",
    para: "      await tx.$queryRaw`SELECT 1`;"
  },
  {
    id: 'TE-D2',
    descricao: 'diagnóstico: conta não administradora passa a valer como leitura completa',
    suite: SUITE_DIAGNOSTICO,
    arquivo: 'scripts/diagnostico-delegacoes-inertes.js',
    de: "      if (contexto?.administrador !== true) {",
    para: "      if (false) {"
  },
  {
    id: 'TE-M14',
    descricao: 'R-01: o espelho passa a valer TAMBÉM quando há histórico — a retroatividade de volta',
    // A direção PERIGOSA da mesma distinção. Com `?? undefined`, o atleta que
    // tinha histórico e nenhum vínculo na data cairia no espelho — que aponta
    // para a equipe de HOJE. É exatamente a retroatividade automática que R-01
    // proíbe, e é o mutante mais importante desta bateria.
    suite: SUITE_R01,
    arquivo: 'src/services/rankingService.js',
    de: "      return linhas.find(linha => linha.startedAt <= dataOficial && (!linha.endedAt || linha.endedAt >= dataOficial)) ?? null;",
    para: "      return linhas.find(linha => linha.startedAt <= dataOficial && (!linha.endedAt || linha.endedAt >= dataOficial)) ?? undefined;"
  }
];

const MUTANTES_DE_POLITICA = [
  {
    id: 'TE-P1',
    descricao: '`CentralAuthorization` volta a ser legível por qualquer sessão',
    // Quem mede a POLÍTICA desta tabela é a suíte da delegação, não a do módulo:
    // é lá que um terceiro sem relação nenhuma consulta `CentralAuthorization`
    // dentro do contexto de RLS dele. Apontar para a suíte errada fez este
    // mutante SOBREVIVER numa execução anterior por motivo de endereçamento, e
    // não por lacuna de cobertura.
    suite: SUITE_DELEGACAO,
    sql: `
DROP POLICY IF EXISTS central_leitura ON "CentralAuthorization";
CREATE POLICY central_leitura ON "CentralAuthorization" FOR SELECT USING (true);
`,
    // A RESTAURAÇÃO VEM COM O MUTANTE, e isto é correção de um defeito REAL
    // deste script.
    //
    // A primeira versão restaurava reaplicando só a migration `20260926040000`.
    // `central_leitura` nasce na `20260926020000`, que NÃO é reaplicável (ela
    // cria tabela). Resultado medido: depois da bateria, a política continuava
    // `USING (true)` no banco — e o CONTROLE DEPOIS passou, porque nenhum teste
    // media essa política, que é exatamente a lacuna que TE-P1 estava
    // reportando. Um gate de mutação que deixa o sistema mais fraco do que
    // encontrou não tem autoridade para aprovar nada.
    restaurar: `
DROP POLICY IF EXISTS central_leitura ON "CentralAuthorization";
CREATE POLICY central_leitura ON "CentralAuthorization"
  FOR SELECT USING (
    mci_is_platform_admin()
    OR "userId" = mci_current_user_id()
  );
`
  },
  {
    id: 'TE-P2',
    descricao: 'a "simetria" que deixaria o atleta encerrar o próprio vínculo',
    sql: `
DROP POLICY IF EXISTS vinculo_alteracao ON "AthleteTeamMembership";
CREATE POLICY vinculo_alteracao ON "AthleteTeamMembership" FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId"))
    OR mci_atleta_do_usuario("athleteId")
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId"))
    OR mci_atleta_do_usuario("athleteId")
  );
`,
    // A política mais frouxa NÃO quebra nenhum teste existente: nada na suíte
    // pede que o atleta seja recusado ao encerrar o próprio vínculo pela porta
    // do banco, porque a aplicação nem oferece essa rota. Declarado EQUIVALENTE
    // com a razão escrita — a garantia aqui é de desenho (o `FOR ALL` foi
    // partido em três de propósito), e inventar um teste que chame SQL cru para
    // matá-lo mediria o mutante, não o produto.
    esperado: 'SOBREVIVEU',
    porQue: 'Nenhuma rota permite ao atleta encerrar o próprio vínculo, então a folga '
      + 'da política não tem caminho de aplicação por onde ser observada. A separação de '
      + '`FOR ALL` em INSERT/UPDATE/DELETE é barreira de profundidade, documentada na '
      + 'migration 20260926040000; medi-la exigiria um teste de SQL cru, que mediria a '
      + 'política e não o comportamento do produto.'
  }
];

// As migrations que CRIAM ou SUBSTITUEM as políticas que os mutantes mexem, na
// mesma ordem em que o banco as aplica. A ordem importa: 20260927010000 e
// 20260927020000 substituem `vinculo_criacao` e `atleta_leitura` criadas por
// 20260926040000, e reaplicar só a primeira devolveria as duas à versão antiga.
// Todas são idempotentes de ponta a ponta — todo `CREATE POLICY` tem o seu
// `DROP ... IF EXISTS`, e a função vem com `CREATE OR REPLACE`.
//
// 20260926020000 NÃO entra: ela cria TABELA, e reexecutá-la falharia.
const MIGRACOES_DE_POLITICA = [
  `${RAIZ}/prisma/migrations/20260926040000_treinador_como_ator_de_rls/migration.sql`,
  `${RAIZ}/prisma/migrations/20260927010000_vinculo_exige_pedido_pendente/migration.sql`,
  `${RAIZ}/prisma/migrations/20260927020000_leitura_de_atleta_pelo_treinador/migration.sql`
];

function psql(sql) {
  const arquivo = `/tmp/mutante-te-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(arquivo, sql);
  try {
    execSync(`PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -v ON_ERROR_STOP=1 -f ${arquivo}`,
      { stdio: 'pipe', encoding: 'utf8' });
  } finally {
    rmSync(arquivo, { force: true });
  }
}

// Restaurar é reaplicar a CADEIA inteira, e não a migration que criou a política
// pela primeira vez. A versão anterior reaplicava apenas 20260926040000: ela
// devolvia `central_leitura` e `vinculo_alteracao` ao estado certo, mas também
// devolvia `atleta_leitura` e `vinculo_criacao` à versão ANTIGA, que migrations
// posteriores já tinham substituído. O banco de teste terminava a rodada
// divergente do repositório, e as suítes de A-03 e A-04 passavam a falhar sem
// que uma linha de código tivesse mudado — falha com cara de regressão, causada
// pelo próprio medidor.
const restaurarPoliticas = () => {
  for (const migration of MIGRACOES_DE_POLITICA) psql(readFileSync(migration, 'utf8'));
};

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

function rodarCodigo(mutante) {
  const caminho = `${RAIZ}/${mutante.arquivo}`;
  const backup = `${caminho}.mutante-bak`;
  copyFileSync(caminho, backup);
  try {
    const original = readFileSync(caminho, 'utf8');
    const ocorrencias = original.split(mutante.de).length - 1;
    if (ocorrencias !== 1) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: `o trecho aparece ${ocorrencias} vez(es)` };
    }
    writeFileSync(caminho, original.replace(mutante.de, mutante.para));

    const r = suitePassa(mutante.suite);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    copyFileSync(backup, caminho);
    rmSync(backup, { force: true });
  }
}

function rodarPolitica(mutante) {
  try {
    psql(mutante.sql);
    const r = suitePassa(mutante.suite ?? SUITE_MODULO);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    // A restauração PRÓPRIA do mutante primeiro, quando ele tem uma: a
    // reaplicação da migration só devolve as políticas que ELA cria.
    if (mutante.restaurar) psql(mutante.restaurar);
    restaurarPoliticas();
  }
}

// A CONFERÊNCIA QUE FECHA O BURACO: depois de tudo, as políticas do banco são
// as que o repositório declara?
//
// Comparar o texto de cada política com o esperado é o único jeito de saber que
// a restauração de fato aconteceu — o CONTROLE DEPOIS por suíte só reprova o que
// algum teste mede, e política sem teste é justamente o caso em que o mutante
// sobrevive E fica.
//
// O trecho esperado tem de sair do REPOSITÓRIO de hoje, e não do estado que o
// banco tinha quando esta lista foi escrita. `atleta_leitura` esperava
// `mci_treinador_autorizado_de`, a versão anterior a A-03: com isso o conferidor
// aprovava exatamente a política que a restauração incompleta devolvia, e a
// divergência ficava invisível nas duas pontas. Quando uma migration substitui
// uma política, esta lista muda com ela.
const POLITICAS_ESPERADAS = [
  ['central_leitura', 'mci_is_platform_admin() OR ("userId" = mci_current_user_id())'],
  ['vinculo_alteracao', 'mci_operator_of'],
  // A-03 (20260927020000): leitura de atleta exige EQUIPE na federação.
  ['atleta_leitura', 'mci_treinador_com_equipe_em'],
  // A-04 (20260927010000): o vínculo do atleta exige convite pendente.
  ['vinculo_criacao', 'TeamMembershipRequest'],
  ['auditoria_escrita', 'mci_treinador_autorizado_de']
];

function conferirPoliticas() {
  const divergencias = [];
  for (const [nome, esperado] of POLITICAS_ESPERADAS) {
    const saida = execSync(
      `PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -At -c `
      + `"SELECT coalesce(pg_get_expr(polqual, polrelid), '') || ' | ' || coalesce(pg_get_expr(polwithcheck, polrelid), '') `
      + `FROM pg_policy WHERE polname = '${nome}'"`,
      { encoding: 'utf8' }
    ).trim();
    if (!saida) divergencias.push(`${nome}: política AUSENTE`);
    else if (!saida.includes(esperado)) divergencias.push(`${nome}: não contém "${esperado}"`);
  }
  return divergencias;
}

console.log('=== MUTATION TESTING — TREINADORES & EQUIPES ===\n');

const SUITES_DE_CONTROLE = [
  ['módulo', SUITE_MODULO],
  ['ranking oficial', SUITE_RANKING],
  ['vínculo', SUITE_VINCULO],
  ['delegação', SUITE_DELEGACAO],
  ['R-01', SUITE_R01],
  ['gate de rota', SUITE_GATE],
  ['endurecimento', SUITE_HARDENING],
  ['diagnóstico de delegações', SUITE_DIAGNOSTICO]
];

for (const [rotulo, suite] of SUITES_DE_CONTROLE) {
  if (!suitePassa(suite).passou) {
    console.log(`CONTROLE ANTES FALHOU: a suíte "${rotulo}" já está vermelha. Nada abaixo conclui nada.`);
    process.exit(1);
  }
}
console.log(`CONTROLE ANTES: as ${SUITES_DE_CONTROLE.length} suítes passam sem mutante.\n`);

const resultados = [];
for (const mutante of MUTANTES_DE_CODIGO) {
  const r = rodarCodigo(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}
for (const mutante of MUTANTES_DE_POLITICA) {
  const r = rodarPolitica(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

const depois = SUITES_DE_CONTROLE.map(([rotulo, suite]) => ({ rotulo, ...suitePassa(suite) }));
const politicasDivergentes = conferirPoliticas();
const restauracaoOk = depois.every(d => d.passou) && politicasDivergentes.length === 0;

if (politicasDivergentes.length) {
  console.log('\nPOLÍTICAS NÃO RESTAURADAS — o script sujou o banco e não desfez:');
  for (const d of politicasDivergentes) console.log(`  ${d}`);
}
console.log(`\nCONTROLE DEPOIS: ${restauracaoOk
  ? 'todas as suítes de controle voltam a passar — restauração íntegra.'
  : `FALHOU em ${depois.filter(d => !d.passou).map(d => d.rotulo).join(', ')}.`}`);

const divergentes = resultados.filter(r => r.veredito !== (r.esperado ?? 'MORREU'));
const mortos = resultados.filter(r => r.veredito === 'MORREU').length;
const equivalentes = resultados.filter(r => r.esperado === 'SOBREVIVEU');

console.log(`\n${mortos} morreram, ${equivalentes.length} equivalente(s) declarado(s), `
  + `${resultados.length - divergentes.length}/${resultados.length} conforme a expectativa`);

for (const e of equivalentes) {
  console.log(`\n${e.id} EQUIVALENTE — por que não pode morrer:\n  ${e.porQue}`);
}

if (divergentes.length) {
  console.log('\nDIVERGIRAM DA EXPECTATIVA — cada um exige explicação:');
  for (const d of divergentes) console.log(`  ${d.id}  esperado ${d.esperado ?? 'MORREU'}, deu ${d.veredito}`);
}

process.exitCode = divergentes.length || !restauracaoOk ? 1 : 0;

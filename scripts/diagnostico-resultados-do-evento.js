#!/usr/bin/env node
// ==========================================================================
// DIAGNÓSTICO SOMENTE LEITURA — POR QUE A PÁGINA PÚBLICA DE UM EVENTO MOSTRA
// "0 ATLETAS" E "RESULTADOS AINDA NÃO PUBLICADOS".
//
// POR QUE ESTE SCRIPT EXISTE
//
// A plataforma tem DOIS caminhos de resultado, e eles não se cruzam:
//
//   CAMINHO INTERNO      julgamento no MCI  -> `Result` + `ResultEntry`
//                        inscrição no MCI   -> `Registration`
//
//   CAMINHO IMPORTADO    arquivo da origem  -> `MuscleWarImportItem`
//                                           -> `ExternalResult` + `RankingPoint`
//                                           -> `PublicRankingEntry` (projeção pública)
//
// `publicService.eventPage` lê SÓ o caminho interno:
//
//     results  <- Result       where eventId = <evento> AND status = 'PUBLISHED'
//     athletes <- Registration where eventId = <evento> AND status = 'CONFIRMED'
//
// Um evento cujos resultados entraram por IMPORTAÇÃO não tem uma linha em
// `Result` nem em `Registration`. As duas consultas voltam vazias, a página
// mostra "0 atletas" e "Resultados ainda não publicados" — e as duas frases
// dizem a verdade sobre as tabelas que elas consultam, enquanto os resultados
// existem, homologados, nas outras três.
//
// ESTE SCRIPT NÃO ALTERA NADA. Ele conta as duas famílias para o MESMO evento e
// diz qual delas tem dado — que é a diferença entre três diagnósticos
// completamente diferentes: "falta importar", "falta homologar" e "a página lê
// o lugar errado".
//
//     node scripts/diagnostico-resultados-do-evento.js <slug-do-evento> <id-SUPER_ADMIN>
//     node scripts/diagnostico-resultados-do-evento.js --listar-eventos
//
// POR QUE EXIGE UM ID
//
// `RankingPoint` e `ExternalResult` têm política de leitura
// `mci_operator_of("organizationId")`; `PublicRankingEntry` tem
// `mci_operator_of(...) OR mci_ranking_publicado("seasonId")`. Um `PrismaClient`
// cru não passa por `withUserContext` e não tem `mci.user_id`: as consultas
// voltariam VAZIAS e o script relataria "não há resultado importado" quando o
// que houve foi "não consigo ver resultado importado". São opostos, e apareciam
// iguais — foi exatamente o defeito corrigido no diagnóstico de delegações.
//
// O contexto é declarado com `set_config('mci.user_id', $1, true)` — o MESMO
// `SET LOCAL` de toda requisição autenticada. Nenhum mecanismo novo: nem
// BYPASSRLS, nem SECURITY DEFINER, nem política afrouxada.
//
// NENHUM SEGREDO É IMPRESSO: a DATABASE_URL não aparece, nem parcialmente.
// Nenhum e-mail, telefone ou CPF sai na saída.
// ==========================================================================

// A URL É LIDA DO AMBIENTE **ANTES** DO `require` — `require('@prisma/client')`
// carrega o `.env` para `process.env`, e sem esta captura a recusa por ausência
// de ambiente nunca dispara numa máquina que tenha `.env`: o script conectaria
// em OUTRO banco e imprimiria números plausíveis sem dizer qual leu.
const URL_DO_AMBIENTE = process.env.DATABASE_URL;

const { PrismaClient } = require('@prisma/client');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const AMARELO = s => `\x1b[33m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

// Os mesmos filtros de `publicService.eventPage`, palavra por palavra. Se um dia
// divergirem, o diagnóstico deixa de diagnosticar a tela.
const STATUS_DE_RESULTADO_PUBLICO = 'PUBLISHED';
const STATUS_DE_INSCRICAO_PUBLICA = 'CONFIRMED';

const linha = (rotulo, valor) => console.log(`  ${rotulo.padEnd(52)} ${valor}`);

async function listarEventos(prisma) {
  // `Event` não tem RLS: esta listagem não depende de contexto.
  const eventos = await prisma.event.findMany({
    select: { slug: true, name: true, status: true, startDate: true },
    orderBy: { startDate: 'desc' },
    take: 50
  });
  console.log('=== EVENTOS (50 mais recentes) ===\n');
  for (const e of eventos) {
    console.log(`  ${e.slug.padEnd(44)} ${e.status.padEnd(10)} `
      + `${new Date(e.startDate).toISOString().slice(0, 10)}  ${e.name}`);
  }
  console.log(`\n${eventos.length} evento(s). Rode de novo passando um destes slugs.`);
}

async function principal() {
  if (!URL_DO_AMBIENTE) {
    console.error('DATABASE_URL ausente no ambiente. Rode no mesmo ambiente da aplicação.');
    process.exitCode = 2;
    return;
  }

  const slug = process.argv[2] || '';
  const idDoAdministrador = process.argv[3] || process.env.MCI_ADMIN_ID || '';

  const prisma = new PrismaClient();
  try {
    if (slug === '--listar-eventos') return listarEventos(prisma);

    if (!slug || !idDoAdministrador) {
      console.error('Informe o slug do evento e o id de uma conta SUPER_ADMIN:');
      console.error('  node scripts/diagnostico-resultados-do-evento.js <slug> <id>');
      console.error('Para ver os slugs:');
      console.error('  node scripts/diagnostico-resultados-do-evento.js --listar-eventos');
      console.error('Para ver os ids:');
      console.error('  node scripts/diagnostico-delegacoes-inertes.js --listar-admins');
      console.error('');
      console.error('O ID NÃO É BUROCRACIA: `RankingPoint`, `ExternalResult` e `PublicRankingEntry`');
      console.error('têm RLS de operador. Sem contexto a consulta volta VAZIA, e vazio aqui NÃO');
      console.error('significa "não há resultado importado" — significa "não consigo ver".');
      process.exitCode = 2;
      return;
    }

    // O NOME DO BANCO NA SAÍDA. Nome de banco não é segredo — a credencial é —, e
    // sem ele a evidência guardada não diz de onde veio.
    const [{ banco }] = await prisma.$queryRaw`SELECT current_database() AS banco`;
    console.log(`banco consultado: ${banco}\n`);

    const evento = await prisma.event.findUnique({
      where: { slug },
      select: {
        id: true, name: true, slug: true, status: true, startDate: true, endDate: true,
        organizationId: true,
        organization: { select: { id: true, name: true, slug: true, active: true } }
      }
    });

    if (!evento) {
      console.error(`Nenhum evento com slug "${slug}".`);
      console.error('Liste os slugs com --listar-eventos: a página pública usa o SLUG, e um slug');
      console.error('diferente do que está na URL é, por si só, a explicação de uma página vazia.');
      process.exitCode = 2;
      return;
    }

    console.log('=== O EVENTO ===\n');
    linha('id', evento.id);
    linha('nome', evento.name);
    linha('slug', evento.slug);
    linha('situação', evento.status);
    linha('início', new Date(evento.startDate).toISOString().slice(0, 10));
    linha('organização', `${evento.organization.name} [${evento.organizationId}]`);
    linha('organização ativa', evento.organization.active ? 'sim' : AMARELO('NÃO'));
    console.log('');

    // A VISIBILIDADE DO EVENTO VEM ANTES DE TUDO: `eventPage` responde 404 quando
    // o status não está na lista visível, e aí nem chega a consultar resultado.
    if (!evento.organization.active) {
      console.log(AMARELO('ATENÇÃO: a organização está inativa. `mci_ranking_publicado` devolve falso,'));
      console.log(AMARELO('e a leitura ANÔNIMA de `PublicRankingEntry` volta vazia mesmo havendo dado.'));
      console.log('');
    }

    // ---------------------------------------------------------- CAMINHO INTERNO
    //
    // `Registration` não tem RLS. `Result` tem política
    // `status = 'PUBLISHED' OR operador`, então a contagem por status abaixo
    // precisa de contexto para ver os NÃO publicados — e é justamente a
    // diferença entre "não há resultado" e "há resultado não publicado".
    const inscricoes = await prisma.registration.groupBy({
      by: ['status'], where: { eventId: evento.id }, _count: { _all: true }
    });

    const comContexto = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('mci.user_id', ${idDoAdministrador}, true)`;

      const [contexto] = await tx.$queryRaw`
        SELECT mci_current_user_id() AS usuario, mci_is_platform_admin() AS administrador`;

      if (contexto?.usuario !== idDoAdministrador) {
        throw Object.assign(new Error('contexto não aplicado'), { code: 'CONTEXTO_NAO_APLICADO' });
      }
      // Sem isto, uma conta comum leria só o que é dela e o script apresentaria
      // uma leitura parcial como se fosse o quadro inteiro.
      if (contexto?.administrador !== true) {
        throw Object.assign(new Error('conta não é administradora de plataforma'), { code: 'CONTA_NAO_ADMINISTRADORA' });
      }

      const resultados = await tx.result.groupBy({
        by: ['status'], where: { eventId: evento.id }, _count: { _all: true }
      });
      const entradasPublicadas = await tx.resultEntry.count({
        where: { result: { eventId: evento.id, status: STATUS_DE_RESULTADO_PUBLICO } }
      });

      const lancamentos = await tx.rankingPoint.groupBy({
        by: ['source'], where: { eventId: evento.id }, _count: { _all: true }
      });
      const lancamentosInvalidados = await tx.rankingPoint.count({
        where: { eventId: evento.id, voidedAt: { not: null } }
      });
      const lancamentosVivos = await tx.rankingPoint.count({
        where: { eventId: evento.id, voidedAt: null }
      });
      const projecao = await tx.publicRankingEntry.groupBy({
        by: ['voided'], where: { eventId: evento.id }, _count: { _all: true }
      });

      // `ExternalResult` NÃO tem `eventId` — ela guarda `eventName`/`eventDate`.
      // A contagem por nome é aproximada de propósito, e a saída diz isso: ela
      // serve para achar o lote, não para decidir nada.
      const externosPorNome = await tx.externalResult.count({
        where: { organizationId: evento.organizationId, eventName: { contains: evento.name, mode: 'insensitive' } }
      });
      const externosDaOrganizacao = await tx.externalResult.count({
        where: { organizationId: evento.organizationId }
      });

      const lotes = await tx.muscleWarImport.groupBy({
        by: ['status'], where: { organizationId: evento.organizationId }, _count: { _all: true }
      });

      const temporadas = await tx.rankingSeason.findMany({
        where: { organizationId: evento.organizationId },
        select: { id: true, name: true, year: true, status: true },
        orderBy: { year: 'desc' }, take: 10
      });

      return {
        resultados, entradasPublicadas, lancamentos, lancamentosVivos, lancamentosInvalidados,
        projecao, externosPorNome, externosDaOrganizacao, lotes, temporadas
      };
    });

    const soma = grupos => grupos.reduce((total, g) => total + g._count._all, 0);
    const doStatus = (grupos, status) => grupos.find(g => g.status === status)?._count._all ?? 0;

    console.log('=== CAMINHO INTERNO — é o que a página pública lê hoje ===\n');
    linha(`Registration (todas)`, soma(inscricoes));
    linha(`Registration status=${STATUS_DE_INSCRICAO_PUBLICA}  -> "N atletas"`,
      doStatus(inscricoes, STATUS_DE_INSCRICAO_PUBLICA));
    for (const g of inscricoes.filter(g => g.status !== STATUS_DE_INSCRICAO_PUBLICA)) {
      linha(CINZA(`  Registration status=${g.status}`), g._count._all);
    }
    linha('Result (todos)', soma(comContexto.resultados));
    linha(`Result status=${STATUS_DE_RESULTADO_PUBLICO}  -> aba "Resultados"`,
      doStatus(comContexto.resultados, STATUS_DE_RESULTADO_PUBLICO));
    for (const g of comContexto.resultados.filter(g => g.status !== STATUS_DE_RESULTADO_PUBLICO)) {
      linha(CINZA(`  Result status=${g.status}`), g._count._all);
    }
    linha('ResultEntry dos resultados publicados', comContexto.entradasPublicadas);
    console.log('');

    console.log('=== CAMINHO IMPORTADO — existe e a página NÃO lê ===\n');
    linha('RankingPoint com eventId deste evento (vivos)', comContexto.lancamentosVivos);
    linha(CINZA('  destes, invalidados'), comContexto.lancamentosInvalidados);
    for (const g of comContexto.lancamentos) {
      linha(`  RankingPoint source=${g.source}`, g._count._all);
    }
    linha('PublicRankingEntry com eventId deste evento', soma(comContexto.projecao));
    for (const g of comContexto.projecao) {
      linha(`  PublicRankingEntry voided=${g.voided}`, g._count._all);
    }
    linha('ExternalResult com eventName parecido', comContexto.externosPorNome);
    linha(CINZA('  ExternalResult da organização (total)'), comContexto.externosDaOrganizacao);
    for (const g of comContexto.lotes) {
      linha(`MuscleWarImport status=${g.status}`, g._count._all);
    }
    console.log('');
    console.log(CINZA('`ExternalResult` não tem coluna de evento: a contagem por nome é aproximada'));
    console.log(CINZA('e serve para localizar o lote, não para decidir nada.'));
    console.log('');

    if (comContexto.temporadas.length) {
      console.log('=== TEMPORADAS DA ORGANIZAÇÃO ===\n');
      for (const t of comContexto.temporadas) {
        linha(`${t.year} ${t.name}`, `${t.status}  [${t.id}]`);
      }
      console.log('');
    }

    // ------------------------------------------------------------- O VEREDITO
    const internoTemDado = doStatus(comContexto.resultados, STATUS_DE_RESULTADO_PUBLICO) > 0;
    const importadoTemDado = comContexto.lancamentosVivos > 0
      || soma(comContexto.projecao) > 0;

    console.log('=== VEREDITO ===\n');

    if (internoTemDado) {
      console.log(VERDE('A página TEM resultado interno publicado para mostrar.'));
      console.log('Se a tela mostra vazio mesmo assim, o problema não é de dado: confira o slug da');
      console.log('URL contra o slug acima, e a situação do evento contra a lista de visíveis.');
      return;
    }

    if (importadoTemDado) {
      console.log(AMARELO('DIAGNÓSTICO: os resultados EXISTEM pelo caminho importado e a página lê'));
      console.log(AMARELO('apenas o caminho interno. Não falta importar nem homologar — a consulta'));
      console.log(AMARELO('pública do evento não olha para onde o dado está.'));
      console.log('');
      console.log('Nada a corrigir em dado. A correção é de leitura, em `publicService.eventPage`.');
      // Saída 1: há algo a fazer, e não é ato administrativo — é publicação de código.
      process.exitCode = 1;
      return;
    }

    console.log(AMARELO('NENHUM dos dois caminhos tem resultado para este evento.'));
    console.log('Aqui o diagnóstico é de DADO, não de tela:');
    console.log('  * há lote de importação para a organização? (linhas MuscleWarImport acima)');
    console.log('  * o lote foi APLICADO, ou parou em PREVIEWED / REJECTED?');
    console.log('  * o lote foi aplicado APONTANDO para este evento? `RankingPoint.eventId` é');
    console.log('    opcional: um lote aplicado sem evento gera ponto de temporada sem evento,');
    console.log('    e o ponto aparece no ranking e não na página do evento.');
    console.log('');
    console.log('Nada é corrigido por este script. Reaplicar ou revincular lote é ato');
    console.log('administrativo, pela rota, com trilha.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const EXPLICACAO = {
  CONTEXTO_NAO_APLICADO:
    'o banco não aceitou `mci.user_id`. As leituras do caminho importado seriam vazias por falta\n'
    + 'de contexto, e vazio aqui NÃO significa "não há resultado". Nada foi relatado de propósito.',
  CONTA_NAO_ADMINISTRADORA:
    'o id informado não é de uma conta SUPER_ADMIN. Com ele, as políticas devolveriam apenas o\n'
    + 'que é daquela conta — uma leitura parcial apresentada como se fosse o quadro inteiro.'
};

principal().catch(erro => {
  // A mensagem do Prisma pode carregar a URL de conexão; aqui sai só o código.
  console.error(`falha no diagnóstico: ${erro.code ?? erro.name ?? 'erro'}`);
  if (EXPLICACAO[erro.code]) console.error(EXPLICACAO[erro.code]);
  process.exitCode = 2;
});

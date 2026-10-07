const prisma = require('../config/prisma');
// O LEITOR DA SUPERFÍCIE PÚBLICA — ver `src/config/prismaPublico.js`.
//
// `resultadosImportadosDoEvento` é projeção pública pelos mesmos motivos que o
// ranking e o Super Overall: os bytes que saem dela são os que o visitante
// anônimo já recebe hoje por `GET /ranking/by?eventId=...`. Sem este leitor, a
// função entregaria MENOS a quem se identificou — `atleta_leitura` libera a
// linha do atleta para `mci_current_user_id() IS NULL`, e um atleta logado de
// OUTRA federação não é anônimo: o nome viria em branco para ele e apareceria
// para o visitante deslogado. É exatamente o defeito que fez este leitor nascer.
const publico = require('../config/prismaPublico');
const { AppError } = require('../utils/errors');
const { athletePublic } = require('../utils/visibility');
const publishedResults = require('./publishedResultsService');

// Vitrine pública: só dado público, e sempre da base real.
// Nenhuma rota daqui expõe CPF, telefone, e-mail, documento ou resultado ainda
// não publicado.

const EVENTOS_VISIVEIS = Object.freeze(['PLANNED', 'REGISTRATIONS_OPEN', 'REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING', 'RESULTS_IN_REVIEW', 'RESULTS_PUBLISHED', 'CLOSED']);

async function summary() {
  const [eventos, atletas, pros, resultados, temporadas] = await Promise.all([
    prisma.event.count({ where: { status: { in: EVENTOS_VISIVEIS } } }),
    prisma.athlete.count(),
    prisma.athlete.count({ where: { proStatus: 'ACTIVE' } }),
    // NÃO é `result.count`. A conta anterior contava só a apuração recebida
    // pelo MCI, e o histórico importado — que é a maior parte do acervo desta
    // plataforma — ficava de fora: uma etapa inteira aplicada devolvia zero.
    // A regra mora em publishedResultsService.js, um lugar só para os dois
    // cartões que a exibem.
    publishedResults.paraOPublico(),
    prisma.rankingSeason.count({ where: { status: 'OPEN' } })
  ]);

  const proximos = await prisma.event.findMany({
    where: { status: { in: ['PLANNED', 'REGISTRATIONS_OPEN'] }, startDate: { gte: new Date() } },
    select: { id: true, name: true, slug: true, startDate: true, city: true, state: true, venue: true },
    orderBy: { startDate: 'asc' },
    take: 5
  });

  return {
    events: eventos,
    athletes: atletas,
    proAthletes: pros,
    publishedResults: resultados.total,
    // A COMPOSIÇÃO, e não só o total. O defeito que este campo evita é o que
    // acabou de custar uma investigação: um número sozinho não diz se o zero é
    // "não há resultado" ou "há, e a conta não os vê".
    publishedResultsBreakdown: { received: resultados.received, imported: resultados.imported },
    openSeasons: temporadas,
    upcoming: proximos
  };
}

async function listEvents(filtros) {
  const items = await prisma.event.findMany({
    where: { status: { in: EVENTOS_VISIVEIS }, ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {}) },
    select: {
      id: true, name: true, slug: true, status: true, startDate: true, endDate: true,
      city: true, state: true, venue: true, description: true,
      organization: { select: { id: true, name: true, slug: true } },
      _count: { select: { registrations: true } }
    },
    // Mesma direção da listagem de operação: as duas telas mostram o mesmo
    // calendário e discordar seria defeito. O `createdAt` entra como segundo
    // critério porque sem ele a ordem entre etapas do MESMO dia é indefinida,
    // e ordem indefinida com cursor pode repetir ou pular linha entre páginas.
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return { items, nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

// Página pública do campeonato: agenda, categorias, atletas, resultados
// publicados, patrocinadores e conteúdo social do evento.
// Competidores distintos do evento, somando os dois caminhos sem contar ninguém
// duas vezes. O atleta com cadastro é identificado pelo id; o competidor sem
// cadastro, pelo nome da fonte — que é o único identificador que ele tem na
// projeção pública.
function contarCompetidores(inscricoes, gruposImportados) {
  const vistos = new Set();

  for (const item of inscricoes) {
    if (item.athlete?.id) vistos.add(`atleta:${item.athlete.id}`);
  }
  for (const grupo of gruposImportados) {
    for (const entrada of grupo.entries) {
      if (entrada.athleteId) vistos.add(`atleta:${entrada.athleteId}`);
      else if (entrada.name) vistos.add(`fonte:${entrada.name}`);
    }
  }

  return vistos.size;
}

// ============================================================================
// OS RESULTADOS DO EVENTO QUE ENTRARAM POR IMPORTAÇÃO.
//
// A PLATAFORMA TEM DOIS CAMINHOS DE RESULTADO, E ELES NÃO SE CRUZAM:
//
//   CAMINHO INTERNO     julgamento no MCI  -> `Result` + `ResultEntry`
//                       inscrição no MCI   -> `Registration`
//
//   CAMINHO IMPORTADO   arquivo da origem  -> `MuscleWarImportItem`
//                                          -> `ExternalResult` + `RankingPoint`
//                                          -> `PublicRankingEntry`
//
// Até aqui `eventPage` lia SÓ o primeiro. Medido: um evento cujos resultados
// entraram por importação não tem uma única linha em `Result` nem em
// `Registration`, então as duas consultas voltavam vazias e a página dizia
// "0 atletas" e "Resultados ainda não publicados" — duas frases verdadeiras
// sobre as tabelas consultadas, e falsas sobre o evento, cujos resultados
// estavam homologados nas outras três. A etapa do Ipiranga é esse caso.
//
// POR QUE `PublicRankingEntry` E NÃO `RankingPoint`
//
// `RankingPoint` tem política de leitura de OPERADOR: numa rota pública ela
// devolve zero linha, e zero linha aqui seria indistinguível de "não há
// resultado" — o mesmo defeito que já custou um diagnóstico falso nesta base.
// `PublicRankingEntry` é a projeção pública da mesma verdade, com política
// `mci_operator_of(...) OR mci_ranking_publicado("seasonId")`, e é a tabela que
// `GET /ranking/by?eventId=...` já serve ao anônimo. Ler dela não abre nada novo:
// muda o LUGAR de onde a página do evento lê, não quem pode ler.
//
// O QUE NÃO ACONTECE AQUI
//
// Nada é publicado, homologado, recalculado ou criado. A função é uma leitura.
// `voided: false` exclui o lançamento invalidado — que continua no ledger,
// valendo zero, e não volta a aparecer como resultado por causa desta tela.
// A pontuação exibida é a que o motor oficial já gravou; nenhuma conta é feita
// aqui, e por isso nenhuma regra esportiva é tocada.
// ============================================================================
const TETO_DE_RESULTADOS_IMPORTADOS = 2000;

async function resultadosImportadosDoEvento(event) {
  const entradas = await publico.publicRankingEntry.findMany({
    // `organizationId` entra junto com `eventId` por duas razões: é o filtro de
    // tenancy explícito (o mesmo que a política confere) e é coluna indexada.
    where: { eventId: event.id, organizationId: event.organizationId, voided: false },
    select: {
      id: true, athleteId: true, displayName: true,
      categoryId: true, catalogClassId: true,
      placing: true, points: true, isOverallChampion: true, didNotShow: true
    },
    orderBy: [{ placing: 'asc' }],
    take: TETO_DE_RESULTADOS_IMPORTADOS
  });

  if (!entradas.length) return [];

  // O NOME DO COMPETIDOR VEM DE DOIS LUGARES, E ISSO NÃO É REDUNDÂNCIA.
  //
  // `republicarProjecao` grava `displayName` APENAS quando não há cadastro
  // (`ponto.athleteId ? null : externalAthlete.displayName`). Quem tem cadastro
  // precisa do nome buscado em `Athlete` — e é por isso que esta leitura usa o
  // leitor público: a política do atleta libera o anônimo, e o autenticado de
  // outra federação ficaria sem o nome.
  const idsDeAtleta = [...new Set(entradas.map(linha => linha.athleteId).filter(Boolean))];
  const atletas = new Map(
    (idsDeAtleta.length
      ? await publico.athlete.findMany({
        where: { id: { in: idsDeAtleta } },
        select: {
          id: true, fullName: true, stageName: true, city: true, state: true,
          team: { select: { id: true, name: true } }
        }
      })
      : []).map(atleta => [atleta.id, atleta])
  );

  const idsDeCategoria = [...new Set(entradas.map(linha => linha.categoryId).filter(Boolean))];
  const categorias = new Map(
    (idsDeCategoria.length
      ? await publico.category.findMany({
        where: { id: { in: idsDeCategoria } }, select: { id: true, name: true, code: true }
      })
      : []).map(categoria => [categoria.id, categoria])
  );

  const idsDeClasse = [...new Set(entradas.map(linha => linha.catalogClassId).filter(Boolean))];
  const classes = new Map(
    (idsDeClasse.length
      ? await publico.classCatalog.findMany({
        where: { id: { in: idsDeClasse } }, select: { id: true, name: true, code: true }
      })
      : []).map(classe => [classe.id, classe])
  );

  // A CLASSE OFICIAL ENTRA NO AGRUPAMENTO, E A CATEGORIA SOZINHA NÃO SERVE.
  //
  // Cada participação é uma disputa independente: o mesmo atleta pontua em
  // quantas classes disputar, e "1º lugar" só quer dizer alguma coisa dentro de
  // uma classe. Agrupar só por categoria juntaria seis primeiros lugares
  // diferentes na mesma lista, e a página mostraria um pódio que não existiu.
  const grupos = new Map();
  for (const linha of entradas) {
    const chave = `${linha.categoryId ?? 'sem-categoria'}::${linha.catalogClassId ?? 'sem-classe'}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        key: chave,
        category: linha.categoryId ? categorias.get(linha.categoryId) ?? null : null,
        competitionClass: linha.catalogClassId ? classes.get(linha.catalogClassId) ?? null : null,
        entries: []
      });
    }

    const atleta = linha.athleteId ? atletas.get(linha.athleteId) ?? null : null;
    grupos.get(chave).entries.push({
      id: linha.id,
      placing: linha.placing,
      points: linha.points,
      isOverallChampion: linha.isOverallChampion,
      didNotShow: linha.didNotShow,
      // `athleteId` sai para a página poder linkar o perfil de quem tem
      // cadastro; quem não tem aparece pelo nome da fonte e sem link.
      athleteId: linha.athleteId ?? null,
      // Nome da fonte para o competidor sem cadastro; nome do cadastro para
      // quem tem. Nunca os dois, nunca nenhum quando existe um dos dois.
      name: atleta ? (atleta.stageName || atleta.fullName) : (linha.displayName ?? null),
      team: atleta?.team ?? null,
      city: atleta?.city ?? null,
      state: atleta?.state ?? null
    });
  }

  for (const grupo of grupos.values()) {
    // `placing` nulo (não comparecimento sem colocação) vai para o fim: ele é
    // participação, e participação sem colocação não disputa posição com o pódio.
    grupo.entries.sort((a, b) => (a.placing ?? Number.MAX_SAFE_INTEGER) - (b.placing ?? Number.MAX_SAFE_INTEGER));
  }

  return [...grupos.values()];
}

async function eventPage(slug) {
  const event = await prisma.event.findUnique({
    where: { slug },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
      eventCategories: {
        orderBy: { sortOrder: 'asc' },
        include: { category: true, divisions: { orderBy: { sortOrder: 'asc' }, include: { classes: { orderBy: { sortOrder: 'asc' } } } } }
      },
      batches: {
        orderBy: [{ sortOrder: 'asc' }, { scheduledAt: 'asc' }],
        include: { competitionClass: { select: { id: true, name: true } } }
      },
      sponsorships: { where: { status: 'ACTIVE' }, include: { sponsor: { select: { id: true, name: true, brand: { select: { id: true, name: true, slug: true } } } } } }
    }
  });

  if (!event || !EVENTOS_VISIVEIS.includes(event.status)) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  }

  const resultados = await prisma.result.findMany({
    where: { eventId: event.id, status: 'PUBLISHED' },
    include: {
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } },
      entries: {
        where: { status: 'RANKED' },
        // `photoKey` entra para virar `hasPhoto` logo abaixo; a chave não sai
        // daqui. É caminho interno do armazenamento, e a foto é servida por
        // `/media/athletes/:id/photo`, que a resolve no servidor.
        include: { athlete: { select: { id: true, fullName: true, stageName: true, state: true, city: true, photoKey: true, team: { select: { id: true, name: true } } } } },
        orderBy: { placing: 'asc' }
      }
    },
    orderBy: { publishedAt: 'asc' }
  });

  const atletas = await prisma.registration.findMany({
    where: { eventId: event.id, status: 'CONFIRMED' },
    select: { athlete: { select: { id: true, fullName: true, stageName: true, state: true, city: true, proStatus: true, photoKey: true, team: { select: { id: true, name: true } } } } },
    orderBy: { athlete: { fullName: 'asc' } },
    take: 500
  });

  // A LEITURA QUE FALTAVA. Não substitui a de cima: um evento pode ter as duas
  // coisas, e nesse caso as duas aparecem, cada uma com o seu selo de origem.
  const importados = await resultadosImportadosDoEvento(event);

  const posts = await prisma.post.findMany({
    where: { eventId: event.id, visibility: 'PUBLIC', deletedAt: null },
    include: { author: true, media: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  // A CHAVE DA FOTO MORRE AQUI. Os dois SELECTs acima a trouxeram para derivar
  // `hasPhoto`; o que sai no corpo é só o booleano. Uma função, usada nos dois
  // lugares, para que não haja um caminho que esqueça de limpar.
  const semChave = atleta => {
    if (!atleta) return atleta;
    const { photoKey, ...resto } = atleta;
    return { ...resto, hasPhoto: Boolean(photoKey) };
  };

  return {
    event: {
      id: event.id, name: event.name, slug: event.slug, description: event.description,
      status: event.status, startDate: event.startDate, endDate: event.endDate,
      venue: event.venue, city: event.city, state: event.state, timezone: event.timezone,
      organization: event.organization
    },
    categories: event.eventCategories,
    schedule: event.batches,
    athletes: atletas.map(item => semChave(item.athlete)),
    results: resultados.map(resultado => ({
      ...resultado,
      entries: resultado.entries.map(entrada => ({ ...entrada, athlete: semChave(entrada.athlete) }))
    })),
    // Resultados homologados que entraram por importação, agrupados por
    // categoria e classe oficial. Lista vazia quando o evento não tem nenhum.
    importedResults: importados,
    // QUANTOS COMPETIDORES O EVENTO TEVE, DE VERDADE.
    //
    // A página mostrava `athletes.length` — inscrições CONFIRMADAS no MCI —, e
    // num evento importado esse número é zero por construção. Zero atletas ao
    // lado de uma lista de resultados é a contradição que motivou este achado.
    //
    // O número aqui é a UNIÃO dos dois caminhos, sem dupla contagem: cada
    // inscrição confirmada conta uma vez, cada competidor com resultado
    // importado conta uma vez, e quem aparece nos dois conta uma vez só — a
    // chave da projeção (`id` do lançamento) não serve para isso, então a
    // deduplicação é por atleta quando há cadastro e por nome da fonte quando
    // não há, que é o mesmo par que distingue competidor na projeção.
    competitorCount: contarCompetidores(atletas, importados),
    sponsors: event.sponsorships.map(item => item.sponsor),
    posts: posts.map(post => ({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      author: { id: post.author.id, handle: post.author.handle, displayName: post.author.displayName, hasAvatar: Boolean(post.author.avatarKey) },
      media: post.media.map(item => ({ id: item.id, kind: item.kind }))
    }))
  };
}

// ============================================================================
// FILIAÇÕES ABERTAS A AUTOCADASTRO.
//
// Existe porque `GET /affiliations` é escopado ao VÍNCULO do ator, e quem
// acaba de criar conta não tem vínculo nenhum: a lista voltava vazia sempre, e
// a fila de perfil de atleta ficava inalcançável para quem ela atende. Medido
// na API, não deduzido.
//
// A exposição é decidida por TRÊS condições, e nenhuma delas vem do cliente:
//
//   organization.selfRegistrationOpen  a federação decidiu receber pedido
//                                      espontâneo (padrão: false)
//   organization.active                a federação está operando
//   affiliation.active                 a filiação está válida
//
// O que sai daqui é só o necessário para escolher numa lista: id, nome,
// código, tipo e UF, mais o nome da federação para contexto. NÃO sai o
// `organizationId` — a solicitação deriva a federação da filiação escolhida,
// no servidor, e devolver o id aqui só serviria para alguém tentar mandá-lo
// de volta.
// ============================================================================
async function listAffiliations(filtros = {}) {
  const termo = (filtros.search || '').trim();

  return prisma.affiliation.findMany({
    where: {
      active: true,
      organization: { active: true, selfRegistrationOpen: true },
      ...(termo
        ? { OR: [{ name: { contains: termo, mode: 'insensitive' } }, { code: { contains: termo.toUpperCase() } }] }
        : {})
    },
    select: {
      id: true,
      name: true,
      code: true,
      kind: true,
      state: true,
      organization: { select: { name: true } }
    },
    orderBy: [{ name: 'asc' }],
    take: Math.min(filtros.limit || 100, 200)
  });
}

async function athletePage(id) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    include: {
      team: { select: { id: true, name: true } },
      coach: { select: { id: true, name: true } },
      gym: { select: { id: true, name: true } },
      affiliation: { select: { id: true, name: true, code: true } },
      socialProfile: { select: { id: true, handle: true, displayName: true, bio: true, isPrivate: true } }
    }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  // AS DUAS ORIGENS, PELA MESMA REGRA.
  //
  // Esta consulta lia só `ResultEntry` — a apuração RECEBIDA pelo MCI. O
  // histórico IMPORTADO não passa por ali: ele grava `ExternalResult` +
  // `RankingPoint`, e o importador nunca toca em `Result`. O efeito era a tela
  // se contradizendo no mesmo bloco de métricas: "30 pontos somados" (que vem
  // de `Ranking`, alimentado pelo ledger) ao lado de "0 resultados publicados"
  // e "ainda sem resultados publicados".
  //
  // A regra de "publicado" já existia num lugar só, por causa do mesmo defeito
  // nos cartões da organização. O que faltava era o perfil do atleta usá-la.
  // Nada foi afrouxado: rascunho, resultado em revisão e lote invalidado
  // continuam fora.
  const participacoes = await publishedResults.participacoesDoAtleta(id, {
    eventosVisiveis: EVENTOS_VISIVEIS
  });

  const rankings = await prisma.ranking.findMany({
    where: { athleteId: id },
    include: { season: { select: { id: true, name: true, year: true } }, category: { select: { id: true, code: true, name: true } } },
    orderBy: { totalPoints: 'desc' }
  });

  return {
    athlete: { ...athletePublic(athlete), socialProfile: athlete.socialProfile },
    // A forma é PLANA e igual para as duas origens: a tela não precisa saber
    // de onde veio cada linha para desenhá-la, e `origem` fica disponível para
    // quem quiser distinguir.
    results: participacoes.map(p => ({
      key: p.chave,
      origin: p.origem,
      placing: p.placing,
      status: p.status,
      points: p.points,
      isOverallChampion: p.isOverallChampion,
      event: p.event,
      eventNavigable: p.eventoNavegavel,
      categoryName: p.categoryName,
      className: p.className,
      publishedAt: p.date
    })),
    titles: participacoes.filter(p => p.placing === 1).length,
    rankings
  };
}

async function listAthletes(filtros) {
  const items = await prisma.athlete.findMany({
    where: filtros.search ? { OR: [{ fullName: { contains: filtros.search, mode: 'insensitive' } }, { stageName: { contains: filtros.search, mode: 'insensitive' } }] } : {},
    include: { team: { select: { id: true, name: true } }, gym: { select: { id: true, name: true } }, coach: { select: { id: true, name: true } }, affiliation: { select: { id: true, name: true, code: true } } },
    orderBy: { fullName: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return { items: items.map(athletePublic), nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

module.exports = { summary, listEvents, eventPage, athletePage, listAthletes, listAffiliations, EVENTOS_VISIVEIS };

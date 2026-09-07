// Controllers são finos por decisão: extraem entrada da requisição, chamam o
// service e devolvem a resposta. Nenhuma regra de negócio mora aqui — assim a
// regra pode ser testada sem HTTP e não existe uma segunda cópia dela.

const auth = require('../services/authService');
const organizations = require('../services/organizationService');
const affiliations = require('../services/affiliationService');
const athletes = require('../services/athleteService');
const events = require('../services/eventService');
const registrations = require('../services/registrationService');
const operations = require('../services/operationsService');
const judging = require('../services/judgingService');
const results = require('../services/resultService');
const ranking = require('../services/rankingService');
const muscleWar = require('../services/muscleWarService');
const partners = require('../services/partnerService');
const social = require('../services/socialService');
const messenger = require('../services/messengerService');
const communities = require('../services/communityService');
const searchService = require('../services/searchService');
const dashboard = require('../services/dashboardService');
const publicService = require('../services/publicService');
const documents = require('../services/documentService');
const notifications = require('../services/notificationService');
const auditService = require('../services/auditService');
const admin = require('../services/adminService');
const scoring = require('../services/scoringService');
const health = require('../services/healthService');
const memberships = require('../services/membershipService');

const ip = req => req.ip || req.headers['x-forwarded-for'] || null;

// Envia um stream de arquivo com cabeçalhos seguros: nada é interpretado pelo
// navegador como HTML e o nome do arquivo vai citado.
function enviarArquivo(res, stream, { mimeType, fileName, inline = false }) {
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(fileName || 'arquivo').replace(/["\\]/g, '')}"`);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

module.exports = {
  health: {
    health: async (req, res) => res.json(health.health()),
    ready: async (req, res) => {
      const estado = await health.ready();
      res.status(estado.ready ? 200 : 503).json(estado);
    }
  },

  auth: {
    register: async (req, res) => res.status(201).json(await auth.register(req.body, { ip: ip(req) })),
    login: async (req, res) => res.json(await auth.login(req.body, { ip: ip(req) })),
    me: async (req, res) => res.json(await auth.me(req.user.id)),
    updateProfile: async (req, res) => res.json(await auth.updateProfile(req.user.id, req.body)),
    changePassword: async (req, res) => res.json(await auth.changePassword(req.user.id, req.body))
  },

  organizations: {
    list: async (req, res) => res.json({ items: await organizations.list(req.user) }),
    create: async (req, res) => res.status(201).json(await organizations.create(req.body, req.user)),
    findById: async (req, res) => res.json(await organizations.findById(req.params.id, req.user)),
    addMember: async (req, res) => res.status(201).json(await organizations.addMember(req.params.id, req.body, req.user)),
    removeMember: async (req, res) => res.json(await organizations.removeMember(req.params.id, req.params.membershipId, req.user))
  },

  affiliations: {
    list: async (req, res) => res.json({ items: await affiliations.list(req.query, req.user) }),
    create: async (req, res) => res.status(201).json(await affiliations.create(req.body, req.user)),
    activate: async (req, res) => res.json(await affiliations.setActive(req.params.id, true, req.user)),
    deactivate: async (req, res) => res.json(await affiliations.setActive(req.params.id, false, req.user))
  },

  athletes: {
    linkTeam: async (req, res) => res.status(201).json(await memberships.link(req.params.id, req.body, req.user)),
    transferTeam: async (req, res) => res.json(await memberships.transfer(req.params.id, req.body, req.user)),
    unlinkTeam: async (req, res) => res.json(await memberships.unlink(req.params.id, req.body, req.user)),
    teamHistory: async (req, res) => res.json({ items: await memberships.history(req.params.id, req.user) }),
    list: async (req, res) => res.json(await athletes.list(req.query, req.user)),
    create: async (req, res) => res.status(201).json(await athletes.create(req.body, req.user)),
    findById: async (req, res) => res.json(await athletes.findById(req.params.id, req.user)),
    update: async (req, res) => res.json(await athletes.update(req.params.id, req.body, req.user)),
    lookup: async (req, res) => res.json(await athletes.lookup(req.body, req.user)),
    setProStatus: async (req, res) => res.json(await athletes.setProStatus(req.params.id, req.body, req.user)),
    listPro: async (req, res) => res.json(await athletes.listPro(req.query, req.user))
  },

  events: {
    list: async (req, res) => res.json(await events.list(req.query, req.user)),
    create: async (req, res) => res.status(201).json(await events.create(req.body, req.user)),
    findOne: async (req, res) => res.json(await events.findBySlugOrId(req.params.id, req.user)),
    update: async (req, res) => res.json(await events.update(req.params.id, req.body, req.user)),
    transition: async (req, res) => res.json(await events.transition(req.params.id, req.body, req.user)),
    remove: async (req, res) => res.json(await events.remove(req.params.id, req.user)),
    addCategory: async (req, res) => res.status(201).json(await events.addCategory(req.params.id, req.body, req.user)),
    addDivision: async (req, res) => res.status(201).json(await events.addDivision(req.params.eventCategoryId, req.body, req.user)),
    addClass: async (req, res) => res.status(201).json(await events.addClass(req.params.divisionId, req.body, req.user)),
    listCategories: async (req, res) => res.json({ items: await events.listCategories() }),
    createCategory: async (req, res) => res.status(201).json(await events.createCategory(req.body, req.user))
  },

  registrations: {
    create: async (req, res) => res.status(201).json(await registrations.create(req.params.id, req.body, req.user)),
    listByEvent: async (req, res) => res.json(await registrations.listByEvent(req.params.id, req.query, req.user)),
    findById: async (req, res) => res.json(await registrations.findById(req.params.id, req.user)),
    cancel: async (req, res) => res.json(await registrations.cancel(req.params.id, req.body, req.user))
  },

  operations: {
    checkIn: async (req, res) => res.status(201).json(await operations.checkIn(req.params.id, req.body, req.user)),
    cancelCheckIn: async (req, res) => res.json(await operations.cancelCheckIn(req.params.id, req.user)),
    listCheckIns: async (req, res) => res.json(await operations.listCheckIns(req.params.id, req.query, req.user)),
    weighIn: async (req, res) => res.status(201).json(await operations.weighIn(req.params.id, req.body, req.user)),
    listWeighIns: async (req, res) => res.json({ items: await operations.listWeighIns(req.params.id, req.user) }),
    issueCredential: async (req, res) => res.status(201).json(await operations.issueCredential(req.params.id, req.body, req.user)),
    listCredentials: async (req, res) => res.json({ items: await operations.listCredentials(req.params.id, req.user) }),
    revokeCredential: async (req, res) => res.json(await operations.revokeCredential(req.params.id, req.user)),
    scanCredential: async (req, res) => res.json(await operations.scanCredential(req.params.id, req.body, req.user)),
    createBatch: async (req, res) => res.status(201).json(await operations.createBatch(req.params.id, req.body, req.user)),
    listBatches: async (req, res) => res.json({ items: await operations.listBatches(req.params.id, req.user) }),
    setStageOrder: async (req, res) => res.json(await operations.setStageOrder(req.params.id, req.body, req.user)),
    listStageOrder: async (req, res) => res.json(await operations.listStageOrder(req.params.id, req.user)),
    updateBatchStatus: async (req, res) => res.json(await operations.updateBatchStatus(req.params.id, req.body, req.user))
  },

  judging: {
    createPanel: async (req, res) => res.status(201).json(await judging.createPanel(req.params.id, req.body, req.user)),
    listPanels: async (req, res) => res.json({ items: await judging.listPanels(req.params.id, req.user) }),
    addJudge: async (req, res) => res.status(201).json(await judging.addJudge(req.params.id, req.body, req.user)),
    removeJudge: async (req, res) => res.json(await judging.removeJudge(req.params.id, req.params.judgeId, req.user)),
    openSession: async (req, res) => res.status(201).json(await judging.openSession(req.body, req.user)),
    listSessions: async (req, res) => res.json({ items: await judging.listSessions(req.params.id, req.user) }),
    sheet: async (req, res) => res.json(await judging.sessionSheet(req.params.id, req.user)),
    submit: async (req, res) => res.json(await judging.submitScores(req.params.id, req.body, req.user)),
    close: async (req, res) => res.json(await judging.closeSession(req.params.id, req.user))
  },

  results: {
    calculate: async (req, res) => res.json(await results.calculate(req.params.id, req.user)),
    findByClass: async (req, res) => res.json(await results.findByClass(req.params.id, req.user)),
    publish: async (req, res) => res.json(await results.publish(req.params.id, req.body, req.user)),
    override: async (req, res) => res.json(await results.override(req.params.id, req.body, req.user)),
    versions: async (req, res) => res.json({ items: await results.versions(req.params.id, req.user) }),
    listByEvent: async (req, res) => res.json({ items: await results.listByEvent(req.params.id, req.user) })
  },

  ranking: {
    list: async (req, res) => res.json(await ranking.list(req.query, req.user)),
    listSeasons: async (req, res) => res.json({ items: await ranking.listSeasons(req.query, req.user) }),
    createSeason: async (req, res) => res.status(201).json(await ranking.createSeason(req.body, req.user)),
    setPointsRules: async (req, res) => res.json({ items: await ranking.setPointsRules(req.params.id, req.body, req.user) }),
    recompute: async (req, res) => res.json(await ranking.recompute(req.params.id, req.user)),
    athletePoints: async (req, res) => res.json({ items: await ranking.athletePoints(req.params.id, req.query.seasonId, req.user) }),
    by: async (req, res) => res.json(await ranking.athleteRankingBy(req.query.seasonId, {
      classId: req.query.classId ?? null,
      eventId: req.query.eventId ?? null,
      divisionId: req.query.divisionId ?? null,
      categoryId: req.query.categoryId ?? null
    })),
    teams: async (req, res) => res.json(await ranking.teamRanking(req.query.seasonId, { categoryId: req.query.categoryId ?? null })),
    declareOverall: async (req, res) => res.status(201).json(await ranking.declareOverall(req.params.id, req.body, req.user)),
    listOverall: async (req, res) => res.json({ items: await ranking.listOverall(req.params.id) }),
    superOverall: async (req, res) => res.json(await ranking.superOverallRanking(req.query.seasonId, { categoryId: req.query.categoryId ?? null })),
    listClasses: async (req, res) => res.json({ items: await ranking.listClasses(req.query.organizationId, req.user) }),
    upsertClass: async (req, res) => res.status(201).json(await ranking.upsertClass(req.body.organizationId, req.body, req.user)),
    companies: async (req, res) => res.json(await ranking.companyRanking(req.query.seasonId, { categoryId: req.query.categoryId ?? null }))
  },

  muscleWar: {
    list: async (req, res) => res.json({ items: await muscleWar.listImports(req.query, req.user) }),
    create: async (req, res) => res.status(201).json(await muscleWar.createImport(req.body, req.user)),
    preview: async (req, res) => res.json(await muscleWar.preview(req.params.id, req.user)),
    link: async (req, res) => res.json(await muscleWar.linkItem(req.params.itemId, req.body, req.user)),
    apply: async (req, res) => res.json(await muscleWar.apply(req.params.id, req.user)),
    reject: async (req, res) => res.json(await muscleWar.reject(req.params.id, req.body, req.user))
  },

  partners: {
    listTeams: async (req, res) => res.json({ items: await partners.listTeams(req.query, req.user) }),
    createTeam: async (req, res) => res.status(201).json(await partners.createTeam(req.body, req.user)),
    createCompany: async (req, res) => res.status(201).json(await partners.createCompany(req.body, req.user)),
    listCompanies: async (req, res) => res.json({ items: await partners.listCompanies(req.query, req.user) }),
    listGyms: async (req, res) => res.json({ items: await partners.listGyms(req.query, req.user) }),
    createGym: async (req, res) => res.status(201).json(await partners.createGym(req.body, req.user)),
    listCoaches: async (req, res) => res.json({ items: await partners.listCoaches(req.query) }),
    createCoach: async (req, res) => res.status(201).json(await partners.createCoach(req.body, req.user)),
    listBrands: async (req, res) => res.json({ items: await partners.listBrands(req.query, req.user) }),
    createBrand: async (req, res) => res.status(201).json(await partners.createBrand(req.body, req.user)),
    listSponsors: async (req, res) => res.json({ items: await partners.listSponsors(req.query, req.user) }),
    createSponsor: async (req, res) => res.status(201).json(await partners.createSponsor(req.body, req.user)),
    listSponsorships: async (req, res) => res.json({ items: await partners.listSponsorships(req.query, req.user) }),
    createSponsorship: async (req, res) => res.status(201).json(await partners.createSponsorship(req.body, req.user)),
    listPartnerships: async (req, res) => res.json({ items: await partners.listPartnerships(req.query) }),
    createPartnership: async (req, res) => res.status(201).json(await partners.createPartnership(req.body, req.user)),
    setPartnershipStatus: async (req, res) => res.json(await partners.setPartnershipStatus(req.params.id, req.body, req.user))
  },

  social: {
    myProfile: async (req, res) => res.json(await social.meuPerfil(req.user.id)),
    updateProfile: async (req, res) => res.json(await social.updateProfile(req.user.id, req.body)),
    setHandle: async (req, res) => res.json(await social.setHandle(req.user.id, req.body.handle)),
    profile: async (req, res) => res.json(await social.profileByHandle(req.params.handle, req.user)),
    feed: async (req, res) => res.json(await social.feed(req.user?.id, req.query)),
    createPost: async (req, res) => res.status(201).json(await social.createPost(req.user.id, req.body)),
    attachMedia: async (req, res) => res.status(201).json(await social.attachMedia(req.params.id, req.user.id, req.file)),
    getPost: async (req, res) => res.json(await social.getPost(req.params.id, req.user?.id)),
    deletePost: async (req, res) => res.json(await social.deletePost(req.params.id, req.user.id, req.user)),
    like: async (req, res) => res.json(await social.like(req.params.id, req.user.id)),
    unlike: async (req, res) => res.json(await social.unlike(req.params.id, req.user.id)),
    save: async (req, res) => res.json(await social.save(req.params.id, req.user.id)),
    unsave: async (req, res) => res.json(await social.unsave(req.params.id, req.user.id)),
    share: async (req, res) => res.status(201).json(await social.share(req.params.id, req.user.id, req.body)),
    listSaved: async (req, res) => res.json(await social.listSaved(req.user.id, req.query)),
    comment: async (req, res) => res.status(201).json(await social.comment(req.params.id, req.user.id, req.body)),
    listComments: async (req, res) => res.json(await social.listComments(req.params.id, req.user?.id, req.query)),
    deleteComment: async (req, res) => res.json(await social.deleteComment(req.params.id, req.user.id, req.user)),
    follow: async (req, res) => res.json(await social.follow(req.params.handle, req.user.id)),
    unfollow: async (req, res) => res.json(await social.unfollow(req.params.handle, req.user.id)),
    followers: async (req, res) => res.json(await social.listFollowers(req.params.handle, 'followers', req.query)),
    following: async (req, res) => res.json(await social.listFollowers(req.params.handle, 'following', req.query)),
    createStory: async (req, res) => res.status(201).json(await social.createStory(req.user.id, req.file, req.body)),
    listStories: async (req, res) => res.json(await social.listStories(req.user.id)),
    viewStory: async (req, res) => res.json(await social.viewStory(req.params.id, req.user.id)),
    block: async (req, res) => res.json(await social.block(req.params.handle, req.user.id)),
    unblock: async (req, res) => res.json(await social.unblock(req.params.handle, req.user.id)),
    report: async (req, res) => res.status(201).json(await social.report(req.user.id, req.body)),
    listReports: async (req, res) => res.json({ items: await social.listReports(req.query, req.user) }),
    resolveReport: async (req, res) => res.json(await social.resolveReport(req.params.id, req.body, req.user))
  },

  messenger: {
    listConversations: async (req, res) => res.json(await messenger.listConversations(req.user.id, req.query)),
    createConversation: async (req, res) => res.status(201).json(await messenger.createConversation(req.user.id, req.body)),
    getConversation: async (req, res) => res.json(await messenger.getConversation(req.params.id, req.user.id)),
    listMessages: async (req, res) => res.json(await messenger.listMessages(req.params.id, req.user.id, req.query)),
    sendMessage: async (req, res) => res.status(201).json(await messenger.sendMessage(req.params.id, req.user.id, req.body)),
    sendMedia: async (req, res) => res.status(201).json(await messenger.sendMedia(req.params.id, req.user.id, req.file)),
    media: async (req, res) => {
      const { stream, mimeType } = await messenger.mediaStream(req.params.id, req.user.id);
      enviarArquivo(res, stream, { mimeType, fileName: req.params.id, inline: true });
    },
    markRead: async (req, res) => res.json(await messenger.markRead(req.params.id, req.user.id)),
    react: async (req, res) => res.json(await messenger.react(req.params.id, req.user.id, req.body)),
    deleteMessage: async (req, res) => res.json(await messenger.deleteMessage(req.params.id, req.user.id, req.user)),
    addMembers: async (req, res) => res.json(await messenger.addMembers(req.params.id, req.user.id, req.body)),
    leave: async (req, res) => res.json(await messenger.leave(req.params.id, req.user.id))
  },

  communities: {
    list: async (req, res) => res.json(await communities.list(req.user?.id, req.query)),
    create: async (req, res) => res.status(201).json(await communities.create(req.user.id, req.body, req.user)),
    findBySlug: async (req, res) => res.json(await communities.findBySlug(req.params.slug, req.user?.id)),
    join: async (req, res) => res.json(await communities.join(req.params.slug, req.user.id)),
    leave: async (req, res) => res.json(await communities.leave(req.params.slug, req.user.id)),
    addMember: async (req, res) => res.status(201).json(await communities.addMember(req.params.slug, req.user.id, req.body)),
    listMembers: async (req, res) => res.json(await communities.listMembers(req.params.slug, req.user?.id, req.query))
  },

  search: {
    global: async (req, res) => res.json(await searchService.search(req.query, req.user))
  },

  dashboard: {
    summary: async (req, res) => res.json(await dashboard.summary(req.user)),
    admin: async (req, res) => res.json(await dashboard.adminOverview(req.query, req.user)),
    athlete: async (req, res) => res.json(await dashboard.athleteOverview(req.user)),
    eventOperations: async (req, res) => res.json(await dashboard.eventOperations(req.params.id, req.user))
  },

  publicApi: {
    summary: async (req, res) => res.json(await publicService.summary()),
    listEvents: async (req, res) => res.json(await publicService.listEvents(req.query)),
    eventPage: async (req, res) => res.json(await publicService.eventPage(req.params.slug)),
    listAthletes: async (req, res) => res.json(await publicService.listAthletes(req.query)),
    athletePage: async (req, res) => res.json(await publicService.athletePage(req.params.id))
  },

  documents: {
    uploadAthlete: async (req, res) => res.status(201).json(await documents.uploadAthleteDocument(req.params.id, req.file, req.body, req.user)),
    listAthlete: async (req, res) => res.json({ items: await documents.listAthleteDocuments(req.params.id, req.user) }),
    downloadAthlete: async (req, res) => {
      const { stream, document } = await documents.downloadAthleteDocument(req.params.id, req.user);
      enviarArquivo(res, stream, { mimeType: document.mimeType, fileName: document.fileName });
    },
    deleteAthlete: async (req, res) => res.json(await documents.deleteAthleteDocument(req.params.id, req.user)),
    uploadEvent: async (req, res) => res.status(201).json(await documents.uploadEventDocument(req.params.id, req.file, req.body, req.user)),
    listEvent: async (req, res) => res.json({ items: await documents.listEventDocuments(req.params.id, req.user) }),
    downloadEvent: async (req, res) => {
      const { stream, document } = await documents.downloadEventDocument(req.params.id, req.user);
      enviarArquivo(res, stream, { mimeType: document.mimeType, fileName: document.fileName });
    },
    postMedia: async (req, res) => {
      const { stream, mimeType } = await documents.downloadPostMedia(req.params.id, req.user);
      enviarArquivo(res, stream, { mimeType, fileName: req.params.id, inline: true });
    },
    storyMedia: async (req, res) => {
      const { stream, mimeType } = await documents.downloadStoryMedia(req.params.id, req.user);
      enviarArquivo(res, stream, { mimeType, fileName: req.params.id, inline: true });
    }
  },

  notifications: {
    list: async (req, res) => res.json(await notifications.list(req.user.id, req.query)),
    markRead: async (req, res) => res.json(await notifications.markRead(req.params.id, req.user.id)),
    markAllRead: async (req, res) => res.json(await notifications.markAllRead(req.user.id))
  },

  audit: {
    list: async (req, res) => res.json(await auditService.list(req.query, req.user))
  },

  admin: {
    listUsers: async (req, res) => res.json(await admin.listUsers(req.query, req.user)),
    findUser: async (req, res) => res.json(await admin.findUser(req.params.id, req.user)),
    updateUser: async (req, res) => res.json(await admin.updateUser(req.params.id, req.body, req.user))
  },

  scoring: {
    list: async (req, res) => res.json({ items: await scoring.list() }),
    create: async (req, res) => res.status(201).json(await scoring.create(req.body, req.user))
  }
};

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const { optionalAuth, requireAuth, requirePermission } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');
const { singleFileUpload } = require('../middlewares/upload');
const storage = require('../services/storageService');
const s = require('../utils/schemas');
const c = require('../controllers');

const router = express.Router();
const wrap = asyncHandler;

// Autorização por permissão nomeada. O tenant vem de onde a rota o conhece;
// quando o recurso é carregado pelo id, quem confere é o service — a barreira
// de tenant está lá, junto do dado.
const perm = (permission, from = null) => requirePermission(permission, from);
const orgDoCorpo = req => req.body?.organizationId ?? null;
const orgDaQuery = req => req.query?.organizationId ?? null;

// Dois baldes: por origem e por CONTA ALVO. O segundo é o que segura força
// bruta quando o atacante troca de endereço — e o ensaio do gate final provou
// que trocar de endereço era trivial enquanto a origem vinha do cabeçalho cru.
const limiteAutenticacao = rateLimit({
  windowMs: 15 * 60_000, max: 10, nome: 'auth',
  alvo: req => String(req.body?.email || '').trim().toLowerCase() || null,
  maxPorAlvo: 20,
  // O 429 DA PORTA DE ENTRADA VAI PARA A TRILHA — achado A-10.
  //
  // Só aqui, e a escolha é sobre sinal e volume. Este é o teto que contém força
  // bruta, e a rajada que ele barra é o evento que quem investiga procura: 200
  // tentativas barradas não aparecem em `LOGIN_FAILED`, porque o limitador recusa
  // antes de o serviço rodar. Ligar a auditoria nos tetos de conteúdo, busca ou
  // mensagem produziria linha para cada pessoa que clicou rápido — ruído em
  // volume, sem sinal de segurança. Ver `registrarBloqueio` em
  // `src/middlewares/rateLimit.js` para o porquê de uma linha por janela.
  auditar: true
});
const limitePublico = rateLimit({ windowMs: 60_000, max: 180, nome: 'public' });
const limiteUpload = rateLimit({ windowMs: 60_000, max: 30, nome: 'upload' });
const limiteBusca = rateLimit({ windowMs: 60_000, max: 120, nome: 'search' });
// A importação lê e valida arquivo inteiro: é a rota mais cara da API.
const limiteImportacao = rateLimit({ windowMs: 60_000, max: 10, nome: 'import' });

// Criação de conteúdo. O teto global de 600/min não protege ninguém aqui: com
// ele, uma conta despeja centenas de comentários na publicação de outra pessoa
// em um minuto — assédio por inundação, que num sistema de federação tem nome e
// consequência. Conferido antes de existir: 120 comentários e 80 publicações
// seguidas passaram sem nenhuma contenção.
//
// Os tetos são folgados para quem está usando de verdade. Ninguém escreve 40
// comentários por minuto à mão; conversa de mensageiro é naturalmente mais
// rápida, e por isso tem teto próprio.
const limiteConteudo = rateLimit({ windowMs: 60_000, max: 40, nome: 'conteudo' });
const limiteMensagem = rateLimit({ windowMs: 60_000, max: 90, nome: 'mensagem' });

const uploadDocumento = singleFileUpload('file');
const uploadMidia = singleFileUpload('file', { maxBytes: storage.MAX_MEDIA_BYTES, tipo: 'midia' });
// Foto de perfil: imagem estática e teto próprio, menor que o da mídia social.
// Um avatar aparece dezenas de vezes por tela; não há motivo para aceitar os
// mesmos megabytes de um vídeo de publicação.
const uploadAvatar = singleFileUpload('file', { maxBytes: storage.MAX_AVATAR_BYTES, tipo: 'avatar' });
// A FOTO DO TREINADOR. Mesmo teto e mesma lista de tipos do avatar — é foto de
// perfil, com o mesmo uso. O campo do formulário é `photo`, e não `file`, porque
// o autocadastro manda foto E campos de texto na mesma requisição: um nome que
// diz o que é evita que a próxima pessoa a mexer confunda com documento.
// `arquivoObrigatorio: false` não é afrouxamento: a frase da foto obrigatória é
// decidida pelo produto e vive no serviço, num lugar só. Com a recusa no
// middleware, o cliente leria "Nenhum arquivo foi enviado" e a frase combinada
// nunca sairia. Teto de bytes, lista de tipos e conferência da assinatura dos
// bytes continuam aqui — o que passa adiante é só a AUSÊNCIA, para o serviço
// recusá-la com a mensagem certa.
const uploadFotoTreinador = singleFileUpload('photo', {
  maxBytes: storage.MAX_AVATAR_BYTES, tipo: 'avatar', arquivoObrigatorio: false
});

// ============================================================ AUTENTICAÇÃO
router.post('/auth/register', limiteAutenticacao, validate(s.cadastroCompleto), wrap(c.auth.register));
router.post('/auth/login', limiteAutenticacao, validate(s.authLogin), wrap(c.auth.login));
router.get('/auth/me', requireAuth, wrap(c.auth.me));

router.get('/profile', requireAuth, wrap(c.auth.me));
router.patch('/profile', requireAuth, validate(s.profileUpdate), wrap(c.auth.updateProfile));
router.post('/profile/password', requireAuth, limiteAutenticacao, validate(s.passwordChange), wrap(c.auth.changePassword));

// ============================================================= ORGANIZAÇÕES
router.route('/organizations')
  .get(requireAuth, wrap(c.organizations.list))
  .post(requireAuth, perm('organizations.manage'), validate(s.organizationCreate), wrap(c.organizations.create));
router.get('/organizations/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.organizations.findById));
router.post('/organizations/:id/self-registration', requireAuth, validate(s.paramsWithId, 'params'), validate(s.organizationSelfRegistration), wrap(c.organizations.setSelfRegistration));
router.post('/organizations/:id/members', requireAuth, validate(s.paramsWithId, 'params'), validate(s.organizationMemberCreate), wrap(c.organizations.addMember));
router.delete('/organizations/:id/members/:membershipId', requireAuth, wrap(c.organizations.removeMember));

// ================================================================= FILIAÇÃO
router.route('/affiliations')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.affiliations.list))
  .post(requireAuth, perm('affiliations.manage', orgDoCorpo), validate(s.affiliationCreate), wrap(c.affiliations.create));
router.post('/affiliations/:id/activate', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.affiliations.activate));
router.post('/affiliations/:id/deactivate', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.affiliations.deactivate));

// =================================================================== ATLETAS
// ---------------------------------------------------- fila de perfil de atleta
//
// `criar` NÃO exige permissão de operador: é exatamente o ponto da fila. O que
// protege aqui é a política de RLS (`userId = mci_current_user_id()`) e o
// serviço, que deriva a organização da FILIAÇÃO e não do corpo.
router.post('/athlete-requests', requireAuth, validate(s.athleteRequestCreate), wrap(c.athleteRequests.criar));
router.get('/athlete-requests/me', requireAuth, wrap(c.athleteRequests.meus));

// ===================================================== MINHA FILIAÇÃO / MEU HISTÓRICO
//
// Sem id no caminho, de propósito: o atleta vem do token. Uma rota que não
// aceita identificador de pessoa não tem IDOR a defender — não existe
// parâmetro capaz de apontar para outra pessoa. Ver src/services/meService.js.
router.get('/me/affiliation', requireAuth, wrap(c.me.affiliation));
router.get('/me/history', requireAuth, validate(s.meuHistoricoQuery, 'query'), wrap(c.me.history));
// MEU CADASTRO — sem id no caminho, pela mesma razão das duas acima: uma rota
// sem parâmetro de identidade não tem IDOR a defender. A ESCRITA continua sendo
// `PATCH /athletes/:id`, que já recusa do dono os campos restritos — não se
// abre porta de escrita nova para ganhar uma tela.
router.get('/me/cadastro', requireAuth, wrap(c.me.cadastro));

// A MENSAGEM DE ABERTURA, do lado de quem a recebe. Não tem `perm()`: o
// escopo é o CADASTRO DE ATLETA do próprio usuário, que o serviço resolve —
// não existe parâmetro por onde pedir os recados de outra pessoa.
router.get('/me/notices', requireAuth, wrap(c.me.notices));
router.post('/me/notices/:id/read', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.me.readNotice));

// E do lado de quem a escreve. `athletes.manage` porque o destinatário é a
// base de atletas da federação, e publicar um recado para todos eles é ato de
// quem responde por ela.
router.route('/athlete-notices')
  .get(requireAuth, validate(s.athleteNoticeQuery, 'query'), wrap(c.athleteNotices.list))
  .post(requireAuth, perm('athletes.manage', orgDoCorpo), validate(s.athleteNoticeCreate), wrap(c.athleteNotices.create));
router.patch('/athlete-notices/:id', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteNoticeUpdate), wrap(c.athleteNotices.update));
router.delete('/athlete-notices/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athleteNotices.remove));
router.post('/athlete-requests/:id/cancel', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athleteRequests.cancelar));
// A foto sobe PELO SERVIDOR (multipart), como todo upload daqui: nenhuma
// credencial de armazenamento chega ao navegador. `uploadAvatar` já aplica o
// teto de bytes e a lista de tipos de avatar; o serviço confere a assinatura
// dos bytes e só então grava.
router.route('/athlete-requests/:id/photo')
  .post(requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadAvatar, wrap(c.athleteRequests.definirFoto))
  .delete(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athleteRequests.removerFoto));

// Da análise em diante é operador. A organização conferida é a DO PEDIDO,
// lida do banco pelo serviço — nunca a que vier na requisição.
router.get('/athlete-requests', requireAuth, validate(s.athleteRequestQuery, 'query'), wrap(c.athleteRequests.listar));
router.get('/athlete-requests/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athleteRequests.analisar));
router.post('/athlete-requests/:id/approve', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athleteRequests.aprovar));
router.post('/athlete-requests/:id/reject', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteRequestReject), wrap(c.athleteRequests.rejeitar));

router.route('/athletes')
  .get(requireAuth, validate(s.athleteQuery, 'query'), wrap(c.athletes.list))
  .post(requireAuth, perm('athletes.create', orgDoCorpo), validate(s.athleteCreate), wrap(c.athletes.create));
router.post('/athletes/lookup', requireAuth, perm('athletes.read_sensitive', orgDoCorpo), validate(s.athleteLookup), wrap(c.athletes.lookup));
router.get('/athletes/pro', requireAuth, perm('pro.read'), validate(s.athleteQuery, 'query'), wrap(c.athletes.listPro));
router.route('/athletes/:id')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athletes.findById))
  .patch(requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteUpdate), wrap(c.athletes.update));
router.post('/athletes/:id/pro-status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.proStatusUpdate), wrap(c.athletes.setProStatus));

// O ESTADO DO ATLETA. Suspender e arquivar EXIGEM motivo; reativar aceita um.
// Nada aqui toca histórico esportivo: pontuação, resultado, inscrição e título
// continuam inteiros nos três estados.
router.post('/athletes/:id/suspend', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteStatusReason), wrap(c.athletes.suspend));
router.post('/athletes/:id/archive', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteStatusReason), wrap(c.athletes.archive));
router.post('/athletes/:id/reactivate', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteStatusOptionalReason), wrap(c.athletes.reactivate));

// REVELAR O CPF é POST, e não GET, por duas razões que não são de estilo: o
// ato é auditável (grava `ATHLETE_CPF_VIEW`), e GET convida cache, prefetch e
// registro em log intermediário para uma resposta que carrega documento. O id
// do atleta vai no caminho; o número volta no corpo — nunca em URL nem em
// parâmetro de consulta. A permissão é conferida no serviço, contra a
// organização DO ATLETA, e não contra nada que o cliente tenha mandado.
router.post('/athletes/:id/cpf', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athletes.revealCpf));

// O HISTÓRICO IMPORTADO, DO LADO DO ATLETA.
//
// A leitura mostra o que já é dele e o que PODE ser — com os resultados de
// cada candidata, para que o operador confirme uma carreira, e não um nome.
// Nenhuma sugestão vincula nada: o vínculo é o POST abaixo, com permissão
// própria (`musclewar.review`) e auditoria.
router.get('/athletes/:id/imported-history', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.muscleWar.historicoDoAtleta));
router.post('/athletes/:id/imported-history/:externalAthleteId/link', requireAuth,
  validate(s.paramsComIdentidadeExterna, 'params'), wrap(c.muscleWar.adotarIdentidade));

// A EXCLUSÃO FÍSICA SÓ PASSA SEM HISTÓRICO ESPORTIVO. O serviço confere
// lançamento, ranking, projeção, resultado, inscrição, resultado importado e
// título — havendo qualquer um, responde 409 e aponta o arquivamento.
router.delete('/athletes/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athletes.remove));

router.route('/athletes/:id/documents')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.listAthlete))
  .post(requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadDocumento, validate(s.documentUpload), wrap(c.documents.uploadAthlete));
router.get('/documents/athlete/:id/download', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.downloadAthlete));
router.delete('/documents/athlete/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.deleteAthlete));

// ==================================================== CATÁLOGO DE CATEGORIAS
router.route('/categories')
  .get(optionalAuth, wrap(c.events.listCategories))
  .post(requireAuth, perm('categories.manage'), validate(s.categoryCreate), wrap(c.events.createCategory));

// =================================================================== EVENTOS
router.route('/events')
  .get(optionalAuth, validate(s.eventQuery, 'query'), wrap(c.events.list))
  .post(requireAuth, perm('events.create', orgDoCorpo), validate(s.eventCreate), wrap(c.events.create));
router.route('/events/:id')
  .get(optionalAuth, wrap(c.events.findOne))
  .patch(requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventUpdate), wrap(c.events.update))
  .delete(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.events.remove));
router.post('/events/:id/transition', requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventTransition), wrap(c.events.transition));
router.post('/events/:id/categories', requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventCategoryCreate), wrap(c.events.addCategory));
router.post('/event-categories/:eventCategoryId/divisions', requireAuth, validate(s.divisionCreate), wrap(c.events.addDivision));
router.post('/divisions/:divisionId/classes', requireAuth, validate(s.classCreate), wrap(c.events.addClass));

router.route('/events/:id/documents')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.listEvent))
  .post(requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadDocumento, validate(s.eventDocumentUpload), wrap(c.documents.uploadEvent));
router.get('/documents/event/:id/download', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.downloadEvent));

// ================================================================ INSCRIÇÕES
router.route('/events/:id/registrations')
  .get(requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationQuery, 'query'), wrap(c.registrations.listByEvent))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationCreate), wrap(c.registrations.create));
router.get('/registrations/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.registrations.findById));
router.post('/registrations/:id/cancel', requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationCancel), wrap(c.registrations.cancel));

// ============================================================ OPERAÇÃO DE PISO
router.get('/events/:id/checkins', requireAuth, validate(s.paramsWithId, 'params'), validate(s.checkInQuery, 'query'), wrap(c.operations.listCheckIns));
router.post('/registrations/:id/checkin', requireAuth, validate(s.paramsWithId, 'params'), validate(s.checkInCreate), wrap(c.operations.checkIn));
router.post('/registrations/:id/checkin/cancel', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.cancelCheckIn));

router.route('/registrations/:id/weighins')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listWeighIns))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.weighInCreate), wrap(c.operations.weighIn));

router.route('/events/:id/credentials')
  .get(requireAuth, validate(s.paramsWithId, 'params'), validate(s.paginacao, 'query'), wrap(c.operations.listCredentials))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.credentialCreate), wrap(c.operations.issueCredential));
router.post('/events/:id/credentials/scan', requireAuth, validate(s.paramsWithId, 'params'), validate(s.credentialScan), wrap(c.operations.scanCredential));
router.post('/credentials/:id/revoke', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.revokeCredential));

router.route('/events/:id/batches')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listBatches))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.batchCreate), wrap(c.operations.createBatch));
router.route('/batches/:id/order')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listStageOrder))
  .put(requireAuth, validate(s.paramsWithId, 'params'), validate(s.stageOrderSet), wrap(c.operations.setStageOrder));
router.post('/batches/:id/status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.batchStatusUpdate), wrap(c.operations.updateBatchStatus));

// ================================================================ JULGAMENTO
// ================================================================ RESULTADOS
router.get('/events/:id/results', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.results.listByEvent));
router.get('/classes/:id/result', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.results.findByClass));
// O MCI NÃO julga: esta porta RECEBE o resultado oficial decidido fora, com
// atleta e colocação. Não há apuração, ficha de juiz nem recálculo.
router.post('/classes/:id/result', requireAuth, perm('results.receive'), validate(s.paramsWithId, 'params'), validate(s.resultReceive), wrap(c.results.receive));
router.post('/classes/:id/result/publish', requireAuth, validate(s.paramsWithId, 'params'), validate(s.resultPublish), wrap(c.results.publish));
router.post('/classes/:id/result/override', requireAuth, validate(s.paramsWithId, 'params'), validate(s.resultOverride), wrap(c.results.override));
router.get('/classes/:id/result/versions', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.results.versions));

// ===================================================== RANKING E TEMPORADAS
router.get('/ranking', optionalAuth, validate(s.rankingQuery, 'query'), wrap(c.ranking.list));
// Classes disponíveis para recortar o ranking, por categoria. Dinâmica de
// propósito: a lista de classes é DADO da organização, e nenhuma tela pode
// trazê-la escrita no código.
router.get('/ranking/classes', optionalAuth, validate(s.classesParaFiltroQuery, 'query'), wrap(c.ranking.classesParaFiltro));
router.route('/seasons')
  .get(optionalAuth, validate(s.scopedListQuery, 'query'), wrap(c.ranking.listSeasons))
  .post(requireAuth, perm('ranking.manage', orgDoCorpo), validate(s.seasonCreate), wrap(c.ranking.createSeason));
router.put('/seasons/:id/points-rules', requireAuth, validate(s.paramsWithId, 'params'), validate(s.pointsRuleSet), wrap(c.ranking.setPointsRules));
router.post('/seasons/:id/recompute', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.recompute));
// Ranking classificatório do Super Overall anual: mesmo motor, considerando
// apenas os pontos das classes marcadas como elegíveis (pela regra, a OPEN).
router.get('/ranking/super-overall', optionalAuth, validate(s.superOverallQuery, 'query'), wrap(c.ranking.superOverall));

// Catálogo de classes. O operador cria, edita e desativa classes e marca quais
// alimentam o Super Overall — sem alteração no motor de pontuação.
router.route('/classes-catalog')
  .get(requireAuth, validate(s.classCatalogQuery, 'query'), wrap(c.ranking.listClasses))
  .post(requireAuth, perm('ranking.manage', orgDoCorpo), validate(s.classCatalogUpsert), wrap(c.ranking.upsertClass));

// Ranking de equipes: mesma tabela de pontos e mesmo desempate do atleta.
// Recortes do ranking do campeonato: por classe, por evento ou por divisão.
// Mesmo motor do ranking principal — derivado de RankingPoint, sem regra nova.
router.get('/ranking/by', optionalAuth, validate(s.rankingCutQuery, 'query'), wrap(c.ranking.by));

router.get('/ranking/teams', optionalAuth, validate(s.teamRankingQuery, 'query'), wrap(c.ranking.teams));

// Ranking de empresas: os pontos das equipes que ela inscreveu, pela mesma
// tabela e o mesmo desempate.
router.get('/ranking/companies', optionalAuth, validate(s.teamRankingQuery, 'query'), wrap(c.ranking.companies));

// Título Overall. É declarado pela organização, não calculado: o critério de
// determinação do campeão não foi homologado (ver docs/HOMOLOGACAO-ESPORTIVA.md).
router.route('/events/:id/overall')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.listOverall))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.overallDeclare), wrap(c.ranking.declareOverall));

// Homologação administrativa do Overall: os candidatos da classe absoluta, a
// prévia do impacto e a revogação. Todas exigem `ranking.manage` NA
// ORGANIZAÇÃO DO EVENTO — verificado no serviço, a partir do evento do
// caminho, e nunca de um id enviado pelo cliente.
router.get('/events/:id/overall/candidates', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.overallCandidates));
router.get('/events/:id/overall/preview', requireAuth, validate(s.paramsWithId, 'params'), validate(s.overallPreviewQuery, 'query'), wrap(c.ranking.overallPreview));
// CORREÇÃO ADMINISTRATIVA DE LANÇAMENTO PUBLICADO.
//
// A listagem é por campeonato, e o serviço autoriza pela organização DO
// EVENTO, que o id do caminho revela.
router.get('/events/:id/ranking-points', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.eventRankingPoints));

// Já as quatro portas abaixo autorizam por LANÇAMENTO, e não por rota: o id do
// ponto não revela organização nenhuma, então o serviço carrega o ponto,
// descobre a organização pela temporada e chama `assertCan(ranking.manage)`
// com ELA. Um `perm()` aqui na rota não teria o que conferir, e seria uma
// promessa vazia.
router.get('/ranking/points/:pointId/preview', requireAuth, validate(s.paramsComPonto, 'params'), validate(s.rankingPointPreviewQuery, 'query'), wrap(c.ranking.previewRankingPoint));
router.patch('/ranking/points/:pointId', requireAuth, validate(s.paramsComPonto, 'params'), validate(s.rankingPointEdit), wrap(c.ranking.editRankingPoint));
// AJUSTE ADMINISTRATIVO DA PONTUAÇÃO. Rota própria, e não mais um campo do
// PATCH acima: corrigir colocação e ajustar ponto são decisões diferentes,
// com justificativas diferentes, e a auditoria precisa saber qual foi qual.
// A autorização é do serviço — `carregarLancamento` exige `ranking.manage`
// NA ORGANIZAÇÃO DA TEMPORADA, que é a única que o cliente não escolhe.
router.post('/ranking/points/:pointId/adjust', requireAuth, validate(s.paramsComPonto, 'params'), validate(s.rankingPointAdjust), wrap(c.ranking.adjustRankingPoint));
router.get('/ranking/points/:pointId/adjustments', requireAuth, validate(s.paramsComPonto, 'params'), wrap(c.ranking.listAdjustments));
router.post('/ranking/points/:pointId/void', requireAuth, validate(s.paramsComPonto, 'params'), validate(s.rankingPointReason), wrap(c.ranking.voidRankingPoint));
router.post('/ranking/points/:pointId/restore', requireAuth, validate(s.paramsComPonto, 'params'), validate(s.rankingPointReason), wrap(c.ranking.restoreRankingPoint));

router.delete('/events/:id/overall/:titleId', requireAuth, validate(s.paramsComTitulo, 'params'), validate(s.overallRevoke), wrap(c.ranking.revokeOverall));

router.get('/athletes/:id/ranking-points', requireAuth, validate(s.paramsWithId, 'params'), validate(s.rankingPointsQuery, 'query'), wrap(c.ranking.athletePoints));

// ================================================================= MUSCLEWAR
// PRAZO DILATADO, E SÓ AQUI.
//
// Criar e aplicar uma importação são as únicas operações do MCI que recebem a
// planilha de uma temporada inteira numa requisição. O prazo padrão da
// transação (5s) é generoso para todo o resto e curto para estas duas — medido
// na FASE 13.6, com 1.000 linhas estourando e devolvendo 500.
//
// O número não é chute: é teto de operação, não de expectativa. O caminho
// rápido continua sendo o rápido; o prazo existe para que o arquivo grande
// TERMINE em vez de morrer pela metade.
const PRAZO_DA_IMPORTACAO = { timeout: 180_000, maxWait: 30_000 };

router.route('/musclewar/imports')
  .get(requireAuth, perm('musclewar.review', orgDaQuery), validate(s.importQuery, 'query'), wrap(c.muscleWar.list))
  .post(requireAuth, limiteImportacao, perm('musclewar.import', orgDoCorpo), validate(s.muscleWarImportCreate), wrap(c.muscleWar.create, PRAZO_DA_IMPORTACAO));
router.get('/musclewar/imports/:id', requireAuth, validate(s.paramsWithId, 'params'), validate(s.muscleWarPreviewQuery, 'query'), wrap(c.muscleWar.preview));
router.post('/musclewar/items/:itemId/link', requireAuth, validate(s.muscleWarLink), wrap(c.muscleWar.link));
router.post('/musclewar/imports/:id/apply', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.muscleWar.apply, PRAZO_DA_IMPORTACAO));
router.post('/musclewar/imports/:id/reject', requireAuth, validate(s.paramsWithId, 'params'), validate(s.rejectImport), wrap(c.muscleWar.reject));
// A autorização NÃO fica aqui em `perm(...)`: quem decide é o serviço, porque
// a permissão exigida depende do que o lote publicou — invalidar mexe no
// ledger e pede `ranking.manage` além de `musclewar.apply`. Resolver isso no
// middleware exigiria ler o lote duas vezes, e a segunda leitura é a que vale.
router.delete('/musclewar/imports/:id', requireAuth, validate(s.paramsWithId, 'params'), validate(s.deleteImport), wrap(c.muscleWar.remove));

// ================================== EQUIPES, ACADEMIAS, COACHES, MARCAS, PATROCÍNIO
// Empresas competidoras: cadastram-se e entram com suas equipes.
// Vínculo do atleta com equipe. A trava de unicidade é do banco; aqui a
// diferença é de permissão: `athletes.update` vincula um atleta SEM equipe,
// `athletes.transfer` é o que tira o atleta de outra — ato do operador da
// Muscle Contest, não do treinador.
router.post('/athletes/:id/team', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteTeamLink), wrap(c.athletes.linkTeam));
router.post('/athletes/:id/team/transfer', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteTeamTransfer), wrap(c.athletes.transferTeam));
router.post('/athletes/:id/team/unlink', requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteTeamUnlink), wrap(c.athletes.unlinkTeam));
router.get('/athletes/:id/team-history', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athletes.teamHistory));

router.route('/companies')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listCompanies))
  .post(requireAuth, perm('companies.manage', orgDoCorpo), validate(s.companyCreate), wrap(c.partners.createCompany));

router.route('/teams')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listTeams))
  .post(requireAuth, perm('teams.manage', orgDoCorpo), validate(s.teamCreate), wrap(c.partners.createTeam));
// O treinador responsável pela equipe. `teams.manage` porque é cadastro de
// equipe; a conferência de que o treinador pode responder por esta federação é
// do serviço, que precisa ler `Coach` e `CoachOrganization`.
router.post('/teams/:id/coach', requireAuth, validate(s.paramsWithId, 'params'), validate(s.teamCoachSet), wrap(c.partners.setTeamCoach));
router.route('/gyms')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listGyms))
  .post(requireAuth, perm('gyms.manage', orgDoCorpo), validate(s.gymCreate), wrap(c.partners.createGym));
router.route('/coaches')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listCoaches))
  .post(requireAuth, perm('coaches.manage'), validate(s.coachCreate), wrap(c.partners.createCoach));

// ==================================================== TREINADORES & EQUIPES
//
// ORDEM IMPORTA: os caminhos fixos (`/me`, `/review`) vêm antes dos que têm
// parâmetro, senão `me` casaria com `:id` e o treinador pediria o próprio
// cadastro achando que pediu o de alguém.
//
// ONDE A PERMISSÃO É CONFERIDA, e por quê nem toda rota tem `perm(...)`: o
// middleware roda ANTES do Zod, e o Zod roda antes do serviço. Onde a
// autorização depende do RECURSO — de quem é a equipe, de quem é o atleta, de
// qual federação é o pedido —, ela mora no serviço, junto do dado, porque a
// rota não tem como saber. Onde ela é global e não depende do recurso
// (`coaches.approve`, `central.grant`), fica aqui: a recusa vem antes de
// qualquer leitura, que é o comportamento mais barato e o mais seguro.

// ------------------------------------------------- o treinador e o que é dele
//
// O autocadastro NÃO tem `perm(...)`: qualquer conta autenticada pode se
// cadastrar como treinador. O teto de conteúdo segura a criação em massa.
//
// O cadastro nasce **APPROVED**, com `reviewedAt` e `autoApprovedAt` gravados e
// `reviewedById` nulo — ver `coachService.autocadastro`. Esta linha já disse
// "nasce PENDING por R-03", e era verdade até a decisão de aprovação automática;
// ficou para trás e passou a afirmar o contrário do código. Quem ler a rota tira
// a conclusão errada sobre o que o treinador vê ao terminar o cadastro, então o
// texto é corrigido aqui em vez de remendado.
//
// O que a aprovação automática NÃO concede continua valendo: atuar numa federação
// exige `CoachOrganization`, e é a autorização automática na NPC que a cria — não
// o status do cadastro.
// O AUTOCADASTRO PASSOU A SER MULTIPART, e é por isso que a foto não tem como
// ser contornada: ela vem na MESMA requisição que cria o cadastro, e o serviço
// recusa antes de qualquer escrita quando ela falta. Não existe janela entre
// "cadastro criado" e "foto enviada" — logo não existe cadastro novo sem foto.
//
// A ORDEM DOS MIDDLEWARES IMPORTA: o upload vem ANTES do `validate`, porque é o
// multer que preenche `req.body` a partir do corpo multipart. Invertido, o schema
// leria um corpo vazio e recusaria todo cadastro por campo obrigatório ausente.
router.post('/coaches/self-register', requireAuth, limiteConteudo, limiteUpload, uploadFotoTreinador, validate(s.coachSelfRegister), wrap(c.coaches.autocadastro));
// A TROCA DA FOTO, depois. Existe separada porque atualizar foto não é refazer
// cadastro: ela escreve UMA coluna e não toca em vínculo, ponto nem histórico.
router.post('/coaches/me/photo', requireAuth, limiteUpload, uploadFotoTreinador, wrap(c.coaches.trocarMinhaFoto));
router.route('/coaches/me')
  .get(requireAuth, wrap(c.coaches.meuCadastro))
  .patch(requireAuth, validate(s.coachSelfUpdate), wrap(c.coaches.atualizarMeuCadastro));
// AS EQUIPES DO TREINADOR — ler, criar e corrigir as DELE.
//
// `POST` e `PATCH` entraram com a autorização automática na NPC. Eles NÃO são
// `POST /teams`: aquele é o cadastro de equipe da federação, exige
// `teams.manage` na organização e aceita escolher o treinador responsável. Estes
// exigem `teams.create_own`, gravam o cadastro de treinador de QUEM PEDE e
// alcançam só a equipe dele — a conferência de que ele pode atuar naquela
// federação é do serviço, que precisa ler `Coach` e `CoachOrganization`.
router.get('/coaches/me/teams', requireAuth, wrap(c.coaches.minhasEquipes));
router.post('/coaches/me/teams', requireAuth, perm('teams.create_own'), validate(s.coachTeamCreate), wrap(c.coaches.criarMinhaEquipe));
router.patch('/coaches/me/teams/:id', requireAuth, perm('teams.create_own'), validate(s.paramsWithId, 'params'), validate(s.coachTeamUpdate), wrap(c.coaches.atualizarMinhaEquipe));
router.get('/coaches/me/athletes', requireAuth, validate(s.coachTeamQuery, 'query'), wrap(c.coaches.meusAtletas));

// ------------------------------------------- a mesa de análise central (R-03)
router.get('/coaches/review', requireAuth, perm('coaches.approve'), validate(s.coachReviewQuery, 'query'), wrap(c.coaches.listarParaAnalise));

// A LISTA DA FEDERAÇÃO (R-04) — a contrapartida de leitura da rota de
// autorização abaixo. O escopo vem da QUERY e é obrigatório no schema: sem
// `organizationId`, `perm` avaliaria a permissão sem federação nomeada, e
// `effectivePermissions` somaria as permissões de todas as federações do ator.
// A lista devolve só cadastro APROVADO — quem ainda está em análise é assunto
// da mesa central, e não aparece aqui.
router.get('/coaches/authorizable', requireAuth, perm('coaches.authorize_org', orgDaQuery), validate(s.coachAuthorizableQuery, 'query'), wrap(c.coaches.listarParaAutorizacao));
router.get('/coaches/:id/review', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), wrap(c.coaches.carregarParaAnalise));
router.post('/coaches/:id/approve', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), validate(s.coachDecision), wrap(c.coaches.aprovar));
router.post('/coaches/:id/reject', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), validate(s.coachDecisionWithReason), wrap(c.coaches.rejeitar));
router.post('/coaches/:id/suspend', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), validate(s.coachDecisionWithReason), wrap(c.coaches.suspender));
router.post('/coaches/:id/reactivate', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), validate(s.coachDecision), wrap(c.coaches.reativar));
router.post('/coaches/:id/cancel', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), validate(s.coachDecisionWithReason), wrap(c.coaches.cancelar));

// -------------------------------------- a autorização por federação (R-04)
//
// `perm('coaches.authorize_org', orgDoCorpo)`: a organização vem do CORPO, e o
// middleware já barra quem não pertence a ela. O serviço confere de novo com
// `assertCan` — a barreira de tenant vale nos dois lugares, porque o serviço é
// chamável de fora da rota.
router.post('/coaches/:id/organizations', requireAuth, perm('coaches.authorize_org', orgDoCorpo), validate(s.paramsWithId, 'params'), validate(s.coachOrgAuthorize), wrap(c.coaches.autorizarOrganizacao));
router.post('/coaches/:id/organizations/revoke', requireAuth, perm('coaches.authorize_org', orgDoCorpo), validate(s.paramsWithId, 'params'), validate(s.coachOrgRevoke), wrap(c.coaches.revogarOrganizacao));

// ------------------------------------------- documentos da análise (R-05)
//
// Enviar é do treinador ou da mesa; LISTAR e BAIXAR são só da mesa. A assimetria
// é a decisão R-05: documento não aparece no painel do treinador, nem para quem
// o enviou.
router.post('/coaches/:id/documents', requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadDocumento, validate(s.coachDocumentUpload), wrap(c.coaches.anexarDocumento));
router.get('/coaches/:id/documents', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), wrap(c.coaches.listarDocumentos));
router.get('/documents/coach/:id/download', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), wrap(c.coaches.baixarDocumento));
router.delete('/documents/coach/:id', requireAuth, perm('coaches.approve'), validate(s.paramsWithId, 'params'), wrap(c.coaches.removerDocumento));

// ------------------------------- ranking de treinadores: SEM classificação
//
// A fórmula não está homologada. `/ranking` responde 409 com o motivo, de
// propósito: um 404 diria "não existe essa rota", e o que precisa ser dito é
// "não existe classificação homologada".
router.get('/coaches/:id/ranking/eligibility', requireAuth, validate(s.paramsWithId, 'params'), validate(s.coachEligibilityQuery, 'query'), wrap(c.coaches.elegibilidade));
router.get('/coaches/:id/ranking/projection', requireAuth, validate(s.paramsWithId, 'params'), validate(s.coachRankingQuery, 'query'), wrap(c.coaches.projecao));
// UMA rota, e não duas. A primeira versão disto tinha também
// `GET /coaches/ranking`, um apelido — e o apelido custou: a auditoria de rotas
// exige que toda rota fora da superfície pública declarada recuse requisição sem
// sessão, e um caminho novo em `/coaches/...` respondendo 409 ao visitante
// aparecia como vazamento. O namespace público do ranking é `/ranking/*`, e é
// onde esta rota pertence. Superfície menor, nenhuma exceção a declarar.
router.get('/ranking/coaches', optionalAuth, wrap(c.coaches.classificacao));
// Conferência de R-01: o `teamId` congelado confere com o vínculo da data do
// evento? Diagnóstico de homologação, não correção — por isso `ranking.manage`.
router.get('/coaches/ranking/divergences', requireAuth, perm('ranking.manage'), validate(s.coachDivergenceQuery, 'query'), wrap(c.coaches.divergencias));

// ----------------------------------------------- solicitação de vínculo
//
// A BUSCA POR MATRÍCULA é POST, e não GET, por duas razões medidas: a matrícula
// não fica em log de acesso nem em histórico de navegador, e o teto de busca
// próprio a segura — é a rota mais varrível do módulo.
router.post('/athletes/lookup-affiliation', requireAuth, limiteBusca, validate(s.athleteAffiliationLookup), wrap(c.membershipRequests.localizarAtleta));

router.route('/team-membership-requests')
  .get(requireAuth, validate(s.membershipRequestQuery, 'query'), wrap(c.membershipRequests.listarDaEquipe))
  .post(requireAuth, limiteConteudo, validate(s.membershipRequestCreate), wrap(c.membershipRequests.solicitar));
// O atleta vê os pedidos dirigidos a ele. Antes de `/:id`, pelo mesmo motivo de
// ordem de sempre.
router.get('/team-membership-requests/me', requireAuth, wrap(c.membershipRequests.meusPedidos));
// CONFIRMAR e REJEITAR são do ATLETA, e a autorização é por titularidade da
// conta — não há permissão nomeada a conferir na rota.
router.post('/team-membership-requests/:id/confirm', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.membershipRequests.confirmar));
router.post('/team-membership-requests/:id/reject', requireAuth, validate(s.paramsWithId, 'params'), validate(s.membershipRequestReason), wrap(c.membershipRequests.rejeitar));
router.post('/team-membership-requests/:id/cancel', requireAuth, validate(s.paramsWithId, 'params'), validate(s.membershipRequestReason), wrap(c.membershipRequests.cancelar));
// A aprovação por DECISÃO ADMINISTRATIVA exige `athletes.transfer`, que desde
// R-02 nenhum papel recebe por construção. A conferência é no serviço porque a
// organização vem do pedido, não do corpo.
router.post('/team-membership-requests/:id/admin-approve', requireAuth, validate(s.paramsWithId, 'params'), validate(s.membershipRequestAdminApprove), wrap(c.membershipRequests.aprovarPorDecisao));

// ------------------------------------------------ delegação central (R-02)
router.route('/central-authorizations')
  .get(requireAuth, validate(s.centralGrantQuery, 'query'), wrap(c.centralAuthorizations.listar))
  .post(requireAuth, perm('central.grant'), validate(s.centralGrantCreate), wrap(c.centralAuthorizations.conceder));
// A própria pessoa vê o que recebeu. Ver a sua delegação não depende de poder
// conceder — daí a ausência de `perm(...)` aqui.
router.get('/central-authorizations/me', requireAuth, wrap(c.centralAuthorizations.minhas));
router.post('/central-authorizations/:id/revoke', requireAuth, perm('central.grant'), validate(s.paramsWithId, 'params'), validate(s.centralGrantRevoke), wrap(c.centralAuthorizations.revogar));
router.route('/brands')
  .get(optionalAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listBrands))
  .post(requireAuth, perm('brands.manage', orgDoCorpo), validate(s.brandCreate), wrap(c.partners.createBrand));
router.route('/sponsors')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listSponsors))
  .post(requireAuth, perm('sponsors.manage', orgDoCorpo), validate(s.sponsorCreate), wrap(c.partners.createSponsor));
router.route('/sponsorships')
  .get(requireAuth, validate(s.sponsorshipQuery, 'query'), wrap(c.partners.listSponsorships))
  .post(requireAuth, validate(s.sponsorshipCreate), wrap(c.partners.createSponsorship));
router.route('/partnerships')
  .get(optionalAuth, validate(s.partnershipQuery, 'query'), wrap(c.partners.listPartnerships))
  .post(requireAuth, validate(s.partnershipCreate), wrap(c.partners.createPartnership));
router.post('/partnerships/:id/status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.partnershipStatus), wrap(c.partners.setPartnershipStatus));

// ==================================================================== SOCIAL
router.get('/social/me', requireAuth, wrap(c.social.myProfile));
router.patch('/social/me', requireAuth, validate(s.profileUpdateSocial), wrap(c.social.updateProfile));
// A rota é sempre "a minha foto": não recebe id de perfil, então não existe
// caminho para trocar a de outra pessoa. O perfil sai do token.
router.post('/social/me/avatar', requireAuth, limiteUpload, uploadAvatar, wrap(c.social.setAvatar));
router.delete('/social/me/avatar', requireAuth, wrap(c.social.removeAvatar));
router.post('/social/me/handle', requireAuth, validate(s.handleUpdate), wrap(c.social.setHandle));

router.get('/social/feed', optionalAuth, validate(s.feedQuery, 'query'), wrap(c.social.feed));
router.get('/social/saved', requireAuth, validate(s.paginacao, 'query'), wrap(c.social.listSaved));

router.route('/social/posts')
  .post(requireAuth, limiteConteudo, validate(s.postCreate), wrap(c.social.createPost));
router.route('/social/posts/:id')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.social.getPost))
  .delete(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.deletePost));
router.post('/social/posts/:id/media', requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadMidia, wrap(c.social.attachMedia));
router.post('/social/posts/:id/like', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.like));
router.delete('/social/posts/:id/like', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.unlike));
router.post('/social/posts/:id/save', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.save));
router.delete('/social/posts/:id/save', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.unsave));
router.post('/social/posts/:id/share', requireAuth, limiteConteudo, validate(s.paramsWithId, 'params'), validate(s.shareCreate), wrap(c.social.share));
router.route('/social/posts/:id/comments')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), validate(s.paginacao, 'query'), wrap(c.social.listComments))
  .post(requireAuth, limiteConteudo, validate(s.paramsWithId, 'params'), validate(s.commentCreate), wrap(c.social.comment));
router.delete('/social/comments/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.deleteComment));

router.get('/social/profiles/:handle', optionalAuth, wrap(c.social.profile));
router.post('/social/profiles/:handle/follow', requireAuth, wrap(c.social.follow));
router.delete('/social/profiles/:handle/follow', requireAuth, wrap(c.social.unfollow));
router.get('/social/profiles/:handle/followers', optionalAuth, validate(s.paginacao, 'query'), wrap(c.social.followers));
router.get('/social/profiles/:handle/following', optionalAuth, validate(s.paginacao, 'query'), wrap(c.social.following));
router.post('/social/profiles/:handle/block', requireAuth, wrap(c.social.block));
router.delete('/social/profiles/:handle/block', requireAuth, wrap(c.social.unblock));

router.route('/social/stories')
  .get(requireAuth, wrap(c.social.listStories))
  .post(requireAuth, limiteUpload, uploadMidia, validate(s.storyCaption), wrap(c.social.createStory));
router.post('/social/stories/:id/view', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.viewStory));

router.get('/media/posts/:id', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.postMedia));
router.get('/media/stories/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.storyMedia));
router.get('/media/profiles/:id/avatar', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.profileAvatar));
// As duas exigem sessão.
//
// A do PEDIDO é evidente: o serviço decide entre o dono e o operador.
//
// A do ATLETA foi deliberada. A foto chega aqui por um caminho específico —
// a pessoa a enviou para a federação CONFERIR sua identidade —, e abri-la a
// visitante anônimo seria eu decidir publicar retrato de atleta por conta
// própria. Hoje nada se perde com isso: a vitrine pública nunca exibiu foto,
// porque até agora não existia rota nenhuma que a servisse. Se a decisão de
// produto for publicá-la, troca-se por `optionalAuth` e acrescenta-se a rota
// à lista de públicas em tests/rotas.test.mjs — de propósito, não por
// descuido.
router.get('/media/athlete-requests/:id/photo', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.athleteRequestPhoto));
router.get('/media/athletes/:id/photo', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.athletePhoto));
// `optionalAuth`: a foto do treinador aparece no ranking de treinadores, que é
// superfície pública — mesma razão da foto do atleta na vitrine. O id é tudo o
// que a rota recebe; a chave do objeto é resolvida no servidor.
router.get('/media/coaches/:id/photo', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.coachPhoto));

router.post('/social/reports', requireAuth, limiteConteudo, validate(s.reportCreate), wrap(c.social.report));
router.get('/social/reports', requireAuth, perm('social.moderate'), validate(s.reportQuery, 'query'), wrap(c.social.listReports));
router.post('/social/reports/:id/resolve', requireAuth, perm('social.moderate'), validate(s.paramsWithId, 'params'), validate(s.reportResolve), wrap(c.social.resolveReport));

// ================================================================= MESSENGER
router.route('/messenger/conversations')
  .get(requireAuth, perm('messenger.use'), validate(s.paginacao, 'query'), wrap(c.messenger.listConversations))
  .post(requireAuth, perm('messenger.use'), validate(s.conversationCreate), wrap(c.messenger.createConversation));
router.get('/messenger/conversations/:id', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.getConversation));
router.route('/messenger/conversations/:id/messages')
  .get(requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.paginacao, 'query'), wrap(c.messenger.listMessages))
  .post(requireAuth, perm('messenger.use'), limiteMensagem, validate(s.paramsWithId, 'params'), validate(s.messageCreate), wrap(c.messenger.sendMessage));
router.post('/messenger/conversations/:id/media', requireAuth, perm('messenger.use'), limiteUpload, validate(s.paramsWithId, 'params'), uploadMidia, wrap(c.messenger.sendMedia));
router.post('/messenger/conversations/:id/read', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.markRead));
router.post('/messenger/conversations/:id/members', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.conversationMembers), wrap(c.messenger.addMembers));
router.post('/messenger/conversations/:id/leave', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.leave));
router.post('/messenger/messages/:id/reactions', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.reactionCreate), wrap(c.messenger.react));
router.delete('/messenger/messages/:id', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.deleteMessage));
router.get('/messenger/messages/:id/media', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.media));

// =============================================================== COMUNIDADES
router.route('/communities')
  .get(optionalAuth, validate(s.paginacao, 'query'), wrap(c.communities.list))
  .post(requireAuth, perm('communities.manage'), validate(s.communityCreate), wrap(c.communities.create));
router.get('/communities/:slug', optionalAuth, wrap(c.communities.findBySlug));
router.post('/communities/:slug/join', requireAuth, wrap(c.communities.join));
router.post('/communities/:slug/leave', requireAuth, wrap(c.communities.leave));
router.post('/communities/:slug/members', requireAuth, validate(s.communityMemberAdd), wrap(c.communities.addMember));
router.get('/communities/:slug/members', optionalAuth, validate(s.paginacao, 'query'), wrap(c.communities.listMembers));

// ===================================================================== BUSCA
router.get('/search', optionalAuth, limiteBusca, validate(s.searchQuery, 'query'), wrap(c.search.global));

// ================================================================== PAINÉIS
router.get('/dashboard/summary', requireAuth, wrap(c.dashboard.summary));
router.get('/dashboard/admin', requireAuth, perm('analytics.read', orgDaQuery), wrap(c.dashboard.admin));
router.get('/dashboard/athlete', requireAuth, wrap(c.dashboard.athlete));
router.get('/events/:id/operations', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.dashboard.eventOperations));

// ============================================================ NOTIFICAÇÕES
router.get('/notifications', requireAuth, validate(s.notificationQuery, 'query'), wrap(c.notifications.list));
router.post('/notifications/:id/read', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.notifications.markRead));
router.post('/notifications/read-all', requireAuth, wrap(c.notifications.markAllRead));

// ================================================================= AUDITORIA
router.get('/audit', requireAuth, perm('audit.read', orgDaQuery), validate(s.auditQuery, 'query'), wrap(c.audit.list));
// Integridade da trilha: quantas gravações falharam nesta instância e qual foi a
// última. Mesma permissão da leitura da trilha — quem audita precisa saber se a
// auditoria está funcionando. Sem parâmetro, sem escrita, sem dado sensível.
router.get('/audit/integrity', requireAuth, perm('audit.read'), wrap(c.audit.integrity));

// ================================================================== USUÁRIOS
router.get('/admin/users', requireAuth, perm('users.read'), validate(s.adminUserQuery, 'query'), wrap(c.admin.listUsers));
router.get('/admin/users/:id', requireAuth, perm('users.read'), validate(s.paramsWithId, 'params'), wrap(c.admin.findUser));
router.patch('/admin/users/:id', requireAuth, perm('users.manage'), validate(s.paramsWithId, 'params'), validate(s.adminUserUpdate), wrap(c.admin.updateUser));

// =================================================================== VITRINE
router.get('/public/summary', limitePublico, wrap(c.publicApi.summary));
router.get('/public/events', limitePublico, validate(s.buscaPublica, 'query'), wrap(c.publicApi.listEvents));
router.get('/public/events/:slug', limitePublico, wrap(c.publicApi.eventPage));
// Descoberta de filiações para quem ainda não tem vínculo com organização
// nenhuma. Devolve só o necessário para escolher numa lista, e apenas de
// federações que decidiram receber pedido espontâneo.
router.get('/public/affiliations', limitePublico, validate(s.buscaPublica, 'query'), wrap(c.publicApi.listAffiliations));
router.get('/public/athletes', limitePublico, validate(s.buscaPublica, 'query'), wrap(c.publicApi.listAthletes));
router.get('/public/athletes/:id', limitePublico, validate(s.paramsWithId, 'params'), wrap(c.publicApi.athletePage));

module.exports = router;

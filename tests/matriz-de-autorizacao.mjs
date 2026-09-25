// ============================================================================
// A MATRIZ DE AUTORIZAÇÃO — uma linha por rota mutante autenticada.
//
// POR QUE ESTE ARQUIVO EXISTE, E POR QUE ELE É UMA LISTA E NÃO UMA HEURÍSTICA
//
// A autorização desta API não mora no middleware. Das rotas mutantes
// autenticadas, a grande maioria chega ao serviço com apenas `requireAuth`, e
// quem recusa é o `assertCan` lá dentro — contra a organização DO RECURSO, lida
// do banco. Isso é o desenho certo: um middleware não sabe, pela URL, de quem é
// o evento cujo id está no caminho.
//
// O custo desse desenho é que não existe nada estrutural provando que TODA rota
// faz a chamada. Uma função que esqueça o `assertCan` responde 200, e a suíte
// que varre a superfície inteira só exige que nenhuma rota responda 5xx — ou
// seja, o esquecimento passa.
//
// Este arquivo é a lista que fecha esse buraco. Cada rota mutante tem uma
// EXPECTATIVA DECLARADA. O teste confere que a lista e a superfície registrada
// no Express são o MESMO conjunto: rota nova sem linha aqui quebra o build, e
// linha aqui sem rota também.
//
// POR QUE O CORPO DA REQUISIÇÃO IMPORTA
//
// A ordem dos middlewares é `requireAuth` → (`perm`) → `validate` → controller.
// Para as rotas em que a autorização está no serviço, `validate` roda ANTES
// dela. Um corpo inválido responde 400 — e um teste que aceitasse 400 como
// "recusou" não estaria medindo autorização nenhuma: estaria medindo o Zod.
//
// Por isso cada linha carrega um corpo que PASSA pela validação, e o teste
// trata 400 como FALHA, nunca como aprovação. Se um schema mudar, o gate
// reprova aqui e não em silêncio.
//
// OS TRÊS TIPOS DE EXPECTATIVA
//
// PERMISSAO     — operação administrativa/operacional. Um ator autenticado,
//                 membro da organização, mas SEM a permissão, tem de receber
//                 403. É a maioria.
//
// AUTOSSERVICO  — a rota existe para o próprio ator operar sobre os dados dele.
//                 Exigir permissão administrativa aqui seria quebrar a função.
//                 A prova não é 403 para qualquer um: é 401 sem sessão MAIS o
//                 LIMITE DE DONO — o ator não alcança o recurso de outro.
//
// SOCIAL        — mesma natureza do autosserviço, no módulo social/mensageria,
//                 onde o limite é dono ou participante e a barreira é a RLS.
//
// Cada linha de AUTOSSERVICO e SOCIAL traz `motivo`: por que não é bypass.
// Não existe "ignorar esta rota".
// ============================================================================

export const PERMISSAO = 'PERMISSAO';
export const AUTOSSERVICO = 'AUTOSSERVICO';
export const SOCIAL = 'SOCIAL';

/** PNG de 1×1, o menor arquivo de imagem válido — para as rotas de upload. */
export const PNG_MINIMO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g2pFAAAAAElFTkSuQmCC',
  'base64'
);

/**
 * A matriz. `f` é a fixture: ids reais, criados pelo ator AUTORIZADO — o que
 * faz da própria construção da fixture a prova positiva de que quem tem
 * permissão consegue operar.
 */
export function matriz(f) {
  const permissao = (m, p, url, corpo, perm, extra = {}) =>
    ({ m, p, url, corpo, tipo: PERMISSAO, permissao: perm, ...extra });
  const auto = (m, p, url, corpo, motivo, extra = {}) =>
    ({ m, p, url, corpo, tipo: AUTOSSERVICO, motivo, ...extra });
  const social = (m, p, url, corpo, motivo, extra = {}) =>
    ({ m, p, url, corpo, tipo: SOCIAL, motivo, ...extra });

  return [
    // ---------------------------------------------------- plataforma e conta
    permissao('PATCH', '/admin/users/:id', `/admin/users/${f.atletaB.id}`,
      { status: 'SUSPENDED' }, 'users.manage'),
    permissao('POST', '/organizations', '/organizations',
      { name: 'Federação Nova QA', slug: `fed-nova-${f.sufixo}` }, 'organizations.manage'),
    permissao('POST', '/organizations/:id/members', `/organizations/${f.orgA}/members`,
      { userId: f.atletaB.id, role: 'STAFF' }, 'organizations.manage'),
    permissao('DELETE', '/organizations/:id/members/:membershipId',
      `/organizations/${f.orgA}/members/${f.membershipDoAtletaA}`, null, 'organizations.manage'),
    permissao('POST', '/organizations/:id/self-registration', `/organizations/${f.orgA}/self-registration`,
      { open: true }, 'organizations.manage'),

    auto('PATCH', '/profile', '/profile', { name: 'Nome Trocado QA' },
      'Cada conta edita o próprio nome e e-mail. O serviço opera sobre `actor.id` e não aceita id de terceiro: não existe caminho para editar outra conta por aqui.'),
    auto('POST', '/profile/password', '/profile/password',
      { currentPassword: 'senha-de-teste-123', newPassword: 'senha-de-teste-456' },
      'Troca de senha exige a senha ATUAL e opera sobre `actor.id`. Sem a senha atual a troca é recusada, e não há parâmetro que aponte para outra conta.'),

    // ------------------------------------------------------------- filiações
    permissao('POST', '/affiliations', '/affiliations',
      { organizationId: f.orgA, name: 'Entidade QA', code: `QA${f.codigo}`, kind: 'ENTITY' }, 'affiliations.manage'),
    permissao('POST', '/affiliations/:id/activate', `/affiliations/${f.affiliationA}/activate`, null, 'affiliations.manage'),
    permissao('POST', '/affiliations/:id/deactivate', `/affiliations/${f.affiliationA}/deactivate`, null, 'affiliations.manage'),

    // -------------------------------------------- mensagem de abertura ao atleta
    permissao('POST', '/athlete-notices', '/athlete-notices',
      { organizationId: f.orgA, title: 'Aviso QA', body: 'Corpo do aviso de QA.' }, 'athletes.manage'),
    permissao('PATCH', '/athlete-notices/:id', `/athlete-notices/${f.noticeA}`,
      { title: 'Aviso QA editado' }, 'athletes.manage'),
    permissao('DELETE', '/athlete-notices/:id', `/athlete-notices/${f.noticeA}`, null, 'athletes.manage'),
    auto('POST', '/me/notices/:id/read', `/me/notices/${f.noticeA}/read`, null,
      'Marcar um aviso como lido é ato do leitor sobre a própria leitura: a linha gravada é (aviso, ator). Não há como marcar a leitura de outra pessoa.'),

    // ------------------------------------------------------- fila de autocadastro
    auto('POST', '/athlete-requests', '/athlete-requests',
      { fullName: 'Pessoa QA Matriz', cpf: f.cpfLivre, sex: 'MALE', affiliationId: f.affiliationA, affiliationNumber: f.matriculaLivre },
      'É a porta do autocadastro: qualquer pessoa autenticada abre o SEU pedido. O pedido nasce com `userId` do ator; exigir permissão administrativa aqui fecharia o cadastro de atleta.'),
    auto('POST', '/athlete-requests/:id/cancel', `/athlete-requests/${f.pedidoDoAtletaA}/cancel`, null,
      'Só o solicitante cancela o próprio pedido — e o teste de limite prova que outro ator autenticado não cancela o pedido alheio.',
      { alheio: () => `/athlete-requests/${f.pedidoDoAtletaB}/cancel` }),
    auto('POST', '/athlete-requests/:id/photo', `/athlete-requests/${f.pedidoDoAtletaA}/photo`, null,
      'A foto é do próprio pedido, enviada pelo solicitante antes da análise.',
      { arquivo: 'file', alheio: () => `/athlete-requests/${f.pedidoDoAtletaB}/photo` }),
    auto('DELETE', '/athlete-requests/:id/photo', `/athlete-requests/${f.pedidoDoAtletaA}/photo`, null,
      'Mesma razão do envio: o solicitante corrige a própria foto.',
      { alheio: () => `/athlete-requests/${f.pedidoDoAtletaB}/photo` }),
    permissao('POST', '/athlete-requests/:id/approve', `/athlete-requests/${f.pedidoDoAtletaA}/approve`, null, 'athletes.manage'),
    permissao('POST', '/athlete-requests/:id/reject', `/athlete-requests/${f.pedidoDoAtletaA}/reject`,
      { reason: 'Documento ilegível (QA).' }, 'athletes.manage'),

    // ----------------------------------------------------------------- atletas
    permissao('POST', '/athletes', '/athletes',
      { organizationId: f.orgA, fullName: 'Atleta QA Matriz', cpf: f.cpfLivre2, sex: 'FEMALE' }, 'athletes.create'),
    permissao('POST', '/athletes/lookup', '/athletes/lookup',
      { organizationId: f.orgA, cpf: f.cpfDoAtletaA }, 'athletes.read_sensitive'),
    permissao('PATCH', '/athletes/:id', `/athletes/${f.athleteA}`, { city: 'Cuiabá' }, 'athletes.update'),
    permissao('DELETE', '/athletes/:id', `/athletes/${f.athleteA}`, null, 'athletes.manage'),
    permissao('POST', '/athletes/:id/pro-status', `/athletes/${f.athleteA}/pro-status`,
      { status: 'ACTIVE', reason: 'Promoção de QA.' }, 'pro.manage'),
    permissao('POST', '/athletes/:id/suspend', `/athletes/${f.athleteA}/suspend`,
      { reason: 'Suspensão de QA.' }, 'athletes.manage'),
    permissao('POST', '/athletes/:id/archive', `/athletes/${f.athleteA}/archive`,
      { reason: 'Arquivamento de QA.' }, 'athletes.manage'),
    permissao('POST', '/athletes/:id/reactivate', `/athletes/${f.athleteA}/reactivate`, {}, 'athletes.manage'),
    permissao('POST', '/athletes/:id/cpf', `/athletes/${f.athleteA}/cpf`, null, 'athletes.read_sensitive'),
    permissao('POST', '/athletes/:id/documents', `/athletes/${f.athleteA}/documents`,
      null, 'documents.upload', { arquivo: 'file' }),
    permissao('DELETE', '/documents/athlete/:id', `/documents/athlete/${f.documentoDoAtletaA}`, null, 'documents.delete',
      { recusasExtras: [404], porQue: 'A política `documento_do_atleta` é `a."userId" = ator OR mci_operator_of(a."organizationId")` (medida). Um atleta da federação que não é o dono do documento NÃO é operador, então a linha não existe para ele e 404 é recusa por não divulgação. A fixture prova que o documento existe.' }),
    permissao('POST', '/athletes/:id/imported-history/:externalAthleteId/link',
      `/athletes/${f.athleteA}/imported-history/${f.externalAthleteA}/link`, null, 'musclewar.apply'),
    permissao('POST', '/athletes/:id/team', `/athletes/${f.athleteSemEquipe}/team`,
      { teamId: f.teamA }, 'athletes.update'),
    permissao('POST', '/athletes/:id/team/transfer', `/athletes/${f.athleteA}/team/transfer`,
      { teamId: f.teamA, reason: 'Transferência de QA.' }, 'athletes.transfer'),
    permissao('POST', '/athletes/:id/team/unlink', `/athletes/${f.athleteA}/team/unlink`,
      { reason: 'Desvínculo de QA.' }, 'athletes.transfer',
      { recusasExtras: [404], porQue: '`vinculo_leitura` exige `mci_operator_of(team.organizationId)` ou ser o próprio atleta (medida). Para um atleta da federação que não é o dono, o vínculo é invisível e o serviço responde NO_ACTIVE_MEMBERSHIP — que é não divulgação, não acesso. A fixture prova que existe 1 vínculo ATIVO.' }),

    // ------------------------------------------------- catálogo, evento e estrutura
    // ESCOPO DE PLATAFORMA, e não de federação. `Category` não tem coluna
    // `organizationId` (conferido no schema): o catálogo oficial de categorias é
    // GLOBAL, e a guarda é a permissão `categories.manage`, não o tenant. Logo o
    // caso cross-tenant não se aplica — não existe "categoria de outra
    // federação" para alcançar. Ver achado F2 no relatório de T1.
    permissao('POST', '/categories', '/categories',
      { code: `QACAT${f.codigo}`, name: 'Categoria QA', sex: 'MALE' }, 'categories.manage',
      { escopoDePlataforma: true }),
    permissao('POST', '/classes-catalog', '/classes-catalog',
      { organizationId: f.orgA, code: `QACLS${f.codigo}`, displayName: 'Classe QA' }, 'ranking.manage'),
    permissao('POST', '/events', '/events',
      { organizationId: f.orgA, name: 'Etapa QA Matriz', slug: `etapa-qa-${f.sufixo}` }, 'events.create'),
    permissao('PATCH', '/events/:id', `/events/${f.eventA}`, { venue: 'Ginásio QA' }, 'events.update'),
    permissao('DELETE', '/events/:id', `/events/${f.eventA}`, null, 'events.delete'),
    permissao('POST', '/events/:id/transition', `/events/${f.eventA}/transition`,
      { status: 'CANCELLED' }, 'events.publish'),
    permissao('POST', '/events/:id/categories', `/events/${f.eventA}/categories`,
      { categoryId: f.categoryOutra }, 'events.update'),
    permissao('POST', '/event-categories/:eventCategoryId/divisions', `/event-categories/${f.eventCategoryA}/divisions`,
      { name: 'Divisão QA', code: `QADIV${f.codigo}` }, 'events.update'),
    permissao('POST', '/divisions/:divisionId/classes', `/divisions/${f.divisionA}/classes`,
      { name: 'Classe QA', code: `QAC${f.codigo}` }, 'events.update'),
    permissao('POST', '/events/:id/documents', `/events/${f.eventA}/documents`,
      null, 'documents.upload', { arquivo: 'file' }),

    // ------------------------------------------------------------- inscrições
    permissao('POST', '/events/:id/registrations', `/events/${f.eventA}/registrations`,
      { cpf: f.cpfDoAtletaA, classIds: [f.classA] }, 'registrations.create'),
    permissao('POST', '/registrations/:id/cancel', `/registrations/${f.registrationA}/cancel`,
      { reason: 'Cancelamento de QA.' }, 'registrations.cancel'),

    // -------------------------------------------------- operação do dia do evento
    permissao('POST', '/registrations/:id/checkin', `/registrations/${f.registrationA}/checkin`,
      { device: 'Portaria QA' }, 'checkin.operate'),
    permissao('POST', '/registrations/:id/checkin/cancel', `/registrations/${f.registrationA}/checkin/cancel`,
      null, 'checkin.operate'),
    permissao('POST', '/registrations/:id/weighins', `/registrations/${f.registrationA}/weighins`,
      { weightGrams: 70000 }, 'weighin.operate'),
    permissao('POST', '/events/:id/credentials', `/events/${f.eventA}/credentials`,
      { type: 'STAFF', holderName: 'Fulano QA' }, 'credentials.manage'),
    permissao('POST', '/events/:id/credentials/scan', `/events/${f.eventA}/credentials/scan`,
      { code: f.credencialCodigo }, 'credentials.scan'),
    permissao('POST', '/credentials/:id/revoke', `/credentials/${f.credencialA}/revoke`, null, 'credentials.manage'),
    permissao('POST', '/events/:id/batches', `/events/${f.eventA}/batches`,
      { classId: f.classA, name: 'Bateria QA' }, 'stage.manage'),
    permissao('PUT', '/batches/:id/order', `/batches/${f.batchA}/order`,
      { items: [{ registrationItemId: f.registrationItemA, position: 1 }] }, 'stage.manage'),
    permissao('POST', '/batches/:id/status', `/batches/${f.batchA}/status`,
      { status: 'CALLED' }, 'stage.manage'),

    // --------------------------------------------------------------- resultados
    permissao('POST', '/classes/:id/result', `/classes/${f.classA}/result`,
      { entries: [{ athleteId: f.athleteA, placing: 1, status: 'RANKED' }] }, 'results.receive'),
    permissao('POST', '/classes/:id/result/publish', `/classes/${f.classA}/result/publish`, {}, 'results.publish',
      { recusasExtras: [404], porQue: 'Resultado não publicado é invisível para quem não é operador da federação: a RLS de `Result` esconde a linha e a resposta honesta é 404, que é recusa por não divulgação — não é acesso.' }),
    permissao('POST', '/classes/:id/result/override', `/classes/${f.classA}/result/override`,
      { reason: 'Correção de QA documentada.', entries: [{ registrationItemId: f.registrationItemA, placing: 1, status: 'RANKED' }] },
      'results.override', { recusasExtras: [404], porQue: 'Mesma razão da publicação: a linha do resultado é invisível para quem não opera a federação.' }),

    // ------------------------------------------------------ temporada e ranking
    permissao('POST', '/seasons', '/seasons',
      { organizationId: f.orgA, name: 'Temporada QA', year: 2031 }, 'ranking.manage'),
    permissao('PUT', '/seasons/:id/points-rules', `/seasons/${f.seasonA}/points-rules`,
      { rules: [{ placing: 1, points: 5 }] }, 'ranking.manage'),
    permissao('POST', '/seasons/:id/recompute', `/seasons/${f.seasonA}/recompute`, null, 'ranking.manage'),
    permissao('POST', '/events/:id/overall', `/events/${f.eventA}/overall`,
      { athleteId: f.athleteA }, 'ranking.manage'),
    permissao('DELETE', '/events/:id/overall/:titleId', `/events/${f.eventA}/overall/${f.tituloOverallA}`,
      { reason: 'Revogação de QA.' }, 'ranking.manage'),
    permissao('PATCH', '/ranking/points/:pointId', `/ranking/points/${f.rankingPointA}`,
      { placing: 2, reason: 'Correção de QA documentada.' }, 'ranking.manage',
      { recusasExtras: [404], porQue: 'A RLS de `RankingPoint` é de operador: para quem não opera a federação a linha não existe, e 404 é a recusa por não divulgação.' }),
    permissao('POST', '/ranking/points/:pointId/adjust', `/ranking/points/${f.rankingPointA}/adjust`,
      { points: 4, expectedPoints: f.pontosDoLancamentoA, reason: 'Ajuste de QA documentado.' }, 'ranking.manage',
      { recusasExtras: [404], porQue: 'Mesma RLS de operador do lançamento.' }),
    permissao('POST', '/ranking/points/:pointId/void', `/ranking/points/${f.rankingPointA}/void`,
      { reason: 'Invalidação de QA documentada.' }, 'ranking.manage',
      { recusasExtras: [404], porQue: 'Mesma RLS de operador do lançamento.' }),
    permissao('POST', '/ranking/points/:pointId/restore', `/ranking/points/${f.rankingPointA}/restore`,
      { reason: 'Restauração de QA documentada.' }, 'ranking.manage',
      { recusasExtras: [404], porQue: 'Mesma RLS de operador do lançamento.' }),

    // ------------------------------------------------------------- importação
    permissao('POST', '/musclewar/imports', '/musclewar/imports',
      { organizationId: f.orgA, seasonId: f.seasonA, sourceType: 'CSV', sourceRef: 'qa-matriz.csv', content: f.csvMinimo },
      'musclewar.import'),
    permissao('POST', '/musclewar/imports/:id/apply', `/musclewar/imports/${f.importA}/apply`, null, 'musclewar.apply',
      { recusasExtras: [404], porQue: 'A RLS de `MuscleWarImport` é de operador da federação; sem isso a linha não é visível.' }),
    permissao('POST', '/musclewar/imports/:id/reject', `/musclewar/imports/${f.importA}/reject`,
      { reason: 'Rejeição de QA.' }, 'musclewar.review', { recusasExtras: [404], porQue: 'Mesma RLS de operador do lote.' }),
    permissao('DELETE', '/musclewar/imports/:id', `/musclewar/imports/${f.importA}`,
      { reason: 'Exclusão de QA.' }, 'musclewar.apply', { recusasExtras: [404], porQue: 'Mesma RLS de operador do lote.' }),
    permissao('POST', '/musclewar/items/:itemId/link', `/musclewar/items/${f.importItemA}/link`,
      { athleteId: f.athleteA }, 'musclewar.apply', { recusasExtras: [404], porQue: 'O item herda a visibilidade do lote, que é de operador.' }),

    // ------------------------------------------ equipes, empresas e parceiros
    permissao('POST', '/companies', '/companies',
      { organizationId: f.orgA, name: 'Empresa QA' }, 'companies.manage'),
    permissao('POST', '/teams', '/teams', { organizationId: f.orgA, name: 'Equipe QA' }, 'teams.manage'),
    permissao('POST', '/gyms', '/gyms', { organizationId: f.orgA, name: 'Academia QA' }, 'gyms.manage'),
    // ESCOPO DE PLATAFORMA pelo mesmo motivo: `Coach` também não tem
    // `organizationId` no schema. Ver achado F2.
    permissao('POST', '/coaches', '/coaches', { name: 'Treinador QA' }, 'coaches.manage',
      { escopoDePlataforma: true }),
    permissao('POST', '/brands', '/brands',
      { organizationId: f.orgA, name: 'Marca QA', slug: `marca-qa-${f.sufixo}` }, 'brands.manage'),
    permissao('POST', '/sponsors', '/sponsors', { organizationId: f.orgA, name: 'Patrocinador QA' }, 'sponsors.manage'),
    permissao('POST', '/sponsorships', '/sponsorships', { sponsorId: f.sponsorA, eventId: f.eventA }, 'sponsors.manage'),
    permissao('POST', '/partnerships', '/partnerships', { athleteId: f.athleteA, brandId: f.brandA }, 'brands.manage'),
    permissao('POST', '/partnerships/:id/status', `/partnerships/${f.partnershipA}/status`,
      { status: 'ACTIVE' }, 'brands.manage'),

    // ----------------------------------------------------------------- social
    social('PATCH', '/social/me', '/social/me', { displayName: 'Perfil QA' },
      'O perfil social é do próprio ator: o serviço resolve o perfil por `actor.id`. Não existe parâmetro que aponte para o perfil de outra pessoa.'),
    social('POST', '/social/me/handle', '/social/me/handle', { handle: `qa${f.sufixo}` },
      'Mesmo perfil próprio, resolvido por `actor.id`. A unicidade do handle é do banco.'),
    social('POST', '/social/me/avatar', '/social/me/avatar', null,
      'Avatar do próprio perfil, resolvido por `actor.id`.', { arquivo: 'file' }),
    social('DELETE', '/social/me/avatar', '/social/me/avatar', null,
      'Remove o avatar do próprio perfil, resolvido por `actor.id`.'),
    social('POST', '/social/posts', '/social/posts', { content: 'Publicação de QA.' },
      'Publicar é a função da rede social para qualquer conta autenticada; o autor é `actor`, não um parâmetro.'),
    social('DELETE', '/social/posts/:id', `/social/posts/${f.postDoAtletaA}`, null,
      'Só o autor (ou a moderação) apaga. O teste de limite prova que outro ator não apaga a publicação alheia.',
      { alheio: () => `/social/posts/${f.postDoAtletaB}` }),
    social('POST', '/social/posts/:id/media', `/social/posts/${f.postDoAtletaA}/media`, null,
      'Anexar mídia é ato do autor sobre a própria publicação.',
      { arquivo: 'file', alheio: () => `/social/posts/${f.postDoAtletaB}/media` }),
    social('POST', '/social/posts/:id/like', `/social/posts/${f.postDoAtletaB}/like`, null,
      'Curtir publicação de OUTRA pessoa é o comportamento pretendido de uma rede social; a linha gravada é (publicação, ator).'),
    social('DELETE', '/social/posts/:id/like', `/social/posts/${f.postDoAtletaB}/like`, null,
      'Descurtir remove a própria curtida, identificada por (publicação, ator).'),
    social('POST', '/social/posts/:id/save', `/social/posts/${f.postDoAtletaB}/save`, null,
      'Salvar é ato privado do ator sobre a própria lista.'),
    social('DELETE', '/social/posts/:id/save', `/social/posts/${f.postDoAtletaB}/save`, null,
      'Remove o próprio salvamento — a linha é (publicação, ator), e não existe parâmetro que alcance a lista de outra pessoa.'),
    social('POST', '/social/posts/:id/share', `/social/posts/${f.postDoAtletaB}/share`, { comment: 'Compartilhando (QA).' },
      'Compartilhar conteúdo de outra pessoa é a função da rede; o compartilhamento é do ator.'),
    social('POST', '/social/posts/:id/comments', `/social/posts/${f.postDoAtletaB}/comments`, { content: 'Comentário de QA.' },
      'Comentar na publicação de outra pessoa é a função da rede; o autor do comentário é o ator.'),
    social('DELETE', '/social/comments/:id', `/social/comments/${f.comentarioDoAtletaA}`, null,
      'Só o autor do comentário, o autor da publicação ou a moderação apagam. O alvo alheio é um comentário de OUTRO autor em publicação de OUTRO autor — o comentário na publicação do próprio ator não serve, porque apagá-lo é direito dele.',
      { alheio: () => `/social/comments/${f.comentarioAlheio}` }),
    social('POST', '/social/profiles/:handle/follow', `/social/profiles/${f.handleDoAtletaB}/follow`, null,
      'Seguir outra conta é a função da rede; a linha é (seguidor = ator, seguido).'),
    social('DELETE', '/social/profiles/:handle/follow', `/social/profiles/${f.handleDoAtletaB}/follow`, null,
      'Deixar de seguir remove a própria linha de seguimento.'),
    social('POST', '/social/profiles/:handle/block', `/social/profiles/${f.handleDoAtletaB}/block`, null,
      'Bloquear é ato de defesa do ator sobre a própria experiência.'),
    social('DELETE', '/social/profiles/:handle/block', `/social/profiles/${f.handleDoAtletaB}/block`, null,
      'Desbloquear remove o próprio bloqueio — a linha é (bloqueador = ator, bloqueado); ninguém desfaz o bloqueio de terceiro.'),
    social('POST', '/social/stories', '/social/stories', null,
      'Publicar story é função da rede para qualquer conta; o autor é o ator.', { arquivo: 'file' }),
    social('POST', '/social/stories/:id/view', `/social/stories/${f.storyDoAtletaB}/view`, null,
      'Registrar visualização é ato do espectador: a linha é (story, ator).'),
    social('POST', '/social/reports', '/social/reports',
      { targetType: 'POST', targetId: f.postDoAtletaB, reason: 'Denúncia de QA.' },
      'Denunciar é função aberta a qualquer conta autenticada — fechá-la por permissão administrativa esvaziaria a moderação.'),
    permissao('POST', '/social/reports/:id/resolve', `/social/reports/${f.denunciaA}/resolve`,
      { status: 'DISMISSED' }, 'social.moderate'),

    // ------------------------------------------------------------- mensageria
    social('POST', '/messenger/conversations', '/messenger/conversations',
      { kind: 'DIRECT', participantIds: [f.perfilDoAtletaB] },
      'Abrir conversa é função da mensageria para qualquer conta; o ator entra como participante obrigatório.'),
    social('POST', '/messenger/conversations/:id/messages', `/messenger/conversations/${f.conversaDoAtletaA}/messages`,
      { body: 'Mensagem de QA.' },
      'Enviar mensagem exige ser participante. O limite é provado com a conversa de que o ator não participa.',
      { alheio: () => `/messenger/conversations/${f.conversaAlheia}/messages` }),
    social('POST', '/messenger/conversations/:id/media', `/messenger/conversations/${f.conversaDoAtletaA}/media`, null,
      'Mesma regra do envio de texto: participante.',
      { arquivo: 'file', alheio: () => `/messenger/conversations/${f.conversaAlheia}/media` }),
    social('POST', '/messenger/conversations/:id/read', `/messenger/conversations/${f.conversaDoAtletaA}/read`, null,
      'Marcar leitura é ato do participante sobre a própria leitura.',
      { alheio: () => `/messenger/conversations/${f.conversaAlheia}/read` }),
    social('POST', '/messenger/conversations/:id/members', `/messenger/conversations/${f.conversaDoAtletaA}/members`,
      { participantIds: [f.perfilDoAdmin] },
      'Só participante acrescenta participante; o limite é provado com a conversa alheia.',
      { alheio: () => `/messenger/conversations/${f.conversaAlheia}/members` }),
    social('POST', '/messenger/conversations/:id/leave', `/messenger/conversations/${f.conversaDoAtletaA}/leave`, null,
      'Sair é ato do próprio participante: o serviço remove o ATOR da conversa, e não aceita dizer quem sai.',
      { alheio: () => `/messenger/conversations/${f.conversaAlheia}/leave` }),
    social('POST', '/messenger/messages/:id/reactions', `/messenger/messages/${f.mensagemDoAtletaA}/reactions`,
      { emoji: '👏' },
      'Reagir exige participar da conversa da mensagem.',
      { alheio: () => `/messenger/messages/${f.mensagemAlheia}/reactions` }),
    social('DELETE', '/messenger/messages/:id', `/messenger/messages/${f.mensagemDoAtletaA}`, null,
      'Só o autor apaga a própria mensagem; o limite é provado com a mensagem de quem não é o ator.',
      { alheio: () => `/messenger/messages/${f.mensagemAlheia}` }),

    // ------------------------------------------------------------ comunidades
    permissao('POST', '/communities', '/communities',
      { slug: `com-qa-${f.sufixo}`, name: 'Comunidade QA' }, 'communities.manage'),
    social('POST', '/communities/:slug/join', `/communities/${f.comunidadeSlug}/join`, null,
      'Entrar numa comunidade é ato do próprio ator; a linha é (comunidade, ator).'),
    social('POST', '/communities/:slug/leave', `/communities/${f.comunidadeSlug}/leave`, null,
      'Sair da comunidade é ato do próprio ator: a linha removida é (comunidade, ator), sem parâmetro de terceiro.'),
    permissao('POST', '/communities/:slug/members', `/communities/${f.comunidadeSlug}/members`,
      { profileId: f.perfilDoAtletaB, role: 'MEMBER' }, 'communities.manage'),

    // ---------------------------------------------------------- notificações
    auto('POST', '/notifications/:id/read', `/notifications/${f.notificacaoDoAtletaA}/read`, null,
      'A notificação já é endereçada a um destinatário; marcar como lida só alcança as do próprio ator — a RLS de `Notification` é `userId = ator`.',
      { alheio: () => `/notifications/${f.notificacaoAlheia}/read` }),
    auto('POST', '/notifications/read-all', '/notifications/read-all', null,
      'Marca em lote as notificações DO ATOR. Não recebe parâmetro de destinatário: não há alvo alheio possível.')
  ];
}

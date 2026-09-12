const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export const AUTH_STORAGE_KEY = 'mci-auth-token';

// Eventos de dados. A interface reage a uma escrita bem-sucedida recarregando
// o que estiver na tela, em vez de cada tela adivinhar quando revalidar.
export const refreshData = () => window.dispatchEvent(new Event('mci-data-changed'));

// Fim de sessão. O token vence sozinho, e sem este aviso o que o operador vê é
// uma tela que CONTINUA parecendo autenticada — nome no canto, menu inteiro —
// onde toda ação devolve um erro e nenhuma diz que a sessão acabou. O evento
// leva a aplicação de volta à entrada, uma vez só.
export const SESSAO_EXPIRADA = 'mci-sessao-expirada';

// Entrar e cadastrar RESPONDEM 401 por senha errada, e isso não é sessão
// vencida: não há sessão. Tratar os dois casos igual mandaria o usuário para a
// tela de entrada em que ele já está, apagando a mensagem do erro real.
const ROTAS_DE_ENTRADA = ['/auth/login', '/auth/register'];

export const getAuthToken = () => {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY);
  } catch (error) {
    return null;
  }
};

export const setAuthToken = token => {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (error) {
    /* armazenamento indisponível: a sessão vale apenas para esta aba */
  }
};

export const clearAuthToken = () => setAuthToken(null);

const withQuery = (path, params = {}) => {
  const entries = Object.entries(params).filter(([, valor]) => valor !== undefined && valor !== null && valor !== '');
  if (!entries.length) return path;
  return `${path}?${entries.map(([chave, valor]) => `${chave}=${encodeURIComponent(valor)}`).join('&')}`;
};

export async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const token = getAuthToken();

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });

    const corpo = response.status === 204 ? null : await response.json().catch(() => null);

    if (!response.ok) {
      // 401 com token enviado significa que o servidor recusou ESTA sessão.
      // 403 não entra aqui: é falta de permissão, e derrubar a sessão por
      // isso tiraria o usuário do sistema por ter clicado onde não podia.
      if (response.status === 401 && token && !ROTAS_DE_ENTRADA.includes(path)) {
        clearAuthToken();
        window.dispatchEvent(new Event(SESSAO_EXPIRADA));
      }
      const erro = new Error(corpo?.error?.message || 'Não foi possível concluir a operação.');
      erro.code = corpo?.error?.code;
      erro.status = response.status;
      erro.details = corpo?.error?.details;
      throw erro;
    }
    return corpo;
  } catch (error) {
    // A mensagem trocada é para o usuário; `cause` preserva o erro original
    // para quem for depurar. Sem isso, a falha de rede vira uma frase sem
    // rastro no console.
    if (error.name === 'AbortError') throw new Error('A API demorou demais para responder.', { cause: error });
    if (error instanceof TypeError) throw new Error('Não foi possível conectar à API.', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const get = (path, params) => apiRequest(withQuery(path, params));
const post = (path, data) => apiRequest(path, { method: 'POST', body: JSON.stringify(data ?? {}) });
const patch = (path, data) => apiRequest(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) });
const put = (path, data) => apiRequest(path, { method: 'PUT', body: JSON.stringify(data ?? {}) });
const remove = path => apiRequest(path, { method: 'DELETE' });

// O navegador monta o boundary do multipart sozinho: fixar Content-Type aqui
// quebraria o envio.
const upload = (path, arquivo, campos = {}) => {
  const form = new FormData();
  form.append('file', arquivo);
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor !== undefined && valor !== null && valor !== '') form.append(chave, String(valor));
  }
  return apiRequest(path, { method: 'POST', body: form });
};

// Mídia protegida. A rota exige Authorization, e <img src> não manda
// cabeçalho — então o arquivo é buscado com o token e exposto como object URL.
// Token em query string acabaria em log de servidor, histórico e Referer.
export async function fetchMediaObjectUrl(caminho) {
  const token = getAuthToken();
  // Mesmo teto de espera das demais chamadas. Sem ele, uma conexão que abre e
  // não responde deixa o avatar ou a foto girando para sempre — e, numa tela
  // de feed, várias ao mesmo tempo, cada uma segurando uma conexão do
  // navegador.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_URL}${caminho}`, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) throw new Error('Mídia indisponível.');
    return URL.createObjectURL(await response.blob());
  } finally {
    clearTimeout(timeout);
  }
}

export const releaseMediaObjectUrl = url => {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
};

export const api = {
  auth: {
    register: dados => post('/auth/register', dados),
    login: dados => post('/auth/login', dados),
    me: () => get('/auth/me'),
    updateProfile: dados => patch('/profile', dados),
    changePassword: dados => post('/profile/password', dados)
  },

  organizations: {
    list: () => get('/organizations'),
    create: dados => post('/organizations', dados),
    findById: id => get(`/organizations/${id}`),
    addMember: (id, dados) => post(`/organizations/${id}/members`, dados),
    removeMember: (id, membershipId) => remove(`/organizations/${id}/members/${membershipId}`)
  },

  affiliations: {
    list: params => get('/affiliations', params),
    create: dados => post('/affiliations', dados),
    activate: id => post(`/affiliations/${id}/activate`),
    deactivate: id => post(`/affiliations/${id}/deactivate`)
  },

  athletes: {
    list: params => get('/athletes', params),
    create: dados => post('/athletes', dados),
    findById: id => get(`/athletes/${id}`),
    update: (id, dados) => patch(`/athletes/${id}`, dados),
    lookup: dados => post('/athletes/lookup', dados),
    listPro: params => get('/athletes/pro', params),
    setProStatus: (id, dados) => post(`/athletes/${id}/pro-status`, dados),
    // Vínculo com equipe. `linkTeam` só vincula atleta livre; tirar de outra
    // equipe é `transferTeam`, ato do operador da Muscle Contest.
    linkTeam: (id, dados) => post(`/athletes/${id}/team`, dados),
    transferTeam: (id, dados) => post(`/athletes/${id}/team/transfer`, dados),
    unlinkTeam: (id, dados) => post(`/athletes/${id}/team/unlink`, dados),
    teamHistory: id => get(`/athletes/${id}/team-history`),
    documents: id => get(`/athletes/${id}/documents`),
    uploadDocument: (id, arquivo, campos) => upload(`/athletes/${id}/documents`, arquivo, campos)
  },

  categories: {
    list: () => get('/categories'),
    create: dados => post('/categories', dados)
  },

  events: {
    list: params => get('/events', params),
    create: dados => post('/events', dados),
    findOne: id => get(`/events/${id}`),
    update: (id, dados) => patch(`/events/${id}`, dados),
    transition: (id, dados) => post(`/events/${id}/transition`, dados),
    remove: id => remove(`/events/${id}`),
    addCategory: (id, dados) => post(`/events/${id}/categories`, dados),
    addDivision: (eventCategoryId, dados) => post(`/event-categories/${eventCategoryId}/divisions`, dados),
    addClass: (divisionId, dados) => post(`/divisions/${divisionId}/classes`, dados),
    documents: id => get(`/events/${id}/documents`),
    uploadDocument: (id, arquivo, campos) => upload(`/events/${id}/documents`, arquivo, campos),
    operations: id => get(`/events/${id}/operations`)
  },

  registrations: {
    listByEvent: (eventId, params) => get(`/events/${eventId}/registrations`, params),
    create: (eventId, dados) => post(`/events/${eventId}/registrations`, dados),
    findById: id => get(`/registrations/${id}`),
    cancel: (id, dados) => post(`/registrations/${id}/cancel`, dados)
  },

  operations: {
    listCheckIns: (eventId, params) => get(`/events/${eventId}/checkins`, params),
    checkIn: (registrationId, dados) => post(`/registrations/${registrationId}/checkin`, dados),
    cancelCheckIn: registrationId => post(`/registrations/${registrationId}/checkin/cancel`),
    weighIns: registrationId => get(`/registrations/${registrationId}/weighins`),
    weighIn: (registrationId, dados) => post(`/registrations/${registrationId}/weighins`, dados),
    credentials: eventId => get(`/events/${eventId}/credentials`),
    issueCredential: (eventId, dados) => post(`/events/${eventId}/credentials`, dados),
    revokeCredential: id => post(`/credentials/${id}/revoke`),
    scanCredential: (eventId, dados) => post(`/events/${eventId}/credentials/scan`, dados),
    batches: eventId => get(`/events/${eventId}/batches`),
    createBatch: (eventId, dados) => post(`/events/${eventId}/batches`, dados),
    stageOrder: batchId => get(`/batches/${batchId}/order`),
    setStageOrder: (batchId, dados) => put(`/batches/${batchId}/order`, dados),
    setBatchStatus: (batchId, dados) => post(`/batches/${batchId}/status`, dados)
  },

  results: {
    listByEvent: eventId => get(`/events/${eventId}/results`),
    findByClass: classId => get(`/classes/${classId}/result`),
    // O MCI NÃO julga: lança o resultado oficial recebido de fora.
    receive: (classId, dados) => post(`/classes/${classId}/result`, dados),
    publish: (classId, dados) => post(`/classes/${classId}/result/publish`, dados),
    override: (classId, dados) => post(`/classes/${classId}/result/override`, dados),
    versions: classId => get(`/classes/${classId}/result/versions`)
  },

  ranking: {
    // Duas métricas, dois endpoints — de propósito. `list` é o ranking do
    // CAMPEONATO, onde toda classe pontua; `superOverall` é o classificatório
    // ANUAL, que só as classes elegíveis alimentam. Misturá-los apagaria
    // Estreante, Novice e Master do pódio do campeonato.
    list: params => get('/ranking', params),
    superOverall: params => get('/ranking/super-overall', params),
    teams: params => get('/ranking/teams', params),
    companies: params => get('/ranking/companies', params),
    athletePoints: (id, params) => get(`/athletes/${id}/ranking-points`, params),
    seasons: params => get('/seasons', params),
    createSeason: dados => post('/seasons', dados),
    setPointsRules: (id, dados) => put(`/seasons/${id}/points-rules`, dados),
    recompute: id => post(`/seasons/${id}/recompute`)
  },

  muscleWar: {
    list: params => get('/musclewar/imports', params),
    create: dados => post('/musclewar/imports', dados),
    preview: id => get(`/musclewar/imports/${id}`),
    link: (itemId, dados) => post(`/musclewar/items/${itemId}/link`, dados),
    apply: id => post(`/musclewar/imports/${id}/apply`),
    reject: (id, dados) => post(`/musclewar/imports/${id}/reject`, dados)
  },

  partners: {
    // Empresa entra na competição com as suas equipes — fica acima da equipe.
    // Patrocinador NÃO: é relação comercial, e por isso vive noutro bloco.
    companies: params => get('/companies', params),
    createCompany: dados => post('/companies', dados),
    teams: params => get('/teams', params),
    createTeam: dados => post('/teams', dados),
    gyms: params => get('/gyms', params),
    createGym: dados => post('/gyms', dados),
    coaches: params => get('/coaches', params),
    createCoach: dados => post('/coaches', dados),
    brands: params => get('/brands', params),
    createBrand: dados => post('/brands', dados),
    sponsors: params => get('/sponsors', params),
    createSponsor: dados => post('/sponsors', dados),
    sponsorships: params => get('/sponsorships', params),
    createSponsorship: dados => post('/sponsorships', dados),
    partnerships: params => get('/partnerships', params),
    createPartnership: dados => post('/partnerships', dados),
    setPartnershipStatus: (id, dados) => post(`/partnerships/${id}/status`, dados)
  },

  social: {
    me: () => get('/social/me'),
    updateProfile: dados => patch('/social/me', dados),
    setHandle: handle => post('/social/me/handle', { handle }),
    feed: params => get('/social/feed', params),
    saved: params => get('/social/saved', params),
    createPost: dados => post('/social/posts', dados),
    attachMedia: (postId, arquivo) => upload(`/social/posts/${postId}/media`, arquivo),
    getPost: id => get(`/social/posts/${id}`),
    deletePost: id => remove(`/social/posts/${id}`),
    like: id => post(`/social/posts/${id}/like`),
    unlike: id => remove(`/social/posts/${id}/like`),
    save: id => post(`/social/posts/${id}/save`),
    unsave: id => remove(`/social/posts/${id}/save`),
    share: (id, dados) => post(`/social/posts/${id}/share`, dados),
    comments: (id, params) => get(`/social/posts/${id}/comments`, params),
    comment: (id, dados) => post(`/social/posts/${id}/comments`, dados),
    deleteComment: id => remove(`/social/comments/${id}`),
    profile: handle => get(`/social/profiles/${handle}`),
    follow: handle => post(`/social/profiles/${handle}/follow`),
    unfollow: handle => remove(`/social/profiles/${handle}/follow`),
    followers: (handle, params) => get(`/social/profiles/${handle}/followers`, params),
    following: (handle, params) => get(`/social/profiles/${handle}/following`, params),
    block: handle => post(`/social/profiles/${handle}/block`),
    unblock: handle => remove(`/social/profiles/${handle}/block`),
    stories: () => get('/social/stories'),
    createStory: (arquivo, campos) => upload('/social/stories', arquivo, campos),
    viewStory: id => post(`/social/stories/${id}/view`),
    report: dados => post('/social/reports', dados),
    reports: params => get('/social/reports', params),
    resolveReport: (id, dados) => post(`/social/reports/${id}/resolve`, dados)
  },

  messenger: {
    conversations: params => get('/messenger/conversations', params),
    createConversation: dados => post('/messenger/conversations', dados),
    conversation: id => get(`/messenger/conversations/${id}`),
    messages: (id, params) => get(`/messenger/conversations/${id}/messages`, params),
    send: (id, dados) => post(`/messenger/conversations/${id}/messages`, dados),
    sendMedia: (id, arquivo) => upload(`/messenger/conversations/${id}/media`, arquivo),
    markRead: id => post(`/messenger/conversations/${id}/read`),
    addMembers: (id, dados) => post(`/messenger/conversations/${id}/members`, dados),
    leave: id => post(`/messenger/conversations/${id}/leave`),
    react: (messageId, dados) => post(`/messenger/messages/${messageId}/reactions`, dados),
    deleteMessage: messageId => remove(`/messenger/messages/${messageId}`)
  },

  communities: {
    list: params => get('/communities', params),
    create: dados => post('/communities', dados),
    findBySlug: slug => get(`/communities/${slug}`),
    join: slug => post(`/communities/${slug}/join`),
    leave: slug => post(`/communities/${slug}/leave`),
    members: (slug, params) => get(`/communities/${slug}/members`, params),
    addMember: (slug, dados) => post(`/communities/${slug}/members`, dados)
  },

  search: params => get('/search', params),

  dashboard: {
    summary: () => get('/dashboard/summary'),
    admin: params => get('/dashboard/admin', params),
    athlete: () => get('/dashboard/athlete')
  },

  publicApi: {
    summary: () => get('/public/summary'),
    events: params => get('/public/events', params),
    event: slug => get(`/public/events/${slug}`),
    athletes: params => get('/public/athletes', params),
    athlete: id => get(`/public/athletes/${id}`)
  },

  notifications: {
    list: params => get('/notifications', params),
    markRead: id => post(`/notifications/${id}/read`),
    markAllRead: () => post('/notifications/read-all')
  },

  admin: {
    users: params => get('/admin/users', params),
    user: id => get(`/admin/users/${id}`),
    updateUser: (id, dados) => patch(`/admin/users/${id}`, dados)
  },

  audit: params => get('/audit', params)
};

export default api;

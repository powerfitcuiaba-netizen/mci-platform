const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
export const AUTH_STORAGE_KEY = 'mci-auth-token';
export const refreshData = () => window.dispatchEvent(new Event('mci-data-changed'));

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
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return path;
  const search = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${path}?${search}`;
};

export async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const token = getAuthToken();
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(body?.error?.message || 'Não foi possível concluir a operação.');
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('A API demorou demais para responder.');
    if (error instanceof TypeError) throw new Error('Não foi possível conectar à API.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const post = (path, data) => apiRequest(path, { method: 'POST', body: JSON.stringify(data) });

// Envio de arquivo: o navegador monta o boundary do multipart sozinho, então o
// Content-Type não pode ser fixado aqui.
export async function apiUpload(path, formData) {
  const token = getAuthToken();
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || 'Não foi possível enviar o arquivo.');
  return body;
}

// Download autenticado: o header Authorization não viaja num link comum, então
// o arquivo é buscado por fetch e entregue como blob.
export async function apiDownload(path) {
  const token = getAuthToken();
  const response = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || 'Não foi possível baixar o arquivo.');
  }
  return response.blob();
}
const patch = (path, data) => apiRequest(path, { method: 'PATCH', body: JSON.stringify(data) });
const remove = path => apiRequest(path, { method: 'DELETE' });

export const api = {
  auth: {
    login: data => post('/auth/login', data),
    register: data => post('/auth/register', data),
    me: () => apiRequest('/auth/me')
  },
  profile: {
    me: () => apiRequest('/profile'),
    update: data => patch('/profile', data),
    changePassword: data => post('/profile/password', data)
  },
  athlete: {
    overview: () => apiRequest('/athlete/overview')
  },
  admin: {
    overview: () => apiRequest('/admin/overview'),
    users: params => apiRequest(withQuery('/admin/users', params || {})),
    user: id => apiRequest(`/admin/users/${id}`),
    updateUser: (id, data) => patch(`/admin/users/${id}`, data)
  },
  audit: {
    list: params => apiRequest(withQuery('/audit', params || {}))
  },
  dashboard: {
    summary: () => apiRequest('/dashboard/summary')
  },
  tournaments: {
    list: () => apiRequest('/campeonatos'),
    get: id => apiRequest(`/campeonatos/${id}`),
    create: data => post('/campeonatos', data),
    update: (id, data) => patch(`/campeonatos/${id}`, data),
    remove: id => remove(`/campeonatos/${id}`),
    participants: id => apiRequest(`/campeonatos/${id}/participantes`),
    enroll: (id, participantId) => post(`/campeonatos/${id}/participantes`, { participantId }),
    cancelEnrollment: enrollmentId => patch(`/inscricoes/${enrollmentId}/cancel`, {}),
    standings: id => apiRequest(`/campeonatos/${id}/classificacao`)
  },
  participants: {
    list: () => apiRequest('/participantes'),
    create: data => post('/participantes', data),
    update: (id, data) => patch(`/participantes/${id}`, data),
    remove: id => remove(`/participantes/${id}`)
  },
  teams: {
    list: () => apiRequest('/equipes'),
    create: data => post('/equipes', { ...data, type: 'TEAM' }),
    update: (id, data) => patch(`/equipes/${id}`, data),
    remove: id => remove(`/equipes/${id}`)
  },
  matches: {
    list: tournamentId => apiRequest(withQuery('/partidas', { tournamentId })),
    create: data => post('/partidas', data),
    update: (id, data) => patch(`/partidas/${id}`, data),
    result: id => apiRequest(`/partidas/${id}/resultado`),
    saveResult: (id, data) => post(`/partidas/${id}/resultado`, data),
    updateResult: (id, data) => patch(`/partidas/${id}/resultado`, data)
  },
  judge: {
    matches: () => apiRequest('/judge/matches'),
    assignments: () => apiRequest('/judge/assignments'),
    assign: data => post('/judge/assignments', data)
  },
  checkin: {
    byTournament: (tournamentId, search) => apiRequest(withQuery(`/checkin/tournaments/${tournamentId}`, { search })),
    byEnrollment: enrollmentId => apiRequest(`/checkin/enrollments/${enrollmentId}`),
    register: (enrollmentId, data = {}) => post(`/checkin/enrollments/${enrollmentId}`, data),
    cancel: enrollmentId => patch(`/checkin/enrollments/${enrollmentId}/cancel`, {})
  },
  notifications: {
    list: params => apiRequest(withQuery('/notifications', params || {})),
    markRead: id => patch(`/notifications/${id}/read`, {}),
    markAllRead: () => post('/notifications/read-all', {})
  },
  documents: {
    list: tournamentId => apiRequest(withQuery('/documents', { tournamentId })),
    get: id => apiRequest(`/documents/${id}`),
    create: data => post('/documents', data),
    upload: formData => apiUpload('/documents/upload', formData),
    download: id => apiDownload(`/documents/${id}/download`),
    remove: id => remove(`/documents/${id}`)
  },
  coach: {
    overview: () => apiRequest('/coach/overview'),
    teams: () => apiRequest('/coach/teams'),
    athletes: () => apiRequest('/coach/athletes'),
    setTeam: (participantId, teamId) => patch(`/coach/participants/${participantId}/team`, { teamId })
  },
  backstage: {
    overview: () => apiRequest('/backstage/overview')
  },
  reports: {
    list: () => apiRequest('/reports/tournaments'),
    tournament: id => apiRequest(`/reports/tournaments/${id}`)
  },
  orders: {
    list: params => apiRequest(withQuery('/orders', params || {})),
    get: id => apiRequest(`/orders/${id}`),
    // A chave de idempotência viaja no header: um clique repetido no checkout
    // não pode virar um segundo pedido.
    create: (data, idempotencyKey) => apiRequest('/orders', { method: 'POST', body: JSON.stringify(data), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }),
    cancel: id => patch(`/orders/${id}/cancel`, {}),
    payments: id => apiRequest(`/orders/${id}/payments`),
    startPayment: (id, idempotencyKey) => apiRequest(`/orders/${id}/payments`, { method: 'POST', body: JSON.stringify({}), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }),
    refund: (id, data) => post(`/orders/${id}/refunds`, data)
  },
  coupons: {
    list: () => apiRequest('/coupons'),
    create: data => post('/coupons', data),
    setActive: (id, active) => patch(`/coupons/${id}/active`, { active }),
    preview: data => post('/coupons/preview', data)
  },
  refunds: {
    list: params => apiRequest(withQuery('/refunds', params || {}))
  },
  sponsors: {
    list: () => apiRequest('/sponsors'),
    create: data => post('/sponsors', data),
    sponsorships: params => apiRequest(withQuery('/sponsorships', params || {})),
    createSponsorship: data => post('/sponsorships', data)
  },
  publicFeed: {
    summary: () => apiRequest('/public/summary'),
    tournaments: () => apiRequest('/public/tournaments'),
    tournament: id => apiRequest(`/public/tournaments/${id}`),
    live: () => apiRequest('/public/live'),
    athletes: () => apiRequest('/public/athletes'),
    athlete: id => apiRequest(`/public/athletes/${id}`),
    teams: () => apiRequest('/public/teams'),
    team: id => apiRequest(`/public/teams/${id}`)
  }
};

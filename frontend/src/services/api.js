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

export const api = {
  auth: {
    login: data => apiRequest('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
    register: data => apiRequest('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    me: () => apiRequest('/auth/me')
  },
  tournaments: {
    list: () => apiRequest('/campeonatos'),
    get: id => apiRequest(`/campeonatos/${id}`),
    create: data => apiRequest('/campeonatos', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => apiRequest(`/campeonatos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: id => apiRequest(`/campeonatos/${id}`, { method: 'DELETE' }),
    participants: id => apiRequest(`/campeonatos/${id}/participantes`),
    enroll: (id, participantId) => apiRequest(`/campeonatos/${id}/participantes`, { method: 'POST', body: JSON.stringify({ participantId }) }),
    standings: id => apiRequest(`/campeonatos/${id}/classificacao`)
  },
  participants: {
    list: () => apiRequest('/participantes'),
    create: data => apiRequest('/participantes', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => apiRequest(`/participantes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: id => apiRequest(`/participantes/${id}`, { method: 'DELETE' })
  },
  teams: {
    list: () => apiRequest('/equipes'),
    create: data => apiRequest('/equipes', { method: 'POST', body: JSON.stringify({ ...data, type: 'TEAM' }) }),
    update: (id, data) => apiRequest(`/equipes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: id => apiRequest(`/equipes/${id}`, { method: 'DELETE' })
  },
  matches: {
    list: tournamentId => apiRequest(`/partidas${tournamentId ? `?tournamentId=${encodeURIComponent(tournamentId)}` : ''}`),
    create: data => apiRequest('/partidas', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => apiRequest(`/partidas/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    result: id => apiRequest(`/partidas/${id}/resultado`),
    saveResult: (id, data) => apiRequest(`/partidas/${id}/resultado`, { method: 'POST', body: JSON.stringify(data) }),
    updateResult: (id, data) => apiRequest(`/partidas/${id}/resultado`, { method: 'PATCH', body: JSON.stringify(data) })
  }
};
import { api, authRequest, clearAuthToken, getAuthToken, setAuthToken } from './services/api';

const AUTH_STORAGE_KEY = 'mci-auth-token';

export function getStoredSession() {
  const token = getAuthToken();
  if (!token) return null;
  return { token };
}

export async function bootAuthSession() {
  const token = getAuthToken();
  if (!token) return { user: null, token: null, authenticated: false };

  try {
    const { user } = await api.auth.me();
    return { user, token, authenticated: true };
  } catch (error) {
    clearAuthToken();
    return { user: null, token: null, authenticated: false };
  }
}

export async function loginUser(payload) {
  const response = await api.auth.login(payload);
  setAuthToken(response.token);
  return response.user;
}

export async function registerUser(payload) {
  const response = await api.auth.register(payload);
  setAuthToken(response.token);
  return response.user;
}

export async function logoutUser() {
  clearAuthToken();
  return true;
}

export { AUTH_STORAGE_KEY };

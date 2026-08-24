import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearAuthToken, getAuthToken, setAuthToken } from './services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const hydrate = async () => {
    const token = getAuthToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const response = await api.auth.me();
      setUser(response.user);
    } catch (error) {
      clearAuthToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { hydrate(); }, []);

  const login = async (payload) => {
    const response = await api.auth.login(payload);
    setAuthToken(response.token);
    setUser(response.user);
    return response.user;
  };

  const register = async (payload) => {
    const response = await api.auth.register(payload);
    setAuthToken(response.token);
    setUser(response.user);
    return response.user;
  };

  const logout = () => {
    clearAuthToken();
    setUser(null);
    window.location.hash = '#login';
  };

  const value = useMemo(() => ({ user, loading, login, register, logout, authenticated: !!user }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

export default AuthContext;

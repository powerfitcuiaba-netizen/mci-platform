import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    auth: {
      login: vi.fn(),
      register: vi.fn(),
      me: vi.fn()
    },
    tournaments: { list: vi.fn(() => Promise.resolve([])) },
    matches: { list: vi.fn(() => Promise.resolve([])) }
  }
}));

vi.mock('./services/api', () => ({
  api: mockApi,
  refreshData: vi.fn(),
  getAuthToken: () => localStorage.getItem('mci-auth-token'),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn()
}));

describe('MCI Campeonatos', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#login';
    mockApi.auth.login.mockReset();
    mockApi.auth.register.mockReset();
    mockApi.auth.me.mockReset();
    mockApi.tournaments.list.mockResolvedValue([]);
    mockApi.matches.list.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it('exibe a tela de login quando não há sessão', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: /login/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /entrar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /criar conta/i })).toBeInTheDocument();
  });

  it('redireciona para dashboard quando o usuário está autenticado', async () => {
    mockApi.auth.me.mockResolvedValue({ user: { name: 'Ana', email: 'ana@example.com', role: 'ORGANIZER' } });
    localStorage.setItem('mci-auth-token', 'fake-token');
    render(<App />);
    expect(await screen.findByRole('heading', { name: /visão geral/i })).toBeInTheDocument();
  });
});
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// O INTERRUPTOR DO AUTOCADASTRO.
//
// `Organization.selfRegistrationOpen` é `Boolean @default(false)`: a federação
// nasce FECHADA para cadastro espontâneo. A rota para abrir existe desde
// sempre — e nenhuma tela a chamava.
//
// O efeito, medido em produção: o atleta chegava na tela de solicitação, o
// campo "Entidade de filiação" vinha vazio, e a mensagem "Nenhuma entidade de
// filiação ativa está disponível para a sua conta" não apontava para a causa.
// A federação não tinha como abrir a porta pela interface.
//
// Dois testes trancam duas portas: o ESTADO tem de estar visível antes de o
// operador procurar o botão, e o botão tem de chamar a rota que já existe —
// nunca uma nova.
// ==========================================================================

const api = {
  organizations: { list: vi.fn(), setSelfRegistration: vi.fn(), create: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ usuario: { id: 'u1', role: 'SUPER_ADMIN' } }) }));

const { AdminConfiguracoes } = await import('./adminPlatform');

const notificacoes = [];
const notificar = (texto, tom) => {
  if (typeof texto !== 'string') throw new TypeError(`notificar espera texto, recebeu ${typeof texto}`);
  notificacoes.push({ texto, tom });
};

const organizacao = (aberto) => ({
  id: 'o1', name: 'MCI Brasil', slug: 'mci-brasil', active: true,
  selfRegistrationOpen: aberto,
  _count: { members: 3, athletes: 191, events: 1 }
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.organizations)) fn.mockReset();
  notificacoes.length = 0;
});
afterEach(cleanup);

const abrirTela = async aberto => {
  api.organizations.list.mockResolvedValue({ items: [organizacao(aberto)] });
  render(<AdminConfiguracoes notificar={notificar} />);
  const linha = await screen.findByText('MCI Brasil');
  return linha.closest('.list-row');
};

describe('o estado do autocadastro é visível', () => {
  it('diz FECHADO quando está fechado', async () => {
    const linha = await abrirTela(false);
    expect(within(linha).getByText(/Autocadastro fechado/i)).toBeTruthy();
    // E o botão oferece a ação que falta, não a que já está feita.
    expect(within(linha).getByRole('button', { name: /Abrir autocadastro/i })).toBeTruthy();
  });

  it('diz ABERTO quando está aberto', async () => {
    const linha = await abrirTela(true);
    expect(within(linha).getByText(/Autocadastro aberto/i)).toBeTruthy();
    expect(within(linha).getByRole('button', { name: /Fechar autocadastro/i })).toBeTruthy();
  });
});

describe('o botão chama a rota que já existe', () => {
  it('abrir envia open: true e avisa o que mudou', async () => {
    api.organizations.setSelfRegistration.mockResolvedValue({ id: 'o1', selfRegistrationOpen: true });
    const linha = await abrirTela(false);

    fireEvent.click(within(linha).getByRole('button', { name: /Abrir autocadastro/i }));

    await waitFor(() => expect(api.organizations.setSelfRegistration).toHaveBeenCalledWith('o1', true));
    // O aviso diz a CONSEQUÊNCIA, não só "salvo": abrir torna as filiações
    // descobríveis por qualquer visitante.
    await waitFor(() => expect(notificacoes[0]?.texto).toMatch(/filiações/i));
    expect(notificacoes[0].tom).not.toBe('erro');
  });

  it('fechar envia open: false', async () => {
    api.organizations.setSelfRegistration.mockResolvedValue({ id: 'o1', selfRegistrationOpen: false });
    const linha = await abrirTela(true);

    fireEvent.click(within(linha).getByRole('button', { name: /Fechar autocadastro/i }));

    await waitFor(() => expect(api.organizations.setSelfRegistration).toHaveBeenCalledWith('o1', false));
  });

  it('a recusa do servidor aparece como erro, e o estado não muda sozinho', async () => {
    api.organizations.setSelfRegistration.mockRejectedValue(new Error('Sem permissão nesta organização'));
    const linha = await abrirTela(false);

    fireEvent.click(within(linha).getByRole('button', { name: /Abrir autocadastro/i }));

    await waitFor(() => expect(notificacoes[0]?.tom).toBe('erro'));
    expect(notificacoes[0].texto).toMatch(/Sem permissão/);
    // A tela continua dizendo FECHADO: ela não presume sucesso.
    expect(within(linha).getByText(/Autocadastro fechado/i)).toBeTruthy();
  });
});

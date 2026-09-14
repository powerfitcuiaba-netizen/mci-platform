import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// AUDITORIA — o último lugar onde o "total" era o tamanho da página.
//
// A tela não exibia esse número, o que mascarava o defeito. Agora exibe — e
// por isso passa a ser testável: se o total voltar a ser o da página, a frase
// na tela fica errada e este teste cai.
//
// O outro ponto: a trilha não pode terminar no fim da primeira página. Quem
// audita procura o que aconteceu, não o que coube.
// ==========================================================================

const api = { audit: vi.fn() };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminAuditoria } = await import('./adminPlatform');

const linha = i => ({
  id: `log-${i}`,
  action: 'REGISTRATION_CREATE',
  entity: 'Registration',
  entityId: `reg-${i}`,
  metadata: { indice: i },
  createdAt: new Date(Date.now() - i * 1000).toISOString(),
  userEmail: `operador${i}@mci.test`,
  user: { id: `u${i}`, name: `Operador ${i}`, role: 'EVENT_DIRECTOR' }
});

const pagina = (inicio, quantos) => Array.from({ length: quantos }, (_, i) => linha(inicio + i));

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.audit.mockReset();
});
afterEach(cleanup);

describe('o total é da trilha, não da página', () => {
  it('a tela diz "200 de 1430", e não "200 de 200"', async () => {
    api.audit.mockResolvedValue({ items: pagina(0, 200), total: 1430, nextCursor: 'log-199' });
    render(<AdminAuditoria />);
    expect(await screen.findByText(/Mostrando 200 de 1430 registro/i)).toBeTruthy();
  });

  it('trilha curta não ganha botão de continuar', async () => {
    api.audit.mockResolvedValue({ items: pagina(0, 3), total: 3, nextCursor: null });
    render(<AdminAuditoria />);
    await screen.findByText(/Mostrando 3 de 3 registro/i);
    expect(screen.queryByRole('button', { name: /Carregar mais/i })).toBeNull();
  });
});

describe('a trilha continua depois da primeira página', () => {
  it('"Carregar mais" traz o registro seguinte e mantém o anterior', async () => {
    api.audit
      .mockResolvedValueOnce({ items: pagina(0, 200), total: 260, nextCursor: 'log-199' })
      .mockResolvedValue({ items: pagina(200, 60), total: 260, nextCursor: null });

    render(<AdminAuditoria />);
    await screen.findByText('reg-0'.replace('reg-', 'Operador '));
    expect(screen.queryByText('Operador 200'), 'a página 2 apareceu antes de ser pedida').toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Carregar mais/i }));
    expect(await screen.findByText('Operador 200')).toBeTruthy();
    // A página nova EMENDA: o que já estava continua na tela.
    expect(screen.getByText('Operador 0')).toBeTruthy();
    expect(api.audit.mock.calls.at(-1)[0].cursor).toBe('log-199');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Carregar mais/i })).toBeNull());
  });

  it('trocar o filtro ZERA a trilha — não emenda ação de outro filtro', async () => {
    api.audit
      .mockResolvedValueOnce({ items: pagina(0, 200), total: 260, nextCursor: 'log-199' })
      .mockResolvedValue({ items: [linha(900)], total: 1, nextCursor: null });

    render(<AdminAuditoria />);
    await screen.findByText('Operador 0');

    fireEvent.change(screen.getByLabelText(/Filtrar por ação/i), { target: { value: 'OVERALL_DECLARE' } });
    expect(await screen.findByText('Operador 900')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Operador 0'), 'sobrou registro do filtro anterior').toBeNull());
    expect(screen.getByText(/Mostrando 1 de 1 registro/i)).toBeTruthy();
  });
});

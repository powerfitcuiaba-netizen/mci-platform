import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// B5–B6 — O OPERADOR PRECISA SABER ONDE ESTÁ PUBLICANDO.
//
// A revisão mostrava totais, linhas e situações — e nenhuma palavra sobre o
// EVENTO. Quem aperta "Aplicar" estava confirmando um destino que a tela nunca
// nomeou. Com duas etapas de nomes parecidos no mesmo calendário, publicar na
// errada é um erro silencioso: os pontos entram, o ranking muda, e nada acusa.
//
// O evento tem de aparecer DUAS vezes: na prévia, enquanto ainda dá para
// voltar atrás; e na confirmação, no instante da decisão irreversível.
// ==========================================================================

const api = { muscleWar: { preview: vi.fn(), apply: vi.fn(), link: vi.fn() }, athletes: { list: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { RevisarImportacao } = await import('./adminPlatform');

const EVENTO = {
  id: 'ev1', name: 'Etapa Ipiranga', slug: 'etapa-ipiranga',
  startDate: '2026-09-12T12:00:00.000Z', city: 'São Paulo', state: 'SP'
};

const previaCom = (evento = EVENTO) => ({
  import: { id: 'imp1', organizationId: 'org1', status: 'PENDING', eventId: evento?.id ?? null, event: evento },
  summary: { totalRecords: 3, recognized: 3, valid: 3, pending: 0, conflicts: 0, duplicates: 0, rejected: 0, applied: 0 },
  page: { total: 3, hasMore: false },
  items: [{
    id: 'it1', rowNumber: 1, matchStatus: 'MATCHED', athleteName: 'Yuri Santinelli',
    memberNumber: '88281', className: "Men's Bodybuilding - Open", placing: 1, points: 5
  }]
});

beforeEach(() => {
  vi.clearAllMocks();
  api.muscleWar.preview.mockResolvedValue(previaCom());
  api.muscleWar.apply.mockResolvedValue({ applied: 3, skippedAsDuplicate: 0 });
  api.athletes.list.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

const abrir = () => render(
  <RevisarImportacao importId="imp1" notificar={vi.fn()} onClose={vi.fn()} onMudou={vi.fn()} />
);

describe('B5 — o evento aparece na prévia, antes da aprovação', () => {
  it('a revisão nomeia o evento com data e cidade', async () => {
    abrir();
    expect(await screen.findByText(/Etapa Ipiranga/)).toBeTruthy();
    expect(screen.getByText(/12\/09\/2026/)).toBeTruthy();
    expect(screen.getByText(/São Paulo\/SP/)).toBeTruthy();
  });

  it('lote sem evento diz isso em voz alta, em vez de calar', async () => {
    api.muscleWar.preview.mockResolvedValue(previaCom(null));
    abrir();
    // Esperar direto pelo aviso: `/Registros/i` casaria com o rótulo da
    // métrica E com o "Mostrando X de Y registros" do rodapé da tabela.
    expect(await screen.findByText(/^Sem evento$/i)).toBeTruthy();
    expect(screen.getByText(/sem etapa/i)).toBeTruthy();
  });
});

describe('B6 — a confirmação diz o destino da publicação', () => {
  it('o diálogo de aprovação nomeia o evento', async () => {
    const usuario = userEvent.setup();
    abrir();
    await usuario.click(await screen.findByRole('button', { name: /aplicar 3 resultado/i }));

    const dialogo = await screen.findByRole('dialog', { name: /aplicar importação/i });
    expect(dialogo.textContent).toMatch(/Etapa Ipiranga/);
    expect(dialogo.textContent).toMatch(/12\/09\/2026/);
  });

  it('sem evento, a confirmação avisa que o resultado ficará sem etapa', async () => {
    api.muscleWar.preview.mockResolvedValue(previaCom(null));
    const usuario = userEvent.setup();
    abrir();
    await usuario.click(await screen.findByRole('button', { name: /aplicar 3 resultado/i }));

    const dialogo = await screen.findByRole('dialog', { name: /aplicar importação/i });
    expect(dialogo.textContent).toMatch(/sem evento/i);
  });
});

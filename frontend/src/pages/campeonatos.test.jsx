import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// A tela de Campeonatos precisa alcançar TODAS as etapas.
//
// Ela carregava 24 e filtrava no cliente. Com as 47 da temporada 2026, 23
// ficavam inalcançáveis e a busca dizia "Nenhum campeonato encontrado" para
// uma etapa que existia — porque procurava apenas dentro das 24 carregadas.
// ==========================================================================

const chamadas = vi.hoisted(() => ({ events: null }));

vi.mock('../services/api', () => {
  const events = vi.fn(({ cursor, search } = {}) => {
    if (search) return Promise.resolve({ items: [etapa('Mercosul', '2026-12-12')], nextCursor: null });
    if (cursor) return Promise.resolve({ items: [etapa('Mercosul', '2026-12-12')], nextCursor: null });
    return Promise.resolve({ items: [etapa('Ipiranga', '2026-09-12')], nextCursor: 'pagina-2' });
  });
  chamadas.events = events;
  return { default: { publicApi: { events } } };
});

function etapa(nome, dia) {
  return {
    id: nome, name: nome, slug: `${nome.toLowerCase()}-2026`, status: 'PLANNED',
    startDate: `${dia}T12:00:00.000Z`, endDate: `${dia}T12:00:00.000Z`,
    description: null, city: null, state: null, venue: null, _count: { registrations: 0 }
  };
}

const { Campeonatos } = await import('./publicPages');

afterEach(() => { cleanup(); chamadas.events.mockClear(); });

describe('tela de Campeonatos', () => {
  it('oferece "Carregar mais" quando o servidor diz que há mais, e traz as etapas seguintes', async () => {
    render(<Campeonatos navegar={() => {}} />);
    await waitFor(() => expect(screen.getByText('Ipiranga')).toBeTruthy());
    expect(screen.queryByText('Mercosul')).toBeNull();

    const botao = await screen.findByRole('button', { name: /Carregar mais/i });
    await userEvent.click(botao);

    await waitFor(() => expect(screen.getByText('Mercosul')).toBeTruthy());
    // A primeira página continua na tela: "carregar mais" acumula, não troca.
    expect(screen.getByText('Ipiranga')).toBeTruthy();
    expect(chamadas.events).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'pagina-2' }));
  });

  it('a busca vai para o servidor — e não filtra só o que já estava na tela', async () => {
    render(<Campeonatos navegar={() => {}} />);
    await waitFor(() => expect(screen.getByText('Ipiranga')).toBeTruthy());

    await userEvent.type(screen.getByLabelText('Buscar campeonato'), 'Mercosul');

    // Mercosul NÃO está entre as etapas carregadas: só aparece se a busca for
    // ao servidor. Filtrando no cliente, a tela diria "nenhum encontrado".
    await waitFor(() => expect(screen.getByText('Mercosul')).toBeTruthy(), { timeout: 4000 });
    expect(chamadas.events).toHaveBeenCalledWith(expect.objectContaining({ search: 'Mercosul' }));
  });
});

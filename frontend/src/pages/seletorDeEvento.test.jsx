import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const listarEventos = vi.fn();
vi.mock('../services/api', () => ({
  default: { events: { list: (...a) => listarEventos(...a) } },
  api: { events: { list: (...a) => listarEventos(...a) } },
  refreshData: vi.fn(),
  fetchMediaObjectUrl: vi.fn(() => Promise.reject(new Error('sem mídia'))),
  releaseMediaObjectUrl: vi.fn()
}));

const { SeletorDeEvento } = await import('./adminEvent');

beforeEach(() => listarEventos.mockReset());
afterEach(cleanup);

// ==========================================================================
// O seletor de evento é a porta de TODAS as telas operacionais: inscrições,
// check-in, pesagem, credenciamento, palco e resultados.
//
// Quando a busca falha, ele ficava exatamente igual a "não há evento nenhum":
// uma caixa com "Selecione o evento…" e mais nada. No dia do campeonato isso é
// o pior desfecho — o operador conclui que o evento sumiu do sistema, quando o
// que caiu foi a rede.
// ==========================================================================
describe('SeletorDeEvento', () => {
  it('lista os eventos quando a busca funciona', async () => {
    listarEventos.mockResolvedValue({ items: [{ id: 'e1', name: 'Etapa Cuiabá', status: 'IN_OPERATION' }] });
    render(<SeletorDeEvento eventId="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Etapa Cuiabá/)).toBeInTheDocument());
  });

  it('diz que a lista não pôde ser carregada, em vez de parecer vazia', async () => {
    listarEventos.mockRejectedValueOnce(new Error('Não foi possível conectar à API.'))
      .mockResolvedValue({ items: [] });
    render(<SeletorDeEvento eventId="" onChange={() => {}} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/não foi possível|falhou|carregar/i);
  });

  it('o seletor fica desabilitado quando a lista falhou: escolher ali não significaria nada', async () => {
    listarEventos.mockRejectedValueOnce(new Error('rede')).mockResolvedValue({ items: [] });
    render(<SeletorDeEvento eventId="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Selecionar evento')).toBeDisabled());
  });

  it('oferece nova tentativa, e ela refaz a busca', async () => {
    listarEventos.mockRejectedValueOnce(new Error('rede'))
      .mockResolvedValue({ items: [{ id: 'e9', name: 'Etapa Recuperada', status: 'IN_OPERATION' }] });

    render(<SeletorDeEvento eventId="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /tentar de novo/i }));
    await waitFor(() => expect(screen.getByText(/Etapa Recuperada/)).toBeInTheDocument());
  });

  it('lista realmente vazia continua dizendo que está vazia, e não que falhou', async () => {
    listarEventos.mockResolvedValue({ items: [] });
    render(<SeletorDeEvento eventId="" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Selecionar evento')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

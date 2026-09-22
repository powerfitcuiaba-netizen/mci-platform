import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// EDITAR PONTOS — O MODAL PRECISA DIZER ONDE O OPERADOR ESTÁ MEXENDO.
//
// Quem vai mudar um número de pontuação não vê mais a linha da tabela: o
// modal a cobre. Se ele não repetir atleta, categoria, classe, campeonato,
// temporada e colocação, o operador decide no escuro — e o erro que ele comete
// não é de julgamento, é de linha.
//
// A confirmação é explícita ("5 → 4", com a diferença) pela mesma razão: um
// número sozinho não denuncia dígito trocado.
//
// E `expectedPoints` viaja no envio. É o valor que estava na tela: o servidor
// recusa se outro operador tiver alterado nesse meio-tempo, em vez de gravar
// por cima de uma decisão que ninguém viu.
// ==========================================================================

const api = {
  ranking: {
    eventPoints: vi.fn(), adjustPoint: vi.fn(), previewPoint: vi.fn(),
    editPoint: vi.fn(), voidPoint: vi.fn(), restorePoint: vi.fn()
  },
  events: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminLancamentos } = await import('./adminLancamentos');

const EVENTO = {
  id: 'ev1', name: 'Ipiranga', startDate: '2026-09-12T12:00:00.000Z',
  season: { id: 's1', name: 'Temporada 2026', year: 2026 }
};

// O caso que importa: histórico importado, SEM cadastro de atleta.
const PONTO = {
  id: 'rp1', placing: 1, didNotShow: false,
  placementPoints: 5, overallBonus: 0, adjustmentPoints: 0, points: 5,
  athlete: null,
  externalAthlete: { id: 'x1', displayName: 'QA COMPETIDORA UM' },
  category: { id: 'c1', code: 'WOMENS_PHYSIQUE', name: "Women's Physique" },
  competitionClass: null,
  catalogClass: { id: 'cl1', code: 'MASTERS_35', name: 'Masters 35+', displayName: 'Masters 35+' },
  voidedAt: null
};

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.ranking)) fn.mockReset();
  api.events.list.mockResolvedValue({ items: [EVENTO] });
  api.ranking.eventPoints.mockResolvedValue({ event: EVENTO, items: [PONTO] });
  api.ranking.adjustPoint.mockResolvedValue({ id: 'rp1', points: 4, diferenca: -1 });
});

afterEach(() => cleanup());

async function abrirOModal() {
  render(<AdminLancamentos notificar={vi.fn()} />);
  const seletor = await screen.findByRole('combobox');
  await userEvent.selectOptions(seletor, 'ev1');
  const botao = await screen.findByRole('button', { name: /editar pontos/i });
  await userEvent.click(botao);
  return screen.findByRole('dialog');
}

describe('a linha mostra o competidor mesmo sem cadastro', () => {
  it('nome da identidade externa e classe do catálogo aparecem na tabela', async () => {
    render(<AdminLancamentos notificar={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'ev1');

    // Resultado histórico importado não tem `athlete`. Mostrar "—" aqui
    // deixaria a tela inutilizável justamente no caso que ela atende.
    expect(await screen.findByText('QA COMPETIDORA UM')).toBeTruthy();
    // E a classe vem do catálogo: `competitionClass` é nula sem evento do MCI.
    expect(screen.getByText('Masters 35+')).toBeTruthy();
  });
});

describe('o modal de editar pontos', () => {
  it('repete o contexto inteiro antes do campo editável', async () => {
    const dialogo = await abrirOModal();

    for (const texto of ['QA COMPETIDORA UM', "Women's Physique", 'Masters 35+', 'Ipiranga', 'Temporada 2026']) {
      expect(dialogo.textContent, texto).toContain(texto);
    }
    // Colocação e pontos atuais, que são o que está prestes a mudar.
    expect(dialogo.textContent).toContain('Pontos atuais');
  });

  it('só confirma com motivo e com valor diferente do atual', async () => {
    await abrirOModal();
    const confirmar = screen.getByRole('button', { name: /confirmar ajuste/i });

    // Nada mudou ainda: o botão não pode estar disponível.
    expect(confirmar.disabled).toBe(true);

    await userEvent.clear(screen.getByLabelText(/novo valor/i));
    await userEvent.type(screen.getByLabelText(/novo valor/i), '4');
    // Valor mudou, motivo ainda não: continua bloqueado.
    expect(confirmar.disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/motivo da alteração/i), 'Correção de homologação');
    await waitFor(() => expect(confirmar.disabled).toBe(false));
  });

  it('mostra a confirmação 5 → 4 com a diferença', async () => {
    const dialogo = await abrirOModal();

    await userEvent.clear(screen.getByLabelText(/novo valor/i));
    await userEvent.type(screen.getByLabelText(/novo valor/i), '4');

    await waitFor(() => expect(dialogo.textContent).toContain('5 → 4'));
    expect(dialogo.textContent).toContain('-1');
  });

  it('envia o valor, o motivo e o total que estava na tela', async () => {
    await abrirOModal();

    await userEvent.clear(screen.getByLabelText(/novo valor/i));
    await userEvent.type(screen.getByLabelText(/novo valor/i), '4');
    await userEvent.type(screen.getByLabelText(/motivo da alteração/i), 'Correção de homologação');
    await userEvent.click(screen.getByRole('button', { name: /confirmar ajuste/i }));

    await waitFor(() => expect(api.ranking.adjustPoint).toHaveBeenCalled());
    expect(api.ranking.adjustPoint).toHaveBeenCalledWith('rp1', {
      points: 4,
      // A GUARDA DE CONCORRÊNCIA: o total que o operador tinha na tela.
      expectedPoints: 5,
      reason: 'Correção de homologação'
    });
  });

  it('o duplo clique não manda dois ajustes', async () => {
    // Uma promessa que não resolve: é assim que se observa o estado "enviando".
    api.ranking.adjustPoint.mockImplementation(() => new Promise(() => {}));
    await abrirOModal();

    await userEvent.clear(screen.getByLabelText(/novo valor/i));
    await userEvent.type(screen.getByLabelText(/novo valor/i), '4');
    await userEvent.type(screen.getByLabelText(/motivo da alteração/i), 'Correção de homologação');

    const confirmar = screen.getByRole('button', { name: /confirmar ajuste/i });
    await userEvent.click(confirmar);
    await userEvent.click(confirmar);

    expect(api.ranking.adjustPoint).toHaveBeenCalledTimes(1);
  });

  it('a recusa por concorrência é mostrada ao operador, e a tela não finge sucesso', async () => {
    const notificar = vi.fn();
    api.ranking.adjustPoint.mockRejectedValue(
      new Error('Os pontos foram alterados por outro operador. Atualize antes de editar novamente.')
    );

    render(<AdminLancamentos notificar={notificar} />);
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'ev1');
    await userEvent.click(await screen.findByRole('button', { name: /editar pontos/i }));

    await userEvent.clear(screen.getByLabelText(/novo valor/i));
    await userEvent.type(screen.getByLabelText(/novo valor/i), '4');
    await userEvent.type(screen.getByLabelText(/motivo da alteração/i), 'Correção de homologação');
    await userEvent.click(screen.getByRole('button', { name: /confirmar ajuste/i }));

    await waitFor(() => expect(notificar).toHaveBeenCalledWith(
      expect.objectContaining({ tom: 'perigo', texto: expect.stringContaining('outro operador') })
    ));
    // O modal continua aberto: quem falhou precisa ver o que falhou.
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

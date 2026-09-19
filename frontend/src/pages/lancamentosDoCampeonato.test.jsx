import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// LANÇAMENTOS DO CAMPEONATO — corrigir e invalidar resultado já publicado.
//
// O que esta tela não pode fazer, e cada teste tranca uma porta:
//
//   * aceitar pontuação digitada. O operador informa COLOCAÇÃO ou NS, e quem
//     calcula é o servidor. Um campo de pontos aqui recriaria, na tela, a
//     porta que a importação fechou ao recusar a coluna de pontos do arquivo;
//   * gravar com um clique só, ou sem mostrar o impacto;
//   * gravar sem motivo;
//   * sumir com a linha invalidada — ela fica, marcada, com o motivo à vista;
//   * oferecer "Corrigir" no que está invalidado, ou "Restaurar" no que está
//     valendo.
// ==========================================================================

const api = {
  events: { list: vi.fn() },
  ranking: {
    eventPoints: vi.fn(),
    previewPoint: vi.fn(),
    editPoint: vi.fn(),
    voidPoint: vi.fn(),
    restorePoint: vi.fn()
  }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminLancamentos } = await import('./adminLancamentos');

// `notificar` REAL do projeto: (texto, tom). Um espião que aceita qualquer
// coisa já deixou passar uma chamada com OBJETO, que derrubava a aplicação
// inteira com React error #31. Este cobra a assinatura.
const notificacoes = [];
const notificar = (texto, tom) => {
  if (typeof texto !== 'string') throw new TypeError(`notificar espera texto, recebeu ${typeof texto}`);
  notificacoes.push({ texto, tom });
};

const EVENTO = {
  id: 'ev1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba',
  startDate: '2026-11-20T12:00:00.000Z', seasonId: 's1'
};

const ponto = (extras = {}) => ({
  id: 'rp1', placing: 3, placingOriginal: null, didNotShow: false,
  placementPoints: 3, overallBonus: 0, points: 3,
  superOverallPoints: 3, superOverallEligible: true, isOverallChampion: false,
  source: 'MUSCLEWAR', externalResultId: 'er1',
  voidedAt: null, voidedById: null, voidReason: null,
  athlete: { id: 'at1', fullName: 'JOANA SILVA', affiliationNumber: '88281' },
  category: { id: 'c1', code: 'BIKINI', name: 'Bikini' },
  competitionClass: { id: 'cl1', code: 'OPEN', name: 'Open' },
  affiliation: { id: 'a1', code: 'NPC-MT', name: 'NPC Mato Grosso' },
  ...extras
});

const PREVIA = {
  atual: { placing: 3, didNotShow: false, placementPoints: 3, overallBonus: 0, points: 3, voided: false },
  novo: { placing: 2, didNotShow: false, placementPoints: 4, overallBonus: 0, points: 4, voided: false },
  diferenca: 1,
  athlete: { id: 'at1', fullName: 'JOANA SILVA' }
};

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of [api.events.list, api.ranking.eventPoints, api.ranking.previewPoint, api.ranking.editPoint, api.ranking.voidPoint, api.ranking.restorePoint]) fn.mockReset();
  api.events.list.mockResolvedValue({ items: [{ id: 'ev1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba', startDate: EVENTO.startDate, status: 'RESULTS_PUBLISHED' }], nextCursor: null });
  api.ranking.previewPoint.mockResolvedValue(PREVIA);
});
afterEach(cleanup);

const abrir = async items => {
  api.ranking.eventPoints.mockResolvedValue({ event: EVENTO, items });
  notificacoes.length = 0;
  render(<AdminLancamentos notificar={notificar} />);

  const seletor = await screen.findByLabelText(/selecionar evento/i);
  await waitFor(() => expect(within(seletor).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(seletor, { target: { value: 'ev1' } });
  await waitFor(() => expect(api.ranking.eventPoints).toHaveBeenCalledWith('ev1'));
};

const preencher = (rotulo, valor) => {
  const campo = screen.getByLabelText(new RegExp(rotulo, 'i'));
  fireEvent.change(campo, { target: { value: valor } });
};

describe('a lista de lançamentos', () => {
  it('mostra o lançamento com colocação, pontos e situação', async () => {
    await abrir([ponto()]);
    expect(await screen.findByText('JOANA SILVA')).toBeTruthy();
    expect(screen.getByText(/Matrícula 88281/)).toBeTruthy();
    expect(screen.getByText('Válido')).toBeTruthy();
  });

  it('o invalidado CONTINUA na lista, marcado e com o motivo à vista', async () => {
    await abrir([ponto({ voidedAt: '2026-11-21T10:00:00.000Z', voidReason: 'atleta desclassificado', points: 0 })]);

    // Some da lista seria o pior desfecho: a etapa desapareceria do histórico
    // do atleta e ninguém teria como restaurá-la.
    expect(await screen.findByText('JOANA SILVA')).toBeTruthy();
    expect(screen.getByText('Invalidado')).toBeTruthy();
    expect(screen.getByText('atleta desclassificado')).toBeTruthy();
  });

  it('oferece Corrigir/Invalidar no válido e só Restaurar no invalidado', async () => {
    await abrir([ponto()]);
    expect(await screen.findByRole('button', { name: /corrigir/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /invalidar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /restaurar/i })).toBeNull();

    cleanup();
    await abrir([ponto({ voidedAt: '2026-11-21T10:00:00.000Z', voidReason: 'desclassificado', points: 0 })]);
    expect(await screen.findByRole('button', { name: /restaurar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^corrigir/i })).toBeNull();
  });
});

describe('corrigir', () => {
  const abrirCorrecao = async () => {
    await abrir([ponto()]);
    fireEvent.click(await screen.findByRole('button', { name: /corrigir/i }));
    await screen.findByRole('dialog');
  };

  it('não existe campo de pontos: quem calcula é o servidor', async () => {
    await abrirCorrecao();
    const dialogo = screen.getByRole('dialog');
    // A tela pede COLOCAÇÃO. Um campo de pontos aqui deixaria o operador
    // digitar 999 e o ranking publicaria o que ele digitou.
    expect(within(dialogo).getByLabelText(/colocação/i)).toBeTruthy();
    expect(within(dialogo).queryByLabelText(/^pontos$/i)).toBeNull();
  });

  it('mostra a conta aberta antes de gravar', async () => {
    await abrirCorrecao();
    preencher('colocação', '2');

    await waitFor(() => expect(api.ranking.previewPoint).toHaveBeenCalledWith('rp1', { placing: 2 }));
    const dialogo = screen.getByRole('dialog');
    expect(await within(dialogo).findByText('3º')).toBeTruthy();
    expect(within(dialogo).getByText('2º')).toBeTruthy();
    expect(within(dialogo).getByText('+1')).toBeTruthy();
    // A prévia não grava nada.
    expect(api.ranking.editPoint).not.toHaveBeenCalled();
  });

  it('sem motivo, o botão de confirmar não grava', async () => {
    await abrirCorrecao();
    preencher('colocação', '2');

    const confirmar = screen.getByRole('button', { name: /confirmar correção/i });
    expect(confirmar.disabled).toBe(true);
    fireEvent.click(confirmar);
    expect(api.ranking.editPoint).not.toHaveBeenCalled();
  });

  it('com colocação e motivo, grava a correção e recarrega a lista', async () => {
    await abrirCorrecao();
    preencher('colocação', '2');
    preencher('motivo da correção', 'sumula oficial corrigida');
    api.ranking.editPoint.mockResolvedValue({ id: 'rp1' });

    fireEvent.click(screen.getByRole('button', { name: /confirmar correção/i }));
    await waitFor(() => expect(api.ranking.editPoint).toHaveBeenCalledWith('rp1', {
      placing: 2, reason: 'sumula oficial corrigida'
    }));
    await waitFor(() => expect(api.ranking.eventPoints).toHaveBeenCalledTimes(2));
    expect(notificacoes.at(-1).texto).toMatch(/corrigido/i);
  });

  it('marcar NS troca a colocação pela ausência', async () => {
    await abrirCorrecao();
    fireEvent.click(screen.getByLabelText(/não subiu ao palco/i));

    await waitFor(() => expect(api.ranking.previewPoint).toHaveBeenCalledWith('rp1', { didNotShow: true }));
    // Sem colocação a informar: NS vale zero por regra, e pedir um número
    // junto convidaria a contradição "não compareceu em 3º".
    expect(screen.queryByLabelText(/colocação/i)).toBeNull();
  });
});

describe('invalidar e restaurar', () => {
  it('o diálogo diz que a participação NÃO é apagada', async () => {
    await abrir([ponto()]);
    fireEvent.click(await screen.findByRole('button', { name: /invalidar/i }));

    const dialogo = await screen.findByRole('dialog');
    // Sem esta frase o operador supõe que está apagando e escolhe errado.
    expect(within(dialogo).getByText(/NÃO é apagada/i)).toBeTruthy();
  });

  it('sem motivo não invalida; com motivo, invalida', async () => {
    await abrir([ponto()]);
    fireEvent.click(await screen.findByRole('button', { name: /invalidar/i }));
    await screen.findByRole('dialog');

    const confirmar = screen.getByRole('button', { name: /invalidar lançamento/i });
    expect(confirmar.disabled).toBe(true);

    preencher('motivo da invalidação', 'atleta desclassificado');
    api.ranking.voidPoint.mockResolvedValue({ id: 'rp1' });
    fireEvent.click(screen.getByRole('button', { name: /invalidar lançamento/i }));

    await waitFor(() => expect(api.ranking.voidPoint).toHaveBeenCalledWith('rp1', {
      reason: 'atleta desclassificado'
    }));
  });

  it('restaurar mostra por que foi invalidado e exige motivo próprio', async () => {
    await abrir([ponto({ voidedAt: '2026-11-21T10:00:00.000Z', voidReason: 'desclassificado por doping', points: 0 })]);
    fireEvent.click(await screen.findByRole('button', { name: /restaurar/i }));

    const dialogo = await screen.findByRole('dialog');
    // O motivo ORIGINAL fica à vista: restaurar sem saber por que foi
    // invalidado é decidir no escuro.
    expect(within(dialogo).getByText(/desclassificado por doping/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /restaurar lançamento/i }).disabled).toBe(true);

    preencher('motivo da restauração', 'decisao revertida pela comissao');
    api.ranking.restorePoint.mockResolvedValue({ id: 'rp1' });
    fireEvent.click(screen.getByRole('button', { name: /restaurar lançamento/i }));

    await waitFor(() => expect(api.ranking.restorePoint).toHaveBeenCalledWith('rp1', {
      reason: 'decisao revertida pela comissao'
    }));
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// O AVISO DO RECALCULAR DIZ O QUE ACONTECEU.
//
// Antes, os três desfechos saíam com a mesma frase — "Ranking recalculado: N
// linha(s)" —, e N contava LINHAS DO AGREGADO, não lançamentos. O operador
// que clicava não conseguia distinguir:
//
//   * a tabela alcançou o histórico e corrigiu N lançamentos;
//   * estava tudo certo e nada mudou;
//   * NÃO HAVIA TABELA, e por isso nada foi escrito.
//
// O terceiro é o que mais importa: nada ter sido escrito ali é PROTEÇÃO —
// zerar o histórico por causa de uma configuração ausente seria destruir o
// que já existe. Um aviso ambíguo transformaria a proteção em mistério.
// ==========================================================================

const api = {
  ranking: { seasons: vi.fn(), recompute: vi.fn(), setPointsRules: vi.fn(), conferirPontuacao: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminRanking } = await import('./adminPlatform');

const notificacoes = [];
const notificar = (texto, tom) => {
  if (typeof texto !== 'string') throw new TypeError(`notificar espera texto, recebeu ${typeof texto}`);
  notificacoes.push({ texto, tom });
};

const TEMPORADA = {
  id: 's1', name: 'Temporada 2026', year: 2026, status: 'OPEN',
  organizationId: 'o1', organization: { id: 'o1', name: 'MCI Brasil' },
  _count: { events: 1, points: 191, pointsRules: 5 }
};

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.ranking)) fn.mockReset();
  api.ranking.seasons.mockResolvedValue({ items: [TEMPORADA] });
  notificacoes.length = 0;
});
afterEach(cleanup);

const recalcular = async resposta => {
  api.ranking.recompute.mockResolvedValue(resposta);
  render(<AdminRanking notificar={notificar} />);

  const linha = await screen.findByText('Temporada 2026');
  const painel = linha.closest('section');
  fireEvent.click(within(painel).getByRole('button', { name: /^recalcular$/i }));

  await waitFor(() => expect(api.ranking.recompute).toHaveBeenCalledWith('s1'));
  await waitFor(() => expect(notificacoes.length).toBeGreaterThan(0));
  return notificacoes[0];
};

describe('o aviso do recálculo', () => {
  it('diz quantos lançamentos foram corrigidos', async () => {
    const aviso = await recalcular({
      rows: 4, tieUnresolved: 0, lancamentos: 191, lancamentosAlterados: 191, semTabelaDePontos: false
    });
    expect(aviso.texto).toMatch(/191 de 191/);
    expect(aviso.tom).not.toBe('erro');
  });

  it('diz quando nada mudou, em vez de repetir "recalculado"', async () => {
    const aviso = await recalcular({
      rows: 4, tieUnresolved: 0, lancamentos: 191, lancamentosAlterados: 0, semTabelaDePontos: false
    });
    expect(aviso.texto).toMatch(/191/);
    expect(aviso.texto).toMatch(/[Nn]enhuma altera/);
    expect(aviso.tom).not.toBe('erro');
  });

  it('AVISA que não havia tabela, e que por isso nada foi escrito', async () => {
    const aviso = await recalcular({
      rows: 0, tieUnresolved: 0, lancamentos: 0, lancamentosAlterados: 0, semTabelaDePontos: true
    });
    expect(aviso.texto).toMatch(/[Ss]em tabela de pontos/);
    expect(aviso.texto).toMatch(/nada foi recalculado/i);
    // Tom de erro: é uma configuração faltando, não um trabalho concluído.
    expect(aviso.tom).toBe('erro');
  });
});

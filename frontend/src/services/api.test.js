import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.restoreAllMocks());

function mockResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

describe('serviço da API', () => {
  it('centraliza criação, edição e exclusão de campeonato', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => mockResponse({ id: 't1' }, 201))
      .mockImplementationOnce(() => mockResponse({ id: 't1', name: 'Copa atualizada' }))
      .mockImplementationOnce(() => mockResponse(null, 204));
    await api.tournaments.create({ name: 'Copa MCI' });
    await api.tournaments.update('t1', { name: 'Copa atualizada' });
    await api.tournaments.remove('t1');
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/campeonatos'), expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/campeonatos/t1'), expect.objectContaining({ method: 'PATCH' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, expect.stringContaining('/campeonatos/t1'), expect.objectContaining({ method: 'DELETE' }));
  });

  it('envia inscrição, resultado e classificação pela API centralizada', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(path => {
      if (path.includes('/participantes')) return mockResponse({ id: 'enroll-1' }, 201);
      if (path.includes('/resultado')) return mockResponse({ scoreA: 2, scoreB: 1 }, 201);
      return mockResponse([{ points: 3 }]);
    });
    await api.tournaments.enroll('t1', 'p1');
    await api.matches.saveResult('m1', { scoreA: 2, scoreB: 1, winnerParticipantId: 'p1' });
    const standing = await api.tournaments.standings('t1');
    expect(standing[0].points).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('transforma erro da API em mensagem utilizável pela interface', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => mockResponse({ error: { message: 'Campeonato não encontrado' } }, 404));
    await expect(api.tournaments.get('missing')).rejects.toThrow('Campeonato não encontrado');
  });
});
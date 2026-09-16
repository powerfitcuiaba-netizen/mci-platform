import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// FASE 13.16 — NENHUMA TELA PODE DAR TELA BRANCA.
//
// A API vai responder 401, 403, 404, 409, 422, 429 e 500. Vai demorar. Vai
// devolver corpo vazio, corpo pela metade e corpo com a forma errada. Nada
// disso é hipótese: é rede ruim em ginásio, sessão expirada e operador sem
// permissão.
//
// O que se prova aqui é o piso: em qualquer uma dessas respostas a tela
// RENDERIZA ALGUMA COISA — mensagem de erro, vazio explicado, o que for — e
// não some. Uma tela branca num dia de competição é pior que uma mensagem
// ruim, porque não diz nem que houve erro.
// ==========================================================================

const api = {
  me: { affiliation: vi.fn(), history: vi.fn() },
  ranking: { overallCandidates: vi.fn(), athletePoints: vi.fn() },
  events: { list: vi.fn() },
  audit: vi.fn()
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { MinhaFiliacao, MeuHistorico } = await import('./minhaCarreira');
const { AdminOverall } = await import('./adminOverall');
const { AdminAuditoria } = await import('./adminPlatform');

// As respostas hostis que a API realmente produz.
const FALHAS = [
  ['401 sessão expirada', () => Promise.reject(new Error('Autenticação obrigatória'))],
  ['403 sem permissão', () => Promise.reject(new Error('Você não tem permissão para esta operação'))],
  ['404 não encontrado', () => Promise.reject(new Error('Recurso não encontrado'))],
  ['409 conflito', () => Promise.reject(new Error('Registro já existe'))],
  ['422 regra de negócio', () => Promise.reject(new Error('Dados inválidos'))],
  ['429 excesso de requisições', () => Promise.reject(new Error('Muitas requisições'))],
  ['500 erro interno', () => Promise.reject(new Error('Erro interno do servidor'))],
  ['rede caiu', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['erro sem mensagem', () => Promise.reject(new Error(''))]
];

// As respostas MALFORMADAS — as que não falham, e por isso passam do try/catch.
const CORPOS_ESTRANHOS = [
  ['corpo nulo', null],
  ['corpo vazio', {}],
  ['items ausente', { total: 3 }],
  ['items não é lista', { items: 'nada disso' }],
  ['linha sem os campos esperados', { items: [{}], total: 1 }],
  ['números onde havia objeto', { items: [{ id: 1, event: 7, competitionClass: 9 }], total: 1 }]
];

const TELAS = [
  ['Minha filiação', () => <MinhaFiliacao />, () => api.me.affiliation],
  ['Meu histórico', () => <MeuHistorico />, () => api.me.history],
  ['Homologação do Overall', () => <AdminOverall notificar={() => {}} />, () => api.events.list],
  ['Auditoria', () => <AdminAuditoria />, () => api.audit]
];

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of [api.me.affiliation, api.me.history, api.ranking.overallCandidates, api.ranking.athletePoints, api.events.list, api.audit]) fn.mockReset();
  api.events.list.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(cleanup);

// Uma tela "de pé" tem conteúdo visível. Vazio absoluto é a tela branca.
const temConteudo = () => (document.body.textContent || '').trim().length > 0;

describe('a tela sobrevive a qualquer falha da API', () => {
  for (const [rotuloDaTela, montar, alvo] of TELAS) {
    for (const [rotuloDaFalha, falha] of FALHAS) {
      it(`${rotuloDaTela} · ${rotuloDaFalha}`, async () => {
        alvo().mockImplementation(falha);
        expect(() => render(montar())).not.toThrow();
        await waitFor(() => expect(temConteudo()).toBe(true));
      });
    }
  }
});

describe('a tela sobrevive a corpo malformado', () => {
  for (const [rotuloDaTela, montar, alvo] of TELAS) {
    for (const [rotuloDoCorpo, corpo] of CORPOS_ESTRANHOS) {
      it(`${rotuloDaTela} · ${rotuloDoCorpo}`, async () => {
        alvo().mockResolvedValue(corpo);
        expect(() => render(montar())).not.toThrow();
        await waitFor(() => expect(temConteudo()).toBe(true));
      });
    }
  }
});

describe('resposta lenta mostra carregando, e não nada', () => {
  it('Meu histórico exibe o esqueleto enquanto espera', async () => {
    let liberar;
    api.me.history.mockImplementation(() => new Promise(resolve => { liberar = resolve; }));

    render(<MeuHistorico />);
    // Antes de a promessa resolver, a tela já tem algo na frente do usuário.
    expect(temConteudo()).toBe(true);

    liberar({ items: [], total: 0, totals: { participations: 0, placementPoints: 0, overallBonus: 0, points: 0 } });
    await waitFor(() => expect(screen.getByText(/ainda não pontuou/i)).toBeTruthy());
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { api, apiRequest, setAuthToken, clearAuthToken, getAuthToken } from './api';

// O cliente de API precisa: mandar o token, propagar o código de erro do
// servidor e traduzir falha de rede em mensagem legível.

describe('cliente de API', () => {
  beforeEach(() => {
    clearAuthToken();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const responder = (corpo, ok = true, status = 200) => ({
    ok, status,
    json: async () => corpo
  });

  it('envia o token quando existe sessão', async () => {
    setAuthToken('token-de-teste');
    global.fetch.mockResolvedValue(responder({ ok: true }));

    await apiRequest('/qualquer');

    const [, opcoes] = global.fetch.mock.calls[0];
    expect(opcoes.headers.Authorization).toBe('Bearer token-de-teste');
  });

  it('não envia cabeçalho de autorização sem sessão', async () => {
    global.fetch.mockResolvedValue(responder({ ok: true }));
    await apiRequest('/publico');

    const [, opcoes] = global.fetch.mock.calls[0];
    expect(opcoes.headers.Authorization).toBeUndefined();
  });

  it('propaga código, status e detalhes do erro do servidor', async () => {
    global.fetch.mockResolvedValue(responder(
      { error: { code: 'NOT_ELIGIBLE', message: 'Atleta não elegível', details: [{ message: 'Categoria é masculina' }] } },
      false,
      422
    ));

    await expect(apiRequest('/x')).rejects.toMatchObject({
      message: 'Atleta não elegível',
      code: 'NOT_ELIGIBLE',
      status: 422
    });
  });

  it('traduz falha de rede em mensagem legível', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiRequest('/x')).rejects.toThrow('Não foi possível conectar à API.');
  });

  it('monta query string ignorando valores vazios', async () => {
    global.fetch.mockResolvedValue(responder({ items: [] }));
    await api.athletes.list({ limit: 10, search: '', proStatus: undefined, teamId: 'equipe-1' });

    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('limit=10');
    expect(url).toContain('teamId=equipe-1');
    expect(url).not.toContain('search=');
    expect(url).not.toContain('proStatus');
  });

  it('não fixa Content-Type em envio multipart', async () => {
    global.fetch.mockResolvedValue(responder({ id: 'm1' }));
    const arquivo = new File(['conteudo'], 'foto.jpg', { type: 'image/jpeg' });

    await api.social.attachMedia('post-1', arquivo);

    const [, opcoes] = global.fetch.mock.calls[0];
    // O navegador precisa montar o boundary sozinho.
    expect(opcoes.headers['Content-Type']).toBeUndefined();
    expect(opcoes.body).toBeInstanceOf(FormData);
  });

  it('guarda e limpa o token de sessão', () => {
    setAuthToken('abc');
    expect(getAuthToken()).toBe('abc');
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  it('vincular, transferir e encerrar são endpoints DIFERENTES', async () => {
    // A separação não é cosmética: cada um exige permissão distinta no
    // servidor. Se a tela mandasse tudo para o mesmo lugar, o treinador
    // transferiria atleta de outra equipe com a permissão de vincular.
    global.fetch.mockResolvedValue(responder({ id: 'v1' }));

    await api.athletes.linkTeam('atleta-1', { teamId: 'equipe-1' });
    await api.athletes.transferTeam('atleta-1', { teamId: 'equipe-2', reason: 'acordo' });
    await api.athletes.unlinkTeam('atleta-1', { reason: 'saiu' });

    const caminhos = global.fetch.mock.calls.map(([url]) => new URL(url, 'http://x').pathname);
    expect(caminhos[0]).toMatch(/\/athletes\/atleta-1\/team$/);
    expect(caminhos[1]).toMatch(/\/athletes\/atleta-1\/team\/transfer$/);
    expect(caminhos[2]).toMatch(/\/athletes\/atleta-1\/team\/unlink$/);
    expect(new Set(caminhos).size).toBe(3);
  });

  it('a mensagem de vínculo recusado chega inteira à tela', async () => {
    // O 409 nomeia a equipe atual. Se o cliente trocasse por um texto
    // genérico, o treinador ficaria sem saber a quem recorrer — que é
    // justamente a informação que a regra manda dar.
    global.fetch.mockResolvedValue(responder(
      {
        error: {
          code: 'ATHLETE_ALREADY_LINKED',
          message: 'Não é possível vincular este atleta. Ele está atualmente vinculado a Team Alpha (Empresa X). '
            + 'Para mudar de equipe, solicite a alteração ao operador da Muscle Contest.'
        }
      },
      false,
      409
    ));

    await expect(api.athletes.linkTeam('atleta-1', { teamId: 'equipe-2' })).rejects.toMatchObject({
      code: 'ATHLETE_ALREADY_LINKED',
      status: 409
    });

    await expect(api.athletes.linkTeam('atleta-1', { teamId: 'equipe-2' }))
      .rejects.toThrow(/Team Alpha.*operador da Muscle Contest/s);
  });

  it('empresa competidora e patrocinador são superfícies separadas', async () => {
    // Patrocínio é relação comercial: não vincula atleta e não pontua. Se
    // ambos caíssem na mesma rota, a separação existiria só no discurso.
    global.fetch.mockResolvedValue(responder({ items: [] }));

    await api.partners.companies({ organizationId: 'org-1' });
    await api.partners.sponsors({ organizationId: 'org-1' });

    const caminhos = global.fetch.mock.calls.map(([url]) => new URL(url, 'http://x').pathname);
    expect(caminhos[0]).toMatch(/\/companies$/);
    expect(caminhos[1]).toMatch(/\/sponsors$/);
  });

  it('campeonato e Super Overall são endpoints DIFERENTES', async () => {
    // As duas métricas não podem chegar do mesmo lugar: se a tela buscasse os
    // dois números na mesma rota, Estreante, Novice e Master sumiriam do
    // ranking do campeonato ou entrariam no anual — nos dois casos, errado.
    global.fetch.mockResolvedValue(responder({ items: [] }));

    await api.ranking.list({ seasonId: 's1' });
    await api.ranking.superOverall({ seasonId: 's1' });

    const caminhos = global.fetch.mock.calls.map(([url]) => new URL(url, 'http://x').pathname);
    expect(caminhos[0]).toMatch(/\/ranking$/);
    expect(caminhos[1]).toMatch(/\/ranking\/super-overall$/);
    expect(new Set(caminhos).size).toBe(2);
  });

  it('o cliente não carrega nenhuma tabela de pontos própria', () => {
    // Pontuação é dado do regulamento, servido pela temporada. Um valor
    // guardado no frontend vira uma segunda verdade — e foi assim que o
    // formulário chegou a sugerir 100/80/60, que não são de regulamento algum.
    const fonte = api.ranking.setPointsRules.toString() + api.ranking.list.toString();
    expect(fonte).not.toMatch(/points\s*:\s*\d+/);
  });

  it('não expõe nenhuma rota financeira', () => {
    // Nomes exatos: 'order' como substring casaria com 'stageOrder', que é
    // ordem de palco — um falso positivo que ensinaria a ignorar este teste.
    const nomes = Object.keys(api).flatMap(chave => (
      typeof api[chave] === 'object' && api[chave] !== null
        ? [chave, ...Object.keys(api[chave])]
        : [chave]
    ));

    const proibidos = /^(orders?|payments?|coupons?|refunds?|checkout|invoices?|billing|wallet|transactions?|subscriptions?)$/i;
    const ofensores = nomes.filter(nome => proibidos.test(nome));
    expect(ofensores).toHaveLength(0);

    // E nenhum caminho financeiro chega ao servidor.
    const superficie = JSON.stringify(api.toString?.() ?? '');
    expect(superficie).not.toMatch(/\/orders|\/payments|\/coupons|\/refunds/);
  });
});

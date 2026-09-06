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

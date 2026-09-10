import { describe, it, expect, beforeAll } from 'vitest';
import { app, api, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';

// Auditoria da superfície HTTP.
//
// Percorre TODA rota registrada e confere que nenhuma responde erro de
// servidor. O que se procura aqui não é regra de negócio — é rota apontando
// para controller inexistente, parâmetro trocado entre rota e controller, ou
// include inválido do Prisma: defeitos que só aparecem quando a rota é de fato
// chamada, e que um teste de fluxo feliz nunca encontra.

// Prefixos em que um router pode estar montado, do mais específico para o
// menos: o primeiro que o matcher aceitar é o prefixo real.
const PREFIXOS_POSSIVEIS = ['/api/v1', ''];

function rotasRegistradas(aplicacao) {
  const rotas = [];
  const pilha = aplicacao._router?.stack || aplicacao.router?.stack || [];

  const coletar = (camada, prefixo) => {
    if (camada.route) {
      for (const metodo of Object.keys(camada.route.methods)) {
        if (metodo === '_all') continue;
        rotas.push({ metodo: metodo.toUpperCase(), caminho: prefixo + camada.route.path });
      }
      return;
    }
    if (camada.handle?.stack) {
      // O Express 5 não expõe o caminho de montagem no layer; o que existe é o
      // matcher. Perguntar a ele em que prefixo o router responde é mais
      // honesto do que presumir a string, e continua valendo se a montagem
      // mudar.
      const casa = caminho => (camada.matchers || []).some(matcher => {
        try {
          return Boolean(matcher(caminho));
        } catch (erro) {
          return false;
        }
      });

      const base = PREFIXOS_POSSIVEIS.find(candidato => casa(`${candidato}/__sonda__`)) ?? '';
      for (const interna of camada.handle.stack) coletar(interna, prefixo + base);
    }
  };

  for (const camada of pilha) coletar(camada, '');
  return rotas;
}

// Identificadores propositalmente inexistentes: a resposta esperada é 401,
// 403, 404 ou 422 — nunca 500.
const substituirParametros = caminho => caminho
  .replace(/:membershipId\b/g, 'vinculo-inexistente')
  .replace(/:eventCategoryId\b/g, 'categoria-de-evento-inexistente')
  .replace(/:divisionId\b/g, 'divisao-inexistente')
  .replace(/:judgeId\b/g, 'juiz-inexistente')
  .replace(/:itemId\b/g, 'item-inexistente')
  .replace(/:handle\b/g, 'handle-inexistente')
  .replace(/:slug\b/g, 'slug-inexistente')
  .replace(/:id\b/g, 'id-inexistente');

let usuario;
let rotas;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();
  usuario = await criarUsuario({ name: 'Auditor de Rotas' });
  rotas = rotasRegistradas(app);
});

describe('auditoria de rotas', () => {
  it('registra a superfície esperada da API', () => {
    expect(rotas.length).toBeGreaterThan(80);

    const caminhos = rotas.map(rota => `${rota.metodo} ${rota.caminho}`);
    for (const esperada of [
      'GET /health',
      'GET /ready',
      'POST /api/v1/auth/login',
      'POST /api/v1/events/:id/registrations',
      'POST /api/v1/classes/:id/result',
      'POST /api/v1/classes/:id/result/publish',
      'POST /api/v1/musclewar/imports',
      'GET /api/v1/social/feed',
      'POST /api/v1/messenger/conversations',
      'GET /api/v1/audit'
    ]) {
      expect(caminhos, esperada).toContain(esperada);
    }
  });

  // O MCI NÃO julga. Esta trava existe para que reintroduzir apuração interna
  // por descuido quebre a suíte, e não passe despercebido.
  it('nenhuma rota de julgamento está registrada', () => {
    const julgamento = rotas.filter(rota => /\/(judging-sessions|panels|scoring-rule-sets)\b|result\/calculate/i.test(rota.caminho));
    expect(julgamento).toHaveLength(0);
  });

  it('nenhuma rota financeira está registrada', () => {
    const financeiras = rotas.filter(rota => /\/(orders|payments|coupons|refunds|checkout|invoices|billing|wallets)\b/i.test(rota.caminho));
    expect(financeiras).toHaveLength(0);
  });

  it('nenhuma rota responde erro de servidor — sem sessão', async () => {
    const problemas = [];

    for (const rota of rotas) {
      const metodo = rota.metodo.toLowerCase();
      let requisicao = api()[metodo](substituirParametros(rota.caminho));
      if (['post', 'patch', 'put'].includes(metodo)) requisicao = requisicao.send({});

      const resposta = await requisicao;
      if (resposta.status >= 500) {
        problemas.push(`${rota.metodo} ${rota.caminho} → ${resposta.status} ${JSON.stringify(resposta.body)}`);
      }
    }

    expect(problemas, problemas.join('\n')).toHaveLength(0);
  });

  it('nenhuma rota responde erro de servidor — com sessão sem privilégio', async () => {
    const problemas = [];

    for (const rota of rotas) {
      const metodo = rota.metodo.toLowerCase();
      let requisicao = api()[metodo](substituirParametros(rota.caminho)).set(usuario.auth());
      if (['post', 'patch', 'put'].includes(metodo)) requisicao = requisicao.send({});

      const resposta = await requisicao;
      if (resposta.status >= 500) {
        problemas.push(`${rota.metodo} ${rota.caminho} → ${resposta.status} ${JSON.stringify(resposta.body)}`);
      }
    }

    expect(problemas, problemas.join('\n')).toHaveLength(0);
  });

  it('toda rota protegida recusa requisição sem sessão', async () => {
    // Rotas de leitura aberta e as que servem ao visitante: o resto precisa
    // exigir autenticação.
    const abertas = [
      /^GET \/health$/, /^GET \/ready$/, /^GET \/$/,
      /^POST \/api\/v1\/auth\/(register|login)$/,
      /^GET \/api\/v1\/public\//,
      /^GET \/api\/v1\/(events|categories|ranking|seasons|brands|communities|search|partnerships)/,
      /^GET \/api\/v1\/classes\/:id\/result$/,
      /^GET \/api\/v1\/social\/(feed|posts|profiles)/,
      /^GET \/api\/v1\/media\/posts\//,
      /^GET \/api\/v1\/documents\/event\//
    ];

    const vazando = [];

    for (const rota of rotas) {
      const assinatura = `${rota.metodo} ${rota.caminho}`;
      if (abertas.some(padrao => padrao.test(assinatura))) continue;

      const metodo = rota.metodo.toLowerCase();
      let requisicao = api()[metodo](substituirParametros(rota.caminho));
      if (['post', 'patch', 'put'].includes(metodo)) requisicao = requisicao.send({});

      const resposta = await requisicao;
      // 401 é o esperado. 400/422 também servem: a validação de entrada roda
      // antes e a requisição não chega a tocar dado de ninguém.
      if (![401, 400, 422, 415].includes(resposta.status)) {
        vazando.push(`${assinatura} → ${resposta.status}`);
      }
    }

    expect(vazando, vazando.join('\n')).toHaveLength(0);
  });
});

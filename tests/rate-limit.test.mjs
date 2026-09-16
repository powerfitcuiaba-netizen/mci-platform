import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import apiRoutes from '../src/routes/index.js';
import { rateLimit, reset, identificar } from '../src/middlewares/rateLimit.js';

// ============================================================================
// Limitador de requisições — fase 12.1.
//
// Dois testes de naturezas diferentes, de propósito.
//
// O ESTRUTURAL existe porque o defeito que importa aqui não é o limitador
// errar a conta: é ele nunca ter sido ligado na rota. Isso é silencioso, não
// aparece em teste de comportamento, e foi exatamente o que aconteceu — as
// rotas de criação de conteúdo não tinham limitador nenhum, e 120 comentários
// seguidos passavam em modo produção.
//
// O COMPORTAMENTAL exercita o middleware isolado, com o limitador forçado a
// ligado: no ambiente de teste ele vem desligado, como em desenvolvimento.
// ============================================================================

function rotasComLimitador() {
  const mapa = new Map();
  for (const camada of apiRoutes.stack) {
    if (!camada.route) continue;
    const metodos = Object.keys(camada.route.methods).filter(m => m !== '_all');
    const limitadores = camada.route.stack.map(c => c.handle?.limite?.nome).filter(Boolean);
    for (const metodo of metodos) {
      mapa.set(`${metodo.toUpperCase()} ${camada.route.path}`, limitadores);
    }
  }
  return mapa;
}

describe('quais rotas estão atrás do limitador', () => {
  const mapa = rotasComLimitador();

  // Criação de conteúdo por conta autenticada: o vetor é assédio por
  // inundação, não vazamento de dado.
  const CONTEUDO = [
    'POST /social/posts',
    'POST /social/posts/:id/comments',
    'POST /social/posts/:id/share',
    'POST /social/reports'
  ];

  it.each(CONTEUDO)('%s tem limitador de conteúdo', rota => {
    expect(mapa.get(rota), `rota ${rota} não encontrada no router`).toBeTruthy();
    expect(mapa.get(rota)).toContain('conteudo');
  });

  it('o envio de mensagem tem limitador próprio, mais folgado que o de conteúdo', () => {
    expect(mapa.get('POST /messenger/conversations/:id/messages')).toContain('mensagem');
  });

  it('autenticação, upload, busca e importação seguem limitados', () => {
    expect(mapa.get('POST /auth/login')).toContain('auth');
    expect(mapa.get('POST /auth/register')).toContain('auth');
    expect(mapa.get('POST /social/posts/:id/media')).toContain('upload');
    expect(mapa.get('GET /search')).toContain('search');
    expect(mapa.get('POST /musclewar/imports')).toContain('import');
  });
});

describe('como o limitador conta', () => {
  beforeEach(() => reset());

  const requisicao = ({ userId, ip }) => ({
    user: userId ? { id: userId } : undefined,
    headers: ip ? { 'x-forwarded-for': ip } : {},
    ip: ip || '10.0.0.1',
    socket: { remoteAddress: ip || '10.0.0.1' }
  });

  const rodar = (limitador, req) => new Promise(resolve => {
    const res = { setHeader() {} };
    limitador(req, res, erro => resolve(erro ? erro.status : 200));
  });

  it('conta por CONTA quando há usuário, e não pelo endereço', async () => {
    // O caso real: wifi do ginásio, vários atletas no mesmo IP. Se a conta
    // fosse por endereço, um abusivo derrubaria o limite de todo mundo.
    const limitador = rateLimit({ windowMs: 60_000, max: 3, nome: 'teste', quandoAtivo: true });
    const MESMO_IP = '200.100.50.10';

    for (let i = 0; i < 3; i += 1) {
      expect(await rodar(limitador, requisicao({ userId: 'atleta-abusiva', ip: MESMO_IP }))).toBe(200);
    }
    expect(await rodar(limitador, requisicao({ userId: 'atleta-abusiva', ip: MESMO_IP }))).toBe(429);

    // A colega ao lado, no MESMO endereço, não foi afetada.
    expect(await rodar(limitador, requisicao({ userId: 'atleta-de-boa', ip: MESMO_IP }))).toBe(200);
  });

  it('sem usuário autenticado, conta pelo endereço — que ali é o que existe', async () => {
    const limitador = rateLimit({ windowMs: 60_000, max: 2, nome: 'anonimo', quandoAtivo: true });

    expect(await rodar(limitador, requisicao({ ip: '1.1.1.1' }))).toBe(200);
    expect(await rodar(limitador, requisicao({ ip: '1.1.1.1' }))).toBe(200);
    expect(await rodar(limitador, requisicao({ ip: '1.1.1.1' }))).toBe(429);
    expect(await rodar(limitador, requisicao({ ip: '2.2.2.2' }))).toBe(200);
  });

  it('identificador de conta não colide com endereço', () => {
    expect(identificar(requisicao({ userId: '1.1.1.1' }))).toBe('u:1.1.1.1');
    expect(identificar(requisicao({ ip: '1.1.1.1' }))).toBe('1.1.1.1');
  });

  it('desligado, não interfere em nada', async () => {
    const limitador = rateLimit({ windowMs: 60_000, max: 1, nome: 'desligado', quandoAtivo: false });
    for (let i = 0; i < 5; i += 1) {
      expect(await rodar(limitador, requisicao({ userId: 'alguem' }))).toBe(200);
    }
  });
});

// GATE FINAL — o limitador era contornável trocando um cabeçalho.
//
// `identificar` lia `headers['x-forwarded-for'].split(',')[0]`: o valor MAIS À
// ESQUERDA da cadeia, que é exatamente o pedaço que o cliente escreve e
// ninguém verifica. Medido contra a API rodando em produção: 60 tentativas de
// login, 60 aceitas, zero bloqueadas, trocando o cabeçalho a cada requisição.
// O limitador existia e não limitava nada — força bruta ilimitada.
//
// Duas correções, e as duas têm teste aqui:
//   1. a origem vem de `req.ip`, que o Express calcula a partir de
//      `trust proxy` — nunca do cabeçalho cru;
//   2. o login ganha um segundo balde, por CONTA ALVO, que sobrevive à troca
//      de endereço. É o que segura quando o `trust proxy` está mal
//      configurado, ou quando o ataque vem distribuído.
describe('o limitador não se deixa contornar por cabeçalho', () => {
  beforeEach(() => reset());

  // `req.ip` é o que o Express entrega depois de aplicar `trust proxy`. Um
  // cliente que escreve o cabeçalho não muda `req.ip` — é essa a diferença.
  const requisicao = ({ ip = '10.0.0.1', xff = null, corpo = null }) => ({
    user: undefined,
    headers: xff ? { 'x-forwarded-for': xff } : {},
    ip,
    body: corpo,
    socket: { remoteAddress: ip }
  });
  const rodar = (limitador, req) => new Promise(resolve => {
    limitador(req, { setHeader() {} }, erro => resolve(erro ? erro.status : 200));
  });

  it('trocar X-Forwarded-For a cada requisição NÃO renova a cota', async () => {
    const limitador = rateLimit({ windowMs: 60_000, max: 3, nome: 'sonda-xff', quandoAtivo: true });

    const codigos = [];
    for (let i = 0; i < 8; i += 1) {
      // Mesmo endereço real, cabeçalho diferente a cada vez.
      codigos.push(await rodar(limitador, requisicao({ ip: '10.0.0.1', xff: `203.0.113.${i + 1}` })));
    }

    // Sem a correção, os oito voltariam 200 — foi o que aconteceu na API real.
    expect(codigos.filter(c => c === 200)).toHaveLength(3);
    expect(codigos.filter(c => c === 429)).toHaveLength(5);
  });

  it('o identificador ignora o cabeçalho e usa o endereço que o Express calculou', () => {
    expect(identificar(requisicao({ ip: '10.0.0.1', xff: '203.0.113.9' }))).toBe('10.0.0.1');
  });

  it('o balde por conta segura mesmo quando cada tentativa vem de outro endereço', async () => {
    const limitador = rateLimit({
      windowMs: 60_000, max: 100, nome: 'sonda-alvo', quandoAtivo: true,
      alvo: req => String(req.body?.email || '').toLowerCase() || null,
      maxPorAlvo: 4
    });

    const codigos = [];
    for (let i = 0; i < 9; i += 1) {
      codigos.push(await rodar(limitador, requisicao({ ip: `198.51.100.${i + 1}`, corpo: { email: 'vitima@mci.test' } })));
    }

    expect(codigos.slice(0, 4).every(c => c === 200)).toBe(true);
    expect(codigos.filter(c => c === 429)).toHaveLength(5);
  });

  it('travar uma conta NÃO trava as outras — senão o limitador vira o ataque', async () => {
    const limitador = rateLimit({
      windowMs: 60_000, max: 100, nome: 'sonda-isolamento', quandoAtivo: true,
      alvo: req => String(req.body?.email || '').toLowerCase() || null,
      maxPorAlvo: 2
    });

    for (let i = 0; i < 4; i += 1) {
      await rodar(limitador, requisicao({ ip: '10.0.0.9', corpo: { email: 'atacada@mci.test' } }));
    }
    const atacada = await rodar(limitador, requisicao({ ip: '10.0.0.9', corpo: { email: 'atacada@mci.test' } }));
    const inocente = await rodar(limitador, requisicao({ ip: '10.0.0.9', corpo: { email: 'inocente@mci.test' } }));

    expect(atacada).toBe(429);
    expect(inocente).toBe(200);
  });
});

// ============================================================================
// FASE 13.15 — O LIMITADOR LIGADO, NA PILHA INTEIRA.
//
// Os testes acima medem o middleware isolado e a lista de rotas. Nenhum dos
// dois responde a pergunta que importa no dia do go-live: com a aplicação
// rodando como roda em produção, uma enxurrada de login é barrada?
//
// Isolado, o limitador pode contar certo e mesmo assim não barrar nada — foi
// literalmente o caso no gate final, quando a origem vinha do cabeçalho cru.
// A lista de rotas pode estar completa e o `config.rateLimitEnabled` vir
// desligado. As duas coisas passam despercebidas separadamente.
//
// Aqui a aplicação sobe num PROCESSO de verdade, com NODE_ENV=production e o
// limitador no padrão de produção (ligado), e apanha.
// ============================================================================

const RAIZ_DO_PROJETO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function inundar({ rota, corpo, quantas, origem = 'rotativa', ambiente = {} }) {
  const programa = `
    process.env.NODE_ENV = 'production';
    const request = require('supertest');
    const app = require(process.env.CAMINHO_DO_APP).default || require(process.env.CAMINHO_DO_APP);
    (async () => {
      const codigos = [];
      let retryAfter = null;
      for (let i = 0; i < Number(process.env.QUANTAS); i += 1) {
        const enderecoDeclarado = process.env.ORIGEM === 'fixa'
          ? '203.0.113.7'
          : '203.0.113.' + ((i % 200) + 1);
        const r = await request(app).post(process.env.ROTA)
          .set('X-Forwarded-For', enderecoDeclarado)
          .send(JSON.parse(process.env.CORPO));
        codigos.push(r.status);
        if (r.status === 429 && retryAfter === null) retryAfter = r.headers['retry-after'] ?? null;
      }
      process.stdout.write(JSON.stringify({ codigos, retryAfter }));
      process.exit(0);
    })().catch(erro => { process.stdout.write(JSON.stringify({ erro: String(erro) })); process.exit(0); });
  `;

  const saida = execFileSync(process.execPath, ['-e', programa], {
    encoding: 'utf8',
    cwd: RAIZ_DO_PROJETO,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      BCRYPT_ROUNDS: '4',
      JWT_SECRET: 'rate-limit-em-processo-segredo-com-tamanho-suficiente-0001',
      STORAGE_DIR: './uploads-test',
      CORS_ORIGINS: 'http://127.0.0.1:5173',
      CAMINHO_DO_APP: path.join(RAIZ_DO_PROJETO, 'src', 'app.js'),
      ROTA: rota,
      CORPO: JSON.stringify(corpo),
      QUANTAS: String(quantas),
      ORIGEM: origem,
      ...ambiente
    },
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(saida);
}

describe('com a aplicação em modo produção, o limitador barra de verdade', () => {
  it('de um endereço só, o balde de ORIGEM corta em 10', () => {
    const { codigos, retryAfter, erro } = inundar({
      rota: '/api/v1/auth/login',
      corpo: { email: 'vitima@mci.test', password: 'senha-errada-de-proposito' },
      quantas: 20,
      origem: 'fixa'
    });

    expect(erro, 'a sonda subiu a aplicação').toBeUndefined();
    expect(codigos.indexOf(429), `códigos: ${codigos.join(',')}`).toBe(10);

    // Retry-After não é enfeite: sem ele, quem caiu no limite não sabe quando
    // voltar, e a única estratégia que sobra é insistir.
    expect(Number(retryAfter), 'a resposta diz quando tentar de novo').toBeGreaterThan(0);
  }, 120000);

  it('trocando de endereço, quem segura é o balde por CONTA ALVO — em 20', () => {
    // MEDIDO, e o número importa.
    //
    // Em produção `trust proxy` vale 1, porque há um proxy na frente. Com um
    // único X-Forwarded-For, o valor que o Express usa como `req.ip` é o que o
    // cliente escreveu — e trocá-lo a cada tentativa RENOVA o balde de origem.
    // Isso não é defeito de configuração: é o que "um proxy na frente"
    // significa, e é exatamente por isso que existe o segundo balde.
    //
    // O que sobra, então, é 20 tentativas por 15 minutos contra UMA conta,
    // venham de onde vierem. É esse o número que protege a senha de alguém, e
    // é ele que este teste tranca.
    const { codigos } = inundar({
      rota: '/api/v1/auth/login',
      corpo: { email: 'alvo-fixo@mci.test', password: 'errada' },
      quantas: 30,
      origem: 'rotativa'
    });

    expect(codigos.indexOf(429),
      `endereço novo a cada vez: ${codigos.join(',')}`).toBe(20);
    expect(codigos.slice(20).every(c => c === 429), 'e continua barrando').toBe(true);
  }, 120000);

  it('em desenvolvimento o limitador segue desligado — e isso é deliberado', () => {
    // Não é descuido: quem desenvolve recarrega a tela dezenas de vezes por
    // minuto. O que o teste tranca é que a decisão seja do AMBIENTE, e não um
    // acidente que também valha em produção.
    const { codigos } = inundar({
      rota: '/api/v1/auth/login',
      corpo: { email: 'qualquer@mci.test', password: 'errada' },
      quantas: 15,
      ambiente: { NODE_ENV: 'development', RATE_LIMIT_ENABLED: 'false' }
    });
    expect(codigos.filter(c => c === 429), `códigos: ${codigos.join(',')}`).toHaveLength(0);
  }, 120000);
});

describe('as rotas de escrita que faltavam na lista', () => {
  const mapa = rotasComLimitador();

  // Cada uma destas estava fora do teste estrutural. Um limitador que some
  // numa refatoração de rota não aparece em nenhum teste de comportamento.
  it.each([
    ['POST /profile/password', 'auth'],
    ['POST /athletes/:id/documents', 'upload'],
    ['POST /events/:id/documents', 'upload'],
    ['POST /social/me/avatar', 'upload'],
    ['POST /social/stories', 'upload'],
    ['POST /athlete-requests/:id/photo', 'upload']
  ])('%s está atrás do limitador "%s"', (rota, nome) => {
    expect(mapa.get(rota), `rota ${rota} não encontrada no router`).toBeTruthy();
    expect(mapa.get(rota)).toContain(nome);
  });
});

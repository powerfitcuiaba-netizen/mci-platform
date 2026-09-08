import { describe, it, expect, beforeEach } from 'vitest';
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

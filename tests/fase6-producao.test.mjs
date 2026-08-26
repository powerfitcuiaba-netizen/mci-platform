import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import { validar, PLACEHOLDERS } from '../src/config/environment.js';
import logger from '../src/utils/logger.js';
import storage from '../src/services/storageService.js';
import { rateLimit, reset as resetRateLimit } from '../src/middlewares/rateLimit.js';

const api = '/api/v1';

describe('Fase 6 — produção e infraestrutura', () => {
  describe('Health e prontidão', () => {
    it('/health responde sem tocar em dependência nem expor segredo', async () => {
      const resposta = await request(app).get('/health');
      expect(resposta.status).toBe(200);
      expect(resposta.body.status).toBe('ok');
      expect(typeof resposta.body.uptimeSeconds).toBe('number');

      const payload = JSON.stringify(resposta.body);
      for (const proibido of ['JWT_SECRET', 'DATABASE_URL', 'file:', 'postgres', 'secret', 'password']) {
        expect(payload.toLowerCase(), proibido).not.toContain(proibido.toLowerCase());
      }
    });

    it('/ready confere banco e armazenamento', async () => {
      const resposta = await request(app).get('/ready');
      expect(resposta.status).toBe(200);
      expect(resposta.body.status).toBe('ready');
      expect(resposta.body.checks.database.status).toBe('ok');
      expect(resposta.body.checks.storage.status).toBe('ok');
      expect(resposta.body.checks.configuration.status).toBe('ok');
    });

    it('/ready não revela a URL do banco nem o caminho do storage', async () => {
      const resposta = await request(app).get('/ready');
      const payload = JSON.stringify(resposta.body);
      expect(payload).not.toContain('file:');
      expect(payload).not.toContain('uploads');
      // Diz o tipo, não o endereço.
      expect(resposta.body.checks.database.kind).toBeTruthy();
    });

    it('as sondas ficam fora do prefixo versionado da API', async () => {
      expect((await request(app).get(`${api}/health`)).status).toBe(404);
    });
  });

  describe('Configuração de produção', () => {
    it('em desenvolvimento não exige segredo forte', () => {
      expect(validar()).toEqual([]);
    });

    it('recusa produção com segredo de desenvolvimento, SQLite e CORS implícito', () => {
      const problemas = validar({
        isProduction: true,
        jwtSecret: 'development-secret-change-me',
        databaseKind: 'sqlite',
        corsOrigins: ['*'],
        paymentProvider: 'sandbox',
        allowSandboxPayments: false,
        paymentWebhookSecret: 'sandbox-webhook-secret'
      });

      const texto = problemas.join(' | ');
      expect(texto).toMatch(/JWT_SECRET/);
      expect(texto).toMatch(/SQLite não é adequado/);
      expect(texto).toMatch(/CORS/);
      expect(texto).toMatch(/provedor de desenvolvimento|PAYMENT_PROVIDER/);
      expect(texto).toMatch(/PAYMENT_WEBHOOK_SECRET/);
    });

    it('aceita produção corretamente configurada', () => {
      const antes = { ...process.env };
      process.env.JWT_SECRET = 'x'.repeat(48);
      process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/mci';
      process.env.CORS_ORIGINS = 'https://mci.example.com';

      const problemas = validar({
        isProduction: true,
        jwtSecret: 'x'.repeat(48),
        databaseKind: 'postgresql',
        corsOrigins: ['https://mci.example.com'],
        paymentProvider: 'stripe',
        allowSandboxPayments: false,
        paymentWebhookSecret: 'whsec_' + 'y'.repeat(40)
      });
      expect(problemas).toEqual([]);

      process.env = antes;
    });

    it('a lista de placeholders cobre os valores do .env.example', () => {
      expect(PLACEHOLDERS).toContain('change-this-secret-in-production');
      expect(PLACEHOLDERS).toContain('sandbox-webhook-secret');
    });
  });

  describe('Rate limiting', () => {
    beforeEach(() => resetRateLimit());

    it('bloqueia depois do teto e informa quando tentar de novo', async () => {
      const express = (await import('express')).default;
      const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;

      const alvo = express();
      alvo.get('/teste', rateLimit({ windowMs: 60_000, max: 3, nome: 'teste', quandoAtivo: true }), (req, res) => res.json({ ok: true }));
      alvo.use(errorHandler);

      for (let i = 0; i < 3; i += 1) {
        expect((await request(alvo).get('/teste')).status).toBe(200);
      }

      const bloqueado = await request(alvo).get('/teste');
      expect(bloqueado.status).toBe(429);
      expect(bloqueado.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(bloqueado.headers['retry-after']).toBeTruthy();
    });

    it('fica inativo quando desligado, sem afetar a suíte', async () => {
      const express = (await import('express')).default;
      const alvo = express();
      alvo.get('/livre', rateLimit({ windowMs: 60_000, max: 1, nome: 'livre', quandoAtivo: false }), (req, res) => res.json({ ok: true }));

      for (let i = 0; i < 5; i += 1) {
        expect((await request(alvo).get('/livre')).status).toBe(200);
      }
    });

    // O limitador funcionar e o limitador estar LIGADO na rota são duas coisas
    // diferentes, e só a primeira aparece num teste de comportamento. Este aqui
    // percorre o roteador e confere a tabela de limites que o README promete.
    it('está ligado em todas as rotas que a documentação promete proteger', async () => {
      const router = (await import('../src/routes/index.js')).default;

      const limitesDe = caminho => router.stack
        .filter(camada => camada.route && camada.route.path === caminho)
        .flatMap(camada => camada.route.stack)
        .map(camada => camada.handle.limite)
        .filter(Boolean);

      const caminhos = router.stack.filter(c => c.route).map(c => c.route.path);

      // Toda a vitrine pública, sem exceção: é a superfície alcançável sem
      // credencial alguma. Uma rota nova em /public sem limitador reprova aqui.
      const publicas = [...new Set(caminhos.filter(caminho => caminho.startsWith('/public')))];
      expect(publicas.length).toBeGreaterThanOrEqual(8);
      for (const caminho of publicas) {
        const limites = limitesDe(caminho);
        expect(limites.map(l => l.nome), `${caminho} sem limitador público`).toContain('public');
        expect(limites.find(l => l.nome === 'public').max).toBe(180);
      }

      // As demais faixas declaradas no README.
      for (const [caminho, nome, max] of [
        ['/auth/login', 'auth', 10],
        ['/auth/register', 'auth', 10],
        ['/documents/upload', 'upload', 30],
        ['/webhooks/payments/:provider', 'webhook', 120]
      ]) {
        const limites = limitesDe(caminho);
        expect(limites.map(l => l.nome), `${caminho} sem limitador ${nome}`).toContain(nome);
        expect(limites.find(l => l.nome === nome).max).toBe(max);
      }
    });

    it('separa a contagem por origem', async () => {
      const express = (await import('express')).default;
      const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;

      const alvo = express();
      alvo.get('/porip', rateLimit({ windowMs: 60_000, max: 1, nome: 'porip', quandoAtivo: true }), (req, res) => res.json({ ok: true }));
      alvo.use(errorHandler);

      expect((await request(alvo).get('/porip').set('x-forwarded-for', '10.0.0.1')).status).toBe(200);
      expect((await request(alvo).get('/porip').set('x-forwarded-for', '10.0.0.1')).status).toBe(429);
      // Outra origem começa do zero.
      expect((await request(alvo).get('/porip').set('x-forwarded-for', '10.0.0.2')).status).toBe(200);
    });
  });

  describe('Logging', () => {
    const espioes = [];
    afterEach(() => { espioes.forEach(e => e.mockRestore()); espioes.length = 0; });

    // A redação obrigatória só protege o que passa pelo logger. Uma chamada
    // solta a console escapa dela inteira — e não é "debug esquecido", é log
    // de produção feito por fora, que nenhuma varredura de TODO/debugger pega.
    it('nenhum código de produção escreve direto no console', async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');

      const arquivos = [];
      const varrer = dir => {
        for (const nome of readdirSync(dir)) {
          const caminho = join(dir, nome);
          if (statSync(caminho).isDirectory()) varrer(caminho);
          else if (nome.endsWith('.js') || nome.endsWith('.jsx')) arquivos.push(caminho);
        }
      };
      varrer('src');
      varrer(join('frontend', 'src'));

      const infratores = arquivos
        .filter(caminho => !caminho.includes('.test.'))
        .flatMap(caminho => readFileSync(caminho, 'utf8').split(/\r?\n/)
          .map((linha, i) => ({ caminho, numero: i + 1, linha }))
          .filter(({ linha }) => /(^|[^.\w])console\s*\./.test(linha)))
        .map(({ caminho, numero, linha }) => `${caminho}:${numero} ${linha.trim().slice(0, 70)}`);

      expect(arquivos.length).toBeGreaterThan(50);
      expect(infratores, 'use o logger estruturado em vez de console').toEqual([]);
    });

    it('redige senha, token e segredo em qualquer profundidade', () => {
      const redigido = logger.redigir({
        usuario: 'ana',
        password: 'Senha@123',
        nested: { token: 'abc.def.ghi', apiKey: 'sk_live_x', dados: { cvv: '123', cardNumber: '4111111111111111' } },
        lista: [{ secret: 'top' }]
      });

      const texto = JSON.stringify(redigido);
      expect(texto).not.toContain('Senha@123');
      expect(texto).not.toContain('abc.def.ghi');
      expect(texto).not.toContain('sk_live_x');
      expect(texto).not.toContain('4111111111111111');
      expect(texto).not.toContain('top');
      // O que não é sensível permanece legível.
      expect(redigido.usuario).toBe('ana');
      expect(redigido.password).toBe('[redigido]');
    });

    it('monta linha estruturada com nível, ambiente e contexto redigido', () => {
      const linha = logger.format('error', 'falha de teste', { rota: 'GET /x', password: 'Senha@123' });
      expect(linha.level).toBe('error');
      expect(linha.env).toBe('test');
      expect(linha.msg).toBe('falha de teste');
      expect(linha.ctx.rota).toBe('GET /x');
      expect(linha.ctx.password).toBe('[redigido]');
      expect(linha.ts).toBeTruthy();
    });

    it('fica silencioso durante os testes, sem poluir a saída', () => {
      const espiao = vi.spyOn(console, 'log').mockImplementation(() => {});
      espioes.push(espiao);
      logger.info('mensagem qualquer');
      expect(logger.nivel).toBe('silent');
      expect(espiao).not.toHaveBeenCalled();
    });
  });

  describe('Erros', () => {
    it('não devolve stack trace ao cliente', async () => {
      const resposta = await request(app).get(`${api}/campeonatos/inexistente`);
      expect(resposta.status).toBe(404);
      const payload = JSON.stringify(resposta.body);
      expect(payload).not.toContain('at ');
      expect(payload).not.toContain('node_modules');
      expect(resposta.body.error.code).toBe('TOURNAMENT_NOT_FOUND');
    });

    it('não anuncia a tecnologia do servidor', async () => {
      const resposta = await request(app).get('/health');
      expect(resposta.headers['x-powered-by']).toBeUndefined();
      // Helmet ativo.
      expect(resposta.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('Armazenamento abstraído', () => {
    it('expõe o contrato de provider e usa o local por padrão', () => {
      expect(storage.driver()).toBe('local');
      for (const metodo of ['saveBuffer', 'saveStream', 'createReadStream', 'exists', 'remove', 'stat', 'healthCheck']) {
        expect(typeof storage[metodo], metodo).toBe('function');
      }
      expect(typeof storage.registerProvider).toBe('function');
    });

    it('a chave é gerada pelo servidor e recusa caminho para fora da raiz', () => {
      const chave = storage.buildKey('torneio-1', 'application/pdf');
      expect(chave).toMatch(/^torneio-1\/[0-9a-f-]{36}\.pdf$/);

      // Escopo com travessia é sanitizado antes de virar caminho.
      expect(storage.buildKey('../../etc', 'application/pdf')).toMatch(/^etc\//);
      expect(() => storage.resolveKey('../../../etc/passwd')).toThrow();
    });

    it('responde ao health check do próprio provedor', async () => {
      expect(await storage.healthCheck()).toBe(true);
    });
  });

  describe('CORS', () => {
    it('aceita requisição sem origem (servidor a servidor)', async () => {
      const resposta = await request(app).get('/health');
      expect(resposta.status).toBe(200);
    });

    it('libera a origem configurada do frontend', async () => {
      const resposta = await request(app).get('/health').set('Origin', 'http://localhost:5173');
      expect(resposta.status).toBe(200);
      expect(resposta.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('não devolve permissão para origem desconhecida', async () => {
      const resposta = await request(app).get('/health').set('Origin', 'https://site-malicioso.example');
      expect(resposta.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('Banco', () => {
    it('responde a uma consulta simples', async () => {
      const resultado = await prisma.$queryRawUnsafe('SELECT 1 as um');
      // Consulta bruta devolve BigInt no SQLite; o que importa é a conexão responder.
      expect(Number(resultado[0].um)).toBe(1);
    });
  });
});

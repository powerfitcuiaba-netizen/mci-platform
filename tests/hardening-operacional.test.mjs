import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { api, prisma, comoAtor, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';
import { reset as resetarLimitador } from '../src/middlewares/rateLimit.js';

// ============================================================================
// ENDURECIMENTO OPERACIONAL — achados A-09 e A-10.
//
// A-09  `POST /profile/password` trocava a senha e NÃO deixava rastro. Numa
//       investigação de acesso indevido, "quando a senha desta conta mudou?"
//       não tinha resposta — e troca sem registro é indistinguível de nenhuma
//       troca. Agora a trilha é obrigatória: sem linha, sem troca.
//
// A-10  o limitador recusa com 429 ANTES de qualquer serviço rodar, então a
//       rajada que ele barra era invisível para a trilha. É o evento que quem
//       investiga procura: 200 tentativas barradas não aparecem em
//       `LOGIN_FAILED`. Agora a PRIMEIRA recusa de cada balde em cada janela
//       grava uma linha — uma só, para a defesa não alimentar o ataque.
//
// A falha de auditoria é forçada por um GATILHO no banco que levanta exceção no
// INSERT de `AuditLog`: a recusa vem do mesmo lugar de onde viria uma
// indisponibilidade real. Nenhuma política é afrouxada, removida ou recriada.
// ============================================================================

// A MESMA senha que `criarUsuario` usa no cadastro: o helper não recebe senha,
// e inventar outra aqui faria o teste medir um cadastro que não existe.
const SENHA = 'senha-de-teste-123';
const SENHA_NOVA = 'outra-senha-de-teste-456';

const GATILHO = 'mci_teste_trilha_indisponivel_operacional';

async function bloquearTrilha() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${GATILHO}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION 'trilha de auditoria indisponivel (simulado pelo teste)'; END
    $fn$`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${GATILHO} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${GATILHO}()`
  );
}

async function liberarTrilha() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${GATILHO} ON "AuditLog"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${GATILHO}()`);
}

const trilhaDe = (admin, where) => comoAtor(admin, tx => tx.auditLog.findMany({
  where, orderBy: { createdAt: 'asc' }
}));

beforeAll(async () => {
  await limparBanco();
  garantirCatalogo();
});

// Rede de segurança dupla: o gatilho não pode vazar para o caso seguinte, e o
// limitador não pode levar contagem de um caso para o outro.
afterEach(async () => {
  await liberarTrilha();
  resetarLimitador();
});

// ---------------------------------------------------------------------- A-09
describe('A-09: a troca de senha entra na trilha, e sem trilha não há troca', () => {
  it('trocar a senha grava PASSWORD_CHANGE, com autor e sem nenhum segredo', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta Da Senha' });

    const troca = await api().post('/api/v1/profile/password').set(pessoa.auth())
      .send({ currentPassword: SENHA, newPassword: SENHA_NOVA });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);

    const linhas = await trilhaDe(admin, { action: 'PASSWORD_CHANGE', entityId: pessoa.id });
    expect(linhas, 'a troca de senha precisa estar na trilha').toHaveLength(1);

    const linha = linhas[0];
    expect(linha.userId, 'o autor da troca é o dono da conta').toBe(pessoa.id);
    expect(linha.entity).toBe('User');

    // NENHUM SEGREDO NA LINHA: nem senha, nem antiga, nem hash, nem comprimento.
    const texto = JSON.stringify(linha);
    expect(texto).not.toContain(SENHA);
    expect(texto).not.toContain(SENHA_NOVA);
    expect(texto).not.toContain('$2a$');
    expect(texto).not.toContain('$2b$');
    expect(texto.toLowerCase()).not.toContain('passwordhash');

    // E a senha realmente mudou: a nova entra, a antiga não.
    expect((await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: SENHA_NOVA })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: SENHA })).status).toBe(401);
  });

  it('sem trilha, a senha NÃO muda — a operação é recusada inteira', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta Do Fail Closed' });

    await bloquearTrilha();
    const troca = await api().post('/api/v1/profile/password').set(pessoa.auth())
      .send({ currentPassword: SENHA, newPassword: SENHA_NOVA });
    await liberarTrilha();

    expect(troca.status, JSON.stringify(troca.body)).toBe(503);
    // O CÓDIGO NÃO SAI, e isso é decisão do `errorHandler`: resposta 5xx não
    // publica a taxonomia interna (`AUDIT_UNAVAILABLE` fica no log). O que se
    // mede aqui é o status e a mensagem — que não entrega o desenho do banco.
    expect(troca.body.error.code).toBe('INTERNAL_ERROR');
    expect(troca.body.error.message).toMatch(/Tente novamente/i);
    expect(troca.body.error.message).not.toMatch(/policy|row-level|AuditLog|trigger|auditoria/i);

    // A SENHA ANTIGA CONTINUA VALENDO: a transação da requisição voltou atrás.
    expect((await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: SENHA })).status)
      .toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: SENHA_NOVA })).status)
      .toBe(401);
  });

  it('senha atual errada continua recusando com 401, e não troca nada', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta Da Recusa' });

    const troca = await api().post('/api/v1/profile/password').set(pessoa.auth())
      .send({ currentPassword: 'nao-e-a-minha-senha', newPassword: SENHA_NOVA });
    expect(troca.status).toBe(401);
    expect(troca.body.error.code).toBe('INVALID_CREDENTIALS');

    expect((await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: SENHA })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------- A-10
//
// O limitador só conta quando `RATE_LIMIT_ENABLED` está ligado — em teste ele
// vem desligado de propósito, senão a suíte inteira se limitaria. Aqui o
// middleware é construído À MÃO com `quandoAtivo: true`, montado num app
// mínimo: é o MESMO código de produção, só ligado.
describe('A-10: o 429 da porta de entrada entra na trilha, uma vez por janela', () => {
  it('a primeira recusa grava RATE_LIMIT_BLOCK; as seguintes, nenhuma linha nova', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora Do Teto' });

    const express = (await import('express')).default;
    const { rateLimit } = await import('../src/middlewares/rateLimit.js');
    const errorHandler = (await import('../src/middlewares/errorHandler.js')).default;
    const request = (await import('supertest')).default;

    const limite = rateLimit({
      windowMs: 60_000, max: 2, nome: 'auth-teste', quandoAtivo: true, auditar: true,
      alvo: req => String(req.body?.email || '').trim().toLowerCase() || null
    });
    const app = express();
    app.use(express.json());
    app.post('/entrar', limite, (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const bater = () => request(app).post('/entrar').send({ email: 'alvo@exemplo.org', password: 'x' });

    expect((await bater()).status).toBe(200);
    expect((await bater()).status).toBe(200);

    const primeira = await bater();
    expect(primeira.status, 'o teto de 2 recusa a terceira').toBe(429);
    expect(primeira.headers['retry-after'], 'a recusa diz quando tentar de novo').toBeTruthy();

    // A linha chega de forma assíncrona, de propósito: a recusa não espera a
    // trilha. Esperar aqui é esperar o efeito, não inventar tempo.
    await vi.waitFor(async () => {
      expect(await trilhaDe(admin, { action: 'RATE_LIMIT_BLOCK' })).toHaveLength(1);
    }, { timeout: 4000 });

    const linha = (await trilhaDe(admin, { action: 'RATE_LIMIT_BLOCK' }))[0];
    expect(linha.userId, 'quem esbarra no teto é desconhecido por definição').toBeNull();
    expect(linha.entity).toBe('RateLimit');
    expect(linha.metadata.limitador).toBe('auth-teste');
    expect(linha.metadata.escopo).toBe('origem');
    expect(linha.metadata.teto).toBe(2);

    // O ALVO NÃO ENTRA NA LINHA: guardá-lo faria da trilha uma lista de contas
    // sondadas, e essa é a informação que um atacante gostaria de plantar lá.
    expect(JSON.stringify(linha)).not.toContain('alvo@exemplo.org');

    // MAIS BLOQUEIOS, NENHUMA LINHA NOVA. É o que impede a defesa de alimentar o
    // ataque: sem isto, manter a rajada encheria a tabela de propósito.
    for (let i = 0; i < 6; i += 1) expect((await bater()).status).toBe(429);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await trilhaDe(admin, { action: 'RATE_LIMIT_BLOCK' }),
      'uma linha por janela, e não uma por requisição barrada').toHaveLength(1);
  });

  it('o limitador desligado não grava nada, e não recusa nada', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora Sem Teto' });

    const express = (await import('express')).default;
    const { rateLimit } = await import('../src/middlewares/rateLimit.js');
    const request = (await import('supertest')).default;

    const app = express();
    app.use(express.json());
    app.post('/entrar', rateLimit({ max: 1, nome: 'desligado', quandoAtivo: false, auditar: true }),
      (_req, res) => res.json({ ok: true }));

    const antes = (await trilhaDe(admin, { action: 'RATE_LIMIT_BLOCK' })).length;
    for (let i = 0; i < 5; i += 1) expect((await request(app).post('/entrar').send({})).status).toBe(200);
    // DELTA, e não contagem absoluta: o banco é limpo uma vez por arquivo, e um
    // teste que depende da ordem dos casos reprova por motivo inventado.
    expect((await trilhaDe(admin, { action: 'RATE_LIMIT_BLOCK' })).length).toBe(antes);
  });
});

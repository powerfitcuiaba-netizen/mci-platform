import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Caminho derivado da posição DESTE arquivo, nunca escrito à mão. A primeira
// versão embutiu /home/user/mci-platform/... — o diretório desta máquina de
// desenvolvimento. Passava aqui e os cinco testes reprovavam na CI com
// MODULE_NOT_FOUND, porque lá o repositório fica em /home/runner/work/...
// Teste que só passa numa máquina não testa o código, testa a máquina.
const RAIZ = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ERROR_HANDLER = path.join(RAIZ, 'src', 'middlewares', 'errorHandler.js');

// ==========================================================================
// Em produção, um erro não tratado não pode contar como a aplicação é feita.
//
// O `errorHandler` já redige a mensagem de 500 quando `isProduction` — mas
// isso NÃO tinha teste. Comportamento de segurança sem trava é comportamento
// que alguém remove numa refatoração sem que nada acuse.
//
// O caso concreto que motivou este arquivo: uma falha do Prisma observada em
// desenvolvimento devolveu, no corpo da resposta, o caminho absoluto do
// arquivo, o número da linha e o trecho da consulta. Em desenvolvimento isso
// é útil. Publicado na internet, é o mapa da aplicação.
// ==========================================================================

const VAZAMENTO_DO_PRISMA = `
Invalid \`prisma.conversationMember.findMany()\` invocation in
/home/user/mci-platform/src/services/messengerService.js:143:55

  143   const memberships = await prisma.conversationMember.findMany(
Error occurred during query execution:
PostgresError { code: "54001", message: "stack depth limit exceeded" }
`;

// Medido num PROCESSO DE VERDADE com NODE_ENV=production, e não com um
// duplo: `config` é congelado na carga do módulo, e o handler é CommonJS —
// um mock de módulo não alcança o `require` dele. A primeira versão deste
// arquivo usou mock, mediu o ambiente de teste e reprovou por engano.
function responderEm(ambiente, erro) {
  const programa = `
    const errorHandler = require(process.env.CAMINHO_DO_HANDLER);
    const erro = Object.assign(new Error(process.env.MENSAGEM), process.env.CODIGO ? { code: process.env.CODIGO } : {});
    if (process.env.STATUS) erro.status = Number(process.env.STATUS);
    let saida = null; let st = null;
    errorHandler(erro, { method: 'GET', originalUrl: '/api/v1/x' },
      { status(s) { st = s; return this; }, json(c) { saida = c; return this; } }, () => {});
    process.stdout.write(JSON.stringify({ status: st, corpo: saida }));
  `;
  const r = execFileSync(process.execPath, ['-e', programa], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: ambiente,
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'segredo-de-teste-com-tamanho-mais-que-suficiente-para-a-guarda',
      CAMINHO_DO_HANDLER: ERROR_HANDLER,
      MENSAGEM: erro.message,
      CODIGO: erro.code || '',
      STATUS: erro.status ? String(erro.status) : ''
    }
  });
  const { status, corpo } = JSON.parse(r);
  return { status, corpo, texto: JSON.stringify(corpo) };
}

const responder = erro => responderEm('production', erro);

describe('erro de 500 em produção', () => {
  it('não devolve caminho de arquivo, linha, SQL nem nome da tabela', () => {
    const { status, texto } = responder(Object.assign(new Error(VAZAMENTO_DO_PRISMA), { code: 'P2010' }));

    expect(status).toBe(500);
    expect(texto).not.toMatch(/\/home\/|messengerService|prisma\.|conversationMember|PostgresError|54001/);
  });

  it('devolve mensagem genérica e código genérico', () => {
    const { corpo } = responder(new Error(VAZAMENTO_DO_PRISMA));
    expect(corpo.error.message).toBe('Erro interno do servidor');
    expect(corpo.error.code).toBe('INTERNAL_ERROR');
  });

  it('o CÓDIGO interno do Prisma também não sai — ele diz qual é a camada de persistência', () => {
    const { corpo } = responder(Object.assign(new Error('falha'), { code: 'P2003' }));
    expect(corpo.error.code).not.toBe('P2003');
  });

  it('erro de 4xx CONTINUA explicando o que houve — redigir tudo esconderia o que é útil', () => {
    const { status, corpo } = responder(Object.assign(new Error('CPF já cadastrado nesta organização'), { status: 409, code: 'CPF_DUPLICADO' }));
    expect(status).toBe(409);
    expect(corpo.error.code).toBe('CPF_DUPLICADO');
    expect(corpo.error.message).toBe('CPF já cadastrado nesta organização');
  });

  it('fora de produção a mensagem real aparece — senão depurar vira adivinhação', () => {
    const { corpo } = responderEm('development', new Error(VAZAMENTO_DO_PRISMA));
    expect(corpo.error.message).toContain('stack depth limit exceeded');
  });
});

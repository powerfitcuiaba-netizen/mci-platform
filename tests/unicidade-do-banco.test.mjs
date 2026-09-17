import { describe, it, expect } from 'vitest';
import { ehViolacaoDeUnicidade } from '../src/utils/errors.js';
import errorHandler from '../src/middlewares/errorHandler.js';

// ============================================================================
// FASE 13 — "JÁ EXISTE" É REGRA DE NEGÓCIO, NÃO FALHA DA APLICAÇÃO.
//
// A medição de concorrência encontrou 500 onde o certo era 409: duas
// declarações simultâneas do mesmo título Overall. Quem impedia a segunda era
// o índice ÚNICO PARCIAL criado na migration — e o Prisma não modela índice
// parcial, então a violação não chega como P2002: chega como erro
// desconhecido, com o código do PostgreSQL (23505) dentro da mensagem.
//
// Reconhecer isso estava escrito dentro do serviço, onde só um teste de
// corrida alcançava. Aqui o reconhecimento é medido DIRETO, nas duas formas em
// que a violação chega, sem depender de duas requisições se cruzarem no tempo
// certo. Corrida é teste de sistema; isto é a trava.
// ============================================================================

const doPrisma = codigo => Object.assign(new Error('Unique constraint failed'), { code: codigo });

// A forma real, colhida do log da FASE 13 quando o índice parcial disparou.
const CRU_DO_POSTGRES = `
Invalid \`prisma.eventOverallTitle.create()\` invocation:
Error occurred during query execution:
ConnectorError(... PostgresError { code: "23505", message: "duplicate key value violates unique constraint \\"EventOverallTitle_eventId_geral_key\\"", ... })
`;

describe('reconhecimento da violação de unicidade', () => {
  it('reconhece o P2002 que o Prisma mapeia', () => {
    expect(ehViolacaoDeUnicidade(doPrisma('P2002'))).toBe(true);
  });

  it('reconhece o 23505 cru do índice PARCIAL, que o Prisma não mapeia', () => {
    expect(ehViolacaoDeUnicidade(new Error(CRU_DO_POSTGRES))).toBe(true);
  });

  it('não confunde outras condições do banco com unicidade', () => {
    expect(ehViolacaoDeUnicidade(doPrisma('P2003')), 'chave estrangeira').toBe(false);
    expect(ehViolacaoDeUnicidade(doPrisma('P2025')), 'linha ausente').toBe(false);
    expect(ehViolacaoDeUnicidade(new Error('PostgresError { code: "25P02" }')), 'transação abortada').toBe(false);
    expect(ehViolacaoDeUnicidade(new Error('falha qualquer'))).toBe(false);
  });

  it('não quebra com o que não é erro', () => {
    expect(ehViolacaoDeUnicidade(null)).toBe(false);
    expect(ehViolacaoDeUnicidade(undefined)).toBe(false);
    expect(ehViolacaoDeUnicidade({})).toBe(false);
    expect(ehViolacaoDeUnicidade('23505'), 'string não é erro').toBe(false);
  });
});

// ==========================================================================
// A REDE EMBAIXO: nenhum caminho esquecido devolve 500 para uma condição que
// o banco previu. Cada serviço continua traduzindo o SEU caso com mensagem
// própria — este teste cobra que, quando ninguém traduziu, o handler traduz.
// ==========================================================================

function responder(erro) {
  let status = null; let corpo = null;
  errorHandler(
    erro,
    { method: 'POST', originalUrl: '/api/v1/events/x/overall' },
    { status(s) { status = s; return this; }, json(c) { corpo = c; return this; } },
    () => {}
  );
  return { status, corpo };
}

describe('rede global do errorHandler', () => {
  it('23505 cru vira 409, não 500', () => {
    const { status, corpo } = responder(new Error(CRU_DO_POSTGRES));
    expect(status, 'conflito, não falha da aplicação').toBe(409);
    expect(corpo.error.code).toBe('CONFLICT');
  });

  it('P2002 vira 409', () => {
    const { status, corpo } = responder(doPrisma('P2002'));
    expect(status).toBe(409);
    expect(corpo.error.code).toBe('CONFLICT');
  });

  it('P2025 vira 404', () => {
    expect(responder(doPrisma('P2025')).status).toBe(404);
  });

  it('a rede não sequestra erro que o serviço já classificou', () => {
    // 409 com código PRÓPRIO precisa chegar ao cliente como o serviço quis.
    // Se a rede passasse na frente, toda tradução de negócio viraria
    // "CONFLICT / Registro já existe" e o operador perderia a instrução.
    const doServico = Object.assign(new Error('Revogue a homologação atual antes de declarar outro campeão.'), {
      status: 409, code: 'OVERALL_ALREADY_DECLARED'
    });
    const { status, corpo } = responder(doServico);
    expect(status).toBe(409);
    expect(corpo.error.code).toBe('OVERALL_ALREADY_DECLARED');
    expect(corpo.error.message).toContain('Revogue');
  });

  it('a rede não passa na frente de quem já definiu o status', () => {
    // O caso é estreito de propósito: um erro que carrega status PRÓPRIO e,
    // por acaso, um código homônimo ao do Prisma. Sem a guarda de status, o
    // mapa atropelaria a decisão de quem levantou o erro e devolveria 409
    // onde o serviço pediu 422 — uma regra de negócio virando "registro já
    // existe" no meio do caminho.
    const classificado = Object.assign(new Error('Matrícula já usada nesta federação'), {
      status: 422, code: 'P2002'
    });
    const { status, corpo } = responder(classificado);
    expect(status, 'quem definiu o status manda').toBe(422);
    expect(corpo.error.code).toBe('P2002');
  });

  it('erro sem classificação continua 500 — a rede não mascara o que não é unicidade', () => {
    const { status, corpo } = responder(new Error('PostgresError { code: "42P01", message: "relation does not exist" }'));
    expect(status).toBe(500);
    expect(corpo.error.code).toBe('INTERNAL_ERROR');
  });
});

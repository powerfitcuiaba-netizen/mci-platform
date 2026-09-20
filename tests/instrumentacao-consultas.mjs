import { createRequire } from 'node:module';

// ============================================================================
// CONTADOR DE CONSULTAS — O ARREIO, NÃO O PRODUTO.
//
// POR QUE ISTO EXISTE
//
// "Não tem N+1" não é uma afirmação que se faça lendo o código: é um número.
// O jeito de obter esse número seria ligar `log: [{ emit: 'event' }]` no
// cliente Prisma — mas o cliente da aplicação é construído em
// `src/config/prismaPublico.js` sem essa opção, e mudar produção para poder
// medir produção é exatamente o tipo de troca que transforma o instrumento em
// parte do objeto medido.
//
// Então a instrumentação acontece AQUI, antes de a aplicação carregar: o
// construtor `PrismaClient` é envolvido, cada instância nasce emitindo evento
// de consulta, e o arreio se inscreve em todas. O código de `src/` não muda
// uma linha e não sabe que está sendo medido.
//
// POR QUE PRECISA SER O PRIMEIRO IMPORT
//
// `prismaPublico` guarda a INSTÂNCIA no topo do módulo. Depois que a
// aplicação carrega, trocar o construtor não alcança mais nada. Este módulo
// tem de ser importado antes de `helpers.mjs` — e é por isso que ele está em
// arquivo separado em vez de no corpo do teste, onde a ordem dependeria de
// alguém não reordenar os imports sem querer.
//
// ESTE ARQUIVO NÃO TEM TESTE DENTRO. Não termina em `.test.mjs` de propósito:
// `vitest.config.mjs` só coleta `tests/**/*.test.mjs`.
//
// O QUE O NÚMERO SIGNIFICA
//
// Uma ida ao banco por evento emitido, incluindo BEGIN e COMMIT. Não interessa
// o valor absoluto — interessa se ele CRESCE com a quantidade de competidores.
// Uma leitura em lote responde com o mesmo número para 1 e para 191. Um N+1
// responde com um número proporcional, e é isso que a asserção procura.
// ============================================================================

const require_ = createRequire(import.meta.url);
const modulo = require_('@prisma/client');
const Original = modulo.PrismaClient;

const consultas = [];
let ligado = false;

if (!Original.__mciInstrumentado) {
  class PrismaClientMedido extends Original {
    constructor(opcoes = {}) {
      super({ ...opcoes, log: [{ emit: 'event', level: 'query' }] });
      this.$on('query', evento => {
        if (ligado) consultas.push(evento.query);
      });
    }
  }
  PrismaClientMedido.__mciInstrumentado = true;
  Object.defineProperty(modulo, 'PrismaClient', {
    value: PrismaClientMedido, writable: true, configurable: true
  });
}

/** Zera o contador e passa a registrar. */
export function comecarAMedir() {
  consultas.length = 0;
  ligado = true;
}

/** Para de registrar e devolve o que foi executado no intervalo. */
export function pararDeMedir() {
  ligado = false;
  return consultas.slice();
}

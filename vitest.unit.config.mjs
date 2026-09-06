import { defineConfig } from 'vitest/config';

// Testes UNITÁRIOS — os que rodam sem subir banco.
//
// Separado da vitest.config.mjs porque aquela suíte é de integração: exige
// PostgreSQL e roda `prisma migrate deploy` antes. Estes aqui provam regra de
// domínio e de autorização, e precisam continuar rodando quando não há banco
// nenhum à mão.
//
// O serviço de julgamento recebe banco, repositório e auditoria por parâmetro,
// então o teste injeta dublês diretamente — sem interceptação de módulo.

export default defineConfig({
  test: {
    include: [
      'tests/motor-pontuacao.test.mjs',
      'tests/acesso-e-estados.test.mjs',
      'tests/julgamento-servico.test.mjs'
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20000
  }
});

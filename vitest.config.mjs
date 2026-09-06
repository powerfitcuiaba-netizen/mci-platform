import { defineConfig } from 'vitest/config';

// A suíte do backend é exatamente tests/. O escopo é declarado aqui para que a
// execução não dependa de filtro por substring na linha de comando.
//
// fileParallelism desligado: os testes de integração compartilham um banco
// PostgreSQL e truncam tabelas entre arquivos; em paralelo, um arquivo
// limparia dados de outro.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.agents/**', '**/.claude/**', 'frontend/**'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 60000
  }
});

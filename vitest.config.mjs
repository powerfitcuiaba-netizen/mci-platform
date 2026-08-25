import { defineConfig } from 'vitest/config';

// A suíte do backend é exatamente o diretório tests/. O escopo é declarado aqui
// para que a execução não dependa de filtro por substring na linha de comando —
// qualquer pasta do workspace com "tests" no caminho seria capturada por engano.
//
// .agents/ e .claude/ guardam ferramentas do ambiente de desenvolvimento, não do
// produto, e trazem suítes próprias: ficam explicitamente de fora.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.agents/**',
      '**/.claude/**',
      '**/skills/**',
      'frontend/**'
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20000
  }
});

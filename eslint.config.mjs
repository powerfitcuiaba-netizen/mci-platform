import js from '@eslint/js';
import globals from 'globals';

// Configuração de lint do backend.
//
// O objetivo aqui não é estilo — é defeito. As regras ligadas abaixo pegam erro
// real: promessa sem await que engole falha, variável de erro capturada e
// ignorada, comparação frouxa que aceita o que não devia. Formatação fica para
// quem quiser rodar um formatador; regra de formatação em lint só gera ruído
// que ensina a ignorar o lint inteiro.

export default [
  {
    ignores: [
      'node_modules/**',
      'frontend/**',
      'prisma/legado-sqlite/**',
      'uploads/**',
      'uploads-test/**',
      '.agents/**',
      '.claude/**'
    ]
  },

  {
    files: ['src/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,

      // Defeitos silenciosos.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-unsafe-optional-chaining': 'error',

      // Erro capturado e descartado é falha que ninguém vai ver.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Três isenções, cada uma por um motivo concreto:
      //   argsIgnorePattern `next` — o Express só reconhece um handler de erro
      //     com quatro parâmetros; remover o quarto mudaria o significado.
      //   caughtErrorsIgnorePattern — `catch (_error)` declara que o descarte é
      //     proposital, e o que não segue o padrão continua sendo erro.
      //   ignoreRestSiblings — `const { userId, ...visivel } = pedido` é como o
      //     código remove campo sensível da resposta. Proibir isso empurraria
      //     para o `delete`, que é pior: muda o objeto no lugar.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_|^next$',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true
      }],

      // console em servidor contorna o logger estruturado, que já redige senha
      // e token. Passar por fora dele é como vazamento chega em log.
      'no-console': 'error'
    }
  },

  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];

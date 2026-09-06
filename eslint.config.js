const js = require('@eslint/js');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');

// ============================================================================
// ESLint — configuração enxuta e honesta.
//
// O objetivo é pegar DEFEITO, não impor estilo. Regra de estilo que não muda
// o comportamento do programa vira ruído, e ruído ensina a ignorar o linter.
//
// O projeto é JavaScript puro e tem três ambientes distintos, cada um com
// globais e sistema de módulos próprios:
//   - backend  : CommonJS, globais do Node
//   - scripts  : ESM, globais do Node
//   - testes   : ESM, globais do Node
//   - frontend : ESM + JSX, globais do navegador
// ============================================================================

// Erros reais que o `recommended` não cobre, acrescentados de propósito.
const REGRAS_DE_DEFEITO = {
  // `==` entre tipos diferentes já causou bug de comparação de id nesta base.
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  // Promise ignorada em service é falha silenciosa: a operação parece ter
  // acontecido e não aconteceu.
  'no-async-promise-executor': 'error',
  // `allowProperties` desliga a checagem em escrita de propriedade. O alvo do
  // aviso aqui seria `req.user = ...` depois de um await: em Express o objeto
  // de requisição é por requisição e nunca é compartilhado entre tarefas
  // concorrentes, então é falso positivo. A checagem em variável continua.
  'require-atomic-updates': ['error', { allowProperties: true }],
  // Sombra de variável em callback aninhado esconde qual valor está em uso.
  'no-shadow-restricted-names': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  'no-constant-binary-expression': 'error',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'warn',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  // Argumento não usado costuma indicar assinatura que mudou e ficou para
  // trás. O prefixo `_` marca o descarte deliberado.
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_|^erro$|^error$'
  }]
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'frontend/dist/**',
      'prisma/migrations/**',
      'uploads/**',
      'uploads-test/**',
      'design/**'
    ]
  },

  // ------------------------------------------------------------- backend
  {
    files: ['src/**/*.js', 'server.js', 'prisma/seed.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      ...REGRAS_DE_DEFEITO,
      // O log estruturado escreve direto no descritor; console em service é
      // depuração esquecida. A CI já recusa console.log — aqui o erro aparece
      // antes do push.
      'no-console': 'error'
    }
  },

  // O seed é um utilitário de linha de comando: relatar o que fez no stdout é
  // a interface dele, não depuração esquecida.
  {
    files: ['prisma/seed.js'],
    rules: { 'no-console': 'off' }
  },

  // ------------------------------------------------------------- scripts
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      ...REGRAS_DE_DEFEITO
    }
  },

  // -------------------------------------------------------------- testes
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      ...REGRAS_DE_DEFEITO
    }
  },

  // ------------------------------------------------------------ frontend
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...REGRAS_DE_DEFEITO,
      // Hook chamado condicionalmente ou dependência esquecida são defeitos de
      // verdade, não estilo: quebram render de forma difícil de rastrear.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // A interface fala com o usuário por toast; console é depuração.
      'no-console': 'error'
    }
  },

  // Os testes de interface rodam em jsdom e usam globais de navegador e de
  // Node ao mesmo tempo.
  {
    files: ['frontend/src/**/*.test.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    }
  }
];

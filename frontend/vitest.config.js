import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// A suíte da interface é exatamente src/. O escopo é explícito para que
// ferramentas do ambiente instaladas no workspace (.agents/, .claude/) nunca
// sejam recolhidas junto, mesmo que passem a existir dentro de frontend/.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/testSetup.js',
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.agents/**',
      '**/.claude/**',
      '**/skills/**'
    ]
  }
});

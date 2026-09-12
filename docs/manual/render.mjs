// Converte um arquivo HTML em PDF pelo Chromium, respeitando as regras @page
// da folha de estilo (é de onde saem as margens da norma).
//
// O Playwright não é dependência do projeto — este gerador é ferramenta de
// documentação, não código de produção. Informe o caminho do módulo em
// PLAYWRIGHT_MODULE se ele não estiver instalado globalmente.
import path from 'node:path';

const CAMINHOS = [
  process.env.PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/node22/lib/node_modules/playwright/index.mjs'
].filter(Boolean);

let chromium;
for (const caminho of CAMINHOS) {
  try {
    ({ chromium } = await import(caminho));
    break;
  } catch { /* tenta o próximo */ }
}
if (!chromium) {
  console.error('Playwright não encontrado. Instale-o ou aponte PLAYWRIGHT_MODULE para o módulo.');
  process.exit(2);
}

const [entrada, saida, semMargem] = process.argv.slice(2);

const navegador = await chromium.launch();
const pagina = await navegador.newPage();
await pagina.goto('file://' + path.resolve(entrada), { waitUntil: 'networkidle' });
await pagina.emulateMedia({ media: 'print' });
await pagina.pdf({
  path: saida,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  margin: semMargem === 'sem-margem'
    ? { top: '0', right: '0', bottom: '0', left: '0' }
    : { top: '3cm', right: '2cm', bottom: '2cm', left: '3cm' }
});
await navegador.close();
console.log(`${saida} gerado`);

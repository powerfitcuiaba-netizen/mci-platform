import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build');
const [total, inicio] = process.argv.slice(2).map(Number);
const paginas = Array.from({ length: total }, (_, i) => `
  <div class="folha"><span class="n">${inicio + i}</span></div>`).join('');
fs.writeFileSync(path.join(SAIDA, 'numeros.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0; }
body { margin: 0; font-family: Arial, "Liberation Sans", sans-serif; }
.folha { width: 21cm; height: 29.7cm; position: relative; break-after: page; }
.folha:last-child { break-after: auto; }
/* NBR 14724: canto superior direito, a 2 cm da borda superior, com o último
   algarismo a 2 cm da borda direita. */
.n { position: absolute; top: 2cm; right: 2cm; transform: translateY(-100%);
     font-size: 10pt; line-height: 1; }
</style></head><body>${paginas}</body></html>`);
console.log(`numeros.html: ${total} folhas a partir de ${inicio}`);

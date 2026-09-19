#!/usr/bin/env node
// ============================================================================
// A AÇÃO DESTRUTIVA APARECE NA LISTAGEM? — MEDIÇÃO NO COMPONENTE DE VERDADE.
//
// POR QUE ESTE ARREIO EXISTE
//
// `excluirImportacao.test.jsx` já tranca o comportamento da listagem em jsdom:
// rascunho oferece Excluir, lote publicado oferece Invalidar, lote invalidado
// não oferece nada, e quem não pode aplicar não recebe botão. Esses quatro
// testes passam desde que o botão nasceu — e o operador, ainda assim, abriu a
// tela e viu só [ Revisar ].
//
// A distância entre as duas coisas não estava no código: estava no AMBIENTE. O
// que ele abriu foi um build anterior ao commit do botão. jsdom não prova nada
// sobre qual build está no ar, e nenhum teste de unidade poderia — mas também
// não havia, em lugar nenhum, uma IMAGEM da listagem para comparar com a que
// ele estava vendo. Sem isso, "está implementado" é afirmação, não prova.
//
// Este script fecha essa lacuna: monta o COMPONENTE REAL (`AdminMuscleWar`,
// direto de `frontend/src/pages/adminPlatform.jsx`), com o CSS REAL, num
// Chromium REAL, e mede na imagem o que cada linha oferece. Nada é escrito à
// mão: o HTML é o que o React produz.
//
// O QUE É SUBSTITUÍDO, E SÓ ISSO
//
//   · `services/api` — só `muscleWar.list`, para devolver os lotes de QA sem
//     precisar de banco. Todo o resto do módulo é o de verdade.
//   · `AuthContext`  — para escolher QUEM está olhando a tela, que é
//     exatamente a variável em teste.
//
// A regra de quem pode (`permissoesDe`/`podeCom`), o texto dos botões, a
// condição de estado e o CSS não são substituídos por nada.
//
// USO (playwright-core e o Chromium do ambiente não são dependências do
// repositório; o script é opt-in, como `modal-na-viewport.mjs`):
//
//   npm i playwright-core
//   node scripts/qa/listagem-importacoes.mjs [pasta-de-trabalho]
//
// Os lotes são de QA. Este repositório é público: nenhum arquivo, evento ou
// nome de competidor real entra aqui. Sai com código 1 se qualquer cenário
// reprovar.
// ============================================================================

import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FRONT = resolve(RAIZ, 'frontend');
// Dentro de `frontend/` porque o Vite precisa alcançar `frontend/node_modules`
// para resolver React; `tmp/` já é ignorado pelo Git em qualquer nível.
const OBRA = resolve(FRONT, 'tmp/qa-listagem');
const SAIDA = resolve(process.env.M || process.argv[2] || resolve(RAIZ, 'tmp/qa-listagem'));

// ---------------------------------------------------------------- os lotes
// Um de cada estado que a listagem sabe desenhar, porque o botão MUDA DE
// NATUREZA com o estado e desenhar só o caso feliz esconderia justamente o
// caso em que o rótulo errado apaga resultado publicado.
const LOTES = [
  { id: 'qa-1', sourceRef: 'qa_etapa_um_resultados.csv', status: 'PENDING',
    totalRecords: 191, matchedCount: 168, pendingCount: 17, conflictCount: 6, appliedCount: 0 },
  { id: 'qa-2', sourceRef: 'qa_etapa_dois_resultados.csv', status: 'PREVIEWED',
    totalRecords: 84, matchedCount: 84, pendingCount: 0, conflictCount: 0, appliedCount: 0 },
  { id: 'qa-3', sourceRef: 'qa_etapa_tres_resultados.csv', status: 'REJECTED',
    totalRecords: 37, matchedCount: 0, pendingCount: 0, conflictCount: 37, appliedCount: 0 },
  { id: 'qa-4', sourceRef: 'qa_etapa_quatro_resultados.csv', status: 'APPLIED',
    totalRecords: 142, matchedCount: 142, pendingCount: 0, conflictCount: 0, appliedCount: 142 },
  { id: 'qa-5', sourceRef: 'qa_etapa_cinco_resultados.csv', status: 'INVALIDATED',
    totalRecords: 63, matchedCount: 63, pendingCount: 0, conflictCount: 0, appliedCount: 63 }
].map((l, i) => ({
  ...l, sourceType: 'CSV', version: 1,
  createdAt: `2026-09-1${i + 2}T14:2${i}:00.000Z`,
  createdBy: { id: 'qa-op', name: 'QA OPERADOR' },
  season: { id: 'qa-s', name: 'Temporada QA 2026', year: 2026 },
  event: { id: `qa-e${i}`, name: `QA Etapa ${i + 1}` }
}));

// Quem olha. O primeiro é o caso do operador que abriu o chamado; o segundo
// existe para a tela provar que ela ESCONDE, e não que ela nunca escondeu.
const OLHARES = [
  { chave: 'admin', user: { id: 'qa-u1', role: 'ADMIN', organizations: [] },
    esperaAcao: true, titulo: 'ADMIN' },
  { chave: 'ranking', user: { id: 'qa-u2', role: 'ATHLETE', organizations: [{ role: 'RANKING_MANAGER' }] },
    esperaAcao: true, titulo: 'RANKING_MANAGER (por vínculo de organização)' },
  { chave: 'juiz', user: { id: 'qa-u3', role: 'JUDGE', organizations: [{ role: 'JUDGE' }] },
    esperaAcao: false, titulo: 'JUDGE — não pode aplicar' }
];

// O que CADA linha tem de oferecer. É a tabela de verdade da tela, e é ela
// que a imagem tem de confirmar.
// Os cinco estados são os do enum `ImportStatus` do schema, e não rótulos
// inventados para a medição: PENDING, PREVIEWED, REJECTED, APPLIED,
// INVALIDATED. Um estado fora do enum mediria uma tela que não existe.
const ESPERADO = {
  'qa-1': { revisar: true, destrutiva: 'Excluir' },
  'qa-2': { revisar: true, destrutiva: 'Excluir' },
  'qa-3': { revisar: true, destrutiva: 'Excluir' },
  'qa-4': { revisar: true, destrutiva: 'Invalidar' },
  'qa-5': { revisar: true, destrutiva: null }
};

// ------------------------------------------------------------------ a obra
rmSync(OBRA, { recursive: true, force: true });
mkdirSync(OBRA, { recursive: true });
mkdirSync(SAIDA, { recursive: true });

const API_REAL = resolve(FRONT, 'src/services/api.js');

writeFileSync(resolve(OBRA, 'stub-api.js'), `
// Só \`muscleWar.list\` é trocado. O resto do módulo é o de verdade.
export * from ${JSON.stringify(API_REAL)};
import real from ${JSON.stringify(API_REAL)};
export const api = {
  ...real,
  muscleWar: { ...real.muscleWar, list: async () => ({ items: window.__QA_LOTES, total: window.__QA_LOTES.length }) }
};
export default api;
`);

writeFileSync(resolve(OBRA, 'stub-auth.jsx'), `
// Quem está olhando a tela é a variável em teste; o resto do contexto não é
// usado pela listagem.
export const useAuth = () => ({ user: window.__QA_USUARIO, authenticated: true, loading: false });
export function AuthProvider({ children }) { return children; }
export default null;
`);

writeFileSync(resolve(OBRA, 'entrada.jsx'), `
import { createRoot } from 'react-dom/client';
import { AdminMuscleWar } from ${JSON.stringify(resolve(FRONT, 'src/pages/adminPlatform.jsx'))};
import ${JSON.stringify(resolve(FRONT, 'src/styles.css'))};

createRoot(document.getElementById('raiz')).render(<AdminMuscleWar notificar={() => {}} />);
`);

writeFileSync(resolve(OBRA, 'index.html'), `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA — listagem de importações MuscleWare</title>
<script>
  // Só os lotes moram aqui. QUEM OLHA entra por \`addInitScript\`, antes da
  // página: escrever o usuário neste script também fazia ele sobrescrever a
  // escolha do arreio, e os três cenários mediam o mesmo ADMIN — a primeira
  // execução acusou isso como "o juiz vê o botão", que era falso.
  window.__QA_LOTES = ${JSON.stringify(LOTES)};
</script>
</head><body><div id="raiz"></div><script type="module" src="./entrada.jsx"></script></body></html>
`);

writeFileSync(resolve(OBRA, 'vite.qa.config.mjs'), `
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const alvo = (fim) => (fonte) => new RegExp(fim).test(fonte);
const ehApi = alvo('(^|/)services/api(\\\\.js)?$');
const ehAuth = alvo('(^|/)AuthContext(\\\\.jsx)?$');

export default defineConfig({
  root: ${JSON.stringify(OBRA)},
  base: './',
  plugins: [
    // A troca acontece na RESOLUÇÃO, não por alias de caminho relativo: o
    // mesmo módulo é importado de profundidades diferentes da árvore, e um
    // alias textual pegaria umas e deixaria outras passar.
    { name: 'qa-troca-dois-modulos',
      enforce: 'pre',
      resolveId(fonte, importador) {
        // O próprio substituto importa o módulo de verdade para reexportar o
        // que não muda. Sem esta saída ele se resolveria para si mesmo, e o
        // build morria com MISSING_EXPORT — foi assim que este arreio
        // falhou na primeira execução.
        if (importador && importador.includes('/tmp/qa-listagem/')) return null;
        if (ehApi(fonte)) return ${JSON.stringify(resolve(OBRA, 'stub-api.js'))};
        if (ehAuth(fonte)) return ${JSON.stringify(resolve(OBRA, 'stub-auth.jsx'))};
        return null;
      } },
    react()
  ],
  build: { outDir: ${JSON.stringify(resolve(OBRA, 'dist'))}, emptyOutDir: true }
});
`);

execFileSync('npx', ['vite', 'build', '--config', resolve(OBRA, 'vite.qa.config.mjs')],
  { cwd: FRONT, stdio: 'inherit' });

// ------------------------------------------------------------- o servidor
// O build é um módulo ES, e módulo ES sobre `file://` é bloqueado pela
// política de origem do Chromium — a primeira execução carregou uma página em
// branco por isso, sem nenhum erro no build. Serve-se por HTTP em 127.0.0.1:
// a porta não sai da máquina e morre junto com o script.
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const DIST = resolve(OBRA, 'dist');

const servidor = createServer((req, res) => {
  const pedido = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let caminho = join(DIST, pedido === '/' ? 'index.html' : pedido);
  if (!caminho.startsWith(DIST) || !existsSync(caminho) || statSync(caminho).isDirectory()) {
    caminho = join(DIST, 'index.html');
  }
  res.writeHead(200, { 'content-type': TIPOS[extname(caminho)] || 'application/octet-stream' });
  createReadStream(caminho).pipe(res);
});
await new Promise(pronto => servidor.listen(0, '127.0.0.1', pronto));
const ENDERECO = `http://127.0.0.1:${servidor.address().port}/`;

// --------------------------------------------------------------- a medição
const navegador = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const linhas = [];
let reprovou = false;

for (const olhar of OLHARES) {
  const pagina = await navegador.newPage({ viewport: { width: 1440, height: 900 } });
  await pagina.addInitScript(u => { window.__QA_USUARIO = u; }, olhar.user);
  await pagina.goto(ENDERECO);
  await pagina.waitForSelector('.table tbody tr', { timeout: 15000 });
  await pagina.waitForTimeout(200);

  const medido = await pagina.evaluate(() => [...document.querySelectorAll('.table tbody tr')].map(tr => {
    const botoes = [...tr.querySelectorAll('.acoes-da-linha button')];
    const r = e => e.getBoundingClientRect();
    return {
      arquivo: tr.querySelector('strong')?.textContent ?? '',
      estado: tr.querySelector('.badge')?.textContent ?? tr.children[1]?.textContent ?? '',
      // VISÍVEL, não "existe no DOM": botão de largura zero ou fora da tela é
      // a mesma coisa que botão ausente para quem está operando.
      botoes: botoes.filter(b => r(b).width > 0 && r(b).height > 0
        && r(b).right <= innerWidth + 1 && r(b).bottom <= innerHeight + 1)
        .map(b => b.textContent.trim())
    };
  }));

  for (const l of medido) {
    const id = Object.keys(ESPERADO).find(k => l.arquivo.includes(k.replace('qa-', 'qa_')))
      ?? Object.keys(ESPERADO)[medido.indexOf(l)];
    const quer = ESPERADO[id];
    const temRevisar = l.botoes.some(t => /Revisar/i.test(t));
    const destrutiva = l.botoes.find(t => /Excluir|Invalidar/i.test(t)) ?? null;
    const querDestrutiva = olhar.esperaAcao ? quer.destrutiva : null;
    const ok = temRevisar === quer.revisar
      && (querDestrutiva === null ? destrutiva === null : destrutiva === querDestrutiva);
    if (!ok) reprovou = true;
    linhas.push(`${ok ? 'PASS' : 'FALHA'} ${olhar.chave.padEnd(8)} ${l.arquivo.padEnd(32)}`
      + ` ${String(l.estado).padEnd(12)} | botoes: ${l.botoes.join(' + ') || '(nenhum)'}`
      + ` | esperado: Revisar${querDestrutiva ? ' + ' + querDestrutiva : ''}`);
  }

  await pagina.screenshot({ path: `${SAIDA}/listagem-${olhar.chave}.png`, fullPage: true });
  await pagina.close();
}

await navegador.close();
servidor.close();
console.log('\n' + linhas.join('\n'));
console.log(`\n(capturas em ${SAIDA})`);
console.log(reprovou ? '\nRESULTADO: REPROVOU' : '\nRESULTADO: A AÇÃO APARECE ONDE DEVE E SOME ONDE DEVE');
process.exit(reprovou ? 1 : 0);

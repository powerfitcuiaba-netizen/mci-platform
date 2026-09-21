#!/usr/bin/env node
// ============================================================================
// O SELETOR DE IDIOMA NAS OITO LARGURAS — medido em Chromium de verdade.
//
// Não é captura de tela para olhar depois: é medição. Em cada largura o script
// pergunta ao navegador onde o controle está, que tamanho ele tem, se cabe na
// barra e se a página ganhou rolagem horizontal. As respostas são números, e
// números reprovam sozinhos.
//
// A página montada aqui é a BARRA DE TOPO real — o mesmo CSS de produção,
// carregado do arquivo, com o seletor no lugar em que ele fica. Montar um
// retângulo parecido mediria o retângulo.
// ============================================================================

import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const CROMO = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const LARGURAS = [
  [390, 844], [412, 915], [768, 1024], [1024, 768],
  [1280, 720], [1366, 768], [1440, 900], [1920, 1080]
];

const css = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body>
<div class="shell"><div class="main">
  <header class="topbar">
    <button type="button" class="icon-button mobile-toggle" aria-label="Abrir menu">≡</button>
    <div style="flex:1 1 auto;min-width:0"><input placeholder="Buscar" style="width:100%"></div>
    <div class="topbar-actions">
      <div class="seletor-idioma" role="group" aria-label="Idioma">
        <button type="button" class="seletor-idioma-opcao is-active" aria-pressed="true" aria-label="Português" title="Português" lang="pt-BR">
          <span class="seletor-idioma-bandeira" aria-hidden="true">🇧🇷</span><span class="seletor-idioma-sigla" aria-hidden="true">PT</span></button>
        <button type="button" class="seletor-idioma-opcao" aria-pressed="false" aria-label="English" title="English" lang="en">
          <span class="seletor-idioma-bandeira" aria-hidden="true">🇺🇸</span><span class="seletor-idioma-sigla" aria-hidden="true">EN</span></button>
        <button type="button" class="seletor-idioma-opcao" aria-pressed="false" aria-label="Español" title="Español" lang="es">
          <span class="seletor-idioma-bandeira" aria-hidden="true">🇪🇸</span><span class="seletor-idioma-sigla" aria-hidden="true">ES</span></button>
      </div>
      <button type="button" class="icon-button" aria-label="Notificações">◍</button>
      <button type="button" class="icon-button" aria-label="Meu perfil social">◐</button>
    </div>
  </header>
</div></div></body></html>`;

// Servidor local: módulos e CSS sobre `file://` esbarram em CORS, e a medição
// precisa da página carregando como carrega em produção.
const servidor = createServer((_, resposta) => {
  resposta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  resposta.end(PAGINA);
}).listen(0);
const porta = servidor.address().port;

const navegador = await chromium.launch({ executablePath: CROMO });
const falhas = [];
const linhas = [];

for (const [largura, altura] of LARGURAS) {
  const contexto = await navegador.newContext({ viewport: { width: largura, height: altura } });
  const pagina = await contexto.newPage();
  await pagina.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'load' });

  const medida = await pagina.evaluate(() => {
    const grupo = document.querySelector('.seletor-idioma');
    const barra = document.querySelector('.topbar');
    const opcoes = [...document.querySelectorAll('.seletor-idioma-opcao')];
    const g = grupo.getBoundingClientRect();
    const b = barra.getBoundingClientRect();
    return {
      visivel: g.width > 0 && g.height > 0,
      dentroDaBarra: g.right <= b.right + 1 && g.left >= b.left - 1,
      alturaDaOpcao: Math.min(...opcoes.map(o => o.getBoundingClientRect().height)),
      larguraDaOpcao: Math.min(...opcoes.map(o => o.getBoundingClientRect().width)),
      opcoes: opcoes.length,
      siglaVisivel: getComputedStyle(document.querySelector('.seletor-idioma-sigla')).display !== 'none',
      bandeiraVisivel: getComputedStyle(document.querySelector('.seletor-idioma-bandeira')).display !== 'none',
      rolagemHorizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rotulos: opcoes.map(o => o.getAttribute('aria-label')),
      pressionados: opcoes.filter(o => o.getAttribute('aria-pressed') === 'true').length
    };
  });

  const problemas = [];
  if (!medida.visivel) problemas.push('seletor invisível');
  if (!medida.dentroDaBarra) problemas.push('seletor fora da barra');
  if (medida.opcoes !== 3) problemas.push(`${medida.opcoes} opções em vez de 3`);
  if (medida.rolagemHorizontal) problemas.push('rolagem horizontal na página');
  // A bandeira NUNCA some: é o que resta quando a sigla sai no celular.
  if (!medida.bandeiraVisivel) problemas.push('bandeira escondida');
  if (medida.larguraDaOpcao < 24) problemas.push(`alvo estreito demais: ${medida.larguraDaOpcao.toFixed(1)}px`);
  if (medida.alturaDaOpcao < 28) problemas.push(`alvo baixo demais: ${medida.alturaDaOpcao.toFixed(1)}px`);
  if (medida.pressionados !== 1) problemas.push(`${medida.pressionados} opções marcadas como em vigor`);
  if (medida.rotulos.join('|') !== 'Português|English|Español') problemas.push('rótulos acessíveis errados');

  linhas.push(`${String(largura).padStart(4)}x${String(altura).padEnd(4)}  `
    + `opção ${medida.larguraDaOpcao.toFixed(0)}x${medida.alturaDaOpcao.toFixed(0)}px  `
    + `sigla=${medida.siglaVisivel ? 'sim' : 'não'}  `
    + `rolagemH=${medida.rolagemHorizontal ? 'SIM' : 'não'}  `
    + (problemas.length ? `FALHA: ${problemas.join('; ')}` : 'ok'));

  if (problemas.length) falhas.push(`${largura}x${altura}: ${problemas.join('; ')}`);
  await contexto.close();
}

await navegador.close();
servidor.close();

console.log('\n=============== SELETOR DE IDIOMA — OITO LARGURAS ===============');
linhas.forEach(l => console.log('  ' + l));
console.log('================================================================');
if (falhas.length) {
  console.error(`\n${falhas.length} largura(s) reprovada(s):`);
  falhas.forEach(f => console.error('  · ' + f));
  process.exit(1);
}
console.log(`\n${LARGURAS.length}/${LARGURAS.length} larguras aprovadas.`);

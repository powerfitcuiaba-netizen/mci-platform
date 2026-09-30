#!/usr/bin/env node
// ============================================================================
// GATE — A FOTO CABE NA TELA DO CELULAR.
//
// POR QUE ESTE GATE EXISTE, SEPARADO DO DE RESPONSIVIDADE
//
// O gate de responsividade mede rolagem horizontal do DOCUMENTO. É a medida
// certa para layout, e é cega para este defeito: uma foto de 1280px dentro de
// um corpo de modal que rola por dentro NÃO faz o documento rolar. Medido em
// Chromium antes da correção: foto de 1280x960 renderizando 1275px de largura
// numa viewport de 320px, com `document.scrollWidth` igual a 320. O gate
// aprovava, e quem estava com o celular na mão via a faixa central de uma foto
// de retrato.
//
// Então a medida aqui é outra: a BORDA DIREITA DE CADA IMAGEM contra a largura
// da viewport.
//
// O QUE ESTE GATE NÃO FAZ
//
// Não sobe a aplicação. Ele carrega o CSS CONSTRUÍDO (o mesmo arquivo que vai
// para produção) e monta as marcações onde imagem aparece, com imagem de
// dimensão real. Não precisa de banco, de sessão nem de dado semeado — e por
// isso roda em segundos e pode ser exigido em toda mudança de CSS. O gate de
// responsividade continua sendo o que prova a aplicação inteira de pé.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const DIST = arg('dist', 'frontend/dist/assets');
const LARGURAS = [320, 375, 390, 414, 430, 768];

// PNG gerado aqui, e não um arquivo versionado: o que importa é a DIMENSÃO
// declarada no cabeçalho — é dela que o navegador tira o tamanho natural, e é
// o tamanho natural que transborda.
function pngCinza(largura, altura) {
  const crc = buf => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const bloco = (tipo, dados) => {
    const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
    const tamanho = Buffer.alloc(4); tamanho.writeUInt32BE(dados.length);
    const soma = Buffer.alloc(4); soma.writeUInt32BE(crc(corpo));
    return Buffer.concat([tamanho, corpo, soma]);
  };
  const cabecalho = Buffer.alloc(13);
  cabecalho.writeUInt32BE(largura, 0);
  cabecalho.writeUInt32BE(altura, 4);
  cabecalho[8] = 8; cabecalho[9] = 2; // 8 bits, RGB
  const linhas = [];
  for (let y = 0; y < altura; y += 1) {
    linhas.push(Buffer.from([0]), Buffer.alloc(largura * 3, 128));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloco('IHDR', cabecalho),
    bloco('IDAT', deflateSync(Buffer.concat(linhas), { level: 6 })),
    bloco('IEND', Buffer.alloc(0))
  ]);
}

const cssConstruido = () => {
  const arquivos = readdirSync(DIST).filter(n => n.endsWith('.css'));
  if (!arquivos.length) throw new Error(`nenhum .css em ${DIST} — rode o build do frontend primeiro`);
  return arquivos.map(n => readFileSync(join(DIST, n), 'utf8')).join('\n');
};

// AS MARCAÇÕES. Cada uma é a de uma tela real, copiada da estrutura que o
// componente produz — inclusive o `<figure style="margin:0">` do visualizador
// de story, que foi onde o defeito apareceu.
const CENAS = [
  {
    nome: 'visualizador de story (modal + figure, imagem sem classe)',
    html: retrato => `<div class="modal-layer" role="dialog"><div class="modal">
      <div class="modal-head"><h2>Story</h2></div>
      <div class="modal-body"><div style="display:grid;gap:10px">
        <figure style="margin:0"><img data-alvo src="${retrato}" alt="story"><figcaption>legenda</figcaption></figure>
      </div></div></div></div>`
  },
  {
    nome: 'mídia da publicação (.post-media dentro de .post)',
    html: retrato => `<div class="post"><div class="post-media">
      <button type="button" class="midia-ampliavel"><img data-alvo src="${retrato}" alt="mídia" width="1280" height="960"></button>
    </div></div>`
  },
  {
    nome: 'mídia da mensagem (.chat-msg)',
    html: retrato => `<div class="chat-body"><div class="chat-msg">
      <button type="button" class="midia-ampliavel"><img data-alvo src="${retrato}" alt="mídia"></button>
    </div></div>`
  },
  {
    nome: 'ampliação (.lightbox-caixa)',
    html: retrato => `<div class="lightbox"><div class="lightbox-caixa"><img data-alvo src="${retrato}" alt="ampliada"></div></div>`
  },
  {
    nome: 'prévia da foto do pedido (.foto-previa)',
    html: retrato => `<div class="card"><div class="foto-previa"><img data-alvo src="${retrato}" alt="foto"></div></div>`
  },
  {
    nome: 'foto do treinador no painel (.foto-do-treinador)',
    html: retrato => `<section class="card"><img data-alvo class="foto-do-treinador" src="${retrato}" alt="foto" width="120" height="120"></section>`
  },
  {
    nome: 'prévia da foto do cadastro de treinador (.foto-escolhida)',
    html: retrato => `<form class="card"><div class="foto-escolhida"><img data-alvo src="${retrato}" alt="prévia" width="96" height="96"><button type="button" class="button button-ghost button-sm">Remover</button></div></form>`
  }
];

const problemas = [];
const linhas = [];

const css = cssConstruido();
const retrato = `data:image/png;base64,${pngCinza(1280, 960).toString('base64')}`;

const modulo = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const { chromium } = await import(modulo);
const navegador = await chromium.launch({
  executablePath: arg('chromium', env.PLAYWRIGHT_CHROMIUM || undefined),
  args: ['--no-sandbox']
});

try {
  for (const largura of LARGURAS) {
    const pagina = await navegador.newPage({ viewport: { width: largura, height: 820 } });
    for (const cena of CENAS) {
      await pagina.setContent(
        `<!doctype html><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<style>${css}</style>`
        + `<div class="app-shell"><main class="conteudo">${cena.html(retrato)}</main></div>`,
        { waitUntil: 'load' }
      );
      await pagina.waitForFunction(() => {
        const img = document.querySelector('[data-alvo]');
        return img instanceof HTMLImageElement ? img.complete : true;
      });
      const medida = await pagina.evaluate(() => {
        const img = document.querySelector('[data-alvo]');
        const r = img.getBoundingClientRect();
        return {
          direita: Math.round(r.right),
          largura: Math.round(r.width),
          documento: document.documentElement.scrollWidth,
          viewport: window.innerWidth
        };
      });
      // Um pixel de tolerância: arredondamento de subpixel não é defeito.
      const cabe = medida.direita <= medida.viewport + 1;
      linhas.push({ largura, cena: cena.nome, ...medida, cabe });
      if (!cabe) {
        problemas.push(`${largura}px — ${cena.nome}: a imagem termina em ${medida.direita}px, `
          + `${medida.direita - medida.viewport}px além da viewport (largura renderizada ${medida.largura}px)`);
      }
    }
    await pagina.close();
  }
} finally {
  await navegador.close();
}

for (const l of linhas) {
  console.log(`${l.cabe ? 'ok   ' : 'FALHA'} ${String(l.largura).padStart(4)}px  `
    + `borda direita ${String(l.direita).padStart(5)} / viewport ${String(l.viewport).padStart(4)}  ${l.cena}`);
}

console.log('');
if (problemas.length) {
  console.error(`REPROVADO — ${problemas.length} caso(s):`);
  for (const p of problemas) console.error(`  * ${p}`);
  process.exit(1);
}
console.log(`APROVADO — ${linhas.length} medições (${CENAS.length} cenas x ${LARGURAS.length} larguras), nenhuma imagem passa da viewport.`);

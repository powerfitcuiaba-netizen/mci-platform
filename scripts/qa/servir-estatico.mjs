#!/usr/bin/env node
// ============================================================================
// Servidor estático para o ambiente de PREVIEW (FASE 14).
//
// POR QUE NÃO `vite preview`
//
// O preview do Vite recusa requisição cujo cabeçalho `Host` ele não reconhece
// — é a defesa contra rebinding de DNS, e está certa. Num túnel público o Host
// é um domínio sorteado a cada execução, então toda requisição voltaria
// "Blocked request". Liberar o host no config do Vite afrouxaria a defesa
// também em desenvolvimento, e não é onde ela deve ser afrouxada.
//
// Este servidor entrega `dist/` e nada mais. Ele existe só para o ambiente de
// visualização; produção continua servindo o bundle pelo provedor estático,
// que é o que `render.yaml` descreve.
//
// O QUE ELE FAZ DE PROPÓSITO
//
//   * caminho que não casa com arquivo cai em `index.html` — a interface é uma
//     SPA, e sem isso recarregar em /#ranking devolveria 404;
//   * nenhum caminho sai do diretório servido, mesmo com `..` ou byte nulo;
//   * `X-Content-Type-Options: nosniff`, porque o bundle é servido para um
//     navegador de verdade.
//
// Uso: node scripts/qa/servir-estatico.mjs --dir frontend/dist --porta 5700
// ============================================================================

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const { argv } = process;
const arg = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const RAIZ = path.resolve(arg('dir', 'frontend/dist'));
const PORTA = Number(arg('porta', 5700));
const HOST = arg('host', '0.0.0.0');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8'
};

// Resolve o caminho pedido DENTRO da raiz. O `resolve` normaliza `..` antes da
// comparação, então um caminho que tente subir não passa pelo prefixo.
function resolverDentroDaRaiz(caminhoPedido) {
  const semQuery = caminhoPedido.split('?')[0].split('#')[0];
  let decodificado;
  try {
    decodificado = decodeURIComponent(semQuery);
  } catch {
    return null;
  }
  if (decodificado.includes('\0')) return null;

  const completo = path.resolve(RAIZ, `.${path.posix.normalize(decodificado)}`);
  return completo === RAIZ || completo.startsWith(`${RAIZ}${path.sep}`) ? completo : null;
}

async function arquivoOuNulo(caminho) {
  try {
    const info = await stat(caminho);
    return info.isFile() ? caminho : null;
  } catch {
    return null;
  }
}

const servidor = createServer(async (req, res) => {
  const alvo = resolverDentroDaRaiz(req.url || '/');
  if (!alvo) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('caminho inválido');
  }

  // Arquivo existente; senão, o index — a SPA resolve a rota no navegador.
  const encontrado = (await arquivoOuNulo(alvo))
    || (await arquivoOuNulo(path.join(alvo, 'index.html')))
    || (await arquivoOuNulo(path.join(RAIZ, 'index.html')));

  if (!encontrado) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('não encontrado');
  }

  res.writeHead(200, {
    'Content-Type': TIPOS[path.extname(encontrado).toLowerCase()] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    // O bundle tem hash no nome; o index nunca pode ficar em cache, senão o
    // navegador continua pedindo um bundle que já não existe.
    'Cache-Control': encontrado.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
  });

  createReadStream(encontrado).pipe(res);
});

servidor.listen(PORTA, HOST, () => {
  console.log(`estático em http://${HOST}:${PORTA} servindo ${RAIZ}`);
});

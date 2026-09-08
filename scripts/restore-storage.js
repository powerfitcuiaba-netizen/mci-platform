#!/usr/bin/env node
//
// Restauração dos ARQUIVOS do MCI, a partir de um backup de
// scripts/backup-storage.js.
//
// Recusa escrever por cima de storage que já tenha os objetos do manifesto:
// restaurar sobre storage vivo mistura dois estados e produz arquivo trocado —
// o mesmo cuidado que scripts/restore.sh tem com o banco.
//
// Uso:
//   STORAGE_DRIVER=local STORAGE_DIR=./uploads \
//     node scripts/restore-storage.js /var/backups/mci/storage-20260908T044213Z
//
// Restaure o storage e o banco da MESMA janela. Um dump de hoje com arquivos
// de ontem produz referência quebrada — que é exatamente o que este par existe
// para evitar.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const storage = require('../src/services/storageService');

async function principal() {
  const pasta = process.argv[2];
  if (!pasta) throw new Error('informe a pasta do backup de storage');

  const caminhoManifesto = path.join(pasta, 'manifesto.json');
  if (!fs.existsSync(caminhoManifesto)) throw new Error(`manifesto não encontrado em ${pasta}`);

  // Confere o checksum ANTES de tocar no storage.
  const bruto = await fsp.readFile(caminhoManifesto);
  const caminhoSoma = `${caminhoManifesto}.sha256`;
  if (fs.existsSync(caminhoSoma)) {
    const esperado = (await fsp.readFile(caminhoSoma, 'utf8')).trim();
    const atual = crypto.createHash('sha256').update(bruto).digest('hex');
    if (esperado !== atual) throw new Error('checksum do manifesto não confere — backup corrompido.');
  }

  const manifesto = JSON.parse(bruto.toString());
  const inicio = Date.now();

  // Destino não vazio: recusa antes de escrever qualquer byte.
  const jaExistem = [];
  for (const objeto of manifesto.objetos) {
    if (await storage.exists(objeto.chave)) jaExistem.push(objeto.chave);
    if (jaExistem.length >= 5) break;
  }
  if (jaExistem.length) {
    throw new Error(
      `o storage de destino já tem objeto deste backup (ex.: ${jaExistem[0]}). `
      + 'Restaure em storage vazio.'
    );
  }

  // Confere TODOS os objetos antes de gravar QUALQUER um. Verificar durante a
  // escrita deixaria o storage meio restaurado quando o backup estivesse
  // corrompido — metade dos arquivos no lugar e metade não, que é pior do que
  // nenhum: ninguém sabe onde parou.
  const conteudos = new Map();
  const divergentes = [];
  const faltando = [];

  for (const objeto of manifesto.objetos) {
    const origem = path.join(pasta, 'objetos', objeto.chave);
    if (!fs.existsSync(origem)) { faltando.push(objeto.chave); continue; }

    const conteudo = await fsp.readFile(origem);
    const soma = crypto.createHash('sha256').update(conteudo).digest('hex');
    if (soma !== objeto.sha256) { divergentes.push(objeto.chave); continue; }
    conteudos.set(objeto.chave, conteudo);
  }

  if (faltando.length || divergentes.length) {
    throw new Error(
      `backup corrompido: ${faltando.length} objeto(s) faltando, `
      + `${divergentes.length} com checksum divergente. Nada foi gravado.`
    );
  }

  let restaurados = 0;
  for (const [chave, conteudo] of conteudos) {
    await storage.saveBuffer(chave, conteudo);
    restaurados += 1;
  }

  console.log(JSON.stringify({
    driver: storage.driver(),
    esperados: manifesto.objetos.length,
    restaurados,
    bytes: manifesto.bytes,
    ms: Date.now() - inicio
  }));
}

principal().catch(erro => {
  process.stderr.write(`FALHA: ${erro.message}\n`);
  process.exit(1);
});

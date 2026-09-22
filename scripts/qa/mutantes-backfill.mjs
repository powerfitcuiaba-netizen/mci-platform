#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DO BACKFILL DA TAXONOMIA DE CLASSE.
//
//   node scripts/qa/mutantes-backfill.mjs
//
// A suíte do backfill ficou verde. Isso não diz que ela testa alguma coisa.
// Este script estraga o script de reparo de propósito, uma mudança por vez, e
// roda a suíte contra cada versão estragada.
//
// O MUTANTE QUE MAIS IMPORTA é o primeiro: voltar a ler a categoria de
// `RankingPoint.categoryId` em vez de `ExternalResult.categoryCode`. Ele
// reproduz exatamente o defeito que a base real da federação tem — 191
// lançamentos com `categoryId` nulo —, e se a suíte não o matar, ela não
// estava medindo o que esta fase existe para corrigir.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();
const SUITE = 'tests/backfill-classe.test.mjs';

const MUTANTES = [
  {
    nome: 'ler a categoria do lançamento, e não da origem',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: "      const codigo = (ponto.externalResult?.categoryCode ?? '').trim().toUpperCase();",
    para: "      const codigo = '';"
  },
  {
    nome: 'resolver tudo como classe genérica',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    // Montado por concatenação, e não como template: o ESLint reprova cifrão
    // seguido de chave dentro de string literal, e aqui ele é o TEXTO que vai
    // ser escrito no arquivo alvo — não uma interpolação deste script.
    de: ['      const chave = ', '`', '$', '{ponto.organizationId}|', '$', '{categoria.id}|', '$', '{nome}', '`', ';'].join(''),
    para: ['      const chave = ', '`', '$', '{ponto.organizationId}||', '$', '{nome}', '`', ';'].join('')
  },
  {
    nome: 'romper o vínculo categoria -> ClassCatalog na escrita',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '        categoryId: grupo.categoryId,\n        displayName: grupo.displayName',
    para: '        categoryId: null,\n        displayName: grupo.displayName'
  },
  {
    nome: 'aceitar código de categoria desconhecido em vez de conflitar',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '      if (!categoria) {',
    para: '      if (false) {'
  },
  {
    nome: 'cair na genérica quando a origem não declara categoria',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '      if (!codigo) { semCodigoDeCategoria.push(ponto); continue; }',
    para: '      if (!codigo) { /* mutante: segue e resolve como genérica */ }'
  },
  {
    nome: 'escrever categoryId junto com a classe',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '        data: { catalogClassId: classe.id }',
    para: '        data: { catalogClassId: classe.id, categoryId: grupo.categoryId }'
  },
  {
    nome: 'alterar a pontuação junto com a classe',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '        data: { catalogClassId: classe.id }\n      });',
    para: '        data: { catalogClassId: classe.id, points: 0 }\n      });'
  },
  {
    // EQUIVALENTE, E COM O ARGUMENTO ESCRITO — não é buraco no gate.
    //
    // A condição `catalogClassId: null` aparece duas vezes: na consulta de
    // pendentes e no `where` da escrita. Removê-la da SEGUNDA não muda
    // comportamento nenhum observável de fora, porque toda linha de
    // `grupo.pontos` veio da primeira — já filtrada por nulidade.
    //
    // A única forma de as duas divergirem é alguém resolver a classe daquela
    // linha DENTRO da janela entre a leitura da lista e a gravação, no meio da
    // mesma execução. É uma janela real — o script processa grupo a grupo —,
    // mas nenhum teste de caixa-preta a abre de propósito, e um teste que
    // dependesse de tempo seria intermitente, que é pior do que não ter.
    //
    // A condição fica no código como defesa em profundidade. O mutante fica
    // aqui, declarado, para que ninguém precise redescobrir o argumento.
    equivalente: 'a condição repete o filtro da consulta de pendentes; só difere numa corrida interna que teste de fora não abre sem depender de tempo',
    nome: 'sobrescrever classe já resolvida (perde a idempotência)',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '        where: { id: { in: grupo.pontos }, catalogClassId: null },',
    para: '        where: { id: { in: grupo.pontos } },'
  },
  {
    nome: 'escrever mesmo sem --aplicar',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '    if (!aplicar) {',
    para: '    if (false) {'
  },
  {
    nome: 'ignorar o recorte por temporada',
    arquivo: 'scripts/backfill-classe-do-catalogo.js',
    de: '        ...(temporadaId ? { seasonId: temporadaId } : {})',
    para: '        ...({})'
  }
];

function rodarSuite() {
  const saida = spawnSync('npx', ['vitest', 'run', SUITE], {
    cwd: RAIZ, encoding: 'utf8', env: process.env, timeout: 15 * 60 * 1000
  });
  return saida.status === 0;
}

function main() {
  const originais = new Map();
  for (const mutante of MUTANTES) {
    const alvo = path.join(RAIZ, mutante.arquivo);
    if (!originais.has(alvo)) originais.set(alvo, readFileSync(alvo, 'utf8'));
  }

  const mortos = [];
  const sobreviventes = [];
  const naoAplicados = [];
  const equivalentes = [];

  try {
    for (const mutante of MUTANTES) {
      const alvo = path.join(RAIZ, mutante.arquivo);
      const original = originais.get(alvo);
      const ocorrencias = original.split(mutante.de).length - 1;

      if (ocorrencias !== 1) {
        naoAplicados.push(`${mutante.nome} — o trecho aparece ${ocorrencias} vezes em ${mutante.arquivo}`);
        continue;
      }

      writeFileSync(alvo, original.replace(mutante.de, mutante.para));
      process.stdout.write(`  ${mutante.nome.padEnd(58)} `);
      const passou = rodarSuite();
      writeFileSync(alvo, original);

      if (!passou) { mortos.push(mutante.nome); console.log('morto'); continue; }

      // SOBREVIVER SENDO EQUIVALENTE É OUTRA COISA, e o gate trata como
      // outra coisa. Mas se um mutante DECLARADO equivalente MORRE, a
      // declaração está errada — e isso reprova, porque significa que o
      // argumento escrito ali não corresponde mais ao código.
      if (mutante.equivalente) { equivalentes.push(mutante); console.log('equivalente (não muda comportamento)'); }
      else { sobreviventes.push(mutante.nome); console.log('SOBREVIVEU'); }
    }
  } finally {
    for (const [alvo, original] of originais) writeFileSync(alvo, original);
  }

  const declaradosEquivalentes = MUTANTES.filter(m => m.equivalente);
  const equivalentesQueMorreram = declaradosEquivalentes.filter(m => mortos.includes(m.nome));

  console.log(`\n  mortos ......... ${mortos.length}/${MUTANTES.length - declaradosEquivalentes.length} não equivalentes`);
  console.log(`  equivalentes ... ${equivalentes.length}`);
  for (const m of equivalentes) console.log(`     = ${m.nome}\n       ${m.equivalente}`);
  if (equivalentesQueMorreram.length) {
    console.log(`  DECLARAÇÃO ERRADA .. ${equivalentesQueMorreram.length} mutante(s) declarados equivalentes MORRERAM`);
    for (const m of equivalentesQueMorreram) console.log(`     x ${m.nome}`);
  }
  console.log(`  sobreviventes .. ${sobreviventes.length}`);
  for (const nome of sobreviventes) console.log(`     ! ${nome}`);
  if (naoAplicados.length) {
    console.log(`  NÃO APLICADOS .. ${naoAplicados.length}`);
    for (const aviso of naoAplicados) console.log(`     ? ${aviso}`);
  }

  process.exit(sobreviventes.length || naoAplicados.length || equivalentesQueMorreram.length ? 1 : 0);
}

console.log('\n  MUTANTES DO BACKFILL — cada um roda a suíte inteira\n');
main();

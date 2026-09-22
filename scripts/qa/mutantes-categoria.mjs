#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DA CORREÇÃO DE `RankingPoint.categoryId`.
//
//   node scripts/qa/mutantes-categoria.mjs
//
// A suíte ficou verde. Isso não diz que ela mede alguma coisa. Este script
// estraga o script de reparo de propósito, uma mudança por vez, e roda a
// suíte inteira contra cada versão estragada.
//
// OS MUTANTES QUE MAIS IMPORTAM são os que afrouxam a regra de origem: ler a
// categoria de outro lugar que não `ExternalResult.categoryCode`, aceitar
// código desconhecido, ou escrever com a auditoria em aberto. São exatamente
// os atalhos que produziriam uma base plausível e errada.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();
const SUITE = 'tests/backfill-categoria.test.mjs';
const ALVO = 'scripts/backfill-categoria-do-lancamento.js';

const MUTANTES = [
  {
    nome: 'ignorar o código da origem (a categoria some)',
    de: "      const codigo = (ponto.externalResult?.categoryCode ?? '').trim().toUpperCase();",
    para: "      const codigo = '';"
  },
  {
    nome: 'aceitar código desconhecido escolhendo uma categoria qualquer',
    de: '      const categoria = categorias.get(codigo);',
    para: '      const categoria = categorias.get(codigo) ?? catalogo[0];'
  },
  {
    nome: 'a origem sem código deixa de ser tratada à parte',
    de: '      if (!codigo) { semCodigo.push(ponto); continue; }',
    para: '      if (!codigo) { /* mutante: segue adiante */ }'
  },
  {
    nome: 'aplicar mesmo com linhas não resolvidas',
    de: '    if (naoResolvidos) {\n      console.error(',
    para: '    if (false) {\n      console.error('
  },
  {
    nome: 'escrever mesmo sem --aplicar',
    de: '    if (!aplicar) {',
    para: '    if (false) {'
  },
  {
    nome: 'a consulta de pendentes deixa de filtrar por categoria nula',
    de: "    const recorte = { categoryId: null, ...(temporadaId ? { seasonId: temporadaId } : {}) };",
    para: "    const recorte = { ...(temporadaId ? { seasonId: temporadaId } : {}) };"
  },
  {
    nome: 'zerar a pontuação junto com a categoria',
    de: '        data: { categoryId: grupo.categoryId }',
    para: '        data: { categoryId: grupo.categoryId, points: 0 }'
  },
  {
    nome: 'apagar a classe junto com a categoria',
    de: '        data: { categoryId: grupo.categoryId }\n      });',
    para: '        data: { categoryId: grupo.categoryId, catalogClassId: null }\n      });'
  },
  {
    nome: 'ignorar o recorte por temporada',
    de: '...(temporadaId ? { seasonId: temporadaId } : {}) };',
    para: '...({}) };'
  },
  {
    // EQUIVALENTE, E COM O ARGUMENTO ESCRITO — não é buraco no gate.
    //
    // A condição `categoryId: null` aparece duas vezes: na consulta de
    // pendentes e no `where` da escrita. Removê-la da SEGUNDA não muda
    // comportamento nenhum observável de fora, porque toda linha de
    // `grupo.pontos` veio da primeira — já filtrada por nulidade. O mutante
    // que remove a PRIMEIRA está acima, e morre.
    //
    // As duas só divergem se alguém resolver a categoria daquela linha DENTRO
    // da janela entre a leitura e a gravação. Aqui a janela é ainda menor do
    // que no backfill da classe: `withUserContext` abre uma transação só para
    // o script inteiro. Nenhum teste de caixa-preta abre essa janela sem
    // depender de tempo, e teste que depende de tempo é intermitente — pior
    // do que não ter.
    //
    // A condição fica no código como defesa em profundidade. O mutante fica
    // aqui, declarado, para que ninguém precise redescobrir o argumento.
    equivalente: 'a condição repete o filtro da consulta de pendentes; só difere numa corrida dentro da própria transação, que teste de fora não abre sem depender de tempo',
    nome: 'o where da escrita deixa de repetir a condição de nulidade',
    de: '        where: { id: { in: grupo.pontos }, categoryId: null },',
    para: '        where: { id: { in: grupo.pontos } },'
  }
];

function rodarSuite() {
  const saida = spawnSync('npx', ['vitest', 'run', SUITE], {
    cwd: RAIZ, encoding: 'utf8', env: process.env, timeout: 15 * 60 * 1000
  });
  return saida.status === 0;
}

function main() {
  const alvo = path.join(RAIZ, ALVO);
  const original = readFileSync(alvo, 'utf8');

  const mortos = [];
  const sobreviventes = [];
  const naoAplicados = [];
  const equivalentes = [];

  try {
    for (const mutante of MUTANTES) {
      const ocorrencias = original.split(mutante.de).length - 1;

      if (ocorrencias !== 1) {
        naoAplicados.push(`${mutante.nome} — o trecho aparece ${ocorrencias} vezes em ${ALVO}`);
        continue;
      }

      writeFileSync(alvo, original.replace(mutante.de, mutante.para));
      process.stdout.write(`  ${mutante.nome.padEnd(58)} `);
      const passou = rodarSuite();
      writeFileSync(alvo, original);

      if (!passou) { mortos.push(mutante.nome); console.log('morto'); continue; }

      // SOBREVIVER SENDO EQUIVALENTE É OUTRA COISA, e o gate trata como outra
      // coisa. Mas se um mutante DECLARADO equivalente MORRE, a declaração
      // está errada — e isso reprova.
      if (mutante.equivalente) { equivalentes.push(mutante); console.log('equivalente (não muda comportamento)'); }
      else { sobreviventes.push(mutante.nome); console.log('SOBREVIVEU'); }
    }
  } finally {
    // Restaura SEMPRE — inclusive se a execução for interrompida no meio.
    writeFileSync(alvo, original);
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

console.log('\n  MUTANTES DA CORREÇÃO DE CATEGORIA — cada um roda a suíte inteira\n');
main();

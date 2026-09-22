#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DA TAXONOMIA DE CATEGORIA E CLASSE.
//
//   node scripts/qa/mutantes-taxonomia.mjs
//
// A pergunta que um teste verde NÃO responde é se ele testa alguma coisa.
// Este script estraga o código de propósito, uma mudança por vez, e roda a
// suíte da taxonomia contra cada versão estragada.
//
// MUTANTE QUE MORRE é um teste que funciona. MUTANTE QUE SOBREVIVE é um
// buraco no gate — e é reportado como buraco, não escondido.
//
// Toda mutação é revertida ao fim, inclusive quando o processo falha: o
// arquivo original é guardado antes e reescrito no `finally`.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();
const SUITE = 'tests/taxonomia-de-classe.test.mjs';

const MUTANTES = [
  {
    nome: 'remover catalogClassId do lançamento importado',
    arquivo: 'src/services/muscleWarService.js',
    de: 'catalogClassId: classeDoCatalogo?.id ?? null,',
    para: 'catalogClassId: null,'
  },
  {
    nome: 'ignorar a categoria ao gravar o lançamento',
    arquivo: 'src/services/muscleWarService.js',
    de: 'categoryId: categoria?.id ?? null,\n              // A classe do catálogo',
    para: 'categoryId: null,\n              // A classe do catálogo'
  },
  {
    nome: 'zerar os pontos do lançamento importado',
    arquivo: 'src/services/muscleWarService.js',
    de: '              awardedById: actor?.id ?? null,\n              points',
    para: '              awardedById: actor?.id ?? null,\n              points: 0'
  },
  {
    nome: 'resolver sempre a classe genérica, nunca a da categoria',
    arquivo: 'src/utils/classeDoCatalogo.js',
    de: '  if (categoryId) {\n    const especifica = await cliente.classCatalog.findFirst({ where: { organizationId, categoryId, code: codigo } });\n    if (especifica) return especifica;\n  }',
    para: '  if (false && categoryId) {\n    const especifica = await cliente.classCatalog.findFirst({ where: { organizationId, categoryId, code: codigo } });\n    if (especifica) return especifica;\n  }'
  },
  {
    nome: 'criar a classe toda vez, em vez de reusar a existente',
    arquivo: 'src/utils/classeDoCatalogo.js',
    de: '  const generica = await cliente.classCatalog.findFirst({ where: { organizationId, categoryId: null, code: codigo } });\n  if (generica) return generica;',
    para: '  const generica = null;\n  if (generica) return generica;'
  },
  {
    nome: 'aceitar classe de outra organização no recorte',
    arquivo: 'src/services/rankingService.js',
    de: '  if (organizationId && classe.organizationId !== organizationId) {',
    para: '  if (false && classe.organizationId !== organizationId) {'
  },
  {
    nome: 'aceitar o cruzamento categoria/classe incoerente',
    arquivo: 'src/services/rankingService.js',
    de: '  if (categoryId && classe.categoryId && classe.categoryId !== categoryId) {',
    para: '  if (false && classe.categoryId !== categoryId) {'
  },
  {
    nome: 'ignorar o filtro de classe no recorte',
    arquivo: 'src/services/rankingService.js',
    de: '  if (catalogClassId) where.catalogClassId = catalogClassId;',
    para: '  if (false) where.catalogClassId = catalogClassId;'
  },
  {
    nome: 'ignorar a categoria no recorte por classe',
    arquivo: 'src/services/rankingService.js',
    de: '      catalogClassId: filtros.catalogClassId,\n      categoryId: filtros.categoryId ?? null,',
    para: '      catalogClassId: filtros.catalogClassId,\n      categoryId: null,'
  },
  {
    nome: 'não carregar catalogClassId para a projeção pública',
    arquivo: 'src/services/rankingService.js',
    de: '      catalogClassId: ponto.catalogClassId ?? null,',
    para: '      catalogClassId: null,'
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

  try {
    for (const mutante of MUTANTES) {
      const alvo = path.join(RAIZ, mutante.arquivo);
      const original = originais.get(alvo);

      const ocorrencias = original.split(mutante.de).length - 1;
      if (ocorrencias !== 1) {
        // O trecho mudou de forma. Reportar é obrigatório: um mutante que não
        // consegue ser aplicado não testou nada, e contá-lo como morto seria
        // o mesmo que não rodá-lo.
        naoAplicados.push(`${mutante.nome} — o trecho aparece ${ocorrencias} vezes em ${mutante.arquivo}`);
        continue;
      }

      writeFileSync(alvo, original.replace(mutante.de, mutante.para));
      process.stdout.write(`  ${mutante.nome.padEnd(58)} `);
      const passou = rodarSuite();
      writeFileSync(alvo, original);

      if (passou) { sobreviventes.push(mutante.nome); console.log('SOBREVIVEU'); }
      else { mortos.push(mutante.nome); console.log('morto'); }
    }
  } finally {
    for (const [alvo, original] of originais) writeFileSync(alvo, original);
  }

  console.log(`\n  mortos ......... ${mortos.length}/${MUTANTES.length}`);
  console.log(`  sobreviventes .. ${sobreviventes.length}`);
  for (const nome of sobreviventes) console.log(`     ! ${nome}`);
  if (naoAplicados.length) {
    console.log(`  NÃO APLICADOS .. ${naoAplicados.length}`);
    for (const aviso of naoAplicados) console.log(`     ? ${aviso}`);
  }

  // Sobrevivente ou mutante que não pôde ser aplicado reprovam o gate.
  process.exit(sobreviventes.length || naoAplicados.length ? 1 : 0);
}

console.log('\n  MUTANTES DA TAXONOMIA — cada um roda a suíte inteira\n');
main();

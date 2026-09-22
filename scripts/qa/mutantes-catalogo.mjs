#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DO CATÁLOGO OFICIAL DE CATEGORIAS.
//
//   node scripts/qa/mutantes-catalogo.mjs
//
// A suíte de `tests/catalogo-oficial-de-categorias.test.mjs` ficou verde. Isso
// não diz que ela mede alguma coisa: a guarda de categoria TAMBÉM estava verde
// enquanto deixava passar 191 linhas contra um catálogo vazio.
//
// O MUTANTE QUE MAIS IMPORTA é `a guarda volta a ficar depois da resolução do
// atleta`. Ele não inventa um defeito: recoloca o que a base real da federação
// tinha. Se a suíte não o matar, ela não está medindo esta correção — está
// apenas acompanhando o código.
//
// Cada mutante roda a suíte inteira e o arquivo é restaurado em seguida,
// inclusive quando a execução é interrompida.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();
const SUITE = 'tests/catalogo-oficial-de-categorias.test.mjs';

const SERVICO = 'src/services/muscleWarService.js';
const MIGRATION = 'prisma/migrations/20260922210000_catalogo_oficial_de_categorias/migration.sql';

const MUTANTES = [
  {
    // O DEFEITO DE PRODUÇÃO, RECOLOCADO. Com a base de atletas vazia — o
    // caminho normal do histórico oficial — a linha voltava a sair como
    // MATCH_PENDING antes de a categoria ser conferida.
    nome: 'a guarda volta a ficar depois da resolução do atleta',
    arquivo: SERVICO,
    de: '  if (!registro.categoryCode) {',
    para: '  if (!doLote.atletasPorId.size) return { matchStatus: \'MATCH_PENDING\', reason: \'Atleta não reconhecido\', athleteId: null };\n  if (!registro.categoryCode) {'
  },
  {
    nome: 'aceitar código de categoria desconhecido no MCI',
    arquivo: SERVICO,
    de: '  if (!doLote.categoriasConhecidas.has(registro.categoryCode.toUpperCase())) {',
    para: '  if (false) {'
  },
  {
    nome: 'a categoria desconhecida vira pendência, e não conflito',
    arquivo: SERVICO,
    // Montado por concatenação: o cifrão seguido de chave aqui é o TEXTO que
    // vai ser procurado no arquivo alvo, não uma interpolação deste script.
    de: ["      matchStatus: 'CONFLICT',\n      reason: ", '`', 'Categoria desconhecida no MCI: ', '$', '{registro.categoryCode}', '`', ','].join(''),
    para: ["      matchStatus: 'MATCH_PENDING',\n      reason: ", '`', 'Categoria desconhecida no MCI: ', '$', '{registro.categoryCode}', '`', ','].join('')
  },
  {
    nome: 'linha sem categoria nenhuma vira pendência, e não conflito',
    arquivo: SERVICO,
    de: "    return { matchStatus: 'CONFLICT', reason: motivo, athleteId: null };",
    para: "    return { matchStatus: 'MATCH_PENDING', reason: motivo, athleteId: null };"
  },
  {
    // TROCAR A CATEGORIA ENTRE CATEGORIAS. A aplicação resolve pelo código do
    // arquivo; este mutante resolve por qualquer OUTRA — o ponto entra com
    // recorte errado, que é pior do que entrar sem recorte nenhum.
    nome: 'a aplicação grava uma categoria que não é a do arquivo',
    arquivo: SERVICO,
    de: '            ? await tx.category.findUnique({ where: { code: item.categoryCode.toUpperCase() } })',
    para: '            ? await tx.category.findFirst({ where: { code: { not: item.categoryCode.toUpperCase() } }, orderBy: { code: \'asc\' } })'
  },
  {
    nome: 'a aplicação grava categoryId nulo mesmo com a categoria resolvida',
    arquivo: SERVICO,
    de: '              categoryId: categoria?.id ?? null,\n              // A classe do catálogo acompanha o ponto INCLUSIVE quando',
    para: '              categoryId: null,\n              // A classe do catálogo acompanha o ponto INCLUSIVE quando'
  },
  {
    nome: 'a classe resolvida perde o vínculo com a categoria',
    arquivo: SERVICO,
    de: '            categoryId: categoria?.id ?? null,\n            displayName: nomeDeExibicaoDaClasse(item)',
    para: '            categoryId: null,\n            displayName: nomeDeExibicaoDaClasse(item)'
  },
  {
    // O catálogo provisionado pela migration precisa ser O MESMO provisionado
    // pelo seed. Tirar uma categoria de um lado só é o jeito mais fácil de os
    // dois ambientes se separarem sem ninguém notar.
    nome: 'a migration deixa de trazer BIKINI',
    arquivo: MIGRATION,
    de: "  ('cat_mci_bikini',              'BIKINI',              'Bikini',                'FEMALE',  80,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),\n",
    para: ''
  },
  {
    nome: 'a migration deixa de ser idempotente (sem ON CONFLICT)',
    arquivo: MIGRATION,
    de: 'ON CONFLICT ("code") DO NOTHING;',
    para: ';'
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
    // Restaura SEMPRE — inclusive se a execução for interrompida no meio.
    for (const [alvo, original] of originais) writeFileSync(alvo, original);
  }

  console.log(`\n  mortos ......... ${mortos.length}/${MUTANTES.length}`);
  console.log(`  sobreviventes .. ${sobreviventes.length}`);
  for (const nome of sobreviventes) console.log(`     ! ${nome}`);
  if (naoAplicados.length) {
    console.log(`  NÃO APLICADOS .. ${naoAplicados.length}`);
    for (const aviso of naoAplicados) console.log(`     ? ${aviso}`);
  }

  process.exit(sobreviventes.length || naoAplicados.length ? 1 : 0);
}

console.log('\n  MUTANTES DO CATÁLOGO DE CATEGORIAS — cada um roda a suíte inteira\n');
main();

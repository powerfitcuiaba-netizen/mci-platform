#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DO AJUSTE ADMINISTRATIVO DE PONTUAÇÃO.
//
//   node scripts/qa/mutantes-ajuste.mjs
//
// Mesmo instrumento de `mutantes-taxonomia.mjs`, outra superfície: aqui o que
// se estraga de propósito é a autorização, a auditoria, a guarda de
// concorrência, o piso de zero e a promessa de que o ajuste NÃO move
// colocação, categoria, classe nem Overall.
//
// Mutante que morre é um teste que funciona. Mutante que sobrevive é um
// buraco no gate — e é reportado como buraco.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { conferirRestauracao, relatarRestauracao } from './lib/restauracao.mjs';

const RAIZ = process.cwd();
const SUITE = 'tests/ajuste-de-pontos.test.mjs';

const MUTANTES = [
  {
    nome: 'remover a autorização do lançamento',
    arquivo: 'src/services/rankingService.js',
    de: "  assertCan(actor, 'ranking.manage', temporada.organizationId);",
    para: "  if (false) assertCan(actor, 'ranking.manage', temporada.organizationId);"
  },
  {
    nome: 'ignorar a guarda de concorrência',
    arquivo: 'src/services/rankingService.js',
    de: '    if (atual.points !== expectedPoints) {',
    para: '    if (false && atual.points !== expectedPoints) {'
  },
  {
    nome: 'não registrar o ajuste no histórico',
    arquivo: 'src/services/rankingService.js',
    // A PRIMEIRA VERSÃO DESTE MUTANTE ERA INVÁLIDA: espalhava um objeto
    // vazio dentro do `create` e a escrita acontecia do mesmo jeito. Ele
    // "sobreviveu" sem nunca ter mudado comportamento — mutante que não
    // muda nada não mede nada, e contá-lo como buraco no gate seria acusar
    // o teste pelo erro do instrumento.
    de: '    registro = await tx.rankingPointAdjustment.create({',
    para: "    registro = { id: 'sem-registro' };\n    if (false) registro = await tx.rankingPointAdjustment.create({"
  },
  {
    nome: 'não registrar a auditoria do ajuste',
    arquivo: 'src/services/rankingService.js',
    de: "    actor, action: audit.ACTIONS.RANKING_POINTS_ADJUSTED,",
    para: "    actor, action: 'RANKING_POINT_EDITED',"
  },
  {
    nome: 'aceitar motivo vazio',
    arquivo: 'src/utils/schemas.js',
    de: '  points: z.coerce.number().int().min(0).max(100000),\n  expectedPoints: z.coerce.number().int().min(0).max(100000),\n  reason: texto(5, 500)\n});',
    para: '  points: z.coerce.number().int().min(0).max(100000),\n  expectedPoints: z.coerce.number().int().min(0).max(100000),\n  reason: z.string().optional().default("")\n});'
  },
  {
    nome: 'aceitar pontuação negativa',
    arquivo: 'src/utils/schemas.js',
    de: '  points: z.coerce.number().int().min(0).max(100000),\n  expectedPoints:',
    para: '  points: z.coerce.number().int().min(-100000).max(100000),\n  expectedPoints:'
  },
  {
    nome: 'deixar o ajuste alterar a colocação junto',
    arquivo: 'src/services/rankingService.js',
    de: '        adjustmentPoints: points - doMotor,\n        points,',
    para: '        adjustmentPoints: points - doMotor,\n        points, placing: 9,'
  },
  {
    nome: 'deixar o ajuste alterar a categoria junto',
    arquivo: 'src/services/rankingService.js',
    de: '        adjustmentPoints: points - doMotor,\n        points,\n',
    para: '        adjustmentPoints: points - doMotor,\n        points, categoryId: null,\n'
  },
  {
    nome: 'deixar o ajuste conferir bônus de Overall',
    arquivo: 'src/services/rankingService.js',
    de: '        superOverallPoints: atual.superOverallEligible ? points : 0\n      }\n    });\n\n    registro =',
    para: '        superOverallPoints: atual.superOverallEligible ? points : 0,\n        overallBonus: 10, isOverallChampion: true\n      }\n    });\n\n    registro ='
  },
  {
    nome: 'permitir ajustar um não comparecimento',
    arquivo: 'src/services/rankingService.js',
    de: '  if (ponto.didNotShow && points > 0) {',
    para: '  if (false && points > 0) {'
  },
  {
    nome: 'zerar o ajuste na correção de colocação posterior',
    arquivo: 'src/services/rankingService.js',
    de: '  const ajuste = ponto.adjustmentPoints ?? 0;',
    para: '  const ajuste = 0;'
  },
  {
    nome: 'quebrar a decomposição, escrevendo o total sem a parcela',
    arquivo: 'src/services/rankingService.js',
    de: '        adjustmentPoints: points - doMotor,',
    para: '        adjustmentPoints: 0,'
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
    for (const [alvo, original] of originais) writeFileSync(alvo, original);
  }

  // A RESTAURAÇÃO É CONFERIDA CONTRA O GIT, e não só prometida: um commit
  // feito durante a execução leva o mutante junto, e a restauração seguinte
  // deixa a árvore certa com o histórico errado. Ver scripts/qa/lib.
  const divergentes = conferirRestauracao(RAIZ, MUTANTES.map(m => m.arquivo));

  console.log(`\n  mortos ......... ${mortos.length}/${MUTANTES.length}`);
  console.log(`  sobreviventes .. ${sobreviventes.length}`);
  for (const nome of sobreviventes) console.log(`     ! ${nome}`);
  if (naoAplicados.length) {
    console.log(`  NÃO APLICADOS .. ${naoAplicados.length}`);
    for (const aviso of naoAplicados) console.log(`     ? ${aviso}`);
  }

  const restauracaoOk = relatarRestauracao(divergentes);


  process.exit(sobreviventes.length || naoAplicados.length || !restauracaoOk ? 1 : 0);
}

console.log('\n  MUTANTES DO AJUSTE DE PONTOS — cada um roda a suíte inteira\n');
main();

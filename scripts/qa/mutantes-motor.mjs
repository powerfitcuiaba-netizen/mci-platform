#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DO MOTOR DE PONTUAÇÃO E DO OVERALL MANUAL.
//
//   node scripts/qa/mutantes-motor.mjs
//
// As duas suítes ficaram verdes. Isso não diz que elas medem alguma coisa —
// o recálculo também estava verde enquanto deixava 191 lançamentos valendo
// zero com a tabela cadastrada na tela.
//
// OS MUTANTES QUE MAIS IMPORTAM são os que desfazem as três correções desta
// fase: não reaplicar a tabela, apagar o ajuste administrativo, e soltar o
// título Overall da conferência da classe absoluta. São exatamente os atalhos
// que produziriam um ranking plausível e errado.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();
const SUITES = ['tests/motor-de-pontuacao.test.mjs', 'tests/overall-do-historico.test.mjs'];

const SERVICO = 'src/services/rankingService.js';
const SCHEMAS = 'src/utils/schemas.js';

const MUTANTES = [
  // ---------------------------------------------------------------- motor
  {
    nome: 'a tabela da temporada deixa de ser aplicada',
    arquivo: SERVICO,
    de: '      : pontuarResultado(ponto.placing, tabela);',
    para: '      : { placementPoints: ponto.placementPoints };'
  },
  {
    nome: 'ignorar o placing ao consultar a tabela',
    arquivo: SERVICO,
    de: '      : pontuarResultado(ponto.placing, tabela);\n',
    para: '      : pontuarResultado(null, tabela);\n'
  },
  {
    nome: 'o não comparecimento passa a pontuar',
    arquivo: SERVICO,
    de: "    const { placementPoints } = ponto.didNotShow\n      ? { placementPoints: 0 }\n      : pontuarResultado(ponto.placing, tabela);",
    para: '    const { placementPoints } = pontuarResultado(ponto.placing, tabela);'
  },
  {
    // O CASO QUE O TESTE DE CARGA PEGOU: linha sem colocação e sem ausência
    // carrega os pontos que o arquivo declarou, porque não havia regra a
    // aplicar. Reaplicar a tabela nela grava ZERO e apaga o número.
    nome: 'zerar o lançamento cuja pontuação veio do arquivo',
    arquivo: SERVICO,
    de: '    if (ponto.placing == null && !ponto.didNotShow) continue;',
    para: '    if (false) continue;'
  },
  {
    nome: 'usar os pontos antigos como fonte, em vez das parcelas',
    arquivo: SERVICO,
    de: '    const points = placementPoints + ponto.overallBonus + ponto.adjustmentPoints;',
    para: '    const points = ponto.points;'
  },
  {
    nome: 'a reconciliação apaga o ajuste administrativo',
    arquivo: SERVICO,
    de: '    const points = placementPoints + ponto.overallBonus + ponto.adjustmentPoints;\n    const superOverallPoints',
    para: '    const points = placementPoints + ponto.overallBonus;\n    const superOverallPoints'
  },
  {
    nome: 'temporada sem tabela passa a ZERAR o histórico',
    arquivo: SERVICO,
    de: "  if (!tabela.length) {\n    return { processados: 0, alterados: 0, semTabelaDePontos: true };\n  }",
    para: '  const tabelaUsada = tabela.length ? tabela : [];\n  if (false) { return { processados: 0, alterados: 0, semTabelaDePontos: true }; }\n  void tabelaUsada;'
  },
  {
    nome: 'o lançamento invalidado volta a ser repontuado',
    arquivo: SERVICO,
    de: '    where: { seasonId, voidedAt: null },\n    select: {\n      id: true, placing: true, didNotShow: true, superOverallEligible: true,',
    para: '    where: { seasonId },\n    select: {\n      id: true, placing: true, didNotShow: true, superOverallEligible: true,'
  },
  {
    nome: 'o recálculo deixa de reconstruir o bônus declarado',
    arquivo: SERVICO,
    de: '    for (const { eventId } of comTitulo) {\n      await normalizarBonusOverall(tx, { eventId, seasonId });\n    }',
    para: '    for (const { eventId } of comTitulo) { void eventId; }'
  },
  // -------------------------------------------------------------- Overall
  {
    nome: 'a normalização do bônus apaga o ajuste administrativo',
    arquivo: SERVICO,
    de: '      const points = linha.placementPoints + overallBonus + linha.adjustmentPoints;',
    para: '      const points = linha.placementPoints + overallBonus;'
  },
  {
    // EQUIVALENTE, E COM O ARGUMENTO ESCRITO — não é buraco no gate.
    //
    // A varredura de órfãs roda dentro de `aplicarTitulosDoEvento`, e logo
    // depois dela vem `recomputarEm` — que agora começa pela RECONCILIAÇÃO e
    // reescreve `points` como `placementPoints + overallBonus +
    // adjustmentPoints` para toda linha da temporada. Qualquer conta errada
    // aqui é corrigida antes de alguém poder observá-la de fora.
    //
    // A conta certa fica no código como defesa em profundidade: a varredura
    // não pode depender de outra função rodar em seguida para estar correta.
    // Se um dia a ordem mudar, é ela que segura.
    //
    // O mutante irmão — a conta da PORTADORA, que roda no mesmo laço — MORRE,
    // porque aquele caminho grava `overallBonus` junto e a reconciliação o
    // preserva em vez de recalculá-lo.
    equivalente: 'a reconciliação do recálculo reescreve `points` logo depois, pela mesma fórmula, e nenhum teste de caixa-preta observa o estado intermediário',
    nome: 'a linha órfã perde o ajuste junto com o bônus',
    arquivo: SERVICO,
    de: '    const points = linha.placementPoints + linha.adjustmentPoints;',
    para: '    const points = linha.placementPoints;'
  },
  {
    nome: 'o título passa a casar só por athleteId',
    arquivo: SERVICO,
    de: "    const doCompetidor = titulo.athleteId\n      ? { athleteId: titulo.athleteId }\n      : { externalAthleteId: titulo.externalAthleteId };",
    para: '    const doCompetidor = { athleteId: titulo.athleteId };'
  },
  {
    nome: 'declarar Overall sem conferir a classe absoluta',
    arquivo: SERVICO,
    de: '    || await disputouAbsolutaNoLedger(eventId, competidor.doLedger, categoryId);',
    para: '    || true;'
  },
  {
    nome: 'a conferência do ledger aceita classe que não é absoluta',
    arquivo: SERVICO,
    de: '      eventId, ...doLedger, superOverallEligible: true, voidedAt: null,',
    para: '      eventId, ...doLedger, voidedAt: null,'
  },
  {
    nome: 'aceitar competidor de outra organização',
    arquivo: SERVICO,
    de: "  if (externo.organizationId !== event.organizationId) {\n    throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Competidor de outra organização');\n  }",
    para: '  if (false) { throw new AppError(422, \'ATHLETE_OTHER_ORGANIZATION\', \'\'); }'
  },
  {
    nome: 'aceitar categoria que não é do campeonato',
    arquivo: SERVICO,
    de: '    if (!doEvento && !noLedger) {',
    para: '    if (false) {'
  },
  {
    // EQUIVALENTE, E COM O ARGUMENTO ESCRITO — não é buraco no gate.
    //
    // MEDIDO, não suposto: apliquei este mutante à mão e comparei o retrato
    // das duas participações. Saiu IDÊNTICO ao original — bônus [10, 0].
    //
    // O motivo é que a regra "um título, um bônus" é feita valer em DOIS
    // lugares, e o segundo é o decisivo. O laço da portadora marca; a
    // varredura de órfãs logo abaixo tira o bônus de tudo que tem bônus e
    // NÃO está em `portadoras` — que continua contendo só a portadora real.
    // Com o mutante, as duas linhas recebem +10 e a varredura desfaz o
    // excedente na mesma transação, antes de qualquer leitura de fora.
    //
    // A condição fica no código como defesa em profundidade: o laço não pode
    // depender da varredura seguinte para estar correto.
    //
    // E o teste que escrevi para este caso NÃO é decorativo: o mutante logo
    // abaixo estraga a VARREDURA, que é o mecanismo que decide — e morre.
    equivalente: 'a varredura de órfãs, na mesma transação, tira o bônus de quem não está em `portadoras`; medido à mão, o retrato sai idêntico ao do código original',
    nome: 'o bônus passa a pousar em TODAS as participações',
    arquivo: SERVICO,
    de: '      const ehPortadora = Boolean(portadora) && linha.id === portadora.id;',
    para: '      const ehPortadora = Boolean(portadora);'
  },
  {
    // O MECANISMO QUE DE FATO DECIDE. Sem o recorte por `portadoras`, a
    // varredura tira o bônus de TODO MUNDO — inclusive de quem acabou de
    // recebê-lo legitimamente.
    nome: 'a varredura de órfãs deixa de poupar a portadora',
    arquivo: SERVICO,
    de: '      ...(portadoras.size ? { id: { notIn: [...portadoras] } } : {})',
    para: '      ...({})'
  },
  {
    nome: 'trocar campeão sem revogar volta a ser aceito',
    arquivo: SERVICO,
    de: '      if (existente && !mesmoCompetidor) {',
    para: '      if (false) {'
  },
  {
    nome: 'dois títulos do mesmo competidor deixam de ser recusados',
    arquivo: SERVICO,
    de: '      if (doAtleta.some(outro => outro.categoryId !== categoryId)) {',
    para: '      if (false) {'
  },
  // --------------------------------------------------------------- schema
  {
    nome: 'o schema aceita atleta e competidor externo juntos',
    arquivo: SCHEMAS,
    de: '  corpo => Boolean(corpo.athleteId) !== Boolean(corpo.externalAthleteId),',
    para: '  () => true,'
  }
];

function rodarSuites() {
  const saida = spawnSync('npx', ['vitest', 'run', ...SUITES], {
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
      const passou = rodarSuites();
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

console.log('\n  MUTANTES DO MOTOR E DO OVERALL — cada um roda as duas suítes\n');
main();

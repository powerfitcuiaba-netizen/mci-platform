#!/usr/bin/env node
// ==========================================================================
// MUTATION TESTING DA FASE DO ATLETA.
//
//   node scripts/qa/mutantes-atleta.mjs
//
// Três suítes ficaram verdes nesta fase: a revelação do CPF, o vínculo do
// histórico importado e a mensagem de abertura. Verde não diz que elas medem
// alguma coisa — a guarda de categoria também estava verde enquanto deixava
// passar 191 linhas contra um catálogo vazio.
//
// Cada mutante aqui é um DEFEITO PLAUSÍVEL, e a maioria é um esquecimento que
// já aconteceu em algum sistema parecido: a segunda permissão que ninguém
// confere, a janela de validade que só olha uma ponta, o "já vinculado" que
// vira revínculo silencioso.
//
// Cada mutante roda SÓ a suíte que deveria matá-lo, e o arquivo é restaurado
// em seguida — inclusive se a execução for interrompida.
// ==========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RAIZ = process.cwd();

const ATLETA = 'src/services/athleteService.js';
const MUSCLEWAR = 'src/services/muscleWarService.js';
const AVISO = 'src/services/athleteNoticeService.js';

const SUITE_CPF = 'tests/revelar-cpf.test.mjs';
const SUITE_HISTORICO = 'tests/historico-importado-do-atleta.test.mjs';
const SUITE_AVISO = 'tests/mensagem-de-abertura.test.mjs';

const MUTANTES = [
  // ------------------------------------------------------- REVELAR O CPF
  {
    // ESTE MUTANTE SOBREVIVEU, E A INVESTIGAÇÃO MUDOU O QUE EU ACHAVA.
    //
    // Eu o escrevi esperando que morresse. Ele sobreviveu, e o motivo não é
    // buraco na suíte: é que NENHUM PAPEL DA MATRIZ tem
    // `athletes.read_sensitive` sem ter também `search.sensitive`. Conferi um
    // por um — REGISTRATION_OPERATOR, CHECKIN_OPERATOR, WEIGHIN_OPERATOR,
    // EVENT_DIRECTOR, ADMIN, SUPER_ADMIN: todos têm as duas. E é coerente que
    // tenham, porque quem opera inscrição, check-in e pesagem confere
    // documento na porta do evento.
    //
    // Não existe, hoje, ator capaz de separar as duas conferências. Nenhum
    // teste de caixa-preta poderia matar este mutante sem que a matriz mudasse
    // primeiro — e mudá-la só para matar um mutante seria inventar um papel
    // que a federação não usa.
    //
    // O que fiz em vez disso: `tests/revelar-cpf.test.mjs` passou a FIXAR o
    // fato por escrito, e reprova no dia em que um papel separar as duas. Aí
    // esta declaração de equivalência sai daqui, e o mutante passa a morrer.
    // O `assertCan` fica no código porque é ele que expressa a regra; tirá-lo
    // hoje não muda comportamento nenhum, e amanhã mudaria.
    equivalente: 'nenhum papel da matriz tem `athletes.read_sensitive` sem `search.sensitive`, '
      + 'então a segunda conferência não recusa ninguém que a primeira tenha deixado passar; '
      + 'o fato está fixado por teste em tests/revelar-cpf.test.mjs',
    nome: 'revelar o CPF deixa de exigir search.sensitive',
    arquivo: ATLETA, suite: SUITE_CPF,
    de: "  assertCan(actor, 'search.sensitive', athlete.organizationId);\n",
    para: ''
  },
  {
    nome: 'revelar o CPF deixa de auditar',
    arquivo: ATLETA, suite: SUITE_CPF,
    de: "  await audit.record({\n    actor, action: audit.ACTIONS.ATHLETE_CPF_VIEW, entity: 'Athlete',\n    entityId: athlete.id, organizationId: athlete.organizationId, metadata: { via: 'reveal' }\n  });\n",
    para: ""
  },
  {
    nome: 'a recusa passa a deixar rastro de leitura que não houve',
    arquivo: ATLETA, suite: SUITE_CPF,
    de: "  assertCan(actor, 'athletes.read_sensitive', athlete.organizationId);\n  assertCan(actor, 'search.sensitive', athlete.organizationId);\n\n  await audit.record({",
    para: "  await audit.record({"
  },
  {
    // O número cru em vez do formatado. Parece cosmético e não é: quem
    // consome a resposta passa a receber um formato que nunca combinou.
    nome: 'o CPF sai sem formatação',
    arquivo: ATLETA, suite: SUITE_CPF,
    de: '  return { cpf: athlete.identity?.cpf ? formatCpf(athlete.identity.cpf) : null };',
    para: '  return { cpf: athlete.identity?.cpf ?? null };'
  },

  // ------------------------------------------- HISTÓRICO IMPORTADO
  {
    // O REVÍNCULO SILENCIOSO. Sem esta guarda, a carreira de uma pessoa muda
    // de dono por uma chamada — e o erro só aparece quando a prejudicada vai
    // ver o próprio histórico.
    nome: 'a identidade já vinculada a outro atleta aceita novo dono',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: "  if (identidade.athleteId) {\n    throw new AppError(409, 'EXTERNAL_ATHLETE_ALREADY_LINKED',",
    para: "  if (false) {\n    throw new AppError(409, 'EXTERNAL_ATHLETE_ALREADY_LINKED',"
  },
  {
    nome: 'as sugestões passam a incluir identidades que já têm dono',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: '    where: { organizationId: athlete.organizationId, athleteId: null },\n    include: INCLUDE,\n    orderBy: { createdAt: \'desc\' },',
    para: '    where: { organizationId: athlete.organizationId },\n    include: INCLUDE,\n    orderBy: { createdAt: \'desc\' },'
  },
  {
    // A PISTA FRACA VESTIDA DE FORTE. Dizer "filiação + matrícula" quando só
    // o nome bateu é mentir para quem vai confirmar.
    nome: 'a pista por nome se apresenta como filiação + matrícula',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: '      matchedBy: casaFiliacao ? CHAVE_MATRICULA : \'NAME\',',
    para: '      matchedBy: CHAVE_MATRICULA,'
  },
  {
    nome: 'o aviso de homônimos some',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: '      homonimos: !casaFiliacao && porNome.length > 1',
    para: '      homonimos: false'
  },
  {
    nome: 'a identidade de outra organização deixa de ser recusada',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: '  if (!identidade || identidade.organizationId !== athlete.organizationId) {',
    para: '  if (!identidade) {'
  },
  {
    // A PERMISSÃO TROCADA POR UMA MAIS FRACA. `athletes.read_sensitive` é de
    // quem CONSULTA o cadastro; vincular histórico esportivo é de quem revisa
    // importação.
    nome: 'vincular passa a exigir só leitura de cadastro',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: "  assertCan(actor, 'musclewar.review', athlete.organizationId);\n\n  const identidade = await prisma.externalAthlete.findUnique({",
    para: "  assertCan(actor, 'athletes.read_sensitive', athlete.organizationId);\n\n  const identidade = await prisma.externalAthlete.findUnique({"
  },
  {
    nome: 'repetir o vínculo deixa de ser inócuo e vira conflito',
    arquivo: MUSCLEWAR, suite: SUITE_HISTORICO,
    de: '  if (identidade.athleteId && identidade.athleteId === athlete.id) {',
    para: '  if (false) {'
  },

  // ------------------------------------------ MENSAGEM DE ABERTURA
  {
    // A JANELA QUE SÓ OLHA UMA PONTA. O recado vencido continua saindo, e
    // ninguém lembra de apagá-lo: é exatamente assim que um aviso de setembro
    // aparece em dezembro.
    nome: 'a validade ignora o fim da janela',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '    { OR: [{ endsAt: null }, { endsAt: { gte: agora } }] }',
    para: '    { OR: [{ endsAt: null }, { endsAt: { not: undefined } }] }'
  },
  {
    nome: 'a validade ignora o início da janela',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '    { OR: [{ startsAt: null }, { startsAt: { lte: agora } }] },',
    para: '    { OR: [{ startsAt: null }, { startsAt: { not: undefined } }] },'
  },
  {
    nome: 'o recado desativado volta a aparecer para o atleta',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '      organizationId: { in: organizacoes },\n      active: true,',
    para: '      organizationId: { in: organizacoes },'
  },
  {
    // `showOnce` DEIXA DE FECHAR. O mesmo aviso a cada acesso ensina o atleta
    // a fechá-lo sem ler — e o aviso seguinte, o que importava, morre junto.
    nome: 'o recado de uma vez só passa a aparecer sempre',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '    deveExibir: aviso.showOnce ? !aviso.reads.length : true',
    para: '    deveExibir: true'
  },
  {
    nome: 'marcar leitura deixa de ser idempotente',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '    skipDuplicates: true',
    para: '    skipDuplicates: false'
  },
  {
    // APAGAR O QUE JÁ FOI LIDO. A linha de leitura é o registro de que a
    // pessoa foi comunicada; apagar o recado apaga esse registro junto.
    nome: 'apagar passa a ser possível depois da primeira leitura',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '  if (aviso._count.reads > 0) {',
    para: '  if (false) {'
  },
  {
    nome: 'a auditoria da edição esquece quantas pessoas já tinham lido',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '    metadata: { campos: Object.keys(data), leiturasNoMomentoDaEdicao: atual._count.reads }',
    para: '    metadata: { campos: Object.keys(data), leiturasNoMomentoDaEdicao: 0 }'
  },
  {
    nome: 'a janela invertida deixa de ser recusada',
    arquivo: AVISO, suite: SUITE_AVISO,
    de: '  if (startsAt && endsAt && new Date(startsAt) > new Date(endsAt)) {',
    para: '  if (false) {'
  }
];

function rodarSuite(suite) {
  const saida = spawnSync('npx', ['vitest', 'run', suite], {
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
      process.stdout.write(`  ${mutante.nome.padEnd(62)} `);
      const passou = rodarSuite(mutante.suite);
      writeFileSync(alvo, original);

      if (!passou) { mortos.push(mutante.nome); console.log('morto'); continue; }

      // SOBREVIVER SENDO EQUIVALENTE é outra coisa, e o gate trata como outra
      // coisa. Mas se um mutante DECLARADO equivalente MORRE, a declaração
      // está errada — e isso reprova.
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

console.log('\n  MUTANTES DA FASE DO ATLETA — cada um roda a suíte que deveria matá-lo\n');
main();

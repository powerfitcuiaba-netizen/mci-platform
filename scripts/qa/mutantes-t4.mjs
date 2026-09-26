#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — T4: CONCORRÊNCIA DO RANKING, ATOMICIDADE E RLS.
//
// A correção do S4 são três linhas e a do S6 é uma migration. Correção pequena
// é a que volta mais fácil: basta alguém "simplificar" o `recompute_` ou
// reescrever uma política sem olhar o `WITH CHECK`. Cada mutante aqui é uma
// forma REAL de desfazer a decisão, e o veredito só vale com controle antes e
// controle depois — a restauração tem de devolver o verde, senão "MORREU"
// poderia ser arquivo corrompido em vez de garantia medida.
//
// S4  T4-M1  `recompute_` perde a trava da temporada
//     T4-M4  as temporadas do ajuste em lote deixam de ser ordenadas
//
// DOIS MUTANTES FORAM REMOVIDOS DESTE ARQUIVO, e a remoção é resultado.
//
// T4-M2 ("o importador perde a trava da temporada") e T4-M3 ("a trava do
// importador volta a ser só a do lote") SOBREVIVERAM na primeira execução. A
// investigação mostrou que não era lacuna de teste: a trava que a primeira
// versão da correção punha no início de `aplicarLote` era REDUNDANTE. A
// requisição é uma transação só, então o importador não commita nada sem antes
// passar pelo `recompute_`, que pede a chave. Pior que redundante, ela seguraria
// a chave da temporada durante a importação inteira — 100.000 linhas na FASE
// 13.6 —, bloqueando toda correção daquela temporada sem fechar janela nenhuma.
//
// A linha saiu do serviço, e com ela saíram os dois mutantes. T4-M1 cobre os
// dois caminhos: removendo a trava do `recompute_`, reprovam tanto o teste do
// recompute avulso quanto o da aplicação de lote.
//
// S6  T4-M5  `Comment` volta a `WITH CHECK (true)`
//     T4-M6  `Conversation` volta a `WITH CHECK (true)`
//     T4-M7  `ConversationMember` volta a `WITH CHECK (true)`
//     T4-M8  `Notification` volta a `WITH CHECK (true)`
//     T4-M9  `ConversationMember` recebe o espelho INGÊNUO do USING — a
//            correção "óbvia" que NÃO fecha o auto-ingresso
//
// T4-M4 é declarado EQUIVALENTE: a ordenação remove um deadlock que depende de
// duas invalidações em lote tocarem as MESMAS duas temporadas em ordens opostas,
// e nenhum teste da suíte monta esse cenário. Forçar uma morte nele seria
// inventar cobertura; a ordenação fica por construção, não por medição.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const URL_BANCO = 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';
const ENV = `NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 DATABASE_URL="${URL_BANCO}"`;

const SUITE_S4 = 'tests/t4-concorrencia-do-ranking.test.mjs';
const SUITE_S5 = 'tests/t4-atomicidade-da-adocao.test.mjs';
const SUITE_S6 = 'tests/t4-rls-with-check.test.mjs';

// --------------------------------------------------------------------------
// Mutantes de CÓDIGO
// --------------------------------------------------------------------------
const MUTANTES_DE_CODIGO = [
  {
    id: 'T4-M1',
    descricao: 'recompute_ perde a trava da temporada — o S4 original',
    suite: `${SUITE_S4} ${SUITE_S5}`,
    arquivo: 'src/services/rankingService.js',
    de: `  return prisma.$transaction(async tx => {
    await travarTemporada(tx, seasonId);
    return recomputarEm(tx, seasonId);
  }, OPCOES_TRANSACAO);`,
    para: '  return prisma.$transaction(tx => recomputarEm(tx, seasonId), OPCOES_TRANSACAO);'
  },
  {
    id: 'T4-M4',
    descricao: 'as temporadas do ajuste em lote deixam de ser ordenadas',
    suite: SUITE_S4,
    arquivo: 'src/services/rankingService.js',
    de: '  const temporadas = [...new Set(alvos.map(ponto => ponto.seasonId))].sort();',
    para: '  const temporadas = [...new Set(alvos.map(ponto => ponto.seasonId))];',
    esperado: 'SOBREVIVEU',
    porQue: 'EQUIVALENTE dentro desta suíte, e declarado. O deadlock que a ordenação '
      + 'remove exige DUAS invalidações em lote tocando as MESMAS duas temporadas em '
      + 'ordens opostas, no mesmo instante. Nenhum teste monta esse cenário, e montá-lo '
      + 'de forma determinística exigiria instrumentar o serviço. A ordenação é correção '
      + 'por construção — ordem total de aquisição — e não por medição. Forçar uma morte '
      + 'aqui seria inventar cobertura.'
  }
];

// --------------------------------------------------------------------------
// Mutantes de POLÍTICA (SQL aplicado e revertido)
// --------------------------------------------------------------------------
const AFROUXAR = (tabela, politica, cmd, usando) => `
DROP POLICY IF EXISTS ${politica} ON "${tabela}";
CREATE POLICY ${politica} ON "${tabela}"
  FOR ${cmd}
  USING (${usando})
  WITH CHECK (true);
`;

const USING_COMMENT = `mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId" AND p."authorId" = mci_current_profile_id())`;

const USING_MEMBRO = `"profileId" = mci_current_profile_id()
    OR EXISTS (SELECT 1 FROM "Conversation" c WHERE c.id = "ConversationMember"."conversationId"
               AND mci_current_profile_id() = ANY (c."participantIds"))`;

const MUTANTES_DE_POLITICA = [
  {
    id: 'T4-M5',
    descricao: 'Comment volta a WITH CHECK (true)',
    sql: AFROUXAR('Comment', 'comentario_alteracao', 'UPDATE', USING_COMMENT)
  },
  {
    id: 'T4-M6',
    descricao: 'Conversation volta a WITH CHECK (true)',
    sql: AFROUXAR('Conversation', 'conversa_atualizacao', 'UPDATE',
      'mci_current_profile_id() = ANY ("participantIds")')
  },
  {
    id: 'T4-M7',
    descricao: 'ConversationMember volta a WITH CHECK (true)',
    sql: AFROUXAR('ConversationMember', 'membro_participante', 'ALL', USING_MEMBRO)
  },
  {
    id: 'T4-M8',
    descricao: 'Notification volta a WITH CHECK (true) na política do dono',
    sql: AFROUXAR('Notification', 'notificacao_do_dono', 'ALL', '"userId" = mci_current_user_id()')
  },
  {
    id: 'T4-M9',
    descricao: 'ConversationMember recebe o espelho INGÊNUO do USING — a correção que não fecha',
    // É a armadilha da fase: espelhar o `USING` parece a correção certa, e aqui
    // NÃO é. A primeira alternativa (`profileId = ator`) é satisfeita por quem
    // insere a SI MESMO, então o auto-ingresso em conversa alheia continua
    // passando. Este mutante tem de morrer, senão o teste do ataque não mede
    // nada.
    sql: `
DROP POLICY IF EXISTS membro_participante ON "ConversationMember";
CREATE POLICY membro_participante ON "ConversationMember"
  FOR ALL
  USING (${USING_MEMBRO})
  WITH CHECK (${USING_MEMBRO});
`
  }
];

const MIGRATION = `${RAIZ}/prisma/migrations/20260925230000_t4_with_check_coerente/migration.sql`;

function psql(sql) {
  const arquivo = `/tmp/mutante-t4-${Date.now()}.sql`;
  writeFileSync(arquivo, sql);
  try {
    execSync(`PGPASSWORD=mci_local_dev psql -h 127.0.0.1 -U mci -d mci_test -v ON_ERROR_STOP=1 -f ${arquivo}`,
      { stdio: 'pipe', encoding: 'utf8' });
  } finally {
    rmSync(arquivo, { force: true });
  }
}

const restaurarPoliticas = () => psql(readFileSync(MIGRATION, 'utf8'));

function suitePassa(suite) {
  try {
    execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${suite}`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 1_800_000 });
    return { passou: true };
  } catch (erro) {
    const saida = `${erro.stdout ?? ''}`;
    const falhas = (saida.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? '?';
    return { passou: false, falhas };
  }
}

function rodarCodigo(mutante) {
  const caminho = `${RAIZ}/${mutante.arquivo}`;
  const backup = `${caminho}.mutante-bak`;
  copyFileSync(caminho, backup);
  try {
    const original = readFileSync(caminho, 'utf8');
    const ocorrencias = original.split(mutante.de).length - 1;
    if (ocorrencias !== 1) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: `o trecho aparece ${ocorrencias} vez(es)` };
    }
    writeFileSync(caminho, original.replace(mutante.de, mutante.para));
    if (readFileSync(caminho, 'utf8') === original) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: 'o arquivo não mudou depois da escrita' };
    }

    const r = suitePassa(mutante.suite);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    copyFileSync(backup, caminho);
    rmSync(backup, { force: true });
  }
}

function rodarPolitica(mutante) {
  try {
    psql(mutante.sql);
    const r = suitePassa(SUITE_S6);
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    restaurarPoliticas();
  }
}

console.log('=== MUTATION TESTING — T4 ===\n');

// CONTROLE ANTES: as três suítes verdes, senão todo "MORREU" abaixo é ruído.
for (const [rotulo, suite] of [['S4', SUITE_S4], ['S5', SUITE_S5], ['S6', SUITE_S6]]) {
  if (!suitePassa(suite).passou) {
    console.log(`CONTROLE ANTES FALHOU: a suíte ${rotulo} já está vermelha. Nada abaixo conclui nada.`);
    process.exit(1);
  }
}
console.log('CONTROLE ANTES: as suítes S4, S5 e S6 passam sem mutante.\n');

const resultados = [];
for (const mutante of MUTANTES_DE_CODIGO) {
  const r = rodarCodigo(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}
for (const mutante of MUTANTES_DE_POLITICA) {
  const r = rodarPolitica(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

// CONTROLE DEPOIS: código e políticas restaurados de fato?
const depois = ['S4', 'S5', 'S6'].map((rotulo, i) => {
  const suite = [SUITE_S4, SUITE_S5, SUITE_S6][i];
  return { rotulo, ...suitePassa(suite) };
});
const restauracaoOk = depois.every(d => d.passou);
console.log(`\nCONTROLE DEPOIS: ${restauracaoOk
  ? 'as três suítes voltam a passar — restauração íntegra.'
  : `FALHOU em ${depois.filter(d => !d.passou).map(d => d.rotulo).join(', ')}.`}`);

const divergentes = resultados.filter(r => r.veredito !== (r.esperado ?? 'MORREU'));
const mortos = resultados.filter(r => r.veredito === 'MORREU').length;
const equivalentes = resultados.filter(r => r.esperado === 'SOBREVIVEU');

console.log(`\n${mortos} morreram, ${equivalentes.length} equivalente(s) declarado(s), `
  + `${resultados.length - divergentes.length}/${resultados.length} conforme a expectativa`);

for (const e of equivalentes) {
  console.log(`\n${e.id} EQUIVALENTE — por que não pode morrer:\n  ${e.porQue}`);
}

if (divergentes.length) {
  console.log('\nDIVERGIRAM DA EXPECTATIVA — cada um exige explicação:');
  for (const d of divergentes) console.log(`  ${d.id}  esperado ${d.esperado ?? 'MORREU'}, deu ${d.veredito}`);
}

process.exitCode = divergentes.length || !restauracaoOk ? 1 : 0;

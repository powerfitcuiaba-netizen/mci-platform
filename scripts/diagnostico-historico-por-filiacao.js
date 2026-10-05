#!/usr/bin/env node
/**
 * DIAGNÓSTICO DO HISTÓRICO JÁ IMPORTADO — quem ainda não reencontrou o dono.
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * A regra do MCI é: a identidade do atleta é o par ENTIDADE + NÚMERO DE
 * FILIAÇÃO. Um resultado importado com os dois forma `AFF:<filiação>:<número>`
 * e reencontra o atleta no dia em que ele se cadastrar, sozinho, sem ninguém
 * clicar. Um resultado importado SEM eles forma `EXT:<fonte>:<resultado>` — uma
 * identidade por resultado, que o vínculo tardio não alcança nunca mais, porque
 * ele procura por chave exata.
 *
 * Isso aconteceu de verdade neste projeto: um arquivo cuja coluna de matrícula
 * o parser não lia, outro cuja filiação não foi declarada no lote. O estrago é
 * silencioso — a tela mostra "—" com fidelidade e ninguém percebe até o atleta
 * se cadastrar e não achar a própria carreira.
 *
 * Este script responde, antes de qualquer escrita: QUANTOS estão assim, e
 * quantos poderiam ser religados sem adivinhação nenhuma.
 *
 * O QUE ELE NÃO FAZ
 *
 * Não escreve. Nenhum INSERT, nenhum UPDATE, nenhum DELETE, nenhum vínculo,
 * nenhum backfill, nenhum recálculo. É leitura e relatório. A decisão de
 * consolidar é de quem lê — e é outra fase, com outro comando e outra
 * autorização.
 *
 * AS CINCO CLASSES
 *
 *   ALREADY_LINKED   a identidade já tem dono. Nada a fazer.
 *   MATCHABLE        tem entidade + número, e existe UM cadastro com esse par.
 *                    Religável sem adivinhar.
 *   AMBIGUOUS        tem entidade + número, e existe MAIS DE UM cadastro com
 *                    esse par. Não se escolhe por semelhança: é decisão humana.
 *   MISSING_NUMBER   não tem entidade ou não tem número. O nome NÃO substitui:
 *                    religar por nome é o erro que esta regra existe para
 *                    impedir. Precisa de reimportação com o dado certo.
 *   NO_CANDIDATE     tem o par, e ninguém se cadastrou com ele ainda. Não é
 *                    problema: é o caminho normal, e vai se resolver sozinho
 *                    quando o atleta aparecer.
 *
 * USO
 *
 *   node scripts/diagnostico-historico-por-filiacao.js --ator <userId> \
 *     [--organizacao <orgId>] [--filiacao NPC] [--json]
 *
 * POR QUE EXIGE UM ATOR
 *
 * `ExternalAthlete`, `ExternalResult` e `Athlete` têm política de leitura por
 * organização. Um `PrismaClient` cru não passa por `withUserContext` e não tem
 * `mci.user_id`: as consultas voltariam vazias e o relatório diria "não há
 * histórico órfão" quando o que houve foi "não consigo ver". São opostos, e
 * apareciam iguais. O contexto é o MESMO `set_config('mci.user_id', $1, true)`
 * de toda requisição autenticada: nenhum BYPASSRLS, nenhum SECURITY DEFINER,
 * nenhuma política afrouxada.
 *
 * SOBRE O QUE É IMPRESSO
 *
 * Nome de atleta sai, porque quem roda isto é o operador da federação que já os
 * vê na tela. CPF não sai e não é consultado. A DATABASE_URL não é impressa,
 * nem parcialmente.
 */
const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');
const { resolverAtor, listarOperadores } = require('./lib/ator');

const argumento = (nome, padrao = null) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : padrao;
};
const temBandeira = nome => process.argv.includes(`--${nome}`);

const linha = (rotulo, valor) => console.log(`  ${String(rotulo).padEnd(18)} ${valor}`);
const titulo = texto => console.log(`\n${texto}\n${'─'.repeat(texto.length)}`);

/**
 * Classifica UMA identidade externa. Função pura: recebe o que já foi lido e
 * devolve a classe, sem tocar no banco. É assim que ela pode ser testada sem
 * PostgreSQL, e é assim que a regra fica num lugar só.
 */
function classificar(identidade, cadastrosPorPar) {
  if (identidade.athleteId) return 'ALREADY_LINKED';
  if (!identidade.affiliationId || !identidade.affiliationNumber) return 'MISSING_NUMBER';

  const candidatos = cadastrosPorPar.get(`${identidade.affiliationId}:${identidade.affiliationNumber}`) ?? [];
  if (candidatos.length === 0) return 'NO_CANDIDATE';
  if (candidatos.length > 1) return 'AMBIGUOUS';
  return 'MATCHABLE';
}

const CLASSES = Object.freeze([
  'ALREADY_LINKED', 'MATCHABLE', 'AMBIGUOUS', 'MISSING_NUMBER', 'NO_CANDIDATE'
]);

async function diagnosticar({ actorId, organizacaoPedida, filiacaoCodigo }) {
  return withUserContext(actorId, async tx => {
    const ator = await tx.user.findUnique({
      where: { id: actorId },
      select: {
        id: true, role: true, serviceOrganizationId: true,
        memberships: { select: { organizationId: true } }
      }
    });
    if (!ator) throw new Error('Ator não encontrado, ou invisível sob a política de leitura.');

    // A organização não mora em `User`: vem dos vínculos. Com mais de um, o
    // script PARA e pede — escolher sozinho relataria a organização errada.
    const vinculadas = [...new Set(ator.memberships.map(m => m.organizationId))];
    const organizationId = organizacaoPedida
      ?? ator.serviceOrganizationId
      ?? (vinculadas.length === 1 ? vinculadas[0] : null);
    if (!organizationId) {
      throw new Error(vinculadas.length
        ? `O ator tem ${vinculadas.length} organizações. Informe --organizacao.`
        : 'O ator não tem organização vinculada. Informe --organizacao.');
    }

    let filiacaoId = null;
    if (filiacaoCodigo) {
      const f = await tx.affiliation.findFirst({
        where: { organizationId, code: filiacaoCodigo.toUpperCase() },
        select: { id: true, code: true, name: true }
      });
      if (!f) throw new Error(`Não existe filiação com código ${filiacaoCodigo} nesta organização.`);
      filiacaoId = f.id;
    }

    const identidades = await tx.externalAthlete.findMany({
      where: { organizationId, ...(filiacaoId ? { affiliationId: filiacaoId } : {}) },
      select: {
        id: true, identityKey: true, displayName: true, athleteId: true,
        affiliationId: true, affiliationNumber: true,
        affiliation: { select: { code: true } },
        _count: { select: { externalResults: true, rankingPoints: true } }
      }
    });

    // Os cadastros que TÊM o par completo. Quem não tem não pode ser candidato
    // de ninguém: sem o par, não há correspondência inequívoca possível.
    const cadastros = await tx.athlete.findMany({
      where: {
        organizationId,
        affiliationId: { not: null },
        affiliationNumber: { not: null },
        ...(filiacaoId ? { affiliationId: filiacaoId } : {})
      },
      select: { id: true, fullName: true, affiliationId: true, affiliationNumber: true }
    });

    const cadastrosPorPar = new Map();
    for (const a of cadastros) {
      const chave = `${a.affiliationId}:${a.affiliationNumber}`;
      if (!cadastrosPorPar.has(chave)) cadastrosPorPar.set(chave, []);
      cadastrosPorPar.get(chave).push(a);
    }

    const porClasse = Object.fromEntries(CLASSES.map(c => [c, []]));
    for (const identidade of identidades) {
      const classe = classificar(identidade, cadastrosPorPar);
      const candidatos = cadastrosPorPar.get(`${identidade.affiliationId}:${identidade.affiliationNumber}`) ?? [];
      porClasse[classe].push({
        identityKey: identidade.identityKey,
        nomeDaOrigem: identidade.displayName,
        entidade: identidade.affiliation?.code ?? null,
        numeroDeFiliacao: identidade.affiliationNumber,
        resultados: identidade._count.externalResults,
        lancamentos: identidade._count.rankingPoints,
        candidatos: candidatos.map(c => ({ id: c.id, fullName: c.fullName }))
      });
    }

    return { organizationId, filiacao: filiacaoCodigo ?? 'TODAS', total: identidades.length, porClasse };
  });
}

async function principal() {
  if (temBandeira('listar-operadores')) {
    const contas = await listarOperadores();
    titulo(`CONTAS QUE PODEM SER O ATOR — ${contas.length}`);
    for (const c of contas) {
      const orgs = c.memberships.map(m => `${m.organization.name} (${m.role})`).join(', ') || 'sem vínculo';
      console.log(`\n  ${c.email}`);
      linha('  nome', c.name ?? '—');
      linha('  papel', c.role);
      linha('  organizações', orgs);
    }
    console.log('\n  Use o e-mail: --email <o seu>.\n');
    return;
  }

  // O ator por e-mail, pelo mesmo motivo do outro diagnóstico: a interface não
  // mostra o UUID, e caçá-lo na mão transforma investigação em obstáculo.
  let ator;
  try {
    ator = await resolverAtor({ ator: argumento('ator'), email: argumento('email') });
  } catch (erro) {
    console.error(`\n  ${erro.message}\n`);
    console.error('  Uso: node scripts/diagnostico-historico-por-filiacao.js --email <seu e-mail> [--filiacao NPC] [--json]');
    console.error('  Não lembra qual conta usar? node scripts/diagnostico-historico-por-filiacao.js --listar-operadores\n');
    process.exitCode = 2;
    return;
  }
  const actorId = ator.id;

  const relatorio = await diagnosticar({
    actorId,
    organizacaoPedida: argumento('organizacao'),
    filiacaoCodigo: argumento('filiacao')
  });

  if (temBandeira('json')) {
    console.log(JSON.stringify(relatorio, null, 2));
    return;
  }

  titulo('HISTÓRICO IMPORTADO — quem reencontra o dono, e quem não');
  linha('organização', relatorio.organizationId);
  linha('filiação', relatorio.filiacao);
  linha('identidades', relatorio.total);

  titulo('POR CLASSE');
  for (const classe of CLASSES) {
    linha(classe, relatorio.porClasse[classe].length);
  }

  for (const classe of ['MATCHABLE', 'AMBIGUOUS', 'MISSING_NUMBER']) {
    const itens = relatorio.porClasse[classe];
    if (!itens.length) continue;
    titulo(`${classe} — ${itens.length}`);
    for (const i of itens.slice(0, 50)) {
      const alvo = i.candidatos.length === 1 ? ` → ${i.candidatos[0].fullName}` : '';
      console.log(`  ${(i.entidade ?? '—')}/${(i.numeroDeFiliacao ?? '—')}  "${i.nomeDaOrigem}"  `
        + `${i.resultados} resultado(s), ${i.lancamentos} lançamento(s)${alvo}`);
    }
    if (itens.length > 50) console.log(`  … e mais ${itens.length - 50}.`);
  }

  console.log('\nNADA FOI ESCRITO. Este relatório é leitura; religar é outra fase.\n');
}

if (require.main === module) {
  principal()
    .catch(erro => { console.error(`FALHA: ${erro.message}`); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

module.exports = { classificar, CLASSES };

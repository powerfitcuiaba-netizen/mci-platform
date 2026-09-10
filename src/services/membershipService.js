const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const audit = require('./auditService');

// ============================================================================
// Vínculo do atleta com equipe — trava de integridade e histórico.
//
// REGRA HOMOLOGADA: um atleta tem no máximo UM vínculo ativo. O CPF (ou o
// número de filiação) identifica o atleta; a partir do vínculo, nenhuma outra
// equipe consegue reivindicá-lo.
//
// A trava é do BANCO: `AthleteTeamMembership.activeAthleteId` é único e só
// carrega valor enquanto o vínculo está aberto. Uma checagem em service não
// bastaria — entre o SELECT e o INSERT cabe a transação do outro treinador, e é
// exatamente esse o caso que a regra precisa impedir.
//
// Trocar de equipe não é apagar e recriar: o vínculo anterior é ENCERRADO com
// data, autor e motivo. O treinador não transfere sozinho; a transferência
// exige `athletes.transfer`, que é permissão de operador da Muscle Contest.
// ============================================================================

const INCLUIR_EQUIPE = {
  team: { select: { id: true, name: true, organizationId: true, company: { select: { id: true, name: true } } } }
};

async function vinculoAtivo(athleteId) {
  return prisma.athleteTeamMembership.findFirst({
    where: { athleteId, endedAt: null },
    include: INCLUIR_EQUIPE
  });
}

// Erros que, sob concorrência, significam "outra transação chegou primeiro".
// P2002 é a violação do índice único; os demais são o Postgres desistindo de
// uma das transações em conflito.
const ERROS_DE_CORRIDA = new Set(['P2002', 'P2034', '40001', '40P01']);

function recusaPorVinculoExistente(atual) {
  const equipe = atual.team?.name ?? 'outra equipe';
  const empresa = atual.team?.company?.name;

  throw new AppError(409, 'ATHLETE_ALREADY_LINKED',
    `Não é possível vincular este atleta. Ele está atualmente vinculado a ${equipe}`
    + `${empresa ? ` (${empresa})` : ''}. `
    + 'Para mudar de equipe, solicite a alteração ao operador da Muscle Contest.',
    { currentTeamId: atual.teamId, currentTeamName: equipe, currentCompanyName: empresa ?? null, since: atual.startedAt });
}

/**
 * Vincula o atleta a uma equipe. Recusa se já houver vínculo ativo — e a recusa
 * diz qual é a equipe atual, para que o treinador saiba a quem recorrer.
 */
async function link(athleteId, { teamId, reason = null }, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId }, select: { id: true, organizationId: true } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, organizationId: true, companyId: true } });
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'Equipe não encontrada');

  assertCan(actor, 'athletes.update', team.organizationId);
  if (team.organizationId !== athlete.organizationId) {
    throw new AppError(422, 'TEAM_OTHER_ORGANIZATION', 'Equipe de outra organização');
  }

  const atual = await vinculoAtivo(athleteId);
  if (atual) recusaPorVinculoExistente(atual);

  return criarVinculo(athlete, team, { reason, actor, acao: 'ATHLETE_TEAM_LINK' });
}

/**
 * Transfere o atleta de equipe: encerra o vínculo anterior e abre o novo, na
 * MESMA transação.
 *
 * Exige `athletes.transfer`, que o treinador não tem. É a diferença entre
 * "vincular um atleta livre" e "tirá-lo de outra equipe" — a segunda é decisão
 * do operador da Muscle Contest.
 */
async function transfer(athleteId, { teamId, reason }, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId }, select: { id: true, organizationId: true } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, organizationId: true, companyId: true } });
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'Equipe não encontrada');

  assertCan(actor, 'athletes.transfer', team.organizationId);
  if (team.organizationId !== athlete.organizationId) {
    throw new AppError(422, 'TEAM_OTHER_ORGANIZATION', 'Equipe de outra organização');
  }
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da transferência');

  const atual = await vinculoAtivo(athleteId);
  if (atual && atual.teamId === teamId) {
    throw new AppError(422, 'ALREADY_IN_TEAM', 'O atleta já está vinculado a esta equipe');
  }

  return criarVinculo(athlete, team, { reason, actor, anterior: atual, acao: 'ATHLETE_TEAM_TRANSFER' });
}

// Encerramento e criação acontecem juntos: sem isso, uma falha no meio deixaria
// o atleta sem equipe nenhuma.
async function criarVinculo(athlete, team, { reason, actor, anterior = null, acao }) {
  let vinculo;

  try {
    vinculo = await prisma.$transaction(async tx => {
      if (anterior) {
        await tx.athleteTeamMembership.update({
          where: { id: anterior.id },
          // `activeAthleteId` para NULL é o que libera a trava para o novo
          // vínculo — e o registro permanece, com data e autor do encerramento.
          data: { endedAt: new Date(), endedById: actor?.id ?? null, activeAthleteId: null, reason: reason ?? anterior.reason }
        });
      }

      const criado = await tx.athleteTeamMembership.create({
        data: {
          athleteId: athlete.id, teamId: team.id, companyId: team.companyId ?? null,
          reason, createdById: actor?.id ?? null, activeAthleteId: athlete.id
        },
        include: INCLUIR_EQUIPE
      });

      // Espelho do vínculo corrente, mantido só por aqui.
      await tx.athlete.update({ where: { id: athlete.id }, data: { teamId: team.id } });

      return criado;
    });
  } catch (error) {
    // Corrida perdida: outro vínculo entrou entre a checagem e a escrita. É a
    // trava do banco fazendo o que nenhuma checagem em service faria.
    //
    // Sob disputa o Postgres nem sempre acusa violação de unicidade (P2002):
    // duas transações simultâneas podem se enroscar e uma morrer por deadlock
    // ou conflito de escrita (P2034, 40P01, 40001). O sintoma difere, a
    // situação é a mesma — e quem decide não é o código do erro, é a
    // realidade: se há vínculo ativo agora, a recusa é 409, com o nome da
    // equipe atual. Só o que não se explica assim continua subindo.
    if (ERROS_DE_CORRIDA.has(error.code)) {
      // A consulta abaixo enriquece a recusa com o nome da equipe atual, mas
      // NÃO pode decidir a resposta — porque ela pode simplesmente não ter
      // como rodar.
      //
      // A requisição inteira corre dentro de UMA transação interativa, aberta
      // por `withUserContext` para carregar o `SET LOCAL mci.user_id` que faz
      // a RLS valer (ver src/config/prisma.js: o `$transaction` interno
      // reaproveita a transação da requisição, não abre outra nem cria
      // savepoint). Logo, quando o índice único recusa o INSERT, quem aborta
      // não é uma sub-transação: é a transação da requisição. Daí em diante
      // qualquer leitura nela é recusada pelo PostgreSQL com 25P02
      // (`current transaction is aborted, commands ignored until end of
      // transaction block`) — e esse erro subia daqui de dentro, escapava do
      // tratamento de corrida e virava 500 INTERNAL_ERROR.
      //
      // Não é intermitente: sempre que o INSERT perde a corrida, esta leitura
      // falha. Medido na CI real (run #81: P2002 às 22:52:55.062 e o SELECT
      // recusado 8ms depois) e reproduzido localmente em 60 de 60 disputas
      // com 4 concorrentes — 177 ocorrências, todas idênticas.
      const atual = await vinculoAtivo(athlete.id).catch(() => null);
      if (atual) recusaPorVinculoExistente(atual);

      // Sem o nome da equipe, a recusa é genérica — mas continua sendo 409.
      // Todo código deste conjunto significa a mesma coisa: outra transação
      // chegou primeiro. Reservar o 409 ao P2002 deixava P2034, 40001 e 40P01
      // caindo em erro interno.
      throw new AppError(409, 'ATHLETE_ALREADY_LINKED', 'Este atleta já possui vínculo ativo com uma equipe');
    }
    throw error;
  }

  await audit.record({
    actor, action: acao, entity: 'Athlete', entityId: athlete.id,
    organizationId: team.organizationId,
    metadata: { teamId: team.id, teamName: team.name, previousTeamId: anterior?.teamId ?? null, reason }
  });

  return vinculo;
}

/** Encerra o vínculo sem abrir outro. Também é ato de operador. */
async function unlink(athleteId, { reason }, actor) {
  const atual = await vinculoAtivo(athleteId);
  if (!atual) throw new AppError(404, 'NO_ACTIVE_MEMBERSHIP', 'Atleta não possui vínculo ativo');

  assertCan(actor, 'athletes.transfer', atual.team.organizationId);
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo do encerramento');

  const encerrado = await prisma.$transaction(async tx => {
    const linha = await tx.athleteTeamMembership.update({
      where: { id: atual.id },
      data: { endedAt: new Date(), endedById: actor?.id ?? null, activeAthleteId: null, reason },
      include: INCLUIR_EQUIPE
    });
    await tx.athlete.update({ where: { id: athleteId }, data: { teamId: null } });
    return linha;
  });

  await audit.record({
    actor, action: 'ATHLETE_TEAM_UNLINK', entity: 'Athlete', entityId: athleteId,
    organizationId: atual.team.organizationId, metadata: { teamId: atual.teamId, reason }
  });

  return encerrado;
}

/** Histórico completo: o passado do atleta não é apagado por uma troca. */
async function history(athleteId, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId }, select: { organizationId: true } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  assertCan(actor, 'athletes.read', athlete.organizationId);

  return prisma.athleteTeamMembership.findMany({
    where: { athleteId },
    include: INCLUIR_EQUIPE,
    orderBy: { startedAt: 'desc' }
  });
}

module.exports = { link, transfer, unlink, history, vinculoAtivo };

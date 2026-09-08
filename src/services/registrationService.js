const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { normalizeCpf } = require('../utils/cpf');
const { assertCan } = require('../utils/tenant');
const { acceptsRegistration } = require('../utils/eventStates');
const { athleteFor } = require('../utils/visibility');
const audit = require('./auditService');
const notifications = require('./notificationService');

// Idade completa na data de referência do evento. Usada na elegibilidade de
// classe; `null` quando a data de nascimento não foi informada.
function idadeEm(birthDate, referencia) {
  if (!birthDate) return null;
  const nascimento = new Date(birthDate);
  const alvo = new Date(referencia);
  let idade = alvo.getUTCFullYear() - nascimento.getUTCFullYear();
  const mes = alvo.getUTCMonth() - nascimento.getUTCMonth();
  if (mes < 0 || (mes === 0 && alvo.getUTCDate() < nascimento.getUTCDate())) idade -= 1;
  return idade;
}

// Regras de elegibilidade verificáveis com o que a plataforma conhece: sexo da
// categoria e faixa etária da classe. Peso e altura são conferidos na pesagem,
// não na inscrição — o atleta ainda vai treinar até lá.
function checarElegibilidade(athlete, competitionClass, event) {
  const problemas = [];

  const categoria = competitionClass.division.eventCategory.category;
  if (categoria.sex !== athlete.sex) {
    problemas.push(`Categoria ${categoria.name} é ${categoria.sex === 'MALE' ? 'masculina' : 'feminina'}`);
  }

  const referencia = event.startDate || new Date();
  const idade = idadeEm(athlete.birthDate, referencia);

  if (competitionClass.minAge != null || competitionClass.maxAge != null) {
    if (idade === null) {
      problemas.push(`Classe ${competitionClass.name} exige data de nascimento`);
    } else {
      if (competitionClass.minAge != null && idade < competitionClass.minAge) problemas.push(`Classe ${competitionClass.name} exige idade mínima ${competitionClass.minAge}`);
      if (competitionClass.maxAge != null && idade > competitionClass.maxAge) problemas.push(`Classe ${competitionClass.name} exige idade máxima ${competitionClass.maxAge}`);
    }
  }

  return problemas;
}

const INCLUDE_CLASSE = Object.freeze({
  division: { include: { eventCategory: { include: { category: true, event: { select: { id: true } } } } } }
});

/**
 * Fluxo de inscrição: CPF → localizar/criar perfil → confirmar filiação →
 * evento → categoria/divisão/classe → elegibilidade → registro.
 * Não existe pagamento neste fluxo.
 */
async function create(eventId, data, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  assertCan(actor, 'registrations.create', event.organizationId);

  if (!acceptsRegistration(event.status)) {
    throw new AppError(422, 'REGISTRATIONS_NOT_OPEN', `Evento em ${event.status} não aceita inscrições`);
  }

  const cpf = normalizeCpf(data.cpf);

  // Reconhecimento do atleta pelo CPF. Não existindo, o perfil é criado com o
  // que veio na inscrição — nunca em silêncio com dados incompletos.
  const identidade = await prisma.athleteIdentity.findUnique({
    where: { organizationId_cpf: { organizationId: event.organizationId, cpf } },
    select: { athleteId: true }
  });
  let athlete = identidade
    ? await prisma.athlete.findUnique({ where: { id: identidade.athleteId } })
    : null;

  let atletaCriado = false;
  if (!athlete) {
    const perfil = data.athlete || {};
    if (!perfil.fullName || !perfil.sex) {
      throw new AppError(422, 'ATHLETE_DATA_REQUIRED', 'CPF não cadastrado: informe ao menos nome completo e sexo para criar o perfil');
    }
    assertCan(actor, 'athletes.create', event.organizationId);

    // require-atomic-updates aponta reatribuição depois de await. Aqui não há
    // corrida: `athlete` é local a esta chamada e a sequência é estritamente
    // sequencial dentro de uma única requisição.
    // eslint-disable-next-line require-atomic-updates
    athlete = await prisma.athlete.create({
      data: {
        organizationId: event.organizationId,
        identity: { create: { organizationId: event.organizationId, cpf } },
        fullName: perfil.fullName,
        stageName: perfil.stageName ?? null,
        sex: perfil.sex,
        birthDate: perfil.birthDate ?? null,
        country: perfil.country || 'BR',
        state: perfil.state ?? null,
        city: perfil.city ?? null,
        phone: perfil.phone ?? null,
        email: perfil.email ?? null,
        affiliationId: data.affiliationId ?? perfil.affiliationId ?? null,
        teamId: perfil.teamId ?? null,
        coachId: perfil.coachId ?? null,
        gymId: perfil.gymId ?? null,
        createdById: actor.id
      }
    });
    atletaCriado = true;

    // O vínculo tem de nascer junto com o atleta. Sem isto, o perfil criado
    // pela inscrição teria a equipe no espelho (`Athlete.teamId`) e NENHUM
    // vínculo registrado — a trava de vínculo único ficaria desarmada
    // justamente para quem entra pela porta mais movimentada da plataforma, e
    // outra equipe poderia reivindicar o atleta sem receber a recusa.
    if (perfil.teamId) {
      const equipe = await prisma.team.findUnique({ where: { id: perfil.teamId }, select: { companyId: true } });
      await prisma.athleteTeamMembership.create({
        data: {
          athleteId: athlete.id, teamId: perfil.teamId, companyId: equipe?.companyId ?? null,
          createdById: actor?.id ?? null, activeAthleteId: athlete.id
        }
      });
    }

    await audit.record({ actor, action: audit.ACTIONS.ATHLETE_CREATE, entity: 'Athlete', entityId: athlete.id, organizationId: event.organizationId, metadata: { viaRegistration: true } });
  }

  // Filiação: a informada na inscrição, senão a do cadastro do atleta.
  const affiliationId = data.affiliationId ?? athlete.affiliationId ?? null;
  if (affiliationId) {
    const filiacao = await prisma.affiliation.findUnique({ where: { id: affiliationId } });
    if (!filiacao || filiacao.organizationId !== event.organizationId) {
      throw new AppError(422, 'AFFILIATION_INVALID', 'Filiação inválida para esta organização');
    }
    if (!filiacao.active) throw new AppError(422, 'AFFILIATION_INACTIVE', 'Filiação inativa');
  }

  // Classes: todas precisam pertencer a este evento.
  const classes = await prisma.competitionClass.findMany({
    where: { id: { in: data.classIds } },
    include: INCLUDE_CLASSE
  });

  if (classes.length !== data.classIds.length) throw new AppError(422, 'CLASS_INVALID', 'Uma ou mais classes não existem');

  const foraDoEvento = classes.filter(item => item.division.eventCategory.eventId !== eventId);
  if (foraDoEvento.length) throw new AppError(422, 'CLASS_NOT_IN_EVENT', 'Uma ou mais classes não pertencem a este evento');

  const problemas = classes.flatMap(item => checarElegibilidade(athlete, item, event));
  if (problemas.length) {
    const erro = new AppError(422, 'NOT_ELIGIBLE', 'Atleta não elegível para uma ou mais classes');
    erro.details = problemas.map(message => ({ message }));
    throw erro;
  }

  const existente = await prisma.registration.findUnique({
    where: { eventId_athleteId: { eventId, athleteId: athlete.id } }
  });
  if (existente && existente.status !== 'CANCELLED') {
    throw new AppError(409, 'ALREADY_REGISTERED', 'Atleta já inscrito neste evento');
  }

  const registration = await prisma.$transaction(async tx => {
    // Reinscrição depois de cancelamento reaproveita o registro em vez de
    // colidir na constraint (eventId, athleteId).
    const base = existente
      ? await tx.registration.update({
        where: { id: existente.id },
        data: { status: 'CONFIRMED', affiliationId, notes: data.notes ?? null, cancelledAt: null, cancelledById: null, cancelReason: null }
      })
      : await tx.registration.create({
        data: { eventId, athleteId: athlete.id, affiliationId, status: 'CONFIRMED', notes: data.notes ?? null, createdById: actor.id }
      });

    if (existente) await tx.registrationItem.deleteMany({ where: { registrationId: base.id } });

    await tx.registrationItem.createMany({
      data: data.classIds.map(classId => ({ registrationId: base.id, classId, status: 'CONFIRMED' }))
    });

    return tx.registration.findUnique({
      where: { id: base.id },
      include: {
        athlete: { include: { affiliation: true, team: true, coach: true, gym: true } },
        items: { include: { competitionClass: { include: INCLUDE_CLASSE } } },
        event: { select: { id: true, name: true, slug: true } }
      }
    });
  });

  await audit.record({
    actor, action: audit.ACTIONS.REGISTRATION_CREATE, entity: 'Registration', entityId: registration.id,
    organizationId: event.organizationId,
    metadata: { athleteId: athlete.id, eventId, classIds: data.classIds, athleteCreated: atletaCriado, affiliationId }
  });

  await notifications.notify({
    userIds: [athlete.userId, event.createdById],
    type: notifications.TYPES.REGISTRATION,
    title: 'Inscrição registrada',
    message: `${athlete.fullName} foi inscrito em ${event.name}.`,
    entityType: 'Registration', entityId: registration.id, link: `#events/${event.slug}`, actorId: actor.id
  });

  return { registration: serializar(registration, actor), athleteRecognized: !atletaCriado };
}

function serializar(registration, actor) {
  if (!registration) return null;
  return {
    id: registration.id,
    status: registration.status,
    notes: registration.notes,
    createdAt: registration.createdAt,
    cancelledAt: registration.cancelledAt,
    cancelReason: registration.cancelReason,
    event: registration.event,
    affiliation: registration.affiliation ?? null,
    athlete: athleteFor(registration.athlete, actor, registration.athlete?.organizationId),
    items: (registration.items || []).map(item => ({
      id: item.id,
      status: item.status,
      bibNumber: item.bibNumber,
      competitionClass: item.competitionClass && {
        id: item.competitionClass.id,
        name: item.competitionClass.name,
        code: item.competitionClass.code,
        division: item.competitionClass.division && {
          id: item.competitionClass.division.id,
          name: item.competitionClass.division.name,
          category: item.competitionClass.division.eventCategory?.category
        }
      }
    }))
  };
}

// Junta o atleta à inscrição numa segunda consulta, em vez de no `include`.
//
// `Athlete` está sob RLS e `Registration` não. No mesmo `include`, quando a
// política escondia o dono, o Prisma recebia null numa relação obrigatória e
// estourava — 500 onde deveria ser 404. E o 500 virava oráculo: no gate final,
// o diretor de outra federação recebia 200 na inscrição dele, 500 na alheia e
// 404 num id inventado. Três respostas distinguíveis dão um varredor de ids.
//
// Devolve null quando o RLS esconde o dono: sem visibilidade sobre o atleta,
// a inscrição não existe para este ator, e a resposta é a mesma de um id que
// nunca existiu.
async function comAtleta(registration, select) {
  if (!registration) return null;

  const athlete = await prisma.athlete.findUnique({
    where: { id: registration.athleteId },
    ...(select ? { select } : { include: { affiliation: true, team: true, coach: true, gym: true } })
  });
  if (!athlete) return null;

  return { ...registration, athlete };
}

async function cancel(id, { reason }, actor) {
  const registration = await comAtleta(
    await prisma.registration.findUnique({ where: { id }, include: { event: true } }),
    { id: true, fullName: true, userId: true }
  );
  if (!registration) throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Inscrição não encontrada');

  assertCan(actor, 'registrations.cancel', registration.event.organizationId);

  if (registration.status === 'CANCELLED') throw new AppError(422, 'ALREADY_CANCELLED', 'Inscrição já cancelada');

  // Depois de o resultado sair, cancelar apagaria a participação de um evento
  // já apurado.
  if (['RESULTS_PUBLISHED', 'CLOSED'].includes(registration.event.status)) {
    throw new AppError(422, 'EVENT_CLOSED', 'Evento com resultados publicados não permite cancelar inscrição');
  }

  const atualizada = await prisma.$transaction(async tx => {
    await tx.registrationItem.updateMany({ where: { registrationId: id }, data: { status: 'CANCELLED' } });
    return tx.registration.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor.id, cancelReason: reason }
    });
  });

  await audit.record({
    actor, action: audit.ACTIONS.REGISTRATION_CANCEL, entity: 'Registration', entityId: id,
    organizationId: registration.event.organizationId, metadata: { reason, athleteId: registration.athleteId }
  });

  await notifications.notify({
    userIds: [registration.athlete.userId, registration.event.createdById],
    type: notifications.TYPES.REGISTRATION_CANCELLED,
    title: 'Inscrição cancelada',
    message: `${registration.athlete.fullName} não participa mais de ${registration.event.name}.`,
    entityType: 'Registration', entityId: id, actorId: actor.id
  });

  return atualizada;
}

async function listByEvent(eventId, filtros, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  assertCan(actor, 'registrations.read', event.organizationId);

  const where = { eventId };
  if (filtros.status) where.status = filtros.status;
  if (filtros.classId) where.items = { some: { classId: filtros.classId } };
  if (filtros.search) {
    where.athlete = {
      OR: [
        { fullName: { contains: filtros.search, mode: 'insensitive' } },
        { stageName: { contains: filtros.search, mode: 'insensitive' } },
        { athleteNumber: { contains: filtros.search, mode: 'insensitive' } }
      ]
    };
  }

  const items = await prisma.registration.findMany({
    where,
    include: {
      athlete: { include: { affiliation: true, team: true, coach: true, gym: true } },
      affiliation: true,
      items: { include: { competitionClass: { include: INCLUDE_CLASSE } } },
      checkIn: true,
      weighIns: { orderBy: { measuredAt: 'desc' }, take: 1 },
      event: { select: { id: true, name: true, slug: true } }
    },
    orderBy: { createdAt: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: items.map(item => ({
      ...serializar(item, actor),
      checkIn: item.checkIn,
      lastWeighIn: item.weighIns[0] ?? null
    })),
    nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null
  };
}

async function findById(id, actor) {
  const registration = await comAtleta(
    await prisma.registration.findUnique({
      where: { id },
      include: {
        event: true,
        affiliation: true,
        items: { include: { competitionClass: { include: INCLUDE_CLASSE } } },
        checkIn: true,
        weighIns: { orderBy: { measuredAt: 'desc' } },
        credentials: true
      }
    }),
    null
  );
  if (!registration) throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Inscrição não encontrada');

  // O próprio atleta consulta a sua inscrição; qualquer outro precisa de
  // permissão no tenant do evento.
  const ehODono = registration.athlete.userId && registration.athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'registrations.read', registration.event.organizationId);

  return {
    ...serializar(registration, actor),
    checkIn: registration.checkIn,
    weighIns: registration.weighIns,
    credentials: registration.credentials
  };
}

module.exports = { create, cancel, listByEvent, findById, checarElegibilidade, idadeEm, serializar };

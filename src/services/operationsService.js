const crypto = require('crypto');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { isOperational } = require('../utils/eventStates');
const audit = require('./auditService');
const notifications = require('./notificationService');

// Operação de piso: check-in, pesagem, credenciamento e ordem de palco.
// Tudo aqui é auditável e registra operador, momento e dispositivo.

async function carregarInscricao(registrationId) {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: {
      event: true,
      athlete: { select: { id: true, fullName: true, userId: true, athleteNumber: true, identity: { select: { cpf: true } } } },
      items: { include: { competitionClass: { select: { id: true, name: true, minWeightGrams: true, maxWeightGrams: true } } } }
    }
  });
  if (!registration) throw new AppError(404, 'REGISTRATION_NOT_FOUND', 'Inscrição não encontrada');
  return registration;
}

// --------------------------------------------------------------------- CHECK-IN
async function checkIn(registrationId, data, actor) {
  const registration = await carregarInscricao(registrationId);
  assertCan(actor, 'checkin.operate', registration.event.organizationId);

  if (registration.status !== 'CONFIRMED') {
    throw new AppError(422, 'REGISTRATION_NOT_CONFIRMED', `Inscrição em ${registration.status} não faz check-in`);
  }
  if (!isOperational(registration.event.status)) {
    throw new AppError(422, 'EVENT_NOT_OPERATIONAL', `Evento em ${registration.event.status} não está em operação`);
  }
  if (!registration.items.length) {
    throw new AppError(422, 'NO_CLASSES', 'Inscrição sem classe registrada');
  }

  const existente = await prisma.checkIn.findUnique({ where: { registrationId } });
  if (existente && existente.status === 'CHECKED_IN') {
    throw new AppError(409, 'ALREADY_CHECKED_IN', 'Check-in já realizado');
  }

  const checkin = existente
    ? await prisma.checkIn.update({
      where: { registrationId },
      data: { status: 'CHECKED_IN', operatorId: actor.id, device: data.device ?? null, checkedInAt: new Date(), cancelledAt: null }
    })
    : await prisma.checkIn.create({
      data: { registrationId, operatorId: actor.id, device: data.device ?? null }
    });

  await audit.record({
    actor, action: audit.ACTIONS.CHECKIN, entity: 'CheckIn', entityId: checkin.id,
    organizationId: registration.event.organizationId,
    metadata: { registrationId, athleteId: registration.athleteId, device: data.device ?? null }
  });

  await notifications.notify({
    userIds: [registration.athlete.userId], type: notifications.TYPES.CHECKIN,
    title: 'Check-in confirmado', message: `${registration.athlete.fullName} — ${registration.event.name}.`,
    entityType: 'Registration', entityId: registrationId, actorId: actor.id
  });

  return checkin;
}

async function cancelCheckIn(registrationId, actor) {
  const registration = await carregarInscricao(registrationId);
  assertCan(actor, 'checkin.operate', registration.event.organizationId);

  const existente = await prisma.checkIn.findUnique({ where: { registrationId } });
  if (!existente || existente.status === 'CANCELLED') throw new AppError(404, 'CHECKIN_NOT_FOUND', 'Não há check-in ativo');

  const atualizado = await prisma.checkIn.update({
    where: { registrationId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), operatorId: actor.id }
  });

  await audit.record({ actor, action: audit.ACTIONS.CHECKIN, entity: 'CheckIn', entityId: atualizado.id, organizationId: registration.event.organizationId, metadata: { cancelled: true, registrationId } });
  return atualizado;
}

async function listCheckIns(eventId, filtros, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'checkin.read', event.organizationId);

  const registrations = await prisma.registration.findMany({
    where: {
      eventId,
      status: 'CONFIRMED',
      ...(filtros.search ? { athlete: { OR: [
        { fullName: { contains: filtros.search, mode: 'insensitive' } },
        { athleteNumber: { contains: filtros.search, mode: 'insensitive' } }
      ] } } : {})
    },
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, athleteNumber: true, photoKey: true } },
      checkIn: true,
      weighIns: { orderBy: { measuredAt: 'desc' }, take: 1 },
      items: { include: { competitionClass: { select: { id: true, name: true } } } }
    },
    orderBy: { athlete: { fullName: 'asc' } },
    take: filtros.limit
  });

  const total = registrations.length;
  const feitos = registrations.filter(item => item.checkIn?.status === 'CHECKED_IN').length;

  return { items: registrations, summary: { total, checkedIn: feitos, pending: total - feitos } };
}

// ---------------------------------------------------------------------- PESAGEM
async function weighIn(registrationId, data, actor) {
  const registration = await carregarInscricao(registrationId);
  assertCan(actor, 'weighin.operate', registration.event.organizationId);

  if (registration.status !== 'CONFIRMED') throw new AppError(422, 'REGISTRATION_NOT_CONFIRMED', 'Inscrição não confirmada');
  if (!isOperational(registration.event.status)) throw new AppError(422, 'EVENT_NOT_OPERATIONAL', `Evento em ${registration.event.status} não está em operação`);

  const weighin = await prisma.weighIn.create({
    data: {
      registrationId,
      weightGrams: data.weightGrams,
      heightCm: data.heightCm ?? null,
      operatorId: actor.id,
      device: data.device ?? null,
      notes: data.notes ?? null
    }
  });

  // A conferência de faixa é informativa: quem decide reclassificar é a
  // organização, com base no regulamento. O sistema aponta, não desclassifica.
  const foraDeFaixa = registration.items
    .filter(item => {
      const classe = item.competitionClass;
      if (classe.minWeightGrams != null && data.weightGrams < classe.minWeightGrams) return true;
      if (classe.maxWeightGrams != null && data.weightGrams > classe.maxWeightGrams) return true;
      return false;
    })
    .map(item => ({ classId: item.competitionClass.id, className: item.competitionClass.name }));

  await audit.record({
    actor, action: audit.ACTIONS.WEIGHIN, entity: 'WeighIn', entityId: weighin.id,
    organizationId: registration.event.organizationId,
    metadata: { registrationId, athleteId: registration.athleteId, weightGrams: data.weightGrams, outOfRange: foraDeFaixa }
  });

  return { weighIn: weighin, outOfRange: foraDeFaixa };
}

async function listWeighIns(registrationId, actor) {
  const registration = await carregarInscricao(registrationId);
  assertCan(actor, 'weighin.read', registration.event.organizationId);
  return prisma.weighIn.findMany({
    where: { registrationId },
    include: { operator: { select: { id: true, name: true } } },
    orderBy: { measuredAt: 'desc' }
  });
}

// --------------------------------------------------------------- CREDENCIAMENTO
// Código curto, legível e sorteado. Vira o conteúdo do QR Code impresso na
// credencial; a validação é sempre servidor-side, na leitura.
const gerarCodigo = () => `MCI-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

async function issueCredential(eventId, data, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'credentials.manage', event.organizationId);

  if (data.registrationId) {
    const registration = await prisma.registration.findUnique({ where: { id: data.registrationId } });
    if (!registration || registration.eventId !== eventId) throw new AppError(422, 'REGISTRATION_INVALID', 'Inscrição não pertence a este evento');
  }

  const credential = await prisma.credential.create({
    data: { eventId, type: data.type, holderName: data.holderName, registrationId: data.registrationId ?? null, code: gerarCodigo() }
  });

  await audit.record({
    actor, action: audit.ACTIONS.CREDENTIAL_ISSUE, entity: 'Credential', entityId: credential.id,
    organizationId: event.organizationId, metadata: { type: data.type, holderName: data.holderName }
  });

  return credential;
}

async function revokeCredential(id, actor) {
  const credential = await prisma.credential.findUnique({ where: { id }, include: { event: true } });
  if (!credential) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credencial não encontrada');
  assertCan(actor, 'credentials.manage', credential.event.organizationId);

  const atualizada = await prisma.credential.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  await audit.record({ actor, action: 'CREDENTIAL_REVOKE', entity: 'Credential', entityId: id, organizationId: credential.event.organizationId });
  return atualizada;
}

// Leitura de credencial. Uma credencial revogada ou de outro evento é recusada
// — e a recusa também vira scan registrado, que é o que permite investigar
// tentativa de entrada indevida.
async function scanCredential(eventId, { code, gate }, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'credentials.scan', event.organizationId);

  const credential = await prisma.credential.findUnique({
    where: { code },
    include: { registration: { include: { athlete: { select: { id: true, fullName: true, athleteNumber: true, photoKey: true } }, checkIn: true } } }
  });

  if (!credential) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'Credencial não encontrada');

  let accepted = true;
  let reason = null;

  if (credential.eventId !== eventId) { accepted = false; reason = 'Credencial de outro evento'; }
  else if (credential.status !== 'ACTIVE') { accepted = false; reason = 'Credencial revogada'; }

  const scan = await prisma.credentialScan.create({
    data: { credentialId: credential.id, gate: gate ?? null, scannedById: actor.id, accepted, reason }
  });

  await audit.record({
    actor, action: audit.ACTIONS.CREDENTIAL_SCAN, entity: 'Credential', entityId: credential.id,
    organizationId: event.organizationId, metadata: { accepted, reason, gate: gate ?? null }
  });

  return {
    accepted,
    reason,
    scan,
    credential: {
      id: credential.id,
      type: credential.type,
      holderName: credential.holderName,
      status: credential.status,
      athlete: credential.registration?.athlete ?? null,
      checkedIn: credential.registration?.checkIn?.status === 'CHECKED_IN'
    }
  };
}

async function listCredentials(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'credentials.read', event.organizationId);

  return prisma.credential.findMany({
    where: { eventId },
    include: { _count: { select: { scans: true } } },
    orderBy: [{ type: 'asc' }, { holderName: 'asc' }]
  });
}

// -------------------------------------------------------------- ORDEM DE PALCO
async function createBatch(eventId, data, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'stage.manage', event.organizationId);

  const classe = await prisma.competitionClass.findUnique({
    where: { id: data.classId },
    include: { division: { include: { eventCategory: true } } }
  });
  if (!classe || classe.division.eventCategory.eventId !== eventId) {
    throw new AppError(422, 'CLASS_NOT_IN_EVENT', 'Classe não pertence a este evento');
  }

  return prisma.stageBatch.create({
    data: { eventId, classId: data.classId, name: data.name, scheduledAt: data.scheduledAt ?? null, sortOrder: data.sortOrder ?? 0 }
  });
}

async function setStageOrder(batchId, { items }, actor) {
  const batch = await prisma.stageBatch.findUnique({ where: { id: batchId }, include: { event: true } });
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', 'Bateria não encontrada');
  assertCan(actor, 'stage.manage', batch.event.organizationId);

  const ids = items.map(item => item.registrationItemId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, 'DUPLICATE_ITEM', 'Atleta repetido na ordem');

  const posicoes = items.map(item => item.position);
  if (new Set(posicoes).size !== posicoes.length) throw new AppError(422, 'DUPLICATE_POSITION', 'Posição repetida na ordem');

  // Todos os inscritos precisam ser da classe da bateria.
  const registrationItems = await prisma.registrationItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, classId: true, status: true }
  });
  if (registrationItems.length !== ids.length) throw new AppError(422, 'REGISTRATION_ITEM_INVALID', 'Inscrição inválida na ordem');
  if (registrationItems.some(item => item.classId !== batch.classId)) {
    throw new AppError(422, 'CLASS_MISMATCH', 'Há atleta de outra classe na ordem desta bateria');
  }
  if (registrationItems.some(item => item.status === 'CANCELLED')) {
    throw new AppError(422, 'REGISTRATION_CANCELLED', 'Há inscrição cancelada na ordem');
  }

  await prisma.$transaction(async tx => {
    await tx.stageOrder.deleteMany({ where: { batchId } });
    await tx.stageOrder.createMany({
      data: items.map(item => ({ batchId, registrationItemId: item.registrationItemId, position: item.position }))
    });
  });

  return listStageOrder(batchId, actor);
}

async function listStageOrder(batchId, actor) {
  const batch = await prisma.stageBatch.findUnique({ where: { id: batchId }, include: { event: true, competitionClass: true } });
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', 'Bateria não encontrada');
  assertCan(actor, 'stage.read', batch.event.organizationId);

  const orders = await prisma.stageOrder.findMany({
    where: { batchId },
    include: {
      registrationItem: {
        include: {
          registration: { include: { athlete: { select: { id: true, fullName: true, stageName: true, athleteNumber: true, photoKey: true } } } }
        }
      }
    },
    orderBy: { position: 'asc' }
  });

  return { batch, orders };
}

async function updateBatchStatus(batchId, { status }, actor) {
  const batch = await prisma.stageBatch.findUnique({ where: { id: batchId }, include: { event: true, competitionClass: true } });
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', 'Bateria não encontrada');
  assertCan(actor, 'stage.manage', batch.event.organizationId);

  const atualizada = await prisma.stageBatch.update({ where: { id: batchId }, data: { status } });

  if (status === 'CALLED') {
    await prisma.stageOrder.updateMany({ where: { batchId }, data: { status: 'CALLED', calledAt: new Date() } });

    const inscritos = await prisma.stageOrder.findMany({
      where: { batchId },
      select: { registrationItem: { select: { registration: { select: { athlete: { select: { userId: true } } } } } } }
    });

    await notifications.notify({
      userIds: inscritos.map(item => item.registrationItem.registration.athlete.userId).filter(Boolean),
      type: notifications.TYPES.STAGE_CALL,
      title: 'Chamada de palco',
      message: `${batch.name} — ${batch.competitionClass.name} foi chamada.`,
      entityType: 'StageBatch', entityId: batchId, actorId: actor.id
    });
  }

  await audit.record({ actor, action: 'STAGE_BATCH_STATUS', entity: 'StageBatch', entityId: batchId, organizationId: batch.event.organizationId, metadata: { from: batch.status, to: status } });

  return atualizada;
}

async function listBatches(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'stage.read', event.organizationId);

  return prisma.stageBatch.findMany({
    where: { eventId },
    include: {
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } },
      _count: { select: { orders: true } }
    },
    orderBy: [{ sortOrder: 'asc' }, { scheduledAt: 'asc' }]
  });
}

module.exports = {
  checkIn, cancelCheckIn, listCheckIns,
  weighIn, listWeighIns,
  issueCredential, revokeCredential, scanCredential, listCredentials,
  createBatch, setStageOrder, listStageOrder, updateBatchStatus, listBatches
};

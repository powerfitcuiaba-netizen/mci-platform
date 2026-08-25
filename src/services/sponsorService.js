const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const money = require('../utils/money');
const auditService = require('./auditService');

// Patrocínio é receita de contrato entre o evento e uma marca. Não passa por
// pedido, cupom ou pagamento de inscrição: são fluxos financeiros distintos e
// misturá-los tornaria o relatório de vendas indefensável.

const sponsorShape = {
  id: true, name: true, document: true, contactEmail: true, active: true, createdAt: true,
  _count: { select: { sponsorships: true } }
};

const sponsorshipShape = {
  id: true, status: true, amountCents: true, currency: true,
  startsAt: true, endsAt: true, notes: true, createdAt: true,
  sponsor: { select: { id: true, name: true, active: true } },
  tournament: { select: { id: true, name: true, status: true } }
};

const assertGestor = actor => {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode administrar patrocínios');
  }
};

async function createSponsor(data, actor) {
  assertGestor(actor);
  try {
    const sponsor = await prisma.sponsor.create({
      data: {
        name: String(data.name).trim(),
        document: data.document ? String(data.document).trim() : null,
        contactEmail: data.contactEmail ? String(data.contactEmail).trim().toLowerCase() : null,
        active: data.active ?? true
      },
      select: sponsorShape
    });
    await auditService.record({ actor, action: 'SPONSOR_CREATE', entity: 'Sponsor', entityId: sponsor.id, metadata: { name: sponsor.name } });
    return sponsor;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SPONSOR_ALREADY_EXISTS', 'Já existe patrocinador com este documento');
    throw error;
  }
}

async function listSponsors(actor) {
  assertGestor(actor);
  const items = await prisma.sponsor.findMany({ select: sponsorShape, orderBy: { name: 'asc' } });
  return { items };
}

async function createSponsorship(data, actor) {
  assertGestor(actor);

  const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (actor.role !== 'ADMIN' && tournament.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode vincular patrocínio a este campeonato');
  }

  const sponsor = await prisma.sponsor.findUnique({ where: { id: data.sponsorId } });
  if (!sponsor) throw new AppError(404, 'SPONSOR_NOT_FOUND', 'Patrocinador não encontrado');

  const amountCents = money.assertCents(data.amountCents ?? 0, 'valor do patrocínio');
  if (data.startsAt && data.endsAt && new Date(data.endsAt) < new Date(data.startsAt)) {
    throw new AppError(422, 'INVALID_PERIOD', 'Data final deve ser posterior à inicial');
  }

  try {
    const sponsorship = await prisma.sponsorship.create({
      data: {
        sponsorId: sponsor.id,
        tournamentId: tournament.id,
        status: data.status || 'ACTIVE',
        amountCents,
        currency: tournament.currency,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
        notes: data.notes || null
      },
      select: sponsorshipShape
    });
    await auditService.record({
      actor, action: 'SPONSORSHIP_CREATE', entity: 'Sponsorship', entityId: sponsorship.id,
      metadata: { sponsorId: sponsor.id, tournamentId: tournament.id, amountCents }
    });
    return sponsorship;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SPONSORSHIP_ALREADY_EXISTS', 'Este patrocinador já está vinculado ao campeonato');
    throw error;
  }
}

async function listSponsorships(actor, filtros = {}) {
  assertGestor(actor);
  const escopo = actor.role === 'ADMIN' ? {} : { tournament: { createdById: actor.id } };
  const items = await prisma.sponsorship.findMany({
    where: { AND: [escopo, filtros.tournamentId ? { tournamentId: filtros.tournamentId } : {}] },
    select: sponsorshipShape,
    orderBy: { createdAt: 'desc' }
  });
  const totalCents = items.filter(item => item.status === 'ACTIVE').reduce((soma, item) => soma + item.amountCents, 0);
  return { items, totalCents };
}

module.exports = { createSponsor, listSponsors, createSponsorship, listSponsorships, sponsorShape, sponsorshipShape };

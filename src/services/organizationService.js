const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');
const { assertPermission, assertCan } = require('../utils/tenant');
const { isCrossTenant, organizationIdsOf } = require('../utils/permissions');
const audit = require('./auditService');

async function list(actor) {
  const where = isCrossTenant(actor) ? {} : { id: { in: organizationIdsOf(actor).length ? organizationIdsOf(actor) : ['__nenhuma__'] } };

  return prisma.organization.findMany({
    where,
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, slug: true, timezone: true, active: true, createdAt: true,
      // O ESTADO DO AUTOCADASTRO PRECISA SER VISÍVEL.
      //
      // A federação decide se recebe pedido espontâneo, e o campo nasce
      // FECHADO por padrão. Sem ele na listagem, não havia como saber se
      // estava aberto ou fechado sem consultar o banco — e a tela do atleta
      // dizia só "Nenhuma entidade de filiação ativa está disponível",
      // que não aponta para a causa.
      selfRegistrationOpen: true,
      _count: { select: { members: true, athletes: true, events: true } }
    }
  });
}

// Classes do Campeonato Brasileiro. `superOverallEligible` é o que separa
// "pontua no campeonato" de "conta para o Super Overall anual" — e é atributo
// do dado, não condição escrita no motor.
const CLASSES_DO_CAMPEONATO = Object.freeze([
  { code: 'ESTREANTE', name: 'Estreante', superOverallEligible: false, sortOrder: 10 },
  { code: 'NOVICE', name: 'Novice', superOverallEligible: false, sortOrder: 20 },
  { code: 'OPEN', name: 'Open', superOverallEligible: true, sortOrder: 30 },
  { code: 'MASTER', name: 'Master', superOverallEligible: false, sortOrder: 40 }
]);

async function create(data, actor) {
  assertPermission(actor, 'organizations.manage');

  const existente = await prisma.organization.findUnique({ where: { slug: data.slug } });
  if (existente) throw new AppError(409, 'SLUG_IN_USE', 'Já existe uma organização com este slug');

  const organization = await prisma.organization.create({
    data: { name: data.name, slug: data.slug, timezone: data.timezone || config.defaultTimezone }
  });

  // Quem cria entra como ADMIN da organização — do contrário criaria um tenant
  // ao qual não teria acesso.
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: actor.id, role: 'ADMIN' } });

  // Catálogo de classes do Campeonato Brasileiro, já com a REGRA HOMOLOGADA:
  // as quatro pontuam, e só a OPEN alimenta o Super Overall anual. Entram como
  // DADO editável — o operador acrescenta, renomeia e desativa classes sem que
  // o motor de pontuação mude.
  await prisma.classCatalog.createMany({
    // `displayName` nasce igual ao nome: `code` é identidade técnica e
    // `displayName` é o que a tela mostra, e as duas colunas precisam estar
    // preenchidas desde o primeiro dia para que a tela nunca dependa de um
    // fallback. As organizações anteriores a esta coluna continuam com ela
    // nula, e a leitura cai em `name` — não são reescritas.
    data: CLASSES_DO_CAMPEONATO.map(classe => ({ organizationId: organization.id, displayName: classe.name, ...classe }))
  });

  await audit.record({ actor, action: 'ORGANIZATION_CREATE', entity: 'Organization', entityId: organization.id, organizationId: organization.id, metadata: { slug: data.slug } });

  return organization;
}

async function findById(id, actor) {
  assertCan(actor, 'organizations.read', id);

  const organization = await prisma.organization.findUnique({
    where: { id },
    include: {
      members: { include: { user: { select: { id: true, name: true, email: true, role: true, status: true } } } },
      _count: { select: { athletes: true, events: true, seasons: true, affiliations: true } }
    }
  });
  if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');
  return organization;
}

async function addMember(organizationId, data, actor) {
  assertCan(actor, 'users.manage', organizationId);

  // A organização precisa ser conferida como o usuário já era. Sem isto, o id
  // inexistente ia até o INSERT e voltava como violação de chave estrangeira —
  // 500, com o código do Prisma (P2003) no corpo da resposta, onde o usuário
  // inexistente na MESMA rota devolvia um 404 limpo.
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');

  const user = await prisma.user.findUnique({ where: { id: data.userId } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  try {
    const membership = await prisma.organizationMember.create({
      data: { organizationId, userId: data.userId, role: data.role }
    });

    await audit.record({
      actor, action: audit.ACTIONS.ROLE_CHANGE, entity: 'OrganizationMember', entityId: membership.id,
      organizationId, metadata: { userId: data.userId, role: data.role }
    });

    return membership;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'MEMBERSHIP_EXISTS', 'Usuário já tem este papel na organização');
    throw error;
  }
}

async function removeMember(organizationId, membershipId, actor) {
  assertCan(actor, 'users.manage', organizationId);

  const membership = await prisma.organizationMember.findUnique({ where: { id: membershipId } });
  if (!membership || membership.organizationId !== organizationId) {
    throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Vínculo não encontrado');
  }

  await prisma.organizationMember.delete({ where: { id: membershipId } });
  await audit.record({ actor, action: audit.ACTIONS.ROLE_CHANGE, entity: 'OrganizationMember', entityId: membershipId, organizationId, metadata: { removed: true, userId: membership.userId, role: membership.role } });

  return { success: true };
}

// A federação decide se recebe pedido espontâneo. É ato administrativo, com
// auditoria: abrir a porta torna as filiações dela descobríveis por qualquer
// visitante, e fechar tira todas de circulação de uma vez.
async function setSelfRegistration(id, aberto, actor) {
  assertCan(actor, 'organizations.manage', id);

  const organization = await prisma.organization.findUnique({ where: { id }, select: { id: true, selfRegistrationOpen: true } });
  if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');

  const atualizada = await prisma.organization.update({
    where: { id },
    data: { selfRegistrationOpen: aberto },
    select: { id: true, name: true, slug: true, active: true, selfRegistrationOpen: true }
  });

  await audit.record({
    actor, action: aberto ? 'ORGANIZATION_SELF_REGISTRATION_OPEN' : 'ORGANIZATION_SELF_REGISTRATION_CLOSE',
    entity: 'Organization', entityId: id, organizationId: id,
    metadata: { de: organization.selfRegistrationOpen, para: aberto }
  });

  return atualizada;
}

module.exports = { list, create, findById, addMember, removeMember, setSelfRegistration, CLASSES_DO_CAMPEONATO };

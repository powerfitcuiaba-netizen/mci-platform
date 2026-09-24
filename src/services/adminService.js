const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertPermission } = require('../utils/tenant');
const { sanitizeUser } = require('../utils/visibility');
const { isPrivileged } = require('../utils/roles');
const { isCrossTenant, organizationIdsOf } = require('../utils/permissions');
const audit = require('./auditService');

// Administração de contas: leitura, mudança de papel e de situação.

// Usuário não tem `organizationId` — pertence à plataforma, e pode participar de
// várias organizações. O escopo, então, é por MEMBRESIA COMPARTILHADA: quem não
// é cross-tenant enxerga apenas quem divide alguma organização consigo.
//
// É a mesma convenção que `organizationFilter` aplica ao resto do sistema
// ("quem é cross-tenant vê tudo; os demais veem apenas as organizações de que
// participam"), e que aqui faltava: `users.read` é permissão de EVENT_DIRECTOR
// também, então sem escopo o diretor de uma federação enumerava todos os
// usuários da plataforma, e-mail incluído.
// CONTA DE SERVIÇO NÃO É GENTE, E ESTA TELA ADMINISTRA GENTE.
//
// A conta de serviço da federação é membro da organização — precisa ser, é daí
// que `mci_operator_of` a reconhece. Sem este filtro ela aparecia na listagem
// de usuários de todo operador da federação, com papel e situação editáveis
// ao lado, como se fosse uma pessoa que alguém esqueceu de configurar.
//
// Não era escalonamento: `adminUserUpdate` só aceita `role` e `status`,
// `FEDERATION_SERVICE` está fora de `USER_ROLES` (e portanto do enum do Zod),
// `mci_operator_of` lê o papel da MEMBRESIA e não o global, e
// `contaDaOrganizacao` ignora `status`. Medido, um a um. Era uma ferramenta de
// administrar pessoas apontada para uma identidade técnica — e a próxima
// pessoa a mexer ali não teria como saber disso.
//
// O filtro vale INCLUSIVE para cross-tenant: nem o SUPER_ADMIN administra esta
// conta por aqui. Quem a cria e a mantém é `serviceAccountService`, e ele é o
// único lugar onde ela muda.
const SEM_CONTAS_DE_SERVICO = { isServiceAccount: false };

function escopoDeUsuarios(actor) {
  if (isCrossTenant(actor)) return { ...SEM_CONTAS_DE_SERVICO };

  const ids = organizationIdsOf(actor);
  // Sem vínculo nenhum a listagem é vazia, não irrestrita.
  return {
    ...SEM_CONTAS_DE_SERVICO,
    memberships: { some: { organizationId: { in: ids.length ? ids : ['__sem-organizacao__'] } } }
  };
}

async function listUsers(filtros, actor) {
  assertPermission(actor, 'users.read');

  const where = { ...escopoDeUsuarios(actor) };
  if (filtros.role) where.role = filtros.role;
  if (filtros.status) where.status = filtros.status;
  if (filtros.search) {
    where.OR = [
      { name: { contains: filtros.search, mode: 'insensitive' } },
      { email: { contains: filtros.search, mode: 'insensitive' } }
    ];
  }

  const items = await prisma.user.findMany({
    where,
    include: {
      memberships: { include: { organization: { select: { id: true, name: true, slug: true } } } },
      athlete: { select: { id: true } },
      socialProfile: { select: { id: true, handle: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return { items: items.map(sanitizeUser), nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

async function findUser(id, actor) {
  assertPermission(actor, 'users.read');

  const user = await prisma.user.findFirst({
    // `findFirst` com o escopo no where, e não `findUnique` seguido de
    // conferência: quem não pode ver simplesmente não encontra, e a resposta é
    // a mesma de um id inexistente — não dá para distinguir "não existe" de
    // "existe noutra federação".
    where: { id, ...escopoDeUsuarios(actor) },
    include: {
      memberships: { include: { organization: { select: { id: true, name: true, slug: true } } } },
      athlete: { select: { id: true, fullName: true, organizationId: true } },
      socialProfile: { select: { id: true, handle: true, displayName: true } }
    }
  });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  return sanitizeUser(user);
}

async function updateUser(id, data, actor) {
  assertPermission(actor, 'users.manage');

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  // 404, e não 403: para esta tela a conta de serviço não existe, e é a mesma
  // resposta que a listagem já dá ao omiti-la. Responder 403 confirmaria que o
  // id existe — e ensinaria que há uma categoria de conta escondida ali.
  if (user.isServiceAccount) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  // Ninguém altera o próprio papel ou situação. Verificado antes de tudo: é a
  // condição mais específica, e responder com ela deixa claro o motivo real da
  // recusa em vez de mandar o operador procurar uma permissão que não é o caso.
  if (id === actor.id && (data.role || data.status)) {
    throw new AppError(422, 'CANNOT_CHANGE_SELF', 'Não é possível alterar o próprio papel ou situação');
  }
  // Só um SUPER_ADMIN concede papel privilegiado: sem isso, quem tem
  // `users.manage` promoveria um terceiro e escaparia da própria alçada por
  // procuração.
  if (data.role && isPrivileged(data.role) && actor.role !== 'SUPER_ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Apenas SUPER_ADMIN concede papéis privilegiados');
  }

  const atualizado = await prisma.user.update({
    where: { id },
    data,
    include: { memberships: { include: { organization: { select: { id: true, name: true, slug: true } } } }, athlete: { select: { id: true } }, socialProfile: { select: { id: true, handle: true } } }
  });

  await audit.record({
    actor,
    action: data.role ? audit.ACTIONS.ROLE_CHANGE : 'USER_STATUS_CHANGE',
    entity: 'User', entityId: id,
    metadata: { from: { role: user.role, status: user.status }, to: data }
  });

  return sanitizeUser(atualizado);
}

module.exports = { listUsers, findUser, updateUser };

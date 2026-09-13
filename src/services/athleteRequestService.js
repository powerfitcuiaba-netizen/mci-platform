const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');
const { normalizeCpf, isValidCpf } = require('../utils/cpf');
const audit = require('./auditService');

// ============================================================================
// FILA DE PERFIL DE ATLETA.
//
// Separa PEDIR de CONCEDER. Quem acaba de criar conta não é operador de
// federação nenhuma e por isso não pode criar a própria linha de `Athlete` —
// a política `atleta_criacao` exige `mci_operator_of`. Em vez de afrouxá-la,
// o usuário registra um pedido; o operador da federação analisa e é ELE quem
// cria o atleta, com a permissão que sempre teve.
//
// O CPF fica no pedido só até a análise, protegido por RLS própria, e é
// apagado de lá na aprovação — ele passa a viver em `AthleteIdentity`.
// ============================================================================

// Meio-dia UTC, e não meia-noite: às 00:00Z a data já virou no Brasil e o
// nascimento apareceria um dia antes na tela. Aceita Date (o schema já
// converte) e string, porque o serviço é chamado dos dois jeitos.
const aoMeioDia = valor => {
  if (!valor) return null;
  if (valor instanceof Date) {
    return new Date(Date.UTC(valor.getUTCFullYear(), valor.getUTCMonth(), valor.getUTCDate(), 12));
  }
  return new Date(`${String(valor).slice(0, 10)}T12:00:00.000Z`);
};

const CAMPOS_PUBLICOS = Object.freeze({
  id: true, userId: true, organizationId: true, affiliationId: true, affiliationNumber: true,
  fullName: true, sex: true, birthDate: true, photoKey: true,
  status: true, rejectionReason: true, createdAt: true, reviewedAt: true, reviewedById: true, athleteId: true,
  affiliation: { select: { id: true, name: true, code: true, state: true } },
  user: { select: { id: true, name: true, email: true, city: true, state: true } }
});

// `cpf` está FORA de CAMPOS_PUBLICOS de propósito: a listagem da fila nunca o
// devolve. Ele só sai na tela de análise de um pedido específico, e só para
// quem tem permissão de ler dado sensível de atleta.
const cpfDoPedido = { ...CAMPOS_PUBLICOS, cpf: true };

async function criar(data, actor) {
  // A organização vem da FILIAÇÃO, resolvida no servidor. Aceitá-la do corpo
  // deixaria qualquer pessoa endereçar o pedido à federação que quisesse.
  const filiacao = await prisma.affiliation.findUnique({
    where: { id: data.affiliationId },
    select: { id: true, organizationId: true, active: true, name: true }
  });
  if (!filiacao) throw new AppError(422, 'AFFILIATION_INVALID', 'Entidade de filiação não encontrada');
  if (!filiacao.active) throw new AppError(422, 'AFFILIATION_INACTIVE', 'Entidade de filiação inativa');

  const cpf = normalizeCpf(data.cpf);
  if (!isValidCpf(cpf)) throw new AppError(422, 'INVALID_CPF', 'CPF inválido');

  // Um pedido em aberto por pessoa. O índice parcial no banco é a autoridade;
  // esta conferência existe para responder 409 em vez de erro de constraint.
  const emAberto = await prisma.athleteProfileRequest.findFirst({
    where: { userId: actor.id, status: 'PENDING' }, select: { id: true }
  });
  if (emAberto) throw new AppError(409, 'REQUEST_ALREADY_PENDING', 'Já existe uma solicitação sua aguardando análise');

  // NÃO existe pré-checagem de CPF já cadastrado aqui, e isso foi medido:
  // `AthleteIdentity` está sob RLS, e quem está pedindo não é operador da
  // federação — a consulta enxerga zero linhas e devolveria "não existe"
  // SEMPRE, inclusive quando existe. Uma verificação que não pode ver nada
  // não protege; ela só aparenta proteger, que é pior.
  //
  // Quem barra o duplicado é a unicidade de `AthleteIdentity`
  // (organizationId + cpf) no momento da aprovação, dentro da transação: se
  // outro atleta já tiver aquele CPF, a aprovação inteira volta atrás e o
  // pedido continua PENDING. Há teste provando exatamente esse caminho.

  const pedido = await prisma.athleteProfileRequest.create({
    data: {
      userId: actor.id,
      organizationId: filiacao.organizationId,
      affiliationId: filiacao.id,
      affiliationNumber: data.affiliationNumber,
      fullName: data.fullName,
      sex: data.sex,
      // `dataIso` já entrega um Date; quando vier string, o meio-dia UTC evita
      // que a data ande um dia para trás no fuso do Brasil.
      birthDate: aoMeioDia(data.birthDate),
      cpf,
      photoKey: data.photoKey || null
    },
    select: CAMPOS_PUBLICOS
  });

  // O CPF NÃO entra nos metadados: auditoria é lida por muita gente e guardar
  // documento em texto livre ali desfaz o isolamento que o resto do sistema
  // mantém.
  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_CREATE', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: filiacao.organizationId,
    metadata: { affiliationId: filiacao.id, affiliationNumber: data.affiliationNumber }
  });

  return pedido;
}

// A fila do operador. Escopada pela organização do ator — nunca por um
// `organizationId` que tenha vindo do cliente.
async function listar(filtros, actor) {
  const escopo = organizationFilter(actor, filtros.organizationId);
  assertCan(actor, 'athletes.manage', filtros.organizationId ?? escopo.organizationId);

  const where = { ...escopo };
  if (filtros.status) where.status = filtros.status;

  const items = await prisma.athleteProfileRequest.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {}),
    select: CAMPOS_PUBLICOS
  });

  return { items, nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

// O que o próprio solicitante vê. Sem CPF: ele já sabe o próprio documento, e
// devolvê-lo cria mais uma superfície por onde ele pode vazar.
async function meusPedidos(actor) {
  return prisma.athleteProfileRequest.findMany({
    where: { userId: actor.id },
    orderBy: { createdAt: 'desc' },
    select: CAMPOS_PUBLICOS
  });
}

async function carregarParaAnalise(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id }, select: cpfDoPedido });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');

  // Tenant conferido contra a organização DO PEDIDO, lida do banco. É o que
  // impede alcançar pedido de outra federação trocando o id na URL.
  assertCan(actor, 'athletes.read_sensitive', pedido.organizationId);
  return pedido;
}

async function aprovar(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id } });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');

  assertCan(actor, 'athletes.manage', pedido.organizationId);

  if (pedido.status !== 'PENDING') {
    throw new AppError(422, 'REQUEST_NOT_PENDING', `Solicitação já está ${pedido.status}`);
  }
  // Ninguém analisa o próprio pedido, nem sendo operador. É a separação mais
  // básica entre quem pede e quem concede.
  if (pedido.userId === actor.id) {
    throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', 'Você não pode analisar a própria solicitação');
  }
  if (!pedido.cpf) throw new AppError(422, 'REQUEST_WITHOUT_CPF', 'Solicitação sem CPF para vincular');

  // Toda a aprovação numa transação: atleta, documento, filiação e o desfecho
  // do pedido. Meio atleta criado seria pior que aprovação falhada — ficaria
  // um atleta sem CPF que ninguém encontra pela busca.
  const resultado = await prisma.$transaction(async tx => {
    const athlete = await tx.athlete.create({
      data: {
        organizationId: pedido.organizationId,
        userId: pedido.userId,
        fullName: pedido.fullName,
        sex: pedido.sex,
        birthDate: pedido.birthDate,
        affiliationId: pedido.affiliationId,
        affiliationNumber: pedido.affiliationNumber,
        photoKey: pedido.photoKey,
        createdById: actor.id
      }
    });

    await tx.athleteIdentity.create({
      data: { athleteId: athlete.id, organizationId: pedido.organizationId, cpf: pedido.cpf }
    });

    const atualizado = await tx.athleteProfileRequest.update({
      where: { id: pedido.id },
      data: {
        status: 'APPROVED',
        athleteId: athlete.id,
        reviewedAt: new Date(),
        reviewedById: actor.id,
        // O documento sai daqui: a partir de agora ele vive em
        // `AthleteIdentity`, que é onde a RLS de CPF o protege.
        cpf: null
      },
      select: CAMPOS_PUBLICOS
    });

    return { athlete, pedido: atualizado };
  });

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_APPROVE', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: { athleteId: resultado.athlete.id, affiliationId: pedido.affiliationId }
  });

  return resultado.pedido;
}

async function rejeitar(id, data, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id } });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');

  assertCan(actor, 'athletes.manage', pedido.organizationId);

  if (pedido.status !== 'PENDING') {
    throw new AppError(422, 'REQUEST_NOT_PENDING', `Solicitação já está ${pedido.status}`);
  }
  if (pedido.userId === actor.id) {
    throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', 'Você não pode analisar a própria solicitação');
  }

  const atualizado = await prisma.athleteProfileRequest.update({
    where: { id: pedido.id },
    data: {
      status: 'REJECTED',
      rejectionReason: data.reason,
      reviewedAt: new Date(),
      reviewedById: actor.id,
      // Recusado não precisa mais guardar o documento. A linha fica para
      // histórico; o CPF não.
      cpf: null
    },
    select: CAMPOS_PUBLICOS
  });

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_REJECT', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: { motivo: data.reason }
  });

  return atualizado;
}

// O solicitante desiste. Diferente de REJECTED, que é decisão do operador —
// os dois estados existem para que a fila conte a história certa.
async function cancelar(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id } });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  if (pedido.userId !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Esta solicitação não é sua');
  if (pedido.status !== 'PENDING') throw new AppError(422, 'REQUEST_NOT_PENDING', `Solicitação já está ${pedido.status}`);

  return prisma.athleteProfileRequest.update({
    where: { id: pedido.id },
    data: { status: 'CANCELLED', cpf: null },
    select: CAMPOS_PUBLICOS
  });
}

module.exports = { criar, listar, meusPedidos, carregarParaAnalise, aprovar, rejeitar, cancelar };

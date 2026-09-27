const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, assertPermission } = require('../utils/tenant');
const storage = require('./storageService');
const audit = require('./auditService');
const notifications = require('./notificationService');

// ============================================================================
// MÓDULO TREINADORES & EQUIPES — cadastro, análise central e autorização por
// federação.
//
// TRÊS DECISÕES APROVADAS MORAM AQUI, E NENHUMA DELAS É NEGOCIÁVEL NESTE
// ARQUIVO:
//
//   R-03  Quem aprova ou rejeita treinador é a administração CENTRAL da
//         MuscleContest. Nenhuma federação recebe isso por ter papel de
//         operador, e o treinador nunca muda o próprio estado.
//
//   R-04  O cadastro do treinador é GLOBAL e não se duplica por federação. Por
//         isso `Coach` não tem `organizationId`. Onde ele pode ATUAR é outra
//         pergunta, respondida por `CoachOrganization` — cadastro global não
//         concede acesso irrestrito.
//
//   R-05  O treinador vê dado ESPORTIVO, de filiação e de resultado dos atletas
//         vinculados a ele. Nunca documento, nunca CPF completo, nunca dado
//         financeiro, credencial ou informação médica. Documento de análise
//         cadastral não aparece no painel do treinador nem em exportação.
// ============================================================================

// A máquina de estados, escrita como dado e não como cadeia de `if`.
//
// Estado que não está aqui não é alcançável, e é isso que impede a invenção de
// transição no meio de um serviço. `CANCELLED` é terminal de propósito:
// cancelar é encerrar o cadastro, e ressuscitá-lo apagaria a diferença entre
// "voltou" e "nunca saiu".
const TRANSICOES = Object.freeze({
  PENDING: Object.freeze(['APPROVED', 'REJECTED']),
  // Rejeitado pode voltar para análise: o treinador corrige a documentação e
  // pede de novo. É o mesmo desenho do pedido de perfil de atleta.
  REJECTED: Object.freeze(['PENDING']),
  APPROVED: Object.freeze(['SUSPENDED', 'CANCELLED']),
  SUSPENDED: Object.freeze(['APPROVED', 'CANCELLED']),
  CANCELLED: Object.freeze([])
});

// O que o treinador vê de si mesmo. `documents` NÃO está aqui — R-05.
const SELECT_MEU_CADASTRO = Object.freeze({
  id: true, name: true, status: true, registration: true, bio: true,
  phone: true, email: true, userId: true,
  reviewedAt: true, rejectionReason: true, suspendedReason: true,
  createdAt: true, updatedAt: true,
  organizations: {
    select: {
      id: true, organizationId: true, status: true, grantedAt: true, revokedAt: true, reason: true,
      organization: { select: { id: true, name: true, slug: true } }
    }
  },
  teams: { select: { id: true, name: true, organizationId: true, city: true, state: true } }
});

// O que qualquer um pode ver do atleta pela mão do treinador: identidade
// esportiva e filiação. Sem CPF, sem documento, sem telefone, sem nascimento.
const SELECT_ATLETA_ESPORTIVO = Object.freeze({
  id: true, fullName: true, stageName: true, sex: true,
  status: true, proStatus: true,
  affiliationNumber: true,
  affiliation: { select: { id: true, name: true, code: true } },
  team: { select: { id: true, name: true } },
  organization: { select: { id: true, name: true } }
});

function assertTransicao(atual, destino) {
  if (atual === destino) {
    throw new AppError(422, 'COACH_STATUS_UNCHANGED', `O cadastro já está em ${destino}`);
  }
  if (!TRANSICOES[atual]?.includes(destino)) {
    throw new AppError(422, 'COACH_INVALID_TRANSITION',
      `Transição não permitida: ${atual} para ${destino}`);
  }
}

async function carregar(id) {
  const coach = await prisma.coach.findUnique({ where: { id } });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Treinador não encontrado');
  return coach;
}

/**
 * O cadastro do PRÓPRIO usuário como treinador.
 *
 * Nasce `PENDING` por R-03: quem aprova é a administração central, e ninguém
 * atua antes disso.
 *
 * POR QUE ISTO NÃO PRECISA DE `coaches.link_account`: aquela permissão, criada
 * na fase F2, protege o ato de amarrar o cadastro de técnico à conta de OUTRA
 * pessoa — `Coach.userId` é UNIQUE, então quem ocupa a vaga de uma conta
 * impede todos os demais, inclusive a federação do próprio técnico, e num
 * cadastro global isso atravessa federações. Aqui a vaga ocupada é a do
 * próprio autor, sobre a sua própria conta. Não há terceiro a bloquear, e
 * exigir permissão de administrador tornaria o autocadastro impossível.
 */
/**
 * O pedido de cadastro de Treinador (Equipe), feito pela própria conta.
 *
 * A GUARDA DE `coaches.read_own` NÃO É BUROCRACIA — ELA IMPEDE UM REGISTRO ÓRFÃO.
 *
 * Medido antes da correção: a rota exigia apenas sessão. Uma conta ATHLETE (ou
 * GYM, ou BRAND) criava o próprio `Coach` com 201 e, na releitura,
 * `GET /coaches/me` respondia 403 — porque `meuCadastro` exige
 * `coaches.read_own`, que só Treinador (Equipe) tem. O painel trata a falha como
 * "ainda não há cadastro" e devolve o formulário: a pessoa cadastrava de novo,
 * recebia 409 COACH_ALREADY_EXISTS, e nunca via o próprio pedido. Ficava no banco
 * um cadastro que ninguém consegue abrir, esperando análise central de uma conta
 * que não tem área de treinador.
 *
 * A recusa é fail closed e não amplia nada: quem já podia se cadastrar continua
 * podendo, e quem não tem a área deixa de criar registro que não pode ler. Trocar
 * de perfil é ato administrativo, e é por ali que a conta passa a ser treinadora.
 *
 * A guarda é de PERMISSÃO, e não de `role === 'COACH'`: o papel é um jeito de
 * ter a permissão, não a permissão. Um SUPER_ADMIN a tem por ter todas.
 */
async function autocadastro(data, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  assertPermission(actor, 'coaches.read_own');

  const existente = await prisma.coach.findFirst({ where: { userId: actor.id }, select: { id: true, status: true } });
  if (existente) {
    throw new AppError(409, 'COACH_ALREADY_EXISTS',
      'Esta conta já possui cadastro de treinador.',
      { coachId: existente.id, status: existente.status });
  }

  let coach;
  try {
    coach = await prisma.coach.create({
      data: {
        userId: actor.id,
        name: data.name,
        registration: data.registration ?? null,
        bio: data.bio ?? null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        status: 'PENDING'
      },
      select: SELECT_MEU_CADASTRO
    });
  } catch (error) {
    // A trava é do banco: entre a consulta acima e este INSERT cabe uma
    // segunda requisição da mesma conta, e é o índice único de `userId` que
    // decide, não o SELECT.
    if (error.code === 'P2002') {
      throw new AppError(409, 'COACH_ALREADY_EXISTS', 'Esta conta já possui cadastro de treinador.');
    }
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.COACH_REGISTER, entity: 'Coach', entityId: coach.id,
    metadata: { status: 'PENDING' }
  });

  return coach;
}

/** O treinador lendo o próprio cadastro. Sem documento — R-05. */
async function meuCadastro(actor) {
  assertPermission(actor, 'coaches.read_own');

  const coach = await prisma.coach.findFirst({ where: { userId: actor.id }, select: SELECT_MEU_CADASTRO });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  return coach;
}

/**
 * O treinador corrigindo dados de contato e apresentação.
 *
 * `status`, `reviewedAt`, `rejectionReason` e `suspendedReason` não entram aqui
 * de propósito: por R-03 o estado é decisão central, e aceitar o campo do corpo
 * seria devolver ao interessado a caneta que a decisão tirou dele.
 */
async function atualizarMeuCadastro(data, actor) {
  assertPermission(actor, 'coaches.read_own');

  const coach = await prisma.coach.findFirst({ where: { userId: actor.id }, select: { id: true, status: true } });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  if (coach.status === 'CANCELLED') {
    throw new AppError(422, 'COACH_CANCELLED', 'Cadastro encerrado. Procure a administração da Muscle Contest.');
  }

  const atualizado = await prisma.coach.update({
    where: { id: coach.id },
    data: {
      ...(data.name === undefined ? {} : { name: data.name }),
      ...(data.registration === undefined ? {} : { registration: data.registration }),
      ...(data.bio === undefined ? {} : { bio: data.bio }),
      ...(data.phone === undefined ? {} : { phone: data.phone }),
      ...(data.email === undefined ? {} : { email: data.email })
    },
    select: SELECT_MEU_CADASTRO
  });

  await audit.record({
    actor, action: audit.ACTIONS.COACH_UPDATE, entity: 'Coach', entityId: coach.id,
    metadata: { campos: Object.keys(data) }
  });

  return atualizado;
}

// ------------------------------------------------------- ANÁLISE CENTRAL (R-03)

/**
 * A fila de análise. `coaches.approve` é permissão central: não há
 * `organizationId` na pergunta porque não há catálogo de treinador por
 * federação — é o mesmo raciocínio que tirou `categories.manage` do diretor de
 * evento na fase F2.
 */
async function listarParaAnalise(filtros, actor) {
  assertPermission(actor, 'coaches.approve');

  return prisma.coach.findMany({
    where: {
      ...(filtros.status ? { status: filtros.status } : {}),
      ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {})
    },
    select: {
      id: true, name: true, status: true, registration: true, email: true, phone: true,
      createdAt: true, reviewedAt: true, rejectionReason: true, suspendedReason: true,
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { documents: true, teams: true, athletes: true, organizations: true } }
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(Number(filtros.limit) || 50, 200)
  });
}

// ---------------------------------------------- A LISTA DA FEDERAÇÃO (R-04)
//
// Quem autoriza a ATUAÇÃO é a federação; quem aprova o CADASTRO é a mesa
// central. A separação é de R-03 e R-04, e ela deixou um buraco operacional: a
// única lista de treinadores da tela era a fila de análise, que exige
// `coaches.approve`. O diretor de federação, que tem `coaches.authorize_org` e
// NÃO tem `coaches.approve`, ficava sem lista — e, sem lista, sem o botão de
// autorizar. Medido na homologação manual (passo F4): a rota de autorização
// respondia 200 para ele, e a tela não tinha por onde chamá-la.
//
// Esta é a lista dele, e ela é ESTREITA de propósito:
//
//   * só treinador com cadastro APROVADO — quem não passou pela mesa central
//     não aparece, e por isso a federação não descobre por aqui quem está em
//     análise, quem foi recusado nem quem está suspenso. R-03 continua inteira;
//   * só os campos necessários para decidir: nome, registro profissional e
//     cidade/estado, que o catálogo já publica a qualquer conta autenticada
//     (ver `partnerService.SELECT_CATALOGO_DE_TECNICOS`, achado A-13). Nada de
//     e-mail, telefone, documento, motivo de recusa, revisor ou elo com a conta
//     de usuário — R-05;
//   * a situação da autorização vem SÓ da federação pedida. O diretor não fica
//     sabendo onde mais aquele treinador atua, e isso é deliberado: `where`
//     filtra por `organizationId`, e a RLS de `CoachOrganization` confere de
//     novo com `mci_operator_of`.
const SELECT_PARA_AUTORIZACAO = Object.freeze({
  id: true, name: true, registration: true, city: true, state: true
});

async function listarParaAutorizacao(filtros, actor) {
  // O escopo é o da CONSULTA, e obrigatório no schema. `assertCan` com
  // organização nomeada é o que impede a soma de permissões de federações
  // alheias que `effectivePermissions` faz quando o escopo vem nulo.
  assertCan(actor, 'coaches.authorize_org', filtros.organizationId);

  const treinadores = await prisma.coach.findMany({
    where: {
      status: 'APPROVED',
      ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {})
    },
    select: SELECT_PARA_AUTORIZACAO,
    orderBy: { name: 'asc' },
    take: Math.min(Number(filtros.limit) || 50, 200)
  });
  if (!treinadores.length) return [];

  const autorizacoes = await prisma.coachOrganization.findMany({
    where: { organizationId: filtros.organizationId, coachId: { in: treinadores.map(item => item.id) } },
    select: { id: true, coachId: true, status: true, grantedAt: true, revokedAt: true }
  });
  const daFederacao = new Map(autorizacoes.map(linha => [linha.coachId, linha]));

  return treinadores.map(treinador => {
    const autorizacao = daFederacao.get(treinador.id) ?? null;
    return {
      ...treinador,
      authorization: autorizacao && {
        id: autorizacao.id, status: autorizacao.status,
        grantedAt: autorizacao.grantedAt, revokedAt: autorizacao.revokedAt
      }
    };
  });
}

/** O dossiê de análise. Aqui o documento APARECE — é a mesa da análise, não o painel do treinador. */
async function carregarParaAnalise(id, actor) {
  assertPermission(actor, 'coaches.approve');

  const coach = await prisma.coach.findUnique({
    where: { id },
    select: {
      ...SELECT_MEU_CADASTRO,
      user: { select: { id: true, name: true, email: true, status: true } },
      documents: {
        select: { id: true, kind: true, title: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
        orderBy: { createdAt: 'desc' }
      }
    }
  });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Treinador não encontrado');
  return coach;
}

// Transição de estado com trilha e aviso. Um ponto só para os cinco verbos:
// duplicar isso cinco vezes é como uma delas acaba sem auditoria.
async function transicionar(id, destino, { reason = null, acao, notificacao }, actor) {
  assertPermission(actor, 'coaches.approve');

  const coach = await carregar(id);
  assertTransicao(coach.status, destino);

  const atualizado = await prisma.coach.update({
    where: { id },
    data: {
      status: destino,
      reviewedById: actor.id,
      reviewedAt: new Date(),
      // Cada motivo mora no seu campo, e o campo é limpo quando deixa de
      // valer: um cadastro aprovado que ainda exibisse o motivo da rejeição
      // anterior contaria uma história falsa na tela.
      rejectionReason: destino === 'REJECTED' ? reason : null,
      suspendedReason: destino === 'SUSPENDED' ? reason : null
    },
    select: SELECT_MEU_CADASTRO
  });

  await audit.record({
    actor, action: acao, entity: 'Coach', entityId: id,
    metadata: { de: coach.status, para: destino, reason }
  });

  if (notificacao && coach.userId) {
    await notifications.notify({
      userIds: [coach.userId], actorId: actor.id,
      type: notificacao.type, title: notificacao.title, message: notificacao.message(reason),
      entityType: 'Coach', entityId: id, link: '/treinador'
    });
  }

  return atualizado;
}

const aprovar = (id, data, actor) => transicionar(id, 'APPROVED', {
  reason: data?.reason ?? null,
  acao: audit.ACTIONS.COACH_APPROVE,
  notificacao: {
    type: notifications.TYPES.COACH_APPROVED,
    title: 'Cadastro de treinador aprovado',
    message: () => 'A administração da Muscle Contest aprovou o seu cadastro de treinador.'
  }
}, actor);

const rejeitar = (id, data, actor) => {
  if (!data?.reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da rejeição');
  return transicionar(id, 'REJECTED', {
    reason: data.reason,
    acao: audit.ACTIONS.COACH_REJECT,
    notificacao: {
      type: notifications.TYPES.COACH_REJECTED,
      title: 'Cadastro de treinador não aprovado',
      message: motivo => `O seu cadastro de treinador não foi aprovado. Motivo: ${motivo}`
    }
  }, actor);
};

const suspender = (id, data, actor) => {
  if (!data?.reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da suspensão');
  return transicionar(id, 'SUSPENDED', {
    reason: data.reason,
    acao: audit.ACTIONS.COACH_SUSPEND,
    notificacao: {
      type: notifications.TYPES.COACH_SUSPENDED,
      title: 'Cadastro de treinador suspenso',
      message: motivo => `O seu cadastro de treinador foi suspenso. Motivo: ${motivo}`
    }
  }, actor);
};

const reativar = (id, data, actor) => transicionar(id, 'APPROVED', {
  reason: data?.reason ?? null,
  acao: audit.ACTIONS.COACH_REACTIVATE,
  notificacao: {
    type: notifications.TYPES.COACH_APPROVED,
    title: 'Cadastro de treinador reativado',
    message: () => 'A suspensão do seu cadastro de treinador foi encerrada.'
  }
}, actor);

const cancelar = (id, data, actor) => {
  if (!data?.reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo do encerramento');
  return transicionar(id, 'CANCELLED', { reason: data.reason, acao: audit.ACTIONS.COACH_CANCEL, notificacao: null }, actor);
};

// ----------------------------------------- AUTORIZAÇÃO POR FEDERAÇÃO (R-04)

/**
 * Autoriza o treinador global a atuar numa federação.
 *
 * `assertCan` e não `assertPermission`: a barreira de tenant importa aqui. Quem
 * autoriza atuação na federação A precisa pertencer à federação A — senão o
 * operador de uma federação povoa a outra.
 *
 * O cadastro tem de estar APROVADO antes (R-03). Autorizar atuação de quem a
 * administração central ainda não aprovou inverteria a ordem das duas decisões.
 */
async function autorizarOrganizacao(coachId, { organizationId, reason = null }, actor) {
  assertCan(actor, 'coaches.authorize_org', organizationId);

  const coach = await carregar(coachId);
  if (coach.status !== 'APPROVED') {
    throw new AppError(422, 'COACH_NOT_APPROVED',
      'Somente treinador com cadastro aprovado pela administração da Muscle Contest pode ser autorizado a atuar em uma federação.',
      { status: coach.status });
  }

  const organizacao = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  if (!organizacao) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');

  // Reautorizar é ATUALIZAR a linha, não empilhar outra: `@@unique([coachId,
  // organizationId])` existe para que o histórico de concessão não fique
  // ambíguo, e o upsert é o que respeita essa unicidade sob concorrência.
  const autorizacao = await prisma.coachOrganization.upsert({
    where: { coachId_organizationId: { coachId, organizationId } },
    create: { coachId, organizationId, status: 'APPROVED', grantedById: actor.id, grantedAt: new Date(), reason },
    update: { status: 'APPROVED', grantedById: actor.id, grantedAt: new Date(), revokedById: null, revokedAt: null, reason },
    select: {
      id: true, coachId: true, organizationId: true, status: true, grantedAt: true, reason: true,
      organization: { select: { id: true, name: true, slug: true } }
    }
  });

  await audit.record({
    actor, action: audit.ACTIONS.COACH_ORG_AUTHORIZE, entity: 'CoachOrganization', entityId: autorizacao.id,
    organizationId, metadata: { coachId, reason }
  });

  if (coach.userId) {
    await notifications.notify({
      userIds: [coach.userId], actorId: actor.id,
      type: notifications.TYPES.COACH_ORG_AUTHORIZED,
      title: 'Autorização para atuar em federação',
      message: `Você está autorizado a atuar em ${organizacao.name}.`,
      entityType: 'CoachOrganization', entityId: autorizacao.id, link: '/treinador'
    });
  }

  return autorizacao;
}

/** Revoga a atuação. O cadastro global permanece — é a autorização que cai. */
async function revogarOrganizacao(coachId, { organizationId, reason }, actor) {
  assertCan(actor, 'coaches.authorize_org', organizationId);
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da revogação');

  const atual = await prisma.coachOrganization.findUnique({
    where: { coachId_organizationId: { coachId, organizationId } },
    select: { id: true, status: true }
  });
  if (!atual) throw new AppError(404, 'COACH_ORG_NOT_FOUND', 'Autorização não encontrada');
  if (atual.status === 'REVOKED') throw new AppError(422, 'COACH_ORG_ALREADY_REVOKED', 'Autorização já está revogada');

  const revogada = await prisma.coachOrganization.update({
    where: { id: atual.id },
    data: { status: 'REVOKED', revokedById: actor.id, revokedAt: new Date(), reason },
    select: { id: true, coachId: true, organizationId: true, status: true, revokedAt: true, reason: true }
  });

  await audit.record({
    actor, action: audit.ACTIONS.COACH_ORG_REVOKE, entity: 'CoachOrganization', entityId: revogada.id,
    organizationId, metadata: { coachId, reason }
  });

  return revogada;
}

/**
 * O treinador ATIVO desta conta, com a autorização conferida para a federação
 * pedida. É a função que os outros serviços do módulo usam antes de aceitar
 * qualquer ato de treinador — cadastro aprovado E autorização viva.
 */
async function treinadorAtivoDaConta(actor, organizationId = null) {
  if (!actor) return null;

  const coach = await prisma.coach.findFirst({
    where: { userId: actor.id },
    select: {
      id: true, name: true, status: true, userId: true,
      organizations: { select: { organizationId: true, status: true } }
    }
  });
  if (!coach) return null;
  if (coach.status !== 'APPROVED') return { ...coach, autorizado: false, motivo: 'COACH_NOT_APPROVED' };

  if (!organizationId) return { ...coach, autorizado: true, motivo: null };

  const autorizacao = coach.organizations.find(item => item.organizationId === organizationId);
  if (!autorizacao || autorizacao.status !== 'APPROVED') {
    return { ...coach, autorizado: false, motivo: 'COACH_ORG_NOT_AUTHORIZED' };
  }
  return { ...coach, autorizado: true, motivo: null };
}

/**
 * A BARREIRA DE TENANT DO TREINADOR — e por que ela não pode ser `assertCan`.
 *
 * `assertCan` é `assertOrganization` MAIS `assertPermission`, e
 * `assertOrganization` pergunta a `OrganizationMember` se o ator pertence à
 * federação. O treinador NÃO tem linha em `OrganizationMember`: a autorização
 * dele é `CoachOrganization`, e isso é a decisão R-04 — identidade global,
 * atuação por federação, sem duplicar cadastro.
 *
 * MEDIDO: com `assertCan`, todo ato de treinador respondia 403, mesmo com
 * cadastro aprovado e autorização viva. A barreira não estava falhando — estava
 * perguntando à tabela errada.
 *
 * A regra aqui é: a permissão nomeada vale sempre; o TENANT é satisfeito por
 * QUALQUER das duas vias — ser membro da federação (operador, diretor) ou ter
 * autorização viva de treinador nela. Não é afrouxamento: são dois caminhos
 * legítimos para a mesma pergunta, e nenhum deles dispensa a permissão.
 *
 * A ordem importa para a MENSAGEM. Quem tem cadastro de treinador e não pode
 * atuar recebe a recusa que explica o que fazer (pedir autorização à
 * federação); quem não é treinador recebe a recusa de tenant de sempre.
 */
async function assertPodeAtuarNaOrganizacao(actor, permission, organizationId) {
  const { assertOrganization } = require('../utils/tenant');
  assertPermission(actor, permission);
  if (!organizationId) throw new AppError(422, 'ORGANIZATION_REQUIRED', 'Organização não informada');

  const { belongsToOrganization } = require('../utils/permissions');
  if (belongsToOrganization(actor, organizationId)) {
    // Membro da federação: a permissão é conferida NELA, e não só globalmente —
    // é o que impede um papel de uma federação de valer na outra.
    assertPermission(actor, permission, organizationId);
    return { via: 'ORGANIZACAO', coach: null };
  }

  const estado = await treinadorAtivoDaConta(actor, organizationId);
  if (estado?.autorizado) return { via: 'TREINADOR', coach: estado };
  if (estado) recusarTreinadorInativo(estado);

  // Nem membro nem treinador: a recusa de tenant de sempre, com a mesma
  // mensagem que o resto do sistema já usa.
  return assertOrganization(actor, organizationId);
}

/** Recusa padronizada quando o treinador existe mas não pode atuar ali. */
function recusarTreinadorInativo(estado) {
  if (!estado) {
    throw new AppError(403, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  }
  if (estado.motivo === 'COACH_NOT_APPROVED') {
    throw new AppError(403, 'COACH_NOT_APPROVED',
      'O seu cadastro de treinador ainda não está aprovado pela administração da Muscle Contest.',
      { status: estado.status });
  }
  throw new AppError(403, 'COACH_ORG_NOT_AUTHORIZED',
    'Você não está autorizado a atuar nesta federação. Solicite a autorização à federação.');
}

// -------------------------------------------------- A EQUIPE E OS ATLETAS (R-05)

/** As equipes do treinador desta conta. */
async function minhasEquipes(actor) {
  assertPermission(actor, 'teams.read_own');

  const coach = await prisma.coach.findFirst({ where: { userId: actor.id }, select: { id: true, status: true } });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');

  return prisma.team.findMany({
    where: { coachId: coach.id },
    select: {
      id: true, name: true, city: true, state: true, organizationId: true,
      organization: { select: { id: true, name: true, slug: true } },
      company: { select: { id: true, name: true } },
      _count: { select: { athletes: true } }
    },
    orderBy: { name: 'asc' }
  });
}

/**
 * Os atletas vinculados às equipes do treinador — SOMENTE dado esportivo e de
 * filiação (R-05).
 *
 * A projeção é explícita, e é isso que a torna auditável: `SELECT_ATLETA_ESPORTIVO`
 * não tem `cpf`, não tem documento, não tem telefone, não tem nascimento. Um
 * `include` genérico traria tudo o que a tabela ganhar depois — e é exatamente
 * assim que um campo sensível aparece num painel meses depois de ter sido
 * proibido.
 */
async function meusAtletas(filtros, actor) {
  assertPermission(actor, 'coaches.read_own');

  const coach = await prisma.coach.findFirst({ where: { userId: actor.id }, select: { id: true } });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');

  const equipes = await prisma.team.findMany({ where: { coachId: coach.id }, select: { id: true } });
  const ids = equipes.map(equipe => equipe.id);
  // A CONFERÊNCIA DA EQUIPE PEDIDA VEM ANTES DO ATALHO DE LISTA VAZIA.
  //
  // Medido na ordem inversa: o treinador sem equipe nenhuma recebia 200 com
  // lista vazia ao pedir `?teamId=` da equipe de OUTRO — o atalho respondia
  // antes da recusa. Não vazava dado, mas confirmava que o id existia e
  // dizia ao atacante que o caminho era válido.
  if (filtros?.teamId && !ids.includes(filtros.teamId)) {
    throw new AppError(403, 'FORBIDDEN', 'Equipe de outro treinador');
  }
  if (!ids.length) return [];

  // A lista sai do VÍNCULO ativo, e não de `Athlete.teamId`. O espelho existe e
  // é mantido, mas a verdade do vínculo está em `AthleteTeamMembership` — é
  // dela que sai a resposta.
  const vinculos = await prisma.athleteTeamMembership.findMany({
    where: { teamId: filtros?.teamId ? filtros.teamId : { in: ids }, endedAt: null },
    select: {
      id: true, startedAt: true, teamId: true,
      athlete: { select: SELECT_ATLETA_ESPORTIVO }
    },
    orderBy: { startedAt: 'desc' }
  });

  return vinculos.map(vinculo => ({
    membershipId: vinculo.id, teamId: vinculo.teamId, since: vinculo.startedAt, athlete: vinculo.athlete
  }));
}

// -------------------------------------------------------- DOCUMENTOS (R-05)

/**
 * Anexa documento de análise cadastral.
 *
 * O próprio treinador anexa; a equipe central de análise também. Quem LÊ é
 * apenas `coaches.approve` — por R-05 o documento não aparece no painel do
 * treinador, e a consequência prática é que nem o autor do envio o lista de
 * volta. A alternativa (deixar o dono listar) reabriria a superfície que a
 * decisão fechou.
 */
async function anexarDocumento(coachId, arquivo, data, actor) {
  const coach = await carregar(coachId);

  const ehODono = coach.userId && coach.userId === actor?.id;
  if (!ehODono) assertPermission(actor, 'coaches.approve');

  if (!arquivo) throw new AppError(422, 'FILE_REQUIRED', 'Arquivo obrigatório');
  if (!storage.isAllowedMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de arquivo não aceito: ${arquivo.mimeType}`);
  }

  const key = storage.buildKey(`coaches/${coachId}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const documento = await prisma.coachDocument.create({
    data: {
      coachId,
      kind: data?.kind || 'OTHER',
      title: data?.title || arquivo.originalName || 'Documento',
      fileName: arquivo.originalName || 'documento',
      mimeType: arquivo.mimeType,
      storageKey: key,
      sizeBytes: arquivo.buffer.length,
      uploadedById: actor.id
    },
    // `storageKey` fora da resposta de propósito: conhecer a chave não dá
    // acesso, mas também não há razão para entregá-la ao navegador.
    select: { id: true, kind: true, title: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true }
  });

  await audit.record({
    actor, action: audit.ACTIONS.COACH_DOCUMENT_UPLOAD, entity: 'CoachDocument', entityId: documento.id,
    metadata: { coachId, kind: documento.kind }
  });

  return documento;
}

async function listarDocumentos(coachId, actor) {
  assertPermission(actor, 'coaches.approve');
  await carregar(coachId);

  return prisma.coachDocument.findMany({
    where: { coachId },
    select: { id: true, kind: true, title: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
}

async function baixarDocumento(id, actor) {
  assertPermission(actor, 'coaches.approve');

  const documento = await prisma.coachDocument.findUnique({ where: { id } });
  if (!documento) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');
  if (!(await storage.exists(documento.storageKey))) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo indisponível');

  await audit.record({
    actor, action: audit.ACTIONS.COACH_DOCUMENT_DOWNLOAD, entity: 'CoachDocument', entityId: id,
    metadata: { coachId: documento.coachId }
  });

  return { stream: await storage.createReadStream(documento.storageKey), document: documento };
}

async function removerDocumento(id, actor) {
  assertPermission(actor, 'coaches.approve');

  const documento = await prisma.coachDocument.findUnique({ where: { id } });
  if (!documento) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  await prisma.coachDocument.delete({ where: { id } });
  await storage.descartar(documento.storageKey, { motivo: 'documento de treinador apagado', documentId: id });

  await audit.record({
    actor, action: audit.ACTIONS.COACH_DOCUMENT_DELETE, entity: 'CoachDocument', entityId: id,
    metadata: { coachId: documento.coachId }
  });

  return { success: true };
}

module.exports = {
  TRANSICOES,
  SELECT_ATLETA_ESPORTIVO,
  autocadastro, meuCadastro, atualizarMeuCadastro,
  listarParaAnalise,
  listarParaAutorizacao, carregarParaAnalise,
  aprovar, rejeitar, suspender, reativar, cancelar,
  autorizarOrganizacao, revogarOrganizacao,
  treinadorAtivoDaConta, recusarTreinadorInativo, assertPodeAtuarNaOrganizacao,
  minhasEquipes, meusAtletas,
  anexarDocumento, listarDocumentos, baixarDocumento, removerDocumento
};

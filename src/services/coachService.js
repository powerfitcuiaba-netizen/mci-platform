const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, assertPermission } = require('../utils/tenant');
const storage = require('./storageService');
const audit = require('./auditService');
const notifications = require('./notificationService');
const filiacaoOficial = require('./officialAffiliationService');
const imagem = require('./imagemService');

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
  reviewedAt: true, autoApprovedAt: true, rejectionReason: true, suspendedReason: true,
  // A CHAVE NÃO SAI, o BOOLEANO sai. A tela precisa saber se há foto (para o
  // aviso de regularização e para o gate do ranking); conhecer a chave não dá
  // acesso, mas também não há razão para entregá-la ao navegador — a foto é
  // servida por `GET /media/coaches/:id/photo`.
  photoKey: true,
  createdAt: true, updatedAt: true,
  organizations: {
    select: {
      id: true, organizationId: true, status: true, grantedAt: true, autoGrantedAt: true,
      revokedAt: true, reason: true,
      organization: { select: { id: true, name: true, slug: true } }
    }
  },
  teams: { select: { id: true, name: true, organizationId: true, city: true, state: true } }
});

// A CHAVE DO OBJETO NUNCA VAI PARA O NAVEGADOR — sai um booleano no lugar.
//
// A tela precisa saber SE existe foto: é isso que decide o aviso de
// regularização e o que o gate do ranking explica. Não precisa saber ONDE o
// objeto está. Conhecer a chave não dá acesso (a entrega é por
// `GET /media/coaches/:id/photo`, que resolve a chave no servidor), mas entregar
// caminho de armazenamento a um cliente é vazar topologia de graça.
const semChave = coach => {
  if (!coach) return coach;
  const { photoKey, ...resto } = coach;
  return { ...resto, hasPhoto: Boolean(photoKey) };
};

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
  return semChave(coach);
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
// ============================================================================
// A FOTO DE PERFIL DO TREINADOR — obrigatória para CONCLUIR o cadastro.
//
// A MENSAGEM É UMA CONSTANTE, e num lugar só: ela é decidida pelo produto, sai
// no autocadastro sem arquivo e sai também na troca sem arquivo. Duas cópias
// divergem na primeira correção que só uma delas receber.
//
// A VALIDAÇÃO NÃO É DE TELA. `isAllowedAvatarMime` compara o tipo, e
// `imagem.normalizar` RECODIFICA os bytes: o que vai para o armazenamento é um
// WebP produzido aqui, não o arquivo que chegou. Isso é o que faz um .php ou um
// .svg com script renomeado para .jpg não sobreviver — não há como "passar" um
// arquivo que não seja imagem de verdade, porque o decodificador falha antes.
// O teto de bytes é do middleware da rota (`MAX_AVATAR_BYTES`), que recusa antes
// de o corpo inteiro chegar à memória.
//
// NÃO DÁ PARA CONTORNAR PELA API: a obrigatoriedade está no serviço, que é o
// mesmo caminho da rota. Chamar `POST /coaches/self-register` sem o arquivo
// devolve 422 com esta frase, e nenhum `Coach` nasce.
// ============================================================================
const FOTO_OBRIGATORIA = 'O envio de uma foto de perfil é obrigatório para concluir '
  + 'seu cadastro e aparecer no ranking oficial de treinadores.';

async function normalizarFoto(arquivo) {
  if (!arquivo) throw new AppError(422, 'COACH_PHOTO_REQUIRED', FOTO_OBRIGATORIA);

  if (!storage.isAllowedAvatarMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE',
      `Foto de perfil aceita apenas ${Object.keys(storage.ALLOWED_AVATAR).join(', ')}`);
  }

  // Recorte quadrado em WebP, igual ao avatar social: a foto do treinador aparece
  // em lista e em ranking, e guardar o original de 8 MP para exibir em 40px é
  // desperdício em toda leitura.
  return imagem.normalizar(arquivo, 'avatar');
}

// A CHAVE É DERIVADA DA CONTA, e não do cadastro. No autocadastro o `Coach`
// ainda não existe quando o arquivo é gravado, e `userId` é único por cadastro
// de treinador (`@unique`), então serve aos dois momentos — nascimento e troca.
const chaveDaFoto = (userId, mimeType) => storage.buildKey(`coach-photos/${userId}`, mimeType);

/**
 * A TROCA DA FOTO, depois do cadastro.
 *
 * Não mexe em vínculo, ponto, resultado nem histórico: escreve UMA coluna. O
 * arquivo antigo só é descartado DEPOIS de o banco apontar para o novo — se a
 * ordem fosse inversa e a gravação falhasse, o cadastro ficaria apontando para
 * um arquivo que não existe mais. Órfão é muito melhor que foto quebrada.
 */
async function trocarMinhaFoto(arquivo, actor) {
  assertPermission(actor, 'coaches.read_own');

  const coach = await prisma.coach.findFirst({
    where: { userId: actor.id },
    select: { id: true, status: true, photoKey: true }
  });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  if (coach.status === 'CANCELLED') {
    throw new AppError(422, 'COACH_CANCELLED', 'Cadastro encerrado. Procure a administração da Muscle Contest.');
  }

  const normalizada = await normalizarFoto(arquivo);
  const key = chaveDaFoto(actor.id, normalizada.mimeType);
  await storage.saveBuffer(key, normalizada.buffer);

  const anterior = coach.photoKey;
  const atualizado = await prisma.coach.update({
    where: { id: coach.id },
    data: { photoKey: key },
    select: SELECT_MEU_CADASTRO
  });

  if (anterior && anterior !== key) {
    await storage.descartar(anterior, { motivo: 'foto de treinador substituida', coachId: coach.id });
  }

  await audit.record({
    actor, action: audit.ACTIONS.COACH_PHOTO_SET, entity: 'Coach', entityId: coach.id,
    metadata: { substituiu: Boolean(anterior) }
  });

  return semChave(atualizado);
}

/**
 * A chave para entrega, resolvida PELO SERVIDOR.
 *
 * A rota recebe o id do treinador e nada mais — não há parâmetro por onde passar
 * uma chave, que é o que impede trocar o id na URL de alcançar arquivo alheio.
 * Mesmo desenho de `Athlete.photoKey`.
 */
async function fotoParaEntrega(coachId) {
  const coach = await prisma.coach.findUnique({ where: { id: coachId }, select: { photoKey: true } });
  if (!coach || !coach.photoKey) throw new AppError(404, 'PHOTO_NOT_FOUND', 'Treinador sem foto');
  return coach.photoKey;
}

// ============================================================================
// A AUTORIZAÇÃO AUTOMÁTICA NA NPC.
//
// A NPC é a federação oficial ÚNICA da plataforma, e a decisão aprovada diz que
// quem conclui o cadastro de treinador já pode atuar nela — sem pedido, sem fila,
// sem espera. Fora da NPC nada mudou: autorização em outra federação continua
// sendo ato dela (R-04).
//
// TRÊS COISAS QUE ESTA FUNÇÃO NÃO FAZ, e cada ausência é deliberada:
//
//   * NÃO usa `upsert`. Se a linha já existe, o INSERT falha no índice único e a
//     função devolve o que existe SEM tocar nele. É isso que impede a
//     autorização automática de desfazer uma revogação da federação: revogada,
//     a linha existe — e alterá-la continua exigindo operador, pela política
//     `coach_org_alteracao`, que não foi mexida.
//   * NÃO inventa concedente. `grantedById` fica nulo e `autoGrantedAt` diz por
//     quê: a decisão foi da regra. A política do banco EXIGE essa combinação.
//   * NÃO derruba o cadastro quando a NPC não está provisionada. Numa instalação
//     nova a federação oficial pode não existir ainda, e recusar o cadastro por
//     causa disso puniria a pessoa errada. A ausência vai para a trilha.
// ============================================================================
async function autorizarNaFederacaoOficial(coach, actor) {
  const oficial = await filiacaoOficial.organizacaoOficial();

  if (!oficial) {
    await audit.record({
      actor, action: audit.ACTIONS.COACH_REGISTER, entity: 'Coach', entityId: coach.id,
      metadata: {
        automatic: true,
        federacaoOficial: null,
        reason: 'Federação oficial (NPC) não provisionada nesta instalação: o cadastro concluiu sem autorização automática.'
      }
    });
    return null;
  }

  const agora = new Date();
  let autorizacao;

  try {
    autorizacao = await prisma.coachOrganization.create({
      data: {
        coachId: coach.id,
        organizationId: oficial.id,
        status: 'APPROVED',
        grantedById: null,
        grantedAt: agora,
        autoGrantedAt: agora,
        reason: 'Autorização automática na federação oficial única (NPC).'
      },
      select: {
        id: true, coachId: true, organizationId: true, status: true,
        grantedAt: true, autoGrantedAt: true, reason: true,
        organization: { select: { id: true, name: true, slug: true } }
      }
    });
  } catch (error) {
    // Já havia linha para este par. Pode ser autorização viva ou REVOGADA, e nos
    // dois casos o certo é não mexer: a existente é a que vale.
    if (error.code === 'P2002') return null;
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.COACH_ORG_AUTHORIZE, entity: 'CoachOrganization',
    entityId: autorizacao.id, organizationId: oficial.id,
    metadata: {
      automatic: true,
      coachId: coach.id,
      reason: 'Autorização automática na federação oficial única (NPC), concedida pela regra no autocadastro.'
    }
  });

  return autorizacao;
}

async function autocadastro(data, actor, arquivo = null) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  assertPermission(actor, 'coaches.read_own');

  // A FOTO É CONFERIDA ANTES DE QUALQUER ESCRITA, e antes até da consulta de
  // duplicidade: recusar cedo é o que garante que nenhum `Coach` nasça sem foto
  // nem por engano nem por chamada direta à API.
  const foto = await normalizarFoto(arquivo);

  const existente = await prisma.coach.findFirst({ where: { userId: actor.id }, select: { id: true, status: true } });
  if (existente) {
    throw new AppError(409, 'COACH_ALREADY_EXISTS',
      'Esta conta já possui cadastro de treinador.',
      { coachId: existente.id, status: existente.status });
  }

  // ========================================================================
  // O CADASTRO NASCE APROVADO — a decisão que mudou R-03.
  //
  // R-03 dizia que só a administração central aprova cadastro de treinador. A
  // decisão nova retira a análise manual do caminho do cadastro NOVO: quem
  // preenche o formulário corretamente entra no sistema na hora, sem fila.
  //
  // O QUE ISSO **NÃO** CONCEDE, e é a metade que não mudou:
  //
  //   * atuar numa federação continua exigindo `CoachOrganization` concedida
  //     PELA FEDERAÇÃO — R-04, intacta. Treinador aprovado e sem autorização não
  //     recebe equipe, não convida atleta em federação nenhuma;
  //   * as permissões do papel continuam as cinco de sempre;
  //   * suspender, encerrar e reativar continuam sendo ato da central.
  //
  // POR QUE `autoApprovedAt` E `reviewedAt` JUNTOS
  //
  // `reviewedById` fica NULO porque não houve pessoa — inventar um revisor seria
  // mentir na trilha. Mas APENAS status + nulos é exatamente a assinatura do
  // legado do achado A-05, que a migration 20260927030000 devolve a PENDING pelo
  // predicado `reviewedById IS NULL AND reviewedAt IS NULL`. Gravar `reviewedAt`
  // tira a linha daquele predicado, e `autoApprovedAt` diz POR QUE ela está
  // fora: decidida pela regra, neste instante, por ninguém.
  // ========================================================================
  const agora = new Date();

  // O ARQUIVO VAI ANTES DA LINHA. Se a gravação do objeto falhar, nenhum
  // cadastro nasce; se a linha falhar depois, sobra um objeto órfão — que é o
  // lado certo de errar, porque cadastro apontando para arquivo inexistente
  // apareceria como foto quebrada em ranking e em lista.
  const chave = chaveDaFoto(actor.id, foto.mimeType);
  await storage.saveBuffer(chave, foto.buffer);

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
        status: 'APPROVED',
        reviewedAt: agora,
        autoApprovedAt: agora,
        photoKey: chave
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

  // DUAS LINHAS DE TRILHA, porque foram dois fatos.
  //
  // O cadastro e a aprovação acontecem no mesmo instante, mas continuam sendo
  // coisas diferentes: uma auditoria que registrasse só `COACH_REGISTER` faria a
  // aprovação automática desaparecer do histórico, e quem lesse depois não teria
  // como saber que o estado APPROVED não passou por pessoa.
  //
  // `actor` é o próprio treinador nos dois registros — é ele quem age. `automatic`
  // no metadado é o que diz que a decisão não foi dele nem de ninguém: foi a regra.
  await audit.record({
    actor, action: audit.ACTIONS.COACH_REGISTER, entity: 'Coach', entityId: coach.id,
    metadata: { status: 'APPROVED' }
  });
  await audit.record({
    actor, action: audit.ACTIONS.COACH_APPROVE, entity: 'Coach', entityId: coach.id,
    metadata: {
      automatic: true,
      from: 'PENDING',
      to: 'APPROVED',
      reason: 'Aprovação automática do cadastro no autocadastro (decisão que substituiu a análise central).'
    }
  });

  // A AUTORIZAÇÃO NA NPC VEM DEPOIS DA APROVAÇÃO, e não junto: a política do
  // banco exige o cadastro já APPROVED para aceitar a linha, e é o mesmo
  // encadeamento que a decisão descreve — primeiro o cadastro conclui, então ele
  // já pode atuar na federação oficial.
  await autorizarNaFederacaoOficial(coach, actor);

  // Relido para que a resposta traga a autorização recém-criada: o `coach` do
  // INSERT foi projetado antes de ela existir, e devolver a versão antiga faria
  // a tela mostrar "sem autorização" logo depois de autorizar.
  return semChave(await prisma.coach.findUnique({ where: { id: coach.id }, select: SELECT_MEU_CADASTRO }));
}

/** O treinador lendo o próprio cadastro. Sem documento — R-05. */
async function meuCadastro(actor) {
  assertPermission(actor, 'coaches.read_own');

  const coach = await prisma.coach.findFirst({ where: { userId: actor.id }, select: SELECT_MEU_CADASTRO });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  return semChave(coach);
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

  return semChave(atualizado);
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

  return semChave(atualizado);
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

// ============================================================================
// O TREINADOR CRIANDO A EQUIPE DELE.
//
// Entrou com a autorização automática na NPC, e sem isto a decisão ficaria pela
// metade: o treinador passaria a estar autorizado a atuar e continuaria
// esperando a federação criar a equipe — a mesma espera que a decisão manda
// tirar do caminho.
//
// O QUE ISTO **NÃO** É: não é `teams.manage`. O operador da federação cadastra
// qualquer equipe, com qualquer responsável, e vem com o resto do poder de
// operador. Aqui são três amarras, todas conferidas antes de gravar:
//
//   1. a equipe nasce com `coachId` do cadastro DESTA conta — o corpo não escolhe
//      responsável, então não há como criar equipe no nome de outro treinador;
//   2. a federação tem de ser uma em que ele está AUTORIZADO A ATUAR
//      (`CoachOrganization` APPROVED). Autorização automática na NPC serve; em
//      qualquer outra federação continua sendo ato dela — R-04 intacta;
//   3. `companyId` não é aceito. Empresa acima da equipe é decisão de federação,
//      e deixar o interessado apontá-la aqui abriria pontuação de empresa a quem
//      não responde por ela.
// ============================================================================
async function criarMinhaEquipe(data, actor) {
  assertPermission(actor, 'teams.create_own');

  const estado = await treinadorAtivoDaConta(actor, data.organizationId);
  if (!estado) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  if (!estado.autorizado) recusarTreinadorInativo(estado);

  const organizacao = await prisma.organization.findUnique({
    where: { id: data.organizationId },
    select: { id: true, name: true, active: true }
  });
  if (!organizacao) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');
  if (!organizacao.active) throw new AppError(422, 'ORGANIZATION_INACTIVE', 'Federação inativa');

  let equipe;
  try {
    equipe = await prisma.team.create({
      data: {
        organizationId: organizacao.id,
        coachId: estado.id,
        name: data.name,
        city: data.city ?? null,
        state: data.state ?? null
      },
      select: {
        id: true, name: true, city: true, state: true, organizationId: true, coachId: true,
        organization: { select: { id: true, name: true, slug: true } }
      }
    });
  } catch (error) {
    // `@@unique([organizationId, name])`: duas equipes de mesmo nome na mesma
    // federação seriam indistinguíveis no ranking de equipes.
    if (error.code === 'P2002') {
      throw new AppError(409, 'TEAM_NAME_TAKEN',
        'Já existe uma equipe com este nome nesta federação. Escolha outro nome.');
    }
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.TEAM_CREATE, entity: 'Team', entityId: equipe.id,
    organizationId: organizacao.id,
    metadata: { coachId: estado.id, byCoach: true, name: equipe.name }
  });

  return equipe;
}

/**
 * O treinador corrigindo a própria equipe: nome, cidade, UF.
 *
 * `organizationId`, `coachId` e `companyId` NÃO entram. Mover a equipe de
 * federação, trocar o responsável ou apontar empresa são atos de federação, e
 * aceitar o campo aqui devolveria ao interessado a caneta que a decisão não lhe
 * deu. Só a equipe DELE é alcançável — a consulta filtra por `coachId`.
 */
async function atualizarMinhaEquipe(teamId, data, actor) {
  assertPermission(actor, 'teams.create_own');

  const estado = await treinadorAtivoDaConta(actor);
  if (!estado) throw new AppError(404, 'COACH_NOT_FOUND', 'Esta conta não possui cadastro de treinador');
  if (!estado.autorizado) recusarTreinadorInativo(estado);

  const atual = await prisma.team.findFirst({
    where: { id: teamId, coachId: estado.id },
    select: { id: true, name: true, organizationId: true }
  });
  // 404, e não 403: um treinador perguntando por equipe alheia não deve
  // descobrir que ela existe. Mesma escolha das rotas de ranking (achado A-01).
  if (!atual) throw new AppError(404, 'TEAM_NOT_FOUND', 'Equipe não encontrada');

  let equipe;
  try {
    equipe = await prisma.team.update({
      where: { id: atual.id },
      data: {
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.city === undefined ? {} : { city: data.city }),
        ...(data.state === undefined ? {} : { state: data.state })
      },
      select: {
        id: true, name: true, city: true, state: true, organizationId: true, coachId: true,
        organization: { select: { id: true, name: true, slug: true } }
      }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      throw new AppError(409, 'TEAM_NAME_TAKEN',
        'Já existe uma equipe com este nome nesta federação. Escolha outro nome.');
    }
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.TEAM_UPDATE, entity: 'Team', entityId: equipe.id,
    organizationId: equipe.organizationId,
    metadata: { coachId: estado.id, byCoach: true, de: atual.name, para: equipe.name }
  });

  return equipe;
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
  minhasEquipes, criarMinhaEquipe, atualizarMinhaEquipe, meusAtletas,
  FOTO_OBRIGATORIA, trocarMinhaFoto, fotoParaEntrega,
  anexarDocumento, listarDocumentos, baixarDocumento, removerDocumento
};

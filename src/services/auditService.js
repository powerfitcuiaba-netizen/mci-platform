const prisma = require('../config/prisma');
const { contextoAtual } = require('../config/rlsContext');
const { withUserContext } = require('../config/rlsSession');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { can } = require('../utils/permissions');

// Ações críticas registradas na trilha. A lista existe para que o nome da ação
// seja estável e pesquisável, não para restringir: `record` aceita qualquer
// string, mas o domínio usa estas.
const ACTIONS = Object.freeze({
  LOGIN: 'LOGIN',
  // Estava como literal solto no serviço de autenticação. Entrou no catálogo
  // junto da correção da trilha de autenticação: o nome da ação é o que alguém
  // vai procurar na trilha daqui a um ano, e nome que só existe num literal é
  // nome que a próxima pessoa escreve diferente.
  USER_REGISTER: 'USER_REGISTER',
  ATHLETE_CREATE: 'ATHLETE_CREATE',
  ATHLETE_UPDATE: 'ATHLETE_UPDATE',
  ATHLETE_CPF_VIEW: 'ATHLETE_CPF_VIEW',
  REGISTRATION_CREATE: 'REGISTRATION_CREATE',
  REGISTRATION_CANCEL: 'REGISTRATION_CANCEL',
  CHECKIN: 'CHECKIN',
  WEIGHIN: 'WEIGHIN',
  CREDENTIAL_ISSUE: 'CREDENTIAL_ISSUE',
  CREDENTIAL_SCAN: 'CREDENTIAL_SCAN',
  EVENT_CREATE: 'EVENT_CREATE',
  EVENT_TRANSITION: 'EVENT_TRANSITION',
  JUDGING_SCORE: 'JUDGING_SCORE',
  JUDGING_CLOSE: 'JUDGING_CLOSE',
  RESULT_RECEIVED: 'RESULT_RECEIVED',
  RESULT_PUBLICATION: 'RESULT_PUBLICATION',
  RESULT_OVERRIDE: 'RESULT_OVERRIDE',
  RANKING_UPDATE: 'RANKING_UPDATE',
  // Correção administrativa de lançamento já publicado. Três ações separadas
  // porque as três respondem perguntas diferentes na trilha: o que mudou, o
  // que deixou de valer, e o que voltou a valer.
  RANKING_POINT_EDITED: 'RANKING_POINT_EDITED',
  RANKING_POINT_VOIDED: 'RANKING_POINT_VOIDED',
  RANKING_POINT_RESTORED: 'RANKING_POINT_RESTORED',
  // Ajuste ADMINISTRATIVO da pontuação: o número muda, colocação,
  // categoria, classe, evento, temporada e atleta não. Separado de
  // RANKING_POINT_EDITED de propósito — aquele é correção de colocação,
  // este é decisão de homologação, e confundir os dois na auditoria
  // apagaria a diferença entre 'o dado estava errado' e 'a comissão decidiu'.
  RANKING_POINTS_ADJUSTED: 'RANKING_POINTS_ADJUSTED',
  // Pontuação (fase 11.3). O padrão do projeto é ENTIDADE_VERBO, então os
  // nomes seguem SCORE_*, e não os do enunciado, que usa VERBO no particípio.
  // RANKING_UPDATE já cobre o recálculo do agregado e permanece como está.
  SCORE_CONFLICT: 'SCORE_CONFLICT',
  SUPER_OVERALL_UPDATE: 'SUPER_OVERALL_UPDATE',
  OVERALL_DECLARE: 'OVERALL_DECLARE',
  // Revogação de título homologado. Ação PRÓPRIA, e não um DECLARE com valor
  // nulo: corrigir uma homologação é ato administrativo distinto de fazê-la, e
  // quem audita precisa distinguir os dois na trilha sem interpretar metadado.
  OVERALL_REVOKE: 'OVERALL_REVOKE',
  CLASS_CATALOG_SET: 'CLASS_CATALOG_SET',
  // -------------------------------------------- módulo Treinadores & Equipes
  //
  // Uma ação por DECISÃO, e não uma ação genérica com o estado no metadata.
  // Quem audita precisa distinguir 'a administração central aprovou' de 'a
  // administração central suspendeu' sem abrir o payload — é a mesma razão que
  // separou RANKING_POINT_EDITED de RANKING_POINT_VOIDED.
  COACH_REGISTER: 'COACH_REGISTER',
  COACH_UPDATE: 'COACH_UPDATE',
  COACH_APPROVE: 'COACH_APPROVE',
  COACH_REJECT: 'COACH_REJECT',
  COACH_SUSPEND: 'COACH_SUSPEND',
  COACH_REACTIVATE: 'COACH_REACTIVATE',
  COACH_CANCEL: 'COACH_CANCEL',
  // Autorizar o treinador global a atuar numa federação (R-04). Separado da
  // aprovação cadastral de propósito: são decisões de autoridades diferentes.
  // A equipe passou a ter responsável, e trocar responsável muda quem vê os
  // atletas dela. É decisão, não metadado de atualização de cadastro.
  TEAM_COACH_SET: 'TEAM_COACH_SET',
  COACH_ORG_AUTHORIZE: 'COACH_ORG_AUTHORIZE',
  COACH_ORG_REVOKE: 'COACH_ORG_REVOKE',
  COACH_DOCUMENT_UPLOAD: 'COACH_DOCUMENT_UPLOAD',
  COACH_DOCUMENT_DOWNLOAD: 'COACH_DOCUMENT_DOWNLOAD',
  COACH_DOCUMENT_DELETE: 'COACH_DOCUMENT_DELETE',
  // Localizar atleta por matrícula é acesso a dado de pessoa, mesmo sem CPF.
  // Fica registrado quem procurou e se achou — é o que permite detectar
  // varredura de matrículas depois do fato.
  ATHLETE_LOOKUP_AFFILIATION: 'ATHLETE_LOOKUP_AFFILIATION',
  MEMBERSHIP_REQUEST_CREATE: 'MEMBERSHIP_REQUEST_CREATE',
  MEMBERSHIP_REQUEST_CONFIRM: 'MEMBERSHIP_REQUEST_CONFIRM',
  MEMBERSHIP_REQUEST_REJECT: 'MEMBERSHIP_REQUEST_REJECT',
  MEMBERSHIP_REQUEST_CANCEL: 'MEMBERSHIP_REQUEST_CANCEL',
  // A confirmação feita POR DECISÃO ADMINISTRATIVA, substituindo a vontade do
  // atleta. É o caso excepcional de R-01/R-02 e não pode ter o mesmo nome da
  // confirmação comum na trilha.
  MEMBERSHIP_REQUEST_ADMIN_APPROVE: 'MEMBERSHIP_REQUEST_ADMIN_APPROVE',
  // Delegação central (R-02): conceder e revogar poder que altera atribuição
  // de pontos.
  CENTRAL_GRANT: 'CENTRAL_GRANT',
  CENTRAL_REVOKE: 'CENTRAL_REVOKE',
  ATHLETE_TEAM_LINK: 'ATHLETE_TEAM_LINK',
  ATHLETE_TEAM_TRANSFER: 'ATHLETE_TEAM_TRANSFER',
  ATHLETE_TEAM_UNLINK: 'ATHLETE_TEAM_UNLINK',
  MUSCLEWAR_IMPORT: 'MUSCLEWAR_IMPORT',
  MUSCLEWAR_REVIEW: 'MUSCLEWAR_REVIEW',
  MUSCLEWAR_APPLY: 'MUSCLEWAR_APPLY',
  // Excluir um lote e invalidar um lote são operações diferentes, e a
  // auditoria não pode chamá-las pelo mesmo nome: uma apaga rascunho, a outra
  // desfaz resultado publicado. Quem audita precisa distinguir as duas sem
  // abrir o metadata.
  MUSCLEWARE_IMPORT_DELETED: 'MUSCLEWARE_IMPORT_DELETED',
  MUSCLEWARE_IMPORT_INVALIDATED: 'MUSCLEWARE_IMPORT_INVALIDATED',
  // A MENSAGEM DE ABERTURA AOS ATLETAS. Três ações e não uma: publicar um
  // recado para toda a base, mudar o texto DEPOIS de gente já ter lido, e
  // tirá-lo do ar são decisões diferentes, e quem audita precisa distingui-las
  // sem abrir o metadata.
  ATHLETE_NOTICE_CREATE: 'ATHLETE_NOTICE_CREATE',
  ATHLETE_NOTICE_UPDATE: 'ATHLETE_NOTICE_UPDATE',
  ATHLETE_NOTICE_DELETE: 'ATHLETE_NOTICE_DELETE',
  PRO_STATUS_CHANGE: 'PRO_STATUS_CHANGE',
  ROLE_CHANGE: 'ROLE_CHANGE',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  CONTENT_MODERATION: 'CONTENT_MODERATION'
});

// Chaves que nunca entram na trilha, mesmo que apareçam no payload da ação.
const PROIBIDAS = ['password', 'senha', 'token', 'secret', 'authorization', 'hash'];

const ehProibida = chave => {
  const nome = String(chave).toLowerCase();
  return PROIBIDAS.some(proibida => nome.includes(proibida));
};

function sanitize(valor, profundidade = 0) {
  if (profundidade > 4) return '[profundo demais]';
  if (Array.isArray(valor)) return valor.slice(0, 50).map(item => sanitize(item, profundidade + 1));
  if (valor instanceof Date) return valor.toISOString();
  if (valor && typeof valor === 'object') {
    const saida = {};
    for (const [chave, interno] of Object.entries(valor)) {
      if (ehProibida(chave)) continue;
      saida[chave] = sanitize(interno, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

// ============================================================================
// O `try/catch` SOZINHO ERA UMA MENTIRA, e custou caro descobrir.
//
// "Uma falha aqui não derruba a operação auditada" é o que este código dizia,
// e era falso no PostgreSQL: QUALQUER statement recusado aborta a transação
// INTEIRA. Capturar o erro em JavaScript não desfaz isso — a transação fica
// envenenada, todo comando seguinte falha com 25P02, e no commit tudo volta
// atrás.
//
// MEDIDO, e não deduzido: o provisionamento da conta de serviço rodava sem
// ator, a política `auditoria_escrita` recusava o INSERT com 42501, este
// `catch` engolia o erro, `provisionar` devolvia a conta criada COM ID — e o
// banco ficava vazio. Sucesso mentiroso, que é o pior modo de falhar.
//
// A CORREÇÃO É UM SAVEPOINT, e ele precisa ser aqui, num lugar só: são 44
// chamadas espalhadas, e cada uma que confiasse na promessa antiga estaria
// desfazendo o trabalho inteiro sem saber.
//
// Com SAVEPOINT, a recusa da auditoria volta atrás SÓ A SI MESMA. A operação
// principal segue consistente, a transação continua utilizável, e a falha
// continua observável no log — que é exatamente o que a frase original
// prometia e agora, enfim, cumpre.
//
// FORA DE TRANSAÇÃO não há o que proteger: um INSERT avulso que falha não
// envenena nada, e o `try/catch` basta.
//
// `createMany` e não `create`: o `create` do Prisma emite INSERT ... RETURNING,
// e o RETURNING é submetido à política de SELECT da tabela. Como a auditoria só
// é legível por administrador e operador da organização, gravar um registro em
// nome de um ator comum falharia ao tentar lê-lo de volta — e o retorno é
// descartado por todas as 44 chamadas. Sem RETURNING, a escrita passa pela
// política de INSERT, que é a que de fato governa quem pode auditar.
// ============================================================================

// ============================================================================
// FALHA DE AUDITORIA PRECISA SER CONTÁVEL, E NÃO APENAS REGISTRÁVEL.
//
// A perda da trilha de LOGIN e de USER_REGISTER passou meses sem ser notada por
// um motivo simples: só o log sabia dela, e log só é lido por quem já
// desconfia. Foi um gate de QA visual olhando o log do servidor por outro
// motivo que a encontrou — ou seja, por acaso.
//
// O contador conserta isso: o processo passa a saber quantas vezes a trilha
// falhou e qual foi a última falha, e `GET /audit/integrity` entrega isso a quem
// tem permissão de ler a trilha. O teste afirma zero no caminho feliz, então um
// retrocesso reprova o gate em vez de sumir.
//
// O QUE O RESUMO NÃO GUARDA: `metadata`, e-mail, IP, nada que possa ser segredo
// ou dado pessoal. Ação, entidade, código do erro e instante bastam para saber
// que a trilha falhou e onde olhar — e a rota que os expõe, ainda que
// autenticada e permissionada, não é lugar de dado sensível.
// ============================================================================
let falhas = 0;
let ultimaFalha = null;

function contabilizarFalha(dados, error) {
  falhas += 1;
  ultimaFalha = {
    action: dados.action,
    entity: dados.entity,
    codigo: error?.code ?? null,
    quando: new Date().toISOString()
  };
}

/**
 * Saúde da trilha desde a partida do processo.
 *
 * Contagem de processo, e não de banco: é exatamente o que se quer saber — esta
 * instância está conseguindo gravar auditoria? Uma contagem persistida não
 * responderia isso sem confundir falha de agora com falha de ontem.
 */
function estadoDaTrilha() {
  return {
    falhas,
    ultimaFalha,
    desdeSegundos: Math.round(process.uptime())
  };
}

// Apenas para a suíte: zera a contagem entre casos, para que um teste não leia a
// falha provocada por outro. Não há rota que chame isto.
function reiniciarContagemDeFalhas() {
  falhas = 0;
  ultimaFalha = null;
}

// Nome único por chamada: auditorias aninhadas na mesma transação não podem
// disputar o mesmo ponto de retorno.
let sequencia = 0;

async function inserir(dados) {
  return prisma.auditLog.createMany({ data: dados });
}

async function record({ actor, action, entity, entityId = null, organizationId = null, metadata = null, ip = null }) {
  const dados = {
    organizationId,
    userId: actor?.id || null,
    userEmail: actor?.email || null,
    action: String(action),
    entity: String(entity),
    entityId: entityId ? String(entityId) : null,
    metadata: metadata ? sanitize(metadata) : undefined,
    ip: ip ? String(ip).slice(0, 60) : null
  };

  const tx = contextoAtual()?.tx;

  if (!tx) {
    try {
      return await inserir(dados);
    } catch (error) {
      contabilizarFalha(dados, error);
      logger.error('falha ao registrar auditoria', {
        action: dados.action, entity: dados.entity, erro: error.message
      });
      return null;
    }
  }

  sequencia += 1;
  const ponto = `mci_audit_${sequencia}`;

  await tx.$executeRawUnsafe(`SAVEPOINT ${ponto}`);
  try {
    const resultado = await inserir(dados);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);
    return resultado;
  } catch (error) {
    // Volta ao ponto: desfaz SÓ o INSERT recusado. A transação principal
    // continua viva e utilizável — é isto que o `catch` sozinho não fazia.
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${ponto}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);

    // `error` E NÃO `warn`: auditoria que não grava é perda de trilha, e
    // trilha perdida só se descobre quando alguém precisa dela. O motivo real
    // vai junto, porque "falhou" sem o porquê não deixa ninguém consertar.
    contabilizarFalha(dados, error);
    logger.error('falha ao registrar auditoria (a operação seguiu; a transação foi preservada)', {
      action: dados.action, entity: dados.entity, entityId: dados.entityId,
      organizationId: dados.organizationId, temAtor: Boolean(dados.userId),
      codigo: error.code, erro: error.message
    });
    return null;
  }
}

// ============================================================================
// O EVENTO DE AUTENTICAÇÃO — QUANDO O ATOR EXISTE, MAS O CONTEXTO AINDA NÃO.
//
// O PROBLEMA, medido em `scripts/qa/diagnostico-auditoria-autenticacao.mjs`:
// `/auth/login` e `/auth/register` são as ÚNICAS rotas que gravam trilha sem
// `req.user` — por construção, porque é dentro delas que a identidade nasce.
// Sem `req.user`, `asyncHandler` não abre transação; sem transação, não há
// `SET LOCAL mci.user_id`; e a política `auditoria_escrita`, que exige que o
// `userId` da linha seja o ator da sessão, recusava o INSERT com 42501. O login
// funcionava, a trilha se perdia, e só o log sabia. 17 eventos foram medidos
// perdidos numa única execução de QA.
//
// A CORREÇÃO NÃO TOCA A POLÍTICA. Depois de conferir a senha — ou de criar o
// usuário —, o servidor SABE quem é o ator. Basta gravar o evento dentro do
// contexto desse ator, que é o mesmo mecanismo de toda requisição autenticada.
// A política então encontra `userId = mci_current_user_id()` e aceita. Medido:
// o MESMO INSERT recusado sem contexto passa com ele (sondas P1 e P2).
//
// POR QUE ISTO NÃO É UMA PORTA DOS FUNDOS:
//
//   * o ator vem de `actor.id` — um registro que o servidor leu do banco depois
//     de conferir a credencial, ou que ele acabou de criar. NUNCA do corpo, da
//     query ou de cabeçalho. Quem chama não escolhe em nome de quem assina.
//   * a política continua conferindo tudo o que conferia: assinar no lugar de
//     outro segue recusado, e escrever na trilha de federação alheia também.
//     Nada foi afrouxado para isto funcionar.
//   * sem credencial válida não existe `actor`, e sem `actor` esta função se
//     recusa a inventar um: cai para `record`, que a política recusa — que é o
//     comportamento correto para visitante.
//
// POR QUE EM TRANSAÇÃO PRÓPRIA: a autenticação já terminou quando este registro
// acontece. Se a gravação falhar, o login continua válido (é o que a tarefa pede
// preservar) e a falha entra no contador — não desaparece.
//
// JÁ EM CONTEXTO, NÃO ABRE OUTRO: se um dia um caminho autenticado chamar esta
// função, ela usa o contexto que existe. Abrir um segundo sobrescreveria o ator
// corrente e travaria outra conexão do pool sem necessidade.
async function registrarComContextoDoAtor(evento) {
  const ator = evento?.actor?.id ?? null;
  if (!ator || contextoAtual()?.tx) return record(evento);
  return withUserContext(ator, () => record(evento));
}

async function list(filtros, actor) {
  if (!can(actor, 'audit.read', filtros.organizationId || null)) {
    throw new AppError(403, 'FORBIDDEN', 'Sem permissão para consultar a auditoria');
  }

  const where = {};
  if (filtros.entity) where.entity = filtros.entity;
  if (filtros.entityId) where.entityId = filtros.entityId;
  if (filtros.userId) where.userId = filtros.userId;
  if (filtros.action) where.action = filtros.action;
  if (filtros.organizationId) where.organizationId = filtros.organizationId;

  const limite = Math.min(Number(filtros.limit) || 100, 200);

  const items = await prisma.auditLog.findMany({
    where,
    select: {
      id: true, action: true, entity: true, entityId: true, metadata: true,
      organizationId: true, createdAt: true, userEmail: true, ip: true,
      user: { select: { id: true, name: true, role: true } }
    },
    // `createdAt` não é único: duas ações do mesmo lote caem no mesmo
    // milissegundo. O `id` fecha a ordem por contrato — auditoria embaralhada
    // entre duas leituras não é auditoria. Mesma decisão do check-in, e pelo
    // mesmo motivo: determinismo por contrato, não por sorte do plano.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limite,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  // `total: items.length` devolvia o tamanho da PÁGINA. Numa trilha de
  // auditoria isso é pior que numa lista comum: auditoria existe para
  // responder "isto aconteceu quantas vezes?", e um total que na verdade é o
  // teto responde sempre a mesma coisa. A tela não exibia esse número, o que
  // reduzia o impacto — mas número errado exposto por API é defeito mesmo
  // quando ninguém está olhando, porque a próxima tela vai acreditar nele.
  return {
    items,
    total: await prisma.auditLog.count({ where }),
    nextCursor: items.length === limite ? items[items.length - 1].id : null
  };
}

/** A saúde da trilha, para quem tem permissão de lê-la. */
async function integridade(actor) {
  if (!can(actor, 'audit.read', null)) {
    throw new AppError(403, 'FORBIDDEN', 'Sem permissão para consultar a auditoria');
  }
  return estadoDaTrilha();
}

module.exports = {
  record, registrarComContextoDoAtor, list, sanitize, ACTIONS,
  integridade, estadoDaTrilha, reiniciarContagemDeFalhas
};

const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, assertPermission, organizationFilter } = require('../utils/tenant');
const { normalizeCpf, isValidCpf } = require('../utils/cpf');
const storage = require('./storageService');
const imagem = require('./imagemService');
const audit = require('./auditService');
const logger = require('../utils/logger');
const muscleWar = require('./muscleWarService');
const contasDeServico = require('./serviceAccountService');
const { withUserContext } = require('../config/rlsSession');

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

// `photoKey` é SELECIONADO (o serviço precisa da chave para gravar, apagar e
// promover o objeto) mas NUNCA sai na resposta: `semChaves` o troca por um
// booleano. A chave é caminho interno do bucket; a foto é buscada por
// `GET /media/athlete-requests/:id/photo`, que decide quem pode vê-la.
//
// `cpf` está FORA de CAMPOS_PUBLICOS de propósito: a listagem da fila nunca o
// devolve. Ele só sai na tela de análise de um pedido específico, e só para
// quem tem permissão de ler dado sensível de atleta.
const cpfDoPedido = { ...CAMPOS_PUBLICOS, cpf: true };

// Troca a chave de armazenamento por "tem foto?". Um único lugar, para que
// nenhuma rota nova volte a devolvê-la por esquecimento.
const semChaves = pedido => {
  if (!pedido) return pedido;
  // `cpf` é DESESTRUTURADO PARA FICAR DE FORA. O prefixo `_` é a convenção do
  // lint para "existe e não se usa" — e aqui não usar é o ponto: desde que a
  // conclusão automática precisa ler o documento, a resposta passou a correr o
  // risco de devolvê-lo por esquecimento. Removê-lo aqui fecha o caminho todo.
  const { photoKey, cpf: _cpf, ...resto } = pedido;
  return { ...resto, hasPhoto: Boolean(photoKey) };
};

async function criar(data, actor) {
  // A organização vem da FILIAÇÃO, resolvida no servidor. Aceitá-la do corpo
  // deixaria qualquer pessoa endereçar o pedido à federação que quisesse.
  const filiacao = await prisma.affiliation.findUnique({
    where: { id: data.affiliationId },
    select: {
      id: true, organizationId: true, active: true, name: true,
      organization: { select: { active: true, selfRegistrationOpen: true } }
    }
  });
  if (!filiacao) throw new AppError(422, 'AFFILIATION_INVALID', 'Entidade de filiação não encontrada');
  if (!filiacao.active) throw new AppError(422, 'AFFILIATION_INACTIVE', 'Entidade de filiação inativa');

  // A PORTA, E NÃO A VITRINE.
  //
  // `publicService.listAffiliations` já escondia as filiações de quem não
  // recebe pedido espontâneo — mas esconder não é recusar. O id de uma
  // filiação sai na página pública do atleta, e com ele em mãos dava para
  // enviar solicitação a uma federação de porta fechada.
  //
  // Enquanto a solicitação só entrava numa fila para um operador analisar, o
  // furo custava uma linha a mais na fila. Com a CONCLUSÃO AUTOMÁTICA ele
  // passaria a criar atleta — e aí o interruptor que a federação controla não
  // controlaria nada. A conferência tinha de descer para cá.
  if (!filiacao.organization?.active || !filiacao.organization?.selfRegistrationOpen) {
    throw new AppError(422, 'SELF_REGISTRATION_CLOSED',
      'Esta federação não está recebendo autocadastro no momento.');
  }

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
    // `cpfDoPedido` porque a conclusão automática, logo abaixo, precisa do
    // documento para criar a identidade. Ele NÃO sai na resposta: `semChaves`
    // o remove, e agora remove sempre, por construção e não por lembrança.
    select: cpfDoPedido
  });

  // O CPF NÃO entra nos metadados: auditoria é lida por muita gente e guardar
  // documento em texto livre ali desfaz o isolamento que o resto do sistema
  // mantém.
  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_CREATE', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: filiacao.organizationId,
    metadata: { affiliationId: filiacao.id, affiliationNumber: data.affiliationNumber }
  });

  const conciliacao = await concluirAutomaticamente(pedido, actor);

  return { ...semChaves(conciliacao.pedido ?? pedido), conciliacao: conciliacao.resumo };
}

// ============================================================================
// FOTO DO PEDIDO
//
// O arquivo sobe PELO SERVIDOR, como todo upload desta plataforma: nada de URL
// assinada devolvida ao navegador. A credencial do R2 nunca sai daqui, e o
// objeto só é gravado depois que o dono do pedido foi confirmado — uma
// requisição não autorizada não deixa resíduo no bucket.
//
// A chave é construída por `storage.buildKey`, que higieniza cada segmento do
// escopo e sorteia um UUID. Não há como o cliente influenciar a chave, e por
// isso não há travessia de caminho nem chave adivinhável.
// ============================================================================

// Carrega o pedido conferindo que é DESTA pessoa e que ainda está aberto.
// 404 para pedido alheio, e não 403: confirmar que o id existe já é informação.
// A JANELA DA FOTO NÃO FECHA NA CONCLUSÃO.
//
// A foto é enviada DEPOIS que o pedido existe — não há id antes disso, e o
// arquivo fica em memória no navegador até haver um. Enquanto a conclusão
// dependia de um operador, o pedido ficava PENDING tempo de sobra. Com a
// conclusão automática ele nasce APPROVED, e exigir PENDING aqui deixaria
// TODO autocadastro sem foto — medido: a suíte acusou `PHOTO_NOT_FOUND`
// logo depois de um envio que respondera 200.
//
// APPROVED entra, então, e só para o DONO do pedido. Decidido — recusado ou
// cancelado — continua fora: ali o arquivo já foi descartado de propósito, e
// reabri-lo traria de volta um objeto que a regra mandou apagar.
const ABERTO_PARA_FOTO = new Set(['PENDING', 'APPROVED']);

async function pedidoProprioEmAberto(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({
    where: { id },
    select: {
      id: true, userId: true, status: true, photoKey: true,
      organizationId: true, athleteId: true
    }
  });
  if (!pedido || pedido.userId !== actor.id) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  }
  if (!ABERTO_PARA_FOTO.has(pedido.status)) {
    throw new AppError(422, 'REQUEST_NOT_PENDING', `Solicitação já está ${pedido.status}`);
  }
  // Devolve a linha CRUA, com a chave: é uso interno (gravar, apagar, promover
  // o objeto). Nada daqui vai para a resposta sem passar por `semChaves`.
  return pedido;
}

/**
 * Leva a foto do pedido para o atleta que ele criou.
 *
 * Silencioso quando não há atleta: no caminho manual o pedido ainda está
 * PENDING e não há a quem propagar — e não é erro, é a ordem normal das
 * coisas ali.
 */
async function propagarFotoParaOAtleta(pedido, chave) {
  if (!pedido.athleteId) return;

  const contaDeServico = await contasDeServico.contaDaOrganizacao(pedido.organizationId);
  await withUserContext(contaDeServico.id, async tx =>
    tx.athlete.update({ where: { id: pedido.athleteId }, data: { photoKey: chave } }));
}

async function definirFoto(id, arquivo, actor) {
  const pedido = await pedidoProprioEmAberto(id, actor);

  // Duas conferências, e as duas importam: o tipo declarado tem de estar na
  // lista de avatar, e os BYTES têm de corresponder a ele. Só o `Content-Type`
  // é o que o cliente diz, e o cliente pode dizer qualquer coisa.
  if (!storage.isAllowedAvatarMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `A foto aceita apenas ${Object.keys(storage.ALLOWED_AVATAR).join(', ')}`);
  }
  const recusa = storage.motivoDeRecusaPorAssinatura(arquivo.mimeType, arquivo.buffer);
  if (recusa) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', recusa);

  // O sharp recorta em 512px WebP e, de quebra, é a terceira barreira: HTML,
  // SVG e executável renomeados não decodificam e viram 415 aqui.
  const normalizada = await imagem.normalizar(arquivo, 'avatar');
  const chave = storage.buildKey(`athlete-requests/${pedido.id}`, normalizada.mimeType);
  await storage.saveBuffer(chave, normalizada.buffer);

  const anterior = pedido.photoKey;
  const atualizado = await prisma.athleteProfileRequest.update({
    where: { id: pedido.id }, data: { photoKey: chave }, select: CAMPOS_PUBLICOS
  });

  // O arquivo antigo só sai DEPOIS de o banco apontar para o novo: na ordem
  // inversa, uma falha de gravação deixaria o pedido apontando para um objeto
  // que já não existe. Órfão é muito melhor que foto quebrada.
  if (anterior && anterior !== chave) await storage.descartar(anterior, { motivo: 'foto substituida', requestId: pedido.id });

  // O ATLETA JÁ EXISTE: a foto tem de chegar nele.
  //
  // Na conclusão automática o `Athlete` nasceu antes de a foto ser enviada, e
  // ele copiou um `photoKey` que ainda era nulo. Sem esta propagação o perfil
  // ficaria sem foto para sempre, com o arquivo guardado e apontado só pelo
  // pedido — que ninguém abre depois.
  //
  // Quem escreve é a conta de serviço da federação, pelo mesmo motivo de
  // sempre: `Athlete` só aceita escrita de operador, e o atleta não é um.
  await propagarFotoParaOAtleta(pedido, chave);

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_PHOTO_SET', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: { mimeType: normalizada.mimeType, sizeBytes: normalizada.buffer.length, substituiu: Boolean(anterior) }
  });

  return semChaves(atualizado);
}

async function removerFoto(id, actor) {
  const pedido = await pedidoProprioEmAberto(id, actor);
  if (!pedido.photoKey) {
    return semChaves(await prisma.athleteProfileRequest.findUnique({ where: { id }, select: CAMPOS_PUBLICOS }));
  }

  const atualizado = await prisma.athleteProfileRequest.update({
    where: { id: pedido.id }, data: { photoKey: null }, select: CAMPOS_PUBLICOS
  });
  await storage.descartar(pedido.photoKey, { motivo: 'foto removida pelo dono', requestId: pedido.id });
  return semChaves(atualizado);
}

// Quem pode VER a foto: o dono do pedido e o operador que analisa. A chave do
// objeto nunca é aceita como parâmetro — quem resolve a chave é esta função,
// depois de decidir. É o que fecha o IDOR por troca de objectKey.
async function fotoParaEntrega(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({
    where: { id }, select: { id: true, userId: true, organizationId: true, photoKey: true }
  });
  if (!pedido || !pedido.photoKey) throw new AppError(404, 'PHOTO_NOT_FOUND', 'Foto não encontrada');

  if (pedido.userId !== actor.id) assertCan(actor, 'athletes.read_sensitive', pedido.organizationId);
  return pedido.photoKey;
}

// A fila do operador. Escopada pela organização do ator — nunca por um
// `organizationId` que tenha vindo do cliente.
async function listar(filtros, actor) {
  const escopo = organizationFilter(actor, filtros.organizationId);

  // A conferência depende de o cliente ter NOMEADO a organização.
  //
  // Nomeada: `organizationFilter` já exigiu o vínculo, e aqui se confere a
  // permissão naquela organização.
  //
  // Não nomeada (o caso da tela): o escopo é o CONJUNTO das organizações do
  // ator — `{ organizationId: { in: [...] } }` — e não existe um id único
  // para conferir. Passar esse filtro a `assertCan` era o defeito: ele chega
  // em `assertOrganization`, que compara um OBJETO com ids de organização,
  // nunca casa, e a fila devolvia 403 para TODO operador que não pusesse
  // `organizationId` na URL. Aqui a permissão é conferida sozinha — quem
  // limita as linhas é o escopo acima, mais a RLS da tabela.
  if (filtros.organizationId) assertCan(actor, 'athletes.manage', filtros.organizationId);
  else assertPermission(actor, 'athletes.manage', null);

  const where = { ...escopo };
  if (filtros.status) where.status = filtros.status;

  const items = await prisma.athleteProfileRequest.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {}),
    select: CAMPOS_PUBLICOS
  });

  return { items: items.map(semChaves), nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

// O que o próprio solicitante vê. Sem CPF: ele já sabe o próprio documento, e
// devolvê-lo cria mais uma superfície por onde ele pode vazar.
async function meusPedidos(actor) {
  const items = await prisma.athleteProfileRequest.findMany({
    where: { userId: actor.id },
    orderBy: { createdAt: 'desc' },
    select: CAMPOS_PUBLICOS
  });
  return items.map(semChaves);
}

async function carregarParaAnalise(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id }, select: cpfDoPedido });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');

  // Tenant conferido contra a organização DO PEDIDO, lida do banco. É o que
  // impede alcançar pedido de outra federação trocando o id na URL.
  assertCan(actor, 'athletes.read_sensitive', pedido.organizationId);
  return semChaves(pedido);
}

// A transação da aprovação, separada para que a tradução do erro fique
// legível — e para não repetir `prisma.$transaction` num `try` gigante.
/**
 * CONCLUI O AUTOCADASTRO NA HORA E CONCILIA O HISTÓRICO.
 *
 * A regra de negócio mudou: um atleta com histórico não fica mais numa fila
 * só para que alguém aperte "aprovar" e o vínculo aconteça. Ele conclui o
 * cadastro, e o sistema procura os resultados que já são dele.
 *
 * O QUE NÃO MUDOU, E NÃO PODE MUDAR
 *
 * Quem decide QUAIS linhas são desta pessoa continua sendo
 * `vincularPendentesDoAtleta`, com as mesmas chaves e as mesmas recusas: CPF
 * exato vincula; CPF divergente bloqueia; matrícula só vincula quando é única
 * na federação e a filiação confere; nome nunca vincula. Tirar o operador da
 * frente NÃO afrouxou nenhuma dessas conferências — só deixou de exigir que
 * uma pessoa aperte o botão quando a regra já era inequívoca.
 *
 * O AMBÍGUO CONTINUA PARANDO. Quando há mais de um candidato possível, nada é
 * vinculado e o desfecho diz que falta confirmação. É a única coisa que a
 * automação não pode resolver sozinha, e a que mais estraga se resolver errado:
 * histórico vinculado à pessoa errada não se desfaz com um "desfazer".
 *
 * FORA DA TRANSAÇÃO DO CADASTRO, de propósito. Se a conciliação falhar, o
 * atleta continua existindo e o processo pode ser repetido — é idempotente.
 * Dentro dela, uma falha em resultado antigo desfaria um cadastro correto.
 */
async function concluirAutomaticamente(pedido, actor) {
  // A IDENTIDADE VEM DO BACKEND, E DE UM LUGAR SÓ.
  //
  // `pedido.organizationId` foi resolvido no servidor, a partir da FILIAÇÃO
  // escolhida — nunca do corpo da requisição. Daí sai a conta de serviço, por
  // consulta, e não por parâmetro: não existe entrada que nomeie o operador, a
  // conta ou a organização a usar. Mandar `organizationId` ou
  // `serviceAccountId` no corpo não muda nada, porque nada lê esses campos.
  const contaDeServico = await contasDeServico.contaDaOrganizacao(pedido.organizationId);

  let resultado;
  try {
    // A PARTIR DAQUI QUEM ESCREVE É A FEDERAÇÃO, NÃO O ATLETA.
    //
    // `withUserContext` troca `mci.user_id` para a conta de serviço, e é o RLS
    // — não este código — que decide o que ela alcança: `mci_operator_of` só
    // responde verdadeiro para a organização em que ela tem membresia, que é
    // uma. O atleta continua sem poder escrever em `Athlete`, `AthleteIdentity`
    // ou `RankingPoint`; as políticas dessas três tabelas não foram tocadas.
    //
    // O ator da AUDITORIA continua sendo quem se cadastrou, com `actorType`
    // dizendo que a execução foi do sistema. Trocar o ator aqui apagaria de
    // quem foi o cadastro.
    resultado = await withUserContext(contaDeServico.id, async () =>
      executarAprovacao(pedido, contaDeServico, { automatico: true }));
  } catch (erro) {
    // A RECUSA AUTOMÁTICA É NEUTRA.
    //
    // No caminho do operador, "este CPF já pertence a um atleta desta
    // federação" é informação útil para quem está com o documento na mão. Dita
    // a QUEM SE CADASTRA, a mesma frase vira um oráculo: digita-se um CPF
    // qualquer e a resposta conta se aquela pessoa está cadastrada aqui.
    //
    // Então o que sai daqui não confirma nem nega nada sobre o documento. O
    // motivo real fica na auditoria, para o operador que for atender.
    if (erro instanceof AppError && erro.code === 'CPF_ALREADY_REGISTERED') {
      await audit.record({
        actor, action: 'ATHLETE_PROFILE_REQUEST_AUTO_BLOCKED',
        entity: 'AthleteProfileRequest', entityId: pedido.id,
        organizationId: pedido.organizationId,
        metadata: {
          actorType: 'SYSTEM_SERVICE_ACCOUNT',
          serviceAccountId: contaDeServico.id,
          motivo: 'CPF_ALREADY_REGISTERED',
          affiliationId: pedido.affiliationId,
          origem: 'AUTOCADASTRO'
        }
      });
      throw new AppError(409, 'REGISTRATION_NEEDS_REVIEW',
        'Não foi possível concluir o seu cadastro automaticamente. '
        + 'Procure a sua federação para finalizar.');
    }
    throw erro;
  }

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_AUTO_APPROVE',
    entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: {
      // QUEM EXECUTOU, e não só o que aconteceu. `SYSTEM_SERVICE_ACCOUNT`
      // distingue esta linha de uma aprovação humana, que grava
      // `HUMAN_OPERATOR` — sem essa distinção, ler a auditoria um ano depois
      // não diria se alguém conferiu o documento ou se a regra concluiu
      // sozinha.
      actorType: 'SYSTEM_SERVICE_ACCOUNT',
      serviceAccountId: contaDeServico.id,
      athleteId: resultado.athlete.id,
      affiliationId: pedido.affiliationId,
      origem: 'AUTOCADASTRO'
    }
  });

  // A conciliação não pode derrubar o cadastro. Se ela falhar, o atleta existe
  // e o histórico continua pendente — estado recuperável, e a repetição é
  // inofensiva. Derrubar o cadastro por causa de resultado antigo seria trocar
  // um problema pequeno por um grande.
  let vinculo = null;
  try {
    // Mesma identidade: escrever `athleteId` num `RankingPoint` é escrita no
    // ledger, e o ledger só aceita operador da federação.
    vinculo = await withUserContext(contaDeServico.id, async () =>
      muscleWar.vincularPendentesDoAtleta(resultado.athlete, contaDeServico));
  } catch (erro) {
    logger.error({ erro: erro.message, athleteId: resultado.athlete.id },
      'cadastro concluído, mas a conciliação do histórico falhou');
  }

  const resumo = resumoDaConciliacao(vinculo);

  await audit.record({
    actor, action: 'ATHLETE_HISTORY_RECONCILED',
    entity: 'Athlete', entityId: resultado.athlete.id,
    organizationId: pedido.organizationId,
    metadata: {
      actorType: 'SYSTEM_SERVICE_ACCOUNT',
      serviceAccountId: contaDeServico.id,
      athleteId: resultado.athlete.id,
      matchMethod: resumo.matchMethod,
      rankingPointIds: resumo.rankingPointIds,
      vinculados: resumo.vinculados,
      exigeConfirmacao: resumo.exigeConfirmacao,
      resultado: resumo.estado,
      origem: 'AUTOCADASTRO'
    }
  });

  return { pedido: resultado.pedido, resumo };
}

/**
 * O DESFECHO QUE A TELA MOSTRA — e só o desfecho.
 *
 * Três estados, porque são três coisas diferentes para quem acabou de se
 * cadastrar: não havia histórico; havia e foi vinculado; havia e alguém
 * precisa confirmar. A tela não deduz nenhum deles a partir de contagem: quem
 * classifica é o servidor, que é quem tem a regra.
 *
 * Nenhum número de CPF, nenhum nome de terceiro, nenhum id de resultado sai
 * daqui. Quem se cadastra recebe o estado do PRÓPRIO cadastro.
 */
function resumoDaConciliacao(vinculo) {
  const vazio = {
    estado: 'SEM_HISTORICO', matchMethod: 'SEM_HISTORICO',
    vinculados: 0, exigeConfirmacao: 0, rankingPointIds: []
  };
  if (!vinculo) return vazio;

  const vinculados = vinculo.lancamentosVinculados || vinculo.vinculados || 0;
  const exigeConfirmacao = vinculo.conflitos || 0;
  const rankingPointIds = vinculo.rankingPointIds || [];
  const matchMethod = vinculo.matchMethod || 'SEM_HISTORICO';

  if (vinculados > 0) {
    return { estado: 'VINCULADO', matchMethod, vinculados, exigeConfirmacao, rankingPointIds };
  }
  if (exigeConfirmacao > 0) {
    return {
      estado: 'PRECISA_CONFIRMAR', matchMethod: 'PRECISA_CONFIRMAR',
      vinculados: 0, exigeConfirmacao, rankingPointIds: []
    };
  }
  return vazio;
}

async function executarAprovacao(pedido, actor, opcoes = {}) {
  try {
    return await prisma.$transaction(async tx => aprovacaoAtomica(tx, pedido, actor, opcoes));
  } catch (erro) {
    // P2002 é violação de índice único. Aqui ela tem UM significado prático:
    // outro atleta desta federação já tem este CPF. Deixá-la subir daria 500
    // ao operador — "erro inesperado" para uma situação perfeitamente
    // esperada, e sem dizer o que fazer. Medido no navegador: a aprovação
    // devolvia 500.
    if (erro?.code === 'P2002') {
      throw new AppError(409, 'CPF_ALREADY_REGISTERED',
        'Este CPF já pertence a um atleta desta federação. Confira o documento com o solicitante antes de aprovar.');
    }
    throw erro;
  }
}

// O corpo da transação. Atleta, documento e desfecho do pedido nascem juntos
// ou não nascem: meio atleta criado seria pior que aprovação falhada — ficaria
// um atleta sem CPF, que ninguém encontra pela busca.
async function aprovacaoAtomica(tx, pedido, actor, { automatico = false } = {}) {
  const athlete = await tx.athlete.create({
    data: {
      organizationId: pedido.organizationId,
      userId: pedido.userId,
      fullName: pedido.fullName,
      sex: pedido.sex,
      birthDate: pedido.birthDate,
      affiliationId: pedido.affiliationId,
      affiliationNumber: pedido.affiliationNumber,
      // A MESMA chave passa a ser a foto oficial do atleta. O objeto não é
      // copiado nem movido: copiar criaria dois arquivos idênticos e uma
      // janela em que só um deles existe. O pedido continua apontando para ele
      // (é o histórico da análise).
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
      // NINGUÉM REVISOU, ENTÃO NINGUÉM ASSINA.
      //
      // No caminho automático `reviewedById` fica NULO de propósito. Gravar
      // aqui o id de quem pediu diria, para sempre e por escrito, que a pessoa
      // analisou o próprio pedido — que é exatamente o que `aprovar` proíbe.
      // Nulo é o registro honesto: a conclusão foi da regra, não de alguém.
      reviewedById: automatico ? null : actor.id,
      // O documento sai daqui: a partir de agora ele vive em
      // `AthleteIdentity`, que é onde a RLS de CPF o protege.
      cpf: null
    },
    select: CAMPOS_PUBLICOS
  });

  return { athlete, pedido: atualizado };
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

  // O CPF duplicado é barrado AQUI, e não no momento do pedido: a pré-checagem
  // lá é impossível, porque `AthleteIdentity` está sob RLS e quem pede não é
  // operador — a consulta veria zero linhas e diria "não existe" sempre. Quem
  // barra é a unicidade (organizationId + cpf), dentro da transação.
  const resultado = await executarAprovacao(pedido, actor);

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_APPROVE', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: { athleteId: resultado.athlete.id, affiliationId: pedido.affiliationId }
  });

  // A aprovação é o momento em que a identidade passa a existir para o MCI —
  // e é só aqui, não no preenchimento do formulário: quem digitou a matrícula
  // ainda não foi conferido por ninguém, e vincular resultado de campeonato a
  // uma afirmação não analisada seria entregar pontos a quem os pedir.
  //
  // Fora da transação de propósito. Se o vínculo falhar, o atleta continua
  // aprovado e existente; a operação é idempotente e pode ser repetida. Dentro
  // dela, uma falha em resultado antigo desfaria um cadastro correto.
  try {
    await muscleWar.vincularPendentesDoAtleta(resultado.athlete, actor);
  } catch (erro) {
    logger.error({ erro: erro.message, athleteId: resultado.athlete.id },
      'aprovação concluída, mas o vínculo de resultados pendentes falhou');
  }

  return semChaves(resultado.pedido);
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
      // Recusado não precisa mais guardar o documento nem a foto. A linha fica
      // para histórico; o CPF e a imagem, não.
      cpf: null,
      photoKey: null
    },
    select: CAMPOS_PUBLICOS
  });

  // O objeto sai do armazenamento DEPOIS de a linha já não apontar para ele.
  // Falhar aqui deixa um órfão — indesejável, mas melhor que um pedido
  // recusado ainda servindo a foto de alguém.
  if (pedido.photoKey) await storage.descartar(pedido.photoKey, { motivo: 'pedido encerrado', requestId: pedido.id, status: pedido.status });

  await audit.record({
    actor, action: 'ATHLETE_PROFILE_REQUEST_REJECT', entity: 'AthleteProfileRequest', entityId: pedido.id,
    organizationId: pedido.organizationId,
    metadata: { motivo: data.reason }
  });

  return semChaves(atualizado);
}

// O solicitante desiste. Diferente de REJECTED, que é decisão do operador —
// os dois estados existem para que a fila conte a história certa.
async function cancelar(id, actor) {
  const pedido = await prisma.athleteProfileRequest.findUnique({ where: { id } });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  if (pedido.userId !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Esta solicitação não é sua');
  if (pedido.status !== 'PENDING') throw new AppError(422, 'REQUEST_NOT_PENDING', `Solicitação já está ${pedido.status}`);

  const atualizado = await prisma.athleteProfileRequest.update({
    where: { id: pedido.id },
    data: { status: 'CANCELLED', cpf: null, photoKey: null },
    select: CAMPOS_PUBLICOS
  });

  if (pedido.photoKey) await storage.descartar(pedido.photoKey, { motivo: 'pedido encerrado', requestId: pedido.id, status: pedido.status });
  return semChaves(atualizado);
}

module.exports = { criar, listar, meusPedidos, carregarParaAnalise, aprovar, rejeitar, cancelar, definirFoto, removerFoto, fotoParaEntrega };

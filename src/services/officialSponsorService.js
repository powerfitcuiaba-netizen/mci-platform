const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertPermission } = require('../utils/tenant');
const storage = require('./storageService');
const imagem = require('./imagemService');
const audit = require('./auditService');

// ============================================================================
// CATÁLOGO DE PATROCINADORES OFICIAIS DO CAMPEONATO.
//
// A ÚNICA FONTE da vitrine: tela de entrada, rodapé público, ranking, home,
// atletas e campeonatos leem daqui. Antes disso havia uma lista versionada em
// `frontend/src/lib/patrocinadores.js`, e trocar um patrocinador exigia deploy.
//
// NÃO É O `Sponsor` DE FEDERAÇÃO, e a distinção é de domínio, não de nome:
// `Sponsor` é a empresa que apoia um evento, uma equipe ou um atleta DE UMA
// FEDERAÇÃO — tem `organizationId`, vive sob RLS por organização e se liga por
// `Sponsorship`. Este catálogo é institucional e nacional, não pertence a
// federação alguma, e por isso não tem tenant. Nada aqui toca `Sponsor`.
//
// A AUTORIZAÇÃO É DUPLA, E DE PROPÓSITO
//
// A permissão `sponsors.official` é conferida aqui, no serviço, em TODA
// escrita — não só na rota. E a política do banco (`mci_is_super_admin()`)
// repete a regra. Se uma rota nova esquecer o `perm(...)`, o serviço recusa; se
// alguém chamar o serviço sem ator, o banco recusa. É a mesma disciplina do
// resto do projeto: a tela esconde, o servidor decide, o banco confirma.
//
// `assertPermission` e não `assertCan`: `assertCan` exige uma organização, e
// aqui não existe nenhuma para exigir. Passar `null` de propósito é o que diz
// que a permissão é de plataforma.
// ============================================================================

/** A hierarquia comercial. A ordem DESTA lista é a ordem na vitrine. */
const NIVEIS = Object.freeze(['GLOBAL', 'DIAMANTE', 'GOLD', 'SILVER']);
const PESO_DO_NIVEL = Object.freeze(Object.fromEntries(NIVEIS.map((n, i) => [n, i])));

// O que sai para QUALQUER cliente. `logoKey` NÃO está aqui: ela é caminho
// interno do armazenamento, e quem a resolve é `GET /media/sponsors/:id/logo`.
// Devolvê-la entregaria a estrutura do bucket a quem abre a vitrine.
const CAMPOS = Object.freeze({
  id: true, code: true, name: true, level: true, sortOrder: true,
  active: true, logoKey: true, siteUrl: true, createdAt: true, updatedAt: true
});

/**
 * Troca a chave do armazenamento pelo booleano, sempre.
 *
 * Fica numa função só para que não exista um caminho que devolva a linha crua:
 * é a mesma proteção de `Athlete.photoKey`, e `tests/vazamento-de-storage`
 * reprova se a chave escapar.
 */
const semChave = linha => {
  if (!linha) return linha;
  const { logoKey, ...resto } = linha;
  return { ...resto, hasLogo: Boolean(logoKey) };
};

/**
 * A ORDEM CANÔNICA, e ela é determinística de ponta a ponta.
 *
 * Nível primeiro — a hierarquia comercial não se reordena —, depois
 * `sortOrder` dentro do nível, e `name` como desempate. O desempate não é
 * zelo: sem ele, duas marcas com a mesma ordem sairiam na ordem que o
 * PostgreSQL devolvesse, que pode mudar entre execuções e entre máquinas.
 *
 * O Prisma não sabe ordenar por um enum na ordem declarada (ele ordenaria pelo
 * rótulo), então a ordenação por nível é feita aqui, em memória. São dezenas
 * de linhas, não milhares: uma consulta só, sem N+1, e a ordenação custa nada.
 */
const ordenar = linhas => [...linhas].sort((a, b) => (
  (PESO_DO_NIVEL[a.level] - PESO_DO_NIVEL[b.level])
  || (a.sortOrder - b.sortOrder)
  || a.name.localeCompare(b.name, 'pt-BR')
  || a.id.localeCompare(b.id)
));

/**
 * A VITRINE. Anônimo, sem sessão, sem organização.
 *
 * Só o que está ATIVO. A política do banco já esconderia o inativo de quem não
 * é super admin; o `where` está aqui mesmo assim, porque depender só da
 * política faria o super admin ver na vitrine o que o visitante não vê — e a
 * prévia do painel ficaria mentindo.
 *
 * UMA CONSULTA, e ela basta para montar a faixa inteira.
 */
async function paraAVitrine() {
  const linhas = await prisma.officialSponsor.findMany({
    where: { active: true },
    select: CAMPOS
  });
  return ordenar(linhas).map(semChave);
}

/** O catálogo administrativo: ativos E inativos, na mesma ordem canônica. */
async function paraOPainel(actor) {
  assertPermission(actor, 'sponsors.official', null);
  const linhas = await prisma.officialSponsor.findMany({ select: CAMPOS });
  return ordenar(linhas).map(semChave);
}

const porId = async id => {
  const linha = await prisma.officialSponsor.findUnique({ where: { id }, select: CAMPOS });
  if (!linha) throw new AppError(404, 'SPONSOR_NOT_FOUND', 'Patrocinador não encontrado');
  return linha;
};

/**
 * A GUARDA DE CONCORRÊNCIA.
 *
 * Dois administradores com a tela aberta: o segundo a salvar sobrescreveria o
 * primeiro sem que ninguém percebesse. Quando o cliente informa de qual versão
 * partiu, uma alteração feita no meio do caminho vira 409 em vez de perda
 * silenciosa. Informar é OPCIONAL — cliente que não manda continua funcionando
 * como antes —, mas a tela manda sempre.
 */
function conferirVersao(linha, esperado) {
  if (!esperado) return;
  const atual = new Date(linha.updatedAt).toISOString();
  if (new Date(esperado).toISOString() !== atual) {
    throw new AppError(409, 'SPONSOR_STALE', 'Este patrocinador foi alterado por outra pessoa enquanto você editava. Recarregue e refaça a alteração.');
  }
}

/**
 * Recebe o arquivo, confere e devolve a chave montada pelo SERVIDOR.
 *
 * Três barreiras, e as três importam:
 *   1. o tipo declarado está na lista de avatar (PNG, JPEG, WebP);
 *   2. os BYTES correspondem ao tipo declarado — só o `Content-Type` é o que o
 *      cliente diz, e o cliente pode dizer qualquer coisa;
 *   3. o sharp DECODIFICA a imagem: HTML, SVG e executável renomeados não
 *      passam por aqui.
 *
 * A chave sai de `storage.buildKey`: prefixo fixo e UUID. Nada do que o cliente
 * mandou — nome do arquivo incluído — compõe o caminho, então não há travessia
 * nem escolha de objeto. O provedor ainda recusa qualquer chave que suba na
 * hierarquia, que é a última barreira.
 */
async function guardarArte(arquivo) {
  if (!arquivo?.buffer?.length) {
    throw new AppError(400, 'LOGO_REQUIRED', 'Envie a arte do patrocinador');
  }
  if (!storage.isAllowedAvatarMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `A logo aceita apenas ${Object.keys(storage.ALLOWED_AVATAR).join(', ')}`);
  }
  const recusa = storage.motivoDeRecusaPorAssinatura(arquivo.mimeType, arquivo.buffer);
  if (recusa) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', recusa);

  // Perfil `logo`: encaixa dentro do teto SEM recortar. O perfil de avatar
  // recortaria em quadrado, e arte de 10,6:1 perderia as pontas.
  const normalizada = await imagem.normalizar(arquivo, 'logo');
  if (!normalizada.processada) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'A logo precisa ser uma imagem que o servidor consiga processar');
  }

  const chave = storage.buildKey('sponsors', normalizada.mimeType);
  await storage.saveBuffer(chave, normalizada.buffer);

  // CONFERE QUE O OBJETO EXISTE antes de o banco apontar para ele. Um ponteiro
  // para arquivo ausente deixaria a vitrine com um buraco que nada denuncia.
  if (!(await storage.exists(chave))) {
    throw new AppError(500, 'LOGO_NOT_STORED', 'A logo não pôde ser armazenada');
  }
  return { chave, bytes: normalizada.buffer.length, mimeType: normalizada.mimeType };
}

async function criar(dados, arquivo, actor) {
  assertPermission(actor, 'sponsors.official', null);

  const code = String(dados.code || '').trim();
  if (await prisma.officialSponsor.findUnique({ where: { code }, select: { id: true } })) {
    throw new AppError(409, 'SPONSOR_CODE_TAKEN', 'Já existe um patrocinador com este identificador');
  }

  const arte = await guardarArte(arquivo);

  let criado;
  try {
    criado = await prisma.officialSponsor.create({
      data: {
        code,
        name: dados.name,
        level: dados.level,
        sortOrder: dados.sortOrder ?? 0,
        active: dados.active ?? true,
        siteUrl: dados.siteUrl || null,
        logoKey: arte.chave,
        createdById: actor.id,
        updatedById: actor.id
      },
      select: CAMPOS
    });
  } catch (erro) {
    // A linha não nasceu: o objeto que acabou de subir não tem dono e seria
    // lixo permanente no bucket.
    await storage.descartar(arte.chave, { motivo: 'criacao de patrocinador falhou' });
    throw erro;
  }

  await audit.record({
    actor, action: 'OFFICIAL_SPONSOR_CREATE', entity: 'OfficialSponsor', entityId: criado.id,
    metadata: {
      code: criado.code, name: criado.name, level: criado.level,
      sortOrder: criado.sortOrder, active: criado.active,
      siteUrl: criado.siteUrl, logoBytes: arte.bytes, logoMimeType: arte.mimeType
    }
  });

  return semChave(criado);
}

/**
 * Edita nome, nível, ordem, site e estado — nunca o id, nunca a chave da arte.
 *
 * A auditoria registra ANTES e DEPOIS de cada campo que de fato mudou. Guardar
 * o corpo inteiro encheria a trilha de campos iguais e esconderia o que
 * importa; guardar só o novo valor deixaria "mudou para GOLD" sem dizer de
 * onde veio.
 */
async function atualizar(id, dados, actor) {
  assertPermission(actor, 'sponsors.official', null);
  const antes = await porId(id);
  conferirVersao(antes, dados.updatedAt);

  const campos = ['name', 'level', 'sortOrder', 'active', 'siteUrl'];
  const mudou = {};
  for (const campo of campos) {
    if (dados[campo] === undefined) continue;
    const valor = campo === 'siteUrl' ? (dados[campo] || null) : dados[campo];
    if (valor !== antes[campo]) mudou[campo] = { de: antes[campo], para: valor };
  }
  if (!Object.keys(mudou).length) return semChave(antes);

  const depois = await prisma.officialSponsor.update({
    where: { id },
    data: {
      ...Object.fromEntries(Object.entries(mudou).map(([campo, { para }]) => [campo, para])),
      updatedById: actor.id
    },
    select: CAMPOS
  });

  // A AÇÃO DIZ O QUE ACONTECEU, e não só "mudou alguma coisa": quem lê a
  // trilha procura por "quem desativou", não por "quem fez um update".
  const acao = () => {
    const chaves = Object.keys(mudou);
    if (chaves.length === 1 && chaves[0] === 'active') {
      return mudou.active.para ? 'OFFICIAL_SPONSOR_ACTIVATE' : 'OFFICIAL_SPONSOR_DEACTIVATE';
    }
    if (chaves.length === 1 && chaves[0] === 'level') return 'OFFICIAL_SPONSOR_CHANGE_LEVEL';
    if (chaves.length === 1 && chaves[0] === 'sortOrder') return 'OFFICIAL_SPONSOR_CHANGE_ORDER';
    return 'OFFICIAL_SPONSOR_UPDATE';
  };

  await audit.record({
    actor, action: acao(), entity: 'OfficialSponsor', entityId: id,
    metadata: { code: antes.code, name: antes.name, alteracoes: mudou }
  });

  return semChave(depois);
}

/**
 * Troca a arte.
 *
 * A ORDEM IMPORTA: a nova sobe, o banco passa a apontar para ela, e só então a
 * antiga é descartada. Na ordem inversa, uma falha de gravação deixaria o
 * patrocinador apontando para um objeto que já não existe — órfão no bucket é
 * muito melhor que logo quebrada na vitrine.
 */
async function trocarArte(id, arquivo, actor) {
  assertPermission(actor, 'sponsors.official', null);
  const antes = await prisma.officialSponsor.findUnique({
    where: { id }, select: { ...CAMPOS, logoKey: true }
  });
  if (!antes) throw new AppError(404, 'SPONSOR_NOT_FOUND', 'Patrocinador não encontrado');

  const arte = await guardarArte(arquivo);

  const depois = await prisma.officialSponsor.update({
    where: { id },
    data: { logoKey: arte.chave, updatedById: actor.id },
    select: CAMPOS
  });

  if (antes.logoKey && antes.logoKey !== arte.chave) {
    await storage.descartar(antes.logoKey, { motivo: 'logo substituida', sponsorId: id });
  }

  await audit.record({
    actor, action: 'OFFICIAL_SPONSOR_CHANGE_LOGO', entity: 'OfficialSponsor', entityId: id,
    metadata: {
      code: antes.code, name: antes.name,
      logoBytes: arte.bytes, logoMimeType: arte.mimeType, substituiu: Boolean(antes.logoKey)
    }
  });

  return semChave(depois);
}

/**
 * A chave, para a rota de entrega resolver o objeto.
 *
 * A VITRINE É PÚBLICA, então esta função não exige ator — a logo de quem está
 * ATIVO é servida a qualquer um, que é o ponto de uma parede de patrocínio. A
 * de quem está INATIVO só sai para quem administra o catálogo: ela some da
 * vitrine inteira, inclusive da imagem.
 */
async function arteParaEntrega(id, actor) {
  const linha = await prisma.officialSponsor.findUnique({
    where: { id }, select: { id: true, active: true, logoKey: true }
  });
  if (!linha || !linha.logoKey) throw new AppError(404, 'LOGO_NOT_FOUND', 'Logo não encontrada');

  if (!linha.active) {
    const podeVer = actor ? (() => {
      try { assertPermission(actor, 'sponsors.official', null); return true; } catch { return false; }
    })() : false;
    // 404, e não 403: para quem não administra, o patrocinador desativado não
    // existe. Um 403 confirmaria a existência do id a quem não deveria sabê-la.
    if (!podeVer) throw new AppError(404, 'LOGO_NOT_FOUND', 'Logo não encontrada');
  }

  return linha.logoKey;
}

/**
 * Remoção DEFINITIVA — o caminho que não é o normal.
 *
 * O normal é desativar: o contrato acabou, a marca sai da vitrine, o registro
 * fica para quando ela voltar. Apagar existe para o engano — o patrocinador de
 * teste, a linha criada em duplicidade — e por isso exige motivo escrito, que
 * vai inteiro para a trilha.
 *
 * O objeto no armazenamento sai JUNTO: deixá-lo seria guardar a arte de um
 * contrato que o cliente mandou apagar.
 */
async function remover(id, motivo, actor) {
  assertPermission(actor, 'sponsors.official', null);
  const antes = await prisma.officialSponsor.findUnique({
    where: { id }, select: { ...CAMPOS, logoKey: true }
  });
  if (!antes) throw new AppError(404, 'SPONSOR_NOT_FOUND', 'Patrocinador não encontrado');

  await prisma.officialSponsor.delete({ where: { id } });

  await audit.record({
    actor, action: 'OFFICIAL_SPONSOR_DELETE', entity: 'OfficialSponsor', entityId: id,
    metadata: {
      motivo,
      code: antes.code, name: antes.name, level: antes.level,
      sortOrder: antes.sortOrder, active: antes.active, siteUrl: antes.siteUrl
    }
  });

  if (antes.logoKey) {
    await storage.descartar(antes.logoKey, { motivo: 'patrocinador removido', sponsorId: id });
  }

  return { id, removido: true };
}

module.exports = {
  NIVEIS,
  paraAVitrine,
  paraOPainel,
  criar,
  atualizar,
  trocarArte,
  arteParaEntrega,
  remover
};

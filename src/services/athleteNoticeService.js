const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');
const audit = require('./auditService');

// ============================================================================
// A MENSAGEM DE ABERTURA DA FEDERAÇÃO AOS SEUS ATLETAS.
//
// NÃO É NOTIFICAÇÃO E NÃO É POST. Notificação nasce de um evento que aconteceu
// com UMA pessoa ("seu resultado foi publicado"); post entra num feed que se
// rola e se esquece. Isto é o contrário das duas: um recado da organização
// para TODOS os seus atletas, que precisa ser visto ANTES de o atleta fazer
// qualquer outra coisa — abertura de inscrição, mudança de regulamento, prazo
// de filiação.
//
// TRÊS DECISÕES, E CADA UMA TEM TESTE:
//
//   * A VALIDADE É DO RECADO, e não da memória de quem o publicou. Um aviso
//     de setembro exibido em dezembro é ruído, e ninguém se lembra de apagar.
//     Fora da janela ele simplesmente não sai — sem depender de faxina.
//
//   * `showOnce` É O PADRÃO. Repetir o mesmo aviso a cada acesso ensina o
//     atleta a fechá-lo sem ler, e aí o aviso SEGUINTE — o que importava —
//     morre junto. Quem quiser insistência tem de pedi-la.
//
//   * A LEITURA É DE QUEM LEU. Ninguém marca leitura no lugar de outro: o RLS
//     exige que o usuário da linha seja o usuário da sessão. Numa federação,
//     "eu não fui avisado" é uma disputa real, e fabricar a prova de que
//     alguém foi comunicado é exatamente o que não pode ser possível.
// ============================================================================

const CAMPOS = Object.freeze({
  id: true, organizationId: true, title: true, body: true,
  startsAt: true, endsAt: true, showOnce: true, active: true,
  createdAt: true, updatedAt: true,
  createdBy: { select: { id: true, name: true } }
});

// Fora da janela o recado não sai. A comparação é do banco, e não da
// aplicação: quem decide "agora" tem de ser um relógio só.
const dentroDaJanela = agora => ({
  AND: [
    { OR: [{ startsAt: null }, { startsAt: { lte: agora } }] },
    { OR: [{ endsAt: null }, { endsAt: { gte: agora } }] }
  ]
});

function conferirJanela(startsAt, endsAt) {
  if (startsAt && endsAt && new Date(startsAt) > new Date(endsAt)) {
    throw new AppError(422, 'NOTICE_WINDOW_INVALID',
      'O início da validade não pode ser depois do fim.');
  }
}

// ------------------------------------------------------------------- ADMIN

async function list(filtros, actor) {
  const escopo = organizationFilter(actor, filtros.organizationId);
  assertCan(actor, 'athletes.manage', filtros.organizationId || null);

  const where = { ...escopo };
  if (filtros.active !== undefined) where.active = filtros.active;

  const items = await prisma.athleteNotice.findMany({
    where,
    select: { ...CAMPOS, _count: { select: { reads: true } } },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });

  return { items };
}

async function create(data, actor) {
  assertCan(actor, 'athletes.manage', data.organizationId);
  conferirJanela(data.startsAt, data.endsAt);

  const aviso = await prisma.athleteNotice.create({
    data: {
      organizationId: data.organizationId,
      title: data.title,
      body: data.body,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      showOnce: data.showOnce ?? true,
      active: data.active ?? true,
      createdById: actor.id
    },
    select: CAMPOS
  });

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_NOTICE_CREATE, entity: 'AthleteNotice', entityId: aviso.id,
    organizationId: aviso.organizationId,
    metadata: { title: aviso.title, showOnce: aviso.showOnce, startsAt: aviso.startsAt, endsAt: aviso.endsAt }
  });

  return aviso;
}

async function update(id, data, actor) {
  const atual = await prisma.athleteNotice.findUnique({
    where: { id },
    select: { id: true, organizationId: true, startsAt: true, endsAt: true, _count: { select: { reads: true } } }
  });
  if (!atual) throw new AppError(404, 'NOTICE_NOT_FOUND', 'Mensagem não encontrada');

  assertCan(actor, 'athletes.manage', atual.organizationId);
  conferirJanela(
    data.startsAt !== undefined ? data.startsAt : atual.startsAt,
    data.endsAt !== undefined ? data.endsAt : atual.endsAt
  );

  const aviso = await prisma.athleteNotice.update({ where: { id }, data, select: CAMPOS });

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_NOTICE_UPDATE, entity: 'AthleteNotice', entityId: id,
    organizationId: atual.organizationId,
    // QUANTA GENTE JÁ TINHA LIDO quando o texto mudou. Editar um recado que
    // cem pessoas já leram não é o mesmo ato que corrigir um rascunho, e a
    // trilha guarda a diferença sem que ninguém precise reconstruí-la.
    metadata: { campos: Object.keys(data), leiturasNoMomentoDaEdicao: atual._count.reads }
  });

  return aviso;
}

// APAGAR SÓ ENQUANTO NINGUÉM LEU.
//
// Depois que alguém leu, a linha de leitura é o registro de que a comunicação
// chegou — e apagar o recado apagaria o que aquela pessoa foi comunicada.
// Quem quer tirar do ar desativa; `active: false` some da vista do atleta e
// preserva a prova.
async function remove(id, actor) {
  const aviso = await prisma.athleteNotice.findUnique({
    where: { id },
    select: { id: true, organizationId: true, title: true, _count: { select: { reads: true } } }
  });
  if (!aviso) throw new AppError(404, 'NOTICE_NOT_FOUND', 'Mensagem não encontrada');

  assertCan(actor, 'athletes.manage', aviso.organizationId);

  if (aviso._count.reads > 0) {
    throw new AppError(409, 'NOTICE_ALREADY_READ',
      `Esta mensagem já foi lida por ${aviso._count.reads} pessoa(s) e não pode ser apagada: `
      + 'a marcação de leitura é o registro de que elas foram comunicadas. Desative a mensagem '
      + 'para tirá-la do ar sem apagar esse registro.');
  }

  await prisma.athleteNotice.delete({ where: { id } });

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_NOTICE_DELETE, entity: 'AthleteNotice', entityId: id,
    organizationId: aviso.organizationId, metadata: { title: aviso.title }
  });

  return { id, deleted: true };
}

// ------------------------------------------------------------------ ATLETA

// O que ESTE atleta tem para ler agora.
//
// A pergunta é feita a partir do CADASTRO DE ATLETA, e não do vínculo de
// membro: atleta não é membro da organização — ele tem cadastro nela, que é
// outra relação. Quem tem cadastro em duas federações recebe os recados das
// duas.
async function paraOAtleta(actor) {
  if (!actor?.id) throw new AppError(401, 'UNAUTHENTICATED', 'Autenticação necessária');

  const cadastros = await prisma.athlete.findMany({
    where: { userId: actor.id },
    select: { organizationId: true }
  });
  if (!cadastros.length) return { items: [] };

  const organizacoes = [...new Set(cadastros.map(cadastro => cadastro.organizationId))];
  const agora = new Date();

  const avisos = await prisma.athleteNotice.findMany({
    where: {
      organizationId: { in: organizacoes },
      active: true,
      ...dentroDaJanela(agora)
    },
    select: {
      ...CAMPOS,
      organization: { select: { id: true, name: true } },
      reads: { where: { userId: actor.id }, select: { readAt: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  // `showOnce` filtra AQUI, e não na consulta: o atleta precisa poder reabrir
  // um recado que já leu (é o que a lista "mensagens da federação" mostra), e
  // o que a leitura decide é se ele VOLTA A APARECER por cima da tela.
  const items = avisos.map(aviso => ({
    ...aviso,
    reads: undefined,
    readAt: aviso.reads[0]?.readAt ?? null,
    // Este é o campo que a tela usa para decidir se abre o modal. A regra
    // mora aqui, e não no cliente: um segundo lugar decidindo quando mostrar
    // um recado oficial é um segundo lugar para ela divergir.
    deveExibir: aviso.showOnce ? !aviso.reads.length : true
  }));

  return { items };
}

// MARCAR LEITURA É IDEMPOTENTE, e a idempotência é do BANCO.
//
// O índice único (noticeId, userId) é o que garante uma linha por pessoa: dois
// cliques no mesmo instante disputam a mesma chave, e o segundo é recusado
// pelo PostgreSQL. `skipDuplicates` transforma essa recusa em "já estava
// lido", que é a verdade.
async function marcarLido(id, actor) {
  if (!actor?.id) throw new AppError(401, 'UNAUTHENTICATED', 'Autenticação necessária');

  const aviso = await prisma.athleteNotice.findUnique({
    where: { id },
    select: { id: true, organizationId: true }
  });
  // O RLS já não devolveria o recado de uma federação onde este usuário não
  // tem cadastro nem vínculo; se ele chegou aqui nulo, é isso ou não existe.
  // Nos dois casos a resposta é a mesma, de propósito: dizer "existe, mas não
  // é seu" já entrega que existe.
  if (!aviso) throw new AppError(404, 'NOTICE_NOT_FOUND', 'Mensagem não encontrada');

  const cadastro = await prisma.athlete.findFirst({
    where: { userId: actor.id, organizationId: aviso.organizationId },
    select: { id: true }
  });
  if (!cadastro) throw new AppError(404, 'NOTICE_NOT_FOUND', 'Mensagem não encontrada');

  const gravado = await prisma.athleteNoticeRead.createMany({
    data: [{ noticeId: id, userId: actor.id }],
    skipDuplicates: true
  });

  return { id, read: true, jaEstavaLido: gravado.count === 0 };
}

module.exports = { list, create, update, remove, paraOAtleta, marcarLido };

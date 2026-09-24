import { execSync } from 'node:child_process';
import request from 'supertest';

// Ambiente da suíte definido antes de qualquer import do app: config e Prisma
// leem process.env na carga do módulo.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'suite-de-teste-segredo-com-tamanho-mais-que-suficiente';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || './uploads-test';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.BCRYPT_ROUNDS = '4';

const { default: app } = await import('../src/app.js');
const { default: prisma } = await import('../src/config/prisma.js');
const { withUserContext } = await import('../src/config/rlsSession.js');

export { app, prisma };

// Executa uma escrita de fixture em nome de um ator, usando o MESMO helper que
// a aplicação usa em produção — não uma reimplementação.
//
// Passou a ser necessário quando o RLS ganhou FORCE: o dono das tabelas
// deixou de ser isento das políticas, então montar cenário gravando direto no
// banco sem ator não funciona mais. Isso não é obstáculo do teste, é a prova
// de que a barreira passou a valer para todo mundo.
export const comoAtor = (usuario, callback) => withUserContext(usuario?.id ?? usuario, callback);

export const api = () => request(app);

// Ordem de limpeza: filhos antes de pais. Truncate com CASCADE resolveria em
// um comando, mas apagar na ordem torna explícito o grafo de dependências e
// falha alto se um modelo novo for esquecido.
const TABELAS = [
  'MessageReaction', 'Message', 'ConversationMember', 'Conversation',
  'StoryView', 'Story', 'CommentLike', 'Comment', 'PostLike', 'PostShare', 'PostSave', 'PostMedia', 'Post',
  'Block', 'ContentReport', 'Follow', 'CommunityMember',
  'RankingPoint', 'Ranking', 'ExternalResult', 'MuscleWarImportItem', 'MuscleWarImport',
  'RankingPointsRule',
  'ResultVersion', 'ResultEntry', 'Result',
  'JudgingScoreCriterion', 'JudgingScore', 'JudgingSession', 'PanelJudge', 'JudgePanel',
  'StageOrder', 'StageBatch', 'CredentialScan', 'Credential', 'WeighIn', 'CheckIn',
  'RegistrationItem', 'Registration',
  'AthleteBrandPartnership', 'Sponsorship', 'Sponsor', 'Brand',
  'AthleteProHistory', 'AthleteDocument', 'EventDocument',
  'CategoryRule', 'CompetitionClass', 'Division', 'EventCategory', 'Event',
  'RankingSeason', 'Athlete', 'Team', 'Gym', 'Coach',
  'SocialProfile', 'Notification', 'AuditLog', 'Affiliation',
  'OrganizationMember', 'Organization', 'User'
];

// Comunidades semeadas fazem parte do catálogo e sobrevivem à limpeza; as que
// um teste cria, não — do contrário um slug fixo colidiria na execução seguinte.
const COMUNIDADES_DO_CATALOGO = [
  'campeonato-brasileiro', 'bodybuilding', 'wellness', 'bikini', 'fitmodel', 'atletas-pro', 'coaches', 'academias'
];

export async function limparBanco() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABELAS.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.community.deleteMany({ where: { slug: { notIn: COMUNIDADES_DO_CATALOGO } } });
}

// Catálogo global (categorias, critérios, comunidades, regra padrão) é
// pré-requisito do domínio e não é apagado entre testes.
export function garantirCatalogo() {
  execSync('node prisma/seed.js', { stdio: 'pipe', env: process.env });
}

let contador = 0;
export const unico = prefixo => `${prefixo}-${Date.now().toString(36)}-${(contador += 1)}`;

// ---------------------------------------------------------------- construtores

// O cadastro aberto passou a exigir contato, endereço e nascimento. O helper
// manda o corpo COMPLETO de propósito: ele representa um cadastro real, e
// afrouxar a validação para a suíte não ter trabalho seria testar um sistema
// que não existe.
//
// `role` continua fora daqui: papel privilegiado não é autoatribuível, e a
// promoção é feita logo abaixo, direto no banco, como um administrador faria.
const CADASTRO_DE_TESTE = Object.freeze({
  password: 'senha-de-teste-123',
  birthDate: '1995-03-10',
  phone: '65999991234',
  whatsapp: '65988884321',
  postalCode: '78000000',
  addressLine: 'Rua de Teste',
  addressNumber: '100',
  state: 'MT',
  city: 'Cuiabá'
});

export async function criarUsuario({ role = 'ATHLETE', name = 'Usuário', email } = {}) {
  const endereco = email || `${unico('user')}@mci.test`;
  const resposta = await api().post('/api/v1/auth/register').send({ ...CADASTRO_DE_TESTE, name, email: endereco });
  if (resposta.status !== 201) throw new Error(`falha ao criar usuário: ${resposta.status} ${JSON.stringify(resposta.body)}`);

  // Papel privilegiado não é autoatribuível pelo cadastro aberto: a suíte
  // promove direto no banco, como um administrador faria pela rota de gestão.
  if (role !== 'ATHLETE') {
    await prisma.user.update({ where: { id: resposta.body.user.id }, data: { role } });
  }

  const login = await api().post('/api/v1/auth/login').send({ email: endereco, password: 'senha-de-teste-123' });

  return {
    id: resposta.body.user.id,
    email: endereco,
    role,
    token: login.body.token,
    profileId: (await prisma.socialProfile.findUnique({ where: { userId: resposta.body.user.id } }))?.id ?? null,
    auth: () => ({ Authorization: `Bearer ${login.body.token}` })
  };
}

// A FEDERAÇÃO DE TESTE NASCE RECEBENDO AUTOCADASTRO — e isto é decisão da
// FIXTURE, não do produto.
//
// Em produção o padrão continua FECHADO: `selfRegistrationOpen` é false, e
// abrir é ato administrativo com auditoria. Aqui, "uma federação" quase sempre
// quer dizer "uma federação em funcionamento", e exigir o interruptor em cada
// cenário só encheria as suítes de preparação repetida.
//
// O caminho FECHADO não deixou de ter prova por causa disto: ele é medido de
// propósito em `autocadastro-conclusao-automatica` ("federação com autocadastro
// fechado recusa, mesmo com o id da filiação em mãos") e em
// `autocadastro-da-organizacao`, que é a suíte do próprio interruptor.
//
// Quem precisar do padrão de produção passa `autocadastroAberto: false`.
export async function criarOrganizacao(admin, { name = 'MCI Brasil', slug, autocadastroAberto = true } = {}) {
  const resposta = await api()
    .post('/api/v1/organizations')
    .set(admin.auth())
    .send({ name, slug: slug || unico('org') });
  if (resposta.status !== 201) throw new Error(`falha ao criar organização: ${resposta.status} ${JSON.stringify(resposta.body)}`);

  if (autocadastroAberto) {
    const abertura = await api()
      .post(`/api/v1/organizations/${resposta.body.id}/self-registration`)
      .set(admin.auth())
      .send({ open: true });
    if (abertura.status !== 200) {
      throw new Error(`falha ao abrir o autocadastro: ${abertura.status} ${JSON.stringify(abertura.body)}`);
    }
  }

  return resposta.body;
}

export async function vincular(organizationId, usuario, role) {
  return prisma.organizationMember.create({ data: { organizationId, userId: usuario.id, role } });
}

// CPFs válidos gerados sob demanda: a validação de dígito é real, então a
// suíte não pode usar número inventado. A base é embaralhada para nunca cair
// numa sequência de dígitos repetidos, que a validação recusa de propósito.
export function gerarCpf(semente = Math.floor(Math.random() * 1e9)) {
  const base = String(Math.abs(Number(semente)) % 1e9).padStart(9, '0').split('').map(Number);

  // Sequência de dígito repetido não é CPF válido; um deslocamento posicional
  // desfaz a repetição sem tornar a geração imprevisível.
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const espalhada = base.map((digito, indice) => (digito + indice) % 10);
  if (new Set(espalhada).size === 1) espalhada[0] = (espalhada[0] + 3) % 10;

  const digito = (numeros, pesoInicial) => {
    const soma = numeros.reduce((total, valor, indice) => total + valor * (pesoInicial - indice), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const primeiro = digito(espalhada, 10);
  const segundo = digito([...espalhada, primeiro], 11);
  return [...espalhada, primeiro, segundo].join('');
}

export async function criarAtleta(operador, organizationId, dados = {}) {
  const resposta = await api()
    .post('/api/v1/athletes')
    .set(operador.auth())
    .send({
      organizationId,
      fullName: dados.fullName || 'Atleta de Teste',
      cpf: dados.cpf || gerarCpf(),
      sex: dados.sex || 'FEMALE',
      birthDate: dados.birthDate || '1996-05-10',
      state: dados.state || 'MT',
      city: dados.city || 'Cuiabá',
      ...dados
    });
  if (resposta.status !== 201) throw new Error(`falha ao criar atleta: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  return resposta.body;
}

/**
 * Monta um evento completo: categoria → divisão → classe.
 * Devolve os ids necessários para inscrever, julgar e apurar.
 */
export async function criarEventoCompleto(diretor, organizationId, { categoryCode = 'BIKINI', seasonId = null } = {}) {
  const evento = await api().post('/api/v1/events').set(diretor.auth()).send({
    organizationId,
    name: 'Etapa de Teste',
    slug: unico('evento'),
    startDate: '2026-11-20T12:00:00.000Z',
    seasonId
  });
  if (evento.status !== 201) throw new Error(`falha ao criar evento: ${evento.status} ${JSON.stringify(evento.body)}`);

  const categoria = await prisma.category.findUnique({ where: { code: categoryCode } });

  const eventCategory = await api().post(`/api/v1/events/${evento.body.id}/categories`).set(diretor.auth()).send({ categoryId: categoria.id });
  const division = await api().post(`/api/v1/event-categories/${eventCategory.body.id}/divisions`).set(diretor.auth()).send({ name: 'Até 163cm', code: 'ATE163' });
  const classe = await api().post(`/api/v1/divisions/${division.body.id}/classes`).set(diretor.auth()).send({ name: 'Open', code: 'OPEN' });

  return {
    event: evento.body,
    category: categoria,
    eventCategory: eventCategory.body,
    division: division.body,
    competitionClass: classe.body
  };
}

export async function transicionar(diretor, eventId, estados) {
  for (const status of estados) {
    const resposta = await api().post(`/api/v1/events/${eventId}/transition`).set(diretor.auth()).send({ status });
    if (resposta.status !== 200) throw new Error(`falha na transição para ${status}: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  }
}

export async function inscrever(operador, eventId, { cpf, athlete, classIds }) {
  const resposta = await api().post(`/api/v1/events/${eventId}/registrations`).set(operador.auth()).send({ cpf, athlete, classIds });
  if (resposta.status !== 201) throw new Error(`falha na inscrição: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  return resposta.body;
}

// ============================================================================
// DADO LEGADO: DUAS PESSOAS COM A MESMA MATRÍCULA.
//
// Desde a migration `20260921120000_matricula_identifica_um_atleta`, a
// matrícula identifica UM atleta por (organização, filiação): há guarda no
// serviço e índice único parcial no banco. A ambiguidade não NASCE mais.
//
// Ela ainda EXISTE, porém, em base que rodou anos sem o índice — e é para esse
// dado que o importador continua marcando CONFLITO em vez de escolher. Medir
// essa defesa exige montar o cenário, e montá-lo exige derrubar o índice: com
// ele no lugar o `INSERT` é recusado, e um teste que não monta o cenário não
// prova nada.
//
// A CLÁUSULA `finally` NÃO É ZELO: recriar o índice com as linhas ambíguas
// ainda lá falha com "Duplicate keys exist", e falhar aqui deixaria toda a
// suíte seguinte rodando sem a trava, medindo um banco errado. Por isso as
// linhas ambíguas saem ANTES, e a ausência do índice ao final é erro.
//
// Em produção, limpar duplicata é decisão humana — qual dos dois cadastros
// fica. Aqui é descarte de fixture.
// ============================================================================
export const INDICE_DE_MATRICULA = 'Athlete_organizationId_affiliationId_affiliationNumber_key';

export async function indiceDeMatriculaExiste() {
  const [linha] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${INDICE_DE_MATRICULA}'`);
  return linha.n === 1;
}

export async function criarIndiceDeMatricula() {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INDICE_DE_MATRICULA}" ON "Athlete"
     ("organizationId", "affiliationId", "affiliationNumber")
     WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL`);
}

export async function comMatriculaDuplicadaPermitida(callback) {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDICE_DE_MATRICULA}"`);
  try {
    return await callback();
  } finally {
    // O BANCO É ESVAZIADO ANTES DE O ÍNDICE VOLTAR, e não é exagero: com as
    // linhas ambíguas ainda lá, `CREATE UNIQUE INDEX` falha com "Duplicate keys
    // exist" e a suíte inteira seguiria sem a trava. `limparBanco` é TRUNCATE,
    // que não passa por política de RLS — apagar as duplicatas com DELETE
    // esbarraria justamente nas políticas que este projeto não afrouxa. O
    // `beforeEach` de cada arquivo recria o cenário do teste seguinte.
    await limparBanco();
    await criarIndiceDeMatricula();
  }
}

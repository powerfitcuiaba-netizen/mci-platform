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

export { app, prisma };

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

export async function criarUsuario({ role = 'ATHLETE', name = 'Usuário', email } = {}) {
  const endereco = email || `${unico('user')}@mci.test`;
  const resposta = await api().post('/api/v1/auth/register').send({ name, email: endereco, password: 'senha-de-teste-123' });
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

export async function criarOrganizacao(admin, { name = 'MCI Brasil', slug } = {}) {
  const resposta = await api()
    .post('/api/v1/organizations')
    .set(admin.auth())
    .send({ name, slug: slug || unico('org') });
  if (resposta.status !== 201) throw new Error(`falha ao criar organização: ${resposta.status} ${JSON.stringify(resposta.body)}`);
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

const { maskCpf, formatCpf } = require('./cpf');
const { can } = require('./permissions');

// ============================================================================
// Serializadores por nível de acesso.
//
// Classificação dos dados (§52 do escopo):
//   PÚBLICO        nome, nome esportivo, cidade/estado, categoria, títulos,
//                  resultados publicados, ranking, conteúdo social público
//   PRIVADO        documentos, mensagens, posts restritos
//   RESTRITO       CPF, telefone, e-mail pessoal, resultados não publicados
//   ADMINISTRATIVO trilha de auditoria, papéis, importações
//
// O CPF nunca aparece em resposta pública. Quem tem `athletes.read_sensitive`
// recebe mascarado; o número inteiro só sai com `search.sensitive`, e sempre
// deixa rastro na auditoria de quem o consultou.
// ============================================================================

// O CPF pode não vir: a política de "AthleteIdentity" só o entrega a operador
// da organização ou ao próprio atleta. Ausência é resposta legítima, não erro.
const cpfDe = (athlete, formatar) => (athlete?.identity?.cpf ? formatar(athlete.identity.cpf) : null);

function athletePublic(athlete) {
  if (!athlete) return null;
  return {
    id: athlete.id,
    fullName: athlete.fullName,
    stageName: athlete.stageName ?? null,
    sex: athlete.sex,
    country: athlete.country ?? null,
    state: athlete.state ?? null,
    city: athlete.city ?? null,
    // A CHAVE de armazenamento NÃO sai daqui. Ela é referência interna do
    // provedor (caminho dentro do bucket) e não serve a nenhum cliente: a foto
    // é buscada por `GET /media/athletes/:id/photo`, que decide quem pode vê-la.
    // Devolver a chave só entregava a estrutura interna do armazenamento a
    // quem abrisse a vitrine pública.
    hasPhoto: Boolean(athlete.photoKey),
    athleteNumber: athlete.athleteNumber ?? null,
    proStatus: athlete.proStatus,
    proSince: athlete.proSince ?? null,
    team: athlete.team ? { id: athlete.team.id, name: athlete.team.name } : null,
    coach: athlete.coach ? { id: athlete.coach.id, name: athlete.coach.name } : null,
    gym: athlete.gym ? { id: athlete.gym.id, name: athlete.gym.name } : null,
    affiliation: athlete.affiliation ? { id: athlete.affiliation.id, name: athlete.affiliation.name, code: athlete.affiliation.code } : null,
    createdAt: athlete.createdAt
  };
}

// `viewer` é o usuário autenticado; `organizationId` é o tenant do recurso.
function athleteFor(athlete, viewer, organizationId = null) {
  const base = athletePublic(athlete);
  if (!base || !viewer) return base;

  const podeVerRestrito = can(viewer, 'athletes.read_sensitive', organizationId ?? athlete.organizationId);
  const podeVerCpfIntegral = can(viewer, 'search.sensitive', organizationId ?? athlete.organizationId);
  const ehODono = athlete.userId && athlete.userId === viewer.id;

  if (!podeVerRestrito && !ehODono) return base;

  return {
    ...base,
    organizationId: athlete.organizationId,
    userId: athlete.userId ?? null,
    // O ESTADO ADMINISTRATIVO fica na camada RESTRITA, e não na pública.
    //
    // Que um atleta está suspenso é decisão interna da federação: publicá-la
    // ao lado do nome, na vitrine, seria a plataforma divulgando uma sanção
    // que a organização não mandou divulgar. Quem opera precisa ver; o
    // visitante, não.
    status: athlete.status ?? 'ACTIVE',
    statusReason: athlete.statusReason ?? null,
    statusChangedAt: athlete.statusChangedAt ?? null,
    birthDate: athlete.birthDate ?? null,
    phone: athlete.phone ?? null,
    email: athlete.email ?? null,
    // O CPF vem de "AthleteIdentity", tabela com política própria: quem não
    // pode lê-lo recebe `identity` nulo do banco e o campo sai como null aqui.
    // A camada de aplicação continua decidindo entre inteiro e mascarado, mas
    // deixou de ser a única coisa entre o número e a resposta.
    cpf: cpfDe(athlete, ehODono || podeVerCpfIntegral ? formatCpf : maskCpf),
    cpfMasked: cpfDe(athlete, maskCpf),
    // A MATRÍCULA na entidade de filiação fica na camada restrita, junto de
    // nascimento, telefone e e-mail — e fora de `athletePublic`.
    //
    // Ela não é documento pessoal, mas é a chave pela qual os resultados
    // oficiais reconhecem o atleta: publicá-la ao lado do nome entregaria, a
    // quem quiser, o par (nome, matrícula) que basta para reivindicar um
    // histórico. A entidade continua pública; o número dentro dela, não.
    affiliationNumber: athlete.affiliationNumber ?? null
  };
}

function userPublic(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role };
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    role: user.role,
    organizations: (user.memberships || []).map(m => ({
      organizationId: m.organizationId,
      role: m.role,
      name: m.organization?.name ?? null,
      slug: m.organization?.slug ?? null
    })),
    athleteId: user.athlete?.id ?? null,
    profileId: user.socialProfile?.id ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function profilePublic(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    kind: profile.kind,
    bio: profile.bio ?? null,
    // Mesma regra da foto de atleta: a chave é interna, a entrega é por rota
    // com id (`GET /media/profiles/:id/avatar`). `coverKey` saiu junto — é a
    // mesma classe de referência e nenhuma tela a consumia.
    hasAvatar: Boolean(profile.avatarKey),
    isPrivate: profile.isPrivate,
    athleteId: profile.athleteId ?? null,
    createdAt: profile.createdAt
  };
}

// Resultado só sai completo depois de publicado. Antes disso é dado restrito e
// só chega a quem tem `results.read_unpublished`.
function resultFor(result, viewer, organizationId = null) {
  if (!result) return null;
  const publicado = result.status === 'PUBLISHED';
  const podeVerRascunho = viewer ? can(viewer, 'results.read_unpublished', organizationId) : false;

  if (!publicado && !podeVerRascunho) return null;

  return {
    id: result.id,
    eventId: result.eventId,
    classId: result.classId,
    status: result.status,
    version: result.version,
    checksum: result.checksum,
    hasUnresolvedTie: result.hasUnresolvedTie,
    computedAt: result.computedAt,
    publishedAt: result.publishedAt ?? null,
    entries: (result.entries || []).map(entry => ({
      placing: entry.placing,
      status: entry.status,
      score: entry.score,
      rawScore: entry.rawScore,
      breakdown: entry.breakdown,
      athlete: athletePublic(entry.athlete),
      registrationItemId: entry.registrationItemId
    }))
  };
}

module.exports = { athletePublic, athleteFor, userPublic, sanitizeUser, profilePublic, resultFor };

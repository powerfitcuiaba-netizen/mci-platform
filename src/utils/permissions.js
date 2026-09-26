const { USER_ROLES } = require('./roles');

// ============================================================================
// RBAC granular.
//
// A matriz é a única fonte de verdade sobre autorização: rotas e services
// perguntam por permissão nomeada, nunca por papel. Trocar o que um papel pode
// fazer é editar esta tabela — e a tabela é coberta por teste, de modo que uma
// permissão concedida por engano aparece como falha, não como brecha silenciosa.
//
// A permissão efetiva de um usuário é a união do papel global (User.role) com
// os papéis que ele tem na organização em questão (OrganizationMember.role).
// Não existe herança por "nível": um JUDGE não é um ADMIN pequeno, é outro
// conjunto de permissões.
// ============================================================================

const PERMISSIONS = Object.freeze([
  'organizations.read', 'organizations.manage',
  'events.read', 'events.create', 'events.update', 'events.publish', 'events.delete',
  'categories.read', 'categories.manage',
  'athletes.read', 'athletes.read_sensitive', 'athletes.create', 'athletes.update', 'athletes.manage',
  // Transferir é tirar o atleta de OUTRA equipe: ato do operador da Muscle
  // Contest, separado de `athletes.update`, que só permite vincular um atleta
  // sem equipe. É essa separação que impede o treinador de transferir sozinho.
  'athletes.transfer',
  'affiliations.read', 'affiliations.manage',
  'registrations.read', 'registrations.create', 'registrations.cancel',
  'documents.read', 'documents.upload', 'documents.delete',
  'checkin.read', 'checkin.operate',
  'weighin.read', 'weighin.operate',
  'credentials.read', 'credentials.manage', 'credentials.scan',
  'stage.read', 'stage.manage',
  'results.read', 'results.read_unpublished', 'results.receive', 'results.publish', 'results.override',
  'ranking.read', 'ranking.manage',
  'pro.read', 'pro.manage',
  'musclewar.import', 'musclewar.review', 'musclewar.apply',
  'teams.manage', 'companies.manage', 'coaches.manage', 'gyms.manage',
  // ------------------------------------------- módulo Treinadores & Equipes
  // Aprovar ou rejeitar cadastro de treinador. Decisão R-03: é da
  // administração CENTRAL, e nenhuma federação a recebe por ter papel de
  // operador.
  'coaches.approve',
  // Autorizar o treinador global a atuar numa federação. Decisão R-04:
  // identidade é global, atuação é por organização — e conceder atuação não é
  // ato de quem vai atuar.
  'coaches.authorize_org',
  // O treinador lendo o que é dele: o próprio cadastro e a própria equipe.
  'coaches.read_own', 'teams.read_own',
  // Localizar atleta por matrícula + entidade de filiação, sem CPF e sem
  // documento. Existe separada de `athletes.read_sensitive` justamente para que
  // o treinador possa identificar sem alcançar dado pessoal.
  'athletes.lookup_affiliation',
  // Pedir vínculo. Pedir NÃO é vincular: o vínculo depende da confirmação do
  // atleta, e quem grava é `membershipService.linkTeam`.
  'teams.request_membership',
  // Conceder e revogar delegação central. Decisão R-02. NÃO é delegável (ver
  // PERMISSOES_NAO_DELEGAVEIS), para que a cadeia termine em SUPER_ADMIN.
  'central.grant',
  // Cadastrar um técnico é uma coisa; amarrar esse cadastro a uma CONTA da
  // plataforma é outra, e por isso são duas permissões. `Coach.userId` é
  // UNIQUE: quem ocupa o vínculo de uma conta impede que qualquer outro o
  // faça depois — inclusive a federação a que o técnico pertence. Como
  // `Coach` é global por desenho, esse bloqueio atravessaria federações.
  'coaches.link_account',
  'brands.manage', 'sponsors.manage',
  'social.read', 'social.write', 'social.moderate', 'social.delete',
  'messenger.use', 'messenger.moderate',
  'communities.read', 'communities.write', 'communities.manage',
  'notifications.read',
  'search.read', 'search.sensitive',
  'analytics.read',
  'audit.read',
  'users.read', 'users.manage'
]);

const PERMISSION_SET = new Set(PERMISSIONS);

// ============================================================================
// PERMISSÕES QUE NÃO SE GANHA POR PAPEL — DECISÃO R-02.
//
// Transferir, desvincular e corrigir vínculo alteram a ATRIBUIÇÃO DE PONTOS. A
// decisão R-02 diz que só `SUPER_ADMIN` ou administrador central FORMALMENTE
// AUTORIZADO efetiva isso. "Formalmente autorizado" não é papel genérico: é uma
// concessão com autor, motivo, escopo e prazo, que vive em
// `CentralAuthorization`.
//
// O QUE MUDOU, E O QUE ISSO CUSTA
//
// Antes desta fase `athletes.transfer` estava na lista de `EVENT_DIRECTOR`, e
// `ADMIN` a recebia por construção (a lista dele é `PERMISSIONS` menos
// `organizations.manage`). Ou seja: diretor de evento e administrador de
// plataforma transferiam atleta sem concessão nenhuma.
//
// Agora nenhum dos dois recebe por papel. `SUPER_ADMIN` continua tendo, por
// construção. Qualquer outro — inclusive `ADMIN` — precisa de uma delegação
// viva. É restrição de comportamento existente, aprovada em R-02, e há teste
// que mede exatamente a recusa do diretor.
const PERMISSOES_CENTRAIS_DELEGADAS = Object.freeze(['athletes.transfer']);

// E ESTA NÃO SE DELEGA DE JEITO NENHUM.
//
// Se `central.grant` fosse delegável, um delegado poderia delegar para si mesmo
// um poder maior — autoelevação com um passo a mais. A cadeia de concessão
// termina em `SUPER_ADMIN`, sempre.
const PERMISSOES_NAO_DELEGAVEIS = Object.freeze(['central.grant']);

const DELEGADAS = new Set(PERMISSOES_CENTRAIS_DELEGADAS);
const NAO_DELEGAVEIS = new Set(PERMISSOES_NAO_DELEGAVEIS);

// Todo mundo que está autenticado tem isto, seja qual for o papel.
const BASE_AUTENTICADO = Object.freeze([
  'events.read', 'categories.read', 'athletes.read', 'affiliations.read',
  'results.read', 'ranking.read', 'pro.read',
  'social.read', 'social.write', 'messenger.use',
  'communities.read', 'communities.write',
  'notifications.read', 'search.read'
]);

const operacional = (...extra) => Object.freeze([...BASE_AUTENTICADO, ...extra]);

const ROLE_PERMISSIONS = Object.freeze({
  // SUPER_ADMIN recebe tudo por construção (ver permissionsForRole), inclusive
  // permissões acrescentadas depois desta linha.
  SUPER_ADMIN: Object.freeze([...PERMISSIONS]),

  // ADMIN recebe tudo menos `organizations.manage` E menos as centrais
  // delegadas (R-02). Ele continua sendo papel de plataforma; o que ele perdeu é
  // o poder de mexer na atribuição de pontos SEM concessão registrada.
  ADMIN: Object.freeze(PERMISSIONS.filter(p => p !== 'organizations.manage' && !DELEGADAS.has(p))),

  EVENT_DIRECTOR: operacional(
    'organizations.read',
    'events.create', 'events.update', 'events.publish', 'events.delete',
    // `categories.manage` NÃO está aqui, e a ausência é a decisão da fase F2.
    //
    // O catálogo de categorias é OFICIAL e NACIONAL: onze categorias,
    // provisionadas por `20260922210000_catalogo_oficial_de_categorias` e
    // fixadas por `tests/catalogo-oficial-de-categorias.test.mjs`. `Category`
    // não tem `organizationId` — não existe catálogo "da federação".
    //
    // Enquanto esta permissão esteve aqui, o diretor de QUALQUER federação
    // escrevia no catálogo de TODAS. E o alcance medido não era cosmético: a
    // guarda do importador (`muscleWarService.js:406`) recusa a linha cuja
    // categoria não está no catálogo, então quem escreve no catálogo escolhe a
    // resposta da guarda. Medido ponta a ponta: categoria criada com 201, o
    // mesmo lote saindo de CONFLICT para reconhecido, apply 200 e 5 pontos no
    // ledger sob um recorte que a Muscle Contest nunca homologou.
    //
    // É o mesmo desenho de `results.override`, pelo mesmo motivo: o que é
    // oficial e divulgado pertence à plataforma, não a quem conduz a etapa.
    'affiliations.manage',
    'athletes.create', 'athletes.update', 'athletes.manage', 'athletes.read_sensitive',
    // `athletes.transfer` NÃO ESTÁ AQUI, e a ausência é a decisão R-02.
    //
    // Ele conduz a etapa inteira, mas tirar um atleta de uma equipe muda a
    // atribuição de pontos — e isso passou a exigir `SUPER_ADMIN` ou delegação
    // central registrada. Vincular atleta SEM equipe continua sendo dele, por
    // `athletes.update`: é a distinção que `membershipService` já fazia.
    //
    // Ele ganha `athletes.lookup_affiliation` porque o operador da federação
    // precisa localizar atleta por matrícula tanto quanto o treinador.
    'athletes.lookup_affiliation',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload', 'documents.delete',
    'checkin.read', 'checkin.operate', 'weighin.read', 'weighin.operate',
    'credentials.read', 'credentials.manage', 'credentials.scan',
    'stage.read', 'stage.manage',
    'results.read_unpublished', 'results.receive', 'results.publish',
    'ranking.manage', 'pro.manage',
    'musclewar.import', 'musclewar.review', 'musclewar.apply',
    'teams.manage', 'companies.manage', 'coaches.manage', 'gyms.manage', 'brands.manage', 'sponsors.manage',
    // AUTORIZAR O TREINADOR A ATUAR NESTA FEDERAÇÃO — decisão R-04.
    //
    // Fica com a federação de propósito, e a divisão é o ponto da decisão: quem
    // APROVA o cadastro de treinador é a administração CENTRAL (R-03, permissão
    // `coaches.approve`, que NÃO está nesta lista); quem decide se aquele
    // treinador atua AQUI é a federação. Juntar as duas na administração central
    // esvaziaria a separação entre identidade e atuação que R-04 criou; juntar as
    // duas na federação devolveria a ela o poder de criar treinador reconhecido
    // nacionalmente, que é justamente o que R-03 tirou.
    //
    // O tenant continua valendo: `perm('coaches.authorize_org', orgDoCorpo)` na
    // rota e `assertCan` no serviço, ambos contra a organização do corpo. A
    // federação A não autoriza atuação na federação B — medido.
    'coaches.authorize_org',
    'analytics.read', 'search.sensitive', 'users.read'
  ),

  EVENT_COORDINATOR: operacional(
    'events.update',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload',
    'checkin.read', 'checkin.operate', 'weighin.read', 'weighin.operate',
    'credentials.read', 'credentials.manage', 'credentials.scan',
    'stage.read', 'stage.manage',
    'results.read_unpublished',
    'analytics.read'
  ),

  // O julgamento acontece FORA do MCI. Estes dois papéis continuam existindo
  // porque são valores do enum `UserRole` no banco e apagá-los exigiria uma
  // migration destrutiva; o que mudou é o que eles concedem. Nenhum dos dois
  // julga aqui: o coordenador lança o resultado oficial recebido, e o juiz só
  // acompanha a operação de palco.
  JUDGE_COORDINATOR: operacional(
    'stage.read', 'results.read_unpublished', 'results.receive'
  ),

  JUDGE: operacional('stage.read', 'registrations.read'),

  STAFF: operacional('registrations.read', 'stage.read', 'credentials.scan', 'checkin.read'),

  REGISTRATION_OPERATOR: operacional(
    'athletes.create', 'athletes.update', 'athletes.read_sensitive',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload', 'affiliations.manage', 'search.sensitive'
  ),

  CHECKIN_OPERATOR: operacional('registrations.read', 'checkin.read', 'checkin.operate', 'athletes.read_sensitive', 'credentials.scan', 'search.sensitive'),

  WEIGHIN_OPERATOR: operacional('registrations.read', 'weighin.read', 'weighin.operate', 'athletes.read_sensitive', 'search.sensitive'),

  RESULTS_OPERATOR: operacional('results.read_unpublished', 'results.receive', 'results.publish', 'stage.read'),

  RANKING_MANAGER: operacional('ranking.manage', 'results.read_unpublished', 'musclewar.import', 'musclewar.review', 'musclewar.apply', 'pro.manage'),

  SOCIAL_ADMIN: operacional('social.moderate', 'social.delete', 'communities.manage', 'messenger.moderate', 'brands.manage', 'sponsors.manage'),

  MODERATOR: operacional('social.moderate', 'social.delete', 'messenger.moderate'),

  // A CONTA DE SERVIÇO DA FEDERAÇÃO NÃO TEM PERMISSÃO DE APLICAÇÃO NENHUMA.
  //
  // Não é descuido, é o desenho. O poder dela mora no BANCO — `mci_operator_of`
  // a reconhece, e o RLS a prende a uma federação. Aqui em cima, toda rota que
  // passa por `assertCan` lhe é negada, inclusive as da própria federação.
  //
  // Se algum dia esta linha ganhar permissões, a conta deixa de ser uma
  // identidade de execução e vira um usuário privilegiado sem dono — que é
  // exatamente o que ela foi criada para não ser.
  FEDERATION_SERVICE: operacional(),

  ATHLETE: operacional(),
  // O TREINADOR, e só o que é dele.
  //
  // Lê o próprio cadastro e a própria equipe, localiza atleta por matrícula
  // (sem CPF, sem documento) e PEDE vínculo. Não aprova, não transfere, não
  // desvincula, não toca em ponto, não lê dado sensível de ninguém.
  COACH: operacional(
    'registrations.read',
    'coaches.read_own', 'teams.read_own',
    'athletes.lookup_affiliation', 'teams.request_membership'
  ),
  GYM: operacional(),
  TEAM: operacional(),
  BRAND: operacional(),
  SPONSOR: operacional(),
  MEDIA: operacional()
});

// SUPER_ADMIN nunca fica para trás quando uma permissão nova é criada.
function permissionsForRole(role) {
  if (role === 'SUPER_ADMIN') return new Set(PERMISSIONS);
  return new Set(ROLE_PERMISSIONS[role] || []);
}

// Permissões efetivas: papel global + papéis do usuário na organização
// informada. Sem organização, só o papel global conta — é assim que um
// operador de uma organização não opera outra.
function effectivePermissions(user, organizationId = null, agora = new Date()) {
  if (!user) return new Set();

  const efetivas = permissionsForRole(user.role);

  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  for (const membership of memberships) {
    if (organizationId && membership.organizationId !== organizationId) continue;
    for (const permissao of permissionsForRole(membership.role)) efetivas.add(permissao);
  }

  // DELEGAÇÕES CENTRAIS — decisão R-02.
  //
  // Vêm do banco já filtradas por `revokedAt: null` (ver `userRepository`). Aqui
  // se aplicam as três regras que sobram, e cada uma existe por um motivo:
  //
  //   PRAZO: concessão vencida não vale, e não depende de job para parar de
  //   valer. Conferir na hora é o que faz a expiração ser real.
  //
  //   ESCOPO: `organizationId` nulo na concessão vale para todas as federações;
  //   com organização, vale só para ela. Uma concessão da federação A não pode
  //   autorizar operação na B — é a mesma regra de tenant do resto do sistema.
  //
  //   NÃO DELEGÁVEL: `central.grant` é ignorada mesmo se alguém a gravar na
  //   tabela. Sem isso, um delegado delegaria para si mesmo um poder maior, e a
  //   cadeia de concessão deixaria de terminar em SUPER_ADMIN.
  const concessoes = Array.isArray(user.centralGrantsReceived) ? user.centralGrantsReceived : [];
  for (const concessao of concessoes) {
    if (NAO_DELEGAVEIS.has(concessao.permission)) continue;
    if (!PERMISSION_SET.has(concessao.permission)) continue;
    // A LISTA BRANCA VALE NA LEITURA TAMBÉM, e não só na escrita.
    //
    // `centralAuthorizationService.conceder` recusa conceder o que não está em
    // `PERMISSOES_CENTRAIS_DELEGADAS` — mas a política `central_concessao`
    // autoriza o administrador de plataforma a inserir QUALQUER linha, e um
    // script, uma migration ou uma mão humana no banco não passam pelo serviço.
    // Sem esta linha, uma linha com `permission: 'users.manage'` gravada por
    // fora viraria poder de gerenciar contas da plataforma inteira.
    //
    // É a mesma razão pela qual `central.grant` é ignorada aqui: a autorização
    // não pode depender de a escrita ter passado pelo caminho certo. Duas
    // conferências, uma em cada ponta, e a da leitura é a que decide.
    if (!DELEGADAS.has(concessao.permission)) continue;
    if (concessao.expiresAt && new Date(concessao.expiresAt) <= agora) continue;
    if (concessao.organizationId && organizationId && concessao.organizationId !== organizationId) continue;
    // Concessão com escopo de organização NÃO vale para pergunta sem escopo: a
    // ausência de organização significa "em qualquer lugar", e não é isso que
    // uma delegação local concede.
    if (concessao.organizationId && !organizationId) continue;
    efetivas.add(concessao.permission);
  }

  return efetivas;
}

function can(user, permission, organizationId = null, agora = new Date()) {
  if (!PERMISSION_SET.has(permission)) {
    throw new Error(`Permissão desconhecida: ${permission}`);
  }
  return effectivePermissions(user, organizationId, agora).has(permission);
}

// Organizações às quais o usuário pertence. SUPER_ADMIN e ADMIN não são
// limitados por vínculo — são papéis da plataforma, não de um tenant.
function isCrossTenant(user) {
  return Boolean(user) && (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN');
}

function organizationIdsOf(user) {
  if (!user) return [];
  return [...new Set((user.memberships || []).map(m => m.organizationId))];
}

function belongsToOrganization(user, organizationId) {
  if (!user || !organizationId) return false;
  if (isCrossTenant(user)) return true;
  return organizationIdsOf(user).includes(organizationId);
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  PERMISSOES_CENTRAIS_DELEGADAS,
  PERMISSOES_NAO_DELEGAVEIS,
  USER_ROLES,
  permissionsForRole,
  effectivePermissions,
  can,
  isCrossTenant,
  organizationIdsOf,
  belongsToOrganization
};

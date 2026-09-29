// ==========================================================================
// ESPELHO DA MATRIZ DE PERMISSÕES DO SERVIDOR — E SÓ ISSO.
//
// Esta tabela NÃO autoriza nada. Quem autoriza é a API, que confere a matriz
// de verdade a cada requisição e responde 403 para quem não pode. O que existe
// aqui serve a uma finalidade só: não OFERECER ao operador um caminho que
// terminaria em 403 — menu que leva a lugar nenhum e botão que só falha depois
// do clique são ruído, não segurança.
//
// Morava dentro de `App.jsx` enquanto decidia apenas o menu. Saiu para cá
// quando a listagem de importações passou a esconder a ação destrutiva de quem
// não pode executá-la: duas telas lendo a mesma tabela não podem ter duas
// cópias dela, ou uma envelhece sem ninguém notar.
// ==========================================================================

export const PERMISSOES_POR_PAPEL = {
  SUPER_ADMIN: ['*'],
  ADMIN: ['*'],
  EVENT_DIRECTOR: ['analytics.read', 'events.update', 'athletes.manage', 'registrations.read', 'checkin.operate', 'weighin.operate', 'credentials.read', 'stage.read', 'results.read_unpublished', 'ranking.manage', 'musclewar.review', 'musclewar.apply', 'users.read',
    // A FEDERAÇÃO AUTORIZA O TREINADOR A ATUAR NELA — decisão R-04. Note que
    // `coaches.approve` NÃO está aqui: aprovar o CADASTRO é da administração
    // central (R-03), e é justamente essa divisão que o módulo cria.
    'coaches.authorize_org', 'teams.manage', 'athletes.lookup_affiliation'],
  EVENT_COORDINATOR: ['analytics.read', 'events.update', 'registrations.read', 'checkin.operate', 'weighin.operate', 'credentials.read', 'stage.read', 'results.read_unpublished'],
  JUDGE_COORDINATOR: ['stage.read', 'results.read_unpublished'],
  JUDGE: ['stage.read', 'registrations.read'],
  STAFF: ['registrations.read', 'stage.read', 'checkin.read'],
  REGISTRATION_OPERATOR: ['registrations.read'],
  CHECKIN_OPERATOR: ['registrations.read', 'checkin.operate'],
  WEIGHIN_OPERATOR: ['registrations.read', 'weighin.operate'],
  RESULTS_OPERATOR: ['results.read_unpublished', 'stage.read'],
  RANKING_MANAGER: ['ranking.manage', 'results.read_unpublished', 'musclewar.review', 'musclewar.apply'],
  SOCIAL_ADMIN: [],
  MODERATOR: [],
  ATHLETE: [],
  // O TREINADOR, e só o que é dele. Espelha a linha `COACH` do backend: lê o
  // próprio cadastro e a própria equipe, localiza atleta por matrícula e PEDE
  // vínculo. Não aprova, não transfere, não desvincula.
  COACH: ['registrations.read', 'coaches.read_own', 'teams.read_own', 'athletes.lookup_affiliation', 'teams.request_membership'],
  // `TEAM` é papel LEGADO e fica vazio como `ATHLETE` e `GYM` ficam: este mapa
  // só espelha as permissões que a INTERFACE usa para decidir menu e botão, e
  // nenhum desses papéis tem alguma. No servidor eles têm as leituras comuns de
  // `BASE_AUTENTICADO` — o que nenhum deles tem é permissão de treinador.
  //
  // A linha existe para `permissoesDe` não devolver `undefined` e estourar
  // qualquer `can()` na tela de quem administra uma conta legada.
  GYM: [], TEAM: [], BRAND: [], SPONSOR: [], MEDIA: [],

  // VAZIO, e é o desenho. A conta de serviço da federação não tem permissão
  // de aplicação nenhuma: o poder dela existe só no banco, onde o RLS a prende
  // a uma federação. Este mapa é o espelho do backend, e lá também está vazio.
  FEDERATION_SERVICE: []
};

/** União das permissões do papel global do usuário e dos vínculos por organização. */
export function permissoesDe(user) {
  if (!user) return new Set();
  const papeis = [user.role, ...(user.organizations || []).map(vinculo => vinculo.role)];
  const conjunto = new Set();

  for (const papel of papeis) {
    const lista = PERMISSOES_POR_PAPEL[papel] || [];
    if (lista.includes('*')) return new Set(['*']);
    for (const permissao of lista) conjunto.add(permissao);
  }
  return conjunto;
}

/** `pode('musclewar.apply')` a partir de um conjunto devolvido por `permissoesDe`. */
export const podeCom = permissoes => permissao => permissoes.has('*') || permissoes.has(permissao);

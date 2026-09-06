'use strict';

const { AppError } = require('../../utils/errors');

// ============================================================================
// RBAC GRANULAR.
//
// O papel não carrega poder por si: ele carrega uma lista explícita de
// permissões. A diferença é prática — com nível numérico ("juiz é 3, promotor
// é 4") não há como dizer que o juiz pontua mas não vê contrato, porque tudo
// acima do nível dele passa a valer. Com permissão nomeada, dá.
//
// Isto é a camada de decisão. Não substitui a checagem no banco: quem responde
// "este juiz pode ver ESTA bateria" é a política de RLS, porque o frontend não
// é camada de segurança (seção 13).
// ============================================================================

const PERMISSOES = Object.freeze([
  // Organizações e identidade
  'organizations.read', 'organizations.create', 'organizations.update', 'organizations.members.manage',
  'users.read', 'users.create', 'users.update', 'users.roles.manage',

  // Atletas
  'athletes.read', 'athletes.read.sensitive', 'athletes.create', 'athletes.update', 'athletes.delete',
  'athletes.pro.manage',

  // Estrutura competitiva
  'events.read', 'events.create', 'events.update', 'events.publish', 'events.cancel',
  'categories.read', 'categories.manage',

  // Inscrições
  'registrations.read', 'registrations.create', 'registrations.update',
  'registrations.approve', 'registrations.cancel',

  // Financeiro
  'payments.read', 'payments.refund', 'coupons.manage', 'sponsors.manage',

  // Operação de evento
  'checkins.read', 'checkins.create', 'weigh_ins.read', 'weigh_ins.create',
  'credentials.read', 'credentials.issue', 'credentials.scan', 'stage.manage',

  // Julgamento
  'judging.read', 'judging.score', 'judging.panels.manage', 'judging.sessions.manage',

  // Resultados e ranking
  'results.read', 'results.review', 'results.approve', 'results.publish', 'results.override',
  'ranking.read', 'ranking.manage',

  // Documentos
  'documents.read', 'documents.upload', 'documents.delete',

  // Draft e contratos
  'draft.read', 'draft.manage', 'contracts.read', 'contracts.manage',

  // Transversais
  'notifications.send', 'analytics.read', 'audit.read', 'settings.manage'
]);

const PERMISSOES_SET = new Set(PERMISSOES);

// Curinga reservado ao SUPER_ADMIN. Nenhum outro papel o recebe.
const TODAS = '*';

// Blocos reaproveitados entre papéis. Nomear o bloco evita listas divergindo
// silenciosamente quando uma permissão nova é criada.
const LEITURA_PUBLICA = ['events.read', 'results.read', 'ranking.read', 'categories.read'];
const OPERACAO_EVENTO = [
  'checkins.read', 'checkins.create',
  'weigh_ins.read', 'weigh_ins.create',
  'credentials.read', 'credentials.scan',
  'registrations.read'
];

const PAPEIS = Object.freeze({
  SUPER_ADMIN: TODAS,

  ADMIN_MCI: [
    ...LEITURA_PUBLICA, ...OPERACAO_EVENTO,
    'organizations.read', 'organizations.create', 'organizations.update', 'organizations.members.manage',
    'users.read', 'users.create', 'users.update', 'users.roles.manage',
    'athletes.read', 'athletes.read.sensitive', 'athletes.create', 'athletes.update', 'athletes.delete',
    'athletes.pro.manage',
    'events.create', 'events.update', 'events.publish', 'events.cancel',
    'categories.manage',
    'registrations.create', 'registrations.update', 'registrations.approve', 'registrations.cancel',
    'payments.read', 'payments.refund', 'coupons.manage', 'sponsors.manage',
    'credentials.issue', 'stage.manage',
    'judging.read', 'judging.panels.manage', 'judging.sessions.manage',
    'results.review', 'results.approve', 'results.publish',
    'ranking.manage',
    'documents.read', 'documents.upload', 'documents.delete',
    'draft.read', 'draft.manage', 'contracts.read', 'contracts.manage',
    'notifications.send', 'analytics.read', 'audit.read', 'settings.manage'
  ],

  // Responde pela competição em si: painel, baterias, palco e resultado.
  // Não mexe em dinheiro nem em contrato.
  DIRETOR_COMPETICAO: [
    ...LEITURA_PUBLICA, ...OPERACAO_EVENTO,
    'athletes.read', 'events.update',
    'categories.manage', 'registrations.approve',
    'stage.manage', 'credentials.issue',
    'judging.read', 'judging.panels.manage', 'judging.sessions.manage',
    'results.review', 'results.approve', 'results.publish',
    'documents.read', 'analytics.read'
  ],

  // Organiza o próprio evento. Enxerga o financeiro do que promove, mas não
  // publica resultado — isso é do júri.
  PROMOTOR: [
    ...LEITURA_PUBLICA, ...OPERACAO_EVENTO,
    'athletes.read',
    'events.create', 'events.update', 'events.publish',
    'categories.manage',
    'registrations.create', 'registrations.update', 'registrations.approve', 'registrations.cancel',
    'payments.read', 'coupons.manage', 'sponsors.manage',
    'credentials.issue', 'stage.manage',
    'judging.read', 'judging.panels.manage',
    'results.review',
    'documents.read', 'documents.upload',
    'notifications.send', 'analytics.read'
  ],

  STAFF: [...LEITURA_PUBLICA, ...OPERACAO_EVENTO, 'athletes.read', 'documents.read'],

  // ISOLAMENTO DO JUIZ (seção 35). Pontua e vê o que precisa para pontuar.
  // Deliberadamente SEM payments, sponsors, contracts, draft e analytics: o
  // juiz não pode ser exposto a informação comercial do atleta que julga.
  JUIZ: ['events.read', 'categories.read', 'judging.read', 'judging.score'],

  COORDENADOR_JURI: [
    'events.read', 'categories.read', 'athletes.read',
    'judging.read', 'judging.score', 'judging.panels.manage', 'judging.sessions.manage',
    'results.read', 'results.review', 'results.approve'
  ],

  FINANCEIRO: [
    ...LEITURA_PUBLICA,
    'registrations.read', 'payments.read', 'payments.refund',
    'coupons.manage', 'sponsors.manage', 'analytics.read', 'documents.read'
  ],

  CREDENCIAMENTO: [
    'events.read', 'registrations.read', 'athletes.read',
    'checkins.read', 'checkins.create',
    'credentials.read', 'credentials.issue', 'credentials.scan'
  ],

  PESAGEM: [
    'events.read', 'registrations.read', 'athletes.read', 'categories.read',
    'weigh_ins.read', 'weigh_ins.create', 'checkins.read'
  ],

  ATLETA: [...LEITURA_PUBLICA, 'registrations.create', 'documents.upload'],
  COACH: [...LEITURA_PUBLICA, 'athletes.read', 'registrations.create', 'registrations.read', 'documents.upload'],
  ACADEMIA: [...LEITURA_PUBLICA, 'athletes.read'],
  EQUIPE: [...LEITURA_PUBLICA, 'athletes.read'],
  PATROCINADOR: [...LEITURA_PUBLICA, 'analytics.read'],
  MIDIA: [...LEITURA_PUBLICA, 'athletes.read'],

  GESTOR_DRAFT: [...LEITURA_PUBLICA, 'athletes.read', 'draft.read', 'draft.manage', 'contracts.read'],
  GESTOR_PRO: [...LEITURA_PUBLICA, 'athletes.read', 'athletes.pro.manage', 'contracts.read', 'ranking.read'],

  // Auditor enxerga tudo o que é registro, e não altera nada. Note que não há
  // uma única permissão de escrita nesta lista.
  AUDITOR: [
    ...LEITURA_PUBLICA,
    'athletes.read', 'registrations.read', 'payments.read',
    'judging.read', 'results.read', 'documents.read',
    'draft.read', 'contracts.read', 'audit.read', 'analytics.read'
  ],

  PUBLICO: [...LEITURA_PUBLICA]
});

// Papéis da versão anterior do sistema. Continuam válidos e resolvem para o
// papel equivalente: usuário gravado no banco não perde acesso porque a
// nomenclatura mudou.
const PAPEIS_LEGADOS = Object.freeze({
  ADMIN: 'ADMIN_MCI',
  ORGANIZER: 'PROMOTOR',
  JUDGE: 'JUIZ',
  COACH: 'COACH',
  ATHLETE: 'ATLETA',
  PUBLIC: 'PUBLICO'
});

const PAPEIS_VALIDOS = Object.freeze([...Object.keys(PAPEIS), ...Object.keys(PAPEIS_LEGADOS)]);

const resolverPapel = papel => PAPEIS_LEGADOS[papel] || papel;

const ehPapelValido = papel => PAPEIS_VALIDOS.includes(papel);

function permissoesDe(papel) {
  const resolvido = resolverPapel(papel);
  const concedidas = PAPEIS[resolvido];
  if (!concedidas) return [];
  return concedidas === TODAS ? [...PERMISSOES] : [...concedidas];
}

// Um papel desconhecido não recebe nada. Falhar fechado é o único padrão
// aceitável: papel digitado errado vira ausência de acesso, nunca acesso total.
function pode(papel, permissao) {
  if (!PERMISSOES_SET.has(permissao)) {
    throw new Error(`Permissão inexistente: ${permissao}`);
  }
  const resolvido = resolverPapel(papel);
  const concedidas = PAPEIS[resolvido];
  if (!concedidas) return false;
  if (concedidas === TODAS) return true;
  return concedidas.includes(permissao);
}

const podeTodas = (papel, permissoes) => permissoes.every(p => pode(papel, p));
const podeAlguma = (papel, permissoes) => permissoes.some(p => pode(papel, p));

function assertPode(papel, permissao) {
  if (!pode(papel, permissao)) {
    throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para executar esta operação', {
      permissaoExigida: permissao
    });
  }
  return true;
}

module.exports = {
  PERMISSOES,
  PAPEIS,
  PAPEIS_LEGADOS,
  PAPEIS_VALIDOS,
  TODAS,
  permissoesDe,
  pode,
  podeTodas,
  podeAlguma,
  assertPode,
  resolverPapel,
  ehPapelValido
};

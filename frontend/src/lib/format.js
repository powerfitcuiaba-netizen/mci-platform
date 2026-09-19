// Formatação para exibição. Datas usam o fuso do evento quando ele existe:
// a chamada de palco de um campeonato em Cuiabá não pode aparecer no fuso do
// navegador de quem está em outro estado.

export const iniciais = nome => String(nome || '?')
  .trim()
  .split(/\s+/)
  .slice(0, 2)
  .map(parte => parte[0])
  .join('')
  .toUpperCase();

export function formatarData(valor, timeZone) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(data);
}

export function formatarDataHora(valor, timeZone) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(timeZone ? { timeZone } : {})
  }).format(data);
}

export function formatarHora(valor, timeZone) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(data);
}

// Momento relativo curto, para feed e mensagens.
export function desde(valor) {
  if (!valor) return '';
  const segundos = Math.round((Date.now() - new Date(valor).getTime()) / 1000);
  if (segundos < 60) return 'agora';
  if (segundos < 3600) return `${Math.floor(segundos / 60)} min`;
  if (segundos < 86400) return `${Math.floor(segundos / 3600)} h`;
  if (segundos < 604800) return `${Math.floor(segundos / 86400)} d`;
  return formatarData(valor);
}

// Peso é gravado em gramas: inteiro não acumula erro de arredondamento.
export const pesoEmKg = gramas => (gramas == null ? '—' : `${(gramas / 1000).toFixed(2).replace('.', ',')} kg`);

export const somenteDigitos = valor => String(valor ?? '').replace(/\D/g, '');

export function mascararCpf(valor) {
  const digitos = somenteDigitos(valor).slice(0, 11);
  return digitos
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

export const ESTADO_EVENTO = {
  DRAFT: { rotulo: 'Rascunho', tom: 'neutro' },
  PLANNED: { rotulo: 'Planejado', tom: 'info' },
  REGISTRATIONS_OPEN: { rotulo: 'Inscrições abertas', tom: 'ok' },
  REGISTRATIONS_CLOSED: { rotulo: 'Inscrições encerradas', tom: 'alerta' },
  IN_OPERATION: { rotulo: 'Em operação', tom: 'alerta' },
  IN_JUDGING: { rotulo: 'Em julgamento', tom: 'alerta' },
  RESULTS_IN_REVIEW: { rotulo: 'Resultados em revisão', tom: 'alerta' },
  RESULTS_PUBLISHED: { rotulo: 'Resultados publicados', tom: 'ok' },
  CLOSED: { rotulo: 'Encerrado', tom: 'neutro' },
  CANCELLED: { rotulo: 'Cancelado', tom: 'perigo' }
};

// ==========================================================================
// RÓTULOS DE ENUM.
//
// Todo enum que chega à tela passa por aqui. A regra nasceu de um defeito que
// apareceu em SEIS lugares diferentes nesta fase — "CONFIRMED", "ON_STAGE",
// "TIE_UNRESOLVED", "SUPER_ADMIN" — inclusive na página pública do evento e no
// painel do próprio atleta.
//
// Todos têm recuo para o código: rótulo faltando é incômodo, informação sumida
// é engano. E `rotulo()` devolve o código quando o enum ganhar um valor novo,
// em vez de deixar a tela em branco.
// ==========================================================================
const rotulo = (mapa, codigo, tomPadrao = 'neutro') =>
  mapa[codigo] || { rotulo: codigo || '—', tom: tomPadrao };

// Situação do atleta dentro de um resultado. Aparece na apuração oficial.
export const ESTADO_DA_ENTRADA = {
  RANKED: { rotulo: 'Classificado', tom: 'ok' },
  TIE_UNRESOLVED: { rotulo: 'Empate não resolvido', tom: 'alerta' },
  DISQUALIFIED: { rotulo: 'Desclassificado', tom: 'perigo' },
  ABSENT: { rotulo: 'Ausente', tom: 'neutro' }
};
export const estadoDaEntrada = codigo => rotulo(ESTADO_DA_ENTRADA, codigo);

// Tipo de credencial. É lido na portaria, em pé, com fila andando.
export const TIPO_DE_CREDENCIAL = {
  ATHLETE: { rotulo: 'Atleta', tom: 'info' },
  COACH: { rotulo: 'Coach', tom: 'info' },
  STAFF: { rotulo: 'Staff', tom: 'neutro' },
  JUDGE: { rotulo: 'Juiz', tom: 'alerta' },
  MEDIA: { rotulo: 'Imprensa', tom: 'neutro' },
  PHOTOGRAPHER: { rotulo: 'Fotógrafo', tom: 'neutro' },
  SPONSOR: { rotulo: 'Patrocinador', tom: 'neutro' },
  GUEST: { rotulo: 'Convidado', tom: 'neutro' }
};
export const tipoDeCredencial = codigo => rotulo(TIPO_DE_CREDENCIAL, codigo);

// Papéis. Aparecem para quem administra, e mesmo aí "REGISTRATION_OPERATOR"
// não é o nome que ninguém usa para falar da pessoa.
export const PAPEL = {
  SUPER_ADMIN: { rotulo: 'Super administrador', tom: 'perigo' },
  ADMIN: { rotulo: 'Administrador', tom: 'perigo' },
  EVENT_DIRECTOR: { rotulo: 'Diretor de evento', tom: 'alerta' },
  EVENT_COORDINATOR: { rotulo: 'Coordenador de evento', tom: 'alerta' },
  JUDGE_COORDINATOR: { rotulo: 'Coordenador de arbitragem', tom: 'alerta' },
  JUDGE: { rotulo: 'Juiz', tom: 'info' },
  STAFF: { rotulo: 'Staff', tom: 'neutro' },
  REGISTRATION_OPERATOR: { rotulo: 'Operador de inscrições', tom: 'info' },
  CHECKIN_OPERATOR: { rotulo: 'Operador de check-in', tom: 'info' },
  WEIGHIN_OPERATOR: { rotulo: 'Operador de pesagem', tom: 'info' },
  RESULTS_OPERATOR: { rotulo: 'Operador de resultados', tom: 'info' },
  RANKING_MANAGER: { rotulo: 'Gestor de ranking', tom: 'info' },
  SOCIAL_ADMIN: { rotulo: 'Administrador do social', tom: 'info' },
  MODERATOR: { rotulo: 'Moderador', tom: 'info' },
  ATHLETE: { rotulo: 'Atleta', tom: 'neutro' },
  COACH: { rotulo: 'Coach', tom: 'neutro' },
  GYM: { rotulo: 'Academia', tom: 'neutro' },
  TEAM: { rotulo: 'Equipe', tom: 'neutro' },
  BRAND: { rotulo: 'Marca', tom: 'neutro' },
  SPONSOR: { rotulo: 'Patrocinador', tom: 'neutro' },
  MEDIA: { rotulo: 'Imprensa', tom: 'neutro' }
};
export const papel = codigo => rotulo(PAPEL, codigo);

export const ESTADO_DO_USUARIO = {
  ACTIVE: { rotulo: 'Ativo', tom: 'ok' },
  SUSPENDED: { rotulo: 'Suspenso', tom: 'alerta' },
  DISABLED: { rotulo: 'Desativado', tom: 'perigo' }
};
export const estadoDoUsuario = codigo => rotulo(ESTADO_DO_USUARIO, codigo);

export const TIPO_DE_FILIACAO = {
  FEDERATION: { rotulo: 'Federação', tom: 'info' },
  ENTITY: { rotulo: 'Entidade', tom: 'neutro' },
  ASSOCIATION: { rotulo: 'Associação', tom: 'neutro' },
  TEAM: { rotulo: 'Equipe', tom: 'neutro' },
  OTHER: { rotulo: 'Outro', tom: 'neutro' }
};
export const tipoDeFiliacao = codigo => rotulo(TIPO_DE_FILIACAO, codigo);

export const ESTADO_DA_IMPORTACAO = {
  PENDING: { rotulo: 'Pendente', tom: 'alerta' },
  PREVIEWED: { rotulo: 'Pré-visualizado', tom: 'info' },
  APPLIED: { rotulo: 'Aplicado', tom: 'ok' },
  REJECTED: { rotulo: 'Rejeitado', tom: 'perigo' },
  // Rejeitar é recusar ANTES de publicar; invalidar é desfazer DEPOIS. Dois
  // rótulos diferentes porque são dois fatos diferentes no histórico.
  INVALIDATED: { rotulo: 'Invalidada', tom: 'perigo' }
};
export const estadoDaImportacao = codigo => rotulo(ESTADO_DA_IMPORTACAO, codigo);

// Tipo de perfil social. Aparece como sobrelinha no perfil PÚBLICO.
export const TIPO_DE_PERFIL = {
  ATHLETE: { rotulo: 'Atleta', tom: 'neutro' },
  COACH: { rotulo: 'Coach', tom: 'neutro' },
  GYM: { rotulo: 'Academia', tom: 'neutro' },
  TEAM: { rotulo: 'Equipe', tom: 'neutro' },
  BRAND: { rotulo: 'Marca', tom: 'neutro' },
  SPONSOR: { rotulo: 'Patrocinador', tom: 'neutro' },
  FAN: { rotulo: 'Torcedor', tom: 'neutro' },
  MEDIA: { rotulo: 'Imprensa', tom: 'neutro' }
};
export const tipoDePerfil = codigo => rotulo(TIPO_DE_PERFIL, codigo);

// Estado da inscrição. Mesmo defeito do estado da bateria: o enum cru
// ("CONFIRMED", "CANCELLED") estava indo direto para a tabela de inscrições.
export const ESTADO_INSCRICAO = {
  PENDING: { rotulo: 'Pendente', tom: 'alerta' },
  CONFIRMED: { rotulo: 'Confirmada', tom: 'ok' },
  CANCELLED: { rotulo: 'Cancelada', tom: 'perigo' },
  REJECTED: { rotulo: 'Recusada', tom: 'perigo' }
};

export const estadoDaInscricao = codigo => rotulo(ESTADO_INSCRICAO, codigo);

// Estado da bateria de palco. Existe porque o enum cru estava sendo impresso
// direto na tela — "CALLED", "ON_STAGE" —, inclusive na página PÚBLICA do
// evento, que é onde o atleta e o público olham para saber quando entrar.
export const ESTADO_BATERIA = {
  SCHEDULED: { rotulo: 'Agendada', tom: 'info' },
  CALLED: { rotulo: 'Chamada', tom: 'alerta' },
  ON_STAGE: { rotulo: 'No palco', tom: 'perigo' },
  DONE: { rotulo: 'Encerrada', tom: 'neutro' },
  CANCELLED: { rotulo: 'Cancelada', tom: 'perigo' }
};

export const estadoDaBateria = codigo => rotulo(ESTADO_BATERIA, codigo);

// ==========================================================================
// O dia do evento.
//
// Regra de APRESENTAÇÃO, e não de estado. Nada no banco muda sozinho: um
// evento só entra "em operação" quando alguém o coloca lá, porque esse estado
// é o que libera check-in, pesagem, credencial e palco. Relógio não pode abrir
// o piso de um evento que ninguém começou — nem marcar como acontecendo uma
// etapa que foi adiada e ainda não teve a data corrigida.
//
// O que a tela faz é dizer a verdade sobre hoje:
//
//   em operação E hoje  ->  "Ao vivo", pulsando
//   hoje, mas parado    ->  "Hoje", pulsando — recado para o operador de que a
//                           etapa é hoje e ainda não foi aberta
//   qualquer outro dia  ->  o estado, como sempre
// ==========================================================================

// Estados de piso: aqui o evento está de fato acontecendo.
const ESTADOS_DE_PISO = ['IN_OPERATION', 'IN_JUDGING'];

// Estados em que o dia não muda nada. Rascunho não é público; cancelado não
// acontece; resultado publicado e encerrado já passaram.
const ESTADOS_INDIFERENTES_AO_DIA = ['DRAFT', 'CANCELLED', 'CLOSED', 'RESULTS_IN_REVIEW', 'RESULTS_PUBLISHED'];

// "en-CA" devolve AAAA-MM-DD, que compara como texto na ordem certa.
const diaNoFuso = (valor, fuso) => new Intl.DateTimeFormat('en-CA', {
  timeZone: fuso || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(valor));

// O fuso é o DO EVENTO, não o do servidor nem o do navegador. Às 03h30 UTC de
// 15/11 já é dia 15 em São Paulo e ainda é dia 14 em Manaus: comparar em UTC
// apagaria o selo de um evento que ainda está acontecendo.
export function aconteceHoje(evento, agora = new Date()) {
  if (!evento?.startDate) return false;
  const fuso = evento.timezone;
  const hoje = diaNoFuso(agora, fuso);
  const inicio = diaNoFuso(evento.startDate, fuso);
  const fim = diaNoFuso(evento.endDate || evento.startDate, fuso);
  return hoje >= inicio && hoje <= fim;
}

export function seloDoEvento(evento, agora = new Date()) {
  const base = ESTADO_EVENTO[evento?.status] || { rotulo: evento?.status, tom: 'neutro' };

  if (ESTADOS_INDIFERENTES_AO_DIA.includes(evento?.status) || !aconteceHoje(evento, agora)) {
    return { ...base, aoVivo: false };
  }
  if (ESTADOS_DE_PISO.includes(evento.status)) {
    return { rotulo: 'Ao vivo', tom: 'perigo', aoVivo: true };
  }
  return { rotulo: 'Hoje', tom: 'alerta', aoVivo: true };
}

// Transições permitidas, espelhando a máquina de estados do servidor. A
// interface só oferece o que a API aceitaria; a autoridade continua no backend.
export const TRANSICOES_EVENTO = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['REGISTRATIONS_OPEN', 'DRAFT', 'CANCELLED'],
  REGISTRATIONS_OPEN: ['REGISTRATIONS_CLOSED', 'CANCELLED'],
  REGISTRATIONS_CLOSED: ['REGISTRATIONS_OPEN', 'IN_OPERATION', 'CANCELLED'],
  IN_OPERATION: ['IN_JUDGING', 'CANCELLED'],
  IN_JUDGING: ['RESULTS_IN_REVIEW', 'IN_OPERATION', 'CANCELLED'],
  RESULTS_IN_REVIEW: ['RESULTS_PUBLISHED', 'IN_JUDGING', 'CANCELLED'],
  RESULTS_PUBLISHED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: []
};

export const ESTADO_PRO = {
  NONE: { rotulo: 'Amador', tom: 'neutro' },
  ACTIVE: { rotulo: 'PRO ativo', tom: 'ok' },
  INACTIVE: { rotulo: 'PRO inativo', tom: 'neutro' },
  SUSPENDED: { rotulo: 'Suspenso', tom: 'perigo' },
  RETIRED: { rotulo: 'Aposentado', tom: 'neutro' }
};

// Acesso com recuo, como `estadoDaBateria` e `estadoDaInscricao`. `ESTADO_PRO`
// cobre hoje os cinco valores do enum, mas o acesso direto `ESTADO_PRO[x].tom`
// derruba a PÁGINA INTEIRA do atleta no dia em que o enum ganhar um valor —
// rótulo errado é um incômodo, tela branca é um chamado no meio do evento.
export const estadoPro = codigo => rotulo(ESTADO_PRO, codigo);

// A CHAVE que reconheceu a linha, em português de operador.
//
// `AFFILIATION_NUMBER` é o par entidade + matrícula: a matrícula sozinha não
// identifica ninguém, porque duas federações emitem o mesmo número — e o
// rótulo diz isso, em vez de "matrícula".
export const CRITERIO_DE_MATCH = {
  AFFILIATION_NUMBER: 'filiação + matrícula',
  CPF: 'CPF'
};

export const ESTADO_MATCH = {
  MATCHED: { rotulo: 'Reconhecido', tom: 'ok' },
  // "Pendente" não dizia o que estava pendente. O estado é: o sistema não
  // identificou o atleta — que é o que o operador precisa resolver.
  MATCH_PENDING: { rotulo: 'Não identificado', tom: 'alerta' },
  CONFLICT: { rotulo: 'Conflito', tom: 'perigo' },
  DUPLICATE: { rotulo: 'Duplicado', tom: 'neutro' },
  IMPORT_REJECTED: { rotulo: 'Rejeitado', tom: 'perigo' },
  APPLIED: { rotulo: 'Aplicado', tom: 'ok' }
};

// Caminho da foto de perfil, ou null quando o perfil não tem foto.
//
// `hasAvatar` é conferido ANTES de montar o caminho de propósito: pedir o
// avatar de quem não tem devolveria 404 por linha, e uma tela com 30
// comentários faria 30 requisições para receber 30 erros. Quem não tem foto
// nem chega a pedir — cai direto nas iniciais.
export const caminhoDoAvatar = perfil =>
  (perfil?.id && perfil?.hasAvatar ? `/media/profiles/${perfil.id}/avatar` : null);

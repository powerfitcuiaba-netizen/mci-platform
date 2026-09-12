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

export const ESTADO_MATCH = {
  MATCHED: { rotulo: 'Reconhecido', tom: 'ok' },
  MATCH_PENDING: { rotulo: 'Pendente', tom: 'alerta' },
  CONFLICT: { rotulo: 'Conflito', tom: 'perigo' },
  DUPLICATE: { rotulo: 'Duplicado', tom: 'neutro' },
  IMPORT_REJECTED: { rotulo: 'Rejeitado', tom: 'perigo' },
  APPLIED: { rotulo: 'Aplicado', tom: 'ok' }
};

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

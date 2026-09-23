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

// OCULTAR NÃO É FORMATAR, e os dois nomes parecidos já custaram caro: o export
// da revisão saiu com o CPF INTEIRO porque chamou `mascararCpf`, que aplica a
// máscara de digitação (123.456.789-09) e não esconde nada. A asserção do
// teste ainda passou, porque procurava a sequência crua de onze dígitos e os
// pontos a quebraram — falso negativo perfeito.
//
// Esta é a mesma regra do servidor (`src/utils/cpf.js`): as três primeiras e
// as duas últimas casas somem. Sobra o suficiente para conferir de quem é a
// linha, e não o suficiente para reconstruir o documento.
export function ocultarCpf(valor) {
  const digitos = somenteDigitos(valor);
  if (digitos.length !== 11) return '';
  return `***.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-**`;
}

/** Máscara de DIGITAÇÃO. Não esconde: para esconder, use `ocultarCpf`. */
export function mascararCpf(valor) {
  const digitos = somenteDigitos(valor).slice(0, 11);
  return digitos
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

// ==========================================================================
// O IDIOMA DOS RÓTULOS.
//
// Estes mapas são chamados de dezenas de lugares que não recebem contexto de
// React — `estadoDaImportacao(codigo)` no meio de uma tabela, `papel(codigo)`
// numa lista. Obrigar cada chamada a passar o idioma significaria visitar
// todas elas e esquecer algumas.
//
// Em vez disso o idioma corrente é guardado aqui, e `ProvedorDeIdioma` o
// atualiza quando a pessoa troca. O padrão é português, então tudo que existia
// antes desta camada continua funcionando exatamente como funcionava — e é por
// isso que nenhum teste anterior precisou mudar.
//
// O QUE NUNCA MUDA: o CÓDIGO. `MATCH_PENDING` é `MATCH_PENDING` em qualquer
// idioma, no banco, na API e na chave de idempotência. Aqui só se escolhe o
// texto que a pessoa lê.
// ==========================================================================

let idiomaDosRotulos = 'pt-BR';

export function definirIdiomaDosRotulos(codigo) {
  idiomaDosRotulos = codigo || 'pt-BR';
}

export const idiomaAtualDosRotulos = () => idiomaDosRotulos;

// O REGISTRO É POR MAPA, E NÃO POR CÓDIGO SOLTO.
//
// O mesmo código significa coisas diferentes em mapas diferentes:
// `MATCH_PENDING` é "Não identificado" na revisão da importação, e `PENDING` é
// "Pendente" no estado do lote. Uma tabela keyed só pelo código traduziria um
// com o texto do outro na primeira colisão — e colisão de enum entre módulos é
// questão de tempo, não de hipótese.
//
// A chave aqui é o OBJETO do mapa. Ele já é o primeiro parâmetro de `rotulo`,
// então nenhuma chamada precisou mudar.
const TRADUCOES_POR_MAPA = new Map();

const registrarTraducoes = (mapa, traducoes) => {
  TRADUCOES_POR_MAPA.set(mapa, traducoes);
  return mapa;
};

const rotulo = (mapa, codigo, tomPadrao = 'neutro') => {
  const base = mapa[codigo] || { rotulo: codigo || '—', tom: tomPadrao };
  const traduzido = TRADUCOES_POR_MAPA.get(mapa)?.[idiomaDosRotulos]?.[codigo];
  // O TOM NUNCA MUDA COM O IDIOMA. Ele é semântica — perigo, alerta, ok — e
  // vira cor na tela. Traduzir a cor seria traduzir a informação.
  return traduzido ? { ...base, rotulo: traduzido } : base;
};

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
registrarTraducoes(ESTADO_EVENTO, {
  en: {
    'DRAFT': 'Draft',
    'PLANNED': 'Planned',
    'REGISTRATIONS_OPEN': 'Registrations open',
    'REGISTRATIONS_CLOSED': 'Registrations closed',
    'IN_OPERATION': 'In operation',
    'IN_JUDGING': 'Judging',
    'RESULTS_IN_REVIEW': 'Results under review',
    'RESULTS_PUBLISHED': 'Results published',
    'CLOSED': 'Closed',
    'CANCELLED': 'Cancelled'
  },
  es: {
    'DRAFT': 'Borrador',
    'PLANNED': 'Planificado',
    'REGISTRATIONS_OPEN': 'Inscripciones abiertas',
    'REGISTRATIONS_CLOSED': 'Inscripciones cerradas',
    'IN_OPERATION': 'En operación',
    'IN_JUDGING': 'En juzgamiento',
    'RESULTS_IN_REVIEW': 'Resultados en revisión',
    'RESULTS_PUBLISHED': 'Resultados publicados',
    'CLOSED': 'Cerrado',
    'CANCELLED': 'Cancelado'
  }
});

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


// Situação do atleta dentro de um resultado. Aparece na apuração oficial.
export const ESTADO_DA_ENTRADA = {
  RANKED: { rotulo: 'Classificado', tom: 'ok' },
  TIE_UNRESOLVED: { rotulo: 'Empate não resolvido', tom: 'alerta' },
  DISQUALIFIED: { rotulo: 'Desclassificado', tom: 'perigo' },
  ABSENT: { rotulo: 'Ausente', tom: 'neutro' }
};
registrarTraducoes(ESTADO_DA_ENTRADA, {
  en: {
    'RANKED': 'Ranked',
    'TIE_UNRESOLVED': 'Unresolved tie',
    'DISQUALIFIED': 'Disqualified',
    'ABSENT': 'Absent'
  },
  es: {
    'RANKED': 'Clasificado',
    'TIE_UNRESOLVED': 'Empate no resuelto',
    'DISQUALIFIED': 'Descalificado',
    'ABSENT': 'Ausente'
  }
});
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
registrarTraducoes(TIPO_DE_CREDENCIAL, {
  en: {
    'ATHLETE': 'Athlete',
    'COACH': 'Coach',
    'STAFF': 'Staff',
    'JUDGE': 'Judge',
    'MEDIA': 'Press',
    'PHOTOGRAPHER': 'Photographer',
    'SPONSOR': 'Sponsor',
    'GUEST': 'Guest'
  },
  es: {
    'ATHLETE': 'Atleta',
    'COACH': 'Coach',
    'STAFF': 'Staff',
    'JUDGE': 'Juez',
    'MEDIA': 'Prensa',
    'PHOTOGRAPHER': 'Fotógrafo',
    'SPONSOR': 'Patrocinador',
    'GUEST': 'Invitado'
  }
});
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
  MEDIA: { rotulo: 'Imprensa', tom: 'neutro' },

  // A IDENTIDADE TÉCNICA DA FEDERAÇÃO — e ela precisa de rótulo justamente
  // porque NÃO é gente.
  //
  // Ela aparece na auditoria, ao lado de nomes de pessoas, e quem estiver
  // lendo tem de distinguir "a regra concluiu isto sozinha" de "fulano
  // concluiu". Sem rótulo, a tela mostraria `FEDERATION_SERVICE` cru e o
  // leitor teria de adivinhar.
  //
  // O tom é `neutro` de propósito: `info` a destacaria como papel
  // operacional, e ela não é um — no nível da aplicação não tem permissão
  // nenhuma.
  FEDERATION_SERVICE: { rotulo: 'Sistema (automático)', tom: 'neutro' }
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
registrarTraducoes(ESTADO_DA_IMPORTACAO, {
  en: {
    'PENDING': 'Pending',
    'PREVIEWED': 'Previewed',
    'APPLIED': 'Applied',
    'REJECTED': 'Rejected',
    'INVALIDATED': 'Voided'
  },
  es: {
    'PENDING': 'Pendiente',
    'PREVIEWED': 'Previsualizada',
    'APPLIED': 'Aplicada',
    'REJECTED': 'Rechazada',
    'INVALIDATED': 'Anulada'
  }
});
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
registrarTraducoes(ESTADO_MATCH, {
  en: {
    'MATCHED': 'Recognized',
    'MATCH_PENDING': 'Not identified',
    'CONFLICT': 'Conflict',
    'DUPLICATE': 'Duplicate',
    'IMPORT_REJECTED': 'Rejected',
    'APPLIED': 'Applied'
  },
  es: {
    'MATCHED': 'Reconocido',
    'MATCH_PENDING': 'No identificado',
    'CONFLICT': 'Conflicto',
    'DUPLICATE': 'Duplicado',
    'IMPORT_REJECTED': 'Rechazado',
    'APPLIED': 'Aplicado'
  }
});

// O ACESSOR EXISTE PORQUE O MAPA ESTAVA SENDO LIDO DIRETO.
//
// `ESTADO_MATCH[codigo]?.rotulo` espalhado pelas telas funciona — e passa ao
// largo de `rotulo()`, que é onde a tradução mora. O resultado seria uma tela
// em inglês com a coluna "Situação" em português, sem ninguém notar até
// alguém olhar. Todo enum que chega à tela passa por uma função; este também.
export const estadoDeMatch = codigo => rotulo(ESTADO_MATCH, codigo);

// Critério que reconheceu a linha. Texto corrido, não par rótulo/tom — é
// costurado dentro de uma frase ("Vinculado automaticamente por ...").
const CRITERIO_TRADUZIDO = {
  en: { AFFILIATION_NUMBER: 'affiliation + member number', CPF: 'CPF' },
  es: { AFFILIATION_NUMBER: 'afiliación + matrícula', CPF: 'CPF' }
};

export const criterioDeMatch = codigo =>
  CRITERIO_TRADUZIDO[idiomaDosRotulos]?.[codigo] ?? CRITERIO_DE_MATCH[codigo] ?? codigo;

// Caminho da foto de perfil, ou null quando o perfil não tem foto.
//
// `hasAvatar` é conferido ANTES de montar o caminho de propósito: pedir o
// avatar de quem não tem devolveria 404 por linha, e uma tela com 30
// comentários faria 30 requisições para receber 30 erros. Quem não tem foto
// nem chega a pedir — cai direto nas iniciais.
export const caminhoDoAvatar = perfil =>
  (perfil?.id && perfil?.hasAvatar ? `/media/profiles/${perfil.id}/avatar` : null);

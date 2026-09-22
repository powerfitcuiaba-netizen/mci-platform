const { z } = require('zod');
const { USER_ROLES, PAPEIS_DE_CADASTRO_ABERTO } = require('./roles');
const { EVENT_STATES } = require('./eventStates');

// Validação de entrada. Tudo o que entra na API passa por aqui antes de chegar
// a um service: o service confia no formato e cuida da regra de negócio.

const id = z.string().min(1).max(60);
const texto = (min, max) => z.string().trim().min(min).max(max);
const opcional = schema => schema.optional().nullable();
const dataIso = z.coerce.date();

// Booleano vindo de formulário ou querystring chega como TEXTO, e `z.coerce
// .boolean()` aplica `Boolean(...)`: a string 'false' vira `true`, e com ela um
// documento marcado como privado era gravado como público. Aqui a palavra vale
// o que ela diz — só o texto afirmativo é verdadeiro.
const NEGATIVOS = new Set(['false', '0', 'no', 'nao', 'não', 'off', '']);
const booleano = z.preprocess(valor => {
  if (typeof valor !== 'string') return valor;
  const limpo = valor.trim().toLowerCase();
  if (NEGATIVOS.has(limpo)) return false;
  if (['true', '1', 'yes', 'sim', 'on'].includes(limpo)) return true;
  return valor;
}, z.boolean());

const paginacao = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(60).optional()
});

// Listagem pública COM busca. Não dá para usar `paginacao` direto: o
// validate() troca req.query pelo resultado do Zod, e o Zod descarta chave
// não declarada — então um `search` recebido aqui sumiria em silêncio, e a
// rota devolveria a lista inteira como se fosse o resultado da busca.
const buscaPublica = paginacao.extend({
  search: z.string().trim().max(120).optional()
});

const paramsWithId = z.object({ id });

// Dois ids no caminho. Precisa existir porque `validate(..., 'params')`
// SUBSTITUI `req.params` pelo resultado do Zod, e o Zod descarta chave não
// declarada: com `paramsWithId`, `titleId` chegava ao serviço como `undefined`
// — e o Prisma respondia 500 numa rota de regra de negócio.
const paramsComTitulo = z.object({ id, titleId: id });
const paramsComPonto = z.object({ pointId: id });
// Pelo mesmo motivo: o atleta e a identidade importada que ele reivindica.
const paramsComIdentidadeExterna = z.object({ id, externalAthleteId: id });

// ---------------------------------------------------------------- autenticação
const authRegister = z.object({
  name: texto(2, 120),
  email: z.string().trim().toLowerCase().email().max(180),
  password: z.string().min(8).max(200),
  // O cadastro aberto só cria papéis sem poder operacional. Papel privilegiado
  // é concessão administrativa, nunca autoatribuição.
  role: z.enum(PAPEIS_DE_CADASTRO_ABERTO).optional()
});

// ---------------------------------------------------------------- cadastro
// completo
//
// O cadastro aberto passou a pedir contato, endereço e — só para atleta —
// CPF e filiação. A obrigatoriedade mora AQUI, não no banco: as contas que já
// existem foram criadas antes destes campos e continuam válidas.

const somenteDigitosDe = valor => String(valor || '').replace(/\D+/g, '');

// Telefone brasileiro com DDD: 10 dígitos (fixo) ou 11 (celular). Guardado só
// com dígitos — formatar é trabalho da tela.
const telefone = z.string()
  .transform(somenteDigitosDe)
  .refine(d => d.length === 10 || d.length === 11, 'Telefone deve ter DDD e 8 ou 9 dígitos');

const cep = z.string()
  .transform(somenteDigitosDe)
  .refine(d => d.length === 8, 'CEP deve ter 8 dígitos');

const uf = z.string().trim().toUpperCase()
  .refine(v => /^[A-Z]{2}$/.test(v), 'UF deve ter duas letras');

// Nascimento: data real, não futura, e idade plausível para uma pessoa viva.
// O limite superior de 120 anos NÃO é regra esportiva — é sanidade de
// digitação. Nenhuma idade mínima é imposta aqui: o domínio não define uma, e
// inventá-la barraria atleta legítimo.
const nascimento = z.string().trim()
  .refine(v => /^\d{4}-\d{2}-\d{2}$/.test(v), 'Data no formato AAAA-MM-DD')
  .refine(v => !Number.isNaN(Date.parse(`${v}T12:00:00.000Z`)), 'Data inválida')
  .refine(v => {
    // `2026-02-30` passa no Date.parse virando 02/03. Só comparar de volta
    // acusa a data que não existe.
    const [ano, mes, dia] = v.split('-').map(Number);
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
  }, 'Data inexistente no calendário')
  .refine(v => new Date(`${v}T12:00:00.000Z`) <= new Date(), 'Data de nascimento não pode ser no futuro')
  .refine(v => new Date(`${v}T12:00:00.000Z`) >= new Date(Date.UTC(new Date().getUTCFullYear() - 120, 0, 1)),
    'Data de nascimento implausível');

const cadastroCompleto = z.object({
  name: texto(2, 120),
  email: z.string().trim().toLowerCase().email().max(180),
  password: z.string().min(8).max(200),
  role: z.enum(PAPEIS_DE_CADASTRO_ABERTO).optional(),

  birthDate: nascimento,
  phone: telefone,
  whatsapp: telefone,

  postalCode: cep,
  addressLine: texto(3, 160),
  addressNumber: texto(1, 20),
  addressComplement: opcional(texto(1, 80)),
  state: uf,
  city: texto(2, 90),

  // ------------------------------------------------------------------
  // CPF, sexo e filiação NÃO são aceitos aqui, e isso é decisão de
  // arquitetura, não esquecimento.
  //
  // O CPF mora em `AthleteIdentity`, cuja chave primária é o `athleteId`:
  // sem uma linha de `Athlete`, ele não tem onde ser gravado. E a política
  // `atleta_criacao` exige `mci_operator_of(organizationId)` — quem acabou de
  // se cadastrar não é operador de federação nenhuma, então o autocadastro
  // NÃO pode criar a própria linha de atleta. Atleta é criado por operador,
  // por CPF, no fluxo de inscrição que já existe.
  //
  // Aceitar os campos aqui e descartá-los em silêncio seria pior que
  // recusá-los: o atleta digitaria o CPF acreditando que ficou guardado. A
  // recusa é explícita e diz para onde ir.
  cpf: z.never({ error: 'O CPF é registrado no perfil de atleta, pelo operador da federação — não no cadastro da conta.' }).optional(),
  affiliationId: z.never({ error: 'A filiação é vinculada no perfil de atleta, pelo operador da federação.' }).optional(),
  affiliationNumber: z.never({ error: 'O número de registro é vinculado junto com a filiação, no perfil de atleta.' }).optional(),
  sex: z.never({ error: 'O sexo competitivo é definido no perfil de atleta, junto com a filiação.' }).optional()
});

// Solicitação de perfil de atleta. `organizationId` NÃO existe aqui de
// propósito: ela é derivada da filiação, no servidor. Aceitá-la do cliente
// deixaria qualquer pessoa endereçar o pedido à federação que quisesse.
// Só o booleano. `z.object` com `strict` implícito do projeto descarta o
// resto, e nada mais deste corpo chega ao serviço.
const organizationSelfRegistration = z.object({ open: z.boolean() });

// MUDANÇA DE ESTADO DO ATLETA.
//
// O motivo tem PISO de tamanho pelo mesmo raciocínio da invalidação de
// lançamento: "ok" não é motivo, e seis meses depois a diferença entre
// decisão administrativa e arbítrio está exatamente aí.
const athleteStatusReason = z.object({ reason: texto(3, 500) });
const athleteStatusOptionalReason = z.object({ reason: opcional(texto(3, 500)) });

const athleteRequestCreate = z.object({
  fullName: texto(2, 160),
  cpf: z.string().trim().min(11).max(14),
  sex: z.enum(['MALE', 'FEMALE']),
  birthDate: opcional(dataIso),
  affiliationId: id,
  affiliationNumber: texto(1, 40),
  photoKey: opcional(texto(1, 300))
});

const athleteRequestReject = z.object({
  // Motivo obrigatório: recusa sem explicação deixa o solicitante sem saber o
  // que corrigir, e o próximo operador sem saber o que já foi analisado.
  reason: texto(3, 500)
});

const athleteRequestQuery = z.object({
  organizationId: id.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const authLogin = z.object({
  email: z.string().trim().toLowerCase().email().max(180),
  password: z.string().min(8).max(200)
});

const profileUpdate = z.object({
  name: texto(2, 120).optional(),
  email: z.string().trim().toLowerCase().email().max(180).optional()
}).refine(data => Object.keys(data).length > 0, { message: 'Informe ao menos um campo' });

const passwordChange = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(8).max(200)
});

// ---------------------------------------------------------------- organizações
const organizationCreate = z.object({
  name: texto(2, 140),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/, 'Slug deve conter apenas letras minúsculas, números e hífen'),
  timezone: texto(3, 60).optional()
});

const organizationMemberCreate = z.object({
  userId: id,
  role: z.enum(USER_ROLES)
});

// ------------------------------------------------------------------ filiação
const affiliationCreate = z.object({
  organizationId: id,
  name: texto(2, 140),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,30}$/),
  kind: z.enum(['FEDERATION', 'ENTITY', 'ASSOCIATION', 'TEAM', 'OTHER']).optional(),
  state: opcional(texto(2, 2))
});

// ------------------------------------------------------------------- atletas
const athleteCreate = z.object({
  organizationId: id,
  fullName: texto(2, 160),
  stageName: opcional(texto(1, 80)),
  cpf: z.string().trim().min(11).max(14),
  birthDate: opcional(dataIso),
  sex: z.enum(['MALE', 'FEMALE']),
  country: texto(2, 3).optional(),
  state: opcional(texto(2, 2)),
  city: opcional(texto(2, 90)),
  phone: opcional(texto(8, 20)),
  email: opcional(z.string().trim().toLowerCase().email().max(180)),
  athleteNumber: opcional(texto(1, 20)),
  affiliationId: opcional(id),
  // Matrícula do atleta DENTRO da entidade. Filiação são as duas coisas — a
  // entidade e o número —, e sem este campo o operador da federação não tinha
  // como gravar a metade que os arquivos oficiais usam para identificar
  // (o "Member Number"). Continua fora do cadastro da CONTA (ver acima): quem
  // grava é o operador, no perfil de atleta.
  affiliationNumber: opcional(texto(1, 40)),
  teamId: opcional(id),
  coachId: opcional(id),
  gymId: opcional(id),
  userId: opcional(id)
});

// `teamId` NÃO entra aqui de propósito. O vínculo com equipe tem trava de
// unicidade e histórico, e é governado por /athletes/:id/team — deixá-lo no
// update genérico seria o contorno mais óbvio da trava.
// `teamId` é recusado com mensagem, não descartado em silêncio: quem tentar
// trocar a equipe por aqui precisa saber que a operação existe noutro lugar e
// exige outra permissão. Omitir o campo faria a requisição responder 200 sem
// ter mudado nada — a pior resposta possível para uma trava.
const athleteUpdate = athleteCreate.partial().omit({ organizationId: true, cpf: true, teamId: true }).extend({
  teamId: z.never({
    error: 'A equipe do atleta não muda por edição de perfil. Use POST /athletes/:id/team para vincular '
      + 'um atleta sem equipe, ou POST /athletes/:id/team/transfer, que exige o operador da Muscle Contest.'
  }).optional()
});

const athleteTeamLink = z.object({ teamId: id, reason: opcional(texto(3, 300)) });
const athleteTeamTransfer = z.object({ teamId: id, reason: texto(3, 300) });
const athleteTeamUnlink = z.object({ reason: texto(3, 300) });

const athleteQuery = paginacao.extend({
  organizationId: id.optional(),
  search: z.string().trim().max(120).optional(),
  proStatus: z.enum(['NONE', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED']).optional(),
  // O ESTADO ADMINISTRATIVO, que é outra coisa que o estado PRO. Um atleta
  // pode ser PRO ativo e estar suspenso pela federação ao mesmo tempo.
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  affiliationId: id.optional(),
  teamId: id.optional()
});

const athleteLookup = z.object({
  organizationId: id,
  cpf: z.string().trim().min(11).max(14)
});

const proStatusUpdate = z.object({
  status: z.enum(['NONE', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED']),
  reason: texto(3, 300),
  eventId: opcional(id),
  title: opcional(texto(2, 140))
});

// -------------------------------------------------------------------- eventos
const eventCreate = z.object({
  organizationId: id,
  name: texto(3, 160),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,80}$/),
  description: opcional(texto(1, 4000)),
  timezone: texto(3, 60).optional(),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
  venue: opcional(texto(2, 160)),
  city: opcional(texto(2, 90)),
  state: opcional(texto(2, 2)),
  seasonId: opcional(id),
}).refine(data => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
  message: 'A data final não pode ser anterior à inicial', path: ['endDate']
});

const eventUpdate = z.object({
  name: texto(3, 160).optional(),
  description: opcional(texto(1, 4000)),
  timezone: texto(3, 60).optional(),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
  venue: opcional(texto(2, 160)),
  city: opcional(texto(2, 90)),
  state: opcional(texto(2, 2)),
  seasonId: opcional(id),
// A mesma coerência que `eventCreate` exige. Faltava aqui, e o PATCH aceitava
// um evento que termina antes de começar — conferido contra a API: respondeu
// 200 e gravou 10/12 -> 01/12. A data alimenta o calendário público, a ordem
// da listagem e o selo do dia; invertida, atravessa os três em silêncio.
//
// Este refine só alcança o caso em que as DUAS datas vêm no corpo. Quando vem
// só uma, a comparação depende do que já está gravado, e isso é regra de
// domínio: fica em eventService.update.
}).refine(data => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
  message: 'A data final não pode ser anterior à inicial', path: ['endDate']
});

const eventTransition = z.object({ status: z.enum(EVENT_STATES), reason: opcional(texto(3, 300)) });

const eventQuery = paginacao.extend({
  organizationId: id.optional(),
  status: z.enum(EVENT_STATES).optional(),
  search: z.string().trim().max(120).optional()
});

// --------------------------------------------- categorias, divisões e classes
const categoryCreate = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/),
  name: texto(2, 90),
  sex: z.enum(['MALE', 'FEMALE']),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

const eventCategoryCreate = z.object({ categoryId: id, sortOrder: z.coerce.number().int().min(0).max(999).optional() });

const divisionCreate = z.object({
  name: texto(1, 90),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

const classCreate = z.object({
  name: texto(1, 90),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/),
  minAge: opcional(z.coerce.number().int().min(0).max(120)),
  maxAge: opcional(z.coerce.number().int().min(0).max(120)),
  minWeightGrams: opcional(z.coerce.number().int().min(0).max(500000)),
  maxWeightGrams: opcional(z.coerce.number().int().min(0).max(500000)),
  minHeightCm: opcional(z.coerce.number().int().min(0).max(300)),
  maxHeightCm: opcional(z.coerce.number().int().min(0).max(300)),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  superOverallEligible: booleano.optional(),
  active: booleano.optional()
}).refine(d => d.minAge == null || d.maxAge == null || d.maxAge >= d.minAge, { message: 'Idade máxima menor que a mínima', path: ['maxAge'] })
  .refine(d => d.minWeightGrams == null || d.maxWeightGrams == null || d.maxWeightGrams >= d.minWeightGrams, { message: 'Peso máximo menor que o mínimo', path: ['maxWeightGrams'] })
  .refine(d => d.minHeightCm == null || d.maxHeightCm == null || d.maxHeightCm >= d.minHeightCm, { message: 'Altura máxima menor que a mínima', path: ['maxHeightCm'] });

// ------------------------------------------------------------------ inscrição
const registrationCreate = z.object({
  cpf: z.string().trim().min(11).max(14),
  // Quando o CPF ainda não existe, estes campos criam o perfil do atleta.
  athlete: athleteCreate.omit({ organizationId: true, cpf: true }).partial().optional(),
  affiliationId: opcional(id),
  classIds: z.array(id).min(1).max(10),
  notes: opcional(texto(1, 500))
});

const registrationCancel = z.object({ reason: texto(3, 300) });

const registrationQuery = paginacao.extend({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED']).optional(),
  classId: id.optional(),
  search: z.string().trim().max(120).optional()
});

// ---------------------------------------------------------------- check-in
const checkInCreate = z.object({ device: opcional(texto(1, 120)) });

const weighInCreate = z.object({
  weightGrams: z.coerce.number().int().min(20000).max(400000),
  heightCm: opcional(z.coerce.number().int().min(100).max(260)),
  device: opcional(texto(1, 120)),
  notes: opcional(texto(1, 300))
});

const credentialCreate = z.object({
  type: z.enum(['ATHLETE', 'COACH', 'STAFF', 'JUDGE', 'MEDIA', 'PHOTOGRAPHER', 'SPONSOR', 'GUEST']),
  holderName: texto(2, 140),
  registrationId: opcional(id)
});

const credentialScan = z.object({ code: texto(4, 80), gate: opcional(texto(1, 60)) });

// ------------------------------------------------------------------- palco
const batchCreate = z.object({
  classId: id,
  name: texto(1, 90),
  scheduledAt: opcional(dataIso),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional()
});

const batchStatusUpdate = z.object({ status: z.enum(['SCHEDULED', 'CALLED', 'ON_STAGE', 'DONE', 'CANCELLED']) });

const stageOrderSet = z.object({
  items: z.array(z.object({ registrationItemId: id, position: z.coerce.number().int().min(1).max(999) })).min(1).max(200)
});

// --------------------------------------------------------------- resultados
//
// O MCI recebe o resultado oficial decidido fora: atleta e colocação. Não há
// ficha de juiz, nota nem critério de apuração para validar aqui — validar
// mérito esportivo seria julgar, e o MCI não julga.
const resultReceive = z.object({
  entries: z.array(z.object({
    athleteId: id,
    placing: opcional(z.coerce.number().int().min(1).max(999)),
    status: z.enum(['RANKED', 'TIE_UNRESOLVED', 'DISQUALIFIED', 'ABSENT']).optional()
  })).min(1).max(300),
  reason: opcional(texto(2, 300)),
  source: z.enum(['EXTERNAL', 'MUSCLEWAR']).optional()
});

const resultPublish = z.object({ reason: opcional(texto(3, 300)) });

const resultOverride = z.object({
  reason: texto(5, 400),
  entries: z.array(z.object({
    registrationItemId: id,
    placing: opcional(z.coerce.number().int().min(1).max(200)),
    status: z.enum(['RANKED', 'TIE_UNRESOLVED', 'DISQUALIFIED', 'ABSENT'])
  })).min(1).max(200)
});

// ---------------------------------------------------------------- temporadas
const seasonCreate = z.object({
  organizationId: id,
  name: texto(2, 90),
  year: z.coerce.number().int().min(2000).max(2100),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
});

const pointsRuleSet = z.object({
  rules: z.array(z.object({
    placing: z.coerce.number().int().min(1).max(200),
    points: z.coerce.number().int().min(0).max(100000)
  })).min(1).max(200)
});

const classCatalogUpsert = z.object({
  organizationId: id,
  // A CATEGORIA DA CLASSE, OPCIONAL.
  //
  // Ausente = classe GENÉRICA da organização, que é o que ESTREANTE, NOVICE,
  // OPEN e MASTER sempre foram: divisões que valem em qualquer categoria.
  // Presente = classe daquela categoria e só dela — "Masters 35+" de Women's
  // Physique não é a mesma que a de Bikini.
  categoryId: id.optional(),
  // 60, e não 40: "OPEN_LIGHT_HEAVYWEIGHT" tem 22, mas o código é gerado a
  // partir do nome da origem e o teto precisa ser o mesmo que o normalizador
  // usa, ou o operador não conseguiria editar uma classe que a importação
  // criou sozinha.
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,60}$/),
  name: opcional(texto(1, 90)),
  // O texto como a origem escreveu. `code` é identidade; este é apresentação.
  displayName: opcional(texto(1, 120)),
  // REGRA HOMOLOGADA: só as classes marcadas alimentam o Super Overall anual.
  superOverallEligible: booleano.optional(),
  active: booleano.optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

// `limit`/`offset` recortam a lista JÁ CLASSIFICADA, nunca a entrada. Cortar
// antes de classificar mudaria a posição de quem sobrou — um ranking paginado
// não pode discordar do ranking inteiro.
//
// Sem `limit`, a resposta continua completa: cliente que já consome a lista
// toda não quebra. Medido: 3.000 atletas devolvem 818 KB, e a temporada só
// cresce.
const recorteDeLista = {
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional()
};

const superOverallQuery = z.object({
  seasonId: id.optional(),
  categoryId: id.optional(),
  organizationId: id.optional(),
  ...recorteDeLista
});

// DECLARAÇÃO DE OVERALL.
//
// O competidor é UM SÓ, e pode não ter cadastro: o histórico oficial é
// carregado antes de os atletas se inscreverem, e a identidade dessas linhas
// vive em `ExternalAthlete`. Exigir `athleteId` aqui era o que impedia
// declarar o campeão de um campeonato importado.
//
// Os dois juntos são recusados no schema, e não só no serviço: assim o erro
// chega como validação, com o campo apontado, em vez de como regra de negócio.
const overallDeclare = z.object({
  athleteId: id.optional(),
  externalAthleteId: id.optional(),
  categoryId: id.optional(),
  note: opcional(texto(1, 300))
}).refine(
  corpo => Boolean(corpo.athleteId) !== Boolean(corpo.externalAthleteId),
  { message: 'Informe o atleta cadastrado OU o competidor do histórico importado — um, e apenas um', path: ['athleteId'] }
);

// Prévia da homologação. `athleteId` é obrigatório: prévia sem atleta não
// tem o que prever.
const overallPreviewQuery = z.object({
  athleteId: id.optional(),
  externalAthleteId: id.optional(),
  categoryId: id.optional()
}).refine(
  consulta => Boolean(consulta.athleteId) !== Boolean(consulta.externalAthleteId),
  { message: 'Informe o atleta cadastrado OU o competidor do histórico importado — um, e apenas um', path: ['athleteId'] }
);

// Revogação. O MOTIVO é obrigatório — revogar título homologado sem dizer por
// quê deixa o próximo operador sem saber o que já foi analisado, que é o mesmo
// raciocínio da recusa de solicitação de perfil.
const overallRevoke = z.object({
  reason: texto(3, 500)
});

// CORREÇÃO ADMINISTRATIVA DE LANÇAMENTO.
//
// `reason` é obrigatório e tem piso de tamanho: "ok" não é motivo, e seis
// meses depois a diferença entre correção e adulteração está exatamente aí.
//
// O que NÃO aparece aqui é tão importante quanto o que aparece: não há
// `points`, `eventId`, `athleteId`, `source` nem `externalResultId`. Os pontos
// vêm do motor a partir da colocação; a identidade do lançamento é história e
// não se edita. O que o corpo trouxer além disto é descartado pelo esquema
// antes de chegar ao serviço.
const rankingPointEdit = z.object({
  placing: z.coerce.number().int().min(1).max(999).optional(),
  didNotShow: booleano.optional(),
  reason: texto(5, 500)
}).refine(data => data.placing !== undefined || data.didNotShow !== undefined, {
  message: 'Informe a colocação ou o não comparecimento', path: ['placing']
});

// A prévia não grava, então não exige motivo — exige só o que se quer simular.
const rankingPointPreviewQuery = z.object({
  placing: z.coerce.number().int().min(1).max(999).optional(),
  didNotShow: booleano.optional()
});

const rankingPointReason = z.object({ reason: texto(5, 500) });

// AJUSTE ADMINISTRATIVO DA PONTUAÇÃO.
//
// `points` é o total novo, e `expectedPoints` é o total que o operador tinha
// NA TELA quando decidiu. O segundo não é redundante: é a guarda de
// concorrência, e é ela que transforma "dois operadores editando ao mesmo
// tempo" e "duplo clique" no mesmo caso tratado — a segunda gravação chega
// com um valor que já não vale e é recusada.
//
// `reason` é OBRIGATÓRIO e tem piso de 5 caracteres. Ajuste sem justificativa
// é alteração silenciosa com outro nome.
//
// Não há `placing`, `categoryId`, `catalogClassId`, `eventId`, `seasonId` nem
// `athleteId` aqui — o Zod descarta chave não declarada, então o que vier a
// mais no corpo some antes de o serviço existir. É a primeira das duas
// camadas; a segunda é o serviço, que só escreve pontuação.
const rankingPointAdjust = z.object({
  // Piso zero: pontuação negativa não existe na regra homologada. Teto de
  // 100000 acompanha o da tabela da temporada.
  points: z.coerce.number().int().min(0).max(100000),
  expectedPoints: z.coerce.number().int().min(0).max(100000),
  reason: texto(5, 500)
});

const teamRankingQuery = z.object({
  seasonId: id.optional(),
  categoryId: id.optional(),
  organizationId: id.optional()
});

// Meu Histórico. NÃO declara `athleteId` nem `organizationId`: o Zod descarta
// chave não declarada, então esses parâmetros somem antes de o serviço existir
// — e o serviço, por sua vez, deriva o atleta do token. Duas camadas dizendo a
// mesma coisa, que é o que se quer numa superfície de identidade.
const meuHistoricoQuery = paginacao.extend({
  seasonId: id.optional()
});

const rankingQuery = paginacao.extend({
  seasonId: id.optional(),
  // Declarado porque o serviço LÊ: sem temporada escolhida, ele decide a
  // temporada padrão dentro desta organização. Faltando aqui, o Zod apagava o
  // parâmetro antes de o serviço vê-lo, e o recorte pedido era ignorado em
  // silêncio.
  organizationId: id.optional(),
  categoryId: id.optional(),
  // Recorte por CLASSE DO CATÁLOGO. Não é `classId`: aquele é a classe de um
  // evento do MCI e é nulo em todo resultado histórico importado.
  catalogClassId: id.optional(),
  state: z.string().trim().length(2).optional(),
  country: z.string().trim().min(2).max(3).optional()
});

// Classes disponíveis para montar o filtro do ranking. Sem `categoryId` a
// lista é a da organização inteira; com ele, a da categoria mais as
// genéricas, que valem em todas.
// Catálogo do operador. `categoryId` recorta a lista; ausente, vem inteira.
const classCatalogQuery = paginacao.extend({
  organizationId: id.optional(),
  categoryId: id.optional()
});

const classesParaFiltroQuery = z.object({
  organizationId: id.optional(),
  seasonId: id.optional(),
  categoryId: id.optional()
});

// Recortes derivados de RankingPoint: classe, evento e divisão. Exatamente um
// deles por consulta — combinar dois responderia a uma pergunta que ninguém
// fez, e a interseção vazia pareceria "ninguém pontuou".
const rankingCutQuery = z.object({
  seasonId: id,
  categoryId: id.optional(),
  classId: id.optional(),
  catalogClassId: id.optional(),
  eventId: id.optional(),
  divisionId: id.optional(),
  ...recorteDeLista
}).refine(
  d => [d.classId, d.catalogClassId, d.eventId, d.divisionId].filter(Boolean).length === 1,
  { message: 'Informe exatamente um recorte: classId, catalogClassId, eventId ou divisionId' }
);

// ----------------------------------------------------------------- MuscleWar
const muscleWarImportCreate = z.object({
  organizationId: id,
  seasonId: opcional(id),
  eventId: opcional(id),
  sourceType: z.enum(['CSV', 'JSON', 'API']),
  sourceRef: texto(1, 200),
  // O conteúdo bruto: texto CSV, JSON serializado ou corpo devolvido pela API.
  content: z.string().min(1).max(5_000_000),
  fieldMap: z.record(z.string(), z.string()).optional(),
  // Prefixo para DERIVAR o identificador de resultado quando o arquivo de
  // origem não traz nenhum. Opcional de propósito: sem ele nada é derivado, e
  // um arquivo sem identidade é recusado em vez de importado com uma chave
  // inventada. O formato restrito mantém a chave legível na auditoria e no
  // ledger — quem lê `IPIRANGA-88281-BIKINI_OPEN` sabe de onde o ponto veio.
  externalIdPrefix: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/,
    'O prefixo aceita letras, números, hífen e sublinhado, entre 2 e 40 caracteres').optional(),
  // Filiação de TODA a etapa, para arquivos que não trazem a coluna. Não
  // sobrescreve linha que já declara a sua.
  defaultAffiliationCode: opcional(texto(1, 40))
});

const muscleWarLink = z.object({ athleteId: id });

// Recorte da revisão. O teto vive no serviço; aqui a guarda é de FORMA — um
// `limit=abc` ou um `offset` negativo não podem chegar ao Prisma.
const muscleWarPreviewQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  matchStatus: z.enum(['MATCHED', 'MATCH_PENDING', 'CONFLICT', 'DUPLICATE', 'IMPORT_REJECTED', 'APPLIED']).optional(),
  // Busca por nome, matrícula, classe ou código de categoria. CPF fica de fora
  // de propósito — ver a justificativa no serviço.
  q: z.string().trim().max(120).optional(),
  categoryCode: z.string().trim().max(60).optional()
});

// -------------------------------------------------------- equipes e parceiros
const teamCreate = z.object({
  organizationId: id, name: texto(2, 120),
  // Empresa que inscreve a equipe. Opcional: equipe sem empresa compete
  // normalmente, apenas não pontua para nenhuma.
  companyId: opcional(id),
  city: opcional(texto(2, 90)), state: opcional(texto(2, 2))
});
const companyCreate = z.object({ organizationId: id, name: texto(2, 120), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });
const coachCreate = z.object({ name: texto(2, 120), userId: opcional(id), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });
const gymCreate = z.object({ organizationId: id, name: texto(2, 120), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });

const brandCreate = z.object({
  organizationId: id,
  name: texto(2, 120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/),
  website: opcional(z.string().trim().url().max(300))
});

const sponsorCreate = z.object({
  organizationId: id,
  name: texto(2, 120),
  brandId: opcional(id),
  contactEmail: opcional(z.string().trim().toLowerCase().email().max(180))
});

const sponsorshipCreate = z.object({
  sponsorId: id,
  eventId: opcional(id),
  teamId: opcional(id),
  athleteId: opcional(id),
  scope: opcional(texto(2, 300)),
  startsAt: opcional(dataIso),
  endsAt: opcional(dataIso)
}).refine(d => Boolean(d.eventId || d.teamId || d.athleteId), { message: 'Informe evento, equipe ou atleta' });

const partnershipCreate = z.object({
  athleteId: id,
  brandId: id,
  scope: opcional(texto(2, 300)),
  startedAt: opcional(dataIso)
});

const partnershipStatus = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'ENDED']) });

// --------------------------------------------------------------------- social
const profileCreate = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, 'Handle inválido'),
  displayName: texto(2, 80),
  kind: z.enum(['ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'FAN', 'MEDIA']).optional(),
  bio: opcional(texto(1, 500)),
  isPrivate: z.boolean().optional()
});

const profileUpdateSocial = profileCreate.partial().omit({ handle: true });

const postCreate = z.object({
  content: texto(1, 5000),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).optional(),
  eventId: opcional(id),
  communityId: opcional(id)
});

const commentCreate = z.object({ content: texto(1, 2000), parentId: opcional(id) });
const shareCreate = z.object({ comment: opcional(texto(1, 500)) });
const storyCaption = z.object({ caption: opcional(texto(1, 200)) });

const feedQuery = paginacao.extend({
  scope: z.enum(['FOLLOWING', 'DISCOVER', 'EVENT', 'COMMUNITY', 'PROFILE']).default('FOLLOWING'),
  eventId: id.optional(),
  communityId: id.optional(),
  profileId: id.optional()
});

const reportCreate = z.object({
  targetType: z.enum(['POST', 'COMMENT', 'PROFILE', 'MESSAGE']),
  targetId: id,
  reason: texto(3, 500)
});

const reportResolve = z.object({
  status: z.enum(['REVIEWING', 'RESOLVED', 'DISMISSED']),
  resolution: opcional(texto(3, 500)),
  removeContent: z.boolean().optional()
});

// ----------------------------------------------------------------- comunidades
const communityCreate = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,60}$/),
  name: texto(2, 90),
  description: opcional(texto(1, 1000)),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  rules: opcional(texto(1, 4000))
});

// ------------------------------------------------------------------ messenger
const conversationCreate = z.object({
  kind: z.enum(['DIRECT', 'GROUP']).default('DIRECT'),
  title: opcional(texto(1, 90)),
  participantIds: z.array(id).min(1).max(50)
});

const messageCreate = z.object({
  body: opcional(texto(1, 4000)),
  sharedPostId: opcional(id),
  sharedProfileId: opcional(id),
  replyToId: opcional(id)
}).refine(d => Boolean(d.body || d.sharedPostId || d.sharedProfileId), { message: 'Mensagem vazia' });

const reactionCreate = z.object({ emoji: z.string().trim().min(1).max(16) });

const conversationMembers = z.object({ participantIds: z.array(id).min(1).max(50) });

// -------------------------------------------------------------------- busca
const searchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  types: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

// ------------------------------------------------------------- notificações
const notificationQuery = z.object({
  onlyUnread: booleano.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// ---------------------------------------------------------------- auditoria
const auditQuery = z.object({
  entity: z.string().trim().max(60).optional(),
  entityId: id.optional(),
  userId: id.optional(),
  action: z.string().trim().max(60).optional(),
  organizationId: id.optional(),
  // O teto da auditoria é 200, e não 100 como o resto: a trilha é lida em
  // varredura, não em navegação. O `cursor` tem o mesmo formato das demais
  // listas — sem ele declarado, um cursor de 5.000 caracteres era ACEITO e
  // silenciosamente descartado pelo zod, o que parecia validação e não era.
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(60).optional()
});

// ---------------------------------------------------------------- documentos
const documentUpload = z.object({
  title: z.string().trim().max(160).optional(),
  kind: z.enum(['ID', 'MEDICAL', 'TERM', 'AFFILIATION_PROOF', 'OTHER']).optional()
});

const eventDocumentUpload = z.object({
  title: z.string().trim().max(160).optional(),
  isPublic: booleano.optional()
});

// --------------------------------------------------------------- usuários
const adminUserUpdate = z.object({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional()
}).refine(data => Object.keys(data).length > 0, { message: 'Informe ao menos um campo' });

const adminUserQuery = paginacao.extend({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  search: z.string().trim().max(120).optional()
});

// Listagem simples com busca e escopo de organização, usada por filiações,
// equipes, academias, coaches, marcas e patrocinadores.
const scopedListQuery = paginacao.extend({
  organizationId: id.optional(),
  search: z.string().trim().max(120).optional()
});

const checkInQuery = paginacao.extend({
  search: z.string().trim().max(120).optional()
});

const sponsorshipQuery = paginacao.extend({
  organizationId: id.optional(),
  sponsorId: id.optional(),
  eventId: id.optional(),
  teamId: id.optional(),
  athleteId: id.optional()
});

const partnershipQuery = paginacao.extend({
  athleteId: id.optional(),
  brandId: id.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'ENDED']).optional()
});

const importQuery = paginacao.extend({ organizationId: id.optional() });

const reportQuery = paginacao.extend({ status: z.enum(['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED']).optional() });

const rankingPointsQuery = z.object({ seasonId: id.optional() });

const communityMemberAdd = z.object({ profileId: id, role: z.enum(['MEMBER', 'ADMIN']).optional() });

const handleUpdate = z.object({ handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, 'Handle inválido') });

const rejectImport = z.object({ reason: opcional(texto(3, 300)) });
// O motivo é opcional AQUI porque o schema não sabe se o lote publicou algo.
// Quem exige é o serviço, que sabe: rascunho dispensa motivo, invalidação de
// resultado publicado não. Tornar obrigatório no schema bloquearia a exclusão
// legítima de um lote que nunca saiu do rascunho.
const deleteImport = z.object({ reason: opcional(texto(3, 300)) });

module.exports = {
  paginacao, buscaPublica, paramsWithId, scopedListQuery, checkInQuery, sponsorshipQuery, partnershipQuery,
  importQuery, reportQuery, rankingPointsQuery, communityMemberAdd, handleUpdate, rejectImport, deleteImport,
  authRegister, cadastroCompleto, authLogin, profileUpdate, passwordChange,
  athleteRequestCreate, athleteRequestReject, athleteRequestQuery,
  organizationCreate, organizationMemberCreate, organizationSelfRegistration,
  affiliationCreate,
  athleteStatusReason, athleteStatusOptionalReason,
  athleteCreate, athleteUpdate, athleteTeamLink, athleteTeamTransfer, athleteTeamUnlink, athleteQuery, athleteLookup, proStatusUpdate,
  eventCreate, eventUpdate, eventTransition, eventQuery,
  categoryCreate, eventCategoryCreate, divisionCreate, classCreate,
  registrationCreate, registrationCancel, registrationQuery,
  checkInCreate, weighInCreate, credentialCreate, credentialScan,
  batchCreate, batchStatusUpdate, stageOrderSet,
  resultReceive, resultPublish, resultOverride,
  meuHistoricoQuery,
  paramsComTitulo, paramsComPonto, paramsComIdentidadeExterna,
  seasonCreate, pointsRuleSet, rankingQuery, rankingCutQuery, overallDeclare,
  overallPreviewQuery, overallRevoke, teamRankingQuery,
  classCatalogUpsert, classCatalogQuery, classesParaFiltroQuery, superOverallQuery,
  muscleWarImportCreate, muscleWarLink, muscleWarPreviewQuery,
  rankingPointEdit, rankingPointPreviewQuery, rankingPointReason, rankingPointAdjust,
  teamCreate, companyCreate, coachCreate, gymCreate, brandCreate, sponsorCreate, sponsorshipCreate,
  partnershipCreate, partnershipStatus,
  profileCreate, profileUpdateSocial, postCreate, commentCreate, shareCreate, storyCaption, feedQuery,
  reportCreate, reportResolve,
  communityCreate,
  conversationCreate, messageCreate, reactionCreate, conversationMembers,
  searchQuery, notificationQuery, auditQuery,
  documentUpload, eventDocumentUpload,
  adminUserUpdate, adminUserQuery
};

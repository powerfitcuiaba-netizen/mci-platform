const prisma = require('../config/prisma');
const { contextoAtual } = require('../config/rlsContext');
const { AppError } = require('../utils/errors');
const audit = require('./auditService');
const organizacoes = require('./organizationService');

// ============================================================================
// A ENTIDADE DE FILIAÇÃO OFICIAL DO CAMPEONATO BRASILEIRO MUSCLE CONTEST.
//
// O DEFEITO QUE ORIGINOU ESTE ARQUIVO
//
// Na tela "Solicitar perfil de atleta", o campo ENTIDADE DE FILIAÇÃO aparecia
// vazio, com "Nenhuma entidade de filiação ativa está disponível para a sua
// conta." — e sem entidade o atleta não conclui o autocadastro.
//
// Não era a tela, e não era RLS: `Affiliation` e `Organization` não têm política
// nenhuma (medido em `pg_class`: `relrowsecurity = false` nas duas). O visitante
// anônimo lê as duas tabelas.
//
// Era DADO QUE NUNCA FOI PROVISIONADO. `GET /public/affiliations` exige três
// condições, e duas delas não são criadas por nada automatizado:
//
//   affiliation.active                   ok, o padrão é true
//   organization.active                  ok
//   organization.selfRegistrationOpen    NASCE false, e a coluna é ligada em
//                                        EXATAMENTE UM lugar de todo o código:
//                                        `organizationService.setSelfRegistration`,
//                                        alcançável só por
//                                        POST /organizations/:id/self-registration
//
// E a filiação em si: varredura por `affiliation.create`, `upsert` e
// `INSERT INTO "Affiliation"` em `src/`, `scripts/` e `prisma/` acha o endpoint
// manual e `scripts/qa/dataset.mjs` — que é ambiente de QA. `importar-campeonatos.js`,
// que carregou os 47 campeonatos, nunca toca a tabela.
//
// Ou seja: a entidade oficial e o estado do autocadastro existiam apenas como
// CLIQUE MANUAL. Não sobreviviam a um ambiente novo, não eram reproduzíveis, e
// não havia como conferi-los sem abrir o banco. É isso que este módulo fecha.
//
// A IDENTIDADE É CONFIGURAÇÃO, NÃO DESCOBERTA
//
// A organização dona vem de `MCI_NPC_ORGANIZATION_ID`. Nunca de nome
// aproximado, nunca da primeira organização encontrada, nunca do corpo de uma
// requisição. Resolver por semelhança de nome é como se provisiona a federação
// errada em silêncio — e aí a entidade oficial nasce pendurada em quem não é
// dono dela, com histórico atrás.
//
// O QUE ESTE MÓDULO NUNCA FAZ
//
//   · não apaga filiação existente;
//   · não apaga histórico;
//   · não renomeia `code`, que é CHAVE DE RECONHECIMENTO da importação
//     MuscleWar — trocá-lo faria a conciliação por matrícula parar de achar o
//     que já está no ledger;
//   · não escolhe entre duas candidatas: em conflito, PARA e reporta;
//   · não abre o autocadastro de nenhuma organização além da configurada.
// ============================================================================

// O NOME OFICIAL, LITERAL. Definido pela organização do campeonato, e é ele que
// aparece na interface, na documentação e nas mensagens.
const NOME_OFICIAL = 'NPC - National Physique Committe';

// O CÓDIGO É A CHAVE, e é por isso que ele não se normaliza: `@@unique([organizationId, code])`
// o torna único na organização, e `muscleWarService` casa a matrícula do arquivo
// contra ele (`filiacoesPorCodigo`, com `toUpperCase`). Mudá-lo depois de existir
// histórico é desligar o reconhecimento.
const CODIGO_OFICIAL = 'NPC';

// ENTITY, e não FEDERATION: o NPC é a entidade internacional à qual o atleta se
// filia, e não a federação que organiza o campeonato — essa é a `Organization`.
const TIPO_OFICIAL = 'ENTITY';

const ESTADOS = Object.freeze({
  ORGANIZACAO_NAO_CONFIGURADA: 'ORGANIZACAO_NAO_CONFIGURADA',
  ORGANIZACAO_INEXISTENTE: 'ORGANIZACAO_INEXISTENTE',
  ORGANIZACAO_INATIVA: 'ORGANIZACAO_INATIVA',
  CONFLITO: 'CONFLITO',
  PENDENTE: 'PENDENTE',
  CORRETO: 'CORRETO'
});

const PENDENCIAS = Object.freeze({
  FILIACAO_AUSENTE: 'FILIACAO_AUSENTE',
  FILIACAO_INATIVA: 'FILIACAO_INATIVA',
  NOME_DIVERGENTE: 'NOME_DIVERGENTE',
  TIPO_DIVERGENTE: 'TIPO_DIVERGENTE',
  AUTOCADASTRO_FECHADO: 'AUTOCADASTRO_FECHADO'
});

/**
 * O que aponta para uma filiação. Serve à inspeção de conflito — "quantidade de
 * registros relacionados" e "utilização em resultados/importações" — e é o
 * número que impede alguém de tratar uma entidade com histórico como descartável.
 */
async function vinculosDe(affiliationId) {
  const [atletas, inscricoes, solicitacoes, lancamentos, identidadesExternas] = await Promise.all([
    prisma.athlete.count({ where: { affiliationId } }),
    prisma.registration.count({ where: { affiliationId } }),
    prisma.athleteProfileRequest.count({ where: { affiliationId } }),
    prisma.rankingPoint.count({ where: { affiliationId } }),
    prisma.externalAthlete.count({ where: { affiliationId } })
  ]);

  return {
    atletas,
    inscricoes,
    solicitacoes,
    lancamentos,
    identidadesExternas,
    total: atletas + inscricoes + solicitacoes + lancamentos + identidadesExternas
  };
}

/**
 * DIAGNÓSTICO SOMENTE LEITURA. Nenhuma escrita, em nenhum ramo.
 *
 * Devolve o estado de cabeçalho e a lista de pendências. Os dois, e não só um:
 * "NPC ausente" e "autocadastro fechado" acontecem JUNTOS numa instalação nova,
 * e um estado único esconderia a segunda metade do trabalho.
 */
async function diagnosticar(organizationId) {
  if (!organizationId || typeof organizationId !== 'string' || !organizationId.trim()) {
    return { estado: ESTADOS.ORGANIZACAO_NAO_CONFIGURADA, pendencias: [], organizationId: null };
  }

  const id = organizationId.trim();

  const organizacao = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, active: true, selfRegistrationOpen: true }
  });

  if (!organizacao) {
    return { estado: ESTADOS.ORGANIZACAO_INEXISTENTE, pendencias: [], organizationId: id };
  }

  const base = {
    organizationId: organizacao.id,
    organizationName: organizacao.name,
    organizationSlug: organizacao.slug,
    organizationActive: organizacao.active,
    selfRegistrationOpen: organizacao.selfRegistrationOpen
  };

  if (!organizacao.active) {
    return { ...base, estado: ESTADOS.ORGANIZACAO_INATIVA, pendencias: [] };
  }

  // AS CANDIDATAS, pelas duas chaves que podem identificar a entidade oficial.
  //
  // Por código, e por nome. As duas porque `@@unique([organizationId, code])` é
  // SENSÍVEL A MAIÚSCULA: 'NPC' e 'npc' coexistem no banco sem violar nada, e
  // isso é duplicidade real. E porque pode existir a entidade com o nome
  // oficial sob outro código — caso em que trocar o código seria desligar o
  // reconhecimento da importação, então a decisão é humana.
  const daOrganizacao = await prisma.affiliation.findMany({
    where: { organizationId: organizacao.id },
    select: { id: true, name: true, code: true, kind: true, active: true, createdAt: true },
    orderBy: { createdAt: 'asc' }
  });

  const porCodigo = daOrganizacao.filter(f => f.code.toUpperCase() === CODIGO_OFICIAL);
  const porNome = daOrganizacao.filter(f =>
    f.name.trim().toLowerCase() === NOME_OFICIAL.toLowerCase()
    && f.code.toUpperCase() !== CODIGO_OFICIAL);

  const candidatas = [...porCodigo, ...porNome];

  if (candidatas.length > 1) {
    return {
      ...base,
      estado: ESTADOS.CONFLITO,
      pendencias: [],
      candidatas: await Promise.all(candidatas.map(async f => ({
        affiliationId: f.id,
        affiliationName: f.name,
        affiliationCode: f.code,
        affiliationKind: f.kind,
        affiliationActive: f.active,
        vinculos: await vinculosDe(f.id)
      })))
    };
  }

  const pendencias = [];
  if (!organizacao.selfRegistrationOpen) pendencias.push(PENDENCIAS.AUTOCADASTRO_FECHADO);

  const filiacao = candidatas[0] ?? null;

  if (!filiacao) {
    pendencias.push(PENDENCIAS.FILIACAO_AUSENTE);
    return {
      ...base,
      estado: ESTADOS.PENDENTE,
      pendencias,
      affiliationId: null,
      affiliationName: null,
      affiliationCode: null,
      affiliationKind: null,
      affiliationActive: null,
      vinculos: null
    };
  }

  // A ENTIDADE COM O NOME OFICIAL SOB OUTRO CÓDIGO NÃO SE NORMALIZA SOZINHA.
  //
  // Trocar `code` é desligar o reconhecimento da importação para tudo que já
  // está no ledger sob o código antigo. Quem decide isso é a federação, com o
  // histórico na mão — não um script de deploy.
  if (filiacao.code.toUpperCase() !== CODIGO_OFICIAL) {
    return {
      ...base,
      estado: ESTADOS.CONFLITO,
      pendencias: [],
      candidatas: [{
        affiliationId: filiacao.id,
        affiliationName: filiacao.name,
        affiliationCode: filiacao.code,
        affiliationKind: filiacao.kind,
        affiliationActive: filiacao.active,
        vinculos: await vinculosDe(filiacao.id)
      }]
    };
  }

  if (!filiacao.active) pendencias.push(PENDENCIAS.FILIACAO_INATIVA);
  if (filiacao.name.trim() !== NOME_OFICIAL) pendencias.push(PENDENCIAS.NOME_DIVERGENTE);
  if (filiacao.kind !== TIPO_OFICIAL) pendencias.push(PENDENCIAS.TIPO_DIVERGENTE);

  return {
    ...base,
    estado: pendencias.length ? ESTADOS.PENDENTE : ESTADOS.CORRETO,
    pendencias,
    affiliationId: filiacao.id,
    affiliationName: filiacao.name,
    affiliationCode: filiacao.code,
    affiliationKind: filiacao.kind,
    affiliationActive: filiacao.active,
    vinculos: await vinculosDe(filiacao.id)
  };
}

/**
 * O INSERT DA FILIAÇÃO, CONTIDO POR SAVEPOINT.
 *
 * ENCONTRADO PELO TESTE DE CONCORRÊNCIA, e não pela revisão. A primeira versão
 * capturava P2002 e relia a linha — e a releitura falhava com
 * `25P02: current transaction is aborted, commands ignored until end of
 * transaction block`.
 *
 * O motivo é o mesmo que já custou um defeito nesta base, em `auditService`: no
 * PostgreSQL, UM STATEMENT RECUSADO ABORTA A TRANSAÇÃO INTEIRA. O `try/catch`
 * do JavaScript não desfaz isso — ele captura o erro e segue dentro de uma
 * transação que o banco já considera morta. Toda consulta depois dela é
 * recusada, inclusive a que existia para recuperar.
 *
 * SAVEPOINT é a única contenção. Com ele, o `ROLLBACK TO` desfaz só o INSERT
 * recusado e a transação continua viva para a releitura.
 *
 * Fora de transação — script chamando direto, sem `withUserContext` — não há
 * nada a conter e o `try/catch` basta.
 */
async function criarFiliacao(dados) {
  const tx = contextoAtual()?.tx;
  const inserir = () => prisma.affiliation.create({ data: dados, select: { id: true } });

  if (!tx) return inserir();

  const ponto = 'mci_filiacao_oficial';
  await tx.$executeRawUnsafe(`SAVEPOINT ${ponto}`);
  try {
    const criada = await inserir();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);
    return criada;
  } catch (erro) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${ponto}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${ponto}`);
    throw erro;
  }
}

/**
 * PROVISIONA, de forma idempotente, e só o que falta.
 *
 * Cenários cobertos, e todos medidos na suíte:
 *
 *   ausente              cria
 *   presente e correta   NÃO ESCREVE NADA — nem auditoria, porque ato que não
 *                        aconteceu não vai para a trilha
 *   presente e inativa   ativa
 *   nome ou tipo fora    normaliza esses campos, e só esses
 *   rodar de novo        nada a fazer
 *   duas execuções ao    a unicidade `(organizationId, code)` do banco resolve:
 *   mesmo tempo          quem perde a corrida recebe P2002, relê e reutiliza —
 *                        nunca nasce uma segunda NPC
 *   conflito             LANÇA. Não escolhe, não apaga, não renomeia código.
 */
async function provisionar(organizationId, actor) {
  const antes = await diagnosticar(organizationId);

  if (antes.estado === ESTADOS.ORGANIZACAO_NAO_CONFIGURADA) {
    throw new AppError(422, 'NPC_ORGANIZATION_NOT_CONFIGURED',
      'Defina MCI_NPC_ORGANIZATION_ID com a organização oficial do campeonato');
  }
  if (antes.estado === ESTADOS.ORGANIZACAO_INEXISTENTE) {
    throw new AppError(404, 'NPC_ORGANIZATION_NOT_FOUND',
      `Organização ${antes.organizationId} não existe`);
  }
  if (antes.estado === ESTADOS.ORGANIZACAO_INATIVA) {
    throw new AppError(422, 'NPC_ORGANIZATION_INACTIVE',
      `Organização ${antes.organizationName} está inativa; reative-a antes de provisionar a entidade oficial`);
  }
  if (antes.estado === ESTADOS.CONFLITO) {
    throw new AppError(409, 'NPC_AFFILIATION_CONFLICT',
      'Há mais de uma entidade candidata a oficial, ou uma com o nome oficial sob outro código. '
      + 'Nada foi alterado: resolva na federação qual é a oficial.');
  }
  if (antes.estado === ESTADOS.CORRETO) {
    return { ...antes, acoes: [] };
  }

  const acoes = [];

  if (antes.pendencias.includes(PENDENCIAS.AUTOCADASTRO_FECHADO)) {
    // O MESMO CAMINHO DO OPERADOR, e não um UPDATE próprio: `setSelfRegistration`
    // já confere a permissão e grava a auditoria. Dois códigos escrevendo a
    // mesma coluna é como as duas versões divergem sem ninguém notar.
    //
    // SÓ A ORGANIZAÇÃO CONFIGURADA. Nenhuma outra é tocada, e uma que esteja
    // fechada permanece fechada.
    await organizacoes.setSelfRegistration(antes.organizationId, true, actor);
    acoes.push('AUTOCADASTRO_ABERTO');
  }

  let filiacaoId = antes.affiliationId;

  if (antes.pendencias.includes(PENDENCIAS.FILIACAO_AUSENTE)) {
    try {
      const criada = await criarFiliacao({
        organizationId: antes.organizationId,
        name: NOME_OFICIAL,
        code: CODIGO_OFICIAL,
        kind: TIPO_OFICIAL,
        active: true
      });
      filiacaoId = criada.id;
      acoes.push('FILIACAO_CRIADA');

      await audit.record({
        actor, action: 'OFFICIAL_AFFILIATION_PROVISIONED',
        entity: 'Affiliation', entityId: criada.id,
        organizationId: antes.organizationId,
        metadata: { name: NOME_OFICIAL, code: CODIGO_OFICIAL, kind: TIPO_OFICIAL }
      });
    } catch (erro) {
      // A CORRIDA, RESOLVIDA PELO BANCO.
      //
      // Duas execuções simultâneas chegam aqui as duas: `diagnosticar` de ambas
      // leu "ausente" antes de qualquer INSERT. A unicidade
      // `(organizationId, code)` deixa passar uma só; a outra recebe P2002,
      // relê e REUTILIZA. Nunca nascem duas NPC — e a garantia é do banco, não
      // de ordem de escalonamento.
      //
      // A RELEITURA SÓ FUNCIONA porque `criarFiliacao` conteve o INSERT num
      // SAVEPOINT: sem ele a transação estaria abortada aqui e esta consulta
      // morreria com 25P02. Foi o que aconteceu na primeira versão, e foi o
      // teste de concorrência que mostrou.
      if (erro?.code !== 'P2002') throw erro;

      const existente = await prisma.affiliation.findFirst({
        where: { organizationId: antes.organizationId, code: CODIGO_OFICIAL },
        select: { id: true }
      });
      if (!existente) throw erro;
      filiacaoId = existente.id;
      acoes.push('FILIACAO_REUTILIZADA_APOS_CORRIDA');
    }
  }

  // NORMALIZAÇÃO MÍNIMA: só os campos que divergem, num UPDATE só.
  const correcoes = {};
  if (antes.pendencias.includes(PENDENCIAS.FILIACAO_INATIVA)) correcoes.active = true;
  if (antes.pendencias.includes(PENDENCIAS.NOME_DIVERGENTE)) correcoes.name = NOME_OFICIAL;
  if (antes.pendencias.includes(PENDENCIAS.TIPO_DIVERGENTE)) correcoes.kind = TIPO_OFICIAL;

  if (Object.keys(correcoes).length) {
    await prisma.affiliation.update({ where: { id: filiacaoId }, data: correcoes });
    acoes.push(`FILIACAO_NORMALIZADA:${Object.keys(correcoes).sort().join(',')}`);

    await audit.record({
      actor, action: 'OFFICIAL_AFFILIATION_NORMALIZED',
      entity: 'Affiliation', entityId: filiacaoId,
      organizationId: antes.organizationId,
      // O DE/PARA, e não só o depois: a trilha precisa dizer o que estava
      // errado, senão ela registra que algo mudou e não o quê.
      metadata: {
        de: {
          name: antes.affiliationName,
          kind: antes.affiliationKind,
          active: antes.affiliationActive
        },
        para: correcoes
      }
    });
  }

  const depois = await diagnosticar(organizationId);
  return { ...depois, acoes };
}

module.exports = {
  diagnosticar,
  provisionar,
  NOME_OFICIAL,
  CODIGO_OFICIAL,
  TIPO_OFICIAL,
  ESTADOS,
  PENDENCIAS
};

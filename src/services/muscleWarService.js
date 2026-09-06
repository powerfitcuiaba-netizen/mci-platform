const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { isValidCpf } = require('../utils/cpf');
const adapter = require('../utils/musclewar/adapter');
const audit = require('./auditService');
const notifications = require('./notificationService');
const ranking = require('./rankingService');
const { pontuarResultado } = require('../utils/rankingScoring');

const SOURCE = 'MUSCLEWAR';

// ============================================================================
// Importação de resultados do MuscleWar.
//
// O MCI não replica o MuscleWar: recebe dele o necessário para reconhecer o
// atleta, identificar o recorte de competição e trazer resultado e pontuação
// para o histórico e o ranking.
//
// Reconhecimento: CPF é a primeira chave; filiação é a segunda, usada para
// confirmar o vínculo quando informada. Atleta não encontrado NUNCA é criado
// em silêncio: vai para MATCH_PENDING e espera vinculação manual.
//
// Idempotência: `ExternalResult(source, externalId)` é único. Reimportar o
// mesmo resultado não gera segunda pontuação.
// ============================================================================

async function analisarLinha(registro, organizationId, seasonId) {
  // Sem identificador externo não há como garantir idempotência para a linha.
  if (!registro.externalResultId) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'Registro sem identificador externo (external_result_id)', athleteId: null };
  }
  if (registro.placing == null && registro.points == null) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'Registro sem colocação nem pontuação', athleteId: null };
  }
  if (!registro.cpf) {
    return { matchStatus: 'MATCH_PENDING', reason: 'CPF ausente no registro', athleteId: null };
  }
  if (!isValidCpf(registro.cpf)) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'CPF inválido', athleteId: null };
  }

  // Já aplicado antes: duplicado, não erro.
  const jaAplicado = await prisma.externalResult.findUnique({
    where: { source_externalId: { source: SOURCE, externalId: registro.externalResultId } }
  });
  if (jaAplicado) {
    return { matchStatus: 'DUPLICATE', reason: 'Resultado já importado anteriormente', athleteId: jaAplicado.athleteId };
  }

  const identidade = await prisma.athleteIdentity.findUnique({
    where: { organizationId_cpf: { organizationId, cpf: registro.cpf } },
    select: { athleteId: true }
  });

  const athlete = identidade && await prisma.athlete.findUnique({
    where: { id: identidade.athleteId },
    include: { affiliation: { select: { id: true, code: true, active: true } } }
  });

  if (!athlete) {
    return { matchStatus: 'MATCH_PENDING', reason: 'CPF não encontrado nesta organização', athleteId: null };
  }

  // Filiação como segunda chave: divergir é conflito para revisão humana, não
  // motivo para descartar o resultado.
  if (registro.affiliationCode) {
    const codigoAtleta = athlete.affiliation?.code || null;
    if (!codigoAtleta) {
      return { matchStatus: 'CONFLICT', reason: `Atleta sem filiação cadastrada; origem informa ${registro.affiliationCode}`, athleteId: athlete.id };
    }
    if (codigoAtleta.toUpperCase() !== registro.affiliationCode.toUpperCase()) {
      return { matchStatus: 'CONFLICT', reason: `Filiação divergente: cadastro ${codigoAtleta}, origem ${registro.affiliationCode}`, athleteId: athlete.id };
    }
  }

  // Categoria informada precisa existir no catálogo; sem isso o ponto entraria
  // sem recorte e o ranking por categoria ficaria incoerente.
  if (registro.categoryCode) {
    const categoria = await prisma.category.findUnique({ where: { code: registro.categoryCode.toUpperCase() } });
    if (!categoria) {
      return { matchStatus: 'CONFLICT', reason: `Categoria desconhecida no MCI: ${registro.categoryCode}`, athleteId: athlete.id };
    }
  }

  if (seasonId && registro.points == null && registro.placing != null) {
    const regra = await prisma.rankingPointsRule.findUnique({ where: { seasonId_placing: { seasonId, placing: registro.placing } } });
    if (!regra) {
      return { matchStatus: 'CONFLICT', reason: `Temporada sem pontuação definida para a colocação ${registro.placing}`, athleteId: athlete.id };
    }
  }

  return { matchStatus: 'MATCHED', reason: null, athleteId: athlete.id };
}

/**
 * Cria o lote e produz a pré-visualização. Nada é aplicado nesta etapa:
 * o operador revisa totais e pendências antes de confirmar.
 */
async function createImport(data, actor) {
  assertCan(actor, 'musclewar.import', data.organizationId);

  if (data.seasonId) {
    const temporada = await prisma.rankingSeason.findUnique({ where: { id: data.seasonId } });
    if (!temporada || temporada.organizationId !== data.organizationId) throw new AppError(422, 'SEASON_INVALID', 'Temporada inválida para esta organização');
    if (temporada.status !== 'OPEN') throw new AppError(422, 'SEASON_CLOSED', 'Temporada encerrada não recebe importação');
  }
  if (data.eventId) {
    const evento = await prisma.event.findUnique({ where: { id: data.eventId } });
    if (!evento || evento.organizationId !== data.organizationId) throw new AppError(422, 'EVENT_INVALID', 'Evento inválido para esta organização');
  }

  const registros = adapter.parse(data.sourceType, data.content, { fieldMap: data.fieldMap });
  if (!registros.length) throw new AppError(422, 'IMPORT_EMPTY', 'Nenhum registro encontrado na origem');

  // Duplicidade dentro do próprio arquivo: a segunda ocorrência do mesmo
  // identificador é duplicada, não um segundo resultado.
  const vistos = new Set();

  const analisados = [];
  for (const registro of registros) {
    let analise;
    let repetidoNoArquivo = false;

    if (registro.externalResultId && vistos.has(registro.externalResultId)) {
      repetidoNoArquivo = true;
      analise = { matchStatus: 'DUPLICATE', reason: `Identificador ${registro.externalResultId} repetido no próprio arquivo`, athleteId: null };
    } else {
      analise = await analisarLinha(registro, data.organizationId, data.seasonId ?? null);
      if (registro.externalResultId) vistos.add(registro.externalResultId);
    }
    analisados.push({ registro, analise, repetidoNoArquivo });
  }

  const totais = contar(analisados.map(item => item.analise.matchStatus));

  const lote = await prisma.$transaction(async tx => {
    const criado = await tx.muscleWarImport.create({
      data: {
        organizationId: data.organizationId,
        seasonId: data.seasonId ?? null,
        eventId: data.eventId ?? null,
        sourceType: data.sourceType,
        sourceRef: data.sourceRef,
        status: 'PREVIEWED',
        totalRecords: registros.length,
        matchedCount: totais.MATCHED,
        pendingCount: totais.MATCH_PENDING,
        conflictCount: totais.CONFLICT,
        duplicateCount: totais.DUPLICATE,
        rejectedCount: totais.IMPORT_REJECTED,
        createdById: actor.id
      }
    });

    let sequencia = 0;
    for (const { registro, analise, repetidoNoArquivo } of analisados) {
      sequencia += 1;

      // A chave do item é única dentro do lote. Linha sem identificador e
      // linha repetida ainda precisam existir para poderem ser revisadas —
      // então recebem um sufixo que preserva a origem sem colidir.
      const chaveDoItem = !registro.externalResultId
        ? `__sem-id__:${sequencia}`
        : repetidoNoArquivo
          ? `${registro.externalResultId}__repetida:${sequencia}`
          : registro.externalResultId;

      await tx.muscleWarImportItem.create({
        data: {
          importId: criado.id,
          externalResultId: chaveDoItem,
          rowNumber: registro.rowNumber,
          isOverallChampion: registro.isOverallChampion === true,
          teamName: registro.teamName,
          companyName: registro.companyName,
          cpf: registro.cpf,
          athleteName: registro.athleteName,
          affiliationCode: registro.affiliationCode,
          categoryCode: registro.categoryCode,
          divisionName: registro.divisionName,
          className: registro.className,
          placing: registro.placing,
          points: registro.points,
          eventName: registro.eventName,
          eventDate: registro.eventDate,
          raw: registro.raw,
          matchStatus: analise.matchStatus,
          reason: analise.reason,
          athleteId: analise.athleteId
        }
      });
    }

    return criado;
  });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_IMPORT, entity: 'MuscleWarImport', entityId: lote.id,
    organizationId: data.organizationId,
    metadata: { sourceType: data.sourceType, sourceRef: data.sourceRef, total: registros.length, ...totais }
  });

  return preview(lote.id, actor);
}

function contar(status) {
  const base = { MATCHED: 0, MATCH_PENDING: 0, CONFLICT: 0, DUPLICATE: 0, IMPORT_REJECTED: 0, APPLIED: 0 };
  for (const item of status) base[item] = (base[item] ?? 0) + 1;
  return base;
}

async function preview(importId, actor) {
  const lote = await prisma.muscleWarImport.findUnique({
    where: { id: importId },
    include: {
      season: { select: { id: true, name: true, year: true } },
      event: { select: { id: true, name: true, slug: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      appliedBy: { select: { id: true, name: true, email: true } }
    }
  });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');

  assertCan(actor, 'musclewar.review', lote.organizationId);

  const items = await prisma.muscleWarImportItem.findMany({
    where: { importId },
    include: { athlete: { select: { id: true, fullName: true, stageName: true, athleteNumber: true } } },
    orderBy: { rowNumber: 'asc' }
  });

  const totais = contar(items.map(item => item.matchStatus));

  return {
    import: lote,
    summary: {
      totalRecords: items.length,
      recognized: totais.MATCHED,
      pending: totais.MATCH_PENDING,
      conflicts: totais.CONFLICT,
      duplicates: totais.DUPLICATE,
      rejected: totais.IMPORT_REJECTED,
      applied: totais.APPLIED,
      // O que efetivamente entraria se o lote fosse aplicado agora.
      valid: totais.MATCHED
    },
    items
  };
}

/**
 * Vinculação manual de uma linha pendente a um atleta existente. É a única
 * porta para resolver MATCH_PENDING — nenhum atleta é criado pela importação.
 */
async function linkItem(itemId, { athleteId }, actor) {
  const item = await prisma.muscleWarImportItem.findUnique({ where: { id: itemId }, include: { import: true } });
  if (!item) throw new AppError(404, 'IMPORT_ITEM_NOT_FOUND', 'Registro de importação não encontrado');

  assertCan(actor, 'musclewar.review', item.import.organizationId);

  if (item.import.status === 'APPLIED') throw new AppError(422, 'IMPORT_ALREADY_APPLIED', 'Lote já aplicado');
  if (!['MATCH_PENDING', 'CONFLICT'].includes(item.matchStatus)) {
    throw new AppError(422, 'ITEM_NOT_PENDING', `Registro em ${item.matchStatus} não aceita vinculação`);
  }

  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  if (athlete.organizationId !== item.import.organizationId) throw new AppError(403, 'FORBIDDEN', 'Atleta de outra organização');

  // Vincular a um CPF diferente do que veio da origem é decisão consciente do
  // operador e fica registrada como tal.
  const cadastrado = await prisma.athleteIdentity.findUnique({
    where: { athleteId },
    select: { cpf: true }
  });
  const cpfDivergente = Boolean(item.cpf) && Boolean(cadastrado) && item.cpf !== cadastrado.cpf;

  const atualizado = await prisma.muscleWarImportItem.update({
    where: { id: itemId },
    data: {
      athleteId,
      matchStatus: 'MATCHED',
      reason: cpfDivergente ? `Vinculado manualmente (CPF da origem difere do cadastro)` : 'Vinculado manualmente',
      linkedById: actor.id,
      linkedAt: new Date()
    }
  });

  await recontar(item.importId);

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_REVIEW, entity: 'MuscleWarImportItem', entityId: itemId,
    organizationId: item.import.organizationId,
    metadata: { athleteId, externalResultId: item.externalResultId, cpfDivergente }
  });

  if (athlete.userId) {
    await notifications.notify({
      userIds: [athlete.userId], type: notifications.TYPES.ATHLETE_MATCHED,
      title: 'Resultado externo vinculado',
      message: `Um resultado do MuscleWar foi vinculado ao seu perfil.`,
      entityType: 'MuscleWarImportItem', entityId: itemId, actorId: actor.id
    });
  }

  return atualizado;
}

async function recontar(importId) {
  const items = await prisma.muscleWarImportItem.findMany({ where: { importId }, select: { matchStatus: true } });
  const totais = contar(items.map(item => item.matchStatus));

  return prisma.muscleWarImport.update({
    where: { id: importId },
    data: {
      totalRecords: items.length,
      matchedCount: totais.MATCHED,
      pendingCount: totais.MATCH_PENDING,
      conflictCount: totais.CONFLICT,
      duplicateCount: totais.DUPLICATE,
      rejectedCount: totais.IMPORT_REJECTED,
      appliedCount: totais.APPLIED
    }
  });
}

/**
 * Aplica o lote. Só linhas MATCHED entram; pendências e conflitos ficam para
 * revisão e podem ser aplicados depois, no mesmo lote, sem duplicar o que já
 * entrou.
 */
async function apply(importId, actor) {
  const lote = await prisma.muscleWarImport.findUnique({ where: { id: importId } });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');

  assertCan(actor, 'musclewar.apply', lote.organizationId);

  if (lote.status === 'REJECTED') throw new AppError(422, 'IMPORT_REJECTED', 'Lote rejeitado não pode ser aplicado');

  const aplicaveis = await prisma.muscleWarImportItem.findMany({
    where: { importId, matchStatus: 'MATCHED', athleteId: { not: null } },
    orderBy: { rowNumber: 'asc' }
  });

  if (!aplicaveis.length) throw new AppError(422, 'NOTHING_TO_APPLY', 'Nenhum registro reconhecido para aplicar');

  const seasonId = lote.seasonId;
  let aplicados = 0;
  let ignorados = 0;
  let divergentes = 0;

  // Tabela da temporada e catálogo de classes carregados uma vez: a regra é a
  // mesma para o lote inteiro, e consultá-la por linha só somaria idas ao banco.
  const tabela = seasonId
    ? await prisma.rankingPointsRule.findMany({ where: { seasonId }, select: { placing: true, points: true } })
    : [];

  const catalogo = new Map(
    (await prisma.classCatalog.findMany({
      where: { organizationId: lote.organizationId },
      select: { code: true, superOverallEligible: true }
    })).map(classe => [classe.code.toUpperCase(), classe.superOverallEligible])
  );

  const equipes = new Map(
    (await prisma.team.findMany({
      where: { organizationId: lote.organizationId },
      select: { id: true, name: true, companyId: true }
    })).map(equipe => [equipe.name.trim().toUpperCase(), equipe])
  );

  const empresas = new Map(
    (await prisma.company.findMany({
      where: { organizationId: lote.organizationId },
      select: { id: true, name: true }
    })).map(empresa => [empresa.name.trim().toUpperCase(), empresa.id])
  );

  // Vínculos de equipe dos atletas do lote. A trava de vínculo único não pode
  // parar na tela e na API: sem isto, bastaria um arquivo nomeando outra equipe
  // para que ela acumulasse os pontos de um atleta que não é dela — a regra
  // seria contornada justamente pela porta que o operador usa em massa.
  const vinculos = new Map();
  for (const linha of await prisma.athleteTeamMembership.findMany({
    where: { athleteId: { in: aplicaveis.map(item => item.athleteId) } },
    select: { athleteId: true, teamId: true, startedAt: true, endedAt: true, team: { select: { name: true, companyId: true } } }
  })) {
    if (!vinculos.has(linha.athleteId)) vinculos.set(linha.athleteId, []);
    vinculos.get(linha.athleteId).push(linha);
  }

  // Qual vínculo responde por este resultado.
  //
  // 1. O que valia NA DATA DO EVENTO, se houver: um resultado antigo pertence à
  //    equipe de então, e o histórico guarda exatamente isso.
  // 2. Na falta dele — linha sem data, ou data anterior a qualquer vínculo —, o
  //    vínculo ATIVO. Cair no arquivo aqui seria abrir a porta de volta:
  //    bastaria datar a linha antes do vínculo para atribuí-la a quem quisesse.
  // 3. Atleta que nunca teve vínculo: não há fato registrado a contradizer, e o
  //    arquivo segue sendo a única fonte.
  const vinculoDoResultado = (athleteId, data) => {
    const linhas = vinculos.get(athleteId) || [];
    const daEpoca = data
      ? linhas.find(linha => linha.startedAt <= data && (!linha.endedAt || linha.endedAt >= data))
      : null;
    return daEpoca ?? linhas.find(linha => !linha.endedAt) ?? null;
  };

  for (const item of aplicaveis) {
    // A equipe declarada no arquivo não pode contradizer o vínculo registrado.
    // Divergência não é corrigida em silêncio nem aceita: a linha fica em
    // CONFLICT para o operador resolver — ou o arquivo está errado, ou o
    // atleta mudou de equipe e a transferência não foi feita pela via própria.
    const equipeDeclarada = item.teamName ? equipes.get(item.teamName.trim().toUpperCase()) : null;
    const vinculo = vinculoDoResultado(item.athleteId, item.eventDate);

    if (equipeDeclarada && vinculo && vinculo.teamId !== equipeDeclarada.id) {
      await prisma.muscleWarImportItem.update({
        where: { id: item.id },
        data: {
          matchStatus: 'CONFLICT',
          reason: `Equipe divergente: o arquivo indica ${equipeDeclarada.name}, `
            + `mas o atleta estava vinculado a ${vinculo.team?.name ?? 'outra equipe'}. `
            + 'Corrija o arquivo ou registre a transferência antes de aplicar.'
        }
      });
      divergentes += 1;
      continue;
    }

    // Cada linha em sua própria transação: uma colisão de idempotência no meio
    // do lote não desfaz o que já entrou legitimamente.
    try {
      await prisma.$transaction(async tx => {
        const externo = await tx.externalResult.create({
          data: {
            source: SOURCE,
            externalId: item.externalResultId,
            seasonId,
            athleteId: item.athleteId,
            categoryCode: item.categoryCode,
            className: item.className,
            placing: item.placing,
            points: item.points ?? 0,
            eventName: item.eventName,
            eventDate: item.eventDate,
            importItemId: item.id
          }
        });

        if (seasonId) {
          // A COLOCAÇÃO é a fonte primária dos pontos, não um número digitado.
          // O operador informa o resultado oficial; o sistema aplica a regra
          // homologada — inclusive o bônus de Overall, quando a origem o
          // informa. Uma coluna de pontos no arquivo só é usada quando a linha
          // não traz colocação alguma, caso em que não há regra a aplicar.
          const { placementPoints, overallBonus, points } = item.placing != null
            ? pontuarResultado(item.placing, tabela, item.isOverallChampion)
            : { placementPoints: item.points ?? 0, overallBonus: 0, points: item.points ?? 0 };

          const categoria = item.categoryCode
            ? await tx.category.findUnique({ where: { code: item.categoryCode.toUpperCase() } })
            : null;

          // Elegibilidade ao Super Overall: resolvida pela classe declarada,
          // contra o catálogo da organização. O código "OPEN" não aparece aqui.
          const superOverallEligible = Boolean(
            item.className && catalogo.get(item.className.trim().toUpperCase())
          );

          // Na ausência de equipe no arquivo, o vínculo registrado responde —
          // é o mesmo fato, vindo da fonte que a plataforma controla.
          const equipeDoItem = equipeDeclarada
            ?? (vinculo ? { id: vinculo.teamId, companyId: vinculo.team?.companyId ?? null } : null);

          await tx.rankingPoint.create({
            data: {
              seasonId,
              athleteId: item.athleteId,
              categoryId: categoria?.id ?? null,
              source: 'MUSCLEWAR',
              externalResultId: externo.id,
              placing: item.placing,
              placementPoints, overallBonus,
              isOverallChampion: item.isOverallChampion === true,
              superOverallEligible,
              teamId: equipeDoItem?.id ?? null,
              // A empresa vem da declarada na origem; na falta dela, da equipe
              // reconhecida — que é a cadeia natural: atleta → equipe → empresa.
              companyId: (item.companyName ? empresas.get(item.companyName.trim().toUpperCase()) : null)
                ?? equipeDoItem?.companyId ?? null,
              awardedById: actor?.id ?? null,
              points
            }
          });
        }

        await tx.muscleWarImportItem.update({ where: { id: item.id }, data: { matchStatus: 'APPLIED' } });
      });
      aplicados += 1;
    } catch (error) {
      if (error.code === 'P2002') {
        // Outro lote já trouxe este resultado: duplicado, não erro.
        await prisma.muscleWarImportItem.update({
          where: { id: item.id },
          data: { matchStatus: 'DUPLICATE', reason: 'Resultado já existente na plataforma' }
        });
        ignorados += 1;
        continue;
      }
      throw error;
    }
  }

  if (seasonId) await ranking.recompute_(seasonId);

  await recontar(importId);

  const atualizado = await prisma.muscleWarImport.update({
    where: { id: importId },
    data: {
      status: 'APPLIED',
      appliedById: actor.id,
      appliedAt: new Date(),
      // Reaplicar o mesmo lote depois de resolver pendências cria uma nova
      // versão da importação; o histórico anterior não é apagado.
      version: lote.status === 'APPLIED' ? lote.version + 1 : lote.version
    }
  });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_APPLY, entity: 'MuscleWarImport', entityId: importId,
    organizationId: lote.organizationId,
    metadata: {
      applied: aplicados, skippedAsDuplicate: ignorados, teamMismatch: divergentes,
      seasonId, version: atualizado.version, sourceRef: lote.sourceRef
    }
  });

  const atletas = await prisma.athlete.findMany({
    where: { id: { in: aplicaveis.map(item => item.athleteId) } },
    select: { userId: true }
  });

  await notifications.notify({
    userIds: atletas.map(atleta => atleta.userId).filter(Boolean),
    type: notifications.TYPES.IMPORT_APPLIED,
    title: 'Resultado importado',
    message: 'Um resultado do MuscleWar foi somado ao seu histórico.',
    entityType: 'MuscleWarImport', entityId: importId, actorId: actor.id
  });

  return {
    applied: aplicados, skippedAsDuplicate: ignorados, teamMismatch: divergentes,
    preview: await preview(importId, actor)
  };
}

async function reject(importId, { reason }, actor) {
  const lote = await prisma.muscleWarImport.findUnique({ where: { id: importId } });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');
  assertCan(actor, 'musclewar.apply', lote.organizationId);

  if (lote.status === 'APPLIED') throw new AppError(422, 'IMPORT_ALREADY_APPLIED', 'Lote já aplicado não pode ser rejeitado');

  const atualizado = await prisma.muscleWarImport.update({ where: { id: importId }, data: { status: 'REJECTED' } });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_REVIEW, entity: 'MuscleWarImport', entityId: importId,
    organizationId: lote.organizationId, metadata: { rejected: true, reason: reason ?? null }
  });

  return atualizado;
}

async function listImports(filtros, actor) {
  const { organizationFilter } = require('../utils/tenant');
  const escopo = organizationFilter(actor, filtros.organizationId);

  return prisma.muscleWarImport.findMany({
    where: escopo,
    include: {
      createdBy: { select: { id: true, name: true } },
      appliedBy: { select: { id: true, name: true } },
      season: { select: { id: true, name: true, year: true } },
      event: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });
}

module.exports = { createImport, preview, linkItem, apply, reject, listImports, analisarLinha, SOURCE };

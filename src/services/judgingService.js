const motor = require('../domain/julgamento/motorPontuacao');
const { resultado: maquinaResultado } = require('../domain/estados/maquinas');
const { pode, assertPode } = require('../domain/acesso/permissoes');
const { AppError } = require('../utils/errors');

// ============================================================================
// SERVIÇO DE JULGAMENTO.
//
// Faz a ponte entre o motor de apuração (lógica pura, sem banco) e a
// persistência. A regra de cálculo NÃO mora aqui — mora no motor, e este
// serviço apenas monta a entrada, chama, e grava a saída com auditoria.
//
// As dependências de infraestrutura (banco, repositório, auditoria) entram por
// parâmetro em vez de `require` no topo. O motivo é testabilidade: assim a
// regra de autorização e a de transição de estado podem ser provadas sem subir
// PostgreSQL. O domínio continua importado direto — ele é a coisa sob teste,
// não um detalhe substituível.
// ============================================================================

function criarServicoDeJulgamento({ prisma, repo, audit }) {
  const ehMembroDoPainel = (sessao, userId) =>
    sessao.panel.members.some(membro => membro.judgeUserId === userId);

  // Isolamento do juiz (seção 35): não basta ter o papel JUIZ, é preciso estar
  // escalado NAQUELE painel. Um juiz não pontua bateria que não é sua.
  function assertPodePontuar(sessao, actor) {
    if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
    assertPode(actor.role, 'judging.score');

    if (!ehMembroDoPainel(sessao, actor.id)) {
      throw new AppError(403, 'FORBIDDEN', 'Você não está escalado no painel desta bateria');
    }
    if (sessao.status !== 'ABERTA') {
      throw new AppError(422, 'BATERIA_FECHADA', 'Esta bateria não aceita mais notas');
    }
  }

  // -------------------------------------------------------------------------
  // Envio de nota. Idempotente por construção: a chave natural
  // (bateria, juiz, atleta) é única, então reenvio corrige em vez de duplicar.
  // Isso importa porque a rede do ginásio cai (seções 28 e 36).
  // -------------------------------------------------------------------------
  async function registrarNota(sessionId, dados, actor) {
    const sessao = await repo.buscarSessao(sessionId);
    if (!sessao) throw new AppError(404, 'NOT_FOUND', 'Bateria não encontrada');

    assertPodePontuar(sessao, actor);

    const inscricao = await prisma.enrollment.findUnique({
      where: { id: dados.enrollmentId },
      select: { id: true, eventCategoryId: true, status: true }
    });

    if (!inscricao) throw new AppError(404, 'NOT_FOUND', 'Inscrição não encontrada');
    if (inscricao.eventCategoryId !== sessao.eventCategoryId) {
      throw new AppError(422, 'ATLETA_FORA_DA_BATERIA', 'Este atleta não compete nesta categoria');
    }

    // judgeUserId vem SEMPRE do ator autenticado, nunca do corpo da requisição:
    // é o que impede um juiz assinar súmula em nome de outro.
    const nota = await repo.registrarNota({
      sessionId,
      judgeUserId: actor.id,
      enrollmentId: dados.enrollmentId,
      placing: dados.placing,
      clientRef: dados.clientRef
    });

    await audit.record({
      actor,
      action: 'JUDGING_SCORE',
      entity: 'JudgingScore',
      entityId: nota.id,
      metadata: { sessionId, enrollmentId: dados.enrollmentId, placing: dados.placing }
    });

    return nota;
  }

  // O juiz consulta apenas as próprias notas. Ver a nota do colega antes de
  // fechar a súmula é exatamente o que o isolamento existe para impedir.
  async function minhasNotas(sessionId, actor) {
    const sessao = await repo.buscarSessao(sessionId);
    if (!sessao) throw new AppError(404, 'NOT_FOUND', 'Bateria não encontrada');
    if (!ehMembroDoPainel(sessao, actor.id)) {
      throw new AppError(403, 'FORBIDDEN', 'Você não está escalado no painel desta bateria');
    }
    return { items: await repo.notasDoJuiz(sessionId, actor.id) };
  }

  // -------------------------------------------------------------------------
  // Apuração. Monta a entrada do motor a partir do banco e grava o resultado.
  //
  // Tudo numa transação: um resultado meio gravado — colocações sem cabeçalho,
  // ou cabeçalho sem colocações — é pior do que nenhum resultado (seção 77).
  // -------------------------------------------------------------------------
  async function apurar(sessionId, actor) {
    assertPode(actor?.role, 'results.review');

    const sessao = await repo.carregarSessaoParaApuracao(sessionId);
    if (!sessao) throw new AppError(404, 'NOT_FOUND', 'Bateria não encontrada');

    const inscricoes = sessao.eventCategory.enrollments;
    if (inscricoes.length === 0) {
      throw new AppError(422, 'CATEGORIA_SEM_ATLETA', 'Não há inscrição apta nesta categoria');
    }

    const semAtleta = inscricoes.filter(i => !i.athleteId);
    if (semAtleta.length > 0) {
      throw new AppError(422, 'INSCRICAO_SEM_ATLETA', 'Há inscrição sem atleta vinculado nesta categoria', {
        inscricoes: semAtleta.map(i => i.id)
      });
    }

    // A identidade que o motor recebe é a INSCRIÇÃO, não o atleta: é a inscrição
    // que compete numa categoria específica, e o mesmo atleta pode estar em duas.
    const entrada = {
      atletas: inscricoes.map(i => i.id),
      juizes: sessao.panel.members.map(m => m.judgeUserId),
      juizPrincipalId: sessao.panel.headJudgeId || null,
      notas: sessao.scores.map(nota => ({
        juizId: nota.judgeUserId,
        atletaId: nota.enrollmentId,
        colocacao: nota.placing
      }))
    };

    // A regra da bateria tem precedência sobre a da categoria; sem nenhuma das
    // duas, o motor aplica o padrão neutro (zero descarte).
    const regra = sessao.scoringRule || sessao.eventCategory.scoringRule || {};
    const configuracao = {
      descartarMaiores: regra.dropHighest,
      descartarMenores: regra.dropLowest,
      criteriosDesempate: regra.tiebreakers,
      exigirPainelCompleto: regra.requireFullPanel
    };

    // Se a bateria estiver inconsistente o motor lança 422 com a lista de
    // problemas, e nada é gravado.
    const apuracao = motor.calcular(entrada, configuracao);

    const athletePorInscricao = new Map(inscricoes.map(i => [i.id, i.athleteId]));

    const salvo = await prisma.$transaction(async tx => {
      const anterior = await tx.competitionResult.findFirst({
        where: { eventCategoryId: sessao.eventCategoryId },
        orderBy: { version: 'desc' }
      });

      // Resultado já publicado não é recalculado por cima: reabrir exige
      // results.override e passa pela máquina de estados (seção 39).
      if (anterior && ['PUBLICADO', 'BLOQUEADO'].includes(anterior.status)) {
        throw new AppError(
          409,
          'RESULTADO_PUBLICADO',
          'Este resultado já foi publicado; reabra-o antes de recalcular'
        );
      }

      if (anterior) {
        await tx.athletePlacement.deleteMany({ where: { resultId: anterior.id } });
      }

      const dados = {
        status: apuracao.apuravel ? 'EM_REVISAO' : 'RASCUNHO',
        signature: apuracao.assinatura,
        calculatedAt: new Date(),
        sessionId
      };

      const resultado = anterior
        ? await tx.competitionResult.update({ where: { id: anterior.id }, data: dados })
        : await tx.competitionResult.create({
            data: { ...dados, eventCategoryId: sessao.eventCategoryId }
          });

      await tx.athletePlacement.createMany({
        data: apuracao.colocacoes.map(c => ({
          resultId: resultado.id,
          enrollmentId: c.atletaId,
          athleteId: athletePorInscricao.get(c.atletaId),
          placing: c.posicao,
          score: c.soma,
          fullScore: c.somaCompleta,
          tied: c.empatado
        }))
      });

      return resultado;
    });

    await audit.record({
      actor,
      action: 'RESULT_CALCULATE',
      entity: 'CompetitionResult',
      entityId: salvo.id,
      metadata: {
        sessionId,
        assinatura: apuracao.assinatura,
        apuravel: apuracao.apuravel,
        empates: apuracao.empatesNaoResolvidos
      }
    });

    return {
      resultado: salvo,
      colocacoes: apuracao.colocacoes,
      // Empate não resolvido volta explícito: quem decide é o juiz principal, e
      // a interface precisa mostrar isso em vez de exibir um pódio que não existe.
      empatesNaoResolvidos: apuracao.empatesNaoResolvidos,
      apuravel: apuracao.apuravel,
      regraAplicada: apuracao.regraAplicada
    };
  }

  // -------------------------------------------------------------------------
  // Transição de estado do resultado. Toda mudança passa pela máquina, que já
  // checa a permissão exigida por transição privilegiada.
  // -------------------------------------------------------------------------
  async function transitar(resultId, destino, actor, { motivo } = {}) {
    const atual = await repo.buscarResultado(resultId);
    if (!atual) throw new AppError(404, 'NOT_FOUND', 'Resultado não encontrado');

    maquinaResultado.assertTransicao(atual.status, destino, actor?.role);

    // Reabrir resultado publicado sem dizer por quê deixaria a auditoria inútil
    // justamente no caso em que ela mais importa (seção 80).
    const exigiaPrivilegio = Boolean(maquinaResultado.permissaoExigida(atual.status, destino));
    if (exigiaPrivilegio && !motivo) {
      throw new AppError(422, 'MOTIVO_OBRIGATORIO', 'Esta operação exige um motivo registrado');
    }

    const dados = { status: destino };
    if (destino === 'APROVADO') {
      dados.approvedAt = new Date();
      dados.approvedByUserId = actor.id;
    }
    if (exigiaPrivilegio) {
      dados.overrideReason = motivo;
      // Reabertura inicia uma nova versão: a anterior permanece identificável.
      if (atual.status === 'PUBLICADO') dados.version = atual.version + 1;
    }

    const atualizado = await repo.atualizarStatusResultado(resultId, dados);

    await audit.record({
      actor,
      action: exigiaPrivilegio ? 'RESULT_OVERRIDE' : `RESULT_${destino}`,
      entity: 'CompetitionResult',
      entityId: resultId,
      metadata: { de: atual.status, para: destino, motivo: motivo || null }
    });

    return atualizado;
  }

  // Lança os pontos da temporada vigente. Idempotente: a unique
  // (temporada, atleta, resultado) faz republicação não somar de novo (seção 28).
  async function lancarPontosDeRanking(tx, { resultado, placements }) {
    const organizationId = resultado.eventCategory?.tournament?.organizationId;
    if (!organizationId) return { lancados: 0, motivo: 'evento sem organização' };

    const temporada = await tx.season.findFirst({
      where: { organizationId, active: true },
      orderBy: { year: 'desc' }
    });
    if (!temporada) return { lancados: 0, motivo: 'nenhuma temporada ativa' };

    // A tabela de pontos é configuração da temporada. Sem tabela definida, não
    // se inventa pontuação: o ranking simplesmente não recebe lançamento
    // (seção 72).
    const tabela = temporada.pointsTable;
    if (!tabela || typeof tabela !== 'object') {
      return { lancados: 0, motivo: 'temporada sem tabela de pontos' };
    }

    let lancados = 0;
    for (const p of placements) {
      const pontos = Number(tabela[String(p.placing)]);
      if (!Number.isFinite(pontos) || pontos <= 0) continue;

      await tx.rankingPoint.upsert({
        where: {
          seasonId_athleteId_resultId: {
            seasonId: temporada.id,
            athleteId: p.athleteId,
            resultId: resultado.id
          }
        },
        create: {
          seasonId: temporada.id,
          athleteId: p.athleteId,
          resultId: resultado.id,
          placing: p.placing,
          points: pontos
        },
        update: { placing: p.placing, points: pontos }
      });
      lancados += 1;
    }

    return { lancados };
  }

  // -------------------------------------------------------------------------
  // Publicação. É o ponto de não retorno: congela o snapshot e lança os pontos
  // de ranking (seções 41 e 79).
  // -------------------------------------------------------------------------
  async function publicar(resultId, actor) {
    assertPode(actor?.role, 'results.publish');

    const atual = await repo.buscarResultado(resultId);
    if (!atual) throw new AppError(404, 'NOT_FOUND', 'Resultado não encontrado');

    maquinaResultado.assertTransicao(atual.status, 'PUBLICADO', actor.role);

    const publicado = await prisma.$transaction(async tx => {
      const placements = await tx.athletePlacement.findMany({
        where: { resultId },
        orderBy: { placing: 'asc' },
        include: { athlete: { select: { id: true, fullName: true, slug: true } } }
      });

      if (placements.length === 0) {
        throw new AppError(422, 'RESULTADO_VAZIO', 'Não há colocações para publicar');
      }
      // Pódio com empate não vira resultado oficial.
      if (placements.some(p => p.tied)) {
        throw new AppError(422, 'EMPATE_PENDENTE', 'Há empate não resolvido: registre o desempate antes de publicar');
      }

      // Cópia congelada. Alteração posterior em dado operacional (nome do
      // atleta, vínculo de equipe) não reescreve o que foi publicado (seção 79).
      const snapshot = {
        publicadoEm: new Date().toISOString(),
        assinatura: atual.signature,
        colocacoes: placements.map(p => ({
          posicao: p.placing,
          atletaId: p.athleteId,
          atleta: p.athlete?.fullName || null,
          slug: p.athlete?.slug || null,
          soma: p.score,
          somaCompleta: p.fullScore
        }))
      };

      const resultado = await tx.competitionResult.update({
        where: { id: resultId },
        data: {
          status: 'PUBLICADO',
          publishedAt: new Date(),
          publishedByUserId: actor.id,
          snapshot
        }
      });

      await lancarPontosDeRanking(tx, { resultado: atual, placements });

      return resultado;
    });

    await audit.record({
      actor,
      action: 'RESULT_PUBLISH',
      entity: 'CompetitionResult',
      entityId: resultId,
      metadata: { assinatura: atual.signature }
    });

    return publicado;
  }

  // Consulta pública do resultado. Antes da publicação, só quem revisa enxerga —
  // resultado em revisão vazando é pódio divulgado errado (seção 14).
  async function consultarPorCategoria(eventCategoryId, actor) {
    const resultado = await repo.resultadoDaCategoria(eventCategoryId);
    if (!resultado) throw new AppError(404, 'NOT_FOUND', 'Resultado não encontrado');

    if (resultado.status !== 'PUBLICADO') {
      // 404 e não 403: responder "existe mas você não pode ver" já entrega que
      // há resultado apurado antes da divulgação oficial.
      if (!actor || !pode(actor.role, 'results.review')) {
        throw new AppError(404, 'NOT_FOUND', 'Resultado não encontrado');
      }
    }

    return resultado;
  }

  return { registrarNota, minhasNotas, apurar, transitar, publicar, consultarPorCategoria };
}

// Instância de produção, com as dependências reais. É o que os controllers usam.
const servicoPadrao = criarServicoDeJulgamento({
  prisma: require('../config/prisma'),
  repo: require('../repositories/judgingRepository'),
  audit: require('./auditService')
});

module.exports = { ...servicoPadrao, criarServicoDeJulgamento };

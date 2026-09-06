import { beforeEach, describe, expect, it, vi } from 'vitest';

// Testes de autorização e de regra do serviço de julgamento.
//
// O banco é mockado; o DOMÍNIO NÃO É. Motor de apuração, máquina de estados e
// RBAC rodam de verdade — é justamente o comportamento deles através do serviço
// que precisa de prova. Mockar o domínio junto transformaria isto num teste do
// próprio mock.
//
// Cobre os cenários negativos da seção 64: juiz fora do painel, juiz assinando
// por outro, publicação com empate, reabertura de resultado publicado.

// As dependências entram pela fábrica do serviço, e não por interceptação de
// módulo. É mais simples e mais firme: não depende de o vitest conseguir
// substituir um `require` interno de um módulo CommonJS.
import { criarServicoDeJulgamento } from '../src/services/judgingService.js';

const prismaMock = {
  enrollment: { findUnique: vi.fn() },
  $transaction: vi.fn()
};

const repoMock = {
  buscarSessao: vi.fn(),
  carregarSessaoParaApuracao: vi.fn(),
  registrarNota: vi.fn(),
  notasDoJuiz: vi.fn(),
  buscarResultado: vi.fn(),
  resultadoDaCategoria: vi.fn(),
  atualizarStatusResultado: vi.fn()
};

const auditMock = { record: vi.fn() };

const service = criarServicoDeJulgamento({ prisma: prismaMock, repo: repoMock, audit: auditMock });

// Atores. O papel é o que o RBAC real vai consultar.
const juiz = { id: 'juiz-1', role: 'JUIZ', email: 'juiz1@mci.test' };
const outroJuiz = { id: 'juiz-2', role: 'JUIZ', email: 'juiz2@mci.test' };
const diretor = { id: 'dir-1', role: 'DIRETOR_COMPETICAO', email: 'dir@mci.test' };
const superAdmin = { id: 'root-1', role: 'SUPER_ADMIN', email: 'root@mci.test' };
const atleta = { id: 'atl-1', role: 'ATLETA', email: 'atleta@mci.test' };

const sessaoAberta = (extras = {}) => ({
  id: 'bat-1',
  eventCategoryId: 'cat-1',
  status: 'ABERTA',
  panel: {
    headJudgeId: 'juiz-1',
    members: [{ judgeUserId: 'juiz-1' }, { judgeUserId: 'juiz-2' }, { judgeUserId: 'juiz-3' }]
  },
  ...extras
});

// $transaction recebe uma função e a executa com o cliente transacional.
const comTransacao = tx => {
  prismaMock.$transaction.mockImplementation(async fn => fn(tx));
};

const capturar = async promessa => {
  try {
    await promessa;
    return null;
  } catch (erro) {
    return erro;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.record.mockResolvedValue(null);
});

describe('registro de nota — isolamento do juiz', () => {
  it('recusa juiz que não está escalado no painel desta bateria', async () => {
    // Ter o papel JUIZ não basta. O juiz-9 é juiz, mas não deste painel.
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta());

    const erro = await capturar(
      service.registrarNota('bat-1', { enrollmentId: 'ins-1', placing: 1 }, { id: 'juiz-9', role: 'JUIZ' })
    );

    expect(erro.status).toBe(403);
    expect(erro.message).toMatch(/não está escalado/);
    expect(repoMock.registrarNota).not.toHaveBeenCalled();
  });

  it('recusa papel sem permissão de pontuar', async () => {
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta({
      panel: { headJudgeId: null, members: [{ judgeUserId: 'atl-1' }] }
    }));

    const erro = await capturar(service.registrarNota('bat-1', { enrollmentId: 'ins-1', placing: 1 }, atleta));

    expect(erro.status).toBe(403);
    expect(erro.details.permissaoExigida).toBe('judging.score');
  });

  it('recusa nota em bateria já fechada', async () => {
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta({ status: 'FECHADA' }));

    const erro = await capturar(service.registrarNota('bat-1', { enrollmentId: 'ins-1', placing: 1 }, juiz));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('BATERIA_FECHADA');
  });

  it('recusa nota para atleta que compete em outra categoria', async () => {
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta());
    prismaMock.enrollment.findUnique.mockResolvedValue({ id: 'ins-9', eventCategoryId: 'cat-OUTRA', status: 'APROVADA' });

    const erro = await capturar(service.registrarNota('bat-1', { enrollmentId: 'ins-9', placing: 1 }, juiz));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('ATLETA_FORA_DA_BATERIA');
  });

  it('grava a nota SEMPRE em nome de quem está autenticado', async () => {
    // Ponto central: o judgeUserId vem do token, nunca do corpo. Mesmo que o
    // cliente tente assinar como outro juiz, é o ator que é gravado.
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta());
    prismaMock.enrollment.findUnique.mockResolvedValue({ id: 'ins-1', eventCategoryId: 'cat-1', status: 'APROVADA' });
    repoMock.registrarNota.mockResolvedValue({ id: 'nota-1' });

    await service.registrarNota(
      'bat-1',
      { enrollmentId: 'ins-1', placing: 2, judgeUserId: outroJuiz.id },
      juiz
    );

    expect(repoMock.registrarNota).toHaveBeenCalledWith(
      expect.objectContaining({ judgeUserId: 'juiz-1', enrollmentId: 'ins-1', placing: 2 })
    );
  });

  it('propaga a chave de idempotência do cliente', async () => {
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta());
    prismaMock.enrollment.findUnique.mockResolvedValue({ id: 'ins-1', eventCategoryId: 'cat-1', status: 'APROVADA' });
    repoMock.registrarNota.mockResolvedValue({ id: 'nota-1' });

    await service.registrarNota('bat-1', { enrollmentId: 'ins-1', placing: 1, clientRef: 'tablet-a-42' }, juiz);

    expect(repoMock.registrarNota).toHaveBeenCalledWith(expect.objectContaining({ clientRef: 'tablet-a-42' }));
  });

  it('juiz de fora do painel não lê as notas da bateria', async () => {
    repoMock.buscarSessao.mockResolvedValue(sessaoAberta());

    const erro = await capturar(service.minhasNotas('bat-1', { id: 'juiz-9', role: 'JUIZ' }));

    expect(erro.status).toBe(403);
  });
});

describe('apuração', () => {
  const sessaoParaApuracao = (scores, extras = {}) => ({
    id: 'bat-1',
    eventCategoryId: 'cat-1',
    scoringRule: null,
    panel: {
      headJudgeId: null,
      members: [{ judgeUserId: 'j1' }, { judgeUserId: 'j2' }, { judgeUserId: 'j3' }]
    },
    eventCategory: {
      scoringRule: null,
      tournament: { id: 'ev-1', organizationId: 'org-1', status: 'EM_JULGAMENTO' },
      enrollments: [
        { id: 'ins-a', athleteId: 'atl-a', status: 'APROVADA' },
        { id: 'ins-b', athleteId: 'atl-b', status: 'APROVADA' }
      ]
    },
    scores,
    ...extras
  });

  // Cada juiz ordena os dois atletas; a soma decide.
  const notasCompletas = [
    { judgeUserId: 'j1', enrollmentId: 'ins-a', placing: 1 },
    { judgeUserId: 'j1', enrollmentId: 'ins-b', placing: 2 },
    { judgeUserId: 'j2', enrollmentId: 'ins-a', placing: 1 },
    { judgeUserId: 'j2', enrollmentId: 'ins-b', placing: 2 },
    { judgeUserId: 'j3', enrollmentId: 'ins-a', placing: 2 },
    { judgeUserId: 'j3', enrollmentId: 'ins-b', placing: 1 }
  ];

  it('recusa quem não tem permissão de revisar resultado', async () => {
    const erro = await capturar(service.apurar('bat-1', juiz));

    expect(erro.status).toBe(403);
    expect(erro.details.permissaoExigida).toBe('results.review');
    // Nem chegou a consultar o banco.
    expect(repoMock.carregarSessaoParaApuracao).not.toHaveBeenCalled();
  });

  it('recusa apurar categoria sem inscrição apta', async () => {
    const sessao = sessaoParaApuracao([]);
    sessao.eventCategory.enrollments = [];
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessao);

    const erro = await capturar(service.apurar('bat-1', diretor));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('CATEGORIA_SEM_ATLETA');
  });

  it('recusa inscrição sem atleta vinculado', async () => {
    const sessao = sessaoParaApuracao(notasCompletas);
    sessao.eventCategory.enrollments = [{ id: 'ins-a', athleteId: null, status: 'APROVADA' }];
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessao);

    const erro = await capturar(service.apurar('bat-1', diretor));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('INSCRICAO_SEM_ATLETA');
  });

  it('recusa bateria com painel incompleto, sem gravar nada', async () => {
    // Um juiz não pontuou: o motor recusa e o banco não é tocado.
    const incompletas = notasCompletas.filter(n => n.judgeUserId !== 'j3');
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessaoParaApuracao(incompletas));

    const erro = await capturar(service.apurar('bat-1', diretor));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('BATERIA_INVALIDA');
    expect(erro.details.problemas.join(' ')).toMatch(/não pontuou/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('apura, grava as colocações e devolve a assinatura', async () => {
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessaoParaApuracao(notasCompletas));

    const tx = {
      competitionResult: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'res-1', status: 'EM_REVISAO' }),
        update: vi.fn()
      },
      athletePlacement: { deleteMany: vi.fn(), createMany: vi.fn().mockResolvedValue({ count: 2 }) }
    };
    comTransacao(tx);

    const saida = await service.apurar('bat-1', diretor);

    // ins-a soma 1+1+2=4; ins-b soma 2+2+1=5.
    expect(saida.colocacoes.map(c => c.atletaId)).toEqual(['ins-a', 'ins-b']);
    expect(saida.apuravel).toBe(true);
    expect(saida.empatesNaoResolvidos).toEqual([]);

    const gravadas = tx.athletePlacement.createMany.mock.calls[0][0].data;
    expect(gravadas).toHaveLength(2);
    // A colocação carrega o atleta, não só a inscrição.
    expect(gravadas[0]).toMatchObject({ enrollmentId: 'ins-a', athleteId: 'atl-a', placing: 1, score: 4 });

    // Assinatura de determinismo registrada na auditoria.
    expect(auditMock.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESULT_CALCULATE' })
    );
  });

  it('marca resultado como RASCUNHO quando sobra empate não resolvido', async () => {
    // Painel par e espelhado: empate perfeito, sem juiz principal.
    const empate = [
      { judgeUserId: 'j1', enrollmentId: 'ins-a', placing: 1 },
      { judgeUserId: 'j1', enrollmentId: 'ins-b', placing: 2 },
      { judgeUserId: 'j2', enrollmentId: 'ins-a', placing: 2 },
      { judgeUserId: 'j2', enrollmentId: 'ins-b', placing: 1 }
    ];
    const sessao = sessaoParaApuracao(empate);
    sessao.panel.members = [{ judgeUserId: 'j1' }, { judgeUserId: 'j2' }];
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessao);

    const tx = {
      competitionResult: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'res-1', ...data })),
        update: vi.fn()
      },
      athletePlacement: { deleteMany: vi.fn(), createMany: vi.fn() }
    };
    comTransacao(tx);

    const saida = await service.apurar('bat-1', diretor);

    expect(saida.apuravel).toBe(false);
    expect(saida.empatesNaoResolvidos).toHaveLength(1);
    // O resultado NÃO avança para revisão: empate pendente não é pódio.
    expect(tx.competitionResult.create.mock.calls[0][0].data.status).toBe('RASCUNHO');
  });

  it('recusa recalcular por cima de resultado já publicado', async () => {
    repoMock.carregarSessaoParaApuracao.mockResolvedValue(sessaoParaApuracao(notasCompletas));

    comTransacao({
      competitionResult: {
        findFirst: vi.fn().mockResolvedValue({ id: 'res-1', status: 'PUBLICADO', version: 1 }),
        create: vi.fn(),
        update: vi.fn()
      },
      athletePlacement: { deleteMany: vi.fn(), createMany: vi.fn() }
    });

    const erro = await capturar(service.apurar('bat-1', diretor));

    expect(erro.status).toBe(409);
    expect(erro.code).toBe('RESULTADO_PUBLICADO');
  });
});

describe('publicação de resultado', () => {
  it('recusa publicar pódio com empate pendente', async () => {
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-1', status: 'APROVADO', version: 1, signature: 'abc',
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });

    comTransacao({
      athletePlacement: {
        findMany: vi.fn().mockResolvedValue([
          { athleteId: 'atl-a', placing: 1, score: 4, fullScore: 4, tied: true, athlete: { fullName: 'A' } },
          { athleteId: 'atl-b', placing: 1, score: 4, fullScore: 4, tied: true, athlete: { fullName: 'B' } }
        ])
      },
      competitionResult: { update: vi.fn() },
      season: { findFirst: vi.fn() },
      rankingPoint: { upsert: vi.fn() }
    });

    const erro = await capturar(service.publicar('res-1', diretor));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('EMPATE_PENDENTE');
  });

  it('recusa publicar resultado sem colocações', async () => {
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-1', status: 'APROVADO', version: 1,
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });
    comTransacao({
      athletePlacement: { findMany: vi.fn().mockResolvedValue([]) },
      competitionResult: { update: vi.fn() },
      season: { findFirst: vi.fn() },
      rankingPoint: { upsert: vi.fn() }
    });

    const erro = await capturar(service.publicar('res-1', diretor));

    expect(erro.code).toBe('RESULTADO_VAZIO');
  });

  it('recusa publicar resultado que não passou por aprovação', async () => {
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-1', status: 'EM_REVISAO', version: 1,
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });

    const erro = await capturar(service.publicar('res-1', diretor));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('TRANSICAO_INVALIDA');
  });

  it('congela o snapshot e lança os pontos da temporada', async () => {
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-1', status: 'APROVADO', version: 1, signature: 'assinatura-abc',
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });

    const tx = {
      athletePlacement: {
        findMany: vi.fn().mockResolvedValue([
          { athleteId: 'atl-a', placing: 1, score: 4, fullScore: 4, tied: false, athlete: { id: 'atl-a', fullName: 'Ana', slug: 'ana' } },
          { athleteId: 'atl-b', placing: 2, score: 5, fullScore: 5, tied: false, athlete: { id: 'atl-b', fullName: 'Bruna', slug: 'bruna' } }
        ])
      },
      competitionResult: { update: vi.fn().mockResolvedValue({ id: 'res-1', status: 'PUBLICADO' }) },
      season: { findFirst: vi.fn().mockResolvedValue({ id: 'temp-1', pointsTable: { 1: 100, 2: 80 } }) },
      rankingPoint: { upsert: vi.fn().mockResolvedValue({}) }
    };
    comTransacao(tx);

    await service.publicar('res-1', diretor);

    const gravado = tx.competitionResult.update.mock.calls[0][0].data;
    expect(gravado.status).toBe('PUBLICADO');
    expect(gravado.snapshot.assinatura).toBe('assinatura-abc');
    expect(gravado.snapshot.colocacoes).toHaveLength(2);
    expect(gravado.snapshot.colocacoes[0]).toMatchObject({ posicao: 1, atleta: 'Ana' });

    // Pontos idempotentes por (temporada, atleta, resultado).
    expect(tx.rankingPoint.upsert).toHaveBeenCalledTimes(2);
    expect(tx.rankingPoint.upsert.mock.calls[0][0].create).toMatchObject({ points: 100, placing: 1 });
  });

  it('NÃO inventa pontuação quando a temporada não tem tabela de pontos', async () => {
    // Seção 72: sem regra definida, não se inventa regra. O ranking apenas não
    // recebe lançamento — e a publicação segue válida.
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-1', status: 'APROVADO', version: 1, signature: 'x',
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });

    const tx = {
      athletePlacement: {
        findMany: vi.fn().mockResolvedValue([
          { athleteId: 'atl-a', placing: 1, score: 4, fullScore: 4, tied: false, athlete: { fullName: 'Ana' } }
        ])
      },
      competitionResult: { update: vi.fn().mockResolvedValue({ id: 'res-1' }) },
      season: { findFirst: vi.fn().mockResolvedValue({ id: 'temp-1', pointsTable: null }) },
      rankingPoint: { upsert: vi.fn() }
    };
    comTransacao(tx);

    await service.publicar('res-1', diretor);

    expect(tx.rankingPoint.upsert).not.toHaveBeenCalled();
  });
});

describe('transição de estado do resultado', () => {
  const publicado = {
    id: 'res-1', status: 'PUBLICADO', version: 3,
    eventCategory: { tournament: { organizationId: 'org-1' } }
  };

  it('recusa reabrir resultado publicado sem permissão especial', async () => {
    repoMock.buscarResultado.mockResolvedValue(publicado);

    for (const papel of [diretor, { id: 'p', role: 'PROMOTOR' }, { id: 'c', role: 'COORDENADOR_JURI' }]) {
      const erro = await capturar(service.transitar('res-1', 'EM_REVISAO', papel, { motivo: 'erro de digitação na súmula' }));
      expect(erro.status).toBe(403);
      expect(erro.code).toBe('TRANSICAO_PRIVILEGIADA');
    }
    expect(repoMock.atualizarStatusResultado).not.toHaveBeenCalled();
  });

  it('exige motivo registrado na reabertura', async () => {
    repoMock.buscarResultado.mockResolvedValue(publicado);

    const erro = await capturar(service.transitar('res-1', 'EM_REVISAO', superAdmin));

    expect(erro.status).toBe(422);
    expect(erro.code).toBe('MOTIVO_OBRIGATORIO');
    expect(repoMock.atualizarStatusResultado).not.toHaveBeenCalled();
  });

  it('reabre com SUPER_ADMIN, grava o motivo, avança a versão e audita como override', async () => {
    repoMock.buscarResultado.mockResolvedValue(publicado);
    repoMock.atualizarStatusResultado.mockResolvedValue({ id: 'res-1', status: 'EM_REVISAO', version: 4 });

    await service.transitar('res-1', 'EM_REVISAO', superAdmin, { motivo: 'nota do juiz 2 lançada trocada' });

    const dados = repoMock.atualizarStatusResultado.mock.calls[0][1];
    expect(dados.status).toBe('EM_REVISAO');
    expect(dados.overrideReason).toBe('nota do juiz 2 lançada trocada');
    // Versão nova: a publicada anterior continua identificável.
    expect(dados.version).toBe(4);

    expect(auditMock.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESULT_OVERRIDE' })
    );
  });

  it('transição comum não exige motivo nem vira override', async () => {
    repoMock.buscarResultado.mockResolvedValue({
      id: 'res-2', status: 'EM_REVISAO', version: 1,
      eventCategory: { tournament: { organizationId: 'org-1' } }
    });
    repoMock.atualizarStatusResultado.mockResolvedValue({ id: 'res-2', status: 'APROVADO' });

    await service.transitar('res-2', 'APROVADO', diretor);

    const dados = repoMock.atualizarStatusResultado.mock.calls[0][1];
    expect(dados.approvedByUserId).toBe(diretor.id);
    expect(dados.overrideReason).toBeUndefined();
    expect(auditMock.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESULT_APROVADO' }));
  });
});

describe('consulta de resultado', () => {
  it('esconde resultado não publicado do público, como inexistente', async () => {
    // 404 e não 403: responder "existe mas você não pode ver" já entrega que há
    // um resultado apurado antes da divulgação oficial.
    repoMock.resultadoDaCategoria.mockResolvedValue({ id: 'res-1', status: 'EM_REVISAO' });

    const erro = await capturar(service.consultarPorCategoria('cat-1', null));

    expect(erro.status).toBe(404);
  });

  it('esconde resultado não publicado de quem não revisa', async () => {
    repoMock.resultadoDaCategoria.mockResolvedValue({ id: 'res-1', status: 'EM_REVISAO' });

    const erro = await capturar(service.consultarPorCategoria('cat-1', atleta));

    expect(erro.status).toBe(404);
  });

  it('mostra resultado publicado para o público', async () => {
    repoMock.resultadoDaCategoria.mockResolvedValue({ id: 'res-1', status: 'PUBLICADO' });

    const saida = await service.consultarPorCategoria('cat-1', null);

    expect(saida.id).toBe('res-1');
  });

  it('mostra resultado em revisão para quem revisa', async () => {
    repoMock.resultadoDaCategoria.mockResolvedValue({ id: 'res-1', status: 'EM_REVISAO' });

    const saida = await service.consultarPorCategoria('cat-1', diretor);

    expect(saida.id).toBe('res-1');
  });
});

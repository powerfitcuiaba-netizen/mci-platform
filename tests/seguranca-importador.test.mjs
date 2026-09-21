import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// O BOTÃO QUE PUBLICA RANKING É O ALVO MAIS VALIOSO DA PLATAFORMA.
//
// Quem conseguir aplicar um lote decide quem pontua num campeonato nacional.
// Não existe correção posterior barata para isso: o ponto entra no ledger, o
// ranking público muda, e a federação já comunicou o resultado.
//
// Este arquivo ATACA. Cada teste é uma tentativa de fazer o sistema publicar,
// ler ou alterar algo que o autor não deveria alcançar. Nenhum confia no
// frontend: todos batem direto na API.
// ==========================================================================

let orgA, orgB;
let adminA, operadorA, revisorA, atletaA, semPapelA, operadorLimitado;
let operadorB;
let seasonA, seasonB;
let loteA, loteB, itemA, itemB, athleteA, athleteB;

const CLASSE = "Men's Bodybuilding - Novice";
const csv = linhas => ['Athlete #,Class,First Name,Last Name,Member Number,Placing', ...linhas].join('\n');
const linha = (matricula, nome, colocacao = 1, n = 1) =>
  `${n},${CLASSE},${nome},Sobrenome,${matricula},${colocacao}`;

const criarLote = (org, season, operador, conteudo, extras = {}) =>
  api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: 'QA', defaultAffiliationCode: 'NPC', ...extras
  });

async function montarOrganizacao(nome, semente) {
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: `Admin ${nome}` });
  const org = await criarOrganizacao(admin, { name: nome });
  const operador = await criarUsuario({ name: `Operador ${nome}` });
  await vincular(org.id, operador, 'RANKING_MANAGER');
  await vincular(org.id, operador, 'REGISTRATION_OPERATOR');

  const filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org.id, name: 'NPC', code: 'NPC' })).body;

  const season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  const athlete = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org.id, fullName: `ATLETA ${nome}`, sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: org.id, cpf: gerarCpf(semente) } }
    }
  }));

  return { admin, org, operador, filiacao, season, athlete };
}

const itensDe = (importId, operador) => comoAtor(operador, tx => tx.muscleWarImportItem.findMany({
  where: { importId }, orderBy: { rowNumber: 'asc' }
}));

const totais = () => comoAtor(adminA, async tx => ({
  pontos: await tx.rankingPoint.count(),
  externos: await tx.externalResult.count()
}));

const NEGADO = [401, 403, 404];

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  const a = await montarOrganizacao('Federacao A', 801);
  adminA = a.admin; orgA = a.org.id; operadorA = a.operador;
  seasonA = a.season; athleteA = a.athlete;

  const b = await montarOrganizacao('Federacao B', 802);
  orgB = b.org.id; operadorB = b.operador; seasonB = b.season; athleteB = b.athlete;

  revisorA = await criarUsuario({ name: 'Revisor A' });
  await vincular(orgA, revisorA, 'JUDGE');
  atletaA = await criarUsuario({ name: 'Atleta A' });
  await vincular(orgA, atletaA, 'ATHLETE');
  semPapelA = await criarUsuario({ name: 'Sem Papel' });

  // O PERFIL QUE SEPARA RBAC DE RLS.
  //
  // `mci_operator_of` — a política de RLS do lote — aceita
  // REGISTRATION_OPERATOR. Já `musclewar.review` e `musclewar.apply` só vêm
  // com RANKING_MANAGER. Este usuário, portanto, ATRAVESSA o RLS e tem de ser
  // barrado pela checagem de permissão, e só por ela. Sem ele na suíte,
  // remover `assertCan` do serviço não quebrava teste nenhum — o banco estava
  // segurando, e a segunda barreira passava por desnecessária.
  operadorLimitado = await criarUsuario({ name: 'Operador de Inscricoes' });
  await vincular(orgA, operadorLimitado, 'REGISTRATION_OPERATOR');

  // MATRICULA NAO CADASTRADA de proposito: o lote nasce com a linha PENDENTE,
  // que e o estado onde moram o vinculo e as transicoes que os ataques tentam
  // forcar. Usar a matricula do atleta faria o importador reconhecer na hora e
  // metade destes testes mediria outro estado.
  loteA = (await criarLote(orgA, seasonA, operadorA, csv([linha('77777', 'Atleta')]))).body.import;
  loteB = (await criarLote(orgB, seasonB, operadorB, csv([linha('77777', 'Atleta')]))).body.import;
  [itemA] = await itensDe(loteA.id, operadorA);
  [itemB] = await itensDe(loteB.id, operadorB);
});

describe('§2 RBAC — cada porta exige o seu papel', () => {
  it('anônimo não alcança nenhuma porta do importador', async () => {
    for (const r of await Promise.all([
      api().get('/api/v1/musclewar/imports'),
      api().get(`/api/v1/musclewar/imports/${loteA.id}`),
      api().post('/api/v1/musclewar/imports').send({ organizationId: orgA, sourceType: 'CSV', sourceRef: 'x.csv', content: 'a,b\n1,2' }),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).send({}),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/reject`).send({ reason: 'ataque' }),
      api().post(`/api/v1/musclewar/items/${itemA.id}/link`).send({ athleteId: athleteA.id })
    ])) expect(NEGADO).toContain(r.status);
  });

  it('atleta comum não cria, não revisa, não aplica e não rejeita', async () => {
    for (const r of await Promise.all([
      api().post('/api/v1/musclewar/imports').set(atletaA.auth())
        .send({ organizationId: orgA, sourceType: 'CSV', sourceRef: 'x.csv', content: csv([linha('88281', 'X')]) }),
      api().get(`/api/v1/musclewar/imports/${loteA.id}`).set(atletaA.auth()),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(atletaA.auth()).send({}),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/reject`).set(atletaA.auth()).send({ reason: 'motivo do ataque' }),
      api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(atletaA.auth()).send({ athleteId: athleteA.id })
    ])) expect(NEGADO).toContain(r.status);
  });

  it('membro com papel sem relação (JUDGE) não aplica nem revisa importação', async () => {
    for (const r of await Promise.all([
      api().get(`/api/v1/musclewar/imports/${loteA.id}`).set(revisorA.auth()),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(revisorA.auth()).send({}),
      api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(revisorA.auth()).send({ athleteId: athleteA.id })
    ])) expect(NEGADO).toContain(r.status);
  });

  it('usuário autenticado sem vínculo nenhum não alcança nada', async () => {
    for (const r of await Promise.all([
      api().get(`/api/v1/musclewar/imports/${loteA.id}`).set(semPapelA.auth()),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(semPapelA.auth()).send({})
    ])) expect(NEGADO).toContain(r.status);
  });

  it('o operador autorizado consegue — senão o teste acima não provaria nada', async () => {
    expect((await api().get(`/api/v1/musclewar/imports/${loteA.id}`).set(operadorA.auth())).status).toBe(200);
  });

  it('operador de INSCRIÇÕES atravessa o RLS e mesmo assim não revisa, não aplica e não vincula', async () => {
    // Este é o teste que prova que a checagem de permissão faz trabalho
    // próprio: o RLS deixa este usuário ver o lote, e quem o barra é o RBAC.
    for (const r of await Promise.all([
      api().get(`/api/v1/musclewar/imports/${loteA.id}`).set(operadorLimitado.auth()),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorLimitado.auth()).send({}),
      api().post(`/api/v1/musclewar/imports/${loteA.id}/reject`).set(operadorLimitado.auth()).send({ reason: 'motivo do ataque' }),
      api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorLimitado.auth()).send({ athleteId: athleteA.id })
    ])) expect(NEGADO).toContain(r.status);

    expect((await itensDe(loteA.id, operadorA))[0].matchStatus).toBe('MATCH_PENDING');
  });

  it('nem o administrador da plataforma vincula atleta de OUTRA organização', async () => {
    // O SUPER_ADMIN atravessa o RLS das duas organizações. A única coisa entre
    // ele e um vínculo cruzado é a conferência explícita de organização.
    const r = await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(adminA.auth())
      .send({ athleteId: athleteB.id });
    expect([403, 404, 422]).toContain(r.status);
    expect((await itensDe(loteA.id, operadorA))[0].athleteId).toBeNull();
  });
});

describe('§3–§5 cross-tenant e IDOR — o id do cliente não é autoridade', () => {
  it('operador de A não lê o lote de B', async () => {
    const r = await api().get(`/api/v1/musclewar/imports/${loteB.id}`).set(operadorA.auth());
    expect(NEGADO).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/Federacao B/);
  });

  it('operador de A não aplica nem rejeita o lote de B', async () => {
    for (const r of await Promise.all([
      api().post(`/api/v1/musclewar/imports/${loteB.id}/apply`).set(operadorA.auth()).send({}),
      api().post(`/api/v1/musclewar/imports/${loteB.id}/reject`).set(operadorA.auth()).send({ reason: 'motivo do ataque' })
    ])) expect(NEGADO).toContain(r.status);
    expect((await totais()).pontos).toBe(0);
  });

  it('operador de A não vincula item de B', async () => {
    const r = await api().post(`/api/v1/musclewar/items/${itemB.id}/link`).set(operadorA.auth())
      .send({ athleteId: athleteA.id });
    expect(NEGADO).toContain(r.status);
    expect((await itensDe(loteB.id, operadorB))[0].athleteId).toBeNull();
  });

  it('operador de A não vincula ATLETA de B a um item de A', async () => {
    const r = await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth())
      .send({ athleteId: athleteB.id });
    expect(NEGADO).toContain(r.status);
    expect((await itensDe(loteA.id, operadorA))[0].athleteId).toBeNull();
  });

  it('a listagem de lotes não mistura organizações', async () => {
    const r = await api().get('/api/v1/musclewar/imports').query({ organizationId: orgA }).set(operadorA.auth());
    expect(r.status).toBe(200);
    for (const lote of r.body.items ?? []) expect(lote.organizationId).toBe(orgA);
  });

  it('pedir a listagem da organização B com token de A não devolve nada de B', async () => {
    const r = await api().get('/api/v1/musclewar/imports').query({ organizationId: orgB }).set(operadorA.auth());
    if (r.status === 200) {
      for (const lote of r.body.items ?? []) expect(lote.organizationId).not.toBe(orgB);
    } else {
      expect(NEGADO).toContain(r.status);
    }
  });
});

describe('§5 organizationId — o cliente não escolhe o alvo', () => {
  it('operador de A não cria lote declarando a organização B', async () => {
    expect(NEGADO).toContain((await criarLote(orgB, seasonB, operadorA, csv([linha('88281', 'Invasor')]))).status);
  });

  it('organização inexistente não cria lote', async () => {
    const r = await criarLote('clzzzzzzzzzzzzzzzzzzzzzzz', seasonA, operadorA, csv([linha('88281', 'X')]));
    expect([400, 403, 404, 422]).toContain(r.status);
  });

  it('temporada de outra organização não faz o lote sair da organização de origem', async () => {
    const r = await criarLote(orgA, seasonB, operadorA, csv([linha('88281', 'X')]));
    if (r.status === 201) {
      const lote = await comoAtor(operadorA, tx => tx.muscleWarImport.findUnique({ where: { id: r.body.import.id } }));
      expect(lote.organizationId).toBe(orgA);
    } else {
      expect([400, 403, 404, 422]).toContain(r.status);
    }
  });
});

describe('§7 importId — estados que não podem publicar', () => {
  it('lote inexistente não aplica', async () => {
    const r = await api().post('/api/v1/musclewar/imports/clzzzzzzzzzzzzzzzzzzzzzzz/apply').set(operadorA.auth()).send({});
    expect([403, 404]).toContain(r.status);
  });

  // ESTE TESTE MUDOU DE REGRA, e o nome mudou junto.
  //
  // Chamava-se "lote sem linha reconhecida não aplica", e trancava a regra de
  // um sistema que já tinha cadastro de atletas. O MCI é novo e não tem: o
  // histórico oficial dos campeonatos antigos entra ANTES de as pessoas se
  // cadastrarem, e uma linha pendente de vínculo deixou de ser inaplicável.
  //
  // O que precisa continuar trancado, e é o que ele tranca agora, é o outro
  // lado: aplicar NÃO pode virar uma porta que aceita qualquer coisa. Conflito
  // e rejeitado continuam fora, e um lote SÓ com eles continua recusado.
  it('pendente de vínculo aplica; conflito e rejeitado continuam fora', async () => {
    const atletasAntes = await prisma.athlete.count();

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`)
      .set(operadorA.auth()).send({});
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
    expect(aplicacao.body.applied).toBe(1);

    // Entrou no histórico SEM dono, e sem fabricar dono.
    expect(await prisma.athlete.count()).toBe(atletasAntes);
    const depois = await totais();
    expect(depois.pontos).toBe(1);
    expect(depois.externos).toBe(1);

    const semDono = await comoAtor(adminA, tx => tx.rankingPoint.findMany({ where: { athleteId: null } }));
    expect(semDono).toHaveLength(1);
    expect(semDono[0].externalAthleteId).not.toBeNull();
    expect(semDono[0].organizationId).toBe(orgA);
  });

  it('lote sem NENHUMA linha aplicável continua recusado', async () => {
    // Linha sem identificador externo: rejeitada na análise, e rejeitada
    // continua. "Pendente entra" não é "tudo entra".
    const soRuim = (await criarLote(orgA, seasonA, operadorA,
      csv([linha('', 'Sem Identificador')]))).body.import;

    const resposta = await api().post(`/api/v1/musclewar/imports/${soRuim.id}/apply`)
      .set(operadorA.auth()).send({});
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('NOTHING_TO_APPLY');
    expect((await totais()).pontos).toBe(0);
  });

  it('lote rejeitado não aplica depois', async () => {
    expect((await api().post(`/api/v1/musclewar/imports/${loteA.id}/reject`).set(operadorA.auth())
      .send({ reason: 'arquivo errado' })).status).toBe(200);
    const r = await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({});
    expect(r.status).toBe(422);
    // O MOTIVO importa: "rejeitado" e "nada a aplicar" são os dois 422, e
    // conferir só o número deixaria passar a remoção da guarda de rejeição.
    expect(r.body.error.code).toBe('IMPORT_REJECTED');
    expect((await totais()).pontos).toBe(0);
  });

  it('lote aplicado não pode ser rejeitado para apagar o rastro', async () => {
    await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
    expect((await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({})).status).toBe(200);
    expect((await api().post(`/api/v1/musclewar/imports/${loteA.id}/reject`).set(operadorA.auth())
      .send({ reason: 'sumir' })).status).toBe(422);
  });
});

describe('§8 §22 — o cliente não muda o estado por payload', () => {
  it('campos de decisão enviados no corpo da criação são ignorados', async () => {
    const r = await api().post('/api/v1/musclewar/imports').set(operadorA.auth()).send({
      organizationId: orgA, seasonId: seasonA, sourceType: 'CSV',
      sourceRef: unico('x') + '.csv', content: csv([linha('99999', 'Desconhecido')]),
      externalIdPrefix: 'QA', defaultAffiliationCode: 'NPC',
      status: 'APPLIED', matchedCount: 999, appliedCount: 999, version: 99
    });
    expect([201, 400, 422]).toContain(r.status);
    if (r.status !== 201) return;
    const lote = await comoAtor(operadorA, tx => tx.muscleWarImport.findUnique({ where: { id: r.body.import.id } }));
    expect(lote.status).not.toBe('APPLIED');
    expect(lote.appliedCount).toBe(0);
  });

  it('PENDING não vira MATCHED sem vínculo autorizado', async () => {
    expect((await itensDe(loteA.id, operadorA))[0].matchStatus).toBe('MATCH_PENDING');
    const r = await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(atletaA.auth()).send({ athleteId: athleteA.id });
    expect(NEGADO).toContain(r.status);
    expect((await itensDe(loteA.id, operadorA))[0].matchStatus).toBe('MATCH_PENDING');
  });

  it('vincular a um atleta inexistente não reconhece a linha', async () => {
    const r = await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth())
      .send({ athleteId: 'clzzzzzzzzzzzzzzzzzzzzzzz' });
    expect([400, 403, 404, 422]).toContain(r.status);
    expect((await itensDe(loteA.id, operadorA))[0].matchStatus).toBe('MATCH_PENDING');
  });

  it('item já aplicado não aceita novo vínculo', async () => {
    await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({});
    const r = await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
    expect([403, 422]).toContain(r.status);
  });
});

describe('§9–§11 — a pontuação não vem do arquivo', () => {
  const aplicarComoA = async conteudo => {
    const lote = (await criarLote(orgA, seasonA, operadorA, conteudo)).body.import;
    const [item] = await itensDe(lote.id, operadorA);
    await api().post(`/api/v1/musclewar/items/${item.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
    return api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operadorA.auth()).send({});
  };
  const pontos = () => comoAtor(operadorA, tx => tx.rankingPoint.findMany({
    select: { points: true, placementPoints: true, overallBonus: true, placing: true, didNotShow: true }
  }));

  it('coluna de pontos absurda no arquivo não vira pontuação', async () => {
    const resposta = await aplicarComoA([
      'Athlete #,Class,First Name,Last Name,Member Number,Placing,pontos',
      `1,${CLASSE},Atleta,Sobrenome,88281,1,999`
    ].join('\n'));
    expect(resposta.status).toBeLessThan(500);
    for (const p of await pontos()) expect(p.points).toBeLessThanOrEqual(5);
  });

  it('pontuação negativa no arquivo não entra no ledger', async () => {
    await aplicarComoA([
      'Athlete #,Class,First Name,Last Name,Member Number,Placing,pontos',
      `1,${CLASSE},Atleta,Sobrenome,88281,1,-100`
    ].join('\n'));
    for (const p of await pontos()) expect(p.points).toBeGreaterThanOrEqual(0);
  });

  it('Overall declarado numa NOVICE não vale bônus', async () => {
    await aplicarComoA([
      'Athlete #,Class,First Name,Last Name,Member Number,Placing,overall',
      `1,${CLASSE},Atleta,Sobrenome,88281,1,SIM`
    ].join('\n'));
    for (const p of await pontos()) {
      expect(p.overallBonus).toBe(0);
      expect(p.points).toBe(p.placementPoints);
      expect(p.points).toBeLessThanOrEqual(5);
    }
  });

  it('NS não vira colocação nem pontuação, venha o que vier no arquivo', async () => {
    await aplicarComoA([
      'Athlete #,Class,First Name,Last Name,Member Number,Placing,pontos,overall',
      `1,${CLASSE},Atleta,Sobrenome,88281,NS,5,SIM`
    ].join('\n'));
    for (const p of await pontos()) {
      expect(p.points).toBe(0);
      expect(p.placing).toBeNull();
      expect(p.overallBonus).toBe(0);
    }
  });
});

describe('§12–§13 §26 — repetir não duplica', () => {
  beforeEach(async () => {
    await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
  });

  it('dez aplicações sequenciais do mesmo lote produzem uma pontuação só', async () => {
    expect((await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({})).status).toBe(200);
    const depoisDaPrimeira = await totais();
    expect(depoisDaPrimeira.pontos).toBe(1);

    for (let i = 0; i < 9; i += 1) {
      await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({});
    }
    expect(await totais()).toEqual(depoisDaPrimeira);
  }, 60_000);

  it('vinte aplicações SIMULTÂNEAS produzem uma pontuação só', async () => {
    const respostas = await Promise.all(Array.from({ length: 20 }, () =>
      api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({})));
    for (const r of respostas) expect(r.status).toBeLessThan(500);

    const finais = await totais();
    expect(finais.pontos).toBe(1);
    expect(finais.externos).toBe(1);
  }, 60_000);

  it('reenviar o MESMO arquivo como novo lote não pontua de novo', async () => {
    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({});
    const antes = await totais();

    const repetido = (await criarLote(orgA, seasonA, operadorA, csv([linha('77777', 'Atleta')]))).body;
    expect(repetido.summary.duplicates).toBe(1);
    expect(repetido.summary.recognized).toBe(0);
    expect(await totais()).toEqual(antes);
  });
});

describe('§14–§15 §18 — conteúdo hostil é texto, nunca comando', () => {
  const guardar = async valor => {
    const r = await criarLote(orgA, seasonA, operadorA, [
      'Athlete #,Class,First Name,Last Name,Member Number,Placing',
      `1,${CLASSE},${valor},Sobrenome,88281,1`
    ].join('\n'));
    expect(r.status).toBe(201);
    return (await itensDe(r.body.import.id, operadorA))[0];
  };

  it('fórmula de planilha é guardada como texto, sem ser avaliada', async () => {
    const item = await guardar('=1+1');
    expect(item.athleteName).toContain('=1+1');
    expect(item.athleteName).not.toBe('2');
  });

  it('os quatro prefixos de injeção de planilha sobrevivem como texto', async () => {
    for (const prefixo of ['=SUM(A1)', '+1', '-1', '@SUM(A1)']) {
      const item = await guardar(prefixo);
      expect(item.athleteName.startsWith(prefixo)).toBe(true);
    }
  });

  it('script no nome não vira marcação: fica texto íntegro', async () => {
    // Guardado inteiro de propósito. A defesa contra XSS é o React escapar na
    // exibição; sanitizar aqui destruiria o dado de origem que a revisão
    // precisa ver para decidir.
    const item = await guardar('<script>alert(1)</script>');
    expect(item.athleteName).toBe('<script>alert(1)</script> Sobrenome');
  });

  it('payload de SQL no nome não altera o banco', async () => {
    const antes = await comoAtor(operadorA, tx => tx.athlete.count());
    const item = await guardar("Robert DROP TABLE Athlete --");
    expect(item.athleteName).toContain('DROP TABLE');
    expect(await comoAtor(operadorA, tx => tx.athlete.count())).toBe(antes);
  });

  it('SQL na matrícula não altera o banco nem reconhece ninguém', async () => {
    const antes = await comoAtor(operadorA, tx => tx.athlete.count());
    const r = await criarLote(orgA, seasonA, operadorA, [
      'Athlete #,Class,First Name,Last Name,Member Number,Placing',
      `1,${CLASSE},Atleta,Sobrenome,88281 OR 1=1,1`
    ].join('\n'));
    expect(r.status).toBe(201);
    expect(r.body.summary.recognized).toBe(0);
    expect(await comoAtor(operadorA, tx => tx.athlete.count())).toBe(antes);
  });

  it('SQL no id da rota não derruba nem vaza', async () => {
    for (const alvo of ["' OR 1=1 --", '1 UNION SELECT 1', '../../etc/passwd']) {
      const r = await api().get(`/api/v1/musclewar/imports/${encodeURIComponent(alvo)}`).set(operadorA.auth());
      expect(r.status).toBeLessThan(500);
      expect(NEGADO.concat([400, 422])).toContain(r.status);
    }
  });

  it('unicode e quebra de linha entre aspas não quebram a leitura', async () => {
    const r = await criarLote(orgA, seasonA, operadorA, [
      'Athlete #,Class,First Name,Last Name,Member Number,Placing',
      `1,${CLASSE},"José${String.fromCharCode(10)}Maria",Sobrenome,88281,1`
    ].join('\n'));
    expect(r.status).toBeLessThan(500);
  });
});

describe('§17 — arquivo hostil não derruba o processo', () => {
  const enviar = conteudo => api().post('/api/v1/musclewar/imports').set(operadorA.auth()).send({
    organizationId: orgA, seasonId: seasonA, sourceType: 'CSV',
    sourceRef: unico('hostil') + '.csv', content: conteudo
  });

  it('arquivo em branco é recusado com mensagem, não com 500', async () => {
    const r = await enviar(' ');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('só cabeçalho é recusado sem estourar', async () => {
    const r = await enviar('Athlete #,Class,First Name,Last Name,Member Number,Placing');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('binário renomeado como CSV é recusado sem estourar', async () => {
    const binario = String.fromCharCode(0, 1, 2) + 'PK' + String.fromCharCode(3, 4) + 'binario';
    expect((await enviar(binario)).status).toBeLessThan(500);
  });

  it('linha absurdamente longa não derruba o servidor', async () => {
    const r = await enviar([
      'Athlete #,Class,First Name,Last Name,Member Number,Placing',
      `1,${CLASSE},${'A'.repeat(50_000)},Sobrenome,88281,1`
    ].join('\n'));
    expect(r.status).toBeLessThan(500);
  }, 60_000);

  it('acima do limite de linhas é recusado dizendo o limite', async () => {
    const linhas = Array.from({ length: 20_001 }, (_, i) => linha('88281', 'A', 1, i + 1));
    const r = await enviar(csv(linhas));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(JSON.stringify(r.body)).toMatch(/20\D?000|limite/i);
  }, 180_000);
});

describe('§19 — token não eleva privilégio', () => {
  it('token inválido não passa', async () => {
    const r = await api().get(`/api/v1/musclewar/imports/${loteA.id}`).set({ Authorization: 'Bearer nao-e-um-token' });
    expect([401, 403]).toContain(r.status);
  });

  it('o papel vem do token, não do corpo da requisição', async () => {
    const r = await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(atletaA.auth())
      .send({ role: 'SUPER_ADMIN', permissions: ['musclewar.apply'], organizationId: orgA });
    expect(NEGADO).toContain(r.status);
    expect((await totais()).pontos).toBe(0);
  });
});

describe('§23 — toda ação sensível deixa rastro, sem dado pessoal', () => {
  it('vínculo e aplicação são auditados, e o metadata não carrega CPF', async () => {
    await api().post(`/api/v1/musclewar/items/${itemA.id}/link`).set(operadorA.auth()).send({ athleteId: athleteA.id });
    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operadorA.auth()).send({});

    const eventos = await comoAtor(adminA, tx => tx.auditLog.findMany({
      where: { organizationId: orgA }, select: { action: true, userId: true, entity: true, entityId: true, metadata: true }
    }));

    // O rastro existe, e nomeia quem agiu.
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.map(e => e.action)).toContain('MUSCLEWAR_REVIEW');
    expect(eventos.some(e => /MUSCLEWAR|IMPORT/.test(e.action))).toBe(true);

    for (const e of eventos) {
      expect(e.userId).toBeTruthy();
      expect(e.entity).toBeTruthy();
      // Nenhum CPF de 11 dígitos escapou para o metadata.
      expect(JSON.stringify(e.metadata ?? {})).not.toMatch(/\b\d{11}\b/);
    }
  });
});

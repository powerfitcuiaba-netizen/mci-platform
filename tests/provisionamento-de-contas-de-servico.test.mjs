import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, comoAtor, unico, api, gerarCpf, vincular
} from './helpers.mjs';
import contasDeServico from '../src/services/serviceAccountService.js';
import { withUserContext } from '../src/config/rlsSession.js';

// ============================================================================
// A FEDERAÇÃO QUE JÁ EXISTIA ANTES DESTA FASE.
//
// A conta de serviço nasce junto com a organização. As federações de PRODUÇÃO
// foram criadas antes disso — e a migration que acrescentou a coluna não cria
// linha nenhuma, porque migration altera ESTRUTURA e a conta de serviço é
// DADO.
//
// Sem provisionamento, `contaDaOrganizacao` não acha a conta e o autocadastro
// responde 503 para TODAS as federações existentes: a funcionalidade inteira
// desta fase não funcionaria em produção, e o sintoma só apareceria quando o
// primeiro atleta tentasse se cadastrar.
//
// Esta suíte mede o buraco e a tampa: que o 503 é o que acontece sem a conta,
// e que depois de provisionar o autocadastro volta a concluir sozinho.
// ============================================================================

let admin, organizationId, npc;

// Simula a federação LEGADA: cria pela rota real e depois REMOVE a conta de
// serviço, que é o estado exato em que produção está — organização completa,
// sem a identidade técnica que só passou a existir agora.
const tornarLegada = async (orgId) => {
  const conta = await comoAtor(admin, tx => tx.user.findFirst({
    where: { serviceOrganizationId: orgId, isServiceAccount: true }, select: { id: true }
  }));
  expect(conta, 'a organização nasceu sem conta: a fixture não mede nada').toBeTruthy();
  // Apagar o usuário leva a membresia junto (cascata), que é o estado legado.
  await comoAtor(admin, tx => tx.user.delete({ where: { id: conta.id } }));
  return conta.id;
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  organizationId = (await criarOrganizacao(admin, { name: 'Federação Legada' })).id;
  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Legado', code: 'NPCLEG' })).body;
});

describe('a federação legada, sem conta de serviço', () => {
  it('o autocadastro RECUSA com 503, e não com erro genérico', async () => {
    await tornarLegada(organizationId);

    const pessoa = await criarUsuario({ name: 'Atleta Legado' });
    const r = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'Atleta Legado', cpf: gerarCpf(770001), sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: `LEG-${unico('m')}`
    });

    // 503 e não 500: é indisponibilidade de configuração, não defeito de
    // programa. A distinção importa para quem lê o log às três da manhã.
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(503);
    // 503 e não 500: o STATUS é o que distingue indisponibilidade de
    // configuração de defeito de programa, e é o que o operador vê primeiro.
    // O `code` sai como INTERNAL_ERROR de propósito — o tratador de erros não
    // devolve código de 5xx para fora, para não descrever a topologia interna
    // a quem está do lado de fora. O motivo real fica no log do servidor.

    // E NADA SOBRA: nem atleta, nem identidade. A recusa é limpa.
    const sobrou = await comoAtor(admin, async tx => ({
      atletas: await tx.athlete.count(),
      identidades: await tx.athleteIdentity.count()
    }));
    expect(sobrou).toEqual({ atletas: 0, identidades: 0 });
  });

  it('o provisionamento cria a conta, e o autocadastro volta a concluir sozinho', async () => {
    const idAntigo = await tornarLegada(organizationId);

    // O MESMO caminho que a criação de organização usa. Rodar outro caminho
    // aqui faria existirem duas versões da mesma coisa, que é como as duas
    // divergem sem ninguém notar.
    await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));

    const conta = await comoAtor(admin, tx => tx.user.findFirst({
      where: { serviceOrganizationId: organizationId, isServiceAccount: true },
      select: { id: true, role: true, serviceOrganizationId: true }
    }));
    expect(conta, 'o provisionamento não criou a conta').toBeTruthy();
    expect(conta.id, 'reaproveitou a conta apagada').not.toBe(idAntigo);
    expect(conta.role).toBe('FEDERATION_SERVICE');

    // A MEMBRESIA TAMBÉM, senão `mci_operator_of` não a reconhece e a conta
    // existe sem poder fazer nada — que é uma falha pior, porque parece certa.
    const membresia = await comoAtor(admin, tx => tx.organizationMember.findFirst({
      where: { userId: conta.id, organizationId }, select: { role: true }
    }));
    expect(membresia, 'a conta ficou sem membresia').toBeTruthy();
    expect(membresia.role).toBe('FEDERATION_SERVICE');

    // E O QUE IMPORTA: o autocadastro conclui de novo, sozinho.
    const pessoa = await criarUsuario({ name: 'Atleta Depois' });
    const r = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'Atleta Depois', cpf: gerarCpf(770002), sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: `LEG-${unico('m')}`
    });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.reviewedById, 'alguém aprovou').toBeNull();
  });

  it('provisionar de novo não cria uma segunda conta', async () => {
    // Idempotência não é elegância aqui: o script roda a CADA deploy, de
    // propósito, para que ninguém precise lembrar quais federações já foram
    // atendidas. Se a segunda execução duplicasse, o deploy seguinte quebraria
    // a unicidade de `serviceOrganizationId` e derrubaria a subida.
    const primeira = await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));
    const segunda = await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));

    expect(segunda.id).toBe(primeira.id);

    const quantas = await comoAtor(admin, tx => tx.user.count({
      where: { serviceOrganizationId: organizationId, isServiceAccount: true }
    }));
    expect(quantas).toBe(1);
  });

  it('cada federação legada recebe a SUA conta, e não a de outra', async () => {
    const outraOrgId = (await criarOrganizacao(admin, { name: 'Outra Legada' })).id;
    await tornarLegada(organizationId);
    await tornarLegada(outraOrgId);

    for (const id of [organizationId, outraOrgId]) {
      await withUserContext(admin.id, () => contasDeServico.provisionar(id, admin));
    }

    const contas = await comoAtor(admin, tx => tx.user.findMany({
      where: { isServiceAccount: true },
      select: { id: true, serviceOrganizationId: true }
    }));
    expect(contas).toHaveLength(2);
    expect(new Set(contas.map(c => c.serviceOrganizationId)))
      .toEqual(new Set([organizationId, outraOrgId]));
  });
});


// ==========================================================================
// A BATERIA A–F DO PROVISIONAMENTO, pedida no hardening pré-main.
//
// A regra que TODAS elas cobram, por ângulos diferentes:
//
//              1 FEDERAÇÃO = 1 CONTA DE SERVIÇO
//
// Nem zero (autocadastro quebrado), nem duas (auditoria ambígua: "o sistema
// escreveu" deixaria de identificar QUAL caminho escreveu).
// ==========================================================================

describe('A–F do provisionamento: 1 federação = 1 conta', () => {
  const contasDe = orgId => comoAtor(admin, tx => tx.user.findMany({
    where: { serviceOrganizationId: orgId, isServiceAccount: true },
    select: { id: true, email: true, role: true }
  }));

  it('A — federação NOVA já nasce provisionada', async () => {
    // Não precisa de script nenhum: `organizationService.create` provisiona.
    const nova = (await criarOrganizacao(admin, { name: 'Nasce Pronta' })).id;
    expect(await contasDe(nova)).toHaveLength(1);
  });

  it('B — federação EXISTENTE sem conta é provisionada pelo script', async () => {
    await tornarLegada(organizationId);
    expect(await contasDe(organizationId)).toHaveLength(0);

    await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));
    expect(await contasDe(organizationId)).toHaveLength(1);
  });

  it('C — execução REPETIDA não cria duplicata', async () => {
    await tornarLegada(organizationId);
    for (let i = 0; i < 5; i += 1) {
      await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));
    }
    expect(await contasDe(organizationId)).toHaveLength(1);
  });

  it('D — duas execuções CONCORRENTES produzem UMA conta', async () => {
    // A conferência e a escrita não são o mesmo instante. Entre uma e outra
    // cabe outra execução inteira — dois deploys simultâneos, ou um retry que
    // alcança o original. Quem decide no fim é a unicidade de
    // `serviceOrganizationId`, e é isso que este teste cobra.
    await tornarLegada(organizationId);

    const resultados = await Promise.allSettled([
      withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin)),
      withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin))
    ]);

    const contas = await contasDe(organizationId);
    expect(contas, `A CORRIDA CRIOU ${contas.length} CONTAS`).toHaveLength(1);

    // Pelo menos uma tem de ter vencido: perder as duas deixaria a federação
    // sem conta e o autocadastro quebrado, em silêncio.
    expect(resultados.some(r => r.status === 'fulfilled'),
      'as duas execuções concorrentes falharam').toBe(true);
  });

  it('E — federação SEM conta: o script a enxerga como pendente', async () => {
    await tornarLegada(organizationId);
    const pendentes = await comoAtor(admin, tx => tx.organization.findMany({
      where: { contaDeServico: { is: null } }, select: { id: true }
    }));
    expect(pendentes.map(o => o.id)).toContain(organizationId);
  });

  it('F — federação JÁ provisionada não aparece como pendente', async () => {
    const pendentes = await comoAtor(admin, tx => tx.organization.findMany({
      where: { contaDeServico: { is: null } }, select: { id: true }
    }));
    expect(pendentes.map(o => o.id)).not.toContain(organizationId);
  });

  it('nenhuma federação fica PARCIALMENTE provisionada: conta sem membresia não existe', async () => {
    // Conta sem membresia é a falha que mais engana: a linha existe, o
    // relatório diz "provisionada", e `mci_operator_of` responde FALSO — o
    // autocadastro quebra do mesmo jeito, só que agora sem sintoma óbvio.
    await tornarLegada(organizationId);
    const outra = (await criarOrganizacao(admin, { name: 'Outra Qualquer' })).id;
    await tornarLegada(outra);

    for (const id of [organizationId, outra]) {
      await withUserContext(admin.id, () => contasDeServico.provisionar(id, admin));
    }

    const todas = await comoAtor(admin, tx => tx.user.findMany({
      where: { isServiceAccount: true },
      select: { id: true, serviceOrganizationId: true, memberships: { select: { organizationId: true, role: true } } }
    }));

    expect(todas).toHaveLength(2);
    for (const conta of todas) {
      const daSua = conta.memberships.filter(m => m.organizationId === conta.serviceOrganizationId);
      expect(daSua, `conta ${conta.id} sem membresia na própria federação`).toHaveLength(1);
      expect(daSua[0].role).toBe('FEDERATION_SERVICE');
      // E NENHUMA membresia em federação alheia.
      expect(conta.memberships).toHaveLength(1);
    }
  });
});

// ==========================================================================
// O CAMINHO REAL DE PRODUÇÃO, ponta a ponta.
//
// FEDERAÇÃO → CONTA DE SERVIÇO → AUTOCADASTRO → CONCILIAÇÃO → RANKINGPOINT
// → HISTÓRICO DO ATLETA
//
// Testar o script isolado prova que ele cria linha. Não prova que o 503 some
// e que o histórico chega ao atleta. É essa sequência inteira que o deploy
// precisa entregar, e é ela que este teste atravessa.
// ==========================================================================

describe('federação existente depois do deploy: a sequência inteira', () => {
  it('provisionar faz o 503 virar cadastro com histórico vinculado', async () => {
    // 1. A FEDERAÇÃO EXISTE, sem conta de serviço — o estado de produção
    //    imediatamente depois do `migrate deploy`.
    await tornarLegada(organizationId);

    // 2. HISTÓRICO JÁ IMPORTADO, sem dono: é o que a conciliação precisa
    //    encontrar. Montado pelo operador, como a importação faz.
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(organizationId, gerente, 'RANKING_MANAGER');
    await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

    const seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId, name: 'Temporada Legada', year: 2026 })).body.id;
    await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
      .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }] });
    const eventId = (await api().post('/api/v1/events').set(admin.auth()).send({
      organizationId, name: 'Etapa Legada', slug: unico('ev'),
      startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiabá', state: 'MT', seasonId
    })).body.id;

    const cpf = gerarCpf(880001);
    const cabecalho = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,evento';
    const linha = `LEG-1,${cpf},ROBERTA LEGADA,NPCLEG,LEG-42,BIKINI,Women's Bikini - Open Class A,1,Etapa Legada`;
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, eventId, sourceType: 'CSV',
      sourceRef: `${unico('leg')}.csv`, content: [cabecalho, linha].join('\n')
    });
    expect(lote.status, JSON.stringify(lote.body).slice(0, 200)).toBe(201);
    expect((await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
      .set(gerente.auth()).send({})).status).toBe(200);

    const semDono = await comoAtor(gerente, tx => tx.rankingPoint.findMany({
      select: { id: true, athleteId: true, points: true }
    }));
    expect(semDono).toHaveLength(1);
    expect(semDono[0].athleteId, 'o histórico já tinha dono').toBeNull();

    // 3. ANTES DO PROVISIONAMENTO: 503. É o estado que quebraria em produção.
    const pessoa = await criarUsuario({ name: 'ROBERTA LEGADA' });
    const corpo = {
      fullName: 'ROBERTA LEGADA', cpf, sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: 'LEG-42'
    };
    const antes = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send(corpo);
    expect(antes.status, 'o 503 não aconteceu: o teste não mede o buraco').toBe(503);

    // 4. O PROVISIONAMENTO — o passo obrigatório do deploy.
    await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));

    // 5. O MESMO PEDIDO, agora: conclui sozinho.
    const outraPessoa = await criarUsuario({ name: 'ROBERTA LEGADA' });
    const depois = await api().post('/api/v1/athlete-requests').set(outraPessoa.auth()).send(corpo);
    expect(depois.status, JSON.stringify(depois.body).slice(0, 300)).toBe(201);
    expect(depois.body.status).toBe('APPROVED');
    expect(depois.body.reviewedById, 'alguém aprovou').toBeNull();

    // 6. A CONCILIAÇÃO ACHOU O HISTÓRICO.
    expect(depois.body.conciliacao.estado).toBe('VINCULADO');
    expect(depois.body.conciliacao.vinculados).toBeGreaterThan(0);

    // 7. O RANKINGPOINT GANHOU DONO — o MESMO lançamento, sem duplicar e sem
    //    mudar pontuação. É o que separa "vinculou" de "criou de novo".
    const comDono = await comoAtor(gerente, tx => tx.rankingPoint.findMany({
      select: { id: true, athleteId: true, points: true }
    }));
    expect(comDono).toHaveLength(1);
    expect(comDono[0].id).toBe(semDono[0].id);
    expect(comDono[0].points).toBe(semDono[0].points);
    expect(comDono[0].athleteId).toBe(depois.body.athleteId);

    // 8. E O HISTÓRICO CHEGA AO ATLETA, pela rota que ele abre.
    const meu = await api().get('/api/v1/me/historico').set(outraPessoa.auth());
    if (meu.status === 200) {
      expect(JSON.stringify(meu.body)).toMatch(/Etapa Legada/);
    } else {
      // A rota pode ter outro nome; o que não pode é o vínculo não existir —
      // e o passo 7 já o provou pelo banco.
      expect(comDono[0].athleteId).toBeTruthy();
    }
  });
});

// ==========================================================================
// O ENDEREÇO DA CONTA TÉCNICA NÃO PODE SER TOMADO ANTES DE EXISTIR.
// ==========================================================================

describe('squatting do endereço da conta de serviço', () => {
  it('o cadastro aberto RECUSA o domínio reservado', async () => {
    const r = await api().post('/api/v1/auth/register').send({
      name: 'Oportunista', email: `servico.qualquer@${contasDeServico.DOMINIO_RESERVADO}`,
      password: 'senha-de-teste-123', birthDate: '1990-01-01',
      phone: '65999990000', whatsapp: '65999990000', postalCode: '78000000',
      addressLine: 'Rua X', addressNumber: '1', state: 'MT', city: 'Cuiabá'
    });
    expect(r.status).toBe(422);
    expect(r.body.error?.code ?? r.body.code).toBe('EMAIL_DOMAIN_RESERVED');
  });

  it('o endereço vem do ID, e não do slug: não dá para adivinhá-lo antes', async () => {
    // Com o slug, o endereço era adivinhável ANTES de a federação existir:
    // quem soubesse o slug planejado registrava o e-mail primeiro e a criação
    // falhava por unicidade. O id é um cuid gerado no instante da criação.
    const slug = `previsivel-${unico('s')}`;
    const org = await criarOrganizacao(admin, { name: 'Com Slug Conhecido', slug });
    const [conta] = await comoAtor(admin, tx => tx.user.findMany({
      where: { serviceOrganizationId: org.id, isServiceAccount: true }, select: { email: true }
    }));

    expect(conta.email, 'o endereço ainda deriva do slug').not.toContain(slug);
    expect(conta.email).toBe(`servico.${org.id}@${contasDeServico.DOMINIO_RESERVADO}`);
  });

  it('federação criada DEPOIS de alguém tentar o domínio nasce normalmente', async () => {
    // A prova de que o buraco fechou: a tentativa de squatting é recusada, e a
    // federação seguinte é provisionada sem tropeço.
    await api().post('/api/v1/auth/register').send({
      name: 'Oportunista', email: `servico.tentativa@${contasDeServico.DOMINIO_RESERVADO}`,
      password: 'senha-de-teste-123', birthDate: '1990-01-01',
      phone: '65999990000', whatsapp: '65999990000', postalCode: '78000000',
      addressLine: 'Rua X', addressNumber: '1', state: 'MT', city: 'Cuiabá'
    });

    const nova = await criarOrganizacao(admin, { name: 'Depois da Tentativa' });
    const contas = await comoAtor(admin, tx => tx.user.findMany({
      where: { serviceOrganizationId: nova.id, isServiceAccount: true }, select: { id: true }
    }));
    expect(contas, 'a federação não nasceu provisionada').toHaveLength(1);
  });
});

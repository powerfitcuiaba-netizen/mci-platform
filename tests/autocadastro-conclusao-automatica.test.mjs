import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// AUTOCADASTRO DE ATLETA — CONCLUSÃO AUTOMÁTICA.
//
// ESTE ARQUIVO MUDOU DE REGRA, NÃO DE RIGOR.
//
// Ele se chamava "fila de perfil de atleta" e existia porque
// `atleta_criacao` exige `mci_operator_of(organizationId)`: quem acaba de
// criar conta não é operador, então PEDIA e um operador CONCEDIA.
//
// A barreira do banco NÃO MUDOU — e o primeiro teste daqui continua sendo
// ela. O que mudou é quem a atravessa: não mais um humano apertando
// "aprovar", e sim a CONTA DE SERVIÇO da federação, uma identidade técnica
// que só existe para isto, não autentica, não tem permissão de aplicação e
// está presa a UMA organização.
//
// O QUE ESTE ARQUIVO TRAVA, em ordem de gravidade:
//
//   1. o autocadastro continua SEM conseguir criar `Athlete` direto — se um
//      dia conseguir, a conta de serviço virou teatro e a barreira caiu;
//   2. a conclusão é automática e NINGUÉM assina: `reviewedById` é nulo, e a
//      auditoria diz `SYSTEM_SERVICE_ACCOUNT`;
//   3. operador de outra federação não alcança nem lê o pedido;
//   4. o CPF nunca aparece na listagem, e sai do pedido na conclusão — ele
//      passa a viver em `AthleteIdentity`, sob a RLS que o protege;
//   5. a conclusão é atômica: não existe atleta sem documento;
//   6. colisão de identidade — CPF ou matrícula — é recusada com mensagem
//      NEUTRA, porque quem recebe a resposta é qualquer um que preencheu o
//      formulário.
//
// SOBRE OS PEDIDOS PENDENTES "LEGADOS"
//
// Recusar e cancelar continuam existindo no serviço, e continuam precisando
// de prova — para as linhas que ainda estejam PENDING e para qualquer
// caminho futuro que volte a enfileirar. O autocadastro não produz mais
// nenhuma, então o cenário é montado inserindo a linha direto.
//
// Isso é montagem de cenário, não trapaça: o que está sob teste ali é
// `rejeitar` e `cancelar`. Fabricar estado para medir a porta da frente é
// que seria trapaça, e não acontece em lugar nenhum deste arquivo.
// ==========================================================================

let admin;
let orgA;
let operadorA;
let filiacaoA;

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999991234', whatsapp: '65988884321', postalCode: '78000000',
  addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

const cadastrarPessoa = async nome => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, token: r.body.token, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

const criarFiliacao = async (operador, organizationId, nome = 'NPC Brasil') => {
  const r = await api().post('/api/v1/affiliations').set(operador.auth())
    .send({ organizationId, name: nome, code: unico('npc').toUpperCase().slice(0, 12), kind: 'ENTITY', state: 'MT' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

const abrirAutocadastro = (organizationId, aberto = true) =>
  api().post(`/api/v1/organizations/${organizationId}/self-registration`).set(admin.auth()).send({ open: aberto });

const pedir = (pessoa, corpo) => api().post('/api/v1/athlete-requests').set(pessoa.auth()).send(corpo);

const pedidoValido = (filiacao, semente) => ({
  fullName: 'Atleta Solicitante',
  cpf: gerarCpf(semente),
  sex: 'FEMALE',
  birthDate: '1998-07-15',
  affiliationId: filiacao.id,
  affiliationNumber: `NPC-${String(semente).slice(-5)}`
});

// Ver a nota do cabeçalho: cenário montado para medir `rejeitar` e `cancelar`.
const pedidoLegado = async (pessoa, filiacao, organizationId, semente) => comoAtor(pessoa, () =>
  prisma.athleteProfileRequest.create({
    data: {
      userId: pessoa.id,
      organizationId,
      affiliationId: filiacao.id,
      affiliationNumber: `LEG-${String(semente).slice(-5)}`,
      fullName: 'Atleta Legado',
      sex: 'FEMALE',
      birthDate: new Date('1998-07-15T12:00:00.000Z'),
      cpf: gerarCpf(semente).replace(/\D/g, ''),
      status: 'PENDING'
    },
    select: { id: true, organizationId: true, userId: true }
  }));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  operadorA = await criarUsuario({ name: 'Operadora A' });
  await vincular(orgA.id, operadorA, 'EVENT_DIRECTOR');
  filiacaoA = await criarFiliacao(operadorA, orgA.id);
  await abrirAutocadastro(orgA.id);
});

describe('a barreira que a conta de serviço existe para preservar', () => {
  // Se este teste cair, a conta de serviço virou teatro: o atleta passou a
  // poder escrever direto na tabela que ela existe para escrever POR ele.
  it('quem acabou de se cadastrar NÃO cria atleta direto', async () => {
    const pessoa = await cadastrarPessoa('Pessoa Comum');

    const tentativa = await api().post('/api/v1/athletes').set(pessoa.auth()).send({
      organizationId: orgA.id, fullName: 'Eu Mesmo', cpf: gerarCpf(111222333), sex: 'MALE', birthDate: '1995-01-01'
    });

    expect([401, 403]).toContain(tentativa.status);
    expect(await prisma.athlete.count()).toBe(0);
  });

  // CONVERTIDO de "o próprio solicitante NÃO aprova o próprio pedido".
  //
  // Aquele teste protegia contra um conflito de interesse que sumiu junto
  // com a aprovação manual. O que o substitui protege contra a ameaça NOVA,
  // que é maior: a identidade de serviço tem poder de operador no banco, e
  // ninguém pode vesti-la.
  it('o atleta não consegue vestir a identidade de serviço', async () => {
    const pessoa = await cadastrarPessoa('Curiosa');
    const conta = await comoAtor(admin, () => prisma.user.findFirst({
      where: { serviceOrganizationId: orgA.id, isServiceAccount: true },
      select: { id: true, email: true }
    }));
    expect(conta, 'a federação nasceu sem conta de serviço').toBeTruthy();

    // 1. não se autentica com ela, nem com a senha certa (que não existe).
    const login = await api().post('/api/v1/auth/login')
      .send({ email: conta.email, password: 'senha-de-teste-123' });
    expect(login.status).toBe(401);
    expect(login.body.error.code, 'a recusa confirmou que a conta existe').toBe('INVALID_CREDENTIALS');

    // 2. não se escolhe quem executa: mandar a conta no corpo não muda nada.
    const comIdentidadeForjada = await pedir(pessoa, {
      ...pedidoValido(filiacaoA, 191919191),
      serviceAccountId: conta.id,
      operatorId: conta.id
    });
    expect(comIdentidadeForjada.status, JSON.stringify(comIdentidadeForjada.body)).toBe(201);

    // O atleta nasceu na federação da FILIAÇÃO, e o executor foi a conta
    // daquela federação — não a que o corpo nomeou (aqui são a mesma, e é
    // justamente por isso que o teste seguinte, com duas federações, existe).
    expect(comIdentidadeForjada.body.organizationId).toBe(orgA.id);
  });

  it('nem o corpo nem a query escolhem a federação que executa', async () => {
    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    await abrirAutocadastro(orgB.id);
    const pessoa = await cadastrarPessoa('Atravessadora');

    // A filiação é da A; o corpo pede a B de todas as formas que consegue.
    const r = await pedir(pessoa, {
      ...pedidoValido(filiacaoA, 202020202),
      organizationId: orgB.id,
      federationId: orgB.id
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.organizationId, 'o cliente escolheu a federação').toBe(orgA.id);

    const atleta = await comoAtor(admin, () => prisma.athlete.findFirst({ where: { userId: pessoa.id } }));
    expect(atleta.organizationId, 'o atleta nasceu na federação que o corpo pediu').toBe(orgA.id);

    // E a federação B não ganhou atleta nenhum.
    expect(await comoAtor(admin, () => prisma.athlete.count({ where: { organizationId: orgB.id } }))).toBe(0);
  });
});

describe('o cadastro conclui sozinho', () => {
  // CONVERTIDO de "nasce PENDING, sem criar atleta nem identidade".
  //
  // O antigo provava que NADA acontecia até um humano agir. Este prova o
  // oposto, que é a regra nova — e prova mais: que ninguém assinou.
  it('nasce APPROVED, com atleta e identidade, e sem revisor', async () => {
    const pessoa = await cadastrarPessoa('Solicitante');
    const cpf = gerarCpf(111111111);
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 111111111), cpf });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.organizationId, 'a organização deveria vir da filiação').toBe(orgA.id);

    // NINGUÉM ASSINOU. Se um dia alguém constar aqui, ou a fila voltou, ou o
    // id de quem pediu foi gravado como se ele tivesse analisado a si mesmo.
    expect(r.body.reviewedById, 'alguém consta como revisor de um cadastro automático').toBeNull();
    expect(r.body.athleteId, 'a conclusão automática não criou o atleta').toBeTruthy();

    const atleta = await comoAtor(operadorA, () => prisma.athlete.findUnique({ where: { id: r.body.athleteId } }));
    expect(atleta.userId).toBe(pessoa.id);
    expect(atleta.affiliationId).toBe(filiacaoA.id);
    expect(atleta.fullName).toBe('Atleta Solicitante');

    const identidade = await comoAtor(operadorA, () => prisma.athleteIdentity.findUnique({ where: { athleteId: atleta.id } }));
    expect(identidade.cpf, 'o documento não foi para AthleteIdentity').toBe(cpf.replace(/\D/g, ''));

    // E saiu do pedido: ele vive onde a RLS de CPF o protege.
    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: r.body.id } }));
    expect(naFila.cpf, 'o CPF continuou guardado no pedido depois da conclusão').toBeNull();
    expect(naFila.athleteId).toBe(atleta.id);
  });

  it('a resposta diz o desfecho da conciliação, sem histórico nenhum a vincular', async () => {
    const pessoa = await cadastrarPessoa('Estreante');
    const r = await pedir(pessoa, pedidoValido(filiacaoA, 212121212));

    expect(r.body.conciliacao.estado).toBe('SEM_HISTORICO');
    expect(r.body.conciliacao.matchMethod).toBe('SEM_HISTORICO');
    expect(r.body.conciliacao.vinculados).toBe(0);
    expect(r.body.conciliacao.rankingPointIds).toEqual([]);
  });

  it('CPF inválido é recusado', async () => {
    const pessoa = await cadastrarPessoa('CPF Ruim');
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf: '11111111111' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_CPF');
  });

  it('filiação inexistente ou inativa é recusada', async () => {
    const pessoa = await cadastrarPessoa('Sem Filiação');

    const inexistente = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), affiliationId: 'cl00000000000000000000000' });
    expect(inexistente.status).toBe(422);
    expect(inexistente.body.error.code).toBe('AFFILIATION_INVALID');

    await comoAtor(admin, () => prisma.affiliation.update({ where: { id: filiacaoA.id }, data: { active: false } }));
    const inativa = await pedir(pessoa, pedidoValido(filiacaoA, 2));
    expect(inativa.status).toBe(422);
    expect(inativa.body.error.code).toBe('AFFILIATION_INACTIVE');
  });

  // A PORTA, E NÃO A VITRINE. Esconder a filiação nunca impediu quem já
  // tivesse o id dela — e com a conclusão automática o furo passaria a criar
  // atleta em federação de porta fechada.
  it('federação com autocadastro fechado recusa, mesmo com o id da filiação em mãos', async () => {
    await abrirAutocadastro(orgA.id, false);
    const pessoa = await cadastrarPessoa('Insistente');

    const r = await pedir(pessoa, pedidoValido(filiacaoA, 232323232));

    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SELF_REGISTRATION_CLOSED');
    expect(await comoAtor(admin, () => prisma.athlete.count())).toBe(0);
  });

  it('o solicitante acompanha o próprio cadastro, e sem ver o CPF de volta', async () => {
    const pessoa = await cadastrarPessoa('Acompanha');
    await pedir(pessoa, pedidoValido(filiacaoA, 666666666));

    const meus = await api().get('/api/v1/athlete-requests/me').set(pessoa.auth());
    expect(meus.status).toBe(200);
    expect(meus.body.items).toHaveLength(1);
    expect(meus.body.items[0].status).toBe('APPROVED');
    expect(JSON.stringify(meus.body), 'o CPF voltou na consulta do solicitante').not.toMatch(/"cpf"/);
  });
});

describe('colisão de identidade é recusada, e a recusa é muda', () => {
  // CONVERTIDO de "CPF já cadastrado passa no pedido, e é barrado na
  // aprovação sem deixar resto".
  //
  // O antigo aceitava o pedido e barrava depois, porque a RLS impedia a
  // pré-checagem e só a unicidade decidia. A unicidade continua sendo quem
  // decide — mudou o MOMENTO: agora ela decide no próprio cadastro.
  //
  // E o teste ficou mais forte num ponto que o antigo não tinha como cobrir:
  // a mensagem. Dita ao OPERADOR, "este CPF já pertence a um atleta desta
  // federação" é informação útil. Dita a quem se cadastra, é um oráculo.
  it('CPF já cadastrado: o cadastro é recusado sem confirmar que o CPF existe', async () => {
    const cpf = gerarCpf(555555555);
    expect((await api().post('/api/v1/athletes').set(operadorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Já Existe', cpf, sex: 'MALE', birthDate: '1990-01-01' })).status).toBe(201);

    const antes = await comoAtor(operadorA, () => prisma.athlete.count());
    const pessoa = await cadastrarPessoa('Mesmo CPF');
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });

    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.conciliacao.estado).toBe('PRECISA_REVISAO');
    // O pedido FICA pendente: é assim que a federação recebe o caso.
    expect(r.body.status).toBe('PENDING');

    // A RECUSA NÃO CONTA NADA. Nem o documento, nem o nome de quem já o tem,
    // nem sequer que o problema foi o CPF — senão bastaria variar o número
    // para descobrir quem está cadastrado nesta federação.
    // O que NÃO pode voltar é dado de TERCEIRO, e o motivo da colisão. O que
    // a pessoa mandou volta, e isso não é vazamento: é o eco do próprio
    // formulário dela.
    const texto = JSON.stringify(r.body);
    expect(texto, 'a recusa nomeou o outro atleta').not.toContain('Já Existe');
    expect(texto, 'a recusa disse qual identificador colidiu').not.toContain('CPF_ALREADY_REGISTERED');
    expect(texto, 'a recusa disse qual identificador colidiu').not.toContain('AFFILIATION_NUMBER_IN_USE');
    expect(texto).not.toMatch(/"motivo"/);

    // Nada sobrou: nem atleta, nem identidade.
    expect(await comoAtor(operadorA, () => prisma.athlete.count())).toBe(antes);
  });

  // CONVERTIDO de "se a identidade falhar, NENHUM atleta sobra".
  //
  // A atomicidade importa pelo mesmo motivo de antes: a falha plausível é a
  // SEGUNDA escrita, a identidade. Um atleta sem CPF não aparece na busca por
  // documento e vira um fantasma que ninguém consegue inscrever. O que mudou
  // é onde a transação roda — agora dentro do cadastro.
  it('se a identidade falhar, NENHUM atleta sobra', async () => {
    const cpf = gerarCpf(999999999);
    const outro = await api().post('/api/v1/athletes').set(operadorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Chegou Antes', cpf, sex: 'MALE', birthDate: '1990-01-01' });
    expect(outro.status).toBe(201);

    const antes = await comoAtor(operadorA, () => prisma.athlete.count());
    const identidadesAntes = await comoAtor(operadorA, () => prisma.athleteIdentity.count());

    const pessoa = await cadastrarPessoa('Corrida');
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });
    expect(r.status).toBeGreaterThanOrEqual(400);

    expect(await comoAtor(operadorA, () => prisma.athlete.count()),
      'sobrou atleta de um cadastro que falhou').toBe(antes);
    expect(await comoAtor(operadorA, () => prisma.athleteIdentity.count()),
      'sobrou identidade de um cadastro que falhou').toBe(identidadesAntes);
  });

  // Matrícula duplicada é a OUTRA colisão possível, e por muito tempo as duas
  // eram registradas como "CPF duplicado" — o que mandaria o operador
  // procurar o problema no documento quando ele estava no número da filiação.
  it('matrícula já usada: recusa igualmente muda, e a auditoria sabe a diferença', async () => {
    const primeira = await cadastrarPessoa('Dona da Matrícula');
    const p1 = await pedir(primeira, { ...pedidoValido(filiacaoA, 242424242), affiliationNumber: 'NPC-UNICA' });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);

    const segunda = await cadastrarPessoa('Outra');
    const p2 = await pedir(segunda, { ...pedidoValido(filiacaoA, 252525252), affiliationNumber: 'NPC-UNICA' });

    expect(p2.status).toBe(409);
    expect(p2.body.conciliacao.estado).toBe('PRECISA_REVISAO');
    expect(p2.body.status).toBe('PENDING');
    // A matrícula volta porque foi ELA quem a digitou — eco do próprio
    // formulário. O que não pode voltar é de quem ela já é, nem qual das duas
    // unicidades caiu.
    const corpo = JSON.stringify(p2.body);
    expect(corpo, 'a recusa nomeou a dona da matrícula').not.toContain('Dona da Matrícula');
    expect(corpo, 'a recusa disse qual identificador colidiu').not.toContain('AFFILIATION_NUMBER_IN_USE');
    expect(corpo).not.toMatch(/"motivo"/);

    // A auditoria, essa sim, diz qual unicidade caiu — e é ela que o operador
    // lê quando a pessoa ligar reclamando.
    const bloqueios = await comoAtor(admin, () => prisma.auditLog.findMany({
      where: { action: 'ATHLETE_PROFILE_REQUEST_AUTO_BLOCKED' }
    }));
    expect(bloqueios).toHaveLength(1);
    expect(bloqueios[0].metadata.motivo).toBe('AFFILIATION_NUMBER_IN_USE');
    expect(bloqueios[0].metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
  });

  // CONVERTIDO de "só um pedido em aberto por pessoa" e de "aprovar duas
  // vezes não cria dois atletas". As duas provavam a mesma coisa por ângulos
  // diferentes — que ninguém vira dois atletas —, e a trava que as sustentava
  // (o índice parcial de pedido PENDING) deixou de ser alcançável porque não
  // há mais estado pendente. Quem segura agora é a unicidade do documento.
  it('cadastrar duas vezes não cria dois atletas', async () => {
    const pessoa = await cadastrarPessoa('Duas Vezes');
    const cpf = gerarCpf(888888888);

    const primeiro = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(201);

    const segundo = await pedir(pessoa, { ...pedidoValido(filiacaoA, 2), cpf });
    expect(segundo.status, 'a mesma pessoa virou atleta duas vezes').toBeGreaterThanOrEqual(400);

    expect(await comoAtor(operadorA, () => prisma.athlete.count({ where: { userId: pessoa.id } }))).toBe(1);
    expect(await comoAtor(operadorA, () => prisma.athleteIdentity.count())).toBe(1);
  });
});

describe('a auditoria da conclusão automática', () => {
  // CONVERTIDO de "a auditoria registra pedido, aprovação e rejeição — e
  // nunca o CPF". O CPF continua proibido; o que mudou são as ações, e o
  // teste passou a cobrar o que a regra nova exige: QUEM executou.
  it('registra criação, conclusão e conciliação — com actorType, e nunca o CPF', async () => {
    const pessoa = await cadastrarPessoa('Auditada');
    const cpf = gerarCpf(181818181);
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const trilha = await comoAtor(admin, () => prisma.auditLog.findMany({
      where: {
        action: {
          in: [
            'ATHLETE_PROFILE_REQUEST_CREATE',
            'ATHLETE_PROFILE_REQUEST_AUTO_APPROVE',
            'ATHLETE_HISTORY_RECONCILED'
          ]
        }
      }
    }));

    expect(trilha.map(l => l.action).sort()).toEqual([
      'ATHLETE_HISTORY_RECONCILED',
      'ATHLETE_PROFILE_REQUEST_AUTO_APPROVE',
      'ATHLETE_PROFILE_REQUEST_CREATE'
    ]);

    // NENHUMA aprovação humana foi registrada. Se esta ação aparecer, é
    // porque alguém voltou a apertar o botão.
    expect(await comoAtor(admin, () => prisma.auditLog.count({
      where: { action: 'ATHLETE_PROFILE_REQUEST_APPROVE' }
    })), 'houve aprovação humana num cadastro automático').toBe(0);

    const conclusao = trilha.find(l => l.action === 'ATHLETE_PROFILE_REQUEST_AUTO_APPROVE');
    expect(conclusao.metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
    expect(conclusao.metadata.serviceAccountId).toBeTruthy();
    expect(conclusao.metadata.origem).toBe('AUTOCADASTRO');

    const conciliacao = trilha.find(l => l.action === 'ATHLETE_HISTORY_RECONCILED');
    expect(conciliacao.metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
    expect(conciliacao.metadata.matchMethod).toBe('SEM_HISTORICO');
    expect(conciliacao.metadata.rankingPointIds).toEqual([]);

    expect(JSON.stringify(trilha), 'o CPF foi parar na auditoria').not.toContain(cpf.replace(/\D/g, ''));
  });

  // A conta de serviço é do SISTEMA, e o registro tem de deixar isso escrito
  // para quem auditar um ano depois.
  it('a conta de serviço aparece na auditoria como provisionada, e é uma só', async () => {
    const provisionamentos = await comoAtor(admin, () => prisma.auditLog.findMany({
      where: { action: 'SERVICE_ACCOUNT_PROVISIONED', organizationId: orgA.id }
    }));
    expect(provisionamentos).toHaveLength(1);
    expect(provisionamentos[0].metadata.role).toBe('FEDERATION_SERVICE');

    const contas = await comoAtor(admin, () => prisma.user.count({
      where: { serviceOrganizationId: orgA.id, isServiceAccount: true }
    }));
    expect(contas, 'a federação tem mais de uma conta de serviço').toBe(1);
  });
});

// ==========================================================================
// OS CAMINHOS QUE A FILA DEIXOU PARA TRÁS.
//
// `rejeitar` e `cancelar` continuam no serviço e continuam precisando de
// prova — o autocadastro não produz mais pedido PENDENTE, mas o código que
// decide sobre um continua existindo, e linha legada continua podendo
// aparecer. O cenário é montado; o que está sob teste é a decisão.
// ==========================================================================

describe('quem pode decidir sobre um pedido pendente', () => {
  it('papéis sem permissão não aprovam', async () => {
    const pessoa = await cadastrarPessoa('Alvo');
    const pedido = await pedidoLegado(pessoa, filiacaoA, orgA.id, 262626262);

    for (const papel of ['ATHLETE', 'JUDGE', 'STAFF', 'MEDIA']) {
      const usuario = await criarUsuario({ role: papel, name: `Usuário ${papel}` });
      const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(usuario.auth()).send({});
      // 404 é resposta legítima e melhor que 403 aqui: a RLS esconde o pedido
      // de quem não é dono nem operador, então o serviço nem chega a avaliar
      // permissão — e a resposta não confirma que o pedido existe.
      expect([401, 403, 404], `${papel} aprovou`).toContain(r.status);
    }
    expect(await comoAtor(admin, () => prisma.athlete.count())).toBe(0);
  });

  it('sem autenticação não alcança nada da fila', async () => {
    const pessoa = await cadastrarPessoa('Anônimo');
    const pedido = await pedidoLegado(pessoa, filiacaoA, orgA.id, 272727272);

    expect((await api().get('/api/v1/athlete-requests')).status).toBe(401);
    expect((await api().get(`/api/v1/athlete-requests/${pedido.id}`)).status).toBe(401);
    expect((await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).send({})).status).toBe(401);
  });

  it('operador de OUTRA federação não lê, não aprova e não rejeita', async () => {
    const pessoa = await cadastrarPessoa('Alvo Cross');
    const pedido = await pedidoLegado(pessoa, filiacaoA, orgA.id, 282828282);

    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const operadorB = await criarUsuario({ name: 'Operador B' });
    await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');

    expect([403, 404]).toContain((await api().get(`/api/v1/athlete-requests/${pedido.id}`).set(operadorB.auth())).status);
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorB.auth()).send({})).status);
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorB.auth()).send({ reason: 'porque sim' })).status);

    expect(await comoAtor(admin, () => prisma.athlete.count())).toBe(0);

    const fila = await api().get(`/api/v1/athlete-requests?organizationId=${orgB.id}`).set(operadorB.auth());
    if (fila.status === 200) expect(fila.body.items).toHaveLength(0);
  });

  // A CONTA DE SERVIÇO NÃO É UM OPERADOR GENÉRICO. No banco ela escreve como
  // operador da própria federação; na APLICAÇÃO ela não tem permissão
  // nenhuma, e é por isso que este teste existe: se ela ganhasse um token,
  // ainda assim não aprovaria, não rejeitaria e não listaria.
  it('a conta de serviço não opera a API como se fosse gente', async () => {
    const { permissionsForRole } = await import('../src/utils/permissions.js');
    const daConta = permissionsForRole('FEDERATION_SERVICE');

    for (const proibida of ['athletes.manage', 'athletes.create', 'athletes.update', 'ranking.manage', 'musclewar.apply']) {
      expect(daConta, `a conta de serviço ganhou ${proibida}`).not.toContain(proibida);
    }
  });
});

describe('rejeição e cancelamento de pedido pendente', () => {
  it('rejeitar exige motivo, guarda quem analisou e NÃO apaga a linha', async () => {
    const pessoa = await cadastrarPessoa('Rejeitada');
    const pedido = await pedidoLegado(pessoa, filiacaoA, orgA.id, 121212121);

    const semMotivo = await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorA.auth()).send({});
    expect(semMotivo.status).toBe(400);

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorA.auth())
      .send({ reason: 'Número de filiação não confere com o cadastro da entidade' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    expect(r.body.rejectionReason).toMatch(/não confere/);
    // AQUI o revisor é humano, e tem de constar — é o contraponto do
    // `reviewedById` nulo da conclusão automática.
    expect(r.body.reviewedById).toBe(operadorA.id);

    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }));
    expect(naFila).toBeTruthy();
    expect(naFila.cpf).toBeNull();
    expect(await comoAtor(admin, () => prisma.athlete.count())).toBe(0);
  });

  it('depois de rejeitada, a pessoa se cadastra normalmente', async () => {
    const pessoa = await cadastrarPessoa('Segunda Chance');
    const primeiro = await pedidoLegado(pessoa, filiacaoA, orgA.id, 131313131);
    await api().post(`/api/v1/athlete-requests/${primeiro.id}/reject`).set(operadorA.auth()).send({ reason: 'dados incompletos' });

    const segundo = await pedir(pessoa, pedidoValido(filiacaoA, 141414141));
    expect(segundo.status, 'a recusa anterior barrou o cadastro novo').toBe(201);
    expect(segundo.body.status).toBe('APPROVED');
  });

  it('o solicitante cancela o próprio pedido pendente; outra pessoa não', async () => {
    const pessoa = await cadastrarPessoa('Desistente');
    const pedido = await pedidoLegado(pessoa, filiacaoA, orgA.id, 151515151);

    const estranha = await cadastrarPessoa('Estranha');
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(estranha.auth()).send({})).status);

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(pessoa.auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
  });
});

describe('a listagem sem organização nomeada', () => {
  // A TELA do operador não manda `organizationId` — ela não tem como escolher
  // a federação, e não deve ter: quem decide o escopo é o vínculo do ator.
  //
  // O defeito que este teste pegou continua possível: `organizationFilter`
  // devolve `{ organizationId: { in: [...] } }`, e esse OBJETO indo para
  // `assertCan` fazia a fila responder 403 para todo operador legítimo.
  it('o operador lista a própria fila sem nomear a organização', async () => {
    const pessoa = await cadastrarPessoa('Sem Org Nomeada');
    await pedir(pessoa, pedidoValido(filiacaoA, 292929292));

    const fila = await api().get('/api/v1/athlete-requests').set(operadorA.auth());

    expect(fila.status, JSON.stringify(fila.body)).toBe(200);
    expect(fila.body.items).toHaveLength(1);
    expect(fila.body.items[0].organizationId).toBe(orgA.id);
  });

  it('sem organização nomeada, o operador continua sem ver a fila alheia', async () => {
    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    await abrirAutocadastro(orgB.id);
    const operadorB = await criarUsuario({ name: 'Operador B' });
    await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');
    const filiacaoB = await criarFiliacao(operadorB, orgB.id);

    const daA = await cadastrarPessoa('Pedido da A');
    expect((await pedir(daA, pedidoValido(filiacaoA, 303030303))).status).toBe(201);
    const daB = await cadastrarPessoa('Pedido da B');
    expect((await pedir(daB, pedidoValido(filiacaoB, 313131313))).status).toBe(201);

    const fila = await api().get('/api/v1/athlete-requests').set(operadorA.auth());

    expect(fila.status).toBe(200);
    expect(fila.body.items).toHaveLength(1);
    expect(fila.body.items[0].organizationId).toBe(orgA.id);
  });

  it('quem não tem athletes.manage continua recusado sem nomear organização', async () => {
    const pessoa = await cadastrarPessoa('Curioso');
    const fila = await api().get('/api/v1/athlete-requests').set(pessoa.auth());
    expect(fila.status).toBe(403);
  });
});

describe('o CPF na listagem e na análise', () => {
  it('a listagem NÃO devolve CPF', async () => {
    const pessoa = await cadastrarPessoa('Na Fila');
    const cpf = gerarCpf(161616161);
    await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });

    const fila = await api().get(`/api/v1/athlete-requests?organizationId=${orgA.id}`).set(operadorA.auth());
    expect(fila.status, JSON.stringify(fila.body)).toBe(200);
    expect(fila.body.items).toHaveLength(1);

    const texto = JSON.stringify(fila.body);
    expect(texto, 'o CPF apareceu na listagem').not.toContain(cpf.replace(/\D/g, ''));
    expect(texto).not.toMatch(/"cpf"/);
  });

  // SUBSTITUI "o CPF sai só na tela de análise, e só para quem lê dado
  // sensível".
  //
  // Aquele teste provava que o CPF ficava no pedido até a decisão. Agora não
  // fica: a conclusão é imediata e o documento migra na hora. O que precisa
  // de prova mudou junto — não é mais "o CPF aparece para quem pode", é "o
  // CPF já não está mais aqui, e está onde a RLS o protege".
  //
  // A leitura do CPF por quem tem permissão continua coberta, e de forma mais
  // completa, em `tests/revelar-cpf.test.mjs`: lá ela passa pela rota
  // própria, com as duas permissões e a auditoria.
  it('depois da conclusão, a análise não tem mais CPF para mostrar', async () => {
    const pessoa = await cadastrarPessoa('Analisada');
    const cpf = gerarCpf(171717171);
    const pedido = (await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf })).body;

    const analise = await api().get(`/api/v1/athlete-requests/${pedido.id}`).set(operadorA.auth());
    expect(analise.status).toBe(200);
    // O campo não vem NEM COMO NULO: `semChaves` o remove por construção, e
    // ausente é mais forte que nulo — não há o que esquecer de limpar.
    expect(analise.body.cpf, 'o CPF continuou no pedido depois da conclusão').toBeUndefined();

    // E está em AthleteIdentity, que é onde a RLS de CPF o protege.
    const identidade = await comoAtor(operadorA, () =>
      prisma.athleteIdentity.findUnique({ where: { athleteId: pedido.athleteId } }));
    expect(identidade.cpf).toBe(cpf.replace(/\D/g, ''));
  });
});

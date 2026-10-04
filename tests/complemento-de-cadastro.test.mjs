import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// COMPLEMENTO DE CADASTRO DO ATLETA — E OS DOIS NÚMEROS QUE NÃO SE MISTURAM.
//
// O QUE ESTA FASE FEZ, E O QUE ELA DECIDIU NÃO FAZER
//
// Fez: uma superfície onde o atleta completa o próprio cadastro
// (`GET /me/cadastro` + a escrita que já existia), e o rótulo "número de
// filiação" no lugar de "matrícula", com a diferença entre os dois números
// escrita onde a pessoa preenche.
//
// NÃO fez: replicar `affiliationNumber` em `athleteNumber`. A proposta foi
// medida e recusada, e a recusa é justamente o que estes testes travam.
//
//   `affiliationNumber` é único por (organização, FILIAÇÃO, número)
//   `athleteNumber`     é único por (organização,           número)
//
// A segunda unicidade NÃO tem a filiação dentro. Copiar um número no outro
// faria `NPC + 2932` e `IFBB + 2932` — duas pessoas legítimas, de federações
// diferentes — disputarem a MESMA chave, e a segunda seria recusada com 409.
// O sistema passaria a recusar atleta correto. Por isso os dois campos
// continuam separados, e há teste para cada metade disso.
//
// A OUTRA METADE: QUEM PODE ESCREVER O QUÊ.
//
// O par (entidade, número de filiação) é a identidade pela qual o resultado
// oficial reconhece a pessoa. Atleta que editasse o próprio número poderia se
// apropriar do histórico de outro — então o dono NÃO altera `affiliationId`,
// `affiliationNumber` nem `athleteNumber`, e o operador altera. A trava é do
// DONO, não da rota, e é isso que os testes do grupo B separam.
//
// Nada aqui muda schema, índice, migration ou dado de produção. Nenhum teste
// deste arquivo cria, move ou recalcula ponto — dois deles existem justamente
// para provar que salvar o cadastro não encosta no ledger.
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let npc;
let ifbb;
let contaDoAtleta;
let contaSemPerfil;

const noLedger = consulta => comoAtor(gerente, consulta);

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

async function importarEAplicar(conteudo) {
  const criado = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv', content: conteudo
  });
  expect([200, 201], JSON.stringify(criado.body).slice(0, 300)).toContain(criado.status);
  const importId = criado.body.import?.id ?? criado.body.id;
  const aplicado = await api()
    .post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
  expect([200, 201], JSON.stringify(aplicado.body).slice(0, 300)).toContain(aplicado.status);
  return importId;
}

// Liga a conta de usuário ao perfil de atleta. É ato de operador, e é o que
// faz `/me/cadastro` ter alguém para responder.
async function ligarConta(athleteId, conta) {
  const resposta = await api().patch(`/api/v1/athletes/${athleteId}`).set(gerente.auth())
    .send({ userId: conta.id });
  expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
}

const meuCadastro = conta => api().get('/api/v1/me/cadastro').set(conta.auth());

// A edição feita PELO PRÓPRIO ATLETA, com o token dele. A rota é a mesma de
// sempre — é lá que a regra de campo restrito mora.
const salvarComoAtleta = (athleteId, dados) => api()
  .patch(`/api/v1/athletes/${athleteId}`).set(contaDoAtleta.auth()).send(dados);

const estadoNoBanco = athleteId => noLedger(tx => tx.athlete.findUnique({
  where: { id: athleteId },
  select: {
    fullName: true, stageName: true, city: true, state: true, phone: true, email: true,
    affiliationId: true, affiliationNumber: true, athleteNumber: true
  }
}));

// O retrato do ledger para uma matrícula, igual ao da consolidação: é por ele
// que se prova que nada se moveu.
async function retrato(matricula, affiliationId = npc.id) {
  const identidades = await noLedger(tx => tx.externalAthlete.findMany({
    where: { organizationId, affiliationId, affiliationNumber: matricula },
    select: { id: true, athleteId: true }
  }));
  const ids = identidades.map(i => i.id);
  const lancamentos = ids.length
    ? await noLedger(tx => tx.rankingPoint.findMany({
      where: { organizationId, externalAthleteId: { in: ids } },
      select: { id: true, athleteId: true, points: true }
    }))
    : [];
  return {
    identidades: identidades.length,
    comDono: identidades.filter(i => i.athleteId).length,
    lancamentos: lancamentos.length,
    lancamentoIds: new Set(lancamentos.map(l => l.id)),
    lancamentosComDono: lancamentos.filter(l => l.athleteId).length,
    colocacao: lancamentos.reduce((total, l) => total + l.points, 0)
  };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Cadastro' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Mato Grosso', code: 'NPC-MT' })).body;
  ifbb = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'IFBB Mato Grosso', code: 'IFBB-MT' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  // A TABELA OFICIAL DE COLOCAÇÃO. Este arquivo não inventa regra esportiva.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [
      { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }
    ]
  });

  contaDoAtleta = await criarUsuario({ name: 'Conta do Lucas' });
  contaSemPerfil = await criarUsuario({ name: 'Conta sem atleta' });
});

// Um atleta completo o bastante para a tela, ligado à conta do token.
async function lucas(extra = {}) {
  const cpf = extra.cpf ?? gerarCpf(292932932);
  const athlete = await criarAtleta(gerente, organizationId, {
    fullName: 'Lucas Gouveia Lima', cpf, sex: 'MALE', birthDate: '1990-07-15',
    city: 'Cuiabá', state: 'MT',
    affiliationId: npc.id, affiliationNumber: '2932', athleteNumber: 'ATL-700',
    ...extra
  });
  await ligarConta(athlete.id, contaDoAtleta);
  return { athlete, cpf };
}

// ====================================================== A — o que a rota diz
describe('GET /me/cadastro — o que o atleta vê sobre si mesmo', () => {
  it('1. devolve os campos editáveis já preenchidos, com a data em AAAA-MM-DD', async () => {
    const { athlete } = await lucas();

    const resposta = await meuCadastro(contaDoAtleta);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);

    expect(resposta.body.athlete.id).toBe(athlete.id);
    expect(resposta.body.editaveis.fullName).toBe('Lucas Gouveia Lima');
    expect(resposta.body.editaveis.city).toBe('Cuiabá');
    expect(resposta.body.editaveis.state).toBe('MT');
    // A tela usa `<input type="date">`, que só aceita este formato. Mandar o
    // ISO completo deixaria o campo em branco sem dizer por quê.
    expect(resposta.body.editaveis.birthDate).toBe('1990-07-15');
    expect(resposta.body.campos).toContain('fullName');
    expect(resposta.body.campos, 'o número de filiação NÃO é campo editável do atleta')
      .not.toContain('affiliationNumber');
    expect(resposta.body.campos, 'nem o número de atleta').not.toContain('athleteNumber');
  });

  it('2. `faltando` nomeia exatamente os campos em branco', async () => {
    await lucas();

    const resposta = await meuCadastro(contaDoAtleta);
    // Nome, nascimento, cidade e estado foram preenchidos; estes três, não.
    expect([...resposta.body.faltando].sort()).toEqual(['email', 'phone', 'stageName']);

    // Preencher um deles o tira da lista — e não tira os outros.
    const salvo = await salvarComoAtleta((await meuCadastro(contaDoAtleta)).body.athlete.id, {
      phone: '65999990000'
    });
    expect(salvo.status, JSON.stringify(salvo.body).slice(0, 300)).toBe(200);

    const depois = await meuCadastro(contaDoAtleta);
    expect([...depois.body.faltando].sort()).toEqual(['email', 'stageName']);
  });

  it('3. a identidade esportiva vem separada do que é editável', async () => {
    await lucas();

    const { body } = await meuCadastro(contaDoAtleta);
    expect(body.identidade.affiliation.code).toBe('NPC-MT');
    expect(body.identidade.affiliationNumber).toBe('2932');
    expect(body.identidade.athleteNumber).toBe('ATL-700');
    // E nenhum deles aparece como editável: a tela não oferece um campo que
    // o servidor descartaria em silêncio.
    expect(Object.keys(body.editaveis)).not.toContain('affiliationNumber');
    expect(Object.keys(body.editaveis)).not.toContain('affiliationId');
    expect(Object.keys(body.editaveis)).not.toContain('athleteNumber');
  });

  it('4. o CPF sai mascarado, e o número inteiro não aparece na resposta', async () => {
    const { cpf } = await lucas();

    const { body } = await meuCadastro(contaDoAtleta);
    expect(body.identidade.cpfMasked).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    expect(JSON.stringify(body), 'o CPF inteiro não pode estar em lugar nenhum')
      .not.toContain(cpf);
  });

  it('5. nenhum parâmetro do cliente troca de quem é o cadastro devolvido', async () => {
    const { athlete } = await lucas();
    const outro = await criarAtleta(gerente, organizationId, {
      fullName: 'OUTRA PESSOA', cpf: gerarCpf(818181818), sex: 'FEMALE',
      affiliationId: ifbb.id, affiliationNumber: '9999'
    });

    const resposta = await meuCadastro(contaDoAtleta)
      .query({ athleteId: outro.id, organizationId, affiliationId: ifbb.id, affiliationNumber: '9999' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete.id, 'continua sendo o dono do token').toBe(athlete.id);
    expect(resposta.body.identidade.affiliationNumber).toBe('2932');
    expect(JSON.stringify(resposta.body)).not.toContain('OUTRA PESSOA');
    expect(JSON.stringify(resposta.body)).not.toContain('9999');
  });

  it('6. conta sem perfil de atleta recebe resposta explícita, não erro', async () => {
    const resposta = await meuCadastro(contaSemPerfil);
    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete).toBeNull();
    expect(resposta.body.editaveis).toBeNull();
    expect(resposta.body.identidade).toBeNull();
    expect(resposta.body.faltando).toEqual([]);
  });

  it('7. sem autenticação, 401 — a rota não é pública', async () => {
    const resposta = await api().get('/api/v1/me/cadastro');
    expect(resposta.status).toBe(401);
  });
});

// ============================= B — o atleta não altera a identidade esportiva
describe('o atleta completa o cadastro, e NÃO reescreve a identidade', () => {
  it('8. o atleta preenche os campos dele e o servidor grava', async () => {
    const { athlete } = await lucas();

    const salvo = await salvarComoAtleta(athlete.id, {
      stageName: 'Lucas Monstro', phone: '65988887777', email: 'LUCAS@EXEMPLO.COM',
      city: 'Várzea Grande'
    });
    expect(salvo.status, JSON.stringify(salvo.body).slice(0, 300)).toBe(200);

    const estado = await estadoNoBanco(athlete.id);
    expect(estado.stageName).toBe('Lucas Monstro');
    expect(estado.phone).toBe('65988887777');
    expect(estado.email, 'o e-mail é normalizado pelo schema').toBe('lucas@exemplo.com');
    expect(estado.city).toBe('Várzea Grande');
  });

  it('9. o atleta mandando `affiliationNumber` NÃO muda o número de filiação', async () => {
    const { athlete } = await lucas();

    const salvo = await salvarComoAtleta(athlete.id, { affiliationNumber: '7777' });
    expect(salvo.status).toBe(200);

    expect((await estadoNoBanco(athlete.id)).affiliationNumber,
      'o número de filiação é da federação, não do atleta').toBe('2932');
  });

  it('10. o atleta mandando `affiliationId` NÃO muda a entidade de filiação', async () => {
    const { athlete } = await lucas();

    const salvo = await salvarComoAtleta(athlete.id, { affiliationId: ifbb.id });
    expect(salvo.status).toBe(200);

    expect((await estadoNoBanco(athlete.id)).affiliationId).toBe(npc.id);
  });

  it('11. o atleta mandando `athleteNumber` NÃO muda o número de atleta', async () => {
    const { athlete } = await lucas();

    const salvo = await salvarComoAtleta(athlete.id, { athleteNumber: 'ATL-999' });
    expect(salvo.status).toBe(200);

    expect((await estadoNoBanco(athlete.id)).athleteNumber).toBe('ATL-700');
  });

  it('12. os três de uma vez: nenhum muda, e o que é dele é gravado', async () => {
    const { athlete } = await lucas();

    const salvo = await salvarComoAtleta(athlete.id, {
      affiliationId: ifbb.id, affiliationNumber: '7777', athleteNumber: 'ATL-999',
      city: 'Rondonópolis'
    });
    expect(salvo.status).toBe(200);

    const estado = await estadoNoBanco(athlete.id);
    expect(estado.affiliationId).toBe(npc.id);
    expect(estado.affiliationNumber).toBe('2932');
    expect(estado.athleteNumber).toBe('ATL-700');
    // O campo legítimo não é perdido junto: a recusa é por CAMPO, e não pela
    // requisição inteira.
    expect(estado.city).toBe('Rondonópolis');
  });

  it('13. o OPERADOR muda os três — a trava é do dono, não da rota', async () => {
    const { athlete } = await lucas();

    const salvo = await api().patch(`/api/v1/athletes/${athlete.id}`).set(gerente.auth())
      .send({ affiliationId: ifbb.id, affiliationNumber: '3000', athleteNumber: 'ATL-800' });
    expect(salvo.status, JSON.stringify(salvo.body).slice(0, 300)).toBe(200);

    const estado = await estadoNoBanco(athlete.id);
    expect(estado.affiliationId).toBe(ifbb.id);
    expect(estado.affiliationNumber).toBe('3000');
    expect(estado.athleteNumber).toBe('ATL-800');
  });
});

// ============================== C — dois números, duas coisas, sem replicação
describe('número de filiação e número de atleta continuam campos diferentes', () => {
  it('14. NPC + 2932 continua intacto depois de o atleta salvar o cadastro', async () => {
    const { athlete } = await lucas();

    await salvarComoAtleta(athlete.id, { stageName: 'Lucas', phone: '65988887777' });

    const estado = await estadoNoBanco(athlete.id);
    expect(estado.affiliationId).toBe(npc.id);
    expect(estado.affiliationNumber).toBe('2932');
  });

  it('15. a MESMA matrícula 2932 em outra federação continua possível', async () => {
    await lucas();

    // Se a replicação tivesse entrado, este cadastro seria recusado com 409
    // ATHLETE_NUMBER_IN_USE — uma pessoa legítima barrada por causa de outra,
    // de outra federação.
    const daIfbb = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'OUTRO LUCAS', cpf: gerarCpf(747474747), sex: 'MALE',
      birthDate: '1992-01-20', affiliationId: ifbb.id, affiliationNumber: '2932'
    });
    expect(daIfbb.status, JSON.stringify(daIfbb.body).slice(0, 300)).toBe(201);
    expect(daIfbb.body.affiliationNumber).toBe('2932');
  });

  it('16. número de ATLETA igual a uma matrícula alheia não colide', async () => {
    await lucas();

    // `athleteNumber` e `affiliationNumber` vivem em unicidades diferentes.
    // Replicar um no outro faria este cadastro bater contra o 2932 do Lucas.
    const terceiro = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'TERCEIRA PESSOA', cpf: gerarCpf(636363636), sex: 'FEMALE',
      birthDate: '1998-09-09', athleteNumber: '2932'
    });
    expect(terceiro.status, JSON.stringify(terceiro.body).slice(0, 300)).toBe(201);
    expect(terceiro.body.athleteNumber).toBe('2932');
    expect(terceiro.body.affiliationNumber ?? null,
      'e o número de atleta NÃO virou número de filiação').toBeNull();
  });

  it('17. a resposta mostra os dois números com os valores que cada um tem', async () => {
    await lucas();

    const { body } = await meuCadastro(contaDoAtleta);
    expect(body.identidade.affiliationNumber).toBe('2932');
    expect(body.identidade.athleteNumber).toBe('ATL-700');
    expect(body.identidade.affiliationNumber,
      'um não é cópia do outro').not.toBe(body.identidade.athleteNumber);
  });
});

// ===================================== D — o complemento não encosta no ledger
describe('completar o cadastro não cria, move nem desfaz ponto', () => {
  it('18. salvar o cadastro não cria nem move lançamento', async () => {
    const { athlete } = await lucas();
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato A`,
      `r2,,Lucas de Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,2,,Campeonato B`
    ]));

    const antes = await retrato('2932');
    expect(antes.lancamentos, 'o histórico entrou').toBe(2);
    expect(antes.colocacao, '1º = 5 e 2º = 4 pela tabela oficial').toBe(9);
    expect(antes.lancamentosComDono, 'e já é do Lucas, por filiação + matrícula').toBe(2);

    const salvo = await salvarComoAtleta(athlete.id, {
      stageName: 'Lucas Monstro', phone: '65988887777', email: 'lucas@exemplo.com'
    });
    expect(salvo.status).toBe(200);

    const depois = await retrato('2932');
    expect(depois.lancamentos, 'nenhum lançamento novo').toBe(antes.lancamentos);
    expect(depois.colocacao, 'nenhum ponto a mais nem a menos').toBe(antes.colocacao);
    expect([...depois.lancamentoIds].sort(), 'são os MESMOS lançamentos')
      .toEqual([...antes.lancamentoIds].sort());
  });

  it('19. o resultado importado já vinculado continua vinculado', async () => {
    const { athlete } = await lucas();
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato A`
    ]));

    expect((await retrato('2932')).comDono).toBe(1);

    await salvarComoAtleta(athlete.id, { city: 'Sinop', phone: '65977776666' });

    const depois = await retrato('2932');
    expect(depois.comDono, 'a identidade esportiva continua com dono').toBe(1);
    expect(depois.lancamentosComDono, 'e o lançamento também').toBe(1);

    const resultados = await noLedger(tx => tx.externalResult.findMany({
      where: { organizationId }, select: { athleteId: true }
    }));
    expect(resultados.length).toBe(1);
    expect(resultados[0].athleteId, 'o resultado importado segue apontando para o atleta')
      .toBe(athlete.id);
  });

  it('20. salvar duas vezes seguidas deixa o mesmo estado', async () => {
    const { athlete } = await lucas();

    const payload = { stageName: 'Lucas Monstro', phone: '65988887777', email: 'lucas@exemplo.com' };
    await salvarComoAtleta(athlete.id, payload);
    const primeiro = await estadoNoBanco(athlete.id);

    await salvarComoAtleta(athlete.id, payload);
    const segundo = await estadoNoBanco(athlete.id);

    expect(segundo).toEqual(primeiro);
    // E continua havendo UM atleta: salvar não duplica cadastro.
    expect(await noLedger(tx => tx.athlete.count({ where: { organizationId } }))).toBe(1);
  });
});

// ================================================================ E — rastro
describe('a edição do próprio cadastro deixa rastro', () => {
  it('21. a auditoria registra o ator e os campos, sem CPF', async () => {
    const { athlete, cpf } = await lucas();

    await salvarComoAtleta(athlete.id, { stageName: 'Lucas Monstro', phone: '65988887777' });

    const log = await noLedger(tx => tx.auditLog.findFirst({
      where: { action: 'ATHLETE_UPDATE', entityId: athlete.id },
      orderBy: { createdAt: 'desc' }
    }));

    expect(log, 'a edição foi auditada').toBeTruthy();
    expect(log.organizationId).toBe(organizationId);
    expect(log.actorId ?? log.userId, 'o ator é a conta do próprio atleta').toBe(contaDoAtleta.id);
    expect(log.metadata.fields).toContain('stageName');
    expect(log.metadata.fields).toContain('phone');
    expect(JSON.stringify(log), 'a trilha não carrega CPF').not.toContain(cpf);
  });
});

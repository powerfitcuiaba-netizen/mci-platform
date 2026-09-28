import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, autocadastrarTreinador
} from './helpers.mjs';

// ============================================================================
// AUTORIZAÇÃO AUTOMÁTICA NA NPC — a federação oficial única.
//
// A DECISÃO: quem conclui o cadastro de treinador já está autorizado a atuar na
// NPC, no mesmo instante, sem pedido e sem fila. E passa a criar a própria
// equipe, porque autorizar a atuar sem ter onde atuar seria meia decisão.
//
// O QUE ESTA SUÍTE EXISTE PARA IMPEDIR, e cada bloco é uma prova negativa:
//
//   * que a autorização automática vaze para OUTRAS federações — fora da NPC,
//     R-04 continua valendo e a federação continua decidindo;
//   * que ela invente um concedente humano na trilha;
//   * que ela DESFAÇA uma revogação da federação, que é o risco de deixar o
//     interessado gravar a própria linha;
//   * que `teams.create_own` vire `teams.manage` disfarçada — equipe alheia,
//     federação alheia, troca de responsável, empresa apontada pelo interessado;
//   * que o cadastro morra numa instalação onde a NPC não foi provisionada.
// ============================================================================

let central;
let orgNpc;
let orgOutra;
let diretorOutra;

const cadastrar = async (conta, nome) => {
  const r = await autocadastrarTreinador(conta, { name: nome, registration: `CREF-${unico('x')}`, phone: '65999887766' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

// A ENTIDADE OFICIAL É O MARCADOR, e não uma variável de ambiente nos testes: é
// exatamente o que a política do banco consulta (`Affiliation` ativa com código
// NPC) e o que `officialAffiliationService.organizacaoOficial` resolve. Montar o
// cenário por outro caminho mediria um acoplamento que não existe em produção.
const criarEntidadeOficial = async (organizationId, { code = 'NPC', name = 'NPC - National Physique Committe' } = {}) => {
  const r = await api().post('/api/v1/affiliations').set(central.auth())
    .send({ organizationId, name, code, kind: 'ENTITY' });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body;
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  // `MCI_NPC_ORGANIZATION_ID` fica FORA daqui de propósito: sem ela, o serviço
  // resolve pela entidade oficial, que é o caminho de uma instalação já
  // provisionada e o único que a política do banco reconhece.
  delete process.env.MCI_NPC_ORGANIZATION_ID;

  central = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  orgNpc = (await criarOrganizacao(central, { name: unico('NPC Brasil') })).id;
  orgOutra = (await criarOrganizacao(central, { name: unico('Federação Estadual') })).id;

  diretorOutra = await criarUsuario({ name: 'Diretor de Outra' });
  await vincular(orgOutra, diretorOutra, 'EVENT_DIRECTOR');

  await criarEntidadeOficial(orgNpc);
});

describe('o cadastro nasce autorizado na NPC', () => {
  it('a autorização existe, está APPROVED e aponta a federação oficial', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const autorizacoes = cadastro.organizations ?? [];
    expect(autorizacoes, 'a resposta do autocadastro já traz a autorização').toHaveLength(1);
    expect(autorizacoes[0].organizationId).toBe(orgNpc);
    expect(autorizacoes[0].status).toBe('APPROVED');
  });

  it('ela NÃO tem concedente humano, e se declara automática', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const linha = await comoAtor(central, tx => tx.coachOrganization.findFirst({
      where: { coachId: cadastro.id },
      select: { grantedById: true, grantedAt: true, autoGrantedAt: true, status: true }
    }));
    expect(linha.grantedById, 'inventar um revisor seria mentir na trilha').toBeNull();
    expect(linha.autoGrantedAt, 'é ela que diz que a decisão foi da regra').toBeTruthy();
    expect(linha.grantedAt).toBeTruthy();
  });

  it('a trilha registra a autorização como automática', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    const linhas = await comoAtor(central, tx => tx.auditLog.findMany({
      where: { action: 'COACH_ORG_AUTHORIZE' },
      select: { metadata: true, organizationId: true }
    }));
    expect(linhas).toHaveLength(1);
    expect(linhas[0].metadata.automatic).toBe(true);
    expect(linhas[0].organizationId).toBe(orgNpc);
  });

  it('UMA linha, e não duas: cadastrar de novo é 409 e não empilha autorização', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    const repetido = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });
    expect(repetido.status).toBe(409);

    const quantas = await comoAtor(central, tx => tx.coachOrganization.count());
    expect(quantas).toBe(1);
  });

  it('a área do treinador abre na hora, já autorizada', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    const meu = await api().get('/api/v1/coaches/me').set(conta.auth());
    expect(meu.status).toBe(200);
    expect(meu.body.organizations.some(o => o.organizationId === orgNpc && o.status === 'APPROVED')).toBe(true);
  });
});

describe('a automática NÃO vaza para fora da NPC — R-04 intacta', () => {
  it('nasce autorizado SÓ na oficial, em federação nenhuma mais', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const daOutra = await comoAtor(central, tx => tx.coachOrganization.count({
      where: { coachId: cadastro.id, organizationId: orgOutra }
    }));
    expect(daOutra, 'a federação estadual não autorizou ninguém').toBe(0);
  });

  it('criar equipe na federação que NÃO autorizou é recusado', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    const tentativa = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgOutra, name: unico('Equipe Intrusa') });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
    expect(tentativa.body.error.code).toBe('COACH_ORG_NOT_AUTHORIZED');
  });

  it('e a federação estadual continua autorizando pelo fluxo dela', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const autorizacao = await api().post(`/api/v1/coaches/${cadastro.id}/organizations`)
      .set(diretorOutra.auth())
      .send({ organizationId: orgOutra, reason: 'Atuação autorizada pela federação.' });
    expect(autorizacao.status, JSON.stringify(autorizacao.body)).toBe(200);

    const linha = await comoAtor(central, tx => tx.coachOrganization.findFirst({
      where: { coachId: cadastro.id, organizationId: orgOutra },
      select: { grantedById: true, autoGrantedAt: true }
    }));
    expect(linha.grantedById, 'concessão por pessoa grava quem concedeu').toBe(diretorOutra.id);
    expect(linha.autoGrantedAt, 'e NÃO se declara automática').toBeNull();
  });
});

describe('a automática não desfaz decisão da federação', () => {
  it('revogada pela NPC, a autorização NÃO volta sozinha', async () => {
    const diretorNpc = await criarUsuario({ name: 'Diretor NPC' });
    await vincular(orgNpc, diretorNpc, 'EVENT_DIRECTOR');

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const revogada = await api().post(`/api/v1/coaches/${cadastro.id}/organizations/revoke`)
      .set(diretorNpc.auth())
      .send({ organizationId: orgNpc, reason: 'Conduta em apuração.' });
    expect(revogada.status, JSON.stringify(revogada.body)).toBe(200);

    // O treinador continua com cadastro APPROVED e tenta usar a área: a
    // autorização revogada continua revogada, e criar equipe é recusado.
    const tentativa = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Depois da Revogação') });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);

    const linha = await comoAtor(central, tx => tx.coachOrganization.findFirst({
      where: { coachId: cadastro.id, organizationId: orgNpc },
      select: { status: true }
    }));
    expect(linha.status).toBe('REVOKED');
  });

  it('o treinador NÃO consegue gravar autorização para si em outra federação', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    // A ROTA da federação recusa por permissão.
    const pelaRota = await api().post(`/api/v1/coaches/${cadastro.id}/organizations`)
      .set(conta.auth())
      .send({ organizationId: orgOutra, reason: 'Autoconcessão.' });
    expect(pelaRota.status).toBe(403);

    // E o BANCO recusa a escrita direta, que é a barreira que sobra quando a
    // rota muda: a política nova só aceita a organização oficial.
    const noBanco = comoAtor(conta, tx => tx.coachOrganization.create({
      data: {
        coachId: cadastro.id, organizationId: orgOutra,
        status: 'APPROVED', autoGrantedAt: new Date()
      }
    }));
    await expect(noBanco).rejects.toThrow();
  });

  // ESTE TESTE NASCEU DE UM MUTANTE QUE SOBREVIVEU (NF-P2).
  //
  // A política nova é conjuntiva, e uma das condições é que o treinador da linha
  // seja o DA CONTA QUE INSERE. Nenhuma rota tenta o contrário — o serviço sempre
  // usa o cadastro do próprio autor —, então retirar essa condição da política
  // não reprovava teste nenhum: a barreira existia e não era medida. A vítima
  // precisa NÃO ter autorização na NPC, senão o índice único recusaria a linha
  // pelo motivo errado e o teste passaria sem medir a política.
  it('o treinador NÃO consegue autorizar OUTRO treinador na oficial', async () => {
    await comoAtor(central, tx => tx.affiliation.updateMany({ data: { active: false } }));
    const vitimaConta = await criarUsuario({ role: 'COACH', name: 'Treinador Sem Autorização' });
    const vitima = await cadastrar(vitimaConta, 'Treinador Sem Autorização');
    await comoAtor(central, tx => tx.affiliation.updateMany({ data: { active: true } }));

    expect(await comoAtor(central, tx => tx.coachOrganization.count({ where: { coachId: vitima.id } })),
      'a vítima entra no teste sem autorização nenhuma').toBe(0);

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    // A ESCRITA É CRUA, E SEM `RETURNING`, DE PROPÓSITO.
    //
    // A primeira versão deste teste usava `tx.coachOrganization.create`, e o
    // mutante SOBREVIVEU de novo: o Prisma escreve `INSERT ... RETURNING`, e o
    // `RETURNING` passa por `coach_org_leitura`, que só deixa o DONO da linha
    // (ou admin, ou operador da federação) ler. A recusa vinha da política de
    // LEITURA, não da condição do dono na política de ESCRITA — e medir a
    // barreira errada é o mesmo que não medir.
    const alheia = comoAtor(conta, tx => tx.$executeRawUnsafe(
      `INSERT INTO "CoachOrganization"
         ("id", "coachId", "organizationId", "status", "autoGrantedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'APPROVED', now(), now(), now())`,
      `alheia-${unico('cpo')}`, vitima.id, orgNpc
    ));
    await expect(alheia, 'autorizar treinador alheio é ato de federação').rejects.toThrow();

    expect(await comoAtor(central, tx => tx.coachOrganization.count({ where: { coachId: vitima.id } })),
      'e nada foi gravado no nome dela').toBe(0);
  });
});

describe('a equipe do treinador, criada por ele', () => {
  it('cria na NPC, com ele como responsável, e aparece na área dele', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const nome = unico('Equipe Marta');
    const criada = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: nome, city: 'Cuiabá', state: 'MT' });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    expect(criada.body.coachId, 'o responsável é quem pediu').toBe(cadastro.id);
    expect(criada.body.organizationId).toBe(orgNpc);

    const minhas = await api().get('/api/v1/coaches/me/teams').set(conta.auth());
    expect(minhas.status).toBe(200);
    expect(minhas.body.items.map(e => e.name)).toContain(nome);
  });

  it('o corpo NÃO escolhe o responsável nem a empresa', async () => {
    const outraConta = await criarUsuario({ role: 'COACH', name: 'Outro Treinador' });
    const outro = await cadastrar(outraConta, 'Outro Treinador');

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const criada = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe'), coachId: outro.id, companyId: 'qualquer' });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    expect(criada.body.coachId, 'o campo do corpo é ignorado, não obedecido').toBe(cadastro.id);

    const linha = await comoAtor(central, tx => tx.team.findUnique({
      where: { id: criada.body.id }, select: { companyId: true }
    }));
    expect(linha.companyId, 'empresa acima da equipe é decisão de federação').toBeNull();
  });

  it('renomeia a própria equipe, e NÃO alcança a de outro treinador', async () => {
    const outraConta = await criarUsuario({ role: 'COACH', name: 'Outro Treinador' });
    await cadastrar(outraConta, 'Outro Treinador');
    const alheia = await api().post('/api/v1/coaches/me/teams').set(outraConta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Alheia') });
    expect(alheia.status).toBe(201);

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');
    const minha = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Minha') });
    expect(minha.status).toBe(201);

    const novoNome = unico('Equipe Renomeada');
    const renomeada = await api().patch(`/api/v1/coaches/me/teams/${minha.body.id}`)
      .set(conta.auth()).send({ name: novoNome });
    expect(renomeada.status, JSON.stringify(renomeada.body)).toBe(200);
    expect(renomeada.body.name).toBe(novoNome);

    // 404 e não 403: quem pergunta por equipe alheia não descobre que ela existe.
    const naAlheia = await api().patch(`/api/v1/coaches/me/teams/${alheia.body.id}`)
      .set(conta.auth()).send({ name: unico('Sequestrada') });
    expect(naAlheia.status).toBe(404);
  });

  it('nome repetido na mesma federação é recusado com 409', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    const nome = unico('Equipe Única');
    expect((await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: nome })).status).toBe(201);

    const repetida = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: nome });
    expect(repetida.status).toBe(409);
    expect(repetida.body.error.code).toBe('TEAM_NAME_TAKEN');
  });

  it('quem NÃO é treinador não cria equipe por esta rota', async () => {
    const atleta = await criarUsuario({ name: 'Atleta Qualquer' });
    const tentativa = await api().post('/api/v1/coaches/me/teams').set(atleta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe do Atleta') });
    expect(tentativa.status).toBe(403);
  });

  it('a permissão nova NÃO vira poder de operador', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await cadastrar(conta, 'Marta Treinadora');

    // `POST /teams` é a rota do operador: `teams.create_own` não a abre.
    const pelaRotaDoOperador = await api().post('/api/v1/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe pela rota do operador') });
    expect(pelaRotaDoOperador.status).toBe(403);

    // E a fila de análise central segue fechada — R-03.
    expect((await api().get('/api/v1/coaches/review?status=PENDING').set(conta.auth())).status).toBe(403);
  });
});

// ESTE BLOCO NASCEU DE UM MUTANTE QUE SOBREVIVEU (NF-M8).
//
// Trocar o filtro do código NPC por "a primeira filiação ativa" não reprovava
// teste nenhum, porque no cenário montado a NPC era a ÚNICA filiação. Num
// ambiente real ela não é: cada federação estadual tem a sua entidade, e várias
// são anteriores à NPC. O que este bloco mede é que o serviço escolhe pelo
// MARCADOR — o mesmo que a política do banco consulta — e não pela ordem.
describe('a federação oficial é a do código NPC, e não a primeira da fila', () => {
  it('uma entidade estadual ANTERIOR não recebe a autorização automática', async () => {
    const estadual = await criarEntidadeOficial(orgOutra, {
      code: 'FEMT', name: 'Federação Estadual de Mato Grosso'
    });
    // A data é fixada à mão para que "anterior" não dependa de quantos
    // milissegundos separaram duas requisições HTTP.
    await comoAtor(central, tx => tx.affiliation.update({
      where: { id: estadual.id }, data: { createdAt: new Date('2020-01-01T00:00:00.000Z') }
    }));

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    const autorizadas = await comoAtor(central, tx => tx.coachOrganization.findMany({
      where: { coachId: cadastro.id }, select: { organizationId: true }
    }));
    expect(autorizadas.map(a => a.organizationId),
      'a automática só reconhece a entidade oficial').toEqual([orgNpc]);
  });
});

describe('instalação sem NPC provisionada', () => {
  it('o cadastro CONCLUI, sem autorização e com a ausência na trilha', async () => {
    // A entidade oficial é desativada: é o estado de uma instalação nova.
    await comoAtor(central, tx => tx.affiliation.updateMany({ data: { active: false } }));

    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await cadastrar(conta, 'Marta Treinadora');

    expect(cadastro.status, 'o cadastro não é punido por configuração de infraestrutura').toBe('APPROVED');
    expect(cadastro.organizations ?? []).toHaveLength(0);

    const linhas = await comoAtor(central, tx => tx.auditLog.findMany({
      where: { action: 'COACH_REGISTER' }, select: { metadata: true }
    }));
    expect(linhas.some(l => l.metadata?.federacaoOficial === null),
      'a ausência da federação oficial fica escrita').toBe(true);
  });
});

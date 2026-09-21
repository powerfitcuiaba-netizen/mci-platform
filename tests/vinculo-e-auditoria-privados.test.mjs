import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, comoAtor
} from './helpers.mjs';

// ============================================================================
// AS DUAS CLÁUSULAS INCONDICIONAIS QUE FORAM FECHADAS.
//
// Uma liberava LEITURA para todo mundo; a outra deixava a ESCRITA sem conferir.
// São problemas de natureza oposta, e por isso as provas também são:
//
//   · no vínculo de equipe, prova-se que quem NÃO deve ler não lê — e que quem
//     deve, continua lendo. Fechar demais não é acertar: seria trocar um
//     vazamento por uma tela quebrada;
//
//   · na auditoria, prova-se que uma linha não pode MENTIR sobre quem a
//     escreveu, nem ser escrita na trilha de outra federação, nem ser
//     reescrita ou apagada depois.
// ============================================================================

let admin, gerenteA, gerenteB, curiosa, orgA, orgB, equipeA, atletaA, pessoaDoAtleta;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  orgB = await criarOrganizacao(admin, { name: 'Federação B' });

  gerenteA = await criarUsuario({ name: 'Gerente da A' });
  await vincular(orgA.id, gerenteA, 'ADMIN');
  gerenteB = await criarUsuario({ name: 'Gerente da B' });
  await vincular(orgB.id, gerenteB, 'ADMIN');

  // Alguém autenticado que não é operador de nada. É o ator mais informativo
  // de todos: não é anônimo (então não cai em política de visitante) e não
  // tem papel (então nada deveria se abrir para ele).
  curiosa = await criarUsuario({ name: 'Curiosa Autenticada' });

  equipeA = (await api().post('/api/v1/teams').set(admin.auth())
    .send({ organizationId: orgA.id, name: 'Equipe da A' })).body;

  pessoaDoAtleta = await criarUsuario({ name: 'Atleta da A' });
  atletaA = await criarAtleta(admin, orgA.id, {
    fullName: 'ATLETA DA A', cpf: gerarCpf(454545454), userId: pessoaDoAtleta.id
  });

  await api().post(`/api/v1/athletes/${atletaA.id}/team`).set(admin.auth())
    .send({ teamId: equipeA.id, reason: 'Entrada na temporada' });
});

describe('o vínculo de equipe deixou de ser público', () => {
  it('o ANÔNIMO não lê vínculo nenhum', async () => {
    // `prisma` fora de `comoAtor` é o leitor sem ator: é o que a política
    // enxerga quando ninguém está autenticado.
    expect(await prisma.athleteTeamMembership.count()).toBe(0);
  });

  it('a autenticada SEM PAPEL também não lê', async () => {
    const vistos = await comoAtor(curiosa, tx => tx.athleteTeamMembership.count());
    expect(vistos, 'estar logada não é permissão').toBe(0);
  });

  it('o operador da federação VIZINHA não lê, nem com o id na mão', async () => {
    const vinculo = await comoAtor(gerenteA, tx => tx.athleteTeamMembership.findFirst());
    expect(vinculo, 'o cenário precisa ter um vínculo').toBeTruthy();

    const daVizinha = await comoAtor(gerenteB, async tx => ({
      quantos: await tx.athleteTeamMembership.count(),
      porId: await tx.athleteTeamMembership.findUnique({ where: { id: vinculo.id } })
    }));
    expect(daVizinha.quantos).toBe(0);
    expect(daVizinha.porId).toBeNull();
  });

  it('o operador da PRÓPRIA federação continua lendo — fechar demais não é acertar', async () => {
    const vistos = await comoAtor(gerenteA, tx => tx.athleteTeamMembership.findMany());
    expect(vistos).toHaveLength(1);
    expect(vistos[0].teamId).toBe(equipeA.id);
    // O motivo é texto livre escrito pelo operador, e era o que mais doía na
    // leitura aberta: ele conta por que alguém saiu de uma equipe.
    expect(vistos[0].reason).toBe('Entrada na temporada');
  });

  it('o DONO lê o próprio vínculo — é a tela "minha filiação"', async () => {
    const meus = await comoAtor(pessoaDoAtleta, tx => tx.athleteTeamMembership.findMany());
    expect(meus, 'o atleta precisa enxergar a própria equipe').toHaveLength(1);
    expect(meus[0].athleteId).toBe(atletaA.id);
  });

  it('e o dono NÃO lê o vínculo de outro atleta', async () => {
    const outroAtleta = await criarAtleta(admin, orgA.id, {
      fullName: 'OUTRA ATLETA', cpf: gerarCpf(464646464)
    });
    await api().post(`/api/v1/athletes/${outroAtleta.id}/team`).set(admin.auth())
      .send({ teamId: equipeA.id, reason: 'Também entrou' });

    const meus = await comoAtor(pessoaDoAtleta, tx => tx.athleteTeamMembership.findMany());
    expect(meus, 'o dono lê o dele, e só o dele').toHaveLength(1);
    expect(meus[0].athleteId).toBe(atletaA.id);
  });

  it('a rota de histórico continua funcionando para quem tem permissão', async () => {
    const resposta = await api().get(`/api/v1/athletes/${atletaA.id}/team-history`)
      .set(gerenteA.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toHaveLength(1);
  });

  it('e recusa quem não tem', async () => {
    const resposta = await api().get(`/api/v1/athletes/${atletaA.id}/team-history`)
      .set(gerenteB.auth());
    expect([403, 404]).toContain(resposta.status);
  });
});

describe('a auditoria não aceita linha que mente', () => {
  // `createMany`, E NÃO `create`, E O MOTIVO É SUTIL.
  //
  // `create` do Prisma emite `INSERT ... RETURNING`, e o PostgreSQL aplica a
  // política de SELECT ao `RETURNING` — além do `WITH CHECK` do INSERT. Como a
  // LEITURA da auditoria é restrita a operador, um usuário comum gravando a
  // própria linha teria a escrita aceita e a devolução recusada, com a
  // mensagem "new row violates row-level security policy", que aponta para o
  // lugar errado.
  //
  // `audit.record` usa `createMany` justamente por não devolver a linha. Medir
  // com `create` mediria uma coisa que a aplicação não faz — e acusaria de
  // defeito uma política correta.
  const escreverAuditoria = (ator, dados) => comoAtor(ator, tx => tx.auditLog.createMany({
    data: {
      action: 'TESTE', entity: 'Teste',
      userEmail: null, entityId: null, ip: null, ...dados
    }
  }));

  it('NÃO se assina no lugar de outro', async () => {
    // A curiosa tenta gravar uma linha dizendo que foi o ADMIN quem agiu. É a
    // forja que mais importa: uma trilha em que qualquer um escreve
    // "SUPER_ADMIN apagou o resultado" não serve para apurar nada.
    await expect(escreverAuditoria(curiosa, { userId: admin.id }))
      .rejects.toThrow();
  });

  it('assinar com o PRÓPRIO id é aceito', async () => {
    const escrita = await escreverAuditoria(curiosa, { userId: curiosa.id });
    expect(escrita.count).toBe(1);
  });

  it('NÃO se escreve na trilha de outra federação', async () => {
    // O gerente da A tenta gravar na trilha da B. Ele é operador — de outra
    // organização —, e é exatamente por isso que o caso interessa.
    await expect(escreverAuditoria(gerenteA, { userId: gerenteA.id, organizationId: orgB.id }))
      .rejects.toThrow();
  });

  it('na trilha da PRÓPRIA federação, escreve', async () => {
    const escrita = await escreverAuditoria(gerenteA, {
      userId: gerenteA.id, organizationId: orgA.id
    });
    expect(escrita.count).toBe(1);
  });

  it('o atleta escreve na trilha da organização em que TEM cadastro', async () => {
    // Este caso não é teórico: foi medido. Numa amostra de 987 escritas de
    // auditoria da suíte, 22 tinham organização SEM o ator ser membro dela, e
    // todas eram a mesma ação — o atleta abrindo o próprio pedido de cadastro.
    // Um predicado que exigisse `member_of` teria derrubado esse caso, e
    // derrubado em silêncio, porque `audit.record` engole a falha.
    const escrita = await escreverAuditoria(pessoaDoAtleta, {
      userId: pessoaDoAtleta.id, organizationId: orgA.id
    });
    expect(escrita.count).toBe(1);
  });

  it('mas não na de uma federação com que não tem ligação nenhuma', async () => {
    await expect(escreverAuditoria(pessoaDoAtleta, {
      userId: pessoaDoAtleta.id, organizationId: orgB.id
    })).rejects.toThrow();
  });

  it('o ANÔNIMO não assina como ninguém', async () => {
    // Sem sessão, `mci_current_user_id()` é nulo: a linha só passaria com
    // `userId` nulo também. Com o id de alguém, não passa.
    await expect(prisma.auditLog.createMany({
      data: { action: 'TESTE', entity: 'Teste', userId: admin.id }
    })).rejects.toThrow();
  });
});

describe('a auditoria é append-only', () => {
  it('não se reescreve', async () => {
    const linha = await comoAtor(gerenteA, tx => tx.auditLog.create({
      data: { action: 'ORIGINAL', entity: 'Teste', userId: gerenteA.id, organizationId: orgA.id }
    }));

    // `updateMany` não lança quando a política filtra: ela some do `where` e o
    // comando conta zero. É a forma honesta de medir — e o zero é a prova.
    const alterados = await comoAtor(gerenteA, tx => tx.auditLog.updateMany({
      where: { id: linha.id }, data: { action: 'ADULTERADA' }
    }));
    expect(alterados.count, 'auditoria não se reescreve').toBe(0);

    const depois = await comoAtor(gerenteA, tx => tx.auditLog.findUnique({ where: { id: linha.id } }));
    expect(depois.action, 'o registro original tem de continuar intacto').toBe('ORIGINAL');
  });

  it('não se apaga', async () => {
    const linha = await comoAtor(gerenteA, tx => tx.auditLog.create({
      data: { action: 'PERMANENTE', entity: 'Teste', userId: gerenteA.id, organizationId: orgA.id }
    }));

    const apagados = await comoAtor(gerenteA, tx => tx.auditLog.deleteMany({ where: { id: linha.id } }));
    expect(apagados.count, 'auditoria não se apaga').toBe(0);

    const depois = await comoAtor(gerenteA, tx => tx.auditLog.findUnique({ where: { id: linha.id } }));
    expect(depois, 'o registro continua lá').toBeTruthy();
  });

  it('nem pelo administrador da plataforma', async () => {
    // A regra não tem exceção por papel: quem apaga trilha de auditoria é
    // justamente quem teria motivo para apagá-la.
    const linha = await comoAtor(admin, tx => tx.auditLog.create({
      data: { action: 'DO ADMIN', entity: 'Teste', userId: admin.id }
    }));
    expect(await comoAtor(admin, tx => tx.auditLog.deleteMany({ where: { id: linha.id } })))
      .toEqual({ count: 0 });
    expect(await comoAtor(admin, tx => tx.auditLog.updateMany({
      where: { id: linha.id }, data: { action: 'X' } }))).toEqual({ count: 0 });
  });

  it('a LEITURA continua restrita como antes', async () => {
    await comoAtor(gerenteA, tx => tx.auditLog.create({
      data: { action: 'DA A', entity: 'Teste', userId: gerenteA.id, organizationId: orgA.id }
    }));

    // Escopado em orgA: a vizinha tem trilha PRÓPRIA (o cenário a criou), e
    // contar tudo mediria a existência dela, não o isolamento.
    expect(await comoAtor(gerenteB, tx => tx.auditLog.count({ where: { organizationId: orgA.id } })),
      'a vizinha não lê a trilha da A').toBe(0);
    expect(await comoAtor(curiosa, tx => tx.auditLog.count()),
      'autenticada sem papel não lê trilha nenhuma').toBe(0);
    expect(await prisma.auditLog.count(), 'o anônimo não lê nada').toBe(0);
    expect(await comoAtor(gerenteA, tx => tx.auditLog.count()),
      'o operador lê a própria').toBeGreaterThan(0);
  });
});

describe('o acoplamento invisível que isso deixou', () => {
  it('`audit.record` tem de usar `createMany` — `create` quebraria em silêncio', async () => {
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync('src/services/auditService.js', 'utf8');

    // Se alguém trocar por `create`, o `RETURNING` passa a exigir a política de
    // SELECT: todo registro escrito por quem não é operador seria recusado. E
    // `record` engole a falha e segue — então a auditoria sumiria sem nenhum
    // sintoma além de uma linha no log que ninguém lê.
    expect(fonte).toContain('auditLog.createMany');
    expect(fonte, 'auditLog.create() emite RETURNING e exige a política de leitura')
      .not.toMatch(/auditLog\.create\(/);
  });
});

describe('a aplicação continua auditando pelo caminho normal', () => {
  it('criar atleta pelo operador deixa rastro, com o autor correto', async () => {
    const antes = await comoAtor(gerenteA, tx => tx.auditLog.count({
      where: { organizationId: orgA.id, action: 'ATHLETE_CREATE' }
    }));

    await criarAtleta(gerenteA, orgA.id, { fullName: 'NOVA ATLETA', cpf: gerarCpf(474747474) });

    const registros = await comoAtor(gerenteA, tx => tx.auditLog.findMany({
      where: { organizationId: orgA.id, action: 'ATHLETE_CREATE' }
    }));
    expect(registros.length, 'a política nova não pode ter apagado a auditoria real')
      .toBe(antes + 1);
    expect(registros[registros.length - 1].userId).toBe(gerenteA.id);
  });
});

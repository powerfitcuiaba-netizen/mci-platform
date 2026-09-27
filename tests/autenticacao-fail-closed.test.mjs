import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { api, prisma, comoAtor, limparBanco, garantirCatalogo, criarUsuario, unico } from './helpers.mjs';

// ============================================================================
// AS DUAS DECISÕES APROVADAS: TENTATIVA RECUSADA ENTRA NA TRILHA, E SEM TRILHA
// NÃO SE ENTRA.
//
// A — `LOGIN_FAILED`. Credencial inválida não deixava rastro nenhum: uma
//     varredura de senhas contra uma conta era invisível para quem audita. A
//     linha nova carrega o MÍNIMO — conta alvo por identificador interno, motivo
//     e se havia conta do outro lado. Nunca a senha, nunca o e-mail tentado.
//
// B — FAIL CLOSED. Se a auditoria obrigatória não persistir, a autenticação não
//     se completa: login não emite token, cadastro não cria conta.
//
// COMO A FALHA DE AUDITORIA É FORÇADA AQUI, e por que assim: um GATILHO no
// banco que levanta exceção no INSERT de `AuditLog`. É a simulação honesta de
// "trilha indisponível" — a recusa vem do banco, no mesmo lugar em que viria uma
// indisponibilidade real, e não de um espião em módulo que o app talvez nem
// use (a suíte já mediu que a instância importada aqui NÃO é a do app).
//
// O gatilho é ADITIVO e temporário: criado no caso, removido no `finally`.
// NENHUMA política é afrouxada, removida ou recriada para teste nenhum — o que
// se faz é impedir a escrita, que é justamente o cenário sob prova.
// ============================================================================

const SENHA = 'senha-de-teste-123';
const CADASTRO = Object.freeze({
  password: SENHA,
  birthDate: '1995-03-10',
  phone: '65999991234',
  whatsapp: '65988884321',
  postalCode: '78000000',
  addressLine: 'Rua de Teste',
  addressNumber: '100',
  state: 'MT',
  city: 'Cuiabá'
});

const trilhaDe = (admin, where) => comoAtor(admin, tx => tx.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } }));

// AS LINHAS QUE ESTE CASO PRODUZIU, e não as que a trilha acumulou.
//
// O banco é limpo uma vez por arquivo, então contagem absoluta de trilha depende
// da ordem dos casos — e teste que depende de ordem reprova por motivo inventado.
// A medição certa é o DELTA: fotografa os ids antes, e compara depois.
async function linhasNovas(admin, where, corpo) {
  const antes = new Set((await trilhaDe(admin, where)).map(l => l.id));
  const resultado = await corpo();
  const depois = await trilhaDe(admin, where);
  return { resultado, novas: depois.filter(l => !antes.has(l.id)) };
}

const GATILHO = 'mci_teste_trilha_indisponivel';

async function bloquearTrilha() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${GATILHO}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION 'trilha de auditoria indisponivel (simulado pelo teste)'; END
    $fn$`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${GATILHO} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${GATILHO}()`
  );
}

async function liberarTrilha() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${GATILHO} ON "AuditLog"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${GATILHO}()`);
}

/** Roda o corpo com a trilha indisponível, e devolve o banco ao estado anterior. */
async function comTrilhaIndisponivel(corpo) {
  await bloquearTrilha();
  try {
    return await corpo();
  } finally {
    await liberarTrilha();
  }
}

const entrar = (email, senha = SENHA) => api().post('/api/v1/auth/login').send({ email, password: senha });
const cadastrar = (nome, email, extras = {}) => api()
  .post('/api/v1/auth/register').send({ ...CADASTRO, name: nome, email, ...extras });

beforeAll(async () => {
  await limparBanco();
  garantirCatalogo();
});

// Rede de segurança: se um caso quebrar no meio, o gatilho não pode vazar para o
// próximo — ele faria a suíte inteira reprovar por uma razão inventada.
afterEach(liberarTrilha);

describe('A — a tentativa recusada entra na trilha', () => {
  it('senha errada em conta existente grava LOGIN_FAILED com o mínimo necessário', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });

    const { resultado: recusa, novas } = await linhasNovas(admin, { action: 'LOGIN_FAILED' },
      () => entrar(pessoa.email, 'senha-errada-mesmo'));
    expect(recusa.status).toBe(401);
    expect(recusa.body.error.code).toBe('INVALID_CREDENTIALS');

    expect(novas, 'a tentativa recusada precisa estar na trilha').toHaveLength(1);
    const linha = novas[0];

    // O AUTOR É DESCONHECIDO — é o que a tentativa recusada significa. `userId`
    // nulo é o que impede a linha de dizer que a vítima fez a ação, e é o que
    // deixa a política aceitá-la sem contexto de ator nenhum.
    expect(linha.userId, 'tentativa recusada não tem autor conhecido').toBeNull();
    // A CONTA ALVO, por identificador INTERNO. Nunca o e-mail.
    expect(linha.entity).toBe('User');
    expect(linha.entityId).toBe(pessoa.id);
    expect(linha.userEmail, 'e-mail não entra na linha').toBeNull();
    expect(linha.organizationId, 'é ação de plataforma').toBeNull();
    expect(Object.keys(linha.metadata).sort()).toEqual(['contaExistente', 'motivo']);
    expect(linha.metadata.motivo).toBe('INVALID_CREDENTIALS');
    expect(linha.metadata.contaExistente).toBe(true);
  });

  it('conta inexistente responde IGUAL e grava o evento sem identificar ninguém', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });

    const { resultado, novas } = await linhasNovas(admin, { action: 'LOGIN_FAILED' }, async () => ({
      inexistente: await entrar(`${unico('fantasma')}@mci.test`, 'qualquer-senha-123'),
      senhaErrada: await entrar(pessoa.email, 'senha-errada-mesmo')
    }));
    const { inexistente, senhaErrada } = resultado;

    // A RESPOSTA NÃO DIFERENCIA OS DOIS CASOS: é o que impede enumeração de
    // contas. A trilha diferencia, e ela só é legível por administrador.
    expect(inexistente.status).toBe(senhaErrada.status);
    expect(inexistente.body).toEqual(senhaErrada.body);

    expect(novas, 'as duas tentativas entram na trilha').toHaveLength(2);
    const doFantasma = novas.find(l => l.metadata.contaExistente === false);
    expect(doFantasma, 'a tentativa contra conta inexistente também é registrada').toBeTruthy();
    expect(doFantasma.entityId, 'não há conta para apontar').toBeNull();
    expect(doFantasma.userId).toBeNull();
    expect(doFantasma.userEmail, 'o e-mail tentado NÃO é gravado').toBeNull();
  });

  it('conta inativa grava o motivo próprio, e mantém o contrato de 403', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Suspensa' });
    await prisma.user.update({ where: { id: pessoa.id }, data: { status: 'SUSPENDED' } });

    const recusa = await entrar(pessoa.email);
    expect(recusa.status).toBe(403);
    expect(recusa.body.error.code).toBe('USER_INACTIVE');

    const trilha = await trilhaDe(admin, { action: 'LOGIN_FAILED', entityId: pessoa.id });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].metadata.motivo).toBe('USER_INACTIVE');
    expect(trilha[0].userId).toBeNull();
  });

  it('nenhum segredo entra na trilha, no metadado ou na resposta', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });
    const senhaTentada = 'ProvaDeVazamento#2026';

    const recusa = await entrar(pessoa.email, senhaTentada);

    const inteira = await trilhaDe(admin, {});
    const comoTexto = JSON.stringify(inteira);
    expect(comoTexto).not.toContain(senhaTentada);
    expect(comoTexto).not.toContain(SENHA);
    expect(comoTexto).not.toMatch(/\$2[aby]\$/); // nenhum hash bcrypt
    expect(comoTexto).not.toMatch(/password|senha|token|cookie|authorization/i);
    // E a resposta ao cliente também não devolve nada disso.
    expect(JSON.stringify(recusa.body)).not.toContain(senhaTentada);
    expect(recusa.headers['set-cookie']).toBeUndefined();
  });

  it('o cliente não consegue atribuir a falha a outro usuário, organização ou papel', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const vitima = await criarUsuario({ name: 'Vítima' });

    // Campos inventados no corpo do pedido: o Zod os descarta, e mesmo que não
    // descartasse, nada no caminho da auditoria lê identidade do cliente.
    const { resultado: recusa, novas } = await linhasNovas(admin, { action: 'LOGIN_FAILED' }, () => api()
      .post('/api/v1/auth/login').send({
        email: `${unico('atacante')}@mci.test`,
        password: 'qualquer-senha-123',
        userId: vitima.id,
        actorId: vitima.id,
        organizationId: 'org-inventada',
        role: 'SUPER_ADMIN',
        metadata: { motivo: 'FORJADO' }
      }));
    expect(recusa.status).toBe(401);

    expect(novas).toHaveLength(1);
    expect(novas[0].userId, 'nada de assinar pela vítima').toBeNull();
    expect(novas[0].entityId, 'a conta não existe: não há alvo a apontar').toBeNull();
    expect(novas[0].organizationId, 'organização não vem do cliente').toBeNull();
    expect(novas[0].metadata.motivo).toBe('INVALID_CREDENTIALS');
  });
});

describe('B — sem trilha não se entra (fail closed no login)', () => {
  it('login com credencial VÁLIDA não emite token quando a trilha não persiste', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta' });

    const resposta = await comTrilhaIndisponivel(() => entrar(pessoa.email));

    expect(resposta.status, 'a autenticação não pode ser dada por concluída').toBeGreaterThanOrEqual(500);
    expect(resposta.body.token, 'nenhum token').toBeUndefined();
    expect(resposta.body.user, 'nenhum usuário devolvido').toBeUndefined();
    expect(resposta.headers['set-cookie'], 'nenhum cookie de sessão').toBeUndefined();
    // A resposta não conta ao cliente o que houve por dentro.
    expect(JSON.stringify(resposta.body)).not.toMatch(/auditoria|AuditLog|policy|trigger|trilha/i);

    // PROVA DE QUE NÃO HÁ CREDENCIAL UTILIZÁVEL: o que veio na resposta não abre
    // rota autenticada nenhuma. Não há sessão no servidor para conferir — a
    // sessão desta plataforma É o token —, então a prova é o token não existir e
    // o que existe não ser aceito.
    const comOQueVeio = await api().get('/api/v1/auth/me')
      .set({ Authorization: `Bearer ${resposta.body.token}` });
    expect(comOQueVeio.status).toBe(401);
  });

  it('com a trilha indisponível, senha certa e senha errada respondem IGUAL', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta' });

    const { certa, errada } = await comTrilhaIndisponivel(async () => ({
      certa: await entrar(pessoa.email),
      errada: await entrar(pessoa.email, 'senha-errada-mesmo')
    }));

    // SEM ISTO, A FALHA DE AUDITORIA VIRARIA ORÁCULO DE SENHA: 503 para a senha
    // certa e 401 para a errada diria ao atacante qual das duas ele acertou,
    // justamente quando o sistema está cego para registrar a tentativa.
    expect(certa.status).toBe(errada.status);
    expect(certa.body).toEqual(errada.body);
    expect(certa.body.token).toBeUndefined();
    expect(errada.body.token).toBeUndefined();
  });

  it('a trilha voltando, o login volta a funcionar — o fechamento não é permanente', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta' });

    const durante = await comTrilhaIndisponivel(() => entrar(pessoa.email));
    expect(durante.status).toBeGreaterThanOrEqual(500);

    const depois = await entrar(pessoa.email);
    expect(depois.status).toBe(200);
    expect(typeof depois.body.token).toBe('string');
  });
});

describe('B — sem trilha não se cadastra (fail closed no cadastro)', () => {
  it('cadastro não deixa conta nem sessão quando a trilha não persiste', async () => {
    const email = `${unico('sem-trilha')}@mci.test`;

    const resposta = await comTrilhaIndisponivel(() => cadastrar('Sem Trilha', email));

    expect(resposta.status).toBeGreaterThanOrEqual(500);
    expect(resposta.body.token, 'nenhuma sessão').toBeUndefined();
    expect(resposta.headers['set-cookie']).toBeUndefined();

    // A PROVA MAIS FORTE: a conta não existe. A transação do cadastro voltou
    // atrás inteira — não há conta órfã para alguém "recuperar" depois, e nada
    // foi apagado por compensação: nunca chegou a ser gravado.
    expect(await prisma.user.findUnique({ where: { email } }), 'nenhuma conta criada').toBeNull();
    expect(await prisma.socialProfile.count({ where: { displayName: 'Sem Trilha' } })).toBe(0);
  });

  it('o cadastro recusado não toca as contas que já existiam', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const antiga = await criarUsuario({ name: 'Conta Antiga' });
    const quantasAntes = await prisma.user.count();

    await comTrilhaIndisponivel(() => cadastrar('Nova Recusada', `${unico('recusada')}@mci.test`));

    expect(await prisma.user.count(), 'nenhuma conta a mais, nenhuma a menos').toBe(quantasAntes);
    expect(await prisma.user.findUnique({ where: { id: antiga.id } }), 'a conta antiga continua lá').toBeTruthy();

    // E ela continua funcionando.
    const entrada = await entrar(antiga.email);
    expect(entrada.status).toBe(200);
    expect((await trilhaDe(admin, { action: 'LOGIN', userId: antiga.id })).length).toBeGreaterThan(0);
  });

  it('nenhuma conta existe sem o seu evento de cadastro — nem sob repetição simultânea', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const email = `${unico('corrida')}@mci.test`;

    // Duas requisições iguais ao mesmo tempo: a unicidade do e-mail é a
    // autoridade, e o que se mede aqui é que a corrida não produz conta sem
    // trilha nem trilha sem conta.
    const respostas = await Promise.all([
      cadastrar('Corrida Um', email),
      cadastrar('Corrida Dois', email)
    ]);

    const criados = respostas.filter(r => r.status === 201);
    const conflitos = respostas.filter(r => r.status === 409);
    expect(criados).toHaveLength(1);
    expect(conflitos).toHaveLength(1);

    const conta = await prisma.user.findUnique({ where: { email } });
    expect(conta).toBeTruthy();
    const trilha = await trilhaDe(admin, { action: 'USER_REGISTER', entityId: conta.id });
    expect(trilha, 'uma conta, um evento de cadastro').toHaveLength(1);
    expect(trilha[0].userId).toBe(conta.id);
  });

  it('cadastro normal segue devolvendo 201, token e trilha', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const email = `${unico('normal')}@mci.test`;

    const resposta = await cadastrar('Cadastro Normal', email);
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(typeof resposta.body.token).toBe('string');

    const trilha = await trilhaDe(admin, { action: 'USER_REGISTER', entityId: resposta.body.user.id });
    expect(trilha).toHaveLength(1);

    // O token devolvido é utilizável: o cadastro não ficou meio feito.
    const eu = await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${resposta.body.token}` });
    expect(eu.status).toBe(200);
    expect(eu.body.user.email).toBe(email);
  });

  it('o perfil social é criado dentro da transação, e um handle repetido não a envenena', async () => {
    // MESMO PREFIXO DE E-MAIL, domínios diferentes: o segundo cadastro colide no
    // handle e precisa tentar outro. Fora de transação isso sempre funcionou;
    // dentro dela, sem ponto de retorno, o INSERT recusado abortaria a transação
    // inteira e o cadastro morreria com 25P02. Este teste é a trava disso.
    const prefixo = unico('mesmohandle').replace(/[^a-z0-9]/g, '');
    const primeiro = await cadastrar('Primeiro Handle', `${prefixo}@um.mci.test`);
    const segundo = await cadastrar('Segundo Handle', `${prefixo}@dois.mci.test`);

    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(201);
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(201);

    const perfis = await prisma.socialProfile.findMany({
      where: { userId: { in: [primeiro.body.user.id, segundo.body.user.id] } },
      select: { handle: true }
    });
    expect(perfis).toHaveLength(2);
    expect(new Set(perfis.map(p => p.handle)).size, 'handles distintos').toBe(2);
  });
});

describe('D — nada disso afrouxou o RLS', () => {
  const inserir = (tx, { userId, organizationId = null, action = 'LOGIN_FAILED' }) => tx.$executeRawUnsafe(
    `INSERT INTO "AuditLog" ("id","organizationId","userId","userEmail","action","entity","entityId","ip","createdAt")
     VALUES ($1, $2, $3, NULL, $4, 'User', $3, NULL, now())`,
    `sonda-${Math.random().toString(36).slice(2)}`, organizationId, userId, action
  );

  it('anônimo continua sem conseguir gravar linha ATRIBUÍDA a alguém', async () => {
    const alvo = await criarUsuario({ name: 'Alvo' });

    // A sonda P1/P3 do diagnóstico, aqui como teste: a linha com `userId` de
    // outra pessoa, sem contexto, continua recusada. É isso que separa "registrar
    // que houve tentativa" de "escrever no nome de alguém".
    await expect(inserir(prisma, { userId: alvo.id }))
      .rejects.toThrow(/row-level security|violates/i);
  });

  it('ator comum continua sem assinar pelo outro e sem escrever em trilha alheia', async () => {
    const autor = await criarUsuario({ name: 'Autor' });
    const outro = await criarUsuario({ name: 'Outro' });

    await expect(comoAtor(autor, tx => inserir(tx, { userId: outro.id })))
      .rejects.toThrow(/row-level security|violates/i);
  });

  it('a trilha de tentativas recusadas NÃO é legível por usuário comum', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });
    const { novas } = await linhasNovas(admin, { action: 'LOGIN_FAILED' },
      () => entrar(pessoa.email, 'senha-errada-mesmo'));
    expect(novas, 'a tentativa desta pessoa está na trilha').toHaveLength(1);

    // Nem pela rota, nem pelo banco: uma linha que diz "houve tentativa contra
    // esta conta" é informação de segurança, não de perfil.
    expect((await api().get('/api/v1/audit').set(pessoa.auth())).status).toBe(403);
    expect(await comoAtor(pessoa, tx => tx.auditLog.findMany({ where: { action: 'LOGIN_FAILED' } }))).toHaveLength(0);
  });

  it('as políticas de AuditLog continuam duas, restritivas, e a tabela segue FORÇADA', async () => {
    const politicas = await prisma.$queryRawUnsafe(`
      SELECT policyname, cmd, coalesce(qual, '') AS usando, coalesce(with_check, '') AS checando
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AuditLog' ORDER BY policyname
    `);
    const porNome = Object.fromEntries(politicas.map(p => [p.policyname, p]));

    expect(Object.keys(porNome).sort()).toEqual(['auditoria_escrita', 'auditoria_leitura']);
    expect(politicas.map(p => p.cmd).sort()).toEqual(['INSERT', 'SELECT']);
    expect(porNome.auditoria_escrita.checando).toMatch(/mci_current_user_id\(\)/);
    // Nada de porta larga: nem USING(true) na leitura, nem WITH CHECK(true) na escrita.
    expect(porNome.auditoria_escrita.checando.trim()).not.toBe('true');
    expect(porNome.auditoria_leitura.usando.trim()).not.toBe('true');

    const [forca] = await prisma.$queryRawUnsafe(
      `SELECT relrowsecurity AS ligado, relforcerowsecurity AS forcado FROM pg_class WHERE relname = 'AuditLog'`
    );
    expect(forca.ligado).toBe(true);
    expect(forca.forcado).toBe(true);
  });

  it('nenhuma função privilegiada nova apareceu para escrever na trilha', async () => {
    // `SECURITY DEFINER` é o atalho que esta correção recusou. Se um dia aparecer
    // um, é aqui que a suíte avisa.
    const definers = await prisma.$queryRawUnsafe(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND p.proname LIKE 'mci%'
    `);
    expect(definers, `funções SECURITY DEFINER inesperadas: ${JSON.stringify(definers)}`).toHaveLength(0);
  });
});

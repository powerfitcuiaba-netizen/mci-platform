import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { app, api, prisma, comoAtor, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, unico } from './helpers.mjs';

const { default: audit } = await import('../src/services/auditService.js');

// ============================================================================
// A TRILHA DE AUTENTICAÇÃO — ENTRAR E SE CADASTRAR DEIXAM RASTRO.
//
// O DEFEITO QUE ESTA SUÍTE PRENDE, medido em
// `scripts/qa/diagnostico-auditoria-autenticacao.mjs`: `/auth/login` e
// `/auth/register` são as únicas rotas que gravam auditoria sem `req.user` — por
// construção, porque é dentro delas que a identidade nasce. Sem `req.user`,
// `asyncHandler` não abre transação; sem transação não há `SET LOCAL
// mci.user_id`; e a política `auditoria_escrita`, que exige que o `userId` da
// linha seja o ator da sessão, recusava o INSERT com 42501. O login respondia
// 200, o cadastro respondia 201, e a trilha se perdia em silêncio. Foram 17
// eventos perdidos numa única execução de QA visual.
//
// A CORREÇÃO NÃO AFROUXOU NADA, e é isso que a metade de baixo deste arquivo
// mede: a política continua recusando assinatura no lugar de outro, escrita na
// trilha de federação alheia, leitura por quem não pode, e adulteração de linha
// já gravada. O que mudou é que o registro do evento passou a acontecer DENTRO
// do contexto do ator que a autenticação acabou de estabelecer.
//
// NENHUMA POLÍTICA FOI ALTERADA POR ESTA CORREÇÃO. O último teste confere o
// TEXTO das políticas vivas no banco, para que um afrouxamento futuro — feito
// para "fazer o teste passar" — reprove aqui.
// ============================================================================

const CADASTRO = Object.freeze({
  password: 'senha-de-teste-123',
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

// ============================================================================
// O CONTADOR DO TESTE NÃO É O CONTADOR DO APP — medido, e a diferença importa.
//
// `await import('../src/services/auditService.js')` daqui devolve uma instância
// de módulo DIFERENTE da que `src/app.js` carrega por `require`. Medido com
// sonda: depois de um cadastro pelo HTTP com o defeito reposto, a instância
// importada aqui marcava `falhas: 0` e a do app marcava `falhas: 3`.
//
// A consequência prática é séria: uma afirmação sobre `audit.estadoDaTrilha()`
// depois de uma chamada HTTP passaria SEMPRE, com defeito ou sem ele — e teria
// dado a esta suíte um teste cego, do tipo que tranquiliza sem medir.
//
// Então a divisão é explícita: o que acontece DENTRO do processo de teste é
// medido na instância importada; o que acontece PELO HTTP é medido na rota
// `GET /audit/integrity`, que necessariamente lê o contador do app.
const integridadePelaRota = async admin => {
  const resposta = await api().get('/api/v1/audit/integrity').set(admin.auth());
  expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
  return resposta.body;
};

beforeAll(async () => {
  await limparBanco();
  garantirCatalogo();
});

beforeEach(() => {
  // Cada caso mede a SUA contagem de falhas: herdar a do caso anterior tornaria
  // o resultado dependente da ordem de execução.
  audit.reiniciarContagemDeFalhas();
});

describe('a autenticação deixa trilha', () => {
  it('o cadastro deixa USER_REGISTER com o ator, o e-mail e a entidade certos', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const email = `${unico('cadastro')}@mci.test`;

    const resposta = await api().post('/api/v1/auth/register').send({ ...CADASTRO, name: 'Pessoa Nova', email });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const trilha = await trilhaDe(admin, { action: 'USER_REGISTER', entityId: resposta.body.user.id });
    expect(trilha, 'cadastro sem trilha é cadastro sem rastro').toHaveLength(1);
    expect(trilha[0].userId, 'a trilha aponta para quem se cadastrou').toBe(resposta.body.user.id);
    expect(trilha[0].userEmail).toBe(email);
    expect(trilha[0].entity).toBe('User');
    // Ação de plataforma: não pertence a federação nenhuma.
    expect(trilha[0].organizationId).toBeNull();
  });

  it('a entrada deixa LOGIN, e uma segunda entrada deixa um SEGUNDO evento', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });

    // `criarUsuario` já entra uma vez. Esta é a segunda.
    const segunda = await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: CADASTRO.password });
    expect(segunda.status).toBe(200);

    const trilha = await trilhaDe(admin, { action: 'LOGIN', userId: pessoa.id });
    // DUAS entradas, DUAS linhas. Evento de auditoria é FATO, não estado: não há
    // idempotência a impor aqui, e deduplicar esconderia a segunda entrada.
    expect(trilha, 'duas entradas geram duas linhas').toHaveLength(2);
    expect(trilha.every(linha => linha.entity === 'User' && linha.entityId === pessoa.id)).toBe(true);
  });

  it('cadastrar e entrar não acrescentam NENHUMA falha de auditoria', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const antes = await integridadePelaRota(admin);

    const email = `${unico('limpo')}@mci.test`;
    await api().post('/api/v1/auth/register').send({ ...CADASTRO, name: 'Sem Falha', email });
    await api().post('/api/v1/auth/login').send({ email, password: CADASTRO.password });

    const depois = await integridadePelaRota(admin);
    // DELTA, e não valor absoluto: o contador é do processo e atravessa a suíte
    // inteira. O que este teste afirma é que ESTAS duas operações não falham —
    // com o defeito reposto, o delta é 2.
    expect(depois.falhas - antes.falhas, 'cadastrar e entrar não podem falhar em gravar trilha').toBe(0);
  });

  it('credencial inválida não deixa evento de entrada', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });
    const antes = (await trilhaDe(admin, { action: 'LOGIN', userId: pessoa.id })).length;

    const recusa = await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: 'senha-errada-mesmo' });
    expect(recusa.status).toBe(401);

    const depois = (await trilhaDe(admin, { action: 'LOGIN', userId: pessoa.id })).length;
    expect(depois, 'tentativa recusada não é entrada').toBe(antes);
  });
});

describe('a autenticação continua compatível', () => {
  it('o cadastro devolve token e usuário, e o e-mail repetido continua 409', async () => {
    const email = `${unico('compat')}@mci.test`;
    const primeiro = await api().post('/api/v1/auth/register').send({ ...CADASTRO, name: 'Primeira', email });

    expect(primeiro.status).toBe(201);
    expect(typeof primeiro.body.token).toBe('string');
    expect(primeiro.body.user.email).toBe(email);
    // Senha nunca volta na resposta — nem hash.
    expect(JSON.stringify(primeiro.body)).not.toMatch(/passwordHash|senha-de-teste/);

    const repetido = await api().post('/api/v1/auth/register').send({ ...CADASTRO, name: 'Segunda', email });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('a entrada devolve token utilizável na rota autenticada', async () => {
    const pessoa = await criarUsuario({ name: 'Atleta' });
    const entrada = await api().post('/api/v1/auth/login').send({ email: pessoa.email, password: CADASTRO.password });

    expect(entrada.status).toBe(200);
    const eu = await api().get('/api/v1/auth/me').set({ Authorization: `Bearer ${entrada.body.token}` });
    expect(eu.status).toBe(200);
    expect(eu.body.user.id).toBe(pessoa.id);
  });
});

describe('a política de auditoria não foi afrouxada', () => {
  const inserir = (tx, { userId, organizationId = null, action = 'LOGIN' }) => tx.$executeRawUnsafe(
    `INSERT INTO "AuditLog" ("id","organizationId","userId","userEmail","action","entity","entityId","ip","createdAt")
     VALUES ($1, $2, $3, $4, $5, 'User', $3, NULL, now())`,
    `teste-${Math.random().toString(36).slice(2)}`, organizationId, userId, 'teste@mci.test', action
  );

  it('visitante anônimo não grava evento nenhum', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const alvo = await criarUsuario({ name: 'Vítima' });

    // Sem contexto: o proxy de `src/config/prisma.js` roteia para o cliente
    // base, que é exatamente a situação de uma rota aberta.
    await expect(inserir(prisma, { userId: alvo.id, action: 'LOGIN' }))
      .rejects.toThrow(/row-level security|violates/i);

    const forjadas = await trilhaDe(admin, { action: 'LOGIN', userEmail: 'teste@mci.test' });
    expect(forjadas, 'nenhuma linha anônima entrou').toHaveLength(0);
  });

  it('ninguém assina no lugar de outro usuário', async () => {
    const autor = await criarUsuario({ name: 'Autor' });
    const vitima = await criarUsuario({ name: 'Vítima' });

    await expect(comoAtor(autor, tx => inserir(tx, { userId: vitima.id, action: 'LOGIN' })))
      .rejects.toThrow(/row-level security|violates/i);
  });

  it('ator comum não escreve na trilha de federação de que não participa', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const organizacao = await criarOrganizacao(admin, { slug: unico('org-trilha') });
    const forasteiro = await criarUsuario({ name: 'Forasteiro' });

    await expect(comoAtor(forasteiro, tx => inserir(tx, {
      userId: forasteiro.id, organizationId: organizacao.id, action: 'LOGIN'
    }))).rejects.toThrow(/row-level security|violates/i);
  });

  it('a trilha não se adultera nem se apaga — nem por administrador de plataforma', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });

    // A linha é gravada AQUI, e não herdada do login: este é um teste de
    // política, e amarrá-lo à correção da autenticação faria dois defeitos
    // diferentes reprovarem o mesmo caso, sem dizer qual dos dois foi.
    await comoAtor(pessoa, tx => inserir(tx, { userId: pessoa.id, action: 'TESTE_APPEND_ONLY' }));
    const antes = await trilhaDe(admin, { action: 'TESTE_APPEND_ONLY', userId: pessoa.id });
    expect(antes).toHaveLength(1);

    // Sem política de UPDATE nem de DELETE, sob FORCE RLS, o comando não alcança
    // linha nenhuma — e isso vale para o dono do schema também.
    await comoAtor(admin, tx => tx.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'ADULTERADO' WHERE "userId" = $1`, pessoa.id));
    await comoAtor(admin, tx => tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" = $1`, pessoa.id));

    const depois = await trilhaDe(admin, { action: 'TESTE_APPEND_ONLY', userId: pessoa.id });
    expect(depois.length, 'a linha original continua lá').toBe(antes.length);
    expect(await trilhaDe(admin, { action: 'ADULTERADO' })).toHaveLength(0);
  });

  it('quem não pode ler a trilha continua não lendo — pela rota e pelo banco', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });
    // Linha própria, pela mesma razão do caso acima: o que se mede aqui é a
    // política de LEITURA, e ela não depende de como a linha nasceu.
    await comoAtor(pessoa, tx => inserir(tx, { userId: pessoa.id, action: 'TESTE_LEITURA' }));
    expect((await trilhaDe(admin, { userId: pessoa.id })).length).toBeGreaterThan(0);

    const pelaRota = await api().get('/api/v1/audit').set(pessoa.auth());
    expect(pelaRota.status).toBe(403);

    // E a barreira não é só da rota: no contexto do próprio atleta, a política
    // de leitura não entrega linha alguma.
    const peloBanco = await comoAtor(pessoa, tx => tx.auditLog.findMany({ where: { userId: pessoa.id } }));
    expect(peloBanco, 'a política de leitura vale no banco, não só na rota').toHaveLength(0);
  });

  it('o TEXTO das políticas vivas continua exigindo ator e vínculo', async () => {
    const politicas = await prisma.$queryRawUnsafe(`
      SELECT policyname, cmd, coalesce(qual, '') AS usando, coalesce(with_check, '') AS checando
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AuditLog' ORDER BY policyname
    `);
    const porNome = Object.fromEntries(politicas.map(p => [p.policyname, p]));

    // Só existem estas duas. Uma política de UPDATE ou DELETE que aparecesse aqui
    // significaria trilha editável, e é o que este teste existe para impedir.
    expect(Object.keys(porNome).sort()).toEqual(['auditoria_escrita', 'auditoria_leitura']);
    expect(politicas.map(p => p.cmd).sort()).toEqual(['INSERT', 'SELECT']);

    // A cláusula que impede assinar no lugar de outro. Se ela sair, o defeito de
    // segurança volta — e a correção da trilha de autenticação NÃO depende de
    // mexer nela.
    expect(porNome.auditoria_escrita.checando).toMatch(/userId/);
    expect(porNome.auditoria_escrita.checando).toMatch(/mci_current_user_id\(\)/);
    // A leitura segue restrita a administrador de plataforma ou operador.
    expect(porNome.auditoria_leitura.usando).toMatch(/mci_is_platform_admin\(\)/);
    expect(porNome.auditoria_leitura.usando).toMatch(/mci_operator_of/);

    const [forca] = await prisma.$queryRawUnsafe(
      `SELECT relrowsecurity AS ligado, relforcerowsecurity AS forcado FROM pg_class WHERE relname = 'AuditLog'`
    );
    expect(forca.ligado).toBe(true);
    expect(forca.forcado, 'FORCE ROW LEVEL SECURITY não pode ter caído').toBe(true);
  });
});

describe('falha de auditoria é detectável e não vaza segredo', () => {
  it('a recusa é contada, e o resumo diz a ação sem expor dado sensível', async () => {
    const autor = await criarUsuario({ name: 'Autor' });
    const outro = await criarUsuario({ name: 'Outro' });
    audit.reiniciarContagemDeFalhas();

    // Uma recusa DE VERDADE: o ator da sessão é um, o `userId` da linha é outro.
    // A política reprova, `record` trata, e a operação segue — é o caminho que
    // ficava invisível.
    await comoAtor(autor, () => audit.record({
      actor: outro, action: 'TESTE_DE_FALHA', entity: 'User', entityId: outro.id,
      metadata: { password: 'nao-pode-vazar', token: 'nao-pode-vazar', observacao: 'ok' }
    }));

    const estado = audit.estadoDaTrilha();
    expect(estado.falhas, 'a falha tem de ser contada').toBe(1);
    expect(estado.ultimaFalha.action).toBe('TESTE_DE_FALHA');
    expect(estado.ultimaFalha.entity).toBe('User');

    // O resumo da falha é ação, entidade, código e instante. Nada além disso —
    // nem metadata, nem e-mail, nem IP, nem id de pessoa.
    const texto = JSON.stringify(estado);
    expect(texto).not.toMatch(/nao-pode-vazar/);
    expect(texto).not.toMatch(/password|token/i);
    expect(texto).not.toMatch(new RegExp(outro.email.split('@')[0]));
    expect(Object.keys(estado.ultimaFalha).sort()).toEqual(['action', 'codigo', 'entity', 'quando']);
  });

  it('a operação principal NÃO é derrubada pela falha de auditoria', async () => {
    const autor = await criarUsuario({ name: 'Autor' });
    const outro = await criarUsuario({ name: 'Outro' });

    // A transação segue utilizável depois da recusa: é o SAVEPOINT de
    // `auditService` fazendo o seu trabalho. Sem ele, a leitura abaixo falharia
    // com 25P02 e a operação inteira voltaria atrás.
    const resultado = await comoAtor(autor, async tx => {
      await audit.record({ actor: outro, action: 'TESTE_DE_FALHA', entity: 'User', entityId: outro.id });
      return tx.user.findUnique({ where: { id: autor.id }, select: { id: true } });
    });

    expect(resultado.id).toBe(autor.id);
    expect(audit.estadoDaTrilha().falhas).toBeGreaterThan(0);
  });

  it('GET /audit/integrity é para quem lê a trilha, e para mais ninguém', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const pessoa = await criarUsuario({ name: 'Atleta' });

    expect((await api().get('/api/v1/audit/integrity')).status, 'anônimo não pergunta').toBe(401);
    expect((await api().get('/api/v1/audit/integrity').set(pessoa.auth())).status, 'atleta não pergunta').toBe(403);

    const resposta = await api().get('/api/v1/audit/integrity').set(admin.auth());
    expect(resposta.status).toBe(200);
    expect(Object.keys(resposta.body).sort()).toEqual(['desdeSegundos', 'falhas', 'ultimaFalha']);
    expect(typeof resposta.body.falhas).toBe('number');
  });
});

describe('os eventos que já funcionavam continuam funcionando', () => {
  it('ação autenticada de administração segue deixando trilha com o ator certo', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const organizacao = await criarOrganizacao(admin, { slug: unico('org-controle') });

    const trilha = await trilhaDe(admin, { action: 'ORGANIZATION_CREATE', entityId: organizacao.id });
    expect(trilha, 'criar federação é ato auditável').toHaveLength(1);
    expect(trilha[0].userId).toBe(admin.id);
    expect(trilha[0].organizationId).toBe(organizacao.id);
  });

  it('a superfície HTTP da auditoria não ganhou rota sem autenticação', async () => {
    // A rota nova entra na conta: qualquer caminho de auditoria alcançável sem
    // token seria uma regressão de superfície.
    const caminhos = [];
    const coletar = (camada, prefixo) => {
      if (camada.route) {
        for (const metodo of Object.keys(camada.route.methods)) {
          if (metodo !== '_all') caminhos.push({ metodo, caminho: prefixo + camada.route.path });
        }
        return;
      }
      for (const interna of camada.handle?.stack || []) coletar(interna, prefixo);
    };
    for (const camada of app._router?.stack || app.router?.stack || []) coletar(camada, '/api/v1');

    const deAuditoria = caminhos.filter(r => r.caminho.startsWith('/api/v1/audit'));
    expect(deAuditoria.length).toBeGreaterThanOrEqual(2);
    for (const rota of deAuditoria) {
      const resposta = await api()[rota.metodo](rota.caminho);
      expect(resposta.status, `${rota.metodo.toUpperCase()} ${rota.caminho} responde sem token`).toBe(401);
    }
  });
});

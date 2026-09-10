import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, comoAtor } from './helpers.mjs';

// ============================================================================
// Bootstrap do primeiro administrador.
//
// Existe por uma lacuna encontrada ao subir a plataforma de verdade: o cadastro
// aberto recusa papel privilegiado — e deve recusar —, então numa instalação
// nova NINGUÉM conseguia dar o primeiro passo sem escrever direto no banco.
//
// O script fecha isso. Estes testes garantem que ele continue fechando: que a
// senha nunca venha por argumento, que só crie o PRIMEIRO administrador, e que
// a conta criada realmente entre e administre.
// ============================================================================

const SENHA = 'SenhaDeBootstrap#2026';

function rodar(args, { senha, esperaFalha = false } = {}) {
  try {
    const saida = execFileSync('node', ['scripts/criar-admin.js', ...args], {
      env: { ...process.env, ...(senha ? { ADMIN_PASSWORD: senha } : { ADMIN_PASSWORD: '' }) },
      stdio: ['pipe', 'pipe', 'pipe'],
      input: ''
    });
    return { ok: true, saida: saida.toString().trim() };
  } catch (erro) {
    if (!esperaFalha) throw new Error(`script falhou: ${erro.stderr?.toString() || erro.message}`, { cause: erro });
    return { ok: false, erro: (erro.stderr?.toString() || '').trim() };
  }
}

beforeAll(() => garantirCatalogo());
beforeEach(() => limparBanco());

describe('criação do primeiro administrador', () => {
  it('cria a conta e ela entra e administra de verdade', async () => {
    const { saida } = rodar(['Ana Ribeiro', 'Ana@MCI.test'], { senha: SENHA });
    const resultado = JSON.parse(saida);

    expect(resultado.criado).toBe(true);
    // Email normalizado: entrar com a caixa que a pessoa digitou tem de funcionar.
    expect(resultado.email).toBe('ana@mci.test');
    expect(resultado.role).toBe('SUPER_ADMIN');

    const login = await api().post('/api/v1/auth/login').send({ email: 'ana@mci.test', password: SENHA });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const auth = { Authorization: `Bearer ${login.body.token}` };
    // A administração de contas é a rota que só administrador alcança.
    expect((await api().get('/api/v1/admin/users').set(auth)).status).toBe(200);

    const federacao = await api().post('/api/v1/organizations').set(auth)
      .send({ name: 'Federação de Teste', slug: 'fed-de-teste' });
    expect(federacao.status, JSON.stringify(federacao.body)).toBe(201);
  });

  it('a senha nunca é aceita por argumento de linha de comando', () => {
    // Argumento aparece em `ps` para qualquer usuário da máquina e fica no
    // histórico do shell. Passar a senha como terceiro argumento não pode
    // funcionar nem por acidente.
    const { ok, erro } = rodar(['Ana Ribeiro', 'ana@mci.test', SENHA], { esperaFalha: true });

    expect(ok).toBe(false);
    expect(erro).toContain('Senha ausente');
  });

  it('recusa senha curta e email inválido', () => {
    expect(rodar(['Ana', 'ana@mci.test'], { senha: 'curta', esperaFalha: true }).erro).toContain('curta demais');
    expect(rodar(['Ana', 'nao-e-email'], { senha: SENHA, esperaFalha: true }).erro).toContain('Email inválido');
  });

  it('só cria o PRIMEIRO: com administrador existente, recusa', async () => {
    await criarUsuario({ role: 'SUPER_ADMIN', name: 'Já Existe' });

    const { ok, erro } = rodar(['Outro', 'outro@mci.test'], { senha: SENHA, esperaFalha: true });

    expect(ok).toBe(false);
    expect(erro).toContain('Já existe administrador');
  });

  it('promove uma conta que já existe, sem criar duplicata', async () => {
    const comum = await criarUsuario({ name: 'Pessoa Comum' });

    const resultado = JSON.parse(rodar(['Pessoa Comum', comum.email], { senha: SENHA }).saida);
    expect(resultado.promovido).toBe(true);
    expect(resultado.criado).toBe(false);

    const contas = await prisma.user.findMany({ where: { email: comum.email.toLowerCase() } });
    expect(contas).toHaveLength(1);
    expect(contas[0].role).toBe('SUPER_ADMIN');
  });

  it('registra o bootstrap na auditoria', async () => {
    rodar(['Ana Ribeiro', 'ana@mci.test'], { senha: SENHA });

    const admin = await prisma.user.findUnique({ where: { email: 'ana@mci.test' } });

    // A leitura precisa de contexto de ator: AuditLog tem RLS forçado, e ler
    // sem ator não devolve nada — nem para quem é dono do schema.
    const registros = await comoAtor(admin, tx => tx.auditLog.findMany({ where: { action: 'ADMIN_BOOTSTRAP' } }));
    expect(registros).toHaveLength(1);
    expect(registros[0].entity).toBe('User');
    // A senha não pode aparecer em lugar nenhum do registro.
    expect(JSON.stringify(registros[0])).not.toContain(SENHA);
  });
});

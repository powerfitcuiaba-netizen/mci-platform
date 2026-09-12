import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, unico, comoAtor } from './helpers.mjs';

// ============================================================================
// CADASTRO PÚBLICO — perfil não é privilégio.
//
// O formulário de criação de conta oferece sete PERFIS: atleta, coach,
// academia, equipe, marca, patrocinador e imprensa. Nenhum deles carrega poder
// operacional. Direção de evento, pesagem, palco, resultados e administração
// são CONCESSÃO, feita por quem já administra e registrada em auditoria.
//
// A regra que estes testes travam é uma só, e é a que separa as duas coisas:
// NADA que o cliente envie no cadastro pode resultar em conta privilegiada.
// Nem um `role` privilegiado, nem um campo alternativo inventado, nem os dois
// juntos. O servidor é a autoridade; o formulário apenas reflete o que ele
// aceita.
//
// Esconder a opção na tela não é proteção: a prova tem que ser contra a API.
// ============================================================================

const PERFIS_PUBLICOS = ['ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'MEDIA'];
const PRIVILEGIADOS = [
  'SUPER_ADMIN', 'ADMIN', 'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'JUDGE_COORDINATOR',
  'JUDGE', 'STAFF', 'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR',
  'RESULTS_OPERATOR', 'RANKING_MANAGER', 'SOCIAL_ADMIN', 'MODERATOR'
];
const SENHA = 'SenhaForte#2026';

const cadastrar = corpo => api().post('/api/v1/auth/register').send(corpo);
const email = () => `${unico('pessoa')}@mci.test`.toLowerCase().replace(/\s+/g, '');

beforeAll(() => garantirCatalogo());
beforeEach(() => limparBanco());

describe('os sete perfis públicos funcionam', () => {
  for (const perfil of PERFIS_PUBLICOS) {
    it(`cadastro com ${perfil} cria a conta com esse perfil`, async () => {
      const resposta = await cadastrar({ name: 'Pessoa Teste', email: email(), password: SENHA, role: perfil });

      expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
      expect(resposta.body.user.role).toBe(perfil);
      expect(resposta.body.token, 'o cadastro devolve sessão').toBeTruthy();
    });
  }

  it('sem informar perfil, a conta nasce ATHLETE', async () => {
    const resposta = await cadastrar({ name: 'Sem Perfil', email: email(), password: SENHA });

    expect(resposta.status).toBe(201);
    expect(resposta.body.user.role).toBe('ATHLETE');
  });
});

describe('nenhum payload transforma cadastro público em conta privilegiada', () => {
  for (const papel of PRIVILEGIADOS) {
    it(`role=${papel} é recusado`, async () => {
      const alvo = email();
      const resposta = await cadastrar({ name: 'Invasor', email: alvo, password: SENHA, role: papel });

      expect(resposta.status, JSON.stringify(resposta.body)).toBe(400);
      expect(resposta.body.error.code).toBe('VALIDATION_ERROR');

      // E o mais importante: nenhuma conta ficou para trás.
      const criado = await prisma.user.findUnique({ where: { email: alvo } });
      expect(criado, 'a recusa não pode deixar usuário meio-criado').toBeNull();
    });
  }

  for (const variacao of ['admin', 'ADMIN ', 'Administrator', 'superadmin', 'SuperAdmin', 'root', 'owner']) {
    it(`role="${variacao}" é recusado`, async () => {
      const resposta = await cadastrar({ name: 'Invasor', email: email(), password: SENHA, role: variacao });
      expect(resposta.status, JSON.stringify(resposta.body)).toBe(400);
    });
  }

  // Campos alternativos: o cadastro pode até ser aceito — o que não pode é a
  // conta sair privilegiada. O schema descarta o que não conhece.
  const camposAlternativos = [
    ['isAdmin', { isAdmin: true }],
    ['is_admin', { is_admin: true }],
    ['userRole', { userRole: 'SUPER_ADMIN' }],
    ['user_role', { user_role: 'SUPER_ADMIN' }],
    ['permission', { permission: 'admin' }],
    ['permissions', { permissions: ['*'] }],
    ['accessLevel', { accessLevel: 'admin' }],
    ['access_level', { access_level: 99 }],
    ['status', { status: 'ACTIVE' }],
    ['campo inventado', { qualquerCoisa: 'x' }]
  ];

  for (const [nome, extra] of camposAlternativos) {
    it(`${nome} não concede privilégio`, async () => {
      const alvo = email();
      const resposta = await cadastrar({ name: 'Invasor', email: alvo, password: SENHA, ...extra });

      expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
      expect(resposta.body.user.role).toBe('ATHLETE');

      const criado = await prisma.user.findUnique({ where: { email: alvo } });
      expect(PRIVILEGIADOS).not.toContain(criado.role);
    });
  }

  it('o ataque completo — role privilegiado MAIS todos os campos alternativos', async () => {
    const alvo = email();
    const resposta = await cadastrar({
      name: 'Invasor', email: alvo, password: SENHA,
      role: 'SUPER_ADMIN', isAdmin: true, is_admin: true, userRole: 'SUPER_ADMIN',
      permissions: ['*'], accessLevel: 'root', status: 'ACTIVE'
    });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: alvo } })).toBeNull();
  });

  it('o primeiro cadastro da instalação também não vira administrador', async () => {
    // limparBanco() rodou: esta é a primeira conta que existe.
    expect(await prisma.user.count()).toBe(0);

    const resposta = await cadastrar({ name: 'Primeira Pessoa', email: email(), password: SENHA, role: 'ATHLETE' });

    expect(resposta.status).toBe(201);
    expect(resposta.body.user.role).toBe('ATHLETE');
    expect(await prisma.user.count({ where: { role: { in: PRIVILEGIADOS } } }))
      .toBe(0);
  });
});

describe('ninguém se eleva depois de entrar', () => {
  it('o usuário comum não altera o próprio papel', async () => {
    const pessoa = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });

    const tentativa = await api().patch(`/api/v1/admin/users/${pessoa.id}`).set(pessoa.auth())
      .send({ role: 'SUPER_ADMIN' });

    expect([401, 403]).toContain(tentativa.status);
    expect((await prisma.user.findUnique({ where: { id: pessoa.id } })).role).toBe('ATHLETE');
  });

  it('o usuário comum não altera o papel de outra pessoa', async () => {
    const pessoa = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });
    const vitima = await criarUsuario({ role: 'COACH', name: 'Coach Alvo' });

    const tentativa = await api().patch(`/api/v1/admin/users/${vitima.id}`).set(pessoa.auth())
      .send({ role: 'SUPER_ADMIN' });

    expect([401, 403]).toContain(tentativa.status);
    expect((await prisma.user.findUnique({ where: { id: vitima.id } })).role).toBe('COACH');
  });

  it('o usuário comum não entra na área administrativa', async () => {
    const pessoa = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });

    for (const rota of ['/api/v1/admin/users', '/api/v1/audit']) {
      const resposta = await api().get(rota).set(pessoa.auth());
      expect([401, 403], `${rota} devolveu ${resposta.status}`).toContain(resposta.status);
    }
  });

  it('anônimo não entra na área administrativa', async () => {
    expect((await api().get('/api/v1/admin/users')).status).toBe(401);
  });
});

describe('a concessão administrativa continua funcionando para quem pode', () => {
  it('o SUPER_ADMIN promove outra pessoa, e fica registrado', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
    const pessoa = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });

    const promocao = await api().patch(`/api/v1/admin/users/${pessoa.id}`).set(admin.auth())
      .send({ role: 'MODERATOR' });

    expect(promocao.status, JSON.stringify(promocao.body)).toBe(200);
    expect((await prisma.user.findUnique({ where: { id: pessoa.id } })).role).toBe('MODERATOR');

    // Concessão de papel sem rastro não é concessão, é brecha.
    //
    // A leitura precisa de ator: a política `auditoria_restrita` só entrega a
    // trilha a administrador de plataforma ou a operador da organização. Uma
    // consulta sem contexto volta vazia — que é a RLS trabalhando, não falta
    // de registro.
    const trilha = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { entityId: pessoa.id, action: 'ROLE_CHANGE' }, orderBy: { createdAt: 'desc' }
    }));
    expect(trilha, 'a mudança de papel precisa deixar auditoria').toBeTruthy();
    expect(trilha.userId, 'a trilha aponta para quem concedeu').toBe(admin.id);
    expect(trilha.metadata.to.role).toBe('MODERATOR');
  });

  it('nem o SUPER_ADMIN altera o próprio papel', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });

    const tentativa = await api().patch(`/api/v1/admin/users/${admin.id}`).set(admin.auth())
      .send({ role: 'ATHLETE' });

    expect(tentativa.status).toBe(422);
    expect(tentativa.body.error.code).toBe('CANNOT_CHANGE_SELF');
  });
});

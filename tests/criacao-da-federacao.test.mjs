import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, comoAtor, unico } from './helpers.mjs';

// ==========================================================================
// CRIAR A FEDERAÇÃO PROMOTORA.
//
// É a operação mais privilegiada do sistema: sem organização não existe
// evento, atleta, filiação nem ranking — e quem a cria vira ADMIN dela. A
// matriz de RBAC não sondava `organizations.manage`, e a única cobertura que
// existia era de passagem, dentro do teste de bootstrap. Este arquivo fecha
// isso.
//
// Três coisas que um INSERT direto no banco NÃO faria, e que este teste trava
// como parte do contrato:
//
//   1. o criador entra como ADMIN da organização — sem isso nasceria um
//      tenant ao qual ninguém tem acesso;
//   2. o catálogo de classes do Campeonato Brasileiro é semeado, com a regra
//      homologada de que só a OPEN alimenta o Super Overall anual;
//   3. a criação fica na trilha de auditoria.
//
// Por isso a federação de produção precisa nascer pela rota oficial, e não
// por SQL.
// ==========================================================================

const CLASSES_ESPERADAS = ['ESTREANTE', 'NOVICE', 'OPEN', 'MASTER'];

let superAdmin;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  superAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria MCI' });
});

const criar = (auth, corpo) => api().post('/api/v1/organizations').set(auth).send(corpo);

describe('criação da federação promotora', () => {
  it('SUPER_ADMIN cria a federação, entra como ADMIN dela e recebe o catálogo de classes', async () => {
    const slug = unico('federacao');
    const resposta = await criar(superAdmin.auth(), { name: 'Muscle Contest Brasil', slug });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body).toMatchObject({ name: 'Muscle Contest Brasil', slug, active: true });

    const orgId = resposta.body.id;

    // 1. o criador é ADMIN da organização — senão o tenant nasceria órfão
    const vinculo = await comoAtor(superAdmin, () => prisma.organizationMember.findFirst({
      where: { organizationId: orgId, userId: superAdmin.id }
    }));
    expect(vinculo, 'quem criou a federação não ficou vinculado a ela').toBeTruthy();
    expect(vinculo.role).toBe('ADMIN');

    // 2. o catálogo de classes homologado
    const classes = await comoAtor(superAdmin, () => prisma.classCatalog.findMany({
      where: { organizationId: orgId }, orderBy: { sortOrder: 'asc' }
    }));
    expect(classes.map(c => c.code)).toEqual(CLASSES_ESPERADAS);

    // A regra esportiva homologada: só a OPEN alimenta o Super Overall anual.
    expect(classes.filter(c => c.superOverallEligible).map(c => c.code)).toEqual(['OPEN']);

    // 3. auditoria
    const trilha = await comoAtor(superAdmin, () => prisma.auditLog.findMany({
      where: { action: 'ORGANIZATION_CREATE', entityId: orgId }
    }));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].userId).toBe(superAdmin.id);
  });

  it('o fuso padrão é aplicado quando não informado, e respeitado quando informado', async () => {
    const padrao = await criar(superAdmin.auth(), { name: 'Sem fuso', slug: unico('sem-fuso') });
    expect(padrao.body.timezone).toBe('America/Sao_Paulo');

    const cuiaba = await criar(superAdmin.auth(), { name: 'Com fuso', slug: unico('com-fuso'), timezone: 'America/Cuiaba' });
    expect(cuiaba.body.timezone).toBe('America/Cuiaba');
  });
});

describe('criação da federação: quem pode', () => {
  // A regra é peculiar e vale travar: ADMIN tem TODAS as permissões MENOS
  // `organizations.manage`. Criar tenant é ato de plataforma, não de
  // administração de um tenant existente.
  it('ADMIN global NÃO cria organização — só SUPER_ADMIN', async () => {
    const admin = await criarUsuario({ role: 'ADMIN', name: 'Administrador da plataforma' });

    const resposta = await criar(admin.auth(), { name: 'Tentativa', slug: unico('tentativa') });

    expect(resposta.status).toBe(403);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('papéis comuns são recusados', async () => {
    for (const role of ['ATHLETE', 'TEAM', 'JUDGE', 'STAFF', 'COACH', 'BRAND']) {
      const usuario = await criarUsuario({ role, name: `Usuário ${role}` });
      const resposta = await criar(usuario.auth(), { name: `Tentativa ${role}`, slug: unico('tentativa') });
      expect(resposta.status, `${role} conseguiu criar organização`).toBe(403);
    }
    expect(await prisma.organization.count()).toBe(0);
  });

  // A recusa acima vem do middleware da ROTA (`perm('organizations.manage')`).
  // O serviço tem a sua própria conferência, e ela é uma segunda camada que o
  // teste por HTTP não alcança — medido: trocar a permissão dentro do serviço
  // não derrubava nenhum teste. Este caso chama o serviço direto para fechar
  // essa lacuna, e é o que impede que a barreira vire só a da rota.
  it('o serviço recusa por conta própria, sem depender do middleware da rota', async () => {
    const organizationService = (await import('../src/services/organizationService.js')).default
      ?? (await import('../src/services/organizationService.js'));

    const admin = await criarUsuario({ role: 'ADMIN', name: 'Administrador da plataforma' });
    const ator = { id: admin.id, role: 'ADMIN', memberships: [] };

    await expect(
      comoAtor(admin, () => organizationService.create({ name: 'Direto no serviço', slug: unico('direto') }, ator))
    ).rejects.toMatchObject({ status: 403 });

    expect(await prisma.organization.count()).toBe(0);
  });

  it('sem autenticação é 401', async () => {
    const resposta = await api().post('/api/v1/organizations').send({ name: 'Anônima', slug: unico('anonima') });
    expect(resposta.status).toBe(401);
    expect(await prisma.organization.count()).toBe(0);
  });
});

describe('criação da federação: validação e duplicidade', () => {
  it('slug repetido é recusado com 409 e não cria uma segunda', async () => {
    const slug = unico('repetida');
    expect((await criar(superAdmin.auth(), { name: 'Primeira', slug })).status).toBe(201);

    const segunda = await criar(superAdmin.auth(), { name: 'Segunda', slug });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('SLUG_IN_USE');

    expect(await prisma.organization.count({ where: { slug } })).toBe(1);
  });

  it('slug fora do formato é recusado antes de tocar o banco', async () => {
    for (const slug of ['com espaco', 'a', 'acentuação', 'barra/slug', '']) {
      const resposta = await criar(superAdmin.auth(), { name: 'Formato', slug });
      expect(resposta.status, `aceitou slug ${JSON.stringify(slug)}`).toBe(400);
      expect(resposta.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.organization.count()).toBe(0);
  });

  // MAIÚSCULA não é erro: o schema é `.trim().toLowerCase()` ANTES do regex,
  // então a entrada é normalizada em vez de recusada. Medido — a primeira
  // versão deste teste esperava 400 e estava errada. O que precisa ser
  // verdade é que o que fica GRAVADO é sempre minúsculo, porque o slug entra
  // em URL e vira a chave do `--organizacao=`.
  it('slug em maiúsculas é normalizado, não recusado', async () => {
    const resposta = await criar(superAdmin.auth(), { name: 'Normalizada', slug: 'FEDERACAO-MAIUSCULA' });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.slug).toBe('federacao-maiuscula');

    const gravada = await prisma.organization.findUnique({ where: { slug: 'federacao-maiuscula' } });
    expect(gravada).toBeTruthy();
  });

  it('nome vazio ou curto demais é recusado', async () => {
    for (const name of ['', ' ', 'A']) {
      const resposta = await criar(superAdmin.auth(), { name, slug: unico('nome') });
      expect(resposta.status, `aceitou nome ${JSON.stringify(name)}`).toBe(400);
    }
  });

  // Zod descarta chave não declarada. A prova é comportamental: o campo
  // enviado não vira estado da organização.
  it('campo extra no corpo é ignorado, não gravado', async () => {
    const resposta = await criar(superAdmin.auth(), {
      name: 'Com penduricalho', slug: unico('extra'),
      active: false, id: 'id-escolhido-pelo-cliente', createdAt: '1999-01-01T00:00:00.000Z'
    });

    expect(resposta.status).toBe(201);
    expect(resposta.body.active, 'o cliente conseguiu nascer inativa').toBe(true);
    expect(resposta.body.id).not.toBe('id-escolhido-pelo-cliente');
    expect(new Date(resposta.body.createdAt).getFullYear()).toBeGreaterThan(2000);
  });
});

describe('criação da federação: isolamento entre tenants', () => {
  // A fronteira aqui NÃO é "não é membro, não vê". É por PAPEL, e está assim
  // de propósito: SUPER_ADMIN e ADMIN são papéis de PLATAFORMA e atravessam
  // tenants por construção (`isCrossTenant`); todo o resto depende de vínculo.
  // Medido — a primeira versão deste teste supunha que ADMIN seria barrado e
  // estava errada. Quem concede ADMIN precisa saber que concede visão de
  // TODAS as federações.
  it('papel de plataforma atravessa tenants; papel comum sem vínculo não', async () => {
    const orgA = (await criar(superAdmin.auth(), { name: 'Federação A', slug: unico('fed-a') })).body;

    const admin = await criarUsuario({ role: 'ADMIN', name: 'Administrador da plataforma' });
    const comoAdmin = await api().get(`/api/v1/organizations/${orgA.id}`).set(admin.auth());
    expect(comoAdmin.status, 'ADMIN é papel de plataforma e deveria enxergar').toBe(200);

    const atleta = await criarUsuario({ name: 'Atleta de fora' });
    const comoAtleta = await api().get(`/api/v1/organizations/${orgA.id}`).set(atleta.auth());
    expect([403, 404], 'atleta sem vínculo enxergou a federação').toContain(comoAtleta.status);

    const equipe = await criarUsuario({ role: 'TEAM', name: 'Equipe de fora' });
    const comoEquipe = await api().get(`/api/v1/organizations/${orgA.id}`).set(equipe.auth());
    expect([403, 404]).toContain(comoEquipe.status);
  });

  it('duas federações convivem sem misturar catálogo de classes', async () => {
    const a = (await criar(superAdmin.auth(), { name: 'Federação A', slug: unico('fed-a') })).body;
    const b = (await criar(superAdmin.auth(), { name: 'Federação B', slug: unico('fed-b') })).body;

    const classesA = await comoAtor(superAdmin, () => prisma.classCatalog.findMany({ where: { organizationId: a.id } }));
    const classesB = await comoAtor(superAdmin, () => prisma.classCatalog.findMany({ where: { organizationId: b.id } }));

    expect(classesA).toHaveLength(CLASSES_ESPERADAS.length);
    expect(classesB).toHaveLength(CLASSES_ESPERADAS.length);
    expect(new Set(classesA.map(c => c.id)).size + new Set(classesB.map(c => c.id)).size)
      .toBe(CLASSES_ESPERADAS.length * 2);
  });
});

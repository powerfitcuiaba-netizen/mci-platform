import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, unico } from './helpers.mjs';

// ==========================================================================
// DERIVA ENTRE schema.prisma E AS MIGRATIONS — com consequência em produção.
//
// `maxHeightCm` existia em TRÊS lugares e faltava em um:
//
//   migration 20260906120000 ....... CRIA a coluna "maxHeightCm" INTEGER
//   src/utils/schemas.js ........... ACEITA maxHeightCm na entrada da rota
//   POST /divisions/:id/classes .... repassa o corpo validado ao Prisma
//   prisma/schema.prisma ........... NÃO declarava o campo
//
// O controlador faz `create({ data: { divisionId, ...data } })`. Como o Zod
// DECLARA maxHeightCm, ele não é removido do corpo; e como o client do Prisma
// não conhecia o campo, a chamada morria com erro de validação do Prisma —
// 500 numa rota que a própria aplicação diz aceitar aquele campo.
//
// Quem criasse classe com altura máxima recebia 500. Quem não mandasse o
// campo nunca via nada — por isso passou por todas as fases anteriores.
//
// `minHeightCm` sempre esteve declarado. Altura tem mínimo e máximo como
// idade e peso têm; o que faltava era a declaração, não a regra.
// ==========================================================================

let diretor;
let divisionId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  const org = await criarOrganizacao(admin, { name: 'Federação' });
  diretor = await criarUsuario({ role: 'ATHLETE', name: 'Diretor' });
  await vincular(org.id, diretor, 'EVENT_DIRECTOR');

  const evento = await api().post('/api/v1/events').set(diretor.auth())
    .send({ organizationId: org.id, name: 'Etapa', slug: unico('evento'), startDate: '2026-11-20T12:00:00.000Z' });
  const categoria = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
  const ec = await api().post(`/api/v1/events/${evento.body.id}/categories`).set(diretor.auth())
    .send({ categoryId: categoria.id });
  const div = await api().post(`/api/v1/event-categories/${ec.body.id}/divisions`).set(diretor.auth())
    .send({ name: 'Até 163cm', code: 'ATE163' });
  divisionId = div.body.id;
});

describe('classe com faixa de altura', () => {
  it('aceita maxHeightCm e GRAVA o valor — era 500', async () => {
    const r = await api().post(`/api/v1/divisions/${divisionId}/classes`).set(diretor.auth())
      .send({ name: 'Até 168cm', code: 'ATE168', minHeightCm: 160, maxHeightCm: 168 });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.minHeightCm).toBe(160);
    expect(r.body.maxHeightCm).toBe(168);

    // E persistiu de verdade, não só voltou no corpo da resposta.
    const gravada = await prisma.competitionClass.findUnique({ where: { id: r.body.id } });
    expect(gravada.maxHeightCm).toBe(168);
  });

  it('recusa altura máxima menor que a mínima, como já faz com idade e peso', async () => {
    const r = await api().post(`/api/v1/divisions/${divisionId}/classes`).set(diretor.auth())
      .send({ name: 'Incoerente', code: 'INCOER', minHeightCm: 180, maxHeightCm: 160 });

    // 400 é a convenção da aplicação para falha de validação (validate.js),
    // a mesma que idade e peso já produzem — não 422.
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('continua aceitando classe sem faixa de altura nenhuma', async () => {
    const r = await api().post(`/api/v1/divisions/${divisionId}/classes`).set(diretor.auth())
      .send({ name: 'Open', code: 'OPEN' });

    expect(r.status).toBe(201);
    expect(r.body.maxHeightCm).toBeNull();
  });
});

describe('o schema.prisma não pode divergir das migrations', () => {
  it('todo campo que a validação aceita para classe existe no schema.prisma', () => {
    const schemas = readFileSync('src/utils/schemas.js', 'utf8');
    const bloco = schemas.slice(schemas.indexOf('const classCreate'));
    const campos = [...bloco.slice(0, bloco.indexOf('}).refine')).matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
    expect(campos.length).toBeGreaterThan(5);

    const modelo = readFileSync('prisma/schema.prisma', 'utf8');
    const bloco2 = modelo.slice(modelo.indexOf('model CompetitionClass {'));
    const declarados = bloco2.slice(0, bloco2.indexOf('\n}'));

    const ausentes = campos.filter(campo => !new RegExp(`^\\s+${campo}\\s`, 'm').test(declarados));
    expect(ausentes, `a rota aceita campos que o Prisma não conhece: ${ausentes.join(', ')}`).toEqual([]);
  });
});

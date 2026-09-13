import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, unico } from './helpers.mjs';
import * as s from '../src/utils/schemas.js';

// ==========================================================================
// EDIÇÃO DE CAMPEONATO — a coerência das datas valia só na criação.
//
// `eventCreate` tem um refine: data final não pode ser anterior à inicial.
// `eventUpdate` não tinha. Como o PATCH usa `eventUpdate`, dava para criar o
// evento com datas certas e depois EDITÁ-LO para uma faixa impossível.
//
// Medido contra a API em execução, antes da correção:
//
//   PATCH /events/:id  { startDate: 2026-12-10, endDate: 2026-12-01 }
//   -> HTTP 200, e o evento passou a terminar nove dias antes de começar.
//
// Não é erro de digitação sem consequência: a data do evento alimenta o
// calendário público, a ordenação da listagem e o selo do dia. Um intervalo
// invertido atravessa tudo isso em silêncio.
//
// Este arquivo trava as duas pontas: o schema e a rota.
// ==========================================================================

let diretor;
let org;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  org = await criarOrganizacao(admin, { name: 'Federação QA' });
  diretor = await criarUsuario({ role: 'ATHLETE', name: 'Diretor' });
  await vincular(org.id, diretor, 'EVENT_DIRECTOR');
});

const criarEvento = (extra = {}) => api().post('/api/v1/events').set(diretor.auth()).send({
  organizationId: org.id,
  name: 'QA — Etapa de teste',
  slug: unico('qa-etapa'),
  startDate: '2026-11-20T12:00:00.000Z',
  endDate: '2026-11-21T22:00:00.000Z',
  ...extra
});

describe('coerência das datas na edição', () => {
  it('o schema de edição recusa data final anterior à inicial', () => {
    const r = s.eventUpdate.safeParse({
      startDate: '2026-12-10T12:00:00.000Z',
      endDate: '2026-12-01T12:00:00.000Z'
    });
    expect(r.success, 'eventUpdate aceitou intervalo invertido').toBe(false);
  });

  it('o schema de edição aceita o intervalo correto', () => {
    const r = s.eventUpdate.safeParse({
      startDate: '2026-12-01T12:00:00.000Z',
      endDate: '2026-12-10T12:00:00.000Z'
    });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('a rota PATCH recusa o intervalo invertido, e nada é gravado', async () => {
    const evento = await criarEvento();
    expect(evento.status, JSON.stringify(evento.body)).toBe(201);

    const tentativa = await api().patch(`/api/v1/events/${evento.body.id}`).set(diretor.auth())
      .send({ startDate: '2026-12-10T12:00:00.000Z', endDate: '2026-12-01T12:00:00.000Z' });
    expect(tentativa.status).toBe(400);

    const depois = await prisma.event.findUnique({ where: { id: evento.body.id } });
    expect(new Date(depois.endDate) >= new Date(depois.startDate),
      `gravou ${depois.startDate} -> ${depois.endDate}`).toBe(true);
  });

  it('editar só a data final, deixando-a antes da inicial já gravada, também é recusado', async () => {
    // O caso que um refine ingênuo deixa passar: o corpo traz UMA data só, e
    // a comparação precisa considerar a que já está no banco.
    const evento = await criarEvento();
    const tentativa = await api().patch(`/api/v1/events/${evento.body.id}`).set(diretor.auth())
      .send({ endDate: '2026-11-01T12:00:00.000Z' });

    expect(tentativa.status, `respondeu ${tentativa.status}: ${JSON.stringify(tentativa.body).slice(0, 160)}`).toBe(422);

    const depois = await prisma.event.findUnique({ where: { id: evento.body.id } });
    expect(new Date(depois.endDate) >= new Date(depois.startDate)).toBe(true);
  });

  it('a edição legítima continua passando', async () => {
    const evento = await criarEvento();
    const r = await api().patch(`/api/v1/events/${evento.body.id}`).set(diretor.auth())
      .send({ name: 'QA — Etapa renomeada', city: 'Várzea Grande',
              startDate: '2026-12-01T12:00:00.000Z', endDate: '2026-12-02T22:00:00.000Z' });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.name).toBe('QA — Etapa renomeada');
    expect(r.body.city).toBe('Várzea Grande');
  });
});

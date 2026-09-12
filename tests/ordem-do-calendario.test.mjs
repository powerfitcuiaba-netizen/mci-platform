import { describe, it, expect, beforeAll } from 'vitest';
import { api, limparBanco, criarUsuario, criarOrganizacao, transicionar, unico } from './helpers.mjs';

// ==========================================================================
// Calendário se lê do começo para o fim.
//
// A listagem nascia em ordem DECRESCENTE de data. Com as 47 etapas da
// temporada 2026 carregadas, quem abria a tela via dezembro primeiro e tinha
// de rolar até o fim para achar a próxima etapa — e, com paginação, a próxima
// etapa podia nem estar na primeira página.
//
// A ordem é do BACKEND: o frontend não reordena nada (não há um só `sort()` em
// frontend/src). Então é aqui que ela se trava, nas duas listagens, porque são
// duas telas diferentes: a pública e a de operação.
// ==========================================================================

const DATAS = ['2026-12-12', '2026-09-12', '2026-11-14', '2026-10-03'];
const EM_ORDEM = [...DATAS].sort();

let admin;
let organizationId;

beforeAll(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretora do calendário' });
  organizationId = (await criarOrganizacao(admin, { name: 'Federação do calendário' })).id;

  // Criados fora de ordem de propósito: se a listagem caísse na ordem de
  // criação, o teste não veria diferença nenhuma.
  for (const data of DATAS) {
    const resposta = await api().post('/api/v1/events').set(admin.auth()).send({
      organizationId,
      name: `Etapa ${data}`,
      slug: unico('etapa'),
      startDate: `${data}T12:00:00.000Z`
    });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    // Rascunho não aparece na superfície pública.
    await transicionar(admin, resposta.body.id, ['PLANNED']);
  }
});

const somenteODia = itens => itens.map(e => e.startDate.slice(0, 10));

describe('a listagem pública vem em ordem crescente de data', () => {
  it('a primeira etapa da lista é a mais próxima, não a mais distante', async () => {
    const resposta = await api().get('/api/v1/public/events');
    expect(resposta.status).toBe(200);

    const dias = somenteODia(resposta.body.items);
    expect(dias).toEqual(EM_ORDEM);
    expect(dias[0]).toBe('2026-09-12');
  });
});

describe('a listagem de operação segue a mesma ordem', () => {
  it('quem opera o campeonato vê o calendário na mesma direção que o público', async () => {
    const resposta = await api().get('/api/v1/events').set(admin.auth());
    expect(resposta.status).toBe(200);

    const dias = somenteODia(resposta.body.items);
    expect(dias).toEqual(EM_ORDEM);
    expect(dias[0]).toBe('2026-09-12');
  });

  it('a paginação não quebra a ordem: a primeira página traz as PRIMEIRAS etapas', async () => {
    // Com ordem decrescente e limite 2, a primeira página trazia dezembro e
    // novembro — ou seja, a próxima etapa não cabia na primeira página.
    const resposta = await api().get('/api/v1/events?limit=2').set(admin.auth());
    expect(resposta.status).toBe(200);
    expect(somenteODia(resposta.body.items)).toEqual(EM_ORDEM.slice(0, 2));
  });
});

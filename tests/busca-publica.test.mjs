import { describe, it, expect, beforeAll } from 'vitest';
import { api, limparBanco, criarUsuario, criarOrganizacao, vincular, criarAtleta, transicionar, unico } from './helpers.mjs';

// ==========================================================================
// Busca na superfície pública: o parâmetro chegava a lugar nenhum.
//
// `validate()` troca req.query pelo resultado do Zod, e o Zod DESCARTA chave
// que o schema não declara. As duas rotas públicas de listagem validavam com
// `paginacao`, que só tem `limit` e `cursor` — então `search` era removido em
// silêncio, sem erro, sem 400, sem log.
//
// O efeito é pior que uma busca que não funciona: a tela de Atletas já manda
// `search` e mostra o que voltar. Quem digitasse um nome receberia os
// primeiros atletas em ordem alfabética COMO SE FOSSEM O RESULTADO da busca.
// Resposta errada apresentada como certa.
//
// Com o calendário de 47 etapas isso deixou de ser teórico: buscar uma etapa
// de dezembro devolvia a lista inteira, e a tela, que filtra no cliente só o
// que carregou, dizia "Nenhum campeonato encontrado" para uma etapa que
// existe.
// ==========================================================================

let admin;
let organizationId;

beforeAll(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretora' });
  organizationId = (await criarOrganizacao(admin, { name: 'Federação da busca' })).id;
  await vincular(organizationId, admin, 'EVENT_DIRECTOR');

  for (const [nome, data] of [['Ipiranga', '2026-09-12'], ['Mercosul', '2026-12-12'], ['Teresina', '2026-10-10']]) {
    const resposta = await api().post('/api/v1/events').set(admin.auth()).send({
      organizationId, name: nome, slug: unico('etapa'), startDate: `${data}T12:00:00.000Z`
    });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    await transicionar(admin, resposta.body.id, ['PLANNED']);
  }

  await criarAtleta(admin, organizationId, { fullName: 'Amanda Ribeiro' });
  await criarAtleta(admin, organizationId, { fullName: 'Zuleica Prado' });
});

describe('busca de campeonatos na superfície pública', () => {
  it('filtra no servidor, e não devolve a lista inteira', async () => {
    const resposta = await api().get('/api/v1/public/events?search=Mercosul');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.map(e => e.name)).toEqual(['Mercosul']);
  });

  it('é indiferente a maiúsculas e acha por pedaço do nome', async () => {
    const resposta = await api().get('/api/v1/public/events?search=teres');
    expect(resposta.body.items.map(e => e.name)).toEqual(['Teresina']);
  });

  it('busca sem resultado devolve lista vazia — não devolve tudo', async () => {
    const resposta = await api().get('/api/v1/public/events?search=EtapaQueNaoExiste');
    expect(resposta.body.items).toHaveLength(0);
  });

  it('sem busca, continua listando todas', async () => {
    const resposta = await api().get('/api/v1/public/events');
    expect(resposta.body.items).toHaveLength(3);
  });
});

describe('busca de atletas na superfície pública', () => {
  it('filtra no servidor — quem está no fim do alfabeto também é encontrado', async () => {
    // Zuleica jamais apareceria numa primeira página ordenada por nome; se a
    // busca for ignorada, este teste devolve Amanda e reprova.
    const resposta = await api().get('/api/v1/public/athletes?search=Zuleica');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.map(a => a.fullName)).toEqual(['Zuleica Prado']);
  });
});

describe('a paginação alcança o que a primeira página não trouxe', () => {
  it('o cursor entrega as etapas seguintes, sem repetir a primeira', async () => {
    const primeira = await api().get('/api/v1/public/events?limit=2');
    expect(primeira.body.items).toHaveLength(2);
    expect(primeira.body.nextCursor).toBeTruthy();

    const segunda = await api().get(`/api/v1/public/events?limit=2&cursor=${primeira.body.nextCursor}`);
    const nomes = [...primeira.body.items, ...segunda.body.items].map(e => e.name);
    expect(new Set(nomes).size, 'evento repetido entre páginas').toBe(3);
    expect(nomes).toContain('Mercosul');
  });
});

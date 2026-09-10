import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, gerarCpf
} from './helpers.mjs';

// ============================================================================
// Formato da resposta do dashboard — trava de contrato.
//
// Existe por um defeito real: ao remover o julgamento interno, tirei um campo
// da resposta e a interface continuou lendo `dados.openJudgingSessions`,
// renderizando `undefined`. Os testes de interface passaram porque o MOCK ainda
// entregava o campo — o mock mentia sobre o formato da API, e a mentira
// escondeu a quebra.
//
// Aqui o formato é conferido contra o serviço de verdade. Tirar um campo que a
// interface lê quebra a suíte, em vez de virar buraco na tela.
// ============================================================================

let admin;
let diretor;
let orgId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'Federação do Painel' });
  orgId = org.id;
  diretor = await criarUsuario({ name: 'Diretor' });
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
});

describe('painel administrativo', () => {
  // Exatamente os campos que frontend/src/pages/adminPlatform.jsx consome.
  const CAMPOS = [
    'events', 'athletes', 'registrations', 'checkIns',
    'weighIns', 'batches', 'publishedResults', 'muscleWarImports', 'alerts'
  ];

  it('entrega exatamente os campos que a tela consome, sem sobra nem falta', async () => {
    const resposta = await api().get('/api/v1/dashboard/admin').query({ organizationId: orgId }).set(diretor.auth());

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
    expect(Object.keys(resposta.body).sort()).toEqual([...CAMPOS].sort());
  });

  it('nenhum número do painel vem indefinido', async () => {
    await criarAtleta(diretor, orgId, { cpf: gerarCpf(919191919) });
    await criarEventoCompleto(diretor, orgId);

    const { body } = await api().get('/api/v1/dashboard/admin').query({ organizationId: orgId }).set(diretor.auth());

    // O defeito que originou este arquivo aparecia exatamente assim: um campo
    // ausente virando `undefined` no lugar de um número.
    for (const campo of ['registrations', 'checkIns', 'weighIns', 'batches', 'publishedResults', 'muscleWarImports']) {
      expect(typeof body[campo], `${campo} deveria ser número`).toBe('number');
    }
    expect(typeof body.events.active).toBe('number');
    expect(typeof body.athletes.total).toBe('number');
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  it('conta o que existe na organização, e não o que existe na plataforma', async () => {
    const outroDiretor = await criarUsuario({ name: 'Diretor B' });
    const outraOrg = await criarOrganizacao(admin, { name: 'Federação Vizinha' });
    await vincular(outraOrg.id, outroDiretor, 'EVENT_DIRECTOR');

    await criarAtleta(diretor, orgId, { cpf: gerarCpf(929292929) });
    await criarAtleta(outroDiretor, outraOrg.id, { cpf: gerarCpf(939393939) });

    const meu = await api().get('/api/v1/dashboard/admin').query({ organizationId: orgId }).set(diretor.auth());
    expect(meu.body.athletes.total).toBe(1);
  });

  it('não entrega o painel de outra federação', async () => {
    const outroDiretor = await criarUsuario({ name: 'Diretor B' });
    const outraOrg = await criarOrganizacao(admin, { name: 'Federação Vizinha' });
    await vincular(outraOrg.id, outroDiretor, 'EVENT_DIRECTOR');

    const invasao = await api().get('/api/v1/dashboard/admin').query({ organizationId: orgId }).set(outroDiretor.auth());
    expect(invasao.status).toBe(403);
  });
});

// ============================================================================
// Catálogo de categorias.
//
// Os critérios de avaliação foram semeados desde a fase 3 e nunca chegaram a
// lugar nenhum: nenhum serviço e nenhuma tela os liam. Com o julgamento saindo
// para fora do MCI, apagá-los destruiria informação real — o que cada categoria
// valoriza é o que o atleta precisa saber para se preparar. Então em vez de
// apagar, foram expostos; e este teste garante que continuem chegando.
// ============================================================================
describe('catálogo de categorias', () => {
  it('entrega as onze categorias oficiais com os critérios que cada uma avalia', async () => {
    const resposta = await api().get('/api/v1/categories');

    expect(resposta.status).toBe(200);
    const categorias = resposta.body.items ?? resposta.body;
    expect(categorias.length).toBe(11);

    const bikini = categorias.find(categoria => categoria.code === 'BIKINI');
    expect(bikini, 'BIKINI é categoria oficial').toBeTruthy();
    expect(Array.isArray(bikini.criteria)).toBe(true);
    expect(bikini.criteria.length).toBeGreaterThan(0);
    expect(bikini.criteria[0]).toHaveProperty('name');
  });

  it('as categorias obrigatórias estão no catálogo', async () => {
    const { body } = await api().get('/api/v1/categories');
    const codigos = (body.items ?? body).map(categoria => categoria.code);

    // Duas exigidas nominalmente pelo organizador desde a fase 1.
    expect(codigos).toContain('WOMENS_BODYBUILDING');
    expect(codigos).toContain('FITMODEL');
  });
});

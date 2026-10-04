import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  criarAtleta, gerarCpf
} from './helpers.mjs';
// CAMINHO RELATIVO AO PRÓPRIO ARQUIVO, e não absoluto.
//
// A primeira versão deste arquivo fixou `/home/user/mci-platform/` — o
// diretório do contêiner em que ele foi escrito. Passou aqui e reprovou na CI
// com MODULE_NOT_FOUND, porque lá o repositório é clonado em outro lugar. Um
// gate que só roda numa máquina não é gate.
const require = createRequire(import.meta.url);
const { can, PERMISSIONS } = require('../src/utils/permissions.js');

// ============================================================================
// O 403 DO SUPER ADMIN NO HISTÓRICO IMPORTADO — MEDIDO, NÃO LIDO.
//
// A leitura do código diz que é impossível. A produção diz que aconteceu. Este
// arquivo mede, pela rota real, com papel real.
// ============================================================================

let admin;
let organizationId;
let atleta;

beforeAll(async () => { await garantirCatalogo(); });

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Helder Falcao de Teste' });
  const org = await criarOrganizacao(admin, { name: 'MCI Autorizacao' });
  organizationId = org.id;
  atleta = await criarAtleta(admin, organizationId, {
    fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(293200009), sex: 'MALE'
  });
});

describe('a permissão, na função pura', () => {
  it('athletes.read_sensitive está no catálogo de permissões', () => {
    expect(PERMISSIONS).toContain('athletes.read_sensitive');
  });

  it('SUPER_ADMIN com UMA organização: can() devolve true', () => {
    const ator = { id: 'u1', role: 'SUPER_ADMIN', memberships: [{ organizationId: 'org-A', role: 'ADMIN' }] };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(true);
  });

  it('SUPER_ADMIN SEM vínculo nenhum: can() devolve true em qualquer organização', () => {
    const ator = { id: 'u1', role: 'SUPER_ADMIN', memberships: [] };
    expect(can(ator, 'athletes.read_sensitive', 'org-que-ele-nao-participa')).toBe(true);
  });

  it('SUPER_ADMIN com memberships AUSENTE (campo não carregado): ainda true', () => {
    const ator = { id: 'u1', role: 'SUPER_ADMIN' };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(true);
  });

  // AS VARIAÇÕES QUE QUEBRAM. Se a produção tiver qualquer uma destas, o 403 é
  // explicado — e nenhuma delas é defeito de autorização: é dado.
  it('papel em minúsculo NÃO é reconhecido', () => {
    const ator = { id: 'u1', role: 'super_admin', memberships: [] };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(false);
  });

  it('papel ausente NÃO é reconhecido', () => {
    const ator = { id: 'u1', memberships: [] };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(false);
  });

  it('ADMIN (papel de plataforma, não super) TEM a permissão', () => {
    const ator = { id: 'u1', role: 'ADMIN', memberships: [] };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(true);
  });

  it('ATHLETE não tem', () => {
    const ator = { id: 'u1', role: 'ATHLETE', memberships: [] };
    expect(can(ator, 'athletes.read_sensitive', 'org-A')).toBe(false);
  });
});

describe('a rota real, com SUPER_ADMIN de verdade', () => {
  it('GET /athletes/:id/imported-history responde 200', async () => {
    const resposta = await api()
      .get(`/api/v1/athletes/${atleta.id}/imported-history`)
      .set(admin.auth());
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body).toHaveProperty('linked');
    expect(resposta.body).toHaveProperty('suggestions');
  });

  it('e o papel que a API enxerga é mesmo SUPER_ADMIN', async () => {
    const eu = await api().get('/api/v1/auth/me').set(admin.auth());
    expect(eu.status).toBe(200);
    const papel = eu.body?.role ?? eu.body?.user?.role;
    expect(papel).toBe('SUPER_ADMIN');
  });
});

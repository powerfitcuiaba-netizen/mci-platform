import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// A PORTA DO AUTOCADASTRO.
//
// `Organization.selfRegistrationOpen` é `Boolean @default(false)`: a federação
// nasce fechada para cadastro espontâneo, e é ela que decide abrir. Enquanto
// está fechada, `GET /public/affiliations` não devolve NENHUMA filiação dela —
// e a tela de solicitação do atleta fica com o campo "Entidade de filiação"
// vazio.
//
// Isso é comportamento correto e foi medido em produção como confusão: a rota
// para abrir existia, o método no cliente existia, e nenhuma tela chamava. A
// federação não tinha como abrir a porta.
//
// Estes testes cobram as duas pontas: o ESTADO tem de estar na listagem para a
// tela poder mostrá-lo, e abrir/fechar tem de mudar de verdade o que o
// visitante enxerga — com autorização e auditoria.
// ============================================================================

let admin;
let gerente;
let organizationId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  // O PADRÃO DE PRODUÇÃO, e não o da fixture.
  //
  // `criarOrganizacao` abre o autocadastro por conveniência das outras
  // suítes, onde "uma federação" quer dizer "uma federação funcionando". Esta
  // suíte é a DO INTERRUPTOR: ela precisa vê-lo como ele nasce no produto —
  // fechado —, senão estaria medindo a fixture em vez da regra.
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil', autocadastroAberto: false });
  organizationId = org.id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: unico('NPC').slice(0, 12).toUpperCase() });
});

const listarOrganizacoes = () => api().get('/api/v1/organizations').set(admin.auth());
const alternar = (ator, aberto) => api().post(`/api/v1/organizations/${organizationId}/self-registration`)
  .set(ator.auth()).send({ open: aberto });
const filiacoesPublicas = () => api().get('/api/v1/public/affiliations');

describe('a organização nasce fechada, e a listagem diz isso', () => {
  it('selfRegistrationOpen vem na listagem, e começa falso', async () => {
    const resposta = await listarOrganizacoes();
    expect(resposta.status).toBe(200);

    const org = resposta.body.items.find(o => o.id === organizationId);
    // SEM ESTE CAMPO a tela não tem como mostrar o estado, e o operador fica
    // sem saber se a porta está aberta antes de procurar o botão.
    expect(org).toHaveProperty('selfRegistrationOpen');
    expect(org.selfRegistrationOpen).toBe(false);
  });

  it('fechada, a filiação NÃO aparece para o visitante', async () => {
    const publicas = await filiacoesPublicas();
    expect(publicas.status).toBe(200);
    expect(publicas.body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(false);
  });
});

describe('abrir e fechar muda o que o visitante enxerga', () => {
  it('aberta, a filiação passa a aparecer', async () => {
    expect((await alternar(admin, true)).status).toBe(200);

    const publicas = await filiacoesPublicas();
    const daOrganizacao = publicas.body.items.filter(f => f.organization?.name === 'MCI Brasil');
    expect(daOrganizacao.length, 'a filiação entra em circulação').toBe(1);
    expect(daOrganizacao[0].name).toBe('NPC Brasil');

    // E a listagem administrativa acompanha.
    const org = (await listarOrganizacoes()).body.items.find(o => o.id === organizationId);
    expect(org.selfRegistrationOpen).toBe(true);
  });

  it('fechar tira todas de circulação de uma vez', async () => {
    expect((await alternar(admin, true)).status).toBe(200);
    expect((await filiacoesPublicas()).body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(true);

    expect((await alternar(admin, false)).status).toBe(200);
    expect((await filiacoesPublicas()).body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(false);
  });

  it('é idempotente: abrir duas vezes não quebra nem duplica', async () => {
    expect((await alternar(admin, true)).status).toBe(200);
    expect((await alternar(admin, true)).status).toBe(200);

    const publicas = await filiacoesPublicas();
    expect(publicas.body.items.filter(f => f.organization?.name === 'MCI Brasil').length).toBe(1);
  });

  it('a filiação INATIVA continua fora, mesmo com a porta aberta', async () => {
    // Abrir o autocadastro não ressuscita filiação que a organização
    // desativou: as três condições valem juntas.
    expect((await alternar(admin, true)).status).toBe(200);

    const filiacao = await comoAtor(admin, tx => tx.affiliation.findFirst({ where: { organizationId }, select: { id: true } }));
    expect((await api().post(`/api/v1/affiliations/${filiacao.id}/deactivate`).set(admin.auth())).status).toBe(200);

    expect((await filiacoesPublicas()).body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(false);
  });
});

describe('a porta é ato administrativo', () => {
  it('quem não tem organizations.manage é recusado, e nada muda', async () => {
    const resposta = await alternar(gerente, true);
    expect([401, 403]).toContain(resposta.status);

    const org = (await listarOrganizacoes()).body.items.find(o => o.id === organizationId);
    expect(org.selfRegistrationOpen, 'continua fechada').toBe(false);
    expect((await filiacoesPublicas()).body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(false);
  });

  it('nem o ADMIN abre: a permissão é só do SUPER_ADMIN, e de propósito', async () => {
    // MEDIDO EM `src/utils/permissions.js`: o papel ADMIN recebe TODAS as
    // permissões MENOS `organizations.manage`. Abrir o autocadastro torna as
    // filiações da federação descobríveis por qualquer visitante da
    // internet — é decisão de quem responde pela plataforma, não do
    // administrador da operação do dia.
    //
    // Este teste cobra a especificidade da guarda: um papel que passa em
    // quase tudo continua sendo recusado AQUI.
    const administrador = await criarUsuario({ role: 'ADMIN', name: 'Administrador da operação' });
    await vincular(organizationId, administrador, 'ADMIN');

    const resposta = await alternar(administrador, true);
    expect([401, 403]).toContain(resposta.status);

    const org = (await listarOrganizacoes()).body.items.find(o => o.id === organizationId);
    expect(org.selfRegistrationOpen, 'continua fechada').toBe(false);
    expect((await filiacoesPublicas()).body.items.some(f => f.organization?.name === 'MCI Brasil')).toBe(false);
  });

  it('a mudança fica na auditoria, com o antes e o depois', async () => {
    expect((await alternar(admin, true)).status).toBe(200);

    const registros = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { organizationId, action: 'ORGANIZATION_SELF_REGISTRATION_OPEN' },
      select: { action: true, entityId: true, metadata: true }
    }));

    expect(registros.length).toBe(1);
    expect(registros[0].entityId).toBe(organizationId);
    expect(registros[0].metadata).toMatchObject({ de: false, para: true });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, unico, comoAtor
} from './helpers.mjs';
import {
  can, effectivePermissions, PERMISSOES_CENTRAIS_DELEGADAS, PERMISSOES_NAO_DELEGAVEIS, ROLE_PERMISSIONS
} from '../src/utils/permissions.js';

// ============================================================================
// A DELEGAÇÃO CENTRAL — DECISÃO R-02, medida nos dois lados.
//
// PRIMEIRO COMO FUNÇÃO PURA. `effectivePermissions` é onde a concessão se
// transforma em poder, e as três regras dela — prazo, escopo e não
// delegabilidade — precisam ser medidas sem banco: é isso que torna a expiração
// verificável sem esperar o tempo passar, e é isso que garante que uma linha
// gravada por FORA da rota (script, migration, mão humana no banco) não viaja
// como permissão.
//
// DEPOIS PELA ROTA. A recusa de conceder o que não é delegável e a de conceder
// para si mesmo são do serviço, e valem o que valem quando chegam como HTTP.
// ============================================================================

const usuario = (extras = {}) => ({
  id: 'u1', role: 'ATHLETE', memberships: [], centralGrantsReceived: [], ...extras
});

describe('a concessão viva vira permissão; a que não está viva, não', () => {
  it('concessão sem prazo vale, e vale no escopo declarado', () => {
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: 'orgA', expiresAt: null }]
    });
    expect(can(ator, 'athletes.transfer', 'orgA')).toBe(true);
  });

  it('concessão de uma federação NÃO vale na outra', () => {
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: 'orgA', expiresAt: null }]
    });
    expect(can(ator, 'athletes.transfer', 'orgB')).toBe(false);
  });

  it('concessão COM escopo não responde à pergunta SEM escopo', () => {
    // A ausência de organização na pergunta significa "em qualquer lugar", e não
    // é isso que uma delegação local concede. Sem esta regra, o mesmo grant
    // responderia sim a uma checagem global e o escopo viraria decoração.
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: 'orgA', expiresAt: null }]
    });
    expect(can(ator, 'athletes.transfer', null)).toBe(false);
  });

  it('concessão SEM escopo vale em qualquer federação', () => {
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: null, expiresAt: null }]
    });
    expect(can(ator, 'athletes.transfer', 'orgA')).toBe(true);
    expect(can(ator, 'athletes.transfer', 'orgB')).toBe(true);
  });

  it('a EXPIRAÇÃO é conferida na hora da pergunta, sem depender de job', () => {
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: 'orgA', expiresAt: '2026-01-01T00:00:00.000Z' }]
    });
    // Antes do vencimento: vale.
    expect(can(ator, 'athletes.transfer', 'orgA', new Date('2025-12-31T23:59:59.000Z'))).toBe(true);
    // NO instante do vencimento já não vale: o limite é `<=`, e uma concessão
    // "válida até" não vale no instante em que expira.
    expect(can(ator, 'athletes.transfer', 'orgA', new Date('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(can(ator, 'athletes.transfer', 'orgA', new Date('2026-06-01T00:00:00.000Z'))).toBe(false);
  });

  it('`central.grant` gravada como concessão é IGNORADA na leitura', () => {
    // Esta é a barreira contra a linha plantada por fora da rota. O serviço já
    // recusa conceder `central.grant`; aqui prova-se que, mesmo que ela exista
    // na tabela, não vira poder — a cadeia termina em SUPER_ADMIN.
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'central.grant', organizationId: null, expiresAt: null }]
    });
    expect(can(ator, 'central.grant', 'orgA')).toBe(false);
    expect(can(ator, 'central.grant', null)).toBe(false);
  });

  it('permissão inexistente na matriz não vira poder, mesmo gravada', () => {
    const ator = usuario({
      centralGrantsReceived: [{ permission: 'inventada.total', organizationId: null, expiresAt: null }]
    });
    expect(effectivePermissions(ator, 'orgA').has('inventada.total')).toBe(false);
  });

  it('permissão REAL mas FORA da lista branca também não vira poder', () => {
    // A barreira que importa é esta. `results.publish` e `users.manage` existem
    // na matriz e são permissões graves; o serviço recusa concedê-las, mas a
    // política `central_concessao` deixa o administrador de plataforma inserir
    // qualquer linha, e script, migration e mão humana no banco não passam pelo
    // serviço. A conferência da LEITURA é a que decide — sem ela,
    // `CentralAuthorization` seria uma segunda matriz RBAC, invisível para
    // `tests/matriz-de-autorizacao.mjs`.
    const ator = usuario({
      centralGrantsReceived: [
        { permission: 'results.publish', organizationId: null, expiresAt: null },
        { permission: 'users.manage', organizationId: 'orgA', expiresAt: null }
      ]
    });
    expect(can(ator, 'results.publish', 'orgA')).toBe(false);
    expect(can(ator, 'users.manage', 'orgA')).toBe(false);
    // E a delegável continua funcionando: a conferência não quebrou o caso bom.
    const comDelegavel = usuario({
      centralGrantsReceived: [{ permission: 'athletes.transfer', organizationId: 'orgA', expiresAt: null }]
    });
    expect(can(comDelegavel, 'athletes.transfer', 'orgA')).toBe(true);
  });
});

describe('nenhum papel recebe `athletes.transfer` por construção — R-02', () => {
  it('nem EVENT_DIRECTOR, nem ADMIN de plataforma', () => {
    expect(ROLE_PERMISSIONS.EVENT_DIRECTOR.includes('athletes.transfer')).toBe(false);
    expect(ROLE_PERMISSIONS.ADMIN.includes('athletes.transfer')).toBe(false);
  });

  it('SUPER_ADMIN continua tendo, por construção', () => {
    expect(can({ id: 'sa', role: 'SUPER_ADMIN', memberships: [] }, 'athletes.transfer', 'orgA')).toBe(true);
  });

  it('as duas listas dizem o que é delegável e o que nunca é', () => {
    expect([...PERMISSOES_CENTRAIS_DELEGADAS]).toEqual(['athletes.transfer']);
    expect([...PERMISSOES_NAO_DELEGAVEIS]).toEqual(['central.grant']);
    // A interseção vazia não é detalhe: uma permissão que estivesse nas duas
    // listas seria delegável e não delegável ao mesmo tempo, e a ordem das
    // conferências decidiria a resposta.
    const nasDuas = PERMISSOES_CENTRAIS_DELEGADAS.filter(p => PERMISSOES_NAO_DELEGAVEIS.includes(p));
    expect(nasDuas).toEqual([]);
  });
});

describe('a rota de concessão recusa o que a decisão proíbe', () => {
  let admin;
  let alvo;
  let orgId;

  beforeEach(async () => {
    await garantirCatalogo();
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
    alvo = await criarUsuario({ role: 'ADMIN', name: 'Administradora Delegada' });
    orgId = (await criarOrganizacao(admin, { name: unico('Federação') })).id;
    await vincular(orgId, alvo, 'ATHLETE');
  });

  it('permissão FORA da lista branca é recusada com o motivo, não com 400 genérico', async () => {
    const tentativa = await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
      userId: alvo.id, permission: 'results.publish', reason: 'Tentativa de delegar publicação.'
    });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(422);
    expect(tentativa.body.error.code).toBe('PERMISSION_NOT_DELEGABLE');
    // A recusa diz o que É delegável: sem isso, quem administra fica adivinhando.
    expect(tentativa.body.error.details.delegaveis).toEqual(['athletes.transfer']);
  });

  it('`central.grant` é recusada com a mensagem da cadeia de concessão', async () => {
    const tentativa = await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
      userId: alvo.id, permission: 'central.grant', reason: 'Tentativa de delegar a própria delegação.'
    });
    expect(tentativa.status).toBe(422);
    expect(tentativa.body.error.code).toBe('PERMISSION_NOT_DELEGABLE');
    expect(tentativa.body.error.message).toContain('SUPER_ADMIN');
  });

  it('prazo no PASSADO é recusado na entrada, e não gravado para nunca valer', async () => {
    const tentativa = await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
      userId: alvo.id, permission: 'athletes.transfer',
      reason: 'Concessão com prazo vencido.', expiresAt: '2020-01-01T00:00:00.000Z'
    });
    expect(tentativa.status).toBe(422);
    expect(tentativa.body.error.code).toBe('EXPIRES_AT_IN_PAST');
  });

  it('a mesma concessão viva não é gravada duas vezes — a trava é do banco', async () => {
    const corpo = { userId: alvo.id, permission: 'athletes.transfer', organizationId: orgId, reason: 'Primeira concessão formal.' };
    const primeira = await api().post('/api/v1/central-authorizations').set(admin.auth()).send(corpo);
    expect(primeira.status).toBe(201);

    const segunda = await api().post('/api/v1/central-authorizations').set(admin.auth()).send(corpo);
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body.error.code).toBe('GRANT_ALREADY_ACTIVE');

    // E REVOGAR reabre a vaga: a coluna `activeKey` volta a NULL e a linha
    // permanece, com quem revogou e por quê.
    const revogacao = await api().post(`/api/v1/central-authorizations/${primeira.body.id}/revoke`)
      .set(admin.auth()).send({ reason: 'Encerrada a atuação.' });
    expect(revogacao.status).toBe(200);

    const terceira = await api().post('/api/v1/central-authorizations').set(admin.auth()).send(corpo);
    expect(terceira.status, 'a vaga reabriu depois da revogação').toBe(201);
  });

  it('a concessão de OUTRA pessoa não é legível — a barreira é do banco', async () => {
    // MEDIDO por mutação (TE-P1): trocar `central_leitura` por `USING (true)`
    // SOBREVIVIA a toda a suíte, porque toda leitura pela API já filtra por
    // permissão (`central.grant`/`audit.read`) ou por `userId = ator`. A folga
    // da política não tinha caminho de aplicação por onde ser observada.
    //
    // Este teste observa a POLÍTICA, não a rota: um terceiro sem relação
    // nenhuma com a concessão consulta a tabela dentro do contexto de RLS dele.
    // `CentralAuthorization` É a permissão de alterar atribuição de pontos;
    // quem pode ler o mapa de quem tem esse poder sabe a quem atacar.
    const criada = await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
      userId: alvo.id, permission: 'athletes.transfer', organizationId: orgId, reason: 'Concessão formal.'
    });
    expect(criada.status).toBe(201);

    const terceiro = await criarUsuario({ name: 'Conta Sem Relação' });
    const visiveis = await comoAtor(terceiro, tx => tx.centralAuthorization.findMany());
    expect(visiveis, 'terceiro não enxerga concessão nenhuma').toHaveLength(0);

    // O DELEGADO enxerga a dele — saber que poder se tem é legítimo, e não
    // saber é pior.
    const doDelegado = await comoAtor(alvo, tx => tx.centralAuthorization.findMany());
    expect(doDelegado).toHaveLength(1);
    expect(doDelegado[0].userId).toBe(alvo.id);
  });

  it('a pessoa vê a própria delegação sem precisar poder conceder', async () => {
    await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
      userId: alvo.id, permission: 'athletes.transfer', organizationId: orgId, reason: 'Concessão formal.'
    });

    const minhas = await api().get('/api/v1/central-authorizations/me').set(alvo.auth());
    expect(minhas.status).toBe(200);
    expect(minhas.body.items).toHaveLength(1);
    expect(minhas.body.items[0].permission).toBe('athletes.transfer');
  });
});

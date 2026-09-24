import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico
} from './helpers.mjs';
import filiacaoOficial from '../src/services/officialAffiliationService.js';
import { withUserContext } from '../src/config/rlsSession.js';

// ============================================================================
// A ENTIDADE DE FILIAÇÃO OFICIAL: NPC - National Physique Committe.
//
// O DEFEITO MEDIDO
//
// Na tela "Solicitar perfil de atleta" o campo ENTIDADE DE FILIAÇÃO aparecia
// vazio, com "Nenhuma entidade de filiação ativa está disponível para a sua
// conta." — e sem entidade o atleta não conclui o autocadastro.
//
// Não era a tela e não era RLS: `Affiliation` e `Organization` não têm política
// nenhuma. Era DADO QUE NUNCA FOI PROVISIONADO:
//
//   · `Organization.selfRegistrationOpen` nasce `false`, e é ligado em EXATAMENTE
//     UM lugar de todo o código — `organizationService.setSelfRegistration`;
//   · NADA no repositório cria uma `Affiliation`, fora o endpoint manual e
//     `scripts/qa/dataset.mjs`, que é QA.
//
// Esta suíte cobra a tampa: que o provisionamento garanta as duas coisas, de
// forma idempotente, sem nunca duplicar, e que PARE em conflito em vez de
// escolher.
//
// A PRIMEIRA ASSERÇÃO DE CADA CENÁRIO É A LINHA DE BASE. Sem ela, um estado
// correto no fim não prova que foi o provisionamento que o produziu.
// ============================================================================

const NOME = 'NPC - National Physique Committe';
const CODIGO = 'NPC';

let admin;
let organizationId;

const rodarScript = (env = {}, ...args) => spawnSync(
  'node', ['scripts/provisionar-contas-de-servico.js', ...args],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } }
);

const diagnosticar = orgId => comoAtor(admin, () => filiacaoOficial.diagnosticar(orgId));
const provisionar = orgId => withUserContext(admin.id, () => filiacaoOficial.provisionar(orgId, admin));

const filiacoesDe = orgId => comoAtor(admin, tx => tx.affiliation.findMany({
  where: { organizationId: orgId },
  select: { id: true, name: true, code: true, kind: true, active: true },
  orderBy: { code: 'asc' }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  // `autocadastroAberto: false` REPRODUZ PRODUÇÃO. O helper abre o autocadastro
  // por padrão — conveniência para as outras suítes, e aqui seria o arreio
  // escondendo justamente o estado que esta fase existe para corrigir. Medi
  // isso com nove testes vermelhos.
  organizationId = (await criarOrganizacao(admin, {
    name: 'Federação Oficial', autocadastroAberto: false
  })).id;
});

// ---------------------------------------------------------------- A, B, C, D
describe('a organização nasce com o autocadastro FECHADO — a causa raiz', () => {
  it('criar organização pelo caminho real deixa selfRegistrationOpen em false', async () => {
    // A ASSERÇÃO QUE NOMEIA O DEFEITO. `criarOrganizacao` usa a rota real, e o
    // padrão da coluna é `false` por decisão de projeto: nenhuma federação
    // passa a ser descoberta sem ato administrativo. O que faltava era o ato
    // ser PROVISIONÁVEL em vez de só clicável.
    const org = await comoAtor(admin, tx => tx.organization.findUnique({
      where: { id: organizationId }, select: { selfRegistrationOpen: true }
    }));
    expect(org.selfRegistrationOpen).toBe(false);
  });

  it('e por isso a vitrine pública não devolve entidade nenhuma', async () => {
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: CODIGO });

    // A filiação EXISTE e está ATIVA — e a vitrine continua vazia. É a prova de
    // que a causa não era a filiação, e sim o estado da organização.
    const filiacoes = await filiacoesDe(organizationId);
    expect(filiacoes.length).toBe(1);
    expect(filiacoes[0].active).toBe(true);

    const vitrine = await api().get('/api/v1/public/affiliations');
    expect(vitrine.status).toBe(200);
    expect(vitrine.body.items).toEqual([]);
  });
});

describe('banco novo: a NPC não existe e passa a existir', () => {
  it('diagnostica ausente e fechado, depois provisiona os dois', async () => {
    const antes = await diagnosticar(organizationId);
    expect(antes.estado).toBe(filiacaoOficial.ESTADOS.PENDENTE);
    expect(antes.affiliationId).toBeNull();
    expect(antes.selfRegistrationOpen).toBe(false);
    expect(antes.pendencias.sort()).toEqual(['AUTOCADASTRO_FECHADO', 'FILIACAO_AUSENTE']);

    const depois = await provisionar(organizationId);

    expect(depois.estado).toBe(filiacaoOficial.ESTADOS.CORRETO);
    expect(depois.acoes.sort()).toEqual(['AUTOCADASTRO_ABERTO', 'FILIACAO_CRIADA']);
    expect(depois.affiliationName).toBe(NOME);
    expect(depois.affiliationCode).toBe(CODIGO);
    expect(depois.affiliationKind).toBe('ENTITY');
    expect(depois.affiliationActive).toBe(true);
    expect(depois.selfRegistrationOpen).toBe(true);
    expect(depois.pendencias).toEqual([]);
  });

  it('o autocadastro de OUTRA organização continua fechado', async () => {
    const outra = (await criarOrganizacao(admin, { name: 'Federação Vizinha', autocadastroAberto: false })).id;

    await provisionar(organizationId);

    const vizinha = await comoAtor(admin, tx => tx.organization.findUnique({
      where: { id: outra }, select: { selfRegistrationOpen: true }
    }));
    // ABRIR A PORTA DE UMA NÃO ABRE A DE TODAS. Abrir em massa tornaria toda
    // federação publicamente listável por efeito colateral do deploy.
    expect(vizinha.selfRegistrationOpen).toBe(false);
    expect(await filiacoesDe(outra)).toEqual([]);
  });
});

// ------------------------------------------------------------------- E, F, J
describe('idempotência', () => {
  it('dez execuções deixam UMA NPC e não reescrevem nada depois da primeira', async () => {
    const primeira = await provisionar(organizationId);
    expect(primeira.acoes.length).toBe(2);

    for (let i = 0; i < 9; i += 1) {
      const repetida = await provisionar(organizationId);
      expect(repetida.estado).toBe(filiacaoOficial.ESTADOS.CORRETO);
      // NENHUMA AÇÃO. "Presente e correta" não escreve — nem auditoria, porque
      // ato que não aconteceu não vai para a trilha.
      expect(repetida.acoes, `execução ${i + 2}`).toEqual([]);
    }

    expect((await filiacoesDe(organizationId)).length).toBe(1);

    const trilha = await comoAtor(admin, tx => tx.auditLog.count({
      where: { action: { startsWith: 'OFFICIAL_AFFILIATION' } }
    }));
    expect(trilha, 'uma linha de auditoria, não dez').toBe(1);
  });

  it('NPC inativa é reativada, e o nome e o tipo são normalizados', async () => {
    const criada = await provisionar(organizationId);

    await comoAtor(admin, tx => tx.affiliation.update({
      where: { id: criada.affiliationId },
      data: { active: false, name: 'npc antigo', kind: 'OTHER' }
    }));

    const antes = await diagnosticar(organizationId);
    expect(antes.pendencias.sort()).toEqual(['FILIACAO_INATIVA', 'NOME_DIVERGENTE', 'TIPO_DIVERGENTE']);

    const depois = await provisionar(organizationId);

    expect(depois.estado).toBe(filiacaoOficial.ESTADOS.CORRETO);
    expect(depois.acoes).toEqual(['FILIACAO_NORMALIZADA:active,kind,name']);
    expect(depois.affiliationId, 'a MESMA linha, não uma nova').toBe(criada.affiliationId);
    expect(depois.affiliationName).toBe(NOME);
    expect(depois.affiliationKind).toBe('ENTITY');
    expect(depois.affiliationActive).toBe(true);
  });

  it('a normalização registra o DE e o PARA na auditoria', async () => {
    const criada = await provisionar(organizationId);
    await comoAtor(admin, tx => tx.affiliation.update({
      where: { id: criada.affiliationId }, data: { kind: 'OTHER' }
    }));
    await provisionar(organizationId);

    const linha = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'OFFICIAL_AFFILIATION_NORMALIZED' }, select: { metadata: true }
    }));
    // SEM O "DE", a trilha registra que algo mudou e não O QUÊ.
    expect(linha.metadata.de.kind).toBe('OTHER');
    expect(linha.metadata.para.kind).toBe('ENTITY');
  });
});

// ---------------------------------------------------------------------- F, I
describe('conflito: PARA, e não escolhe', () => {
  it('o nome oficial sob OUTRO código é conflito, e nada é alterado', async () => {
    // O `code` é chave de reconhecimento da importação MuscleWar. Renomeá-lo
    // desligaria a conciliação por matrícula para tudo que já está no ledger —
    // decisão da federação, com o histórico na mão, nunca de um script.
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: 'NPCBR' });

    const d = await diagnosticar(organizationId);
    expect(d.estado).toBe(filiacaoOficial.ESTADOS.CONFLITO);
    expect(d.candidatas.length).toBe(1);
    expect(d.candidatas[0].affiliationCode).toBe('NPCBR');
    expect(d.candidatas[0].vinculos).toBeTruthy();

    await expect(provisionar(organizationId)).rejects.toThrow(/mais de uma entidade candidata|nome oficial sob outro/i);

    // NADA CRIADO, NADA APAGADO, NADA RENOMEADO.
    const depois = await filiacoesDe(organizationId);
    expect(depois.length).toBe(1);
    expect(depois[0].code).toBe('NPCBR');
    expect(depois[0].name).toBe(NOME);
  });

  it('duas candidatas é conflito, e as duas sobrevivem com os vínculos relatados', async () => {
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: CODIGO });
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: 'NPCBR' });

    const d = await diagnosticar(organizationId);
    expect(d.estado).toBe(filiacaoOficial.ESTADOS.CONFLITO);
    expect(d.candidatas.length).toBe(2);
    expect(d.candidatas.map(c => c.affiliationCode).sort()).toEqual(['NPC', 'NPCBR']);

    await expect(provisionar(organizationId)).rejects.toThrow();
    expect((await filiacoesDe(organizationId)).length).toBe(2);
  });

  it('variantes de caixa do código são duplicidade real, porque a unicidade é sensível a caixa', async () => {
    // `@@unique([organizationId, code])` NÃO ignora caixa: 'NPC' e 'npc'
    // coexistem sem violar nada. Medido, e não suposto.
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: CODIGO });
    const minusculo = await comoAtor(admin, tx => tx.affiliation.create({
      data: { organizationId, name: 'Outra coisa', code: 'npc', kind: 'ENTITY', active: true },
      select: { id: true }
    }));
    expect(minusculo.id, 'o banco aceitou as duas caixas').toBeTruthy();

    const d = await diagnosticar(organizationId);
    expect(d.estado).toBe(filiacaoOficial.ESTADOS.CONFLITO);
    expect(d.candidatas.length).toBe(2);
  });
});

// ---------------------------------------------------------------------- G, H
describe('a organização é CONFIGURAÇÃO, e nunca descoberta', () => {
  it('id inexistente falha, e nenhuma outra organização é escolhida no lugar', async () => {
    const d = await diagnosticar('nao-existe-esse-id');
    expect(d.estado).toBe(filiacaoOficial.ESTADOS.ORGANIZACAO_INEXISTENTE);

    await expect(provisionar('nao-existe-esse-id')).rejects.toThrow(/não existe/i);

    // A ASSERÇÃO QUE IMPORTA: a organização que EXISTE não foi tocada.
    expect(await filiacoesDe(organizationId)).toEqual([]);
    const org = await comoAtor(admin, tx => tx.organization.findUnique({
      where: { id: organizationId }, select: { selfRegistrationOpen: true }
    }));
    expect(org.selfRegistrationOpen).toBe(false);
  });

  it('variável ausente ou vazia é estado próprio, e não "escolha qualquer uma"', async () => {
    for (const valor of [undefined, null, '', '   ']) {
      const d = await diagnosticar(valor);
      expect(d.estado, `valor ${JSON.stringify(valor)}`)
        .toBe(filiacaoOficial.ESTADOS.ORGANIZACAO_NAO_CONFIGURADA);
    }
    await expect(provisionar('')).rejects.toThrow(/MCI_NPC_ORGANIZATION_ID/);
  });

  it('organização inativa falha explicitamente, sem criar a entidade', async () => {
    await comoAtor(admin, tx => tx.organization.update({
      where: { id: organizationId }, data: { active: false }
    }));

    const d = await diagnosticar(organizationId);
    expect(d.estado).toBe(filiacaoOficial.ESTADOS.ORGANIZACAO_INATIVA);
    expect(d.organizationActive).toBe(false);

    await expect(provisionar(organizationId)).rejects.toThrow(/inativa/i);
    expect(await filiacoesDe(organizationId)).toEqual([]);
  });
});

// ------------------------------------------------------------------------- K
describe('concorrência', () => {
  it('vinte provisionamentos simultâneos deixam UMA NPC', async () => {
    // O DEFEITO QUE ESTE TESTE ENCONTROU, e por isso ele existe:
    //
    // A primeira versão capturava P2002 e RELIA a linha. A releitura falhava com
    // `25P02: current transaction is aborted` — no PostgreSQL um statement
    // recusado aborta a transação inteira, e o `try/catch` do JavaScript não
    // desfaz isso. SAVEPOINT é a única contenção, e é o que `criarFiliacao` faz.
    const resultados = await Promise.allSettled(
      Array.from({ length: 20 }, () => provisionar(organizationId))
    );

    const cumpridas = resultados.filter(r => r.status === 'fulfilled');
    const recusadas = resultados.filter(r => r.status === 'rejected');

    expect(recusadas.map(r => r.reason?.message), 'nenhuma execução deve falhar').toEqual([]);
    expect(cumpridas.length).toBe(20);
    for (const r of cumpridas) expect(r.value.estado).toBe(filiacaoOficial.ESTADOS.CORRETO);

    // O INVARIANTE. Uma só, e a garantia é do banco.
    const filiacoes = await filiacoesDe(organizationId);
    expect(filiacoes.length, 'exatamente uma NPC').toBe(1);
    expect(filiacoes[0].code).toBe(CODIGO);

    // Exatamente uma criação na trilha, por mais que vinte tenham tentado.
    const criacoes = await comoAtor(admin, tx => tx.auditLog.count({
      where: { action: 'OFFICIAL_AFFILIATION_PROVISIONED' }
    }));
    expect(criacoes).toBe(1);
  });

  it('a conta de serviço e a membresia também não duplicam', async () => {
    await Promise.allSettled(Array.from({ length: 10 }, () => provisionar(organizationId)));

    const contagens = await comoAtor(admin, async tx => ({
      organizacoes: await tx.organization.count({ where: { id: organizationId } }),
      contas: await tx.user.count({ where: { serviceOrganizationId: organizationId, isServiceAccount: true } }),
      membresias: await tx.organizationMember.count({ where: { organizationId, role: 'FEDERATION_SERVICE' } })
    }));

    expect(contagens.organizacoes).toBe(1);
    expect(contagens.contas, 'uma conta de serviço').toBe(1);
    expect(contagens.membresias, 'uma membresia de serviço').toBe(1);
  });
});

// ------------------------------------------------------------------------- L
describe('o endpoint público', () => {
  it('devolve a NPC com o texto exato, e sem vazar o organizationId', async () => {
    const vazia = await api().get('/api/v1/public/affiliations');
    expect(vazia.body.items, 'linha de base: vitrine vazia antes').toEqual([]);

    await provisionar(organizationId);

    const r = await api().get('/api/v1/public/affiliations');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);

    const item = r.body.items[0];
    // O TEXTO EXATO que a tela mostra. Comparação literal de propósito: é o
    // nome oficial da entidade, e um caractere fora já é outro nome.
    expect(item.name).toBe(NOME);
    expect(item.code).toBe(CODIGO);
    expect(item.kind).toBe('ENTITY');

    // O `organizationId` NÃO SAI. A solicitação deriva a federação da filiação
    // escolhida, no servidor; devolvê-lo aqui só serviria para alguém tentar
    // mandá-lo de volta.
    expect(Object.keys(item).sort()).toEqual(['code', 'id', 'kind', 'name', 'organization', 'state'].sort());
    expect(item).not.toHaveProperty('organizationId');
    expect(Object.keys(item.organization)).toEqual(['name']);
  });

  it('a rota é ANÔNIMA: sem token, e devolve o mesmo que com token de atleta', async () => {
    await provisionar(organizationId);
    const atleta = await criarUsuario({ name: 'Pessoa Recém-Cadastrada' });

    const anonimo = await api().get('/api/v1/public/affiliations');
    const autenticado = await api().get('/api/v1/public/affiliations').set(atleta.auth());

    expect(anonimo.status).toBe(200);
    expect(autenticado.status).toBe(200);
    // Autenticar-se não pode ENTREGAR MENOS: foi exatamente esse o defeito que
    // fez `prismaPublico` nascer.
    expect(autenticado.body).toEqual(anonimo.body);
  });

  it('desativar a NPC a tira da vitrine, e reativar a devolve', async () => {
    const d = await provisionar(organizationId);

    await comoAtor(admin, tx => tx.affiliation.update({
      where: { id: d.affiliationId }, data: { active: false }
    }));
    expect((await api().get('/api/v1/public/affiliations')).body.items).toEqual([]);

    await provisionar(organizationId);
    expect((await api().get('/api/v1/public/affiliations')).body.items.length).toBe(1);
  });

  it('fechar o autocadastro da organização tira a NPC da vitrine', async () => {
    await provisionar(organizationId);
    expect((await api().get('/api/v1/public/affiliations')).body.items.length).toBe(1);

    await comoAtor(admin, tx => tx.organization.update({
      where: { id: organizationId }, data: { selfRegistrationOpen: false }
    }));
    // A federação pode voltar atrás, e a vitrine acompanha na hora.
    expect((await api().get('/api/v1/public/affiliations')).body.items).toEqual([]);
  });
});

// ------------------------------------------------------------------- P, Q, R
describe('RLS, cross-tenant e RBAC', () => {
  it('a NPC de uma federação não vaza para o operador da outra', async () => {
    await provisionar(organizationId);

    const outraOrg = (await criarOrganizacao(admin, { name: 'Federação Vizinha', autocadastroAberto: false })).id;
    const vizinho = await criarUsuario({ name: 'Operador Vizinho' });
    await vincular(outraOrg, vizinho, 'EVENT_DIRECTOR');

    const lista = await api().get('/api/v1/affiliations').set(vizinho.auth());
    expect(lista.status).toBe(200);
    // A listagem escopada não mostra a filiação da outra federação.
    expect(lista.body.items.map(i => i.code)).not.toContain(CODIGO);
  });

  it('o atleta comum não cria, não ativa e não desativa filiação', async () => {
    const d = await provisionar(organizationId);
    const atleta = await criarUsuario({ name: 'Atleta Comum' });

    const criar = await api().post('/api/v1/affiliations').set(atleta.auth())
      .send({ organizationId, name: 'Entidade Falsa', code: unico('FAKE').slice(0, 10).toUpperCase() });
    expect([401, 403]).toContain(criar.status);

    const desativar = await api().post(`/api/v1/affiliations/${d.affiliationId}/deactivate`).set(atleta.auth());
    expect([401, 403, 404]).toContain(desativar.status);

    // E a NPC continua exatamente como estava.
    const depois = await filiacoesDe(organizationId);
    expect(depois.length).toBe(1);
    expect(depois[0].active).toBe(true);
  });

  it('o atleta não abre o autocadastro de organização nenhuma', async () => {
    const atleta = await criarUsuario({ name: 'Atleta Comum' });
    const r = await api().post(`/api/v1/organizations/${organizationId}/self-registration`)
      .set(atleta.auth()).send({ open: true });
    expect([401, 403, 422]).toContain(r.status);

    const org = await comoAtor(admin, tx => tx.organization.findUnique({
      where: { id: organizationId }, select: { selfRegistrationOpen: true }
    }));
    expect(org.selfRegistrationOpen, 'continua fechado').toBe(false);
  });

  it('a conta de serviço da federação não recebe permissão de aplicação', async () => {
    await provisionar(organizationId);
    const conta = await comoAtor(admin, tx => tx.user.findFirst({
      where: { serviceOrganizationId: organizationId, isServiceAccount: true },
      select: { id: true, role: true, isServiceAccount: true }
    }));
    expect(conta.isServiceAccount).toBe(true);
    // Ela é identidade de BANCO, reconhecida por `mci_operator_of`, e não um
    // papel de aplicação: `assertCan` nega tudo a ela.
    const { permissionsForRole } = await import('../src/utils/permissions.js');
    const permissoes = permissionsForRole('FEDERATION_SERVICE');
    expect(permissoes.has('affiliations.manage')).toBe(false);
    expect(permissoes.has('organizations.manage')).toBe(false);
  });
});

// ----------------------------------------------------- o script, ponta a ponta
describe('o script do deploy, executado de verdade', () => {
  it('sem a variável, não verifica a entidade e não derruba o deploy', () => {
    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: '', PROVISIONAR_ADMIN_EMAIL: '' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('ORGANIZACAO_NAO_CONFIGURADA');
  });

  it('--conferir LÊ sem exigir autorização, e devolve 2 quando há pendência', () => {
    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: '' }, '--conferir');
    // Pedir credencial para OLHAR é o que faz um diagnóstico não ser usado.
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain('NADA foi escrito');
    expect(r.stdout).toContain('FILIACAO_AUSENTE');
  });

  it('--conferir não escreve nada', async () => {
    rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: admin.email }, '--conferir');
    expect(await filiacoesDe(organizationId)).toEqual([]);
    const org = await comoAtor(admin, tx => tx.organization.findUnique({
      where: { id: organizationId }, select: { selfRegistrationOpen: true }
    }));
    expect(org.selfRegistrationOpen).toBe(false);
  });

  it('com pendência e sem administrador, FALHA — e o deploy para', () => {
    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PROVISIONAR_ADMIN_EMAIL');
  });

  it('com administrador, provisiona e a vitrine passa a devolver a NPC', async () => {
    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: admin.email });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('FILIACAO_CRIADA');
    expect(r.stdout).toContain('AUTOCADASTRO_ABERTO');

    const vitrine = await api().get('/api/v1/public/affiliations');
    expect(vitrine.body.items.map(i => i.name)).toEqual([NOME]);
  });

  it('rodar duas vezes seguidas não duplica, e a segunda não faz nada', async () => {
    rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: admin.email });
    const segunda = rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: admin.email });

    expect(segunda.status).toBe(0);
    expect(segunda.stdout).toContain('Nada a fazer');
    expect((await filiacoesDe(organizationId)).length).toBe(1);
  });

  it('conflito derruba o script, e nada é alterado', async () => {
    await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: NOME, code: 'NPCBR' });

    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: organizationId, PROVISIONAR_ADMIN_EMAIL: admin.email });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('CONFLITO');

    const depois = await filiacoesDe(organizationId);
    expect(depois.length).toBe(1);
    expect(depois[0].code).toBe('NPCBR');
  });

  it('organização inexistente derruba o script sem escolher outra', async () => {
    const r = rodarScript({ MCI_NPC_ORGANIZATION_ID: 'nao-existe', PROVISIONAR_ADMIN_EMAIL: admin.email });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('não existe');
    expect(await filiacoesDe(organizationId)).toEqual([]);
  });
});

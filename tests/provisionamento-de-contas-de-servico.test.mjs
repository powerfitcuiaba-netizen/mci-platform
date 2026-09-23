import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, comoAtor, unico, api, gerarCpf
} from './helpers.mjs';
import contasDeServico from '../src/services/serviceAccountService.js';
import { withUserContext } from '../src/config/rlsSession.js';

// ============================================================================
// A FEDERAÇÃO QUE JÁ EXISTIA ANTES DESTA FASE.
//
// A conta de serviço nasce junto com a organização. As federações de PRODUÇÃO
// foram criadas antes disso — e a migration que acrescentou a coluna não cria
// linha nenhuma, porque migration altera ESTRUTURA e a conta de serviço é
// DADO.
//
// Sem provisionamento, `contaDaOrganizacao` não acha a conta e o autocadastro
// responde 503 para TODAS as federações existentes: a funcionalidade inteira
// desta fase não funcionaria em produção, e o sintoma só apareceria quando o
// primeiro atleta tentasse se cadastrar.
//
// Esta suíte mede o buraco e a tampa: que o 503 é o que acontece sem a conta,
// e que depois de provisionar o autocadastro volta a concluir sozinho.
// ============================================================================

let admin, organizationId, npc;

// Simula a federação LEGADA: cria pela rota real e depois REMOVE a conta de
// serviço, que é o estado exato em que produção está — organização completa,
// sem a identidade técnica que só passou a existir agora.
const tornarLegada = async (orgId) => {
  const conta = await comoAtor(admin, tx => tx.user.findFirst({
    where: { serviceOrganizationId: orgId, isServiceAccount: true }, select: { id: true }
  }));
  expect(conta, 'a organização nasceu sem conta: a fixture não mede nada').toBeTruthy();
  // Apagar o usuário leva a membresia junto (cascata), que é o estado legado.
  await comoAtor(admin, tx => tx.user.delete({ where: { id: conta.id } }));
  return conta.id;
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  organizationId = (await criarOrganizacao(admin, { name: 'Federação Legada' })).id;
  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Legado', code: 'NPCLEG' })).body;
});

describe('a federação legada, sem conta de serviço', () => {
  it('o autocadastro RECUSA com 503, e não com erro genérico', async () => {
    await tornarLegada(organizationId);

    const pessoa = await criarUsuario({ name: 'Atleta Legado' });
    const r = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'Atleta Legado', cpf: gerarCpf(770001), sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: `LEG-${unico('m')}`
    });

    // 503 e não 500: é indisponibilidade de configuração, não defeito de
    // programa. A distinção importa para quem lê o log às três da manhã.
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(503);
    // 503 e não 500: o STATUS é o que distingue indisponibilidade de
    // configuração de defeito de programa, e é o que o operador vê primeiro.
    // O `code` sai como INTERNAL_ERROR de propósito — o tratador de erros não
    // devolve código de 5xx para fora, para não descrever a topologia interna
    // a quem está do lado de fora. O motivo real fica no log do servidor.

    // E NADA SOBRA: nem atleta, nem identidade. A recusa é limpa.
    const sobrou = await comoAtor(admin, async tx => ({
      atletas: await tx.athlete.count(),
      identidades: await tx.athleteIdentity.count()
    }));
    expect(sobrou).toEqual({ atletas: 0, identidades: 0 });
  });

  it('o provisionamento cria a conta, e o autocadastro volta a concluir sozinho', async () => {
    const idAntigo = await tornarLegada(organizationId);

    // O MESMO caminho que a criação de organização usa. Rodar outro caminho
    // aqui faria existirem duas versões da mesma coisa, que é como as duas
    // divergem sem ninguém notar.
    await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));

    const conta = await comoAtor(admin, tx => tx.user.findFirst({
      where: { serviceOrganizationId: organizationId, isServiceAccount: true },
      select: { id: true, role: true, serviceOrganizationId: true }
    }));
    expect(conta, 'o provisionamento não criou a conta').toBeTruthy();
    expect(conta.id, 'reaproveitou a conta apagada').not.toBe(idAntigo);
    expect(conta.role).toBe('FEDERATION_SERVICE');

    // A MEMBRESIA TAMBÉM, senão `mci_operator_of` não a reconhece e a conta
    // existe sem poder fazer nada — que é uma falha pior, porque parece certa.
    const membresia = await comoAtor(admin, tx => tx.organizationMember.findFirst({
      where: { userId: conta.id, organizationId }, select: { role: true }
    }));
    expect(membresia, 'a conta ficou sem membresia').toBeTruthy();
    expect(membresia.role).toBe('FEDERATION_SERVICE');

    // E O QUE IMPORTA: o autocadastro conclui de novo, sozinho.
    const pessoa = await criarUsuario({ name: 'Atleta Depois' });
    const r = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'Atleta Depois', cpf: gerarCpf(770002), sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: `LEG-${unico('m')}`
    });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.reviewedById, 'alguém aprovou').toBeNull();
  });

  it('provisionar de novo não cria uma segunda conta', async () => {
    // Idempotência não é elegância aqui: o script roda a CADA deploy, de
    // propósito, para que ninguém precise lembrar quais federações já foram
    // atendidas. Se a segunda execução duplicasse, o deploy seguinte quebraria
    // a unicidade de `serviceOrganizationId` e derrubaria a subida.
    const primeira = await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));
    const segunda = await withUserContext(admin.id, () => contasDeServico.provisionar(organizationId, admin));

    expect(segunda.id).toBe(primeira.id);

    const quantas = await comoAtor(admin, tx => tx.user.count({
      where: { serviceOrganizationId: organizationId, isServiceAccount: true }
    }));
    expect(quantas).toBe(1);
  });

  it('cada federação legada recebe a SUA conta, e não a de outra', async () => {
    const outraOrgId = (await criarOrganizacao(admin, { name: 'Outra Legada' })).id;
    await tornarLegada(organizationId);
    await tornarLegada(outraOrgId);

    for (const id of [organizationId, outraOrgId]) {
      await withUserContext(admin.id, () => contasDeServico.provisionar(id, admin));
    }

    const contas = await comoAtor(admin, tx => tx.user.findMany({
      where: { isServiceAccount: true },
      select: { id: true, serviceOrganizationId: true }
    }));
    expect(contas).toHaveLength(2);
    expect(new Set(contas.map(c => c.serviceOrganizationId)))
      .toEqual(new Set([organizationId, outraOrgId]));
  });
});

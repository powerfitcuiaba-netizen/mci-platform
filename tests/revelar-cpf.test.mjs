import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// REVELAR O CPF — a única porta pela qual o número inteiro sai por id.
//
// A tela administrativa mostra o CPF MASCARADO. Quando o operador precisa do
// inteiro, ele PEDE — e quem decide é o servidor, nunca o frontend.
//
// Duas permissões governam a resposta:
//
//   `athletes.read_sensitive`  abre o cadastro restrito (nascimento, telefone,
//                              e-mail, matrícula) e o CPF MASCARADO;
//   `search.sensitive`         é o que libera o DOCUMENTO em si.
//
// O QUE O MUTATION TESTING MOSTROU, e que esta suíte agora registra: na matriz
// ATUAL as duas andam sempre juntas. Todo papel que tem a primeira tem a
// segunda — e é coerente que tenha, porque quem opera inscrição, check-in e
// pesagem confere documento na porta do evento. Removendo o `assertCan` de
// `search.sensitive`, nenhum teste de caixa-preta muda de cor, porque não
// existe ator que as separe.
//
// Isso não torna a segunda conferência decorativa: ela EXPRESSA a regra, e
// passa a morder no dia em que a matriz criar um papel que veja o cadastro
// sem ver o documento. O último teste desta suíte fixa o fato — e reprova
// nesse dia, apontando o que fazer.
//
// E o número nunca entra em URL nem em parâmetro de consulta — ali ele ficaria
// no histórico do navegador, no cabeçalho Referer e no log de acesso do
// servidor, que são três lugares fora do alcance do RLS.
// ============================================================================

let admin;
let checkin;
let gerente;
let deOutraOrg;
let organizationId;
let athleteId;
let cpfDoAtleta;

const cpfSeq = (() => { let n = 663000000; return () => gerarCpf(n += 6637); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  checkin = await criarUsuario({ name: 'Operador de check-in' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  deOutraOrg = await criarUsuario({ name: 'Operador de outra federação' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, checkin, 'CHECKIN_OPERATOR');
  await vincular(organizationId, gerente, 'RANKING_MANAGER');

  const outra = await criarOrganizacao(admin, { name: unico('MCI Vizinha') });
  await vincular(outra.id, deOutraOrg, 'EVENT_DIRECTOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: unico('NPC').slice(0, 12).toUpperCase() });

  cpfDoAtleta = cpfSeq();
  const atleta = await api().post('/api/v1/athletes').set(admin.auth()).send({
    organizationId, fullName: 'QA ATLETA DE DOCUMENTO', sex: 'FEMALE', cpf: cpfDoAtleta
  });
  expect(atleta.status, JSON.stringify(atleta.body).slice(0, 300)).toBe(201);
  athleteId = atleta.body.id;
});

const revelar = ator => api().post(`/api/v1/athletes/${athleteId}/cpf`).set(ator.auth());
const perfil = ator => api().get(`/api/v1/athletes/${athleteId}`).set(ator.auth());

const formatado = cpf => `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;

const auditoriasDeLeitura = () => comoAtor(admin, tx => tx.auditLog.findMany({
  where: { action: 'ATHLETE_CPF_VIEW', entityId: athleteId },
  select: { userId: true, metadata: true, organizationId: true }
}));

describe('quem pode revelar', () => {
  it('SUPER_ADMIN recebe o número inteiro e formatado', async () => {
    const resposta = await revelar(admin);
    expect(resposta.status).toBe(200);
    expect(resposta.body.cpf).toBe(formatado(cpfDoAtleta));
  });

  it('o operador de check-in vê o cadastro restrito e TAMBÉM o documento — é o papel que o servidor lhe dá', async () => {
    // CHECKIN_OPERATOR tem `athletes.read_sensitive` E `search.sensitive`:
    // confere documento na porta do evento. O teste registra o fato em vez de
    // supô-lo — se a matriz mudar, ele reprova e alguém decide de novo.
    const resposta = await revelar(checkin);
    expect(resposta.status).toBe(200);
    expect(resposta.body.cpf).toBe(formatado(cpfDoAtleta));
  });
});

describe('quem NÃO pode revelar', () => {
  it('o gerente de ranking é recusado — ele administra pontos, não documentos', async () => {
    const resposta = await revelar(gerente);
    expect(resposta.status).toBe(403);
    expect(JSON.stringify(resposta.body)).not.toContain(cpfDoAtleta);
  });

  it('operador de OUTRA organização é recusado, mesmo sendo diretor lá', async () => {
    const resposta = await revelar(deOutraOrg);
    expect([403, 404]).toContain(resposta.status);
    expect(JSON.stringify(resposta.body)).not.toContain(cpfDoAtleta);
  });

  it('sem autenticação nenhuma, 401', async () => {
    const resposta = await api().post(`/api/v1/athletes/${athleteId}/cpf`);
    expect(resposta.status).toBe(401);
  });

  it('a recusa não deixa rastro de leitura, porque leitura não houve', async () => {
    await revelar(gerente);
    const trilha = await auditoriasDeLeitura();
    expect(trilha).toHaveLength(0);
  });
});

describe('toda revelação deixa rastro', () => {
  it('grava ATHLETE_CPF_VIEW com quem pediu, o atleta e a organização', async () => {
    await revelar(admin);
    const trilha = await auditoriasDeLeitura();

    expect(trilha).toHaveLength(1);
    expect(trilha[0].userId).toBe(admin.id);
    expect(trilha[0].organizationId).toBe(organizationId);
    expect(trilha[0].metadata).toMatchObject({ via: 'reveal' });
  });

  it('duas consultas deixam duas linhas — o rastro não é deduplicado', async () => {
    await revelar(admin);
    await revelar(admin);
    expect(await auditoriasDeLeitura()).toHaveLength(2);
  });
});

describe('o atleta inexistente responde 404, e não vaza existência por permissão', () => {
  it('id desconhecido é 404', async () => {
    const resposta = await api().post('/api/v1/athletes/clz0000000000000000000000/cpf').set(admin.auth());
    expect(resposta.status).toBe(404);
  });
});

describe('o perfil continua mascarando por conta própria', () => {
  it('GET /athletes/:id NÃO devolve o número inteiro para quem só tem leitura restrita', async () => {
    const resposta = await perfil(gerente);
    // O gerente pode nem ver o perfil restrito; o que não pode, em hipótese
    // nenhuma, é receber o documento inteiro por uma rota de leitura comum.
    expect(JSON.stringify(resposta.body)).not.toContain(cpfDoAtleta);
    expect(JSON.stringify(resposta.body)).not.toContain(formatado(cpfDoAtleta));
  });

  it('o campo `cpfMasked` existe para que a tela nunca precise mascarar sozinha', async () => {
    const resposta = await perfil(admin);
    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete.cpfMasked).toBeTruthy();
    expect(resposta.body.athlete.cpfMasked).not.toBe(formatado(cpfDoAtleta));
  });
});

// ------------------------------------------------------- a matriz de papéis

describe('a matriz de papéis, fixada por escrito', () => {
  it('hoje nenhum papel vê o cadastro restrito sem ver também o documento', async () => {
    // Quando este teste reprovar, é porque alguém criou um papel que separa as
    // duas permissões — o que é legítimo e provavelmente desejado. O que fazer
    // então: acrescentar a este arquivo um caso que use esse papel novo contra
    // `POST /athletes/:id/cpf` e exija 403, e tirar da declaração de
    // equivalência, em `scripts/qa/mutantes-atleta.mjs`, o mutante
    // "revelar o CPF deixa de exigir search.sensitive" — que a partir daí
    // passa a morrer.
    const { ROLE_PERMISSIONS, permissionsForRole } = await import('../src/utils/permissions.js');

    const separam = Object.keys(ROLE_PERMISSIONS).filter(papel => {
      const permissoes = permissionsForRole(papel);
      return permissoes.has('athletes.read_sensitive') && !permissoes.has('search.sensitive');
    });

    expect(separam, `papéis que separam as duas permissões: ${separam.join(', ')}`).toEqual([]);

    // E o outro lado do fato: existe pelo menos um papel com as duas, senão a
    // rota seria inalcançável e a suíte inteira estaria medindo o vazio.
    const comAsDuas = Object.keys(ROLE_PERMISSIONS).filter(papel => {
      const permissoes = permissionsForRole(papel);
      return permissoes.has('athletes.read_sensitive') && permissoes.has('search.sensitive');
    });
    expect(comAsDuas.length).toBeGreaterThan(0);
  });
});

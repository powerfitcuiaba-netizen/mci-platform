import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// A MATRIZ DE LEITURA DO MÓDULO — ONZE PERFIS × DEZESSETE ROTAS.
//
// POR QUE ESTE ARQUIVO EXISTE, E POR QUE ELE NÃO PODIA FALTAR
//
// `tests/matriz-de-autorizacao.mjs` é a lista estrutural do projeto: uma linha
// por rota MUTANTE autenticada, conferida contra a superfície registrada no
// Express. Ela é excelente e tem um limite declarado no próprio nome — **rota
// mutante**. As rotas de LEITURA ficam fora.
//
// E os dois achados de autorização desta etapa foram, os dois, em rotas de
// leitura:
//
//   A-01  `GET /coaches/:id/ranking/eligibility` e `/projection` exigiam apenas
//         sessão: qualquer conta lia `status` e equipes de qualquer treinador;
//   A-13  `GET /coaches` devolvia a linha INTEIRA de `Coach`, com o MOTIVO de
//         uma rejeição, para qualquer conta autenticada.
//
// Nenhum gate estrutural teria pegado nenhum dos dois. Este arquivo fecha esse
// buraco para a superfície de leitura do módulo, e a forma dele é deliberada:
//
//   1. OS PERFIS SÃO ESTADOS DO DOMÍNIO, não papéis. "Treinador" não é um
//      perfil: são cinco (pendente, aprovado sem federação, aprovado sem equipe,
//      aprovado com equipe, e de outra federação), porque cada um desses estados
//      derruba um predicado diferente de R-03, R-04 e da RLS.
//
//   2. CADA ROTA DECLARA QUEM DEVE CONSEGUIR. Para todos os outros, o teste
//      exige recusa — 401 sem sessão, 403 ou 404 com sessão. Célula que
//      responder 2xx para quem não está na lista é achado, não detalhe.
//
//   3. O CORPO É CONFERIDO EM TODA CÉLULA, inclusive nas de sucesso. Campo
//      proibido não vaza nem para quem tem direito à rota: `passwordHash`, CPF e
//      chave de arquivo não pertencem a resposta nenhuma deste módulo.
//
// O banco é preparado UMA vez: a matriz é somente leitura, e refazer onze perfis
// por caso multiplicaria o tempo por dezesseis sem medir nada a mais.
// ============================================================================

// Campos que não pertencem a NENHUMA resposta deste módulo, para NENHUM perfil.
const PROIBIDOS_SEMPRE = Object.freeze([
  'passwordHash', 'cpf', 'cpfMasked', 'storageKey'
]);

// A-13: o catálogo de técnicos não publica a análise cadastral.
const PROIBIDOS_DO_CATALOGO = Object.freeze([
  'status', 'rejectionReason', 'suspendedReason', 'reviewedById', 'reviewedAt',
  'registration', 'bio', 'phone', 'email', 'userId'
]);

// F-04: a lista da federação mostra `registration` — é a credencial profissional
// que a federação confere antes de autorizar, e o mesmo campo que a mesa central
// já vê na fila. O resto da análise cadastral continua fora.
//
// `status` NÃO entra nesta lista, e o motivo é de instrumento: a conferência
// abaixo procura o TEXTO do campo no corpo inteiro, e o corpo traz
// `authorization.status`, que é a situação da autorização NAQUELA federação —
// não a situação cadastral do treinador. Quem garante o conjunto exato de
// campos desta rota é o bloco F-04 de `hardening-auditoria-treinadores`, que
// compara as chaves uma a uma.
const PROIBIDOS_DA_ATUACAO = Object.freeze([
  'rejectionReason', 'suspendedReason', 'reviewedById', 'reviewedAt',
  'bio', 'phone', 'email', 'userId'
]);

const RECUSAS_COM_SESSAO = Object.freeze([403, 404]);

const ctx = {};

beforeAll(async () => {
  await limparBanco();
  garantirCatalogo();

  const cpf = (() => { let n = 660000000; return () => gerarCpf(n += 5551); })();

  // ------------------------------------------------------- as duas federações
  ctx.central = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  ctx.orgA = (await criarOrganizacao(ctx.central, { name: unico('Federação A') })).id;
  ctx.orgB = (await criarOrganizacao(ctx.central, { name: unico('Federação B') })).id;

  ctx.diretorA = await criarUsuario({ name: 'Diretor A' });
  ctx.diretorB = await criarUsuario({ name: 'Diretor B' });
  await vincular(ctx.orgA, ctx.diretorA, 'EVENT_DIRECTOR');
  await vincular(ctx.orgB, ctx.diretorB, 'EVENT_DIRECTOR');

  // ------------------------------------------------------ os perfis de atleta
  ctx.contaComum = await criarUsuario({ name: 'Conta Qualquer' });

  ctx.atletaDono = await criarUsuario({ name: 'Atleta Dono' });
  const atletaA = await criarAtleta(ctx.diretorA, ctx.orgA, {
    fullName: 'Joana Ferreira', cpf: cpf(), affiliationNumber: '6001'
  });
  await api().patch(`/api/v1/athletes/${atletaA.id}`).set(ctx.diretorA.auth())
    .send({ userId: ctx.atletaDono.id });
  ctx.atletaA = atletaA;

  ctx.atletaDeB = await criarUsuario({ name: 'Atleta De B' });
  const atletaB = await criarAtleta(ctx.diretorB, ctx.orgB, {
    fullName: 'Carla Souza', cpf: cpf(), affiliationNumber: '6002'
  });
  await api().patch(`/api/v1/athletes/${atletaB.id}`).set(ctx.diretorB.auth())
    .send({ userId: ctx.atletaDeB.id });

  // ------------------------------------------- os CINCO estados de treinador
  //
  // Cada um derruba um predicado diferente. É por isso que são cinco perfis e
  // não um: "treinador" sozinho esconderia exatamente o que importa medir.
  const cadastrar = async (conta, nome) => {
    const r = await api().post('/api/v1/coaches/self-register').set(conta.auth())
      .send({ name: nome, registration: unico('CREF') });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id;
  };
  // APROVAR DEIXOU DE SER PASSO: o autocadastro já nasce APPROVED desde a decisão
  // que substituiu a análise central. Chamar `approve` aqui devolveria 422
  // `COACH_STATUS_UNCHANGED`.
  //
  // O que precisou de caminho novo é o CONTRÁRIO: o perfil "treinador pendente"
  // desta matriz não é mais criável pelo produto. Ele representa um cadastro
  // feito ANTES da mudança, que ficou em análise e não foi aprovado
  // retroativamente — e a única forma honesta de montar um estado que o produto
  // não produz mais é escrevê-lo, dizendo que é isso que se está fazendo.
  const voltarParaAnalise = async id => comoAtor(ctx.central, tx => tx.coach.update({
    where: { id },
    data: { status: 'PENDING', autoApprovedAt: null, reviewedAt: null }
  }));
  const autorizar = async (id, org, diretor) => expect((await api().post(`/api/v1/coaches/${id}/organizations`)
    .set(diretor.auth()).send({ organizationId: org, reason: 'Atuação autorizada.' })).status).toBe(200);

  ctx.treinadorPendente = await criarUsuario({ role: 'COACH', name: 'Treinador Pendente' });
  ctx.coachPendente = await cadastrar(ctx.treinadorPendente, 'Treinador Pendente');
  await voltarParaAnalise(ctx.coachPendente);

  ctx.treinadorSemOrg = await criarUsuario({ role: 'COACH', name: 'Treinador Sem Federação' });
  ctx.coachSemOrg = await cadastrar(ctx.treinadorSemOrg, 'Treinador Sem Federação');

  ctx.treinadorSemEquipe = await criarUsuario({ role: 'COACH', name: 'Treinador Sem Equipe' });
  ctx.coachSemEquipe = await cadastrar(ctx.treinadorSemEquipe, 'Treinador Sem Equipe');
  await autorizar(ctx.coachSemEquipe, ctx.orgA, ctx.diretorA);

  ctx.treinador = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
  ctx.coachId = await cadastrar(ctx.treinador, 'Treinadora Marta');
  await autorizar(ctx.coachId, ctx.orgA, ctx.diretorA);
  ctx.equipeA = (await api().post('/api/v1/teams').set(ctx.diretorA.auth())
    .send({ organizationId: ctx.orgA, name: unico('Equipe Marta') })).body;
  expect((await api().post(`/api/v1/teams/${ctx.equipeA.id}/coach`).set(ctx.diretorA.auth())
    .send({ coachId: ctx.coachId })).status).toBe(200);

  ctx.treinadorDeB = await criarUsuario({ role: 'COACH', name: 'Treinador De B' });
  ctx.coachDeB = await cadastrar(ctx.treinadorDeB, 'Treinador De B');
  await autorizar(ctx.coachDeB, ctx.orgB, ctx.diretorB);
  ctx.equipeB = (await api().post('/api/v1/teams').set(ctx.diretorB.auth())
    .send({ organizationId: ctx.orgB, name: unico('Equipe De B') })).body;
  expect((await api().post(`/api/v1/teams/${ctx.equipeB.id}/coach`).set(ctx.diretorB.auth())
    .send({ coachId: ctx.coachDeB })).status).toBe(200);

  // Um convite pendente, para que a listagem de pedidos da equipe tenha linha.
  expect((await api().post('/api/v1/team-membership-requests').set(ctx.treinador.auth())
    .send({ athleteId: atletaA.id, teamId: ctx.equipeA.id, reason: 'Convite.' })).status).toBe(201);

  // Uma temporada, porque as duas rotas de ranking a exigem.
  ctx.seasonId = (await api().post('/api/v1/seasons').set(ctx.central.auth())
    .send({ organizationId: ctx.orgA, name: unico('Temporada'), year: 2033 })).body.id;
}, 240_000);

// OS ONZE PERFIS. `null` é o visitante sem sessão, e ele é um perfil como os
// outros: a superfície pública é uma decisão, não um acidente.
const PERFIS = [
  'anonimo', 'contaComum', 'atletaDono', 'atletaDeB',
  'treinadorPendente', 'treinadorSemOrg', 'treinadorSemEquipe', 'treinador', 'treinadorDeB',
  'diretorA', 'central'
];

const AUTENTICADOS = PERFIS.filter(p => p !== 'anonimo');
const TREINADORES = ['treinadorPendente', 'treinadorSemOrg', 'treinadorSemEquipe', 'treinador', 'treinadorDeB'];

// ----------------------------------------------------------------- as rotas
//
// `permitidos` é quem DEVE conseguir, e `esperado` é o status de sucesso — que
// nem sempre é 200: o bloqueio de §8.3 é 409, e é a resposta correta.
const ROTAS = () => [
  {
    nome: 'GET /coaches (catálogo de técnicos)',
    caminho: '/api/v1/coaches',
    permitidos: AUTENTICADOS,
    proibidos: PROIBIDOS_DO_CATALOGO,
    porQue: 'o catálogo serve para ESCOLHER um técnico; a análise cadastral é da mesa central (A-13)'
  },
  {
    nome: 'GET /coaches/me',
    caminho: '/api/v1/coaches/me',
    permitidos: TREINADORES,
    porQue: 'o próprio cadastro, por `coaches.read_own`; quem não é treinador não tem a permissão'
  },
  {
    nome: 'GET /coaches/me/teams',
    caminho: '/api/v1/coaches/me/teams',
    permitidos: TREINADORES,
    porQue: 'as equipes do próprio cadastro, por `teams.read_own`'
  },
  {
    nome: 'GET /coaches/me/athletes',
    caminho: '/api/v1/coaches/me/athletes',
    permitidos: TREINADORES,
    proibidos: ['documents', 'birthDate', 'phone'],
    porQue: 'os atletas das próprias equipes — dado esportivo e nada além (R-05)'
  },
  {
    nome: 'GET /coaches/review (fila da mesa central)',
    caminho: '/api/v1/coaches/review?status=PENDING',
    permitidos: ['central'],
    porQue: 'analisar cadastro é da administração central (R-03), por `coaches.approve`'
  },
  {
    nome: 'GET /coaches/authorizable (lista da federação)',
    caminho: c => `/api/v1/coaches/authorizable?organizationId=${c.orgA}`,
    permitidos: ['diretorA', 'central'],
    proibidos: PROIBIDOS_DA_ATUACAO,
    porQue: 'autorizar atuação é da federação (R-04), por `coaches.authorize_org` NAQUELA federação'
  },
  {
    nome: 'GET /coaches/:id/review',
    caminho: c => `/api/v1/coaches/${c.coachId}/review`,
    permitidos: ['central'],
    porQue: 'o mesmo de acima, para um cadastro'
  },
  {
    nome: 'GET /coaches/:id/documents',
    caminho: c => `/api/v1/coaches/${c.coachId}/documents`,
    permitidos: ['central'],
    porQue: 'documento da análise é da mesa central — nem o dono lista o próprio (R-05)'
  },
  {
    nome: 'GET /documents/coach/:id/download',
    caminho: c => `/api/v1/documents/coach/${c.coachId}/download`,
    permitidos: [],
    porQue: 'não há documento anexado; ninguém baixa nada, e nenhum perfil passa por 2xx'
  },
  {
    nome: 'GET /coaches/:id/ranking/eligibility',
    caminho: c => `/api/v1/coaches/${c.coachId}/ranking/eligibility?seasonId=${c.seasonId}`,
    permitidos: ['treinador', 'central'],
    porQue: 'o DONO do cadastro e a mesa central; a recusa é 404 igual à de id inexistente (A-01)'
  },
  {
    nome: 'GET /coaches/:id/ranking/projection',
    caminho: c => `/api/v1/coaches/${c.coachId}/ranking/projection?seasonId=${c.seasonId}`,
    permitidos: ['treinador', 'central'],
    porQue: 'o mesmo alcance de `eligibility` (A-01)'
  },
  {
    nome: 'GET /ranking/coaches (bloqueio de §8.3)',
    caminho: '/api/v1/ranking/coaches',
    permitidos: PERFIS,
    esperado: 409,
    porQue: 'a fórmula NÃO está homologada: a recusa é pública, e dizer o motivo é a função da rota'
  },
  {
    nome: 'GET /coaches/ranking/divergences',
    caminho: c => `/api/v1/coaches/ranking/divergences?seasonId=${c.seasonId}`,
    permitidos: ['diretorA', 'central'],
    porQue: 'conferência de R-01 sobre PONTO, por `ranking.manage` — não sobre cadastro'
  },
  {
    nome: 'GET /team-membership-requests?teamId= (equipe própria)',
    caminho: c => `/api/v1/team-membership-requests?teamId=${c.equipeA.id}`,
    permitidos: ['treinador', 'diretorA', 'central'],
    porQue: 'os pedidos da equipe: o treinador responsável e o operador da federação dela'
  },
  {
    nome: 'GET /team-membership-requests/me',
    caminho: '/api/v1/team-membership-requests/me',
    permitidos: AUTENTICADOS,
    porQue: 'os pedidos dirigidos À PRÓPRIA pessoa; quem não tem nenhum recebe lista vazia'
  },
  {
    nome: 'GET /central-authorizations',
    caminho: '/api/v1/central-authorizations',
    permitidos: ['central'],
    porQue: 'o mapa de quem pode alterar atribuição de pontos (R-02) — só quem concede ou audita'
  },
  {
    nome: 'GET /central-authorizations/me',
    caminho: '/api/v1/central-authorizations/me',
    permitidos: AUTENTICADOS,
    porQue: 'saber que poder se tem é legítimo, e não saber é pior'
  }
];

const resolver = (caminho, c) => (typeof caminho === 'function' ? caminho(c) : caminho);

const pedir = (caminho, perfil) => {
  const pedido = api().get(caminho);
  return perfil === 'anonimo' ? pedido : pedido.set(ctx[perfil].auth());
};

describe('a matriz de LEITURA do módulo: onze perfis × dezesseis rotas', () => {
  for (const rota of ROTAS()) {
    describe(rota.nome, () => {
      for (const perfil of PERFIS) {
        const deveConseguir = rota.permitidos.includes(perfil);
        const rotulo = deveConseguir ? 'PERMITE' : 'RECUSA';

        it(`${rotulo} ${perfil}`, async () => {
          const caminho = resolver(rota.caminho, ctx);
          const r = await pedir(caminho, perfil);
          const corpo = JSON.stringify(r.body ?? {});

          if (deveConseguir) {
            expect(r.status, `${rota.nome} / ${perfil}: ${corpo.slice(0, 300)}`)
              .toBe(rota.esperado ?? 200);
          } else if (perfil === 'anonimo') {
            // Sem sessão a recusa é 401, e não 403: dizer "proibido" a quem não
            // se identificou confirma que o recurso existe.
            expect(r.status, `${rota.nome} / anônimo: ${corpo.slice(0, 300)}`).toBe(401);
          } else {
            expect(RECUSAS_COM_SESSAO, `${rota.nome} / ${perfil}: ${corpo.slice(0, 300)}`)
              .toContain(r.status);
          }

          // O CORPO É CONFERIDO EM TODA CÉLULA, inclusive nas de sucesso: campo
          // proibido não vaza nem para quem tem direito à rota.
          for (const proibido of [...PROIBIDOS_SEMPRE, ...(rota.proibidos ?? [])]) {
            expect(corpo, `${rota.nome} / ${perfil} não pode carregar ${proibido}`)
              .not.toContain(proibido);
          }
        });
      }
    });
  }
});

// ============================================================================
// AS DUAS INVARIANTES QUE A MATRIZ SOZINHA NÃO EXPRESSA.
// ============================================================================
describe('as invariantes da superfície de leitura', () => {
  it('a recusa de A-01 é indistinguível da de id inexistente, para TODO perfil recusado', async () => {
    // É a propriedade antienumeração, e ela vale por perfil: se um único perfil
    // receber 403 onde os outros recebem 404, aquele perfil virou oráculo.
    const recusados = PERFIS.filter(p => !['treinador', 'central', 'anonimo'].includes(p));

    for (const perfil of recusados) {
      const real = await pedir(`/api/v1/coaches/${ctx.coachId}/ranking/eligibility?seasonId=${ctx.seasonId}`, perfil);
      const falso = await pedir(`/api/v1/coaches/nao-existe-este-id/ranking/eligibility?seasonId=${ctx.seasonId}`, perfil);

      expect(real.status, `${perfil}: id real`).toBe(404);
      expect(falso.status, `${perfil}: id inventado`).toBe(real.status);
      expect(falso.body.error.code).toBe(real.body.error.code);
    }
  });

  it('nenhum treinador enxerga a equipe de outro, nem com o id dela na mão', async () => {
    // O treinador da federação B pede a equipe da A, e vice-versa. A recusa é
    // 403 com motivo, e vem ANTES do atalho de lista vazia — um 200 vazio
    // confirmaria que o id existe.
    const pares = [
      ['treinador', ctx.equipeB.id],
      ['treinadorDeB', ctx.equipeA.id],
      ['treinadorSemEquipe', ctx.equipeA.id]
    ];
    for (const [perfil, equipe] of pares) {
      const r = await pedir(`/api/v1/coaches/me/athletes?teamId=${equipe}`, perfil);
      expect(r.status, `${perfil} pedindo a equipe ${equipe}`).toBe(403);
    }
  });

  it('o catálogo de técnicos entrega a MESMA projeção para todos os onze perfis', async () => {
    // Projeção que varia por perfil é projeção que alguém vai esquecer de aplicar
    // num perfil. Aqui o conjunto de chaves é conferido como igual para todos.
    const chavesPorPerfil = new Map();
    for (const perfil of AUTENTICADOS) {
      const r = await pedir('/api/v1/coaches', perfil);
      expect(r.status).toBe(200);
      const linha = r.body.items.find(item => item.id === ctx.coachId);
      expect(linha, `${perfil} vê o técnico no catálogo`).toBeTruthy();
      chavesPorPerfil.set(perfil, Object.keys(linha).sort().join(','));
    }
    const distintas = new Set(chavesPorPerfil.values());
    expect(distintas.size, `projeções distintas: ${[...chavesPorPerfil].map(([p, k]) => `${p}=${k}`).join(' | ')}`).toBe(1);
    expect([...distintas][0]).toBe('_count,city,id,name,state');
  });

  it('a trilha de auditoria registra o que a mesa central leu, e não o que os outros tentaram', async () => {
    // A tentativa recusada de LEITURA não gera linha — e isso é decisão, não
    // esquecimento: auditar toda recusa de leitura transformaria a trilha em
    // alvo de inundação, pela mesma razão do 429 de A-10.
    const linhas = await comoAtor(ctx.central, tx => tx.auditLog.count({
      where: { action: { in: ['COACH_APPROVE', 'COACH_ORG_AUTHORIZE', 'TEAM_COACH_SET'] } }
    }));
    expect(linhas, 'as decisões da preparação estão na trilha').toBeGreaterThan(0);
  });
});

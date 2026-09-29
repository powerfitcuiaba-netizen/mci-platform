import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, unico, autocadastrarTreinador
} from './helpers.mjs';
import {
  USER_ROLES, PAPEIS_DE_CADASTRO_ABERTO, PAPEIS_LEGADOS,
  isSelfServiceRole, isLegacyRole
} from '../src/utils/roles.js';
import { effectivePermissions } from '../src/utils/permissions.js';

// ============================================================================
// UNIFICAÇÃO DE TREINADOR E EQUIPE — uma oferta só, sem privilégio novo.
//
// A decisão aprovada: o cadastro deixa de oferecer "Coach" e "Equipe" como
// opções independentes e passa a oferecer **Treinador (Equipe)**, que é o papel
// `COACH`. A área do treinador é a mesma que já existia — vincular atletas,
// consultar os vinculados, conduzir as próprias equipes — sob as permissões que
// a MuscleContest já havia homologado.
//
// TRÊS COISAS PRECISAM SER VERDADE AO MESMO TEMPO, e só medidas juntas elas
// significam alguma coisa:
//
//   1. `TEAM` não é mais oferecido a quem se cadastra;
//   2. `TEAM` continua válido como papel de conta EXISTENTE — nenhuma conta é
//      apagada, convertida ou congelada;
//   3. ninguém ganha permissão por causa da unificação. Nem `COACH`, que já
//      tinha as dele; nem `TEAM`, que nunca teve NENHUMA permissão de treinador.
//
// A terceira é a que um refatorador bem-intencionado quebra primeiro: "já que
// unificamos, `TEAM` devia ter as permissões de `COACH`". Isso concederia área
// de treinador a contas que nunca passaram pela aprovação central (R-03).
// ============================================================================

const SENHA_DO_CONSTRUTOR = 'senha-de-teste-123';

// As cinco permissões homologadas de Treinador (Equipe). A lista é ESCRITA, e
// não derivada de `ROLE_PERMISSIONS`: derivá-la faria o teste concordar com
// qualquer alteração, inclusive com a que ampliasse o conjunto.
// ERAM CINCO, SÃO SEIS. A sexta é `teams.create_own`, e ela entrou com a decisão
// da autorização automática na NPC: sem ela o treinador entraria autorizado a
// atuar e continuaria esperando a federação criar a equipe, que é a espera que a
// decisão manda tirar do caminho.
//
// É a única do conjunto que ESCREVE, e não é `teams.manage` disfarçada: alcança
// a equipe que nasce com o próprio cadastro como responsável, na federação em que
// ele está autorizado. `POST /teams`, a rota do operador, continua recusando o
// treinador com 403 — medido em tests/autorizacao-automatica-npc.
const PERMISSOES_DE_TREINADOR = [
  'registrations.read',
  'coaches.read_own',
  'teams.read_own',
  'teams.create_own',
  'athletes.lookup_affiliation',
  'teams.request_membership'
];

const permissoesDe = role => [...effectivePermissions({ role, memberships: [] })].sort();

// A LINHA DE BASE, MEDIDA E NÃO SUPOSTA.
//
// `operacional()` sem argumento NÃO é conjunto vazio: é `BASE_AUTENTICADO`, as
// 14 leituras e ações de social que toda conta autenticada tem. Escrever este
// teste supondo "vazio" custou uma reprovação — e a suposição errada já estava
// escrita em cinco comentários antes de o teste medir.
//
// `ATHLETE` é a referência porque é o papel mais comum da plataforma. Se a base
// mudar um dia, ela muda para os dois juntos e este teste continua medindo a
// pergunta certa — "`TEAM` tem algo A MAIS que uma conta comum?" — em vez de
// envelhecer numa lista fixa.
const BASE_DE_CONTA_COMUM = () => permissoesDe('ATHLETE');

describe('a oferta de cadastro tem UMA opção de treinador e equipe', () => {
  it('`COACH` é oferecido; `TEAM` não é mais', () => {
    expect(PAPEIS_DE_CADASTRO_ABERTO).toContain('COACH');
    expect(PAPEIS_DE_CADASTRO_ABERTO, 'duas opções para a mesma pessoa é a duplicação que saiu').not.toContain('TEAM');
    expect(isSelfServiceRole('COACH')).toBe(true);
    expect(isSelfServiceRole('TEAM')).toBe(false);
  });

  it('a oferta tem seis perfis, e nenhum deles é duplicata de outro', () => {
    expect(PAPEIS_DE_CADASTRO_ABERTO).toEqual(['ATHLETE', 'COACH', 'GYM', 'BRAND', 'SPONSOR', 'MEDIA']);
    expect(new Set(PAPEIS_DE_CADASTRO_ABERTO).size).toBe(PAPEIS_DE_CADASTRO_ABERTO.length);
  });

  it('`TEAM` permanece no enum de papéis atribuíveis — contas reais dependem disso', () => {
    // Tirá-lo daqui faria `adminUserUpdate` (`z.enum(USER_ROLES)`) recusar
    // qualquer corpo para uma conta `TEAM`, congelando-a administrativamente.
    expect(USER_ROLES).toContain('TEAM');
    expect(PAPEIS_LEGADOS).toEqual(['TEAM']);
    expect(isLegacyRole('TEAM')).toBe(true);
    expect(isLegacyRole('COACH')).toBe(false);
  });
});

describe('a unificação não amplia privilégio de ninguém', () => {
  it('Treinador (Equipe) tem a base de conta comum MAIS as seis homologadas, e nada além', () => {
    const esperado = [...new Set([...BASE_DE_CONTA_COMUM(), ...PERMISSOES_DE_TREINADOR])].sort();
    expect(permissoesDe('COACH')).toEqual(esperado);
  });

  it('`TEAM` continua igual a uma conta comum — a unificação é de oferta, não de poder', () => {
    // Medido: `TEAM: operacional()` é `BASE_AUTENTICADO` e nada mais. Copiar as
    // seis permissões de `COACH` para cá daria área de treinador a quem nunca
    // fez o cadastro — e, com `teams.create_own`, poder de criar equipe.
    expect(permissoesDe('TEAM')).toEqual(BASE_DE_CONTA_COMUM());
  });

  it('a diferença entre Treinador (Equipe) e conta comum são exatamente as seis', () => {
    const base = new Set(BASE_DE_CONTA_COMUM());
    const aMais = permissoesDe('COACH').filter(p => !base.has(p));
    expect(aMais).toEqual([...PERMISSOES_DE_TREINADOR].sort());
  });

  it('`TEAM` não recebe nada de `COACH` por caminho nenhum', () => {
    for (const permissao of PERMISSOES_DE_TREINADOR) {
      expect(effectivePermissions({ role: 'TEAM', memberships: [] }).has(permissao),
        `\`TEAM\` não pode ter ${permissao}`).toBe(false);
    }
  });
});

describe('o cadastro de Treinador (Equipe) exige a área de treinador', () => {
  beforeAll(() => garantirCatalogo());
  beforeEach(() => limparBanco());

  const pedirCadastro = (conta, nome) => autocadastrarTreinador(conta, { name: nome, registration: unico('REG').slice(0, 24) });

  it('Treinador (Equipe) pede o próprio cadastro e consegue LER o que pediu', async () => {
    const treinador = await criarUsuario({ role: 'COACH', name: 'Treinador Novo' });

    const pedido = await pedirCadastro(treinador, 'Treinador Novo');
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    // APPROVED, e não PENDING: a decisão que substituiu a análise central. O que
    // NÃO mudou está medido em `aprovacao-automatica-de-treinador.test.mjs` —
    // aprovar cadastro continua não autorizando atuação em federação nenhuma.
    expect(pedido.body.status, 'o cadastro novo nasce aprovado').toBe('APPROVED');

    // A metade que faltava: o pedido tem de ser legível por quem o fez.
    const leitura = await api().get('/api/v1/coaches/me').set(treinador.auth());
    expect(leitura.status, JSON.stringify(leitura.body)).toBe(200);
    expect(leitura.body.id).toBe(pedido.body.id);
  });

  for (const papel of ['ATHLETE', 'GYM', 'BRAND', 'SPONSOR', 'MEDIA', 'TEAM']) {
    it(`conta ${papel} é RECUSADA e não deixa cadastro órfão no banco`, async () => {
      // O defeito medido antes da correção: a rota aceitava qualquer sessão, o
      // `Coach` nascia, e `GET /coaches/me` respondia 403 porque `meuCadastro`
      // exige `coaches.read_own`. O painel lê a falha como "ainda não há
      // cadastro" e devolve o formulário — a pessoa cadastrava de novo, recebia
      // 409, e nunca via o próprio pedido. Ficava no banco um cadastro que
      // ninguém abre, esperando análise de uma conta sem área de treinador.
      const conta = await criarUsuario({ role: papel, name: `Conta ${papel}` });

      const pedido = await pedirCadastro(conta, `Conta ${papel}`);
      expect(pedido.status, JSON.stringify(pedido.body)).toBe(403);

      expect(await prisma.coach.count({ where: { userId: conta.id } }),
        'a recusa não pode deixar cadastro nenhum atrás de si').toBe(0);
    });
  }

  it('sem sessão nenhuma a rota recusa antes de olhar permissão', async () => {
    const semSessao = await api().post('/api/v1/coaches/self-register').send({ name: 'Anônimo' });
    expect(semSessao.status).toBe(401);
  });
});

describe('a conta legada de equipe é preservada inteira', () => {
  beforeAll(() => garantirCatalogo());
  beforeEach(() => limparBanco());

  it('entra, mantém o papel e continua sem permissão — nada mudou por baixo dela', async () => {
    const equipe = await criarUsuario({ role: 'TEAM', name: 'Equipe Legada' });

    const entrada = await api().post('/api/v1/auth/login')
      .send({ email: equipe.email, password: SENHA_DO_CONSTRUTOR });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);
    expect(entrada.body.user.role).toBe('TEAM');

    // E como não tem `coaches.read_own`, a área de treinador segue fechada para
    // ela — que é o estado correto até a administração central decidir.
    const area = await api().get('/api/v1/coaches/me').set(equipe.auth());
    expect(area.status).toBe(403);
  });

  it('o registro no banco não é reescrito nem apagado', async () => {
    const equipe = await criarUsuario({ role: 'TEAM', name: 'Equipe Preservada' });

    const linha = await prisma.user.findUnique({
      where: { id: equipe.id }, select: { id: true, role: true, status: true, name: true }
    });
    expect(linha).toMatchObject({ id: equipe.id, role: 'TEAM', status: 'ACTIVE', name: 'Equipe Preservada' });
  });
});

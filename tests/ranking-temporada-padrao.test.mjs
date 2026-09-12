import { describe, it, expect, beforeAll } from 'vitest';
import { api, prisma, comoAtor, limparBanco, criarUsuario, criarOrganizacao, criarAtleta, unico } from './helpers.mjs';

// ==========================================================================
// Ranking sem temporada escolhida NÃO pode somar temporadas diferentes.
//
// O ranking de atletas já resolvia isso: sem `seasonId`, adota a temporada
// aberta mais recente, com o comentário no código dizendo por quê — "somar
// temporadas diferentes não significaria nada".
//
// Equipes, empresas e Super Overall não faziam o mesmo. Recebiam `seasonId`
// e o punham direto no `where`; ausente, o Prisma IGNORA a chave e a consulta
// varre TODAS as temporadas. Medido, não deduzido:
//
//   where { seasonId: undefined }  ->  devolve tudo
//   where { seasonId: <id real> }  ->  devolve só o da temporada
//
// E a tela de Ranking nasce com `seasonId = ''`: na primeira renderização ela
// pede exatamente isso. Com uma temporada só, ninguém percebe; na virada de
// 2026 para 2027, a aba "Equipes" mostraria a soma dos dois anos ao lado da
// aba "Atletas" mostrando apenas o ano corrente.
// ==========================================================================

let temporadaAntiga;
let temporadaAtual;
let equipe;
let empresa;

beforeAll(async () => {
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretora do ranking' });
  const organizationId = (await criarOrganizacao(admin, { name: 'Federação do ranking' })).id;

  const empresaResposta = await api().post('/api/v1/companies').set(admin.auth())
    .send({ organizationId, name: unico('Empresa') });
  expect(empresaResposta.status, JSON.stringify(empresaResposta.body)).toBe(201);
  empresa = empresaResposta.body;

  const equipeResposta = await api().post('/api/v1/teams').set(admin.auth())
    .send({ organizationId, name: unico('Equipe'), companyId: empresa.id });
  expect(equipeResposta.status, JSON.stringify(equipeResposta.body)).toBe(201);
  equipe = equipeResposta.body;

  const atleta = await criarAtleta(admin, organizationId, { fullName: 'Atleta das Duas Temporadas' });

  await comoAtor(admin.id, async () => {
    const criarTemporada = (nome, ano) => prisma.rankingSeason.create({
      data: {
        organizationId, name: nome, year: ano, status: 'OPEN',
        startDate: new Date(`${ano}-01-01T12:00:00.000Z`), endDate: new Date(`${ano}-12-31T12:00:00.000Z`)
      }
    });
    temporadaAntiga = await criarTemporada('Temporada 2025', 2025);
    temporadaAtual = await criarTemporada('Temporada 2026', 2026);

    // Ponto de ranking escrito direto: o que está sob teste é a LEITURA. O
    // caminho oficial de escrita (apuração + recompute) tem suíte própria.
    const lancar = (season, pontos) => prisma.rankingPoint.create({
      data: {
        seasonId: season.id, athleteId: atleta.id, source: 'MUSCLEWAR',
        points: pontos, placementPoints: pontos, superOverallPoints: pontos,
        superOverallEligible: true, teamId: equipe.id, companyId: empresa.id, placing: 1
      }
    });
    await lancar(temporadaAntiga, 10);
    await lancar(temporadaAtual, 7);
  });
});

const totalDaEquipe = corpo => corpo.find(linha => linha.team?.id === equipe.id)?.totalPoints
  ?? corpo.find(linha => linha.team?.id === equipe.id)?.points;

describe('sem seasonId, o ranking adota a temporada aberta mais recente', () => {
  it('equipes: 7 da temporada de 2026, e não 17 somando 2025', async () => {
    const resposta = await api().get('/api/v1/ranking/teams');
    expect(resposta.status).toBe(200);
    expect(totalDaEquipe(resposta.body), 'somou temporadas diferentes').toBe(7);
  });

  it('equipes: pedindo a temporada antiga explicitamente, vêm os 10 dela', async () => {
    const resposta = await api().get('/api/v1/ranking/teams').query({ seasonId: temporadaAntiga.id });
    expect(totalDaEquipe(resposta.body)).toBe(10);
  });

  it('empresas: mesma regra, mesmo motivo', async () => {
    const resposta = await api().get('/api/v1/ranking/companies');
    expect(resposta.status).toBe(200);
    const linha = resposta.body.find(l => l.company?.id === empresa.id);
    expect(linha?.totalPoints ?? linha?.points).toBe(7);
  });

  it('Super Overall: mesma regra, mesmo motivo', async () => {
    const resposta = await api().get('/api/v1/ranking/super-overall');
    expect(resposta.status).toBe(200);
    const itens = resposta.body.items ?? resposta.body;
    const total = itens[0]?.totalPoints ?? itens[0]?.points;
    expect(total).toBe(7);
  });

  it('o ranking de atletas já fazia certo — e continua fazendo', async () => {
    const resposta = await api().get('/api/v1/ranking');
    expect(resposta.status).toBe(200);
    expect(resposta.body.season?.id).toBe(temporadaAtual.id);
  });
});

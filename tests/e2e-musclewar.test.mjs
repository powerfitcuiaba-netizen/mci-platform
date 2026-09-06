import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// Importação de resultados do MuscleWar: reconhecimento por CPF, confirmação
// por filiação, pré-visualização, vinculação manual, aplicação e idempotência.

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;

const CPF_A = gerarCpf(101010101);
const CPF_B = gerarCpf(202020202);
const CPF_DESCONHECIDO = gerarCpf(303030303);

const csv = linhas => ['external_result_id,cpf,atleta,filiacao,categoria,classe,colocacao,pontos,evento', ...linhas].join('\n');

async function importar(conteudo, extras = {}) {
  return api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId,
    seasonId,
    sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv',
    content: conteudo,
    ...extras
  });
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  const respostaFiliacao = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' });
  filiacao = respostaFiliacao.body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada MuscleWar 2026', year: 2026 });
  seasonId = temporada.body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }] });

  await criarAtleta(gerente, organizationId, { fullName: 'Atleta Reconhecida', cpf: CPF_A, affiliationId: filiacao.id });
  await criarAtleta(gerente, organizationId, { fullName: 'Atleta Sem Filiação', cpf: CPF_B });
});

describe('importação MuscleWar', () => {
  it('pré-visualiza classificando cada linha antes de aplicar qualquer coisa', async () => {
    const resposta = await importar(csv([
      `MW-1,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa MuscleWar`,
      `MW-2,${CPF_DESCONHECIDO},Fulana Desconhecida,FED-MT,BIKINI,OPEN,2,80,Etapa MuscleWar`,
      `MW-3,${CPF_B},Atleta Sem Filiação,FED-MT,BIKINI,OPEN,3,60,Etapa MuscleWar`,
      `MW-4,${CPF_A},Atleta Reconhecida,FED-MT,CATEGORIA_INEXISTENTE,OPEN,1,100,Etapa MuscleWar`,
      `MW-5,000.000.000-00,CPF Ruim,FED-MT,BIKINI,OPEN,4,40,Etapa MuscleWar`,
      `,${CPF_A},Sem Identificador,FED-MT,BIKINI,OPEN,5,20,Etapa MuscleWar`
    ]));

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.summary).toEqual({
      totalRecords: 6,
      recognized: 1,
      pending: 1,
      conflicts: 2,
      duplicates: 0,
      rejected: 2,
      applied: 0,
      valid: 1
    });

    const porId = Object.fromEntries(resposta.body.items.map(item => [item.externalResultId, item]));
    expect(porId['MW-1'].matchStatus).toBe('MATCHED');
    expect(porId['MW-2'].matchStatus).toBe('MATCH_PENDING');
    expect(porId['MW-2'].reason).toMatch(/CPF não encontrado/);
    // Filiação divergente é conflito para revisão, não descarte.
    expect(porId['MW-3'].matchStatus).toBe('CONFLICT');
    expect(porId['MW-3'].reason).toMatch(/sem filiação/i);
    expect(porId['MW-4'].matchStatus).toBe('CONFLICT');
    expect(porId['MW-4'].reason).toMatch(/Categoria desconhecida/);
    expect(porId['MW-5'].matchStatus).toBe('IMPORT_REJECTED');
    expect(porId['MW-5'].reason).toMatch(/CPF inválido/);

    // Nada foi aplicado na pré-visualização.
    expect(await prisma.externalResult.count()).toBe(0);
    expect(await prisma.rankingPoint.count()).toBe(0);
  });

  it('nunca cria atleta a partir de CPF desconhecido', async () => {
    const antes = await prisma.athlete.count();
    await importar(csv([`MW-10,${CPF_DESCONHECIDO},Fulana Desconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    expect(await prisma.athlete.count()).toBe(antes);
  });

  it('aplica só o reconhecido e leva a pontuação ao ranking com origem rastreável', async () => {
    const lote = await importar(csv([
      `MW-20,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,,Etapa MuscleWar`,
      `MW-21,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,2,80,Etapa MuscleWar`
    ]));
    expect(lote.body.summary.recognized).toBe(1);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
    expect(aplicacao.body.applied).toBe(1);

    // Sem pontuação na origem, vale a tabela da temporada para a colocação.
    const pontos = await prisma.rankingPoint.findMany({ include: { externalResult: true } });
    expect(pontos).toHaveLength(1);
    expect(pontos[0].source).toBe('MUSCLEWAR');
    expect(pontos[0].points).toBe(100);
    expect(pontos[0].externalResult.externalId).toBe('MW-20');

    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items[0].totalPoints).toBe(100);

    // A linha pendente continua pendente e disponível para revisão.
    const revisao = await api().get(`/api/v1/musclewar/imports/${lote.body.import.id}`).set(gerente.auth());
    expect(revisao.body.summary.pending).toBe(1);
    expect(revisao.body.summary.applied).toBe(1);
  });

  it('reimportar o mesmo resultado não duplica pontuação', async () => {
    const linha = `MW-30,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa MuscleWar`;

    const primeiro = await importar(csv([linha]));
    await api().post(`/api/v1/musclewar/imports/${primeiro.body.import.id}/apply`).set(gerente.auth());

    // Segundo lote com o mesmo identificador externo: já sai como duplicado.
    const segundo = await importar(csv([linha]));
    expect(segundo.body.summary.duplicates).toBe(1);
    expect(segundo.body.summary.recognized).toBe(0);

    const aplicacaoRecusada = await api().post(`/api/v1/musclewar/imports/${segundo.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacaoRecusada.status).toBe(422);
    expect(aplicacaoRecusada.body.error.code).toBe('NOTHING_TO_APPLY');

    expect(await prisma.rankingPoint.count()).toBe(1);
    expect(await prisma.externalResult.count()).toBe(1);

    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items[0].totalPoints).toBe(100);
  });

  it('identificador repetido dentro do mesmo arquivo conta uma vez só', async () => {
    const linha = `MW-40,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`;
    const lote = await importar(csv([linha, linha]));

    expect(lote.body.summary.recognized).toBe(1);
    expect(lote.body.summary.duplicates).toBe(1);

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(await prisma.rankingPoint.count()).toBe(1);
  });

  it('vinculação manual resolve a pendência e libera a aplicação', async () => {
    const lote = await importar(csv([`MW-50,${CPF_DESCONHECIDO},Fulana,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    const pendente = lote.body.items[0];
    expect(pendente.matchStatus).toBe('MATCH_PENDING');

    const atleta = await prisma.athlete.findFirst({ where: { cpf: CPF_A } });

    const vinculo = await api().post(`/api/v1/musclewar/items/${pendente.id}/link`).set(gerente.auth())
      .send({ athleteId: atleta.id });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(200);
    expect(vinculo.body.matchStatus).toBe('MATCHED');
    expect(vinculo.body.reason).toMatch(/CPF da origem difere/);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.body.applied).toBe(1);

    const ponto = await prisma.rankingPoint.findFirst();
    expect(ponto.athleteId).toBe(atleta.id);
  });

  it('registra na auditoria quem importou, quem revisou e quem aplicou', async () => {
    const lote = await importar(csv([`MW-60,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,1,100,Etapa`]));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const trilha = await api().get('/api/v1/audit').set(admin.auth()).query({ entity: 'MuscleWarImport' });
    const acoes = trilha.body.items.map(item => item.action);

    expect(acoes).toContain('MUSCLEWAR_IMPORT');
    expect(acoes).toContain('MUSCLEWAR_APPLY');

    const aplicacao = trilha.body.items.find(item => item.action === 'MUSCLEWAR_APPLY');
    expect(aplicacao.userEmail).toBe(gerente.email);
    expect(aplicacao.metadata.applied).toBe(1);
    expect(aplicacao.metadata.sourceRef).toBeTruthy();

    // Histórico de importação não é apagado em silêncio.
    const historico = await comoAtor(gerente, async tx => ({
      lotes: await tx.muscleWarImport.count(),
      itens: await tx.muscleWarImportItem.count()
    }));
    expect(historico.lotes).toBe(1);
    expect(historico.itens).toBe(1);
  });

  it('recusa importação de quem não tem a permissão', async () => {
    const intruso = await criarUsuario({ name: 'Atleta comum' });
    const resposta = await api().post('/api/v1/musclewar/imports').set(intruso.auth())
      .send({ organizationId, seasonId, sourceType: 'CSV', sourceRef: 'x.csv', content: csv([`MW-70,${CPF_A},X,FED-MT,BIKINI,OPEN,1,100,E`]) });

    expect(resposta.status).toBe(403);
  });

  it('recusa importação para organização de outro tenant', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Outro Admin' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Outra Federação' });

    const resposta = await api().post('/api/v1/musclewar/imports').set(gerente.auth())
      .send({ organizationId: outraOrg.id, sourceType: 'CSV', sourceRef: 'x.csv', content: csv([`MW-80,${CPF_A},X,FED-MT,BIKINI,OPEN,1,100,E`]) });

    expect(resposta.status).toBe(403);
  });

  it('conflita quando a temporada não tem pontuação para a colocação informada', async () => {
    const lote = await importar(csv([`MW-90,${CPF_A},Atleta Reconhecida,FED-MT,BIKINI,OPEN,9,,Etapa`]));
    expect(lote.body.items[0].matchStatus).toBe('CONFLICT');
    expect(lote.body.items[0].reason).toMatch(/sem pontuação definida/);
  });
});

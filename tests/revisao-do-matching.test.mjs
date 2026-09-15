import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 9 — A TELA DE REVISÃO PRECISA MOSTRAR POR QUE O SISTEMA DECIDIU.
//
// A FASE 7 ensinou a plataforma a reconhecer o atleta por filiação+matrícula,
// por CPF ou a sugerir por nome. Mas a revisão continuava mostrando só o
// veredito — "Reconhecido", "Conflito" — sem dizer QUAL chave produziu aquilo.
//
// Um operador que não sabe por que a linha casou não tem como conferir se
// casou certo. E um CONFLICT sem os candidatos na tela vira um botão de
// "vincular" apertado no escuro.
//
// O que esta fase exige da API:
//   * `matchedBy`      a chave que reconheceu (filiação+matrícula, ou CPF)
//   * `suggestedAthlete` os dados do sugerido, não só o id
//   * `matchCandidates`  em CONFLICT, quem são os candidatos em disputa
//
// E o que ela proíbe: CONFLICT virar MATCHED sozinho, UNMATCHED ganhar vínculo
// automático, e a revisão expor dado sensível que o operador não precisa.
// ============================================================================

let admin, gerente, deFora, organizationId, seasonId, fedMT, fedSP;

const CPF_YURI = gerarCpf(212212212);
const CPF_KANANDA = gerarCpf(313313313);

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,member_number,categoria,classe,colocacao,evento';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

async function importar(conteudo, ator = null) {
  return api().post('/api/v1/musclewar/imports').set((ator || gerente).auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv', content: conteudo
  });
}

const porId = corpo => Object.fromEntries(corpo.items.map(item => [item.externalResultId, item]));

async function matricular(athleteId, filiacao, numero) {
  const resposta = await api().patch(`/api/v1/athletes/${athleteId}`).set(gerente.auth())
    .send({ affiliationId: filiacao.id, affiliationNumber: numero });
  expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  deFora = await criarUsuario({ name: 'Operador de Outra Casa' });

  fedMT = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Mato Grosso', code: 'NPC-MT' })).body;
  fedSP = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC São Paulo', code: 'NPC-SP' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;
});

describe('MATCHED — a tela diz qual chave reconheceu', () => {
  it('reconhecido por filiação + matrícula: matchedBy diz isso', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(atleta.id, fedMT, '88281');

    const resposta = await importar(csv(['R-1,,Yuri Santinelli,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga']));
    const linha = porId(resposta.body)['R-1'];

    expect(linha.matchStatus).toBe('MATCHED');
    expect(linha.matchedBy, 'a chave que reconheceu').toBe('AFFILIATION_NUMBER');
    expect(linha.athlete.fullName).toBe('Yuri Santinelli');
  });

  it('reconhecido por CPF: matchedBy diz CPF', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Kananda Dos Santos Azevedo', cpf: CPF_KANANDA });
    await matricular(atleta.id, fedMT, '147986');

    const resposta = await importar(csv([`R-2,${CPF_KANANDA},Kananda Dos Santos Azevedo,,,BIKINI,OPEN,2,Ipiranga`]));
    const linha = porId(resposta.body)['R-2'];

    expect(linha.matchStatus).toBe('MATCHED');
    expect(linha.matchedBy).toBe('CPF');
  });

  it('a matrícula do arquivo é devolvida para conferência', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(atleta.id, fedMT, '88281');

    const resposta = await importar(csv(['R-3,,Yuri Santinelli,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga']));
    const linha = porId(resposta.body)['R-3'];

    // É o Member Number — a matrícula de FILIAÇÃO —, e não `athleteNumber`,
    // que é outra coisa no modelo.
    expect(linha.memberNumber).toBe('88281');
  });
});

describe('sugestão por nome — o operador vê QUEM foi sugerido', () => {
  it('o sugerido vem com nome, filiação e matrícula, não só o id', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Carolina Martins', cpf: gerarCpf(414414414) });
    await matricular(atleta.id, fedSP, '155494');

    const resposta = await importar(csv(['R-4,,Carolina Martins,,,BIKINI,OPEN,1,Ipiranga']));
    const linha = porId(resposta.body)['R-4'];

    expect(linha.matchStatus, 'sugestão não é reconhecimento').toBe('MATCH_PENDING');
    expect(linha.athleteId, 'e não vincula').toBeNull();

    expect(linha.suggestedAthlete, 'o sugerido vem inteiro').toBeTruthy();
    expect(linha.suggestedAthlete.fullName).toBe('Carolina Martins');
    expect(linha.suggestedAthlete.affiliation.code).toBe('NPC-SP');
    expect(linha.suggestedAthlete.affiliationNumber).toBe('155494');
    expect(linha.matchedBy, 'nome não reconhece — não há chave de match').toBeNull();
  });

  it('sem sugestão, o campo vem nulo e não some', async () => {
    const resposta = await importar(csv(['R-5,,Ninguem Conhecido,,,BIKINI,OPEN,1,Ipiranga']));
    const linha = porId(resposta.body)['R-5'];

    expect(linha.matchStatus).toBe('MATCH_PENDING');
    expect(linha.suggestedAthlete).toBeNull();
  });
});

describe('CONFLICT — os candidatos em disputa aparecem', () => {
  it('chaves divergentes trazem os dois candidatos, com o que cada chave diz', async () => {
    const yuri = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(yuri.id, fedMT, '88281');
    const kananda = await criarAtleta(gerente, organizationId, { fullName: 'Kananda Dos Santos Azevedo', cpf: CPF_KANANDA });
    await matricular(kananda.id, fedMT, '147986');

    // Matrícula do Yuri, CPF da Kananda.
    const resposta = await importar(csv([`R-6,${CPF_KANANDA},Alguem,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga`]));
    const linha = porId(resposta.body)['R-6'];

    expect(linha.matchStatus).toBe('CONFLICT');
    expect(linha.athleteId, 'conflito NUNCA vincula sozinho').toBeNull();

    expect(linha.matchCandidates, 'os candidatos em disputa').toHaveLength(2);
    const porChave = Object.fromEntries(linha.matchCandidates.map(c => [c.matchedBy, c]));

    expect(porChave.AFFILIATION_NUMBER.fullName).toBe('Yuri Santinelli');
    expect(porChave.AFFILIATION_NUMBER.affiliationNumber).toBe('88281');
    // A entidade também: matrícula sem federação não diz nada ao operador,
    // porque o mesmo número existe em outra casa.
    expect(porChave.AFFILIATION_NUMBER.affiliation.code).toBe('NPC-MT');
    expect(porChave.CPF.fullName).toBe('Kananda Dos Santos Azevedo');
    expect(porChave.CPF.affiliation.code).toBe('NPC-MT');
    expect(porChave.CPF.affiliationNumber).toBe('147986');
  });

  it('CONFLICT não vira MATCHED ao aplicar o lote', async () => {
    const yuri = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(yuri.id, fedMT, '88281');
    const kananda = await criarAtleta(gerente, organizationId, { fullName: 'Kananda Dos Santos Azevedo', cpf: CPF_KANANDA });
    await matricular(kananda.id, fedMT, '147986');

    const criado = await importar(csv([`R-7,${CPF_KANANDA},Alguem,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga`]));
    const aplicado = await api().post(`/api/v1/musclewar/imports/${criado.body.import.id}/apply`)
      .set(gerente.auth()).send({});
    expect([200, 422]).toContain(aplicado.status);

    const depois = await comoAtor(gerente, tx => tx.muscleWarImportItem.findFirst({
      where: { externalResultId: 'R-7' }
    }));
    expect(depois.matchStatus, 'continua CONFLICT').toBe('CONFLICT');
    expect(depois.athleteId, 'e sem vínculo').toBeNull();

    const pontos = await comoAtor(gerente, tx => tx.rankingPoint.count({ where: { seasonId } }));
    expect(pontos, 'nenhum ponto nasceu de um conflito').toBe(0);
  });
});

describe('UNMATCHED — sem vínculo automático, e sem atleta criado', () => {
  it('aplicar o lote não cria atleta para linha não identificada', async () => {
    const antes = await comoAtor(gerente, tx => tx.athlete.count({ where: { organizationId } }));

    const criado = await importar(csv(['R-8,,Fulana Inexistente,,,BIKINI,OPEN,1,Ipiranga']));
    await api().post(`/api/v1/musclewar/imports/${criado.body.import.id}/apply`).set(gerente.auth()).send({});

    const depois = await comoAtor(gerente, tx => tx.athlete.count({ where: { organizationId } }));
    expect(depois, 'nenhum atleta criado').toBe(antes);

    const item = await comoAtor(gerente, tx => tx.muscleWarImportItem.findFirst({ where: { externalResultId: 'R-8' } }));
    expect(item.athleteId).toBeNull();
  });

  it('a sugestão NÃO vira vínculo ao aplicar', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Carolina Martins', cpf: gerarCpf(515515515) });
    await matricular(atleta.id, fedSP, '155494');

    const criado = await importar(csv(['R-9,,Carolina Martins,,,BIKINI,OPEN,1,Ipiranga']));
    await api().post(`/api/v1/musclewar/imports/${criado.body.import.id}/apply`).set(gerente.auth()).send({});

    const item = await comoAtor(gerente, tx => tx.muscleWarImportItem.findFirst({ where: { externalResultId: 'R-9' } }));
    expect(item.suggestedAthleteId, 'a sugestão continua lá').toBe(atleta.id);
    expect(item.athleteId, 'mas não virou vínculo').toBeNull();
  });
});

describe('a revisão é do operador da casa, e não mostra o que ele não precisa', () => {
  it('operador de outra organização não revisa este lote', async () => {
    const criado = await importar(csv(['R-10,,Alguem,,,BIKINI,OPEN,1,Ipiranga']));

    const tentativa = await api().get(`/api/v1/musclewar/imports/${criado.body.import.id}`).set(deFora.auth());
    expect([403, 404]).toContain(tentativa.status);
  });

  it('a revisão não devolve telefone, e-mail nem endereço do sugerido', async () => {
    const atleta = await criarAtleta(gerente, organizationId, {
      fullName: 'Carolina Martins', cpf: gerarCpf(616616616), phone: '65999990000', email: 'carol@mci.test'
    });
    await matricular(atleta.id, fedSP, '155494');

    const resposta = await importar(csv(['R-11,,Carolina Martins,,,BIKINI,OPEN,1,Ipiranga']));
    const corpo = JSON.stringify(porId(resposta.body)['R-11']);

    expect(corpo).not.toContain('65999990000');
    expect(corpo).not.toContain('carol@mci.test');
  });
});

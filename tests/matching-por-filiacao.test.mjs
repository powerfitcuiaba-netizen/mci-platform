import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';
import visibility from '../src/utils/visibility.js';

// ============================================================================
// FASE 7 — RECONHECER O ATLETA PELA FILIAÇÃO, E NÃO SÓ PELO CPF.
//
// A importação reconhecia o atleta por CPF e usava a filiação apenas como
// confirmação. O arquivo oficial do campeonato NÃO é redigido assim: o que ele
// traz é o Member Number — a matrícula do atleta dentro da entidade. Muitos
// arquivos não trazem CPF nenhum.
//
// Prioridade de reconhecimento, homologada:
//
//   1. filiação + matrícula      (as duas juntas; nenhuma sozinha identifica)
//   2. identidade já vinculada   (CPF em AthleteIdentity)
//   3. nome normalizado          (NUNCA reconhece sozinho — só SUGERE)
//   4. revisão manual
//
// A trava que não pode cair: semelhança de nome NUNCA cria atleta, e NUNCA
// vira MATCHED. Ela produz uma sugestão para um humano confirmar. Duas atletas
// chamadas "Ana Silva" existem, e criar a segunda como se fosse a primeira
// funde duas carreiras num cadastro só.
//
// E quando duas chaves apontam para atletas DIFERENTES, isso é CONFLICT — não
// "a que eu achei primeiro". Chaves que discordam são um fato sobre o arquivo
// ou sobre o cadastro, e quem decide é gente.
// ============================================================================

let admin, gerente, deFora, organizationId, seasonId, fedMT, fedSP;

const CPF_YURI = gerarCpf(510510510);
const CPF_KANANDA = gerarCpf(610610610);
const CPF_SOLTO = gerarCpf(710710710);

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,member_number,categoria,classe,colocacao,evento';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

async function importar(conteudo) {
  return api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv', content: conteudo
  });
}

const porId = resposta => Object.fromEntries(resposta.body.items.map(item => [item.externalResultId, item]));

// Matrícula é atributo do cadastro, e o operador precisa poder gravá-la.
async function matricular(athleteId, filiacaoId, numero) {
  const resposta = await api().patch(`/api/v1/athletes/${athleteId}`).set(gerente.auth())
    .send({ affiliationId: filiacaoId, affiliationNumber: numero });
  expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
  return resposta.body;
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
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  // Autenticado e sem vínculo com esta federação: enxerga só a projeção
  // pública do atleta.
  deFora = await criarUsuario({ name: 'Pessoa de Fora' });

  fedMT = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Mato Grosso', code: 'NPC-MT' })).body;
  fedSP = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC São Paulo', code: 'NPC-SP' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;
});

describe('o operador registra a matrícula junto com a filiação', () => {
  it('filiação e matrícula são gravadas como um par', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    const atualizado = await matricular(atleta.id, fedMT.id, '88281');

    expect(atualizado.affiliation.id).toBe(fedMT.id);
    expect(atualizado.affiliationNumber).toBe('88281');
  });

  it('a matrícula NÃO sai na projeção pública do atleta', async () => {
    // A entidade é pública; o número dentro dela, não. O par (nome, matrícula)
    // é o que os resultados oficiais usam para reconhecer alguém — publicá-lo
    // entregaria a chave de reivindicação de histórico a qualquer visitante.
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Flavia Blosfeld', cpf: gerarCpf(313313313) });
    await matricular(atleta.id, fedMT.id, '46576');

    // Duas barreiras, e as duas verificadas.
    //
    // A primeira é o tenant: quem não é da federação não lê o atleta de jeito
    // nenhum — 404, não uma versão reduzida. A segunda é a PROJEÇÃO, para os
    // caminhos que devolvem atleta sem ator (a vitrine pública): ali a
    // matrícula não pode estar.
    const deFora_ = await api().get(`/api/v1/athletes/${atleta.id}`).set(deFora.auth());
    expect(deFora_.status, 'fora da federação não lê o atleta').toBe(404);

    const projecaoPublica = visibility.athletePublic(
      await comoAtor(gerente, tx => tx.athlete.findUnique({
        where: { id: atleta.id }, include: { affiliation: true } }))
    );
    expect(projecaoPublica.affiliation?.name, 'a entidade continua pública').toBe('NPC Mato Grosso');
    expect(projecaoPublica.affiliationNumber, 'a matrícula não').toBeUndefined();
    expect(JSON.stringify(projecaoPublica)).not.toContain('46576');
  });

  it('o atleta não edita a própria matrícula', async () => {
    // Autoedição da matrícula permitiria reivindicar o histórico de outra
    // pessoa. É campo de operador, como a filiação.
    const dono = await criarUsuario({ name: 'Dona do Perfil' });
    const atleta = await criarAtleta(gerente, organizationId, {
      fullName: 'Kaue Inacio Campos', cpf: gerarCpf(414414414), userId: dono.id
    });
    await matricular(atleta.id, fedMT.id, '113349');

    const tentativa = await api().patch(`/api/v1/athletes/${atleta.id}`).set(dono.auth())
      .send({ affiliationNumber: '88281' });
    expect([200, 403]).toContain(tentativa.status);

    const depois = await comoAtor(gerente, tx => tx.athlete.findUnique({ where: { id: atleta.id } }));
    expect(depois.affiliationNumber, 'a matrícula não mudou').toBe('113349');
  });
});

describe('1) filiação + matrícula reconhecem SEM CPF', () => {
  it('arquivo sem CPF encontra o atleta pelo par filiação/matrícula', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(atleta.id, fedMT.id, '88281');

    const resposta = await importar(csv([
      'MN-1,,Yuri Santinelli,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga'
    ]));
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const linha = porId(resposta)['MN-1'];
    expect(linha.matchStatus, JSON.stringify(linha)).toBe('MATCHED');
    expect(linha.athleteId).toBe(atleta.id);
  });

  it('a matrícula sozinha NÃO identifica: o mesmo número em outra federação é outra pessoa', async () => {
    const daMT = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(daMT.id, fedMT.id, '88281');

    // Mesma matrícula, federação diferente: não é o mesmo atleta.
    const resposta = await importar(csv([
      'MN-2,,Outra Pessoa,NPC-SP,88281,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-2'];
    expect(linha.matchStatus, JSON.stringify(linha)).not.toBe('MATCHED');
    expect(linha.athleteId).not.toBe(daMT.id);
  });

  it('a filiação sozinha também não identifica — sem matrícula, cai para a chave seguinte', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Kananda Dos Santos Azevedo', cpf: CPF_KANANDA });
    await matricular(atleta.id, fedMT.id, '147986');

    // Sem matrícula no arquivo, mas COM CPF: reconhece pela chave 2.
    const resposta = await importar(csv([
      `MN-3,${CPF_KANANDA},Kananda Dos Santos Azevedo,NPC-MT,,BIKINI,OPEN,2,Ipiranga`
    ]));

    const linha = porId(resposta)['MN-3'];
    expect(linha.matchStatus, JSON.stringify(linha)).toBe('MATCHED');
    expect(linha.athleteId).toBe(atleta.id);
  });

  it('matrícula sem entidade não identifica — cai para a chave seguinte', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Solitaria Silva', cpf: gerarCpf(515515515) });
    await matricular(atleta.id, fedMT.id, '77777');

    // O arquivo traz a matrícula, mas não diz de qual federação. O número
    // existe — e mesmo assim não basta.
    const resposta = await importar(csv([
      'MN-10,,Solitaria Silva,,77777,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-10'];
    expect(linha.matchStatus, 'só o número não reconhece').toBe('MATCH_PENDING');
    expect(linha.athleteId).toBeNull();
    // Cai para a chave 3, que sugere sem vincular.
    expect(linha.suggestedAthleteId).toBe(atleta.id);
  });
});

describe('2) quando as duas chaves discordam, quem decide é gente', () => {
  it('filiação/matrícula aponta um atleta e o CPF aponta outro: CONFLICT', async () => {
    const yuri = await criarAtleta(gerente, organizationId, { fullName: 'Yuri Santinelli', cpf: CPF_YURI });
    await matricular(yuri.id, fedMT.id, '88281');
    const kananda = await criarAtleta(gerente, organizationId, { fullName: 'Kananda Dos Santos Azevedo', cpf: CPF_KANANDA });
    await matricular(kananda.id, fedMT.id, '147986');

    // A matrícula é a do Yuri; o CPF é o da Kananda.
    const resposta = await importar(csv([
      `MN-4,${CPF_KANANDA},Alguém,NPC-MT,88281,BIKINI,OPEN,1,Ipiranga`
    ]));

    const linha = porId(resposta)['MN-4'];
    expect(linha.matchStatus, JSON.stringify(linha)).toBe('CONFLICT');
    expect(linha.reason).toMatch(/divergem|discordam|diferentes/i);
  });
});

describe('3) nome NUNCA reconhece sozinho, e NUNCA cria atleta', () => {
  it('nome igual, sem filiação e sem CPF: vai para revisão, com sugestão', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Carolina Martins', cpf: CPF_SOLTO });

    const resposta = await importar(csv([
      'MN-5,,Carolina Martins,,,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-5'];
    expect(linha.matchStatus, 'semelhança de nome não é reconhecimento').toBe('MATCH_PENDING');
    expect(linha.athleteId, 'a sugestão não vincula sozinha').toBeNull();
    expect(linha.reason).toMatch(/Carolina Martins/);
    expect(linha.suggestedAthleteId, 'mas o humano recebe a pista').toBe(atleta.id);
  });

  it('nome parecido NÃO cria atleta nenhum', async () => {
    const antes = await comoAtor(gerente, tx => tx.athlete.count({ where: { organizationId } }));

    await importar(csv([
      'MN-6,,Fulana Que Nao Existe,,,BIKINI,OPEN,1,Ipiranga'
    ]));

    const depois = await comoAtor(gerente, tx => tx.athlete.count({ where: { organizationId } }));
    expect(depois, 'a pré-visualização não cria ninguém').toBe(antes);
  });

  it('dois atletas com o mesmo nome não produzem sugestão nenhuma', async () => {
    // O caso que a trava existe para cobrir: sugerir uma das duas seria
    // escolher no lugar de quem tem competência.
    await criarAtleta(gerente, organizationId, { fullName: 'Ana Silva', cpf: gerarCpf(811811811) });
    await criarAtleta(gerente, organizationId, { fullName: 'Ana Silva', cpf: gerarCpf(911911911) });

    const resposta = await importar(csv([
      'MN-7,,Ana Silva,,,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-7'];
    expect(linha.matchStatus).toBe('MATCH_PENDING');
    expect(linha.suggestedAthleteId, 'homônimas: nenhuma sugestão').toBeNull();
    expect(linha.reason).toMatch(/mais de um|homônim|ambíg/i);
  });

  it('acento e caixa não separam o mesmo nome', async () => {
    const atleta = await criarAtleta(gerente, organizationId, { fullName: 'Kauê Inácio Campos', cpf: gerarCpf(121121121) });

    const resposta = await importar(csv([
      'MN-8,,KAUE INACIO CAMPOS,,,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-8'];
    expect(linha.suggestedAthleteId, 'normalização de acento e caixa').toBe(atleta.id);
    expect(linha.matchStatus, 'e ainda assim não reconhece sozinho').toBe('MATCH_PENDING');
  });
});

describe('4) linha sem chave nenhuma continua indo para revisão', () => {
  it('sem CPF, sem filiação e sem nome conhecido: MATCH_PENDING', async () => {
    const resposta = await importar(csv([
      'MN-9,,Desconhecida Total,,,BIKINI,OPEN,1,Ipiranga'
    ]));

    const linha = porId(resposta)['MN-9'];
    expect(linha.matchStatus).toBe('MATCH_PENDING');
    expect(linha.athleteId).toBeNull();
    expect(linha.suggestedAthleteId).toBeNull();
  });
});

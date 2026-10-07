import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, gerarCpf, comoAtor
} from './helpers.mjs';

// ============================================================================
// A FOTO DO ATLETA NA SUPERFÍCIE PÚBLICA.
//
// A DECISÃO QUE ESTA SUÍTE REGISTRA
//
// `GET /media/athletes/:id/photo` exigia sessão, e o comentário do roteador
// dizia por quê: abrir retrato de atleta ao anônimo é decisão de produto, não
// de implementação. A decisão foi tomada — a foto do atleta APROVADO passa a
// ser pública, para aparecer no ranking e na vitrine, superfícies que já
// publicam nome, equipe, cidade e colocação da mesma pessoa.
//
// O QUE CONTINUA FECHADO, e é o que esta suíte protege:
//
//   * a foto do PEDIDO de cadastro — documento de conferência de identidade —
//     continua exigindo sessão;
//   * `photoKey` NUNCA sai no corpo de resposta nenhuma: ela é caminho interno
//     do armazenamento. O que sai é o booleano `hasPhoto`;
//   * a rota recebe o ID DO ATLETA e nada mais; o caminho do objeto é
//     resolvido no servidor, então não há como pedir arquivo arbitrário.
//
// E a identidade da foto é o CADASTRO, nunca o nome: dois atletas homônimos
// têm fotos independentes, e trocar o nome de um não troca a foto do outro.
// ============================================================================

let admin;
let operador;
let organizationId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: unico('MCI') })).id;
  operador = await criarUsuario({ name: 'Operador' });
  await vincular(organizationId, operador, 'REGISTRATION_OPERATOR');
});

async function criarAtleta(nome, semente) {
  const r = await api().post('/api/v1/athletes').set(operador.auth())
    .send({ organizationId, fullName: nome, sex: 'MALE', cpf: gerarCpf(semente) });
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
  return r.body;
}

/**
 * Grava a chave da foto direto no cadastro.
 *
 * O upload real passa pelo pedido de cadastro, que é outro fluxo inteiro. O
 * que esta suíte mede é a LEITURA: quem enxerga a foto, e o que o corpo
 * devolve. Semear a chave isola exatamente isso.
 */
const comFoto = (ator, athleteId, chave) =>
  comoAtor(ator, tx => tx.athlete.update({ where: { id: athleteId }, data: { photoKey: chave } }));

describe('quem pode ver a foto do atleta', () => {
  it('1. o ANÔNIMO alcança a foto do atleta aprovado', async () => {
    const atleta = await criarAtleta('Com Foto', 810000001);
    await comFoto(operador, atleta.id, 'athletes/com-foto.jpg');

    // 404 de ARQUIVO é a resposta certa aqui: a chave existe no cadastro e o
    // objeto não existe no armazenamento de teste. O que importa é que NÃO
    // seja 401: a porta deixou de pedir sessão.
    const r = await api().get(`/api/v1/media/athletes/${atleta.id}/photo`);
    expect([200, 404], `veio ${r.status}`).toContain(r.status);
    expect(r.status, 'a rota não pode mais exigir sessão').not.toBe(401);
  });

  it('2. atleta SEM foto devolve 404, e não um vazio ambíguo', async () => {
    const atleta = await criarAtleta('Sem Foto', 810000002);
    const r = await api().get(`/api/v1/media/athletes/${atleta.id}/photo`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('PHOTO_NOT_FOUND');
  });

  it('3. id inexistente devolve 404 — e não diz se o atleta existe', async () => {
    const r = await api().get('/api/v1/media/athletes/nao-existe-este-atleta/photo');
    expect(r.status).toBe(404);
  });

  it('4. a foto do PEDIDO de cadastro continua exigindo sessão', async () => {
    const r = await api().get('/api/v1/media/athlete-requests/qualquer-id/photo');
    expect(r.status, 'o documento de conferência não virou público').toBe(401);
  });
});

describe('o que o corpo da resposta entrega', () => {
  it('5. a ficha pública traz hasPhoto e NUNCA a chave do armazenamento', async () => {
    const atleta = await criarAtleta('Lucas Com Foto', 810000003);
    await comFoto(operador, atleta.id, 'athletes/segredo-do-bucket.jpg');

    const ficha = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(ficha.status).toBe(200);
    expect(ficha.body.athlete.hasPhoto, 'o booleano que a tela usa').toBe(true);

    const corpo = JSON.stringify(ficha.body);
    expect(corpo).not.toContain('photoKey');
    expect(corpo, 'o caminho dentro do bucket não pode vazar').not.toContain('segredo-do-bucket');
  });

  it('6. a lista pública de atletas traz hasPhoto por atleta, sem a chave', async () => {
    const com = await criarAtleta('Atleta Com Retrato', 810000004);
    await criarAtleta('Atleta Sem Retrato', 810000005);
    await comFoto(operador, com.id, 'athletes/retrato.jpg');

    const lista = await api().get('/api/v1/public/athletes').query({ limit: 50 });
    expect(lista.status).toBe(200);

    const comRetrato = lista.body.items.find(a => a.id === com.id);
    const semRetrato = lista.body.items.find(a => a.fullName === 'Atleta Sem Retrato');
    expect(comRetrato.hasPhoto).toBe(true);
    expect(semRetrato.hasPhoto).toBe(false);
    expect(JSON.stringify(lista.body)).not.toContain('photoKey');
  });

  it('7. dois atletas distintos têm fotos independentes — a chave é o CADASTRO', async () => {
    // MESMO NOME de propósito: se a foto fosse resolvida por nome, este teste
    // seria o que denunciaria.
    const primeiro = await criarAtleta('Jose Da Silva', 810000006);
    const segundo = await criarAtleta('Jose Da Silva', 810000007);
    await comFoto(operador, primeiro.id, 'athletes/primeiro.jpg');

    const lista = await api().get('/api/v1/public/athletes').query({ limit: 50 });
    const a = lista.body.items.find(x => x.id === primeiro.id);
    const b = lista.body.items.find(x => x.id === segundo.id);

    expect(a.hasPhoto, 'o que tem foto').toBe(true);
    expect(b.hasPhoto, 'o homônimo que não tem').toBe(false);
    expect(a.id).not.toBe(b.id);
  });

  it('8. trocar o NOME não mexe na foto: ela segue o athleteId', async () => {
    const atleta = await criarAtleta('Nome Antigo', 810000008);
    await comFoto(operador, atleta.id, 'athletes/fixa.jpg');

    const renomeado = await api().patch(`/api/v1/athletes/${atleta.id}`).set(operador.auth())
      .send({ fullName: 'Nome Novo Completamente Diferente' });
    expect([200, 204], JSON.stringify(renomeado.body).slice(0, 200)).toContain(renomeado.status);

    const ficha = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(ficha.body.athlete.fullName).toBe('Nome Novo Completamente Diferente');
    expect(ficha.body.athlete.hasPhoto, 'a foto continua com o mesmo cadastro').toBe(true);
  });
});

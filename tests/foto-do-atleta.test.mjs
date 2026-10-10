import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, gerarCpf, criarAtleta, PNG_VALIDO
} from './helpers.mjs';

// ============================================================================
// A FOTO DO ATLETA, DEPOIS DE O CADASTRO EXISTIR.
//
// POR QUE ESTE ARQUIVO EXISTE
//
// A vitrine pública mostrava monograma para praticamente todo atleta, e a
// causa não era uma só. Uma delas era esta: NÃO HAVIA COMO ENVIAR A FOTO. Ela
// entrava apenas pela solicitação de perfil e, depois que o perfil existia,
// não havia rota nenhuma — nem para o dono da conta, nem para a federação.
// Atleta cadastrado pelo operador nascia sem foto e ficava assim para sempre.
//
// O que se mede aqui são as duas mãos que resolvem isso, e os limites de cada
// uma: quem pode, quem não pode, o que o armazenamento aceita, o que a trilha
// de auditoria registra e o que a vitrine passa a mostrar.
// ============================================================================

const png = () => PNG_VALIDO;
const JPEG_FALSO = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

let admin;
let operadorA;
let operadorB;
let orgA;
let orgB;
let atleta;
let donoDaConta;

const enviarMinha = (pessoa, bytes = png(), nome = 'f.png', tipo = 'image/png') =>
  api().post('/api/v1/athletes/me/photo').set(pessoa.auth())
    .attach('photo', bytes, { filename: nome, contentType: tipo });

const enviarPeloOperador = (pessoa, id, bytes = png(), nome = 'f.png', tipo = 'image/png') =>
  api().post(`/api/v1/athletes/${id}/photo`).set(pessoa.auth())
    .attach('photo', bytes, { filename: nome, contentType: tipo });

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });

  operadorA = await criarUsuario({ name: 'Operadora A' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  await vincular(orgA.id, operadorA, 'EVENT_DIRECTOR');

  operadorB = await criarUsuario({ name: 'Operador B' });
  orgB = await criarOrganizacao(admin, { name: 'Federação B' });
  await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');

  atleta = await criarAtleta(operadorA, orgA.id, { fullName: 'Atleta Sem Foto', cpf: gerarCpf(880001) });

  // A conta do próprio atleta, ligada ao cadastro. O vínculo é escrito direto
  // porque o que este arquivo mede é a FOTO, e não o fluxo de vinculação —
  // que tem suíte própria.
  donoDaConta = await criarUsuario({ name: 'Dona Da Conta' });
  await comoAtor(admin, tx => tx.athlete.update({
    where: { id: atleta.id }, data: { userId: donoDaConta.id }
  }));
});

describe('o atleta cadastrado nasce SEM foto — e é esse o problema que isto resolve', () => {
  it('o cadastro feito pelo operador não tem foto, e a vitrine diz isso', async () => {
    const publico = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(publico.status).toBe(200);
    expect(publico.body.athlete.hasPhoto, 'o atleta nasceu com foto e o caso mediria o nada').toBe(false);

    // E a rota da foto responde 404, que é o que a tela traduz em monograma.
    const semFoto = await api().get(`/api/v1/media/athletes/${atleta.id}/photo`);
    expect(semFoto.status).toBe(404);
    expect(semFoto.body.error.code).toBe('PHOTO_NOT_FOUND');
  });
});

describe('a primeira mão: o próprio atleta', () => {
  it('envia a própria foto, e ela passa a aparecer na vitrine pública', async () => {
    const r = await enviarMinha(donoDaConta);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.hasPhoto).toBe(true);

    // A CHAVE NÃO SAI NA RESPOSTA. Ela é caminho interno do armazenamento, e a
    // foto é servida por rota que a resolve no servidor.
    expect(JSON.stringify(r.body)).not.toContain('photoKey');

    const publico = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(publico.body.athlete.hasPhoto).toBe(true);

    // E o VISITANTE, sem sessão nenhuma, recebe a imagem.
    const imagem = await api().get(`/api/v1/media/athletes/${atleta.id}/photo`);
    expect(imagem.status).toBe(200);
    expect(String(imagem.headers['content-type'])).toMatch(/^image\//);
  });

  it('a troca descarta a foto anterior e grava a nova', async () => {
    await enviarMinha(donoDaConta);
    const primeira = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));

    await enviarMinha(donoDaConta);
    const segunda = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));

    expect(segunda.photoKey, 'a chave não mudou, então a troca não gravou nada').not.toBe(primeira.photoKey);
  });

  it('conta SEM cadastro de atleta recebe 404 — e nada é gravado', async () => {
    const qualquerUm = await criarUsuario({ name: 'Sem Cadastro De Atleta' });
    const r = await enviarMinha(qualquerUm);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('ATHLETE_NOT_FOUND');
  });

  it('sem arquivo, a recusa é 422 e diz por quê', async () => {
    const r = await api().post('/api/v1/athletes/me/photo').set(donoDaConta.auth());
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ATHLETE_PHOTO_REQUIRED');
  });

  it('sem sessão, a rota não existe para ninguém', async () => {
    const r = await api().post('/api/v1/athletes/me/photo').attach('photo', png(), 'f.png');
    expect(r.status).toBe(401);
  });
});

describe('a segunda mão: a federação do atleta', () => {
  it('o operador da federação DELE envia a foto', async () => {
    const r = await enviarPeloOperador(operadorA, atleta.id);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.hasPhoto).toBe(true);
  });

  it('o operador de OUTRA federação recebe 404, e não 403', async () => {
    // 404 porque confirmar que o id existe já é informação sobre gente que não
    // é daquela mesa.
    const r = await enviarPeloOperador(operadorB, atleta.id);
    expect(r.status).toBe(404);

    const depois = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));
    expect(depois.photoKey, 'a federação de fora gravou foto no atleta alheio').toBeNull();
  });

  it('uma conta sem permissão de operação não envia foto de ninguém', async () => {
    const estranho = await criarUsuario({ name: 'Terceiro Autenticado' });
    const r = await enviarPeloOperador(estranho, atleta.id);
    expect([403, 404]).toContain(r.status);

    const depois = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));
    expect(depois.photoKey).toBeNull();
  });
});

describe('o que o armazenamento recusa', () => {
  it('MIME mentiroso é recusado, e nada é gravado', async () => {
    const r = await enviarMinha(donoDaConta, JPEG_FALSO, 'f.png', 'image/png');
    expect(r.status).toBe(415);

    const depois = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));
    expect(depois.photoKey, 'o HTML renomeado virou foto do atleta').toBeNull();
  });

  it('SVG não entra — é documento executável, e a política não o aceita', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const r = await enviarMinha(donoDaConta, svg, 'f.svg', 'image/svg+xml');
    expect(r.status).toBe(415);
  });

  it('a chave é construída pelo SERVIDOR, com escopo higienizado e nome sorteado', async () => {
    await enviarMinha(donoDaConta);
    const linha = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atleta.id }, select: { photoKey: true }
    }));

    // Nada que venha do cliente entra no caminho: nem o nome do arquivo, nem
    // o tipo declarado. É isso que impede travessia de caminho e chave
    // adivinhável.
    expect(linha.photoKey).toMatch(/^athlete-photos\/[a-z0-9]+\/[0-9a-f-]{36}\.webp$/);
    expect(linha.photoKey).not.toContain('f.png');
  });
});

describe('a trilha de auditoria distingue as duas mãos', () => {
  it('o envio do próprio atleta grava porOperador: false', async () => {
    await enviarMinha(donoDaConta);

    const linhas = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'ATHLETE_PHOTO_SET', entityId: atleta.id }
    }));
    expect(linhas).toHaveLength(1);
    expect(linhas[0].metadata.porOperador).toBe(false);
    expect(linhas[0].metadata.substituiu).toBe(false);
  });

  it('o envio da federação grava porOperador: true, e a substituição aparece', async () => {
    await enviarMinha(donoDaConta);
    await enviarPeloOperador(operadorA, atleta.id);

    const linhas = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'ATHLETE_PHOTO_SET', entityId: atleta.id },
      orderBy: { createdAt: 'asc' }
    }));
    expect(linhas).toHaveLength(2);
    expect(linhas[1].metadata.porOperador).toBe(true);
    // A SEGUNDA substituiu a primeira, e a trilha diz isso: quem conferir
    // depois precisa saber que a foto no ar não é a que o atleta escolheu.
    expect(linhas[1].metadata.substituiu).toBe(true);
  });

  it('a chave NUNCA entra nos metadados da auditoria', async () => {
    await enviarMinha(donoDaConta);
    const linhas = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'ATHLETE_PHOTO_SET' }
    }));
    expect(JSON.stringify(linhas)).not.toContain('athlete-photos/');
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  unico, comoAtor, autocadastrarTreinador, fotoDeTreinador
} from './helpers.mjs';

// ============================================================================
// FOTO DE PERFIL DO TREINADOR — obrigatória para concluir, e requisito de ranking.
//
// AS DUAS DECISÕES MEDIDAS AQUI:
//
//   1. sem foto o cadastro NÃO conclui, e a recusa não é de tela: é do serviço,
//      no mesmo caminho da rota. Chamar a API direto devolve a mesma frase;
//   2. sem foto válida o treinador NÃO entra no ranking oficial — e NADA é
//      apagado por isso. Ponto, resultado, vínculo e histórico ficam onde estão,
//      e a entrada volta no instante em que a foto chegar.
//
// O QUE ESTA SUÍTE EXISTE PARA IMPEDIR:
//
//   * que a obrigatoriedade viva só no formulário e a API aceite cadastro sem foto;
//   * que arquivo que não é imagem entre por ter nome de imagem;
//   * que a CHAVE do objeto no armazenamento vaze para o navegador;
//   * que trocar a foto apague vínculo, ponto ou histórico;
//   * que a falta de foto seja tratada apagando pontuação, em vez de barrando a
//     entrada no ranking.
// ============================================================================

let central;
let orgNpc;

const criarEntidadeOficial = async organizationId => {
  const r = await api().post('/api/v1/affiliations').set(central.auth())
    .send({ organizationId, name: 'NPC - National Physique Committe', code: 'NPC', kind: 'ENTITY' });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
};

// A MENSAGEM É A COMBINADA, letra por letra. Ela foi decidida pelo produto, e um
// teste que aceitasse "qualquer mensagem de erro" deixaria a frase mudar sozinha.
const FRASE = 'O envio de uma foto de perfil é obrigatório para concluir '
  + 'seu cadastro e aparecer no ranking oficial de treinadores.';

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  delete process.env.MCI_NPC_ORGANIZATION_ID;
  central = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  orgNpc = (await criarOrganizacao(central, { name: unico('NPC Brasil') })).id;
  await criarEntidadeOficial(orgNpc);
});

describe('sem foto o cadastro não conclui', () => {
  it('a API recusa com 422 e A FRASE — e nenhum cadastro nasce', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });

    // Chamada DIRETA, sem anexo: é a tentativa de contornar a validação.
    const semFoto = await api().post('/api/v1/coaches/self-register').set(conta.auth())
      .field('name', 'Marta Treinadora');
    expect(semFoto.status, JSON.stringify(semFoto.body)).toBe(422);
    expect(semFoto.body.error.code).toBe('COACH_PHOTO_REQUIRED');
    expect(semFoto.body.error.message).toBe(FRASE);

    const quantos = await comoAtor(central, tx => tx.coach.count());
    expect(quantos, 'recusar antes de escrever é o que garante isto').toBe(0);
  });

  it('corpo JSON sem arquivo também é recusado — não há caminho alternativo', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });

    const comJson = await api().post('/api/v1/coaches/self-register').set(conta.auth())
      .send({ name: 'Marta Treinadora', registration: 'CREF-1' });
    expect(comJson.status).toBe(422);
    expect(comJson.body.error.code).toBe('COACH_PHOTO_REQUIRED');
    expect(await comoAtor(central, tx => tx.coach.count())).toBe(0);
  });

  it('arquivo que NÃO é imagem é recusado, mesmo com nome e tipo de imagem', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });

    // Bytes de um script, anunciados como PNG. O decodificador é que decide.
    const disfarcado = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');
    const tentativa = await api().post('/api/v1/coaches/self-register').set(conta.auth())
      .field('name', 'Marta Treinadora')
      .attach('photo', disfarcado, { filename: 'foto.png', contentType: 'image/png' });

    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(415);
    expect(await comoAtor(central, tx => tx.coach.count())).toBe(0);
  });

  it('tipo não aceito é recusado pela lista, antes de decodificar', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });

    const tentativa = await api().post('/api/v1/coaches/self-register').set(conta.auth())
      .field('name', 'Marta Treinadora')
      .attach('photo', Buffer.from('%PDF-1.4 nada', 'utf8'), { filename: 'foto.pdf', contentType: 'application/pdf' });

    expect(tentativa.status).toBeGreaterThanOrEqual(400);
    expect(await comoAtor(central, tx => tx.coach.count())).toBe(0);
  });
});

describe('com foto o cadastro conclui e a foto é servida', () => {
  it('nasce com foto, e a resposta diz que tem — sem entregar a chave', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });
    expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(201);

    expect(cadastro.body.hasPhoto, 'a tela precisa saber SE existe foto').toBe(true);
    expect(cadastro.body.photoKey, 'a chave do objeto não vai para o navegador').toBeUndefined();
    expect(JSON.stringify(cadastro.body)).not.toContain('coach-photos/');

    // E a chave existe no banco, apontando para o objeto gravado.
    const linha = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: cadastro.body.id }, select: { photoKey: true }
    }));
    expect(linha.photoKey).toMatch(/^coach-photos\//);
  });

  it('a rota de mídia entrega a imagem, e o id é tudo o que ela recebe', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    const foto = await api().get(`/api/v1/media/coaches/${cadastro.body.id}/photo`);
    expect(foto.status, 'o ranking é superfície pública; a foto acompanha').toBe(200);
    expect(String(foto.headers['content-type'])).toMatch(/^image\//);

    // Treinador que não existe não vira oráculo nem erro de servidor.
    const inexistente = await api().get('/api/v1/media/coaches/nao-existe/photo');
    expect(inexistente.status).toBe(404);
  });

  it('a foto guardada é RECODIFICADA, não o arquivo que chegou', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    const linha = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: cadastro.body.id }, select: { photoKey: true }
    }));
    // Entrou PNG, ficou WebP: é a recodificação que faz arquivo disfarçado não
    // sobreviver, e ela é a mesma do avatar social.
    expect(linha.photoKey).toMatch(/\.webp$/);
  });
});

describe('trocar a foto depois não custa nada do que já existe', () => {
  it('troca a imagem e preserva cadastro, autorização, equipe e vínculo', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });
    const coachId = cadastro.body.id;

    const equipe = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Marta') });
    expect(equipe.status).toBe(201);

    const antes = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: coachId },
      select: {
        photoKey: true, status: true, createdAt: true,
        organizations: { select: { id: true, status: true } },
        teams: { select: { id: true, name: true } }
      }
    }));

    const troca = await api().post('/api/v1/coaches/me/photo').set(conta.auth())
      .attach('photo', fotoDeTreinador(), { filename: 'nova.png', contentType: 'image/png' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body.hasPhoto).toBe(true);

    const depois = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: coachId },
      select: {
        photoKey: true, status: true, createdAt: true,
        organizations: { select: { id: true, status: true } },
        teams: { select: { id: true, name: true } }
      }
    }));

    expect(depois.status).toBe(antes.status);
    expect(depois.createdAt).toEqual(antes.createdAt);
    expect(depois.organizations, 'autorização intacta').toEqual(antes.organizations);
    expect(depois.teams, 'equipe intacta').toEqual(antes.teams);
    expect(depois.photoKey, 'só a foto mudou').not.toBe(antes.photoKey);
  });

  it('a troca vai para a trilha', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    await api().post('/api/v1/coaches/me/photo').set(conta.auth())
      .attach('photo', fotoDeTreinador(), { filename: 'nova.png', contentType: 'image/png' });

    const linhas = await comoAtor(central, tx => tx.auditLog.findMany({
      where: { action: 'COACH_PHOTO_SET' }, select: { metadata: true }
    }));
    expect(linhas.length).toBeGreaterThanOrEqual(1);
    expect(linhas.some(l => l.metadata?.substituiu === true)).toBe(true);
  });

  it('trocar sem arquivo devolve A FRASE, e não troca nada', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    const antes = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: cadastro.body.id }, select: { photoKey: true }
    }));

    const semArquivo = await api().post('/api/v1/coaches/me/photo').set(conta.auth());
    expect(semArquivo.status).toBe(422);
    expect(semArquivo.body.error.message).toBe(FRASE);

    const depois = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: cadastro.body.id }, select: { photoKey: true }
    }));
    expect(depois.photoKey).toBe(antes.photoKey);
  });

  it('quem não tem cadastro de treinador não troca foto de ninguém', async () => {
    const atleta = await criarUsuario({ name: 'Atleta Qualquer' });
    const tentativa = await api().post('/api/v1/coaches/me/photo').set(atleta.auth())
      .attach('photo', fotoDeTreinador(), { filename: 'foto.png', contentType: 'image/png' });
    expect([403, 404]).toContain(tentativa.status);
  });
});

describe('sem foto não há entrada no ranking oficial — e nada é apagado', () => {
  // O ESTADO É ESCRITO, e dizer isso importa: treinador sem foto é o CADASTRO
  // ANTERIOR à decisão, e o produto não o produz mais. A única forma honesta de
  // montá-lo é limpar a coluna, declarando que é isso que se está fazendo.
  const apagarAFoto = coachId => comoAtor(central, tx => tx.coach.update({
    where: { id: coachId }, data: { photoKey: null }
  }));

  const criarTemporada = async () => {
    const r = await api().post('/api/v1/seasons').set(central.auth())
      .send({ organizationId: orgNpc, name: unico('Temporada'), year: 2033 });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body.id;
  };

  it('com foto o treinador está APTO; sem foto, NÃO — e o impedimento diz por quê', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });
    const coachId = cadastro.body.id;

    expect((await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Marta') })).status).toBe(201);

    const seasonId = await criarTemporada();

    const comFoto = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(conta.auth()).query({ seasonId });
    expect(comFoto.status, JSON.stringify(comFoto.body)).toBe(200);
    expect(comFoto.body.apto).toBe(true);
    expect(comFoto.body.impedimentos).toEqual([]);
    expect(comFoto.body.coach.hasPhoto).toBe(true);

    await apagarAFoto(coachId);

    const semFoto = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(conta.auth()).query({ seasonId });
    expect(semFoto.status).toBe(200);
    expect(semFoto.body.apto, 'sem foto não entra no ranking oficial').toBe(false);
    expect(semFoto.body.coach.hasPhoto).toBe(false);
    expect(semFoto.body.impedimentos.map(i => i.codigo)).toContain('COACH_PHOTO_REQUIRED');
  });

  it('o impedimento NÃO apaga equipe, vínculo nem cadastro', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });
    const coachId = cadastro.body.id;

    const equipe = await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Marta') });
    expect(equipe.status).toBe(201);

    await apagarAFoto(coachId);

    const depois = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: coachId },
      select: {
        status: true,
        teams: { select: { id: true } },
        organizations: { select: { status: true } }
      }
    }));
    expect(depois.status, 'o cadastro continua aprovado').toBe('APPROVED');
    expect(depois.teams, 'a equipe continua sendo dele').toHaveLength(1);
    expect(depois.organizations.map(o => o.status)).toEqual(['APPROVED']);

    // E a área dele continua abrindo: falta de foto barra o RANKING, não o acesso.
    expect((await api().get('/api/v1/coaches/me').set(conta.auth())).status).toBe(200);
    expect((await api().get('/api/v1/coaches/me/teams').set(conta.auth())).status).toBe(200);
  });

  it('a projeção também diz que não está apto, e continua devolvendo as equipes', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    expect((await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Marta') })).status).toBe(201);

    const seasonId = await criarTemporada();
    await apagarAFoto(cadastro.body.id);

    const projecao = await api().get(`/api/v1/coaches/${cadastro.body.id}/ranking/projection`)
      .set(conta.auth()).query({ seasonId });
    expect(projecao.status, JSON.stringify(projecao.body)).toBe(200);
    expect(projecao.body.apto).toBe(false);
    expect(projecao.body.impedimentos.map(i => i.codigo)).toContain('COACH_PHOTO_REQUIRED');
    // E o bloqueio de §8.3 continua no lugar: nenhum total, nenhuma posição.
    expect(projecao.body.totalDoTreinador).toBeNull();
    expect(projecao.body.posicao).toBeNull();
    expect(projecao.body.homologado).toBe(false);
  });

  it('enviar a foto devolve a entrada no ranking, sem nada mais precisar acontecer', async () => {
    const conta = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
    const cadastro = await autocadastrarTreinador(conta, { name: 'Marta Treinadora' });

    expect((await api().post('/api/v1/coaches/me/teams').set(conta.auth())
      .send({ organizationId: orgNpc, name: unico('Equipe Marta') })).status).toBe(201);

    const seasonId = await criarTemporada();
    await apagarAFoto(cadastro.body.id);

    const troca = await api().post('/api/v1/coaches/me/photo').set(conta.auth())
      .attach('photo', fotoDeTreinador(), { filename: 'nova.png', contentType: 'image/png' });
    expect(troca.status).toBe(200);

    const agora = await api().get(`/api/v1/coaches/${cadastro.body.id}/ranking/eligibility`)
      .set(conta.auth()).query({ seasonId });
    expect(agora.body.apto, 'regularizar é só enviar a foto').toBe(true);
    expect(agora.body.impedimentos).toEqual([]);
  });

  it('a classificação oficial continua recusando por §8.3, e não por foto', async () => {
    // O bloqueio de homologação é anterior e independente: a fórmula do ranking
    // de treinadores não foi homologada, e este teste existe para que o requisito
    // da foto não seja confundido com ela.
    const visitante = await api().get('/api/v1/ranking/coaches');
    expect(visitante.status).toBe(409);
    expect(visitante.body.error.code).toBe('COACH_RANKING_NOT_HOMOLOGATED');
  });
});

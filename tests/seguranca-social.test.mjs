import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, comoAtor } from './helpers.mjs';

// ============================================================================
// Caminhos negativos de Social e Messenger que a suíte ainda não cobria.
//
// Vieram de uma varredura de autorização feita disparando os ataques de
// verdade, não lendo o código. Os módulos resistiram a todos — o que faltava
// não era correção, era a TRAVA: sem teste, a garantia vale por construção e
// desaparece na primeira refatoração distraída.
//
// O que já estava coberto em e2e-social-messenger (ler, escrever, reagir,
// apagar, compartilhar, bloquear) não se repete aqui.
// ============================================================================

// PNG mínimo válido: a mídia precisa ser REAL, senão a mensagem não tem
// storageKey e a rota responde 404 antes de chegar à checagem de participação
// — o teste passaria sem provar nada.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let alice, bob, carol;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  alice = await criarUsuario({ name: 'Alice Autora' });
  bob = await criarUsuario({ name: 'Bob Participante' });
  carol = await criarUsuario({ name: 'Carol Intrusa' });

  // O perfil social nasce no primeiro toque; é o que dá identidade ao ator.
  for (const usuario of [alice, bob, carol]) {
    await api().get('/api/v1/social/feed').set(usuario.auth());
  }
});

const perfilDe = async usuario =>
  prisma.socialProfile.findFirst({ where: { user: { email: usuario.email } } });

// Conversa entre Alice e Bob, com uma mensagem dentro. Carol fica de fora.
async function conversaComMensagem() {
  const perfilBob = await perfilDe(bob);
  const conversa = await api().post('/api/v1/messenger/conversations').set(alice.auth())
    .send({ participantIds: [perfilBob.id] });
  expect(conversa.status, JSON.stringify(conversa.body)).toBe(201);

  const mensagem = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`)
    .set(alice.auth()).send({ body: 'mensagem privada' });
  expect(mensagem.status).toBe(201);

  // Uma segunda mensagem, esta com ANEXO — é a que exercita a rota de mídia.
  const comMidia = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/media`)
    .set(alice.auth())
    .attach('file', PNG, { filename: 'privada.png', contentType: 'image/png' });
  expect(comMidia.status, JSON.stringify(comMidia.body)).toBe(201);

  return {
    conversationId: conversa.body.id,
    messageId: mensagem.body.id,
    mediaMessageId: comMidia.body.id,
    perfilBob
  };
}

describe('mídia de mensagem privada', () => {
  it('quem não participa da conversa não baixa a mídia pelo id', async () => {
    // O caminho mais perigoso do módulo: um arquivo servido por id, fora da
    // listagem. Se a checagem de participação faltasse aqui, bastaria o id
    // para ler anexo de conversa alheia — sem nunca abrir a conversa.
    const { mediaMessageId } = await conversaComMensagem();

    const tentativa = await api().get(`/api/v1/messenger/messages/${mediaMessageId}/media`).set(carol.auth());
    expect([403, 404]).toContain(tentativa.status);

    // E quem participa continua alcançando — a trava não pode fechar para
    // quem tem direito.
    const doParticipante = await api().get(`/api/v1/messenger/messages/${mediaMessageId}/media`).set(bob.auth());
    expect(doParticipante.status).toBe(200);
  });

  it('a mídia está protegida por DUAS barreiras independentes', async () => {
    // Descoberto ao conferir se o teste acima tinha valor: removida a checagem
    // de participação do service, Carol CONTINUAVA recebendo 404. Não era um
    // teste fraco — é o RLS segurando, como a fase 10.2 desenhou.
    //
    // Vale registrar as duas barreiras separadamente, porque cada uma pode
    // desaparecer sozinha numa refatoração, e a que sobrar esconderia a perda
    // da outra até o dia em que as duas fossem embora.
    const { mediaMessageId, conversationId } = await conversaComMensagem();

    // Barreira 2, direto no banco e como Carol: a linha nem é visível.
    const comoCarol = await comoAtor(carol, tx => tx.message.findUnique({ where: { id: mediaMessageId } }));
    expect(comoCarol, 'o RLS esconde a mensagem de quem não participa').toBeNull();

    // E o participante enxerga — a política não fecha para quem tem direito.
    const comoBob = await comoAtor(bob, tx => tx.message.findUnique({ where: { id: mediaMessageId } }));
    expect(comoBob?.conversationId).toBe(conversationId);
  });

  it('nem sem sessão nenhuma', async () => {
    const { mediaMessageId } = await conversaComMensagem();

    const anonima = await api().get(`/api/v1/messenger/messages/${mediaMessageId}/media`);

    expect([401, 403]).toContain(anonima.status);
  });
});

describe('operações de conversa por quem não participa', () => {
  it('não marca como lida, não adiciona membro e não sai de conversa alheia', async () => {
    const { conversationId, perfilBob } = await conversaComMensagem();

    const marcar = await api().post(`/api/v1/messenger/conversations/${conversationId}/read`).set(carol.auth());
    const adicionar = await api().post(`/api/v1/messenger/conversations/${conversationId}/members`)
      .set(carol.auth()).send({ participantIds: [perfilBob.id] });
    const sair = await api().post(`/api/v1/messenger/conversations/${conversationId}/leave`).set(carol.auth());

    for (const [rotulo, resposta] of [['marcar lida', marcar], ['adicionar membro', adicionar], ['sair', sair]]) {
      expect([403, 404], `${rotulo} respondeu ${resposta.status}`).toContain(resposta.status);
    }
  });

  it('a conversa responde 404 para quem não participa, e não 403', async () => {
    // A diferença importa: 403 confirmaria que a conversa existe, e o id
    // sozinho já contaria quem fala com quem.
    const { conversationId } = await conversaComMensagem();

    const resposta = await api().get(`/api/v1/messenger/conversations/${conversationId}`).set(carol.auth());

    expect(resposta.status).toBe(404);
  });

  it('sem sessão, nem chega a existir conversa a consultar', async () => {
    const { conversationId } = await conversaComMensagem();

    expect((await api().get(`/api/v1/messenger/conversations/${conversationId}`)).status).toBe(401);
  });
});

describe('publicação restrita: as portas laterais', () => {
  const publicacaoRestrita = async () => {
    const post = await api().post('/api/v1/social/posts').set(alice.auth())
      .send({ content: 'só para quem segue', visibility: 'FOLLOWERS' });
    expect(post.status).toBe(201);
    return post.body.id;
  };

  it('terceiro não salva publicação que não pode ver', async () => {
    // Salvar parece inofensivo, mas confirma a existência do conteúdo e o
    // deixa na lista de salvos de quem não deveria alcançá-lo.
    const postId = await publicacaoRestrita();

    const salvar = await api().post(`/api/v1/social/posts/${postId}/save`).set(bob.auth());

    expect([403, 404]).toContain(salvar.status);
    const salvos = await api().get('/api/v1/social/saved').set(bob.auth());
    expect(JSON.stringify(salvos.body)).not.toContain(postId);
  });

  it('terceiro não lê os comentários de publicação restrita', async () => {
    // Os comentários vazariam o teor da publicação mesmo com ela escondida.
    const postId = await publicacaoRestrita();
    await api().post(`/api/v1/social/posts/${postId}/comments`).set(alice.auth()).send({ content: 'meu comentário' });

    const tentativa = await api().get(`/api/v1/social/posts/${postId}/comments`).set(bob.auth());

    expect([403, 404]).toContain(tentativa.status);
  });

  it('anônimo também não alcança a publicação restrita', async () => {
    const postId = await publicacaoRestrita();

    expect([401, 403, 404]).toContain((await api().get(`/api/v1/social/posts/${postId}`)).status);
  });
});

describe('moderação exige papel', () => {
  it('usuário comum não lista as denúncias da plataforma', async () => {
    // A fila de denúncias descreve conflitos entre pessoas: quem denunciou
    // quem, e por quê.
    const resposta = await api().get('/api/v1/social/reports').set(bob.auth());

    expect(resposta.status).toBe(403);
  });
});

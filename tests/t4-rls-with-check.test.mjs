import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, comoAtor, prisma
} from './helpers.mjs';

// ==========================================================================
// S6 — `WITH CHECK = true` NAS QUATRO POLÍTICAS.
//
// `USING` decide quais linhas o ator ALCANÇA. `WITH CHECK` decide como a linha
// NOVA pode ficar. Com `WITH CHECK (true)`, quem alcança uma linha pode
// reescrevê-la em qualquer coisa — inclusive numa linha que jamais poderia ter
// alcançado. E em política `FOR ALL` o INSERT é governado SÓ pelo `WITH CHECK`:
// ali, `true` significa inserção sem restrição alguma.
//
// AS QUATRO NÃO TINHAM O MESMO RISCO, e é por isso que cada uma teve análise
// própria. Espelhar o `USING` no `WITH CHECK` — a correção óbvia — só serve em
// UMA delas. Nas outras três quebraria fluxo legítimo ou não fecharia o ataque:
//
//   `Comment`            espelhar SERVE.
//   `Conversation`       espelhar QUEBRA sair da conversa.
//   `ConversationMember` espelhar NÃO FECHA entrar em conversa alheia.
//   `Notification`       espelhar DESLIGA a notificação da plataforma.
//
// O TESTE MEDE O BANCO, e não a API.
//
// Cada caso escreve DIRETO na tabela, com o ator definido pelo mesmo helper que
// a aplicação usa. Um 403 da rota não prova que a política recusou: prova que o
// serviço recusou primeiro. Aqui a responsabilidade é da RLS, então a recusa
// tem de vir do PostgreSQL — código 42501.
//
// E cada recusa vem com CONTROLE POSITIVO ao lado: sem ele, "o banco recusou"
// poderia ser "o banco recusa tudo", que não é correção, é quebra.
// ==========================================================================

// `new row violates row-level security policy` é 42501. O Prisma embrulha, e o
// código aparece na mensagem — conferir a mensagem inteira evita confundir uma
// recusa de política com qualquer outro erro.
const recusadoPelaPolitica = erro => {
  const texto = `${erro?.message ?? erro}`;
  return texto.includes('42501') || /row-level security/i.test(texto);
};

async function deveRecusar(rotulo, executar) {
  let erro = null;
  try { await executar(); } catch (e) { erro = e; }
  expect(erro, `${rotulo}: a operação PASSOU, e a política devia ter recusado`).not.toBeNull();
  expect(recusadoPelaPolitica(erro), `${rotulo}: recusou por outro motivo — ${String(erro?.message).slice(0, 220)}`).toBe(true);
}

let ana, bruno, carla;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
  bruno = await criarUsuario({ name: 'Bruno' });
  carla = await criarUsuario({ name: 'Carla' });
  for (const pessoa of [ana, bruno, carla]) {
    expect(pessoa.profileId, 'a conta nasceu sem perfil social').toBeTruthy();
  }
});

// ==========================================================================
// 1. `Comment` · UPDATE — espelhar o USING serve
// ==========================================================================
describe('Comment: o autor não reescreve a autoria nem muda a publicação', () => {
  async function publicacaoComComentario() {
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Publicação da Ana para medir a política.', visibility: 'PUBLIC' });
    expect(post.status, JSON.stringify(post.body)).toBe(201);

    const comentario = await api().post(`/api/v1/social/posts/${post.body.id}/comments`)
      .set(bruno.auth()).send({ content: 'Comentário do Bruno.' });
    expect(comentario.status, JSON.stringify(comentario.body)).toBe(201);

    const outroPost = await api().post('/api/v1/social/posts').set(carla.auth())
      .send({ content: 'Publicação da Carla, que o Bruno não controla.', visibility: 'PUBLIC' });
    expect(outroPost.status).toBe(201);

    return { postId: post.body.id, commentId: comentario.body.id, postDaCarla: outroPost.body.id };
  }

  it('o autor ATUALIZA o próprio comentário — controle positivo', async () => {
    const { commentId } = await publicacaoComComentario();
    const r = await comoAtor(bruno, tx => tx.comment.updateMany({
      where: { id: commentId }, data: { content: 'Texto corrigido pelo autor.' }
    }));
    expect(r.count, 'o autor não conseguiu editar o próprio comentário').toBe(1);
  }, 60_000);

  it('o autor NÃO reatribui o comentário a outro perfil', async () => {
    const { commentId } = await publicacaoComComentario();
    await deveRecusar('Comment.authorId para terceiro', () => comoAtor(bruno, tx => tx.comment.updateMany({
      where: { id: commentId }, data: { authorId: carla.profileId }
    })));

    const depois = await comoAtor(ana, tx => tx.comment.findUnique({
      where: { id: commentId }, select: { authorId: true }
    }));
    expect(depois.authorId, 'a autoria mudou apesar da recusa').toBe(bruno.profileId);
  }, 60_000);

  // ESTE TESTE AFIRMAVA O CONTRÁRIO, E A MEDIÇÃO O CORRIGIU.
  //
  // Eu esperava que mover o comentário para outra publicação fosse recusado.
  // Medido: PASSA — e está certo que passe. O `WITH CHECK` novo tem a
  // alternativa `"authorId" = mci_current_profile_id()`, e Bruno continua sendo
  // o autor depois da gravação, então a linha nova satisfaz a política.
  //
  // E não é escalada: `comentario_criacao` exige apenas `authorId = ator`, sem
  // dizer nada sobre a publicação. Ou seja, Bruno JÁ PODIA criar um comentário
  // em qualquer publicação no nível do banco — mover não lhe dá poder novo. A
  // camada que decide em que publicação se pode comentar é o serviço.
  //
  // Fica REGISTRADO como lacuna remanescente, fora do escopo do S6: nem a
  // política de INSERT nem a de UPDATE restringem `postId`. Fechá-la exige um
  // predicado de visibilidade de `Post` nas duas, e é decisão própria — não se
  // resolve trocando `WITH CHECK true`.
  it('mover o próprio comentário de publicação é PERMITIDO, e não é escalada', async () => {
    const { commentId, postDaCarla } = await publicacaoComComentario();

    const r = await comoAtor(bruno, tx => tx.comment.updateMany({
      where: { id: commentId }, data: { postId: postDaCarla }
    }));
    expect(r.count, 'o autor não conseguiu mover o próprio comentário').toBe(1);

    // A prova de que não é escalada: criar direto na publicação alheia também
    // passa, então mover não alcança nada de novo.
    const criado = await comoAtor(bruno, tx => tx.comment.create({
      data: { postId: postDaCarla, authorId: bruno.profileId, content: 'Comentário criado direto.' }
    }));
    expect(criado.id, 'criar em publicação alheia foi recusado — a comparação muda').toBeTruthy();

    // O que a política SIM impede é fazê-lo em nome de outra pessoa.
    await deveRecusar('Comment em nome de terceiro', () => comoAtor(bruno, tx => tx.comment.create({
      data: { postId: postDaCarla, authorId: carla.profileId, content: 'Forjado.' }
    })));
  }, 60_000);

  it('o autor da PUBLICAÇÃO continua podendo apagar comentário alheio — o T2 não regrediu', async () => {
    const { commentId } = await publicacaoComComentario();
    // Ana é autora da publicação; Bruno, do comentário. O F1 do T2 deu a Ana
    // esse direito, e o `WITH CHECK` novo tem de preservá-lo.
    const r = await api().delete(`/api/v1/social/comments/${commentId}`).set(ana.auth());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 60_000);
});

// ==========================================================================
// 2. `Conversation` · UPDATE — espelhar o USING quebraria sair da conversa
// ==========================================================================
describe('Conversation: sair continua possível, entregar a conversa não', () => {
  async function conversaEntreTres() {
    const r = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'GROUP', participantIds: [bruno.profileId, carla.profileId], title: 'Grupo QA' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id ?? r.body.conversation?.id;
  }

  it('o participante SAI da conversa — controle positivo, pelo caminho real', async () => {
    const id = await conversaEntreTres();
    const r = await api().post(`/api/v1/messenger/conversations/${id}/leave`).set(bruno.auth()).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await comoAtor(ana, tx => tx.conversation.findUnique({
      where: { id }, select: { participantIds: true, formerParticipantIds: true }
    }));
    expect(depois.participantIds, 'quem saiu continua participante').not.toContain(bruno.profileId);
    expect(depois.formerParticipantIds, 'quem saiu não foi registrado como ex-participante')
      .toContain(bruno.profileId);
  }, 60_000);

  it('o participante NÃO entrega a conversa e desaparece dela', async () => {
    const id = await conversaEntreTres();
    // Reescrever `participantIds` sem o ator E sem registrá-lo como
    // ex-participante: é o ataque que o `WITH CHECK (true)` permitia.
    await deveRecusar('Conversation entregue sem rastro do ator', () => comoAtor(bruno, tx => tx.conversation.updateMany({
      where: { id }, data: { participantIds: [carla.profileId] }
    })));

    const depois = await comoAtor(ana, tx => tx.conversation.findUnique({
      where: { id }, select: { participantIds: true }
    }));
    expect(depois.participantIds, 'a conversa foi reescrita apesar da recusa')
      .toContain(bruno.profileId);
  }, 60_000);

  it('o participante ATUALIZA o título — controle positivo de escrita comum', async () => {
    const id = await conversaEntreTres();
    const r = await comoAtor(bruno, tx => tx.conversation.updateMany({
      where: { id }, data: { title: 'Grupo QA renomeado' }
    }));
    expect(r.count, 'participante não conseguiu renomear a conversa').toBe(1);
  }, 60_000);
});

// ==========================================================================
// 3. `ConversationMember` · ALL — espelhar o USING NÃO fecharia o ataque
// ==========================================================================
describe('ConversationMember: não se entra em conversa alheia', () => {
  it('a criação da conversa grava os membros — controle positivo', async () => {
    const r = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ participantIds: [bruno.profileId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const id = r.body.id ?? r.body.conversation?.id;
    const membros = await comoAtor(ana, tx => tx.conversationMember.findMany({
      where: { conversationId: id }, select: { profileId: true }
    }));
    expect(membros.map(m => m.profileId).sort()).toEqual([ana.profileId, bruno.profileId].sort());
  }, 60_000);

  it('CARLA não se insere na conversa de Ana e Bruno', async () => {
    const criada = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ participantIds: [bruno.profileId] });
    const id = criada.body.id ?? criada.body.conversation?.id;

    // O ATAQUE que `WITH CHECK (true)` permitia, e que o espelho do `USING`
    // continuaria permitindo: a primeira alternativa do `USING` é
    // `"profileId" = mci_current_profile_id()`, satisfeita por quem insere a si
    // mesmo. Por isso o `WITH CHECK` exige a conversa, não o perfil.
    await deveRecusar('ConversationMember auto-inserido em conversa alheia',
      () => comoAtor(carla, tx => tx.conversationMember.create({
        data: { conversationId: id, profileId: carla.profileId }
      })));

    const membros = await comoAtor(ana, tx => tx.conversationMember.findMany({
      where: { conversationId: id }, select: { profileId: true }
    }));
    expect(membros.map(m => m.profileId), 'Carla entrou na conversa').not.toContain(carla.profileId);
  }, 60_000);

  it('quem PARTICIPA acrescenta membro — controle positivo, pelo caminho real', async () => {
    // GRUPO: conversa individual não recebe participante (`NOT_A_GROUP`), e
    // essa é regra de produto, anterior a esta fase.
    const criada = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'GROUP', participantIds: [bruno.profileId] });
    const id = criada.body.id ?? criada.body.conversation?.id;

    const r = await api().post(`/api/v1/messenger/conversations/${id}/members`)
      .set(ana.auth()).send({ participantIds: [carla.profileId] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const membros = await comoAtor(ana, tx => tx.conversationMember.findMany({
      where: { conversationId: id }, select: { profileId: true }
    }));
    expect(membros.map(m => m.profileId)).toContain(carla.profileId);
  }, 60_000);
});

// ==========================================================================
// 4. `Notification` · a escrita ampla é DESENHO, e o UPDATE deixou de ser
// ==========================================================================
describe('Notification: ninguém move notificação de dono', () => {
  async function notificacaoDe(usuario) {
    // Pelo caminho real: Ana publica, Bruno comenta, Ana é notificada.
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Publicação que gera notificação.', visibility: 'PUBLIC' });
    await api().post(`/api/v1/social/posts/${post.body.id}/comments`)
      .set(bruno.auth()).send({ content: 'Comentário que notifica.' });

    const minhas = await comoAtor(usuario, tx => tx.notification.findMany({ select: { id: true, userId: true } }));
    return minhas;
  }

  it('a notificação chega ao dono, escrita por OUTRA pessoa — a entrega ampla é desenho', async () => {
    const daAna = await notificacaoDe(ana);
    expect(daAna.length, 'a notificação não foi entregue').toBeGreaterThan(0);
    expect(daAna.every(n => n.userId === ana.id)).toBe(true);

    // Bruno é quem disparou, e a linha é da Ana. Se a política de INSERT
    // exigisse `userId = ator`, este fluxo teria morrido — é a justificativa da
    // política `notificacao_entrega`, declarada na migration.
    const doBruno = await comoAtor(bruno, tx => tx.notification.findMany({ select: { id: true } }));
    expect(doBruno.map(n => n.id), 'Bruno enxerga notificação da Ana')
      .not.toEqual(expect.arrayContaining(daAna.map(n => n.id)));
  }, 60_000);

  it('o dono marca como lida — controle positivo', async () => {
    const [notificacao] = await notificacaoDe(ana);
    const r = await comoAtor(ana, tx => tx.notification.updateMany({
      where: { id: notificacao.id }, data: { readAt: new Date() }
    }));
    expect(r.count, 'o dono não conseguiu marcar a própria notificação').toBe(1);
  }, 60_000);

  it('o dono NÃO transfere a própria notificação para outra conta', async () => {
    const [notificacao] = await notificacaoDe(ana);

    // O ataque: `USING` permitia alcançar a linha, e `WITH CHECK (true)`
    // permitia reescrevê-la com outro `userId` — plantando aviso na caixa de
    // terceiro a partir de uma notificação legítima.
    await deveRecusar('Notification.userId para terceiro', () => comoAtor(ana, tx => tx.notification.updateMany({
      where: { id: notificacao.id }, data: { userId: carla.id }
    })));

    const dono = await comoAtor(ana, tx => tx.notification.findUnique({
      where: { id: notificacao.id }, select: { userId: true }
    }));
    expect(dono.userId, 'a notificação trocou de dono').toBe(ana.id);
  }, 60_000);

  it('a listagem de notificações continua funcionando pela rota — sem regressão', async () => {
    await notificacaoDe(ana);
    const r = await api().get('/api/v1/notifications').set(ana.auth());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.items ?? r.body).length, 'a rota deixou de listar').toBeGreaterThan(0);
  }, 60_000);
});

// ==========================================================================
// AS POLÍTICAS FICAM FIXADAS CONTRA REVERSÃO SILENCIOSA
// ==========================================================================
describe('o inventário de `with_check = true` é declarado, não acidental', () => {
  it('sobra exatamente UMA política com `WITH CHECK = true`, e é a entrega de notificação', async () => {
    const amplas = await prisma.$queryRawUnsafe(
      `SELECT tablename, policyname, cmd FROM pg_policies WHERE with_check = 'true' ORDER BY tablename, policyname`
    );

    // As outras três foram fechadas. Esta é a única em que a escrita ampla é
    // desenho — avisar OUTRA pessoa é o que notificar significa —, e ela está
    // isolada numa política de INSERT para que governe só o INSERT.
    expect(amplas.map(p => `${p.tablename}.${p.policyname} (${p.cmd})`))
      .toEqual(['Notification.notificacao_entrega (INSERT)']);
  });

  it('as quatro políticas corrigidas têm `WITH CHECK` próprio, e não herdado', async () => {
    const esperadas = [
      ['Comment', 'comentario_alteracao'],
      ['Conversation', 'conversa_atualizacao'],
      ['ConversationMember', 'membro_participante'],
      ['Notification', 'notificacao_do_dono']
    ];

    for (const [tabela, politica] of esperadas) {
      const [linha] = await prisma.$queryRawUnsafe(
        `SELECT with_check FROM pg_policies WHERE tablename = $1 AND policyname = $2`, tabela, politica
      );
      expect(linha, `${tabela}.${politica} desapareceu`).toBeTruthy();
      expect(linha.with_check, `${tabela}.${politica} voltou a aceitar qualquer linha`).not.toBe('true');
      expect(linha.with_check, `${tabela}.${politica} ficou sem WITH CHECK`).toBeTruthy();
    }
  });

  it('nenhuma das tabelas envolvidas perdeu RLS ou FORCE', async () => {
    const linhas = await prisma.$queryRawUnsafe(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('Comment','Conversation','ConversationMember','Notification')`
    );
    expect(linhas.length).toBe(4);
    for (const linha of linhas) {
      expect(linha.relrowsecurity, `${linha.relname} perdeu RLS`).toBe(true);
      expect(linha.relforcerowsecurity, `${linha.relname} perdeu FORCE RLS`).toBe(true);
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, criarAtleta, unico, gerarCpf
} from './helpers.mjs';

// ============================================================================
// F1 e F3 — O BANCO E O SERVIÇO DIZENDO A MESMA COISA.
//
// O T1 achou dois defeitos com a MESMA forma: a aplicação autorizava uma
// operação que a política de linha depois recusava, e a resposta saía 500.
// Nenhum dos dois era falha de autorização — a autorização estava certa nos
// dois casos. Era desacordo entre camadas.
//
// F1  DELETE /social/comments/:id respondia 500 para TODO ator autorizado,
//     porque `comentario_leitura` era `deletedAt IS NULL AND EXISTS(post)` e o
//     soft delete gravava exatamente a linha que ela proibia.
//
// F3  PATCH /athletes/:id pelo próprio atleta respondia 500, porque
//     `atleta_alteracao` tinha `WITH CHECK (mci_operator_of(org))` enquanto
//     `athleteService.update` tem ramificação explícita para o dono.
//
// Este arquivo SUBSTITUI os dois testes que afirmavam o 500. Cada garantia que
// o comportamento correto traz está medida aqui, e não deduzida da migration:
// a prova de que "o serviço e o PostgreSQL concordam" é a operação passando
// pela ROTA e, para o mesmo caso, a escrita passando DIRETO no banco sob o
// contexto do dono.
// ============================================================================

let admin;
let organizationId;
let afiliacao;

beforeEach(async () => {
  await garantirCatalogo();
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  organizationId = (await criarOrganizacao(admin, { name: 'Federação F1F3' })).id;
  afiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC - National Physique Committe', code: 'NPC', kind: 'ENTITY' })).body;
});

// ---------------------------------------------------------------------------
describe('F3 — o atleta edita o próprio cadastro', () => {
  let dono;
  let athleteId;
  let outroAtleta;

  beforeEach(async () => {
    dono = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Dono' });
    athleteId = (await criarAtleta(admin, organizationId, {
      fullName: 'Atleta Dono', cpf: gerarCpf(920001),
      affiliationId: afiliacao.id, affiliationNumber: '5001', city: 'Cuiabá'
    })).id;
    expect((await api().patch(`/api/v1/athletes/${athleteId}`).set(admin.auth())
      .send({ userId: dono.id })).status, 'o operador vincula a conta ao atleta').toBeLessThan(300);

    outroAtleta = (await criarAtleta(admin, organizationId, {
      fullName: 'Atleta Alheio', cpf: gerarCpf(920002),
      affiliationId: afiliacao.id, affiliationNumber: '5002'
    })).id;
  });

  const retrato = () => comoAtor(admin, tx => tx.athlete.findUnique({
    where: { id: athleteId },
    select: {
      userId: true, organizationId: true, affiliationId: true, affiliationNumber: true,
      athleteNumber: true, teamId: true, coachId: true, gymId: true,
      status: true, proStatus: true, city: true, phone: true, stageName: true
    }
  }));

  it('altera os campos permitidos, e a resposta é sucesso', async () => {
    const r = await api().patch(`/api/v1/athletes/${athleteId}`).set(dono.auth())
      .send({ city: 'Várzea Grande', phone: '65999990000', stageName: 'O Dono' });

    expect(r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 300)).toBeLessThan(300);

    const depois = await retrato();
    expect(depois.city).toBe('Várzea Grande');
    expect(depois.phone).toBe('65999990000');
    expect(depois.stageName).toBe('O Dono');
  });

  it('os campos restritos continuam protegidos — medidos um a um', async () => {
    const outraFiliacao = await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId, name: 'Entidade Paralela', code: `PAR${unico('c').slice(-4).toUpperCase()}`, kind: 'ENTITY' });
    const antes = await retrato();

    // Tudo abaixo é do operador. O serviço remove estes campos do payload
    // quando o ator é o dono sem `athletes.update`.
    const r = await api().patch(`/api/v1/athletes/${athleteId}`).set(dono.auth()).send({
      city: 'Rondonópolis',
      userId: admin.id,
      affiliationId: outraFiliacao.body.id,
      affiliationNumber: '0001',
      athleteNumber: 'BURLA-1',
      coachId: null,
      gymId: null
    });
    expect(r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 300)).toBeLessThan(300);

    const depois = await retrato();
    // CONTROLE POSITIVO: sem ele, um serviço que ignorasse o corpo inteiro
    // passaria neste teste.
    expect(depois.city, 'o campo livre mudou').toBe('Rondonópolis');

    for (const campo of ['userId', 'organizationId', 'affiliationId', 'affiliationNumber',
      'athleteNumber', 'teamId', 'coachId', 'gymId', 'status', 'proStatus']) {
      expect(depois[campo], `o dono NÃO move ${campo}`).toBe(antes[campo]);
    }
  });

  it('a EQUIPE não se move por edição de perfil — o schema recusa com mensagem', async () => {
    // `athleteUpdate` declara `teamId: z.never()` de propósito: o vínculo com
    // equipe tem trava de unicidade e histórico, e vive em
    // POST /athletes/:id/team. Não é campo silenciosamente descartado — é recusa
    // explícita, e é isso que este teste trava.
    const equipe = await api().post('/api/v1/teams').set(admin.auth())
      .send({ organizationId, name: `Equipe ${unico('t')}` });
    const r = await api().patch(`/api/v1/athletes/${athleteId}`).set(dono.auth())
      .send({ teamId: equipe.body.id });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/equipe do atleta não muda por edição de perfil/i);
  });

  it('não alcança o atleta de outra pessoa, mesmo com o id na URL', async () => {
    const r = await api().patch(`/api/v1/athletes/${outroAtleta}`).set(dono.auth())
      .send({ city: 'Sorriso' });
    expect([403, 404], `respondeu ${r.status}`).toContain(r.status);

    const alheio = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: outroAtleta }, select: { city: true }
    }));
    expect(alheio.city, 'o cadastro alheio não mudou').not.toBe('Sorriso');
  });

  it('o SERVIÇO e o POSTGRESQL concordam: a mesma escrita passa direto no banco', async () => {
    // A prova de coerência entre camadas. Antes da correção esta escrita
    // devolvia 42501 (`new row violates row-level security policy`) sob o
    // contexto do DONO, enquanto o serviço a autorizava.
    const afetadas = await comoAtor(dono, tx => tx.athlete.updateMany({
      where: { id: athleteId }, data: { city: 'Primavera do Leste' }
    }));
    expect(afetadas.count, 'o dono grava a própria linha no banco').toBe(1);

    // E o contrário continua valendo: quem não é dono nem operador não grava.
    const estranho = await criarUsuario({ role: 'ATHLETE', name: 'Terceiro Qualquer' });
    await vincular(organizationId, estranho, 'ATHLETE');
    // A recusa vem como ERRO do banco, e não como zero linhas: `mci_member_of`
    // faz o USING passar para qualquer membro da organização, e quem barra é o
    // WITH CHECK. Pela rota isso nunca acontece — `assertCan` responde 403
    // antes. Aqui a escrita é direta, de propósito: é a prova de que a segunda
    // barreira existe.
    await expect(comoAtor(estranho, tx => tx.athlete.updateMany({
      where: { id: athleteId }, data: { city: 'Sinop' }
    })), 'terceiro não grava a linha de outro atleta').rejects.toThrow();

    const intacto = await retrato();
    expect(intacto.city, 'a cidade do atleta não foi para Sinop').not.toBe('Sinop');
  });

  it('o WITH CHECK impede o dono de reatribuir o atleta para outra conta', async () => {
    // Esta é a garantia que a política dá SOZINHA, sem depender do serviço:
    // `"userId" = mci_current_user_id()` é avaliado na LINHA NOVA.
    await expect(comoAtor(dono, tx => tx.athlete.updateMany({
      where: { id: athleteId }, data: { userId: admin.id }
    }))).rejects.toThrow();

    const depois = await retrato();
    expect(depois.userId, 'a conta vinculada não mudou').toBe(dono.id);
  });

  it('o CPF segue a regra declarada: o dono vê o próprio, terceiro não vê', async () => {
    // A REGRA NÃO É "nunca devolver CPF". É `visibility.js:81`:
    //
    //     cpf: cpfDe(athlete, ehODono || podeVerCpfIntegral ? formatCpf : maskCpf)
    //
    // O dono recebe o próprio documento — ele já o conhece — e quem não é dono
    // nem tem `athletes.read_sensitive` recebe mascarado. Medi isto em vez de
    // afirmar a regra que eu presumia: escrevi primeiro um teste exigindo
    // ausência de CPF, e ele reprovou contra o comportamento deliberado.
    const doDono = await api().patch(`/api/v1/athletes/${athleteId}`).set(dono.auth())
      .send({ city: 'Barra do Garças' });
    expect(doDono.status).toBeLessThan(300);
    expect(doDono.body.cpfMasked, 'o mascarado sempre acompanha').toMatch(/^\*\*\*\./);

    // O CONTROLE QUE IMPORTA: terceiro autenticado, membro da organização, SEM
    // `athletes.read_sensitive`, lendo o mesmo atleta.
    const terceiro = await criarUsuario({ role: 'ATHLETE', name: 'Terceiro Curioso' });
    await vincular(organizationId, terceiro, 'ATHLETE');
    const deTerceiro = await api().get(`/api/v1/athletes/${athleteId}`).set(terceiro.auth());
    expect(deTerceiro.status).toBe(200);
    const cpfParaTerceiro = deTerceiro.body.athlete?.cpf ?? deTerceiro.body.cpf ?? null;
    if (cpfParaTerceiro !== null) {
      expect(cpfParaTerceiro, 'terceiro só pode ver mascarado').toMatch(/\*/);
    }
    expect(JSON.stringify(deTerceiro.body), 'nenhum CPF inteiro para terceiro').not.toMatch(/"cpf":"\d{3}\.\d{3}\.\d{3}-\d{2}"/);
  });
});

// ---------------------------------------------------------------------------
describe('F1 — exclusão lógica de comentário', () => {
  let autorDoPost;
  let comentarista;
  let terceiro;
  let moderador;
  let postId;

  const publicar = async (usuario, texto) => {
    const r = await api().post('/api/v1/social/posts').set(usuario.auth()).send({ content: texto });
    expect(r.status).toBeLessThan(300);
    return r.body.id;
  };
  const comentar = async (usuario, texto) => {
    const r = await api().post(`/api/v1/social/posts/${postId}/comments`).set(usuario.auth())
      .send({ content: texto });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBeLessThan(300);
    return r.body.id;
  };
  const listar = async usuario => {
    const r = await api().get(`/api/v1/social/posts/${postId}/comments`).set(usuario.auth());
    expect(r.status).toBe(200);
    return r.body.items.map(i => i.id);
  };
  const linhaCrua = commentId => comoAtor(moderador, tx => tx.comment.findFirst({
    where: { id: commentId }, select: { id: true, deletedAt: true, content: true }
  }));

  beforeEach(async () => {
    autorDoPost = await criarUsuario({ role: 'ATHLETE', name: 'Autor Do Post' });
    comentarista = await criarUsuario({ role: 'ATHLETE', name: 'Comentarista' });
    terceiro = await criarUsuario({ role: 'ATHLETE', name: 'Terceiro Sem Relação' });
    moderador = await criarUsuario({ role: 'MODERATOR', name: 'Moderação' });
    postId = await publicar(autorDoPost, 'Publicação base do F1.');
  });

  it('o AUTOR do comentário apaga o próprio comentário', async () => {
    const commentId = await comentar(comentarista, 'Comentário do comentarista.');
    expect(await listar(autorDoPost)).toContain(commentId);

    const r = await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth());
    expect(r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 300)).toBe(200);

    expect(await listar(autorDoPost), 'saiu da listagem').not.toContain(commentId);
  });

  it('a exclusão é LÓGICA: a linha continua, com deletedAt preenchido', async () => {
    const commentId = await comentar(comentarista, 'Comentário para apagar.');
    expect((await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth())).status).toBe(200);

    const linha = await linhaCrua(commentId);
    expect(linha, 'a linha NÃO foi removida do banco').toBeTruthy();
    expect(linha.deletedAt, 'deletedAt foi preenchido').toBeTruthy();
    expect(linha.content, 'o conteúdo é preservado para a trilha').toBe('Comentário para apagar.');
  });

  it('o AUTOR DA PUBLICAÇÃO apaga comentário alheio na publicação dele', async () => {
    const commentId = await comentar(comentarista, 'Comentário na casa de outro.');
    const r = await api().delete(`/api/v1/social/comments/${commentId}`).set(autorDoPost.auth());
    expect(r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 300)).toBe(200);
    expect(await listar(autorDoPost)).not.toContain(commentId);
  });

  it('TERCEIRO sem relação NÃO apaga, e o comentário fica', async () => {
    const commentId = await comentar(comentarista, 'Comentário protegido.');
    const r = await api().delete(`/api/v1/social/comments/${commentId}`).set(terceiro.auth());
    expect(r.status).toBe(403);

    expect(await listar(autorDoPost), 'continua na listagem').toContain(commentId);
    expect((await linhaCrua(commentId)).deletedAt, 'nada foi apagado').toBeNull();
  });

  it('a MODERAÇÃO remove o comentário resolvendo a denúncia, e a auditoria registra', async () => {
    const commentId = await comentar(comentarista, 'Comentário denunciado.');
    const denuncia = await api().post('/api/v1/social/reports').set(autorDoPost.auth())
      .send({ targetType: 'COMMENT', targetId: commentId, reason: 'Conteúdo impróprio (QA).' });
    expect(denuncia.status).toBeLessThan(300);

    const r = await api().post(`/api/v1/social/reports/${denuncia.body.id}/resolve`).set(moderador.auth())
      .send({ status: 'RESOLVED', resolution: 'Removido pela moderação.', removeContent: true });
    expect(r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 300)).toBe(200);

    expect((await linhaCrua(commentId)).deletedAt, 'a moderação apagou de fato').toBeTruthy();
    expect(await listar(autorDoPost)).not.toContain(commentId);

    // A AUDITORIA, como a arquitetura existente a define: a moderação grava
    // `CONTENT_MODERATION`. A exclusão pelo próprio autor NÃO é auditada — é
    // ato social ordinário, e nenhuma ação de auditoria foi acrescentada nesta
    // fase para não mudar comportamento além da correção.
    const trilha = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'CONTENT_MODERATION' },
      orderBy: { createdAt: 'desc' },
      select: { action: true, entity: true, entityId: true, userId: true }
    }));
    expect(trilha, 'a moderação deixou rastro').toBeTruthy();
    expect(trilha.entity).toBe('ContentReport');
    expect(trilha.entityId).toBe(denuncia.body.id);
    expect(trilha.userId).toBe(moderador.id);
  });

  it('o contador de comentários da publicação acompanha a exclusão', async () => {
    const commentId = await comentar(comentarista, 'Comentário contado.');
    const antes = await comoAtor(moderador, tx => tx.post.findUnique({ where: { id: postId }, select: { commentCount: true } }));
    expect((await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth())).status).toBe(200);
    const depois = await comoAtor(moderador, tx => tx.post.findUnique({ where: { id: postId }, select: { commentCount: true } }));
    expect(depois.commentCount, 'o contador desceu 1').toBe(antes.commentCount - 1);
  });

  it('a mesma exclusão é idempotente do ponto de vista do cliente: repetir dá 404', async () => {
    const commentId = await comentar(comentarista, 'Comentário para apagar duas vezes.');
    expect((await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth())).status).toBe(200);
    const segunda = await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth());
    expect(segunda.status, 'já apagado responde não encontrado').toBe(404);
  });

  it('PUBLICAÇÃO e MENSAGEM não sofreram regressão', async () => {
    // As duas outras exclusões lógicas do módulo social. `Post` já tinha a
    // ramificação de autor na política; `Message` não tem política sobre
    // `deletedAt`. As duas passavam antes e têm de continuar passando.
    const meuPost = await publicar(comentarista, 'Publicação própria para apagar.');
    expect((await api().delete(`/api/v1/social/posts/${meuPost}`).set(comentarista.auth())).status).toBeLessThan(300);

    const perfilDoAutor = (await api().get('/api/v1/social/me').set(autorDoPost.auth())).body;
    const conversa = await api().post('/api/v1/messenger/conversations').set(comentarista.auth())
      .send({ kind: 'DIRECT', participantIds: [perfilDoAutor.id] });
    expect(conversa.status).toBeLessThan(300);
    const mensagem = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`)
      .set(comentarista.auth()).send({ body: 'Mensagem própria para apagar.' });
    expect(mensagem.status).toBeLessThan(300);
    expect((await api().delete(`/api/v1/messenger/messages/${mensagem.body.id}`).set(comentarista.auth())).status)
      .toBeLessThan(300);
  });

  it('o comentário apagado não aparece para NINGUÉM na listagem', async () => {
    const commentId = await comentar(comentarista, 'Comentário sumido.');
    expect((await api().delete(`/api/v1/social/comments/${commentId}`).set(comentarista.auth())).status).toBe(200);

    // Inclusive para o AUTOR, que é quem a política passou a enxergar no banco.
    // Quem esconde na vitrine é o serviço, que filtra `deletedAt: null` — e é
    // por isso que ampliar a política de leitura não vazou nada.
    for (const quem of [comentarista, autorDoPost, terceiro, moderador]) {
      expect(await listar(quem), 'invisível na listagem').not.toContain(commentId);
    }
  });
});

// ---------------------------------------------------------------------------
describe('as duas políticas corrigidas continuam sendo as declaradas', () => {
  it('comentario_leitura reconhece moderação e autor, e atleta_alteracao reconhece o dono', async () => {
    // Trava a migration contra reversão silenciosa: se alguém reescrever a
    // política sem a ramificação, isto falha antes de o defeito voltar.
    const politicas = await prisma.$queryRawUnsafe(`
      SELECT tablename, policyname, coalesce(qual, '') AS usando, coalesce(with_check, '') AS checando
      FROM pg_policies
      WHERE schemaname = 'public'
        AND ((tablename = 'Comment' AND policyname = 'comentario_leitura')
          OR (tablename = 'Athlete' AND policyname = 'atleta_alteracao'))
    `);
    expect(politicas.length, 'as duas políticas existem').toBe(2);

    const comentario = politicas.find(p => p.tablename === 'Comment');
    expect(comentario.usando).toContain('mci_is_moderator()');
    expect(comentario.usando).toContain('mci_current_profile_id()');
    expect(comentario.usando, 'a ramificação de não apagado continua').toContain('deletedAt');

    const atleta = politicas.find(p => p.tablename === 'Athlete');
    expect(atleta.checando).toContain('mci_operator_of');
    expect(atleta.checando, 'o dono entra no WITH CHECK').toContain('mci_current_user_id()');
  });
});

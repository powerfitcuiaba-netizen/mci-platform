import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, comoAtor, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';

// ==========================================================================
// RECURSÃO DE POLÍTICA — o bloqueador que derrubava o messenger.
//
// REPRODUÇÃO ORIGINAL: 10 de 10.
// ERRO:    PostgresError 54001 — stack depth limit exceeded
// FUNÇÃO:  mci_in_conversation
// TABELAS: Conversation, ConversationMember
//
// O ciclo era:
//
//   política de "Conversation"        -> mci_in_conversation(id)
//   mci_in_conversation               -> consulta "ConversationMember"
//   política de "ConversationMember"  -> ... OR mci_in_conversation("conversationId")
//                                              ^ MESMA conversa, sem fim
//
// O `OR` só escapava quando a varredura encontrava A MINHA linha primeiro e o
// EXISTS parava. Quem NÃO tem linha nenhuma naquela conversa nunca
// curto-circuita — e aí a recursão não termina. Por isso o defeito parecia
// intermitente: dependia de qual linha o plano visitava primeiro.
//
// O gatilho exato, e é comum: um usuário que não participa de NENHUMA
// conversa tentando abrir a primeira, num banco onde já existem conversas de
// terceiros. Em produção, isso é todo usuário novo a partir da segunda
// conversa da plataforma.
// ==========================================================================

let ana;
let bruno;
let forasteira;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
  bruno = await criarUsuario({ name: 'Bruno' });
  // A forasteira não participa de conversa nenhuma. É ela que reproduz.
  forasteira = await criarUsuario({ name: 'Forasteira' });

  const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
    .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
  expect(conversa.status, JSON.stringify(conversa.body)).toBe(201);
  await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`)
    .set(ana.auth()).send({ body: 'conversa privada entre Ana e Bruno' });
});

describe('quem não participa de conversa nenhuma', () => {
  it('consegue ABRIR a primeira conversa — não recebe 500', async () => {
    const resposta = await api().post('/api/v1/messenger/conversations').set(forasteira.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    expect(resposta.status, `corpo: ${JSON.stringify(resposta.body).slice(0, 200)}`).toBe(201);
  });

  it('consegue LISTAR conversas — e a lista vem vazia, não estourada', async () => {
    const resposta = await api().get('/api/v1/messenger/conversations').set(forasteira.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toHaveLength(0);
  });

  it('dez tentativas seguidas, nenhuma 500 — o defeito original era 10 de 10', async () => {
    const status = [];
    for (let i = 0; i < 10; i++) {
      const r = await api().post('/api/v1/messenger/conversations').set(forasteira.auth())
        .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
      status.push(r.status);
    }
    expect(status.filter(s => s >= 500), `respostas: ${status.join(',')}`).toHaveLength(0);
  });

  it('a leitura direta da tabela não estoura a pilha', async () => {
    // Sem passar pela aplicação: é a política que está sob teste.
    const contagem = await comoAtor(forasteira.id, () => prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "Conversation"'
    ));
    expect(contagem[0].n).toBe(0);
  });
});

describe('e a barreira continua de pé', () => {
  it('a forasteira NÃO enxerga a conversa alheia', async () => {
    const lista = await api().get('/api/v1/messenger/conversations').set(forasteira.auth());
    expect(lista.body.items).toHaveLength(0);
  });

  it('a forasteira NÃO lê as mensagens alheias', async () => {
    const daAna = await api().get('/api/v1/messenger/conversations').set(ana.auth());
    const id = daAna.body.items[0].id;

    const tentativa = await api().get(`/api/v1/messenger/conversations/${id}/messages`).set(forasteira.auth());
    expect([403, 404]).toContain(tentativa.status);
  });

  it('a forasteira NÃO escreve na conversa alheia', async () => {
    const daAna = await api().get('/api/v1/messenger/conversations').set(ana.auth());
    const id = daAna.body.items[0].id;

    const tentativa = await api().post(`/api/v1/messenger/conversations/${id}/messages`)
      .set(forasteira.auth()).send({ body: 'invadindo' });
    expect([403, 404]).toContain(tentativa.status);
  });

  // Este teste existe por causa de uma mutação que SOBREVIVEU à bateria.
  //
  // Trocar o WITH CHECK da política de "Message" por `true` — ou seja, deixar
  // qualquer um inserir mensagem em qualquer conversa, com o remetente que
  // quisesse — não fazia teste nenhum falhar. Nem o `terceiro não consegue
  // inserir mensagem em conversa alheia nem pelo banco`, de tests/rls.test.mjs.
  //
  // O motivo é preciso: aquele teste usa `tx.message.create`, e o Prisma emite
  // INSERT ... RETURNING. Com o WITH CHECK afrouxado a gravação PASSA, e o que
  // falha é só o RETURNING, barrado pela política de LEITURA. O statement
  // inteiro volta atrás, o Prisma lança, e o `rejects.toThrow()` fica verde.
  // Verde pela barreira errada: quem estava segurando era a leitura.
  //
  // Medido: sob a mutação, um INSERT CRU (sem RETURNING) grava a linha — 1
  // linha, remetente forjado, conversa alheia. Com a política correta, 42501 e
  // nenhuma linha. Por isso aqui o INSERT é cru: é o único caminho em que a
  // política de ESCRITA responde sozinha, sem a de leitura encobrir o buraco.
  it('a forasteira NÃO grava mensagem em conversa alheia — INSERT cru, sem RETURNING', async () => {
    const daAna = await api().get('/api/v1/messenger/conversations').set(ana.auth());
    const id = daAna.body.items[0].id;

    await expect(comoAtor(forasteira.id, () => prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id, "conversationId", "senderId", body, "createdAt")
       VALUES ('invasao-crua', '${id}', '${forasteira.profileId}', 'INVASAO', now())`
    ))).rejects.toThrow();

    // E a prova que o `rejects` sozinho não dá: a linha não está lá. A contagem
    // é feita por quem ENXERGA a conversa, senão a política de leitura
    // devolveria zero de qualquer jeito e o teste seria verde à toa.
    const [linha] = await comoAtor(ana.id, () => prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "Message" WHERE "conversationId" = '${id}' AND body = 'INVASAO'`
    ));
    expect(linha.n).toBe(0);
  });

  it('a forasteira NÃO enxerga a linha de participação alheia, nem pelo banco', async () => {
    const visiveis = await comoAtor(forasteira.id, () => prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "ConversationMember"'
    ));
    expect(visiveis[0].n).toBe(0);
  });

  it('quem participa continua enxergando a conversa E o outro participante', async () => {
    const lista = await api().get('/api/v1/messenger/conversations').set(ana.auth());
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].counterpart?.id).toBe(bruno.profileId);
    expect(lista.body.items[0].members).toHaveLength(2);
  });
});

// ==========================================================================
// A TRAVA DE VERDADE CONTRA A RECURSÃO É ESTRUTURAL, NÃO COMPORTAMENTAL.
//
// Isto precisa ser dito com todas as letras: os testes de comportamento acima
// NÃO reprovam quando a recursão é reintroduzida. Medi — recolocando a função
// antiga e a política antiga, os nove continuam passando, porque com poucas
// linhas a varredura encontra a linha certa primeiro e o EXISTS para antes de
// estourar. Foi exatamente por isso que o defeito chegou até aqui: a suíte
// roda com a tabela quase vazia.
//
// Logo, o que trava o defeito é a FORMA das políticas, não o efeito delas: uma
// política que consulta a própria tabela que protege é um ciclo, e um ciclo é
// um estouro de pilha esperando o plano certo. Este teste lê as políticas
// vivas do PostgreSQL e recusa esse formato.
// ==========================================================================
describe('as políticas de conversa não podem consultar a si mesmas', () => {
  it('nenhuma política de Conversation, ConversationMember ou Message referencia a própria tabela', async () => {
    const politicas = await prisma.$queryRawUnsafe(`
      SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expressao
        FROM pg_policies
       WHERE tablename IN ('Conversation', 'ConversationMember', 'Message')
    `);
    expect(politicas.length).toBeGreaterThan(0);

    // O que denuncia o ciclo é a tabela aparecer num FROM ou JOIN — e não a
    // simples menção do nome, porque o PostgreSQL qualifica as colunas da
    // própria linha como "Tabela"."coluna". A primeira versão deste teste não
    // distinguia os dois e acusou política correta.
    const ciclos = politicas.filter(p => new RegExp(`(FROM|JOIN)\\s+"${p.tablename}"`, 'i').test(p.expressao));
    expect(ciclos.map(p => `${p.tablename}.${p.policyname}`), 'política que consulta a própria tabela').toEqual([]);
  });

  it('mci_in_conversation NÃO consulta ConversationMember — era ela que fechava o ciclo', async () => {
    const [fn] = await prisma.$queryRawUnsafe(
      "SELECT prosrc FROM pg_proc WHERE proname = 'mci_in_conversation'"
    );
    expect(fn.prosrc).not.toContain('ConversationMember');
    expect(fn.prosrc).toContain('participantIds');
  });

  it('a política de Conversation é LOCAL À LINHA: não consulta tabela nenhuma', async () => {
    const politicas = await prisma.$queryRawUnsafe(
      "SELECT policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') AS e FROM pg_policies WHERE tablename = 'Conversation'"
    );
    // É esta propriedade que quebra o ciclo: quem consulta Conversation não
    // pode ser mandado de volta para outra tabela que consulte Conversation.
    for (const p of politicas) {
      expect(p.e, `${p.policyname} consulta outra tabela`).not.toMatch(/SELECT|FROM/i);
    }
  });
});

describe('o invariante do array de participantes', () => {
  it('participantIds iguala exatamente os membros ativos, em criar / adicionar / sair', async () => {
    const conferir = async (conversationId, quando) => {
      const [linha] = await comoAtor(ana.id, () => prisma.$queryRawUnsafe(
        `SELECT c."participantIds" AS array,
                (SELECT array_agg(m."profileId" ORDER BY m."profileId") FROM "ConversationMember" m
                  WHERE m."conversationId" = c.id AND m."leftAt" IS NULL) AS ativos
           FROM "Conversation" c WHERE c.id = $1`, conversationId));
      expect([...(linha.array || [])].sort(), `divergiu ao ${quando}`).toEqual([...(linha.ativos || [])].sort());
    };

    const grupo = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'GROUP', title: 'Equipe', participantIds: [bruno.profileId] });
    expect(grupo.status, JSON.stringify(grupo.body)).toBe(201);
    await conferir(grupo.body.id, 'criar');

    const adicionou = await api().post(`/api/v1/messenger/conversations/${grupo.body.id}/members`)
      .set(ana.auth()).send({ participantIds: [forasteira.profileId] });
    expect(adicionou.status, JSON.stringify(adicionou.body)).toBe(200);
    await conferir(grupo.body.id, 'adicionar participante');

    const saiu = await api().post(`/api/v1/messenger/conversations/${grupo.body.id}/leave`).set(forasteira.auth());
    expect(saiu.status, JSON.stringify(saiu.body)).toBe(200);
    await conferir(grupo.body.id, 'sair do grupo');

    // e quem saiu deixa de enxergar
    const depois = await api().get('/api/v1/messenger/conversations').set(forasteira.auth());
    expect(depois.body.items.some(c => c.id === grupo.body.id), 'quem saiu continuou enxergando').toBe(false);
  });
});

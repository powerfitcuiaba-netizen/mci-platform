import { describe, it, expect, beforeAll } from 'vitest';
import {
  app, api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, criarAtleta, criarEventoCompleto, inscrever, transicionar, unico, gerarCpf
} from './helpers.mjs';
import { matriz, PERMISSAO, AUTOSSERVICO, SOCIAL, PNG_MINIMO } from './matriz-de-autorizacao.mjs';

// ============================================================================
// GATE EXAUSTIVO DE AUTORIZAÇÃO POR ROTA (T1)
//
// O QUE ESTE ARQUIVO GARANTE, E O QUE A SUÍTE ANTERIOR NÃO GARANTIA
//
// `tests/rotas.test.mjs` já percorre TODA a superfície registrada. A asserção
// dele, porém, é que nenhuma rota responde 5xx. Medido na auditoria: das rotas
// mutantes autenticadas, a maioria chega ao serviço só com `requireAuth`, e quem
// recusa é o `assertCan` lá dentro. Uma função que esquecesse essa chamada
// responderia 200 — e a suíte inteira continuaria verde.
//
// Aqui a asserção é outra: para TODA rota mutante, sem sessão é 401, e com
// sessão autenticada SEM a permissão é 403 (ou, onde declarado, 404 por não
// divulgação). A lista de expectativas vive em `matriz-de-autorizacao.mjs`, uma
// linha por rota, e este arquivo confere que a lista e a superfície são o mesmo
// conjunto — rota nova sem linha quebra o build.
//
// POR QUE 400 É FALHA, E NUNCA APROVAÇÃO
//
// A ordem é `requireAuth` → (`perm`) → `validate` → controller. Onde a
// autorização está no serviço, o Zod roda ANTES dela. Um corpo inválido responde
// 400, e aceitar 400 como "recusou" mediria o Zod, não a autorização. Então
// cada linha da matriz carrega um corpo que passa pela validação, e 400 reprova
// o gate: se um schema mudar, isto aparece como vermelho, não como falso verde.
//
// O ATOR SEM PERMISSÃO É REAL, E NÃO UM OBJETO FABRICADO
//
// `atletaA` é uma conta de papel `ATHLETE`, MEMBRO da organização A. Ela tem a
// base autenticada e nada de operacional — é exatamente o ator que uma federação
// tem em maior número. Um ator fora da organização provaria menos: a recusa
// poderia vir do tenant, e não da permissão.
//
// O POSITIVO VEM DA PRÓPRIA FIXTURE
//
// Toda a fixture é construída pelo ator AUTORIZADO, pelas mesmas rotas HTTP.
// Cada `expect(...).toBe(201)` do `beforeAll` é prova de que quem tem permissão
// consegue operar — sem isso, um gate que respondesse 403 para todo mundo
// passaria.
// ============================================================================

const METODOS_MUTANTES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const PREFIXOS = ['/api/v1', ''];

/**
 * A superfície mutante registrada no Express.
 *
 * O filtro por `camada.method` NÃO é detalhe: uma rota registrada por
 * `router.route(x).get(a).post(b)` guarda os dois métodos na MESMA pilha, e ler
 * a pilha inteira devolve os middlewares dos dois misturados. Sem o filtro, a
 * leitura de "esta rota tem requireAuth" fica falsa.
 */
function rotasMutantes(aplicacao) {
  const rotas = [];
  const coletar = (camada, prefixo) => {
    if (camada.route) {
      for (const metodo of Object.keys(camada.route.methods)) {
        if (metodo === '_all') continue;
        const middlewares = (camada.route.stack || [])
          .filter(c => !c.method || c.method === metodo)
          .map(c => c.name || '(anon)');
        rotas.push({ m: metodo.toUpperCase(), p: prefixo + camada.route.path, middlewares });
      }
      return;
    }
    if (camada.handle?.stack) {
      const casa = caminho => (camada.matchers || []).some(matcher => {
        try { return Boolean(matcher(caminho)); } catch { return false; }
      });
      const base = PREFIXOS.find(candidato => casa(`${candidato}/__sonda__`)) ?? '';
      for (const interna of camada.handle.stack) coletar(interna, prefixo + base);
    }
  };
  for (const camada of (aplicacao._router?.stack || aplicacao.router?.stack || [])) coletar(camada, '');
  return rotas.filter(r => METODOS_MUTANTES.has(r.m));
}

const chave = r => `${r.m} ${String(r.p).replace('/api/v1', '')}`;

let f;          // a fixture
let entradas;   // a matriz aplicada à fixture
let admin;      // ator AUTORIZADO (SUPER_ADMIN)
let atletaA;    // ator autenticado, membro da organização A, SEM permissão
let atletaB;    // ator de OUTRA organização, sem permissão nenhuma
let operadorB;  // ator de OUTRA organização COM permissão operacional lá
let dono;       // a conta VINCULADA ao atleta — o caso do auto-serviço real

/** Dispara uma entrada da matriz com um token (ou sem nenhum). */
function disparar(entrada, auth, url = entrada.url) {
  let pedido = api()[entrada.m.toLowerCase()](`/api/v1${url}`);
  if (auth) pedido = pedido.set(auth);
  if (entrada.arquivo) return pedido.attach(entrada.arquivo, PNG_MINIMO, 'qa.png');
  return entrada.corpo === null ? pedido : pedido.send(entrada.corpo);
}

beforeAll(async () => {
  await garantirCatalogo();
  await limparBanco();

  const sufixo = unico('qa').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-10);
  const codigo = sufixo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-6);

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria QA' });
  const orgA = (await criarOrganizacao(admin, { name: 'Federação A (QA)', autocadastroAberto: true })).id;
  const orgB = (await criarOrganizacao(admin, { name: 'Federação B (QA)', autocadastroAberto: true })).id;

  // OS DOIS ATORES QUE NÃO PODEM. `ATHLETE` tem só a base autenticada.
  atletaA = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Da Casa' });
  atletaB = await criarUsuario({ role: 'ATHLETE', name: 'Atleta De Fora' });
  const membershipDoAtletaA = (await vincular(orgA, atletaA, 'ATHLETE')).id;
  await vincular(orgB, atletaB, 'ATHLETE');

  // O ATOR QUE ISOLA O TENANT, e sem o qual o cross-tenant não prova nada.
  //
  // `atletaB` é recusado por DUAS razões ao mesmo tempo — não pertence à
  // organização A e não tem permissão operacional nenhuma. Medido: um mutante
  // que desligava `assertOrganization` SOBREVIVEU, porque `assertPermission`
  // continuava recusando. `operadorB` tem `EVENT_DIRECTOR` na organização B, ou
  // seja, TEM a permissão — o único obstáculo dele na organização A é o tenant.
  operadorB = await criarUsuario({ role: 'ATHLETE', name: 'Diretor Da Federação B' });
  await vincular(orgB, operadorB, 'EVENT_DIRECTOR');

  // ------------------------------------------------ estrutura esportiva (POSITIVOS)
  const afiliacao = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: orgA, name: 'NPC - National Physique Committe', code: 'NPC', kind: 'ENTITY' });
  expect(afiliacao.status, 'positivo: admin cria filiação').toBeLessThan(300);

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: orgA, name: 'Temporada QA', year: 2030 });
  expect(temporada.status, 'positivo: admin cria temporada').toBeLessThan(300);
  const seasonA = temporada.body.id;
  expect((await api().put(`/api/v1/seasons/${seasonA}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }] })).status,
  'positivo: admin grava a tabela de pontos').toBeLessThan(300);

  const montado = await criarEventoCompleto(admin, orgA, { seasonId: seasonA });
  const evento = {
    eventId: montado.event.id,
    categoryId: montado.category.id,
    eventCategoryId: montado.eventCategory.id,
    divisionId: montado.division.id,
    classId: montado.competitionClass.id
  };
  const categorias = await api().get('/api/v1/categories').set(admin.auth());
  const categoryOutra = categorias.body.items.find(c => c.id !== evento.categoryId)?.id ?? evento.categoryId;

  const cpfDoAtletaA = gerarCpf(510001);
  const athleteA = (await criarAtleta(admin, orgA, {
    fullName: 'Atleta QA Um', cpf: cpfDoAtletaA, affiliationId: afiliacao.body.id, affiliationNumber: '9001'
  })).id;
  const athleteSemEquipe = (await criarAtleta(admin, orgA, {
    fullName: 'Atleta QA Dois', cpf: gerarCpf(510002), affiliationId: afiliacao.body.id, affiliationNumber: '9002'
  })).id;

  const equipe = await api().post('/api/v1/teams').set(admin.auth()).send({ organizationId: orgA, name: 'Equipe QA' });
  expect(equipe.status, 'positivo: admin cria equipe').toBeLessThan(300);
  const marca = await api().post('/api/v1/brands').set(admin.auth())
    .send({ organizationId: orgA, name: 'Marca QA', slug: `marca-base-${sufixo}` });
  expect(marca.status, 'positivo: admin cria marca').toBeLessThan(300);
  const patrocinador = await api().post('/api/v1/sponsors').set(admin.auth())
    .send({ organizationId: orgA, name: 'Patrocinador QA' });
  expect(patrocinador.status, 'positivo: admin cria patrocinador').toBeLessThan(300);
  const parceria = await api().post('/api/v1/partnerships').set(admin.auth())
    .send({ athleteId: athleteA, brandId: marca.body.id });
  expect(parceria.status, 'positivo: admin cria parceria').toBeLessThan(300);

  // O atleta precisa estar em equipe para que `team/unlink` e `transfer` tenham alvo.
  expect((await api().post(`/api/v1/athletes/${athleteA}/team`).set(admin.auth())
    .send({ teamId: equipe.body.id })).status, 'positivo: admin vincula equipe').toBeLessThan(300);
  expect(await comoAtor(admin, tx => tx.athleteTeamMembership.count({
    where: { athleteId: athleteA, endedAt: null }
  })), 'a fixture tem vínculo de equipe ATIVO').toBe(1);

  await transicionar(admin, evento.eventId, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscricao = await inscrever(admin, evento.eventId, { cpf: cpfDoAtletaA, classIds: [evento.classId] });
  // `registrations.create` devolve `{ registration, athleteRecognized }` — o id
  // NÃO está na raiz, e foi a asserção abaixo que pegou isso.
  const registrationA = inscricao.registration?.id ?? inscricao.id;
  expect(registrationA, 'a fixture tem inscrição com id').toBeTruthy();
  const registrationItemA = (await comoAtor(admin, tx => tx.registrationItem.findFirst({
    where: { registrationId: registrationA }, select: { id: true }
  })))?.id;
  expect(registrationItemA, 'a fixture tem item de inscrição').toBeTruthy();

  const credencial = await api().post(`/api/v1/events/${evento.eventId}/credentials`).set(admin.auth())
    .send({ type: 'STAFF', holderName: 'Fulano QA', registrationId: registrationA });
  expect(credencial.status, 'positivo: admin emite credencial').toBeLessThan(300);

  await transicionar(admin, evento.eventId, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);

  const bateria = await api().post(`/api/v1/events/${evento.eventId}/batches`).set(admin.auth())
    .send({ classId: evento.classId, name: 'Bateria QA' });
  expect(bateria.status, 'positivo: admin monta bateria').toBeLessThan(300);

  await transicionar(admin, evento.eventId, ['IN_JUDGING']);

  // O RESULTADO E O LANÇAMENTO. Publicar é o que faz nascer `RankingPoint`.
  const recebido = await api().post(`/api/v1/classes/${evento.classId}/result`).set(admin.auth())
    .send({ entries: [{ athleteId: athleteA, placing: 1, status: 'RANKED' }] });
  expect(recebido.status, 'positivo: admin recebe resultado externo').toBeLessThan(300);
  const publicado = await api().post(`/api/v1/classes/${evento.classId}/result/publish`).set(admin.auth()).send({});
  expect(publicado.status, 'positivo: admin publica resultado').toBeLessThan(300);

  const lancamento = await comoAtor(admin, tx => tx.rankingPoint.findFirst({
    where: { athleteId: athleteA }, select: { id: true, points: true }
  }));

  const overall = await api().post(`/api/v1/events/${evento.eventId}/overall`).set(admin.auth())
    .send({ athleteId: athleteA, categoryId: evento.categoryId });

  // A IMPORTAÇÃO, que também cria a identidade externa alcançável por rota.
  const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
  const csvMinimo = [CABECALHO, `1,Women's Bikini - Open Class A,QA,EXTERNA,7777,Brazil,25,1,90.0,1`].join('\n');
  const lote = await api().post('/api/v1/musclewar/imports').set(admin.auth())
    .send({ organizationId: orgA, seasonId: seasonA, sourceType: 'CSV', sourceRef: `qa-base-${sufixo}.csv`, content: csvMinimo, externalIdPrefix: 'QA', defaultAffiliationCode: 'NPC' });
  expect(lote.status, 'positivo: admin cria lote de importação').toBeLessThan(300);
  const importA = lote.body.import.id;
  const itens = await api().get(`/api/v1/musclewar/imports/${importA}/items`).set(admin.auth());
  const importItemA = itens.body?.items?.[0]?.id ?? null;
  const externa = await comoAtor(admin, tx => tx.externalAthlete.findFirst({ select: { id: true } }));

  const aviso = await api().post('/api/v1/athlete-notices').set(admin.auth())
    .send({ organizationId: orgA, title: 'Aviso base QA', body: 'Corpo do aviso base.' });
  expect(aviso.status, 'positivo: admin publica aviso').toBeLessThan(300);

  const documento = await api().post(`/api/v1/athletes/${athleteA}/documents`).set(admin.auth())
    .attach('file', PNG_MINIMO, 'doc.png');
  expect(documento.status, 'positivo: admin anexa documento do atleta').toBeLessThan(300);
  expect(documento.body?.id, 'a fixture tem documento de atleta com id').toBeTruthy();

  // A CONTA DONA DO ATLETA. É o caso que o autosserviço de verdade produz: a
  // pessoa entra no sistema e o atleta dela responde por `Athlete.userId`.
  dono = await criarUsuario({ role: 'ATHLETE', name: 'Atleta QA Dono' });
  expect((await api().patch(`/api/v1/athletes/${athleteSemEquipe}`).set(admin.auth())
    .send({ userId: dono.id })).status, 'positivo: admin vincula a conta ao atleta').toBeLessThan(300);

  // ------------------------------------------------- pedidos de autocadastro
  const pedidoA = await api().post('/api/v1/athlete-requests').set(atletaA.auth())
    .send({ fullName: 'Atleta Da Casa', cpf: gerarCpf(510011), sex: 'MALE', affiliationId: afiliacao.body.id, affiliationNumber: '9011' });
  const pedidoB = await api().post('/api/v1/athlete-requests').set(atletaB.auth())
    .send({ fullName: 'Atleta De Fora', cpf: gerarCpf(510012), sex: 'MALE', affiliationId: afiliacao.body.id, affiliationNumber: '9012' });

  // --------------------------------------------------- social e mensageria
  const perfil = async usuario => {
    const r = await api().get('/api/v1/social/me').set(usuario.auth());
    return r.body;
  };
  const perfilA = await perfil(atletaA);
  const perfilB = await perfil(atletaB);
  const perfilAdmin = await perfil(admin);

  const publicar = async (usuario, texto) => {
    const r = await api().post('/api/v1/social/posts').set(usuario.auth()).send({ content: texto });
    expect(r.status, 'positivo: conta autenticada publica').toBeLessThan(300);
    return r.body.id;
  };
  const postA = await publicar(atletaA, 'Publicação base do atleta da casa.');
  const postB = await publicar(atletaB, 'Publicação base do atleta de fora.');

  const comentar = async (usuario, postId) => {
    const r = await api().post(`/api/v1/social/posts/${postId}/comments`).set(usuario.auth())
      .send({ content: 'Comentário base.' });
    return r.body.id;
  };
  const comentarioA = await comentar(atletaA, postB);
  const comentarioB = await comentar(atletaB, postA);
  // O COMENTÁRIO DE FATO ALHEIO PARA `atletaA`: de outro autor, em publicação de
  // outro autor. `comentarioB` NÃO serve — ele está na publicação de `atletaA`, e
  // o autor da publicação tem direito de apagar comentário na casa dele
  // (socialService.js:563). Antes da correção do F1 essa escolha errada parecia
  // certa, porque a rota respondia 500 e o teste lia isso como recusa.
  const comentarioAlheio = await comentar(atletaB, postB);

  const story = await api().post('/api/v1/social/stories').set(atletaB.auth()).attach('file', PNG_MINIMO, 'story.png');
  const denuncia = await api().post('/api/v1/social/reports').set(atletaA.auth())
    .send({ targetType: 'POST', targetId: postB, reason: 'Denúncia base de QA.' });

  const conversaA = await api().post('/api/v1/messenger/conversations').set(atletaA.auth())
    .send({ kind: 'DIRECT', participantIds: [perfilAdmin.id] });
  const mensagemA = await api().post(`/api/v1/messenger/conversations/${conversaA.body.id}/messages`)
    .set(atletaA.auth()).send({ body: 'Mensagem base do atleta da casa.' });
  // A CONVERSA ALHEIA: entre B e o admin. `atletaA` não participa dela.
  const conversaAlheia = await api().post('/api/v1/messenger/conversations').set(atletaB.auth())
    .send({ kind: 'DIRECT', participantIds: [perfilAdmin.id] });
  const mensagemAlheia = await api().post(`/api/v1/messenger/conversations/${conversaAlheia.body.id}/messages`)
    .set(atletaB.auth()).send({ body: 'Mensagem base do atleta de fora.' });

  const comunidade = await api().post('/api/v1/communities').set(admin.auth())
    .send({ slug: `com-base-${sufixo}`, name: 'Comunidade base QA' });
  expect(comunidade.status, 'positivo: admin cria comunidade').toBeLessThan(300);

  // As notificações nascem da operação: o check-in notifica o atleta vinculado.
  const notificacaoDoAtletaA = (await comoAtor(atletaA, tx => tx.notification.findFirst({ select: { id: true } })))?.id ?? null;
  const notificacaoAlheia = (await comoAtor(admin, tx => tx.notification.findFirst({
    where: { userId: { not: atletaA.id } }, select: { id: true }
  })))?.id ?? null;

  f = {
    sufixo, codigo, orgA, orgB, admin, atletaA, atletaB, membershipDoAtletaA,
    affiliationA: afiliacao.body.id, seasonA,
    eventA: evento.eventId, eventCategoryA: evento.eventCategoryId, divisionA: evento.divisionId,
    classA: evento.classId, categoryOutra,
    athleteA, athleteSemEquipe, cpfDoAtletaA, cpfLivre: gerarCpf(510021), cpfLivre2: gerarCpf(510022),
    matriculaLivre: '9099',
    teamA: equipe.body.id, brandA: marca.body.id, sponsorA: patrocinador.body.id, partnershipA: parceria.body.id,
    registrationA, registrationItemA,
    credencialA: credencial.body.id, credencialCodigo: credencial.body.code ?? 'QA-CODIGO',
    batchA: bateria.body.id,
    rankingPointA: lancamento?.id ?? 'cmzzzzzzz0000zzzzzzzzzzzz',
    pontosDoLancamentoA: lancamento?.points ?? 5,
    tituloOverallA: overall.body?.id ?? overall.body?.title?.id ?? 'cmzzzzzzz0001zzzzzzzzzzzz',
    importA, importItemA: importItemA ?? 'cmzzzzzzz0002zzzzzzzzzzzz',
    externalAthleteA: externa?.id ?? 'cmzzzzzzz0003zzzzzzzzzzzz',
    noticeA: aviso.body.id,
    documentoDoAtletaA: documento.body?.id ?? 'cmzzzzzzz0004zzzzzzzzzzzz',
    pedidoDoAtletaA: pedidoA.body?.pedido?.id ?? pedidoA.body?.id ?? 'cmzzzzzzz0005zzzzzzzzzzzz',
    pedidoDoAtletaB: pedidoB.body?.pedido?.id ?? pedidoB.body?.id ?? 'cmzzzzzzz0006zzzzzzzzzzzz',
    csvMinimo,
    perfilDoAtletaA: perfilA.id, perfilDoAtletaB: perfilB.id, perfilDoAdmin: perfilAdmin.id,
    handleDoAtletaB: perfilB.handle,
    postDoAtletaA: postA, postDoAtletaB: postB,
    comentarioDoAtletaA: comentarioA, comentarioDoAtletaB: comentarioB,
    comentarioAlheio,
    storyDoAtletaB: story.body?.id ?? 'cmzzzzzzz0007zzzzzzzzzzzz',
    denunciaA: denuncia.body?.id ?? 'cmzzzzzzz0008zzzzzzzzzzzz',
    conversaDoAtletaA: conversaA.body?.id ?? 'cmzzzzzzz0009zzzzzzzzzzzz',
    conversaAlheia: conversaAlheia.body?.id ?? 'cmzzzzzzz0010zzzzzzzzzzzz',
    mensagemDoAtletaA: mensagemA.body?.id ?? 'cmzzzzzzz0011zzzzzzzzzzzz',
    mensagemAlheia: mensagemAlheia.body?.id ?? 'cmzzzzzzz0012zzzzzzzzzzzz',
    comunidadeSlug: comunidade.body.slug,
    notificacaoDoAtletaA: notificacaoDoAtletaA ?? 'cmzzzzzzz0013zzzzzzzzzzzz',
    notificacaoAlheia: notificacaoAlheia ?? 'cmzzzzzzz0014zzzzzzzzzzzz'
  };

  f.dono = dono;
  entradas = matriz(f);
}, 180000);

describe('a matriz e a superfície são o MESMO conjunto', () => {
  it('toda rota mutante autenticada tem uma linha na matriz, e vice-versa', () => {
    const superficie = rotasMutantes(app).filter(r => r.middlewares.includes('requireAuth'));
    const naSuperficie = new Set(superficie.map(chave));
    const naMatriz = new Set(entradas.map(e => `${e.m} ${e.p}`));

    const semLinha = [...naSuperficie].filter(k => !naMatriz.has(k)).sort();
    const semRota = [...naMatriz].filter(k => !naSuperficie.has(k)).sort();

    // ESTA É A ASSERÇÃO QUE FAZ DISTO UM GATE. Rota nova sem expectativa
    // declarada quebra o build; linha órfã também, porque significa que a
    // matriz está descrevendo uma API que não existe mais.
    expect(semLinha, 'rota mutante SEM expectativa declarada na matriz').toEqual([]);
    expect(semRota, 'linha da matriz sem rota correspondente').toEqual([]);
    expect(naMatriz.size).toBe(naSuperficie.size);
  });

  it('as rotas mutantes SEM autenticação são exatamente as duas públicas', () => {
    const semAuth = rotasMutantes(app)
      .filter(r => !r.middlewares.includes('requireAuth') && !r.middlewares.includes('optionalAuth'))
      .map(chave).sort();
    expect(semAuth).toEqual(['POST /auth/login', 'POST /auth/register']);
  });
});

describe('401 — sem sessão, nenhuma rota mutante executa', () => {
  it('as 118 rotas mutantes autenticadas recusam requisição sem token', async () => {
    const falhas = [];
    for (const entrada of entradas) {
      const r = await disparar(entrada, null);
      if (r.status !== 401) falhas.push(`${entrada.m} ${entrada.p} -> ${r.status}`);
    }
    // 400 não serve: significaria que o Zod respondeu antes da autenticação, e
    // a rota teria vazado a forma do corpo para quem não está autenticado.
    expect(falhas, 'rotas que NÃO responderam 401 sem sessão').toEqual([]);
  }, 180000);
});

describe('403 — autenticado, membro da organização, sem a permissão', () => {
  it('toda rota de permissão recusa o ator sem privilégio', async () => {
    const deveRecusar = entradas.filter(e => e.tipo === PERMISSAO);
    const falhas = [];
    for (const entrada of deveRecusar) {
      const r = await disparar(entrada, atletaA.auth());
      const aceitos = [403, ...(entrada.recusasExtras ?? [])];
      if (!aceitos.includes(r.status)) {
        falhas.push(`${entrada.m} ${entrada.p} -> ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 160)}`);
      }
    }
    expect(falhas, 'rotas que NÃO recusaram ator autenticado sem permissão').toEqual([]);
  }, 300000);

  it('nenhuma recusa foi por corpo inválido — 400 mediria o Zod, não a autorização', async () => {
    const quatrocentos = [];
    for (const entrada of entradas.filter(e => e.tipo === PERMISSAO)) {
      const r = await disparar(entrada, atletaA.auth());
      if (r.status === 400) {
        quatrocentos.push(`${entrada.m} ${entrada.p} -> ${JSON.stringify(r.body?.error?.details ?? r.body).slice(0, 200)}`);
      }
    }
    expect(quatrocentos, 'corpo da matriz reprovado pela validação').toEqual([]);
  }, 300000);
});

describe('autosserviço e social — o limite é o dono, não a permissão', () => {
  it('cada rota de escopo de plataforma declara por que o tenant não se aplica', () => {
    const daPlataforma = entradas.filter(e => e.escopoDePlataforma);
    expect(daPlataforma.map(e => `${e.m} ${e.p}`).sort())
      .toEqual(['POST /categories', 'POST /coaches']);
  });

  it('cada rota de autosserviço/social declara por que não é bypass', () => {
    const semMotivo = entradas
      .filter(e => e.tipo === AUTOSSERVICO || e.tipo === SOCIAL)
      .filter(e => !e.motivo || e.motivo.length < 40)
      .map(e => `${e.m} ${e.p}`);
    expect(semMotivo, 'exceção sem justificativa escrita').toEqual([]);
  });

  it('o recurso de OUTRO dono é recusado, mesmo com o id na mão', async () => {
    const comLimite = entradas.filter(e => e.alheio);
    expect(comLimite.length, 'há rotas de dono com limite declarado').toBeGreaterThan(8);

    const falhas = [];
    for (const entrada of comLimite) {
      const r = await disparar(entrada, atletaA.auth(), entrada.alheio());
      // 403 (recusa explícita) ou 404 (não divulgação sob RLS) servem; 2xx não.
      if (![403, 404].includes(r.status)) {
        falhas.push(`${entrada.m} ${entrada.alheio()} -> ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
      }
    }
    expect(falhas, 'recurso de outro dono alcançado por id').toEqual([]);
  }, 300000);
});

// O LIMITE DO DONO E OS DOIS DEFEITOS DO T1 ficaram em
// `tests/f1-f3-autorizacao-coerente.test.mjs`, depois da correção da fase T2.
// Aqui restou o que é do gate: `DELETE /social/comments/:id` voltou para a
// varredura de limite de dono (não há mais exceção declarada), e
// `PATCH /athletes/:id` continua no grupo de PERMISSAO — o dono é outro ator, e
// quem mede o caminho dele é a suíte do T2.

describe('cross-tenant — o ator de outra federação não alcança o recurso', () => {
  it('um OPERADOR da organização B, que TEM a permissão, é recusado na organização A', async () => {
    // Aqui o único obstáculo possível é o tenant: a permissão ele tem, na
    // federação dele. É este caso que mede `assertOrganization`.
    const falhas = [];
    // As rotas de escopo de PLATAFORMA saem daqui por construção: o recurso não
    // pertence a federação nenhuma, então não existe tenant a cruzar. A exclusão
    // é declarada na matriz, com o motivo, e não uma lista de conveniência.
    for (const entrada of entradas.filter(e => e.tipo === PERMISSAO && !e.escopoDePlataforma)) {
      const r = await disparar(entrada, operadorB.auth());
      if (![403, 404].includes(r.status)) {
        falhas.push(`${entrada.m} ${entrada.p} -> ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 140)}`);
      }
    }
    expect(falhas, 'operador de OUTRA federação alcançou o recurso').toEqual([]);
  }, 300000);

  it('as rotas de permissão recusam o ator da organização B', async () => {
    const falhas = [];
    for (const entrada of entradas.filter(e => e.tipo === PERMISSAO)) {
      const r = await disparar(entrada, atletaB.auth());
      if (![403, 404].includes(r.status)) {
        falhas.push(`${entrada.m} ${entrada.p} -> ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 140)}`);
      }
    }
    expect(falhas, 'ator de outra federação alcançou o recurso').toEqual([]);
  }, 300000);
});

#!/usr/bin/env node
// ============================================================================
// GATE VISUAL — MÓDULO TREINADORES & EQUIPES.
//
// POR QUE ESTE SCRIPT EXISTE, E POR QUE ELE NÃO PODE SER SUBSTITUÍDO PELA SUÍTE
// DE UNIDADE
//
// `frontend/src/pages/treinadores.test.jsx` prova que o dado certo aparece e que
// o proibido não aparece. Ele roda em jsdom, que NÃO TEM LAYOUT: nenhuma das 15
// asserções dele sabe dizer se a tabela de atletas estoura a viewport de 360px,
// se o botão de confirmar vínculo tem alvo de toque tocável, ou se o modal de
// convite cabe na tela de um celular.
//
// Este script sobe a pilha REAL — API + build de produção do frontend — e mede,
// num Chromium de verdade, em OITO larguras, os fluxos das três autoridades do
// módulo. Reprovar aqui é reprovar a publicação.
//
// O QUE ELE MEDE, por tela e por largura:
//   * rolagem lateral do documento e elementos estourando a viewport;
//   * alvo de toque abaixo de 40px nas larguras de telefone;
//   * erro no console do navegador e requisição de rede falhada;
//   * presença do conteúdo esperado — porque um gate que mede a tela de login
//     por engano aprova qualquer coisa (aconteceu na FASE 2.3, está escrito lá).
//
// DADO SINTÉTICO, SEMPRE. Banco dedicado e descartável, contas nomeadas "QA",
// CPF gerado por algoritmo. Nada toca produção, e nenhum screenshot carrega
// documento de pessoa real.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4611));
const PORTA_WEB = Number(arg('porta-web', 5611));
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const DATABASE_URL = arg('db', env.QA_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_qa_treinadores?schema=public');
const PASTA = arg('saida', 'docs/audits/qa-visual-treinadores');
const MANTER = argv.includes('--manter');

// AS OITO LARGURAS pedidas na homologação. 360 é o piso de telefone em uso no
// Brasil; 1920 é o monitor cheio do operador da federação.
const LARGURAS = [360, 390, 430, 768, 1024, 1280, 1440, 1920];
// Alvo de toque só é exigência onde o dedo é o ponteiro.
const LARGURAS_DE_TOQUE = new Set([360, 390, 430]);
const ALVO_MINIMO = 40;
// A SENHA DAS CONTAS SINTÉTICAS.
//
// Literal por padrão porque o gate precisa rodar sem configuração, e a pilha que
// ele levanta escuta SÓ em 127.0.0.1, com banco descartável e dado sintético.
// `QA_PASSWORD` existe para o ambiente de homologação (`--manter`), em que uma
// pessoa vai usar o navegador de verdade e pode preferir uma senha própria.
// NUNCA use aqui uma senha que exista em produção.
const SENHA = env.QA_PASSWORD || 'senha-de-qa-123';

const problemas = [];
const evidencias = [];
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  evidencias.push({ rotulo, veredito: passou ? 'PASS' : 'FAIL', detalhe });
  if (!passou) problemas.push(`${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
};
const registrar = (rotulo, veredito, detalhe = '') => {
  console.log(`  ${veredito.padEnd(6)}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  evidencias.push({ rotulo, veredito, detalhe });
};

const processos = [];

// MATAR O GRUPO, E NÃO SÓ O FILHO.
//
// `npx vite preview` é três processos: o `npm exec`, um `sh -c` e o node do
// vite. Matar apenas o primeiro deixava os outros dois vivos, segurando o pipe
// herdado — e o event loop do Node não fecha com um pipe aberto. Medido: a
// rodada terminava os 218 checks, imprimia o resumo, escrevia `evidencias.json`
// e **nunca saía**; ficou 1h30 parada, com 2 s de CPU. Em CI isso é timeout, e
// os órfãos ainda seguram o banco de QA — foi o que produziu, numa tentativa
// anterior, o "database is being accessed by other users".
//
// `detached: true` põe cada filho em seu próprio grupo, e `kill(-pid)` leva o
// grupo inteiro. Os pipes são destruídos em seguida porque um descritor aberto
// basta para segurar o processo, mesmo sem ninguém do outro lado.
const encerrar = () => {
  for (const p of processos) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch { /* grupo já morreu */ }
    try { p.kill('SIGKILL'); } catch { /* já morreu */ }
    p.stdout?.destroy();
    p.stderr?.destroy();
    p.unref();
  }
};

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch { /* subindo */ }
    await esperar(500);
  }
  return false;
}

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const r = await fetch(`${BASE_API}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(`${metodo} ${caminho} → ${r.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// CPF sintético válido. Dado de QA, e só de QA.
function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const d1bruto = (base.reduce((t, n, i) => t + n * (10 - i), 0) * 10) % 11;
  const d1 = d1bruto === 10 ? 0 : d1bruto;
  const comD1 = base.concat([d1]);
  const d2bruto = (comD1.reduce((t, n, i) => t + n * (11 - i), 0) * 10) % 11;
  const d2 = d2bruto === 10 ? 0 : d2bruto;
  return base.join('') + d1 + d2;
}

const conta = sufixo => ({
  name: `QA ${sufixo}`,
  email: `qa.${sufixo}.${Date.now().toString(36)}@mci.local`,
  password: SENHA,
  birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

const promover = (userId, papel) => execSync(
  `psql "${DATABASE_URL.replace(/\?.*$/, '')}" -c "update \\"User\\" set role='${papel}' where id='${userId}'"`,
  { stdio: 'pipe' }
);

// --------------------------------------------------------------- semeadura
async function semear() {
  const admin = await chamar('/auth/register', { metodo: 'POST', corpo: conta('central') });
  promover(admin.user.id, 'SUPER_ADMIN');
  const tokenAdmin = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: admin.user.email, password: SENHA } })).token;

  const org = await chamar('/organizations', {
    metodo: 'POST', token: tokenAdmin,
    corpo: { name: 'Federação QA Treinadores', slug: `qa-tr-${Date.now().toString(36)}`, state: 'MT' }
  });

  const diretor = await chamar('/auth/register', { metodo: 'POST', corpo: conta('diretor') });
  await chamar(`/organizations/${org.id}/members`, {
    metodo: 'POST', token: tokenAdmin, corpo: { userId: diretor.user.id, role: 'EVENT_DIRECTOR' }
  });
  const tokenDiretor = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: diretor.user.email, password: SENHA } })).token;

  const filiacao = await chamar('/affiliations', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'NPC Mato Grosso (QA)', code: 'QA-NPC-MT' }
  });
  const temporada = await chamar('/seasons', {
    metodo: 'POST', token: tokenDiretor, corpo: { organizationId: org.id, name: 'Temporada QA 2026', year: 2026 }
  });

  // ---------------------------------------------------- O TREINADOR APROVADO
  const treinador = await chamar('/auth/register', { metodo: 'POST', corpo: conta('treinador') });
  promover(treinador.user.id, 'COACH');
  const tokenTreinador = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: treinador.user.email, password: SENHA } })).token;
  const cadastro = await chamar('/coaches/self-register', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { name: 'QA Treinadora Marta', registration: 'CREF-QA-9999', phone: '65999887766' }
  });
  // O cadastro já nasce APROVADO desde a decisão que substituiu a análise
  // central: chamar `approve` aqui devolveria 422 `COACH_STATUS_UNCHANGED`.
  await chamar(`/coaches/${cadastro.id}/organizations`, {
    metodo: 'POST', token: tokenDiretor, corpo: { organizationId: org.id, reason: 'Atuação autorizada (QA).' }
  });

  // ------------------------------------------ O TREINADOR AINDA EM ANÁLISE
  const pendente = await chamar('/auth/register', { metodo: 'POST', corpo: conta('pendente') });
  promover(pendente.user.id, 'COACH');
  const tokenPendente = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: pendente.user.email, password: SENHA } })).token;
  const cadastroPendente = await chamar('/coaches/self-register', {
    metodo: 'POST', token: tokenPendente, corpo: { name: 'QA Treinador Em Analise' }
  });

  // --------------------------------------------------------------- A EQUIPE
  const equipe = await chamar('/teams', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'Equipe QA Alfa', coachId: cadastro.id }
  });

  // -------------------------------------- OS ATLETAS, com conta e sem conta
  const atletaConta = await chamar('/auth/register', { metodo: 'POST', corpo: conta('atleta') });
  const tokenAtleta = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: atletaConta.user.email, password: SENHA } })).token;

  const atleta = await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Joana Ferreira', cpf: cpfDeQa(123456701),
      sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5001'
    }
  });
  await chamar(`/athletes/${atleta.id}`, { metodo: 'PATCH', token: tokenDiretor, corpo: { userId: atletaConta.user.id } });

  const atletaVinculado = await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Carla Souza', cpf: cpfDeQa(123456702),
      sex: 'FEMALE', birthDate: '1994-02-20', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5002', teamId: equipe.id
    }
  });

  const atletaTerceiro = await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Marina Alves', cpf: cpfDeQa(123456703),
      sex: 'FEMALE', birthDate: '1998-09-01', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5003'
    }
  });

  // O PEDIDO PENDENTE dirigido ao atleta que TEM conta — é o que a tela
  // "Minha equipe" precisa mostrar para que a confirmação seja medida.
  const pedido = await chamar('/team-membership-requests', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { athleteId: atleta.id, teamId: equipe.id, reason: 'Convite de QA para a equipe.' }
  });

  // Um segundo pedido, para o atleta SEM conta: é o alvo da decisão
  // administrativa e o "pedido alheio" do teste de bloqueio.
  const pedidoAlheio = await chamar('/team-membership-requests', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { athleteId: atletaTerceiro.id, teamId: equipe.id, reason: 'Convite de QA (atleta sem conta).' }
  });

  // UMA DELEGAÇÃO CENTRAL VIVA, para que a mesa central tenha linha na tabela.
  const delegado = await chamar('/auth/register', { metodo: 'POST', corpo: conta('delegado') });
  promover(delegado.user.id, 'ADMIN');
  const concessao = await chamar('/central-authorizations', {
    metodo: 'POST', token: tokenAdmin,
    corpo: {
      userId: delegado.user.id, permission: 'athletes.transfer', organizationId: org.id,
      reason: 'Delegação formal de QA para correção de vínculo.',
      // Escopo e prazo são obrigatórios desde o achado A-02: concessão sem
      // federação valia em todas, e sem prazo valia para sempre.
      expiresAt: '2099-12-31'
    }
  });
  const tokenDelegado = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: delegado.user.email, password: SENHA } })).token;

  return {
    orgId: org.id, seasonId: temporada.id, filiacaoId: filiacao.id,
    emailAdmin: admin.user.email, emailDiretor: diretor.user.email,
    emailTreinador: treinador.user.email, emailPendente: pendente.user.email,
    emailAtleta: atletaConta.user.email, emailDelegado: delegado.user.email,
    coachId: cadastro.id, coachPendenteId: cadastroPendente.id,
    equipeId: equipe.id, equipeNome: equipe.name,
    atletaId: atleta.id, atletaVinculadoId: atletaVinculado.id, atletaTerceiroId: atletaTerceiro.id,
    pedidoId: pedido.id, pedidoAlheioId: pedidoAlheio.id, concessaoId: concessao.id,
    tokenAdmin, tokenDiretor, tokenTreinador, tokenAtleta, tokenDelegado
  };
}

// -------------------------------------------------------------- o navegador
// O QUE NÃO CONTA COMO DEFEITO DO MÓDULO, E A RAZÃO DE CADA EXCLUSÃO.
//
// Um gate que acusa o ambiente em que ele mesmo roda não mede o produto: mede a
// caixa. As três exclusões abaixo foram MEDIDAS na primeira execução deste gate
// e cada uma tem causa verificada fora do módulo. Nenhuma delas encobre erro de
// mesma origem: 4xx e 5xx da API continuam sendo acusados.
//
//   1. ORIGENS DE TERCEIROS. O proxy de egresso deste ambiente intercepta TLS
//      com uma CA própria, e `fonts.googleapis.com` volta
//      ERR_CERT_AUTHORITY_INVALID em toda página. É artefato da caixa — a fonte
//      cai no fallback declarado e a tela continua legível. Excluir a ORIGEM,
//      e não a mensagem: erro de certificado na própria API seguiria acusado.
//   2. net::ERR_ABORTED. Trocar de rota cancela requisições em vuelo; o
//      navegador relata o cancelamento como falha de rede. Uma navegação
//      cancelando o próprio `GET /auth/me` anterior é comportamento do
//      roteador, não defeito.
//   3. Favicon ausente no servidor de preview.
const ORIGENS_DE_TERCEIROS = [/^https?:\/\/fonts\.googleapis\.com/, /^https?:\/\/fonts\.gstatic\.com/];
const deTerceiros = url => ORIGENS_DE_TERCEIROS.some(padrao => padrao.test(url));

function vigiar(pagina) {
  const erros = new Set();
  const rede = new Set();
  const excluidos = new Set();
  const recusas = new Set();
  pagina.on('console', msg => {
    if (msg.type() !== 'error') return;
    const texto = msg.text();
    // Favicon ausente no preview não é defeito do módulo.
    if (/favicon/i.test(texto)) return;
    // A mensagem do console não traz a URL; o local da mensagem traz.
    const urlDaMensagem = msg.location()?.url || '';
    if (deTerceiros(urlDaMensagem)) { excluidos.add(`console de terceiro: ${urlDaMensagem}`); return; }
    erros.add(texto.slice(0, 200));
  });
  pagina.on('pageerror', erro => erros.add(`pageerror: ${String(erro.message).slice(0, 200)}`));
  pagina.on('requestfailed', pedido => {
    const url = pedido.url();
    const motivo = pedido.failure()?.errorText || '';
    if (deTerceiros(url)) { excluidos.add(`rede de terceiro: ${url} — ${motivo}`); return; }
    if (motivo === 'net::ERR_ABORTED') { excluidos.add(`cancelada pela navegação: ${pedido.method()} ${url.replace(BASE_API, '')}`); return; }
    rede.add(`${pedido.method()} ${url.replace(BASE_API, '')} — ${motivo}`);
  });
  pagina.on('response', resposta => {
    const url = resposta.url();
    if (!url.startsWith(BASE_API)) return;
    // 401 e 403 são RESPOSTAS LEGÍTIMAS em várias telas (o painel do treinador
    // consulta rotas que podem recusar). O que não pode é 5xx: erro de servidor
    // numa tela é defeito, sempre.
    if (resposta.status() >= 500) rede.add(`${resposta.request().method()} ${url.replace(BASE_API, '')} → ${resposta.status()}`);
    // AS RECUSAS FICAM REGISTRADAS, MAS NÃO REPROVAM SOZINHAS.
    //
    // 401, 403 e 422 são respostas legítimas em telas que consultam rotas que
    // podem recusar — e algumas verificações deste gate PROVOCAM a recusa de
    // propósito. O que reprova é uma recusa específica que a tela não deveria
    // ter provocado, e isso se afirma onde a tela é conferida (ver A13, o 422
    // da projeção do ranking do treinador), não numa contagem global.
    if (resposta.status() >= 400) recusas.add(`${resposta.request().method()} ${url.replace(BASE_API, '')} → ${resposta.status()}`);
  });
  return { erros, rede, excluidos, recusas };
}

async function entrar(pagina, email) {
  await pagina.goto(`${BASE_WEB}/`, { waitUntil: 'domcontentloaded' });
  // A abertura da marca roda antes da entrada. Ela é dispensada pela MESMA
  // chave que o componente usa — `sessionStorage`, valor `'true'`
  // (`aberturaMci.jsx:28`). Errar o storage ou o valor deixa a abertura rodando
  // e o `waitForSelector` do campo de e-mail estoura por tempo, o que pareceria
  // defeito da tela de login.
  await pagina.evaluate(() => { try { sessionStorage.setItem('mci-abertura-vista', 'true'); } catch { /* aba anônima */ } });
  await pagina.goto(`${BASE_WEB}/`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('input[type="email"]', { timeout: 20000 });
  await pagina.fill('input[type="email"]', email);
  await pagina.fill('input[type="password"]', SENHA);
  await pagina.click('button[type="submit"]');
  await pagina.waitForSelector('nav.sidebar', { timeout: 25000 });
  await esperar(500);
}

async function medir(pagina, largura) {
  await pagina.setViewportSize({ width: largura, height: 900 });
  await esperar(350);
  return pagina.evaluate(alvoMinimo => {
    const doc = document.documentElement;
    const vw = window.innerWidth;

    const dentroDeRolagem = el => {
      for (let pai = el; pai && pai !== document.body; pai = pai.parentElement) {
        const ox = getComputedStyle(pai).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };

    const estourando = [...document.querySelectorAll('body *')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.right <= vw + 1) return false;
        return !dentroDeRolagem(el);
      })
      .slice(0, 5)
      .map(el => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`);

    const pequenos = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (getComputedStyle(el).display === 'none') return false;
        return r.height < alvoMinimo;
      })
      .slice(0, 5)
      .map(el => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}(${Math.round(el.getBoundingClientRect().height)}px)`);

    return {
      overflowDoc: doc.scrollWidth > vw + 1,
      scrollWidth: doc.scrollWidth,
      viewport: vw,
      estourando,
      pequenos,
      // O TEXTO CONFERIDO É O DO MIOLO, E NÃO O DO BODY.
      //
      // `App.jsx:491` embrulha a página num `<main>`; antes dele vêm a barra
      // superior e a `nav.sidebar`, com 20 itens de menu. `body.innerText`
      // começava por esses itens, e os primeiros 600 caracteres eram menu puro:
      // toda afirmação de conteúdo passava ou falhava pelo menu, não pela tela
      // — inclusive a de idioma, que é o mesmo menu traduzido. Medido: a
      // verificação de idioma passava com a tela em branco.
      // O DIÁLOGO NÃO MORA DENTRO DO `<main>`: `Modal` (`components/ui.jsx`)
      // monta a camada como filha do body, e é o comportamento certo — um
      // diálogo preso à árvore da página herdaria `overflow` e empilhamento de
      // quem o abriu. Ler só o miolo dava o painel de fundo em vez do diálogo,
      // e a verificação do modal de convite falhava lendo a tela de trás.
      texto: [
        (document.querySelector('main') || document.body).innerText || '',
        ...[...document.querySelectorAll('[role="dialog"]')].map(el => el.innerText || '')
      ].join('\n').slice(0, 4000)
    };
  }, ALVO_MINIMO);
}

/** Percorre as 8 larguras numa tela já aberta e acusa o que não cabe. */
async function medirNasLarguras(pagina, rotulo, { esperado = null, arquivo = null } = {}) {
  for (const largura of LARGURAS) {
    const m = await medir(pagina, largura);

    conferir(`${rotulo} @${largura} sem rolagem lateral`, !m.overflowDoc,
      m.overflowDoc ? `documento ${m.scrollWidth}px em viewport ${m.viewport}px` : '');
    conferir(`${rotulo} @${largura} nada estoura a viewport`, m.estourando.length === 0,
      m.estourando.join(', '));
    if (LARGURAS_DE_TOQUE.has(largura)) {
      conferir(`${rotulo} @${largura} alvo de toque >= ${ALVO_MINIMO}px`, m.pequenos.length === 0,
        m.pequenos.join(', '));
    }
    if (esperado && largura === 390) {
      conferir(`${rotulo} @${largura} mostra o conteúdo esperado`, esperado.test(m.texto),
        esperado.test(m.texto) ? '' : `texto visto: ${m.texto.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    if (arquivo && (largura === 390 || largura === 1440)) {
      await pagina.screenshot({ path: `${PASTA}/${arquivo}-${largura}.png`, fullPage: true });
    }
  }
}

/** O texto da REGIÃO DE CONTEÚDO (`<main>`), pela mesma razão de `medir`. */
async function textoDoMiolo(pagina) {
  return pagina.evaluate(() => ((document.querySelector('main') || document.body).innerText || ''));
}

async function abrir(pagina, rota) {
  await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
  await esperar(600);
}

// ------------------------------------------------------------------- main
console.log('\n=== GATE VISUAL — TREINADORES & EQUIPES ===\n');

// ACHADO A-07: A PASTA DE EVIDÊNCIA NÃO É APAGADA.
//
// A versão anterior abria com `rmSync(PASTA, { recursive: true, force: true })`,
// e `PASTA` tem por padrão `docs/audits/qa-visual-treinadores` — evidência
// COMMITADA, referenciada pelo relatório de QA visual. Uma execução do gate
// apagava o registro de todas as anteriores, e uma execução que morresse no meio
// deixava a pasta vazia: o gate destruía a prova que existe para produzir.
//
// O que substitui a limpeza é a DENÚNCIA da defasagem. Arquivo que este gate não
// reescreveu continua no disco, e o resumo o nomeia — quem revisa vê que aquele
// PNG é de outra rodada em vez de recebê-lo apagado.
const INICIO_DA_RODADA = Date.now();
const arquivosAnteriores = existsSync(PASTA) ? readdirSync(PASTA) : [];

try {
  mkdirSync(PASTA, { recursive: true });

  console.log('preparando banco de QA…');
  const semSchema = DATABASE_URL.replace(/\?.*$/, '');
  const nomeDoBanco = semSchema.split('/').pop();
  const servidor = `${semSchema.slice(0, semSchema.lastIndexOf('/'))}/postgres`;
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL } });

  console.log('subindo API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL, PORT: String(PORTA_API),
      // Silencioso por padrão para não afogar a saída do gate; `QA_LOG_LEVEL`
      // existe porque houve o que investigar no log do servidor — recusa de RLS
      // ao gravar auditoria aparece só ali (`auditService` a trata com SAVEPOINT
      // e registra em `logger.error`, então o cliente vê 200 e a trilha se perde
      // em silêncio).
      LOG_LEVEL: env.QA_LOG_LEVEL || 'silent', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'qa-visual-treinadores-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-treinadores-storage',
      CORS_ORIGINS: BASE_WEB
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; writeFileSync(`${PASTA}/api.log`, saidaApi); });
  api.stderr.on('data', d => { saidaApi += d; writeFileSync(`${PASTA}/api.log`, saidaApi); });
  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/api/v1/health`, 60)) {
    throw new Error(`API não subiu. Saída:\n${saidaApi.slice(-1500)}`);
  }
  console.log('API no ar.');

  console.log('semeando dados sintéticos…');
  const d = await semear();

  console.log('construindo e servindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'], {
    cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env, detached: true
  });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB, 60)) throw new Error('preview do frontend não subiu');
  console.log('frontend no ar.\n');

  if (MANTER) {
    console.log('============================================================');
    console.log('  AMBIENTE DE VISUALIZAÇÃO NO AR — dados sintéticos');
    console.log('============================================================');
    console.log(`  Web ............ ${BASE_WEB}`);
    console.log(`  Treinador ...... ${d.emailTreinador}`);
    console.log(`  Em análise ..... ${d.emailPendente}`);
    console.log(`  Atleta ......... ${d.emailAtleta}`);
    console.log(`  Central ........ ${d.emailAdmin}`);
    console.log(`  Diretor ........ ${d.emailDiretor}`);
    console.log(`  Delegado ....... ${d.emailDelegado}`);
    console.log(`  Senha .......... ${SENHA}\n`);
    await new Promise(() => {});
  }

  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  const { chromium } = exigir(CAMINHO_PLAYWRIGHT);
  const navegador = await chromium.launch({ args: ['--no-sandbox'] });
  // UMA ABA POR PESSOA É UMA ABA POR CONTEXTO, E NÃO POR PÁGINA.
  //
  // Páginas do MESMO contexto compartilham a origem e, com ela, o
  // `localStorage` — inclusive `mci-auth-token`. Cinco perfis entrando em
  // sequência deixavam o token do ÚLTIMO para todos: enquanto ninguém
  // recarregava, cada aba seguia com o seu usuário em memória e nada aparecia.
  // Medido: bastou a verificação de idioma recarregar a aba do treinador para
  // ela reabrir como administração central e `GET /coaches/me` devolver 404 —
  // uma falha inventada pelo instrumento. Contexto próprio por perfil é o que
  // corresponde à realidade: são pessoas diferentes, em navegadores diferentes.
  const abas = [];
  const novaAba = async () => {
    const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
    abas.push(ctx);
    return ctx.newPage();
  };

  // ====================================================== A. O TREINADOR
  console.log('A) TREINADOR');
  const pTreinador = await novaAba();
  const vTreinador = vigiar(pTreinador);
  await entrar(pTreinador, d.emailTreinador);
  conferir('A1 treinador entra e a barra lateral aparece', true);

  await abrir(pTreinador, 'treinador');
  await medirNasLarguras(pTreinador, 'A2 painel do treinador',
    { esperado: /Treinadora Marta|Situação cadastral/i, arquivo: 'a2-painel-treinador' });

  await abrir(pTreinador, 'treinador');
  await pTreinador.setViewportSize({ width: 1440, height: 900 });
  const temConvidar = await pTreinador.locator('button', { hasText: /Convidar atleta/i }).count();
  conferir('A3 treinador aprovado e autorizado recebe o botão de convidar', temConvidar > 0);

  if (temConvidar > 0) {
    await pTreinador.locator('button', { hasText: /Convidar atleta/i }).first().click();
    await pTreinador.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await medirNasLarguras(pTreinador, 'A4 modal de convite',
      { esperado: /Matrícula na federação/i, arquivo: 'a4-modal-convite' });

    await pTreinador.setViewportSize({ width: 1440, height: 900 });
    await pTreinador.fill('[role="dialog"] input[maxlength="40"]', '5003');
    await pTreinador.locator('[role="dialog"] button', { hasText: /Localizar/i }).click();
    await esperar(1200);
    const textoDialogo = await pTreinador.locator('[role="dialog"]').innerText();
    conferir('A5 busca por matrícula devolve o atleta e NÃO mostra CPF',
      /Marina Alves/i.test(textoDialogo) && !/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(textoDialogo),
      textoDialogo.replace(/\s+/g, ' ').slice(0, 140));
    conferir('A6 atleta com pedido pendente tem o convite bloqueado na tela',
      /solicitação pendente/i.test(textoDialogo));
    await pTreinador.screenshot({ path: `${PASTA}/a5-busca-matricula.png`, fullPage: true });
    await pTreinador.keyboard.press('Escape');
    await esperar(400);
  }

  await abrir(pTreinador, 'treinador');
  // A LISTA DE CONVITES CHEGA DEPOIS DO RESTO DA TELA, e esperar por tempo fixo
  // é o que faz um gate piscar: a mesma verificação passou numa execução e
  // falhou na seguinte só porque a consulta dos pedidos demorou 200 ms mais.
  // Espera-se pelo CONTEÚDO, com teto; se ele não vier, a conferência abaixo
  // reprova de verdade, e não por corrida.
  await pTreinador.waitForFunction(
    () => /Joana Ferreira|Marina Alves/i.test((document.querySelector('main') || document.body).innerText || ''),
    { timeout: 10000 }
  ).catch(() => { /* não veio: quem reprova é a conferência, com o texto visto */ });
  const painel = await textoDoMiolo(pTreinador);
  conferir('A7 o painel mostra a equipe e os atletas vinculados',
    /Equipe QA Alfa/i.test(painel) && /Carla Souza/i.test(painel));
  conferir('A8 o painel do treinador NÃO fala de CPF nem de documento',
    !/\bCPF\b/i.test(painel) && !/documento/i.test(painel),
    painel.replace(/\s+/g, ' ').slice(0, 160));
  conferir('A9 o convite enviado aparece na lista de convites', /Joana Ferreira|Marina Alves/i.test(painel),
    /Joana Ferreira|Marina Alves/i.test(painel) ? '' : painel.replace(/\s+/g, ' ').slice(0, 200));
  conferir('A10 o ranking do treinador avisa que está em homologação',
    /Ranking em homologação/i.test(painel));
  conferir('A11 o painel não apresenta posição de treinador', !/\bposição\b/i.test(painel));

  // TREINADOR EM ANÁLISE — a outra metade de R-03.
  const pPendente = await novaAba();
  const vPendente = vigiar(pPendente);
  await entrar(pPendente, d.emailPendente);
  await abrir(pPendente, 'treinador');
  const textoPendente = await textoDoMiolo(pPendente);
  conferir('A12 cadastro em análise mostra o estado e NÃO oferece convidar',
    /Em análise/i.test(textoPendente) && !/Convidar atleta/i.test(textoPendente));
  await medirNasLarguras(pPendente, 'A13 painel em análise', { arquivo: 'a13-painel-em-analise' });

  // A14 É REGRESSÃO DE UM DEFEITO MEDIDO, e não zelo genérico.
  //
  // A primeira execução deste gate mostrou um 422 SEASON_REQUIRED por
  // carregamento do painel: o cartão de ranking chamava
  // `GET /coaches/:id/ranking/projection` sem temporada e engolia a recusa num
  // `catch`, então a tabela de equipes nunca aparecia e ninguém era avisado. A
  // recusa do servidor está certa (somar temporadas diferentes não significa
  // nada); errada estava a chamada. O cartão agora resolve a temporada antes de
  // perguntar, e esta verificação falha se a chamada sem temporada voltar.
  const recusasDaProjecao = [...vTreinador.recusas].filter(linha => /ranking\/projection/.test(linha) && / → 4/.test(linha));
  conferir('A14 o painel do treinador não provoca recusa na projeção do ranking',
    recusasDaProjecao.length === 0, recusasDaProjecao.slice(0, 3).join(' | '));

  // ========================================================= B. O ATLETA
  console.log('\nB) ATLETA');
  const pAtleta = await novaAba();
  const vAtleta = vigiar(pAtleta);
  await entrar(pAtleta, d.emailAtleta);
  await abrir(pAtleta, 'minha-equipe');
  await medirNasLarguras(pAtleta, 'B1 minha equipe',
    { esperado: /Equipe QA Alfa|Convites de equipe/i, arquivo: 'b1-minha-equipe' });

  await pAtleta.setViewportSize({ width: 1440, height: 900 });
  await abrir(pAtleta, 'minha-equipe');
  const textoAtleta = await textoDoMiolo(pAtleta);
  conferir('B2 o convite mostra a equipe e o treinador solicitante',
    /Equipe QA Alfa/i.test(textoAtleta) && /Treinadora Marta/i.test(textoAtleta));
  conferir('B3 a CONSEQUÊNCIA do vínculo é dita antes do botão',
    /vínculo exclusivo/i.test(textoAtleta) && /administração/i.test(textoAtleta));
  const temConfirmar = await pAtleta.locator('button', { hasText: /Confirmar vínculo/i }).count();
  const temRecusar = await pAtleta.locator('button', { hasText: /^Recusar$/i }).count();
  conferir('B4 as duas ações são oferecidas com o mesmo peso', temConfirmar > 0 && temRecusar > 0);

  // FOCO E TECLADO: o botão de confirmar é alcançável por teclado e tem foco visível.
  const foco = await pAtleta.evaluate(() => {
    const botoes = [...document.querySelectorAll('button')];
    const alvo = botoes.find(b => /Confirmar vínculo/i.test(b.textContent || ''));
    if (!alvo) return null;
    alvo.focus();
    const est = getComputedStyle(alvo);
    return {
      focado: document.activeElement === alvo,
      outline: est.outlineStyle !== 'none' && est.outlineWidth !== '0px',
      sombra: est.boxShadow !== 'none',
      tabIndex: alvo.tabIndex
    };
  });
  conferir('B5 confirmar é focável por teclado', Boolean(foco?.focado) && (foco?.tabIndex ?? -1) >= 0);
  conferir('B6 o foco é visível (outline ou sombra)', Boolean(foco?.outline || foco?.sombra),
    foco ? `outline=${foco.outline} sombra=${foco.sombra}` : 'botão não encontrado');
  await pAtleta.screenshot({ path: `${PASTA}/b6-foco-confirmar.png`, fullPage: true });

  // O PEDIDO ALHEIO: o atleta não alcança o de outra pessoa, nem pela API.
  const alheio = await fetch(`${BASE_API}/team-membership-requests/${d.pedidoAlheioId}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.tokenAtleta}` }
  });
  conferir('B7 confirmar pedido de OUTRO atleta é recusado', [403, 404].includes(alheio.status), `HTTP ${alheio.status}`);

  // A CONFIRMAÇÃO DE VERDADE, pelo navegador.
  await pAtleta.locator('button', { hasText: /Confirmar vínculo/i }).first().click();
  await esperar(1800);
  const depoisDeConfirmar = await textoDoMiolo(pAtleta);
  conferir('B8 depois de confirmar, a tela mostra o histórico e não o convite pendente',
    /Convites anteriores|Confirmado/i.test(depoisDeConfirmar), depoisDeConfirmar.replace(/\s+/g, ' ').slice(0, 160));
  await pAtleta.screenshot({ path: `${PASTA}/b8-vinculo-confirmado.png`, fullPage: true });
  const vinculoApi = await chamar(`/athletes/${d.atletaId}/team-history`, { token: d.tokenDiretor });
  conferir('B9 o vínculo existe no banco depois da confirmação pela tela',
    (vinculoApi.items || []).some(v => v.teamId === d.equipeId && !v.endedAt));

  // ================================================ C. ADMINISTRAÇÃO CENTRAL
  console.log('\nC) ADMINISTRAÇÃO CENTRAL');
  const pCentral = await novaAba();
  const vCentral = vigiar(pCentral);
  await entrar(pCentral, d.emailAdmin);
  await abrir(pCentral, 'admin/treinadores');
  await medirNasLarguras(pCentral, 'C1 mesa de treinadores',
    { esperado: /Treinadores|Cadastros/i, arquivo: 'c1-mesa-central' });

  await pCentral.setViewportSize({ width: 1440, height: 900 });
  await abrir(pCentral, 'admin/treinadores');
  const textoCentral = await textoDoMiolo(pCentral);
  conferir('C2 a fila mostra o cadastro em análise', /Em Analise|Em análise/i.test(textoCentral));
  conferir('C3 a fila oferece aprovar e não aprovar',
    /Aprovar cadastro/i.test(textoCentral) && /Não aprovar/i.test(textoCentral));
  conferir('C4 a delegação central aparece com escopo e prazo',
    /Delegação central/i.test(textoCentral) && /Sem prazo|Todas as federações|Federação QA/i.test(textoCentral));
  conferir('C5 a listagem mostra CONTAGEM de documentos, não o documento',
    !/baixar|download/i.test(textoCentral));

  // APROVAR pela tela, de verdade.
  const botaoAprovar = pCentral.locator('button', { hasText: /Aprovar cadastro/i }).first();
  if (await botaoAprovar.count() > 0) {
    await botaoAprovar.click();
    await pCentral.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await medirNasLarguras(pCentral, 'C6 diálogo de decisão',
      { esperado: /Motivo/i, arquivo: 'c6-dialogo-decisao' });
    await pCentral.setViewportSize({ width: 1440, height: 900 });
    await pCentral.fill('[role="dialog"] textarea', 'Documentação conferida no QA visual.');
    await pCentral.locator('[role="dialog"] button[type="submit"]').click();
    await esperar(1800);
    const aprovado = await chamar(`/coaches/${d.coachPendenteId}/review`, { token: d.tokenAdmin });
    conferir('C7 aprovar pela tela muda o estado no banco', aprovado.status === 'APPROVED', `status=${aprovado.status}`);
    await pCentral.screenshot({ path: `${PASTA}/c7-aprovado.png`, fullPage: true });
  } else {
    registrar('C7 aprovar pela tela', 'NOT TESTED', 'botão de aprovar não encontrado na fila');
  }

  // A DELEGAÇÃO: conceder pela tela.
  const botaoConceder = pCentral.locator('button', { hasText: /Conceder delegação/i }).first();
  if (await botaoConceder.count() > 0) {
    await botaoConceder.click();
    await pCentral.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await medirNasLarguras(pCentral, 'C8 diálogo de delegação',
      { esperado: /Quem recebe|Permissão/i, arquivo: 'c8-dialogo-delegacao' });
    await pCentral.setViewportSize({ width: 1440, height: 900 });
    const textoDelegacao = await pCentral.locator('[role="dialog"]').innerText();
    conferir('C9 o diálogo de delegação só oferece a permissão delegável',
      /athletes\.transfer/.test(textoDelegacao) && !/users\.manage|results\.publish/.test(textoDelegacao));
    await pCentral.screenshot({ path: `${PASTA}/c9-delegacao.png`, fullPage: true });
    await pCentral.keyboard.press('Escape');
    await esperar(400);
  } else {
    registrar('C8/C9 diálogo de delegação', 'NOT TESTED', 'botão de conceder não encontrado');
  }

  // TRANSFERÊNCIA: o ator AUTORIZADO consegue; o não autorizado é recusado.
  const equipeDois = await chamar('/teams', {
    metodo: 'POST', token: d.tokenDiretor,
    corpo: { organizationId: d.orgId, name: 'Equipe QA Beta' }
  });
  const semAutorizacao = await fetch(`${BASE_API}/athletes/${d.atletaId}/team/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.tokenDiretor}` },
    body: JSON.stringify({ teamId: equipeDois.id, reason: 'Tentativa sem delegação (QA).' })
  });
  conferir('C10 diretor de evento NÃO transfere — R-02', semAutorizacao.status === 403, `HTTP ${semAutorizacao.status}`);

  const comAutorizacao = await fetch(`${BASE_API}/athletes/${d.atletaId}/team/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.tokenDelegado}` },
    body: JSON.stringify({ teamId: equipeDois.id, reason: 'Transferência homologada no QA visual.' })
  });
  conferir('C11 delegado com concessão viva transfere', comAutorizacao.status === 200, `HTTP ${comAutorizacao.status}`);

  // AUDITORIA: a trilha do módulo é consultável pela tela.
  await abrir(pCentral, 'admin/auditoria');
  await esperar(1200);
  const textoAuditoria = await textoDoMiolo(pCentral);
  conferir('C12 a auditoria mostra ações do módulo',
    /COACH_APPROVE|MEMBERSHIP_REQUEST|CENTRAL_GRANT|ATHLETE_TEAM/i.test(textoAuditoria),
    textoAuditoria.replace(/\s+/g, ' ').slice(0, 160));
  await medirNasLarguras(pCentral, 'C13 auditoria', { arquivo: 'c13-auditoria' });

  // ======================================================== D. O RANKING
  console.log('\nD) RANKING');
  const bloqueado = await fetch(`${BASE_API}/ranking/coaches`);
  const corpoBloqueado = await bloqueado.json().catch(() => ({}));
  conferir('D1 o ranking de treinadores responde 409', bloqueado.status === 409, `HTTP ${bloqueado.status}`);
  conferir('D2 a recusa diz que a fórmula não foi homologada',
    /não foi homologada/i.test(JSON.stringify(corpoBloqueado)),
    JSON.stringify(corpoBloqueado).slice(0, 160));
  const projecao = await chamar(`/coaches/${d.coachId}/ranking/projection?seasonId=${d.seasonId}`, { token: d.tokenTreinador });
  conferir('D3 a projeção não apresenta total nem posição de treinador',
    projecao.homologado === false && projecao.totalDoTreinador === null && projecao.posicao === null,
    `homologado=${projecao.homologado} total=${projecao.totalDoTreinador} posicao=${projecao.posicao}`);
  const apelido = await fetch(`${BASE_API}/coaches/ranking`);
  conferir('D4 o apelido /coaches/ranking não existe', apelido.status === 404, `HTTP ${apelido.status}`);

  // ============================================ E. IDIOMAS PT / EN / ES
  console.log('\nE) IDIOMAS');
  for (const [codigo, marca] of [['pt-BR', /Situação cadastral/i], ['en', /Registration status/i], ['es', /Situación del registro/i]]) {
    await pTreinador.evaluate(c => { try { localStorage.setItem('mci.idioma', c); } catch { /* sem storage */ } }, codigo);
    // TROCAR A CHAVE NÃO TROCA A TELA SOZINHO, e isso não é defeito: o idioma é
    // lido uma vez, na partida do provedor (`lib/idioma.jsx::idiomaPreferido`),
    // e `goto` com só o `#` mudando é navegação no MESMO documento — não
    // remonta nada. Sem o `reload` a verificação media a tela em português e
    // chamava de falha de tradução o que era falha do instrumento. Na interface
    // real quem troca é o seletor de idioma, que reescreve o estado do provedor.
    await pTreinador.reload({ waitUntil: 'networkidle' });
    await abrir(pTreinador, 'treinador');
    await esperar(800);
    const texto = await textoDoMiolo(pTreinador);
    conferir(`E1 painel do treinador traduzido em ${codigo}`, marca.test(texto),
      marca.test(texto) ? '' : texto.replace(/\s+/g, ' ').slice(0, 140));
    await pTreinador.screenshot({ path: `${PASTA}/e1-idioma-${codigo}.png`, fullPage: true });
  }
  await pTreinador.evaluate(() => { try { localStorage.setItem('mci.idioma', 'pt-BR'); } catch { /* sem storage */ } });

  // ============================== G. PÁGINA DE CONTROLE (ATRIBUIÇÃO)
  //
  // POR QUE UM CONTROLE, E NÃO SÓ AS TELAS DO MÓDULO.
  //
  // Quando a matriz de larguras acusa um alvo de toque baixo ou uma tabela que
  // estoura, a pergunta seguinte é: isso nasceu neste módulo ou já valia para o
  // produto todo? Sem medir uma tela ANTIGA na mesma execução, no mesmo
  // navegador e nas mesmas oito larguras, a resposta seria opinião. `admin/atletas`
  // é tela de antes deste módulo e usa o mesmo sistema de componentes.
  //
  // O CONTROLE NÃO REPROVA O GATE: ele atribui. Cada achado entra como
  // 'CONTROLE' nas evidências, e o relatório usa isso para dizer o que é
  // regressão do módulo e o que é dívida anterior — que não se conserta às
  // escondidas dentro de uma fase de QA visual de outro módulo.
  console.log('\nG) CONTROLE — tela anterior ao módulo, mesmo sistema de componentes');
  const pControle = await novaAba();
  const vControle = vigiar(pControle);
  await entrar(pControle, d.emailAdmin);
  await abrir(pControle, 'admin/atletas');
  for (const largura of LARGURAS) {
    const m = await medir(pControle, largura);
    registrar(`G1 controle admin/atletas @${largura} rolagem lateral`,
      m.overflowDoc ? 'CONTROLE' : 'PASS',
      m.overflowDoc ? `documento ${m.scrollWidth}px em viewport ${m.viewport}px` : '');
    registrar(`G2 controle admin/atletas @${largura} elementos que estouram`,
      m.estourando.length ? 'CONTROLE' : 'PASS', m.estourando.join(', '));
    if (LARGURAS_DE_TOQUE.has(largura)) {
      registrar(`G3 controle admin/atletas @${largura} alvos abaixo de ${ALVO_MINIMO}px`,
        m.pequenos.length ? 'CONTROLE' : 'PASS', m.pequenos.join(', '));
    }
    if (largura === 390) await pControle.screenshot({ path: `${PASTA}/g1-controle-admin-atletas-390.png`, fullPage: true });
  }
  registrar('G4 console da tela de controle', vControle.erros.size ? 'CONTROLE' : 'PASS',
    [...vControle.erros].slice(0, 3).join(' | '));

  // ==================================== F. CONSOLE E REDE, nas quatro páginas
  console.log('\nF) CONSOLE E REDE');
  for (const [rotulo, vigia] of [['treinador', vTreinador], ['em análise', vPendente], ['atleta', vAtleta], ['central', vCentral]]) {
    conferir(`F1 sem erro de console — ${rotulo}`, vigia.erros.size === 0, [...vigia.erros].slice(0, 3).join(' | '));
    conferir(`F2 sem falha de rede nem 5xx — ${rotulo}`, vigia.rede.size === 0, [...vigia.rede].slice(0, 3).join(' | '));
    // O QUE FOI EXCLUÍDO FICA ESCRITO. Uma exclusão silenciosa é indistinguível
    // de um defeito encoberto; registrada, o revisor confere a razão.
    registrar(`F3 excluído do cômputo — ${rotulo}`, 'INFO', [...vigia.excluidos].slice(0, 4).join(' | ') || 'nada excluído');
    registrar(`F4 recusas da API observadas — ${rotulo}`, 'INFO', [...vigia.recusas].slice(0, 6).join(' | ') || 'nenhuma');
  }

  await navegador.close();

  // ------------------------------------------------------------ evidências
  const resumo = {
    quando: new Date().toISOString(),
    navegador: 'Chromium (Playwright)',
    larguras: LARGURAS,
    ambiente: { api: BASE_API, web: BASE_WEB, banco: nomeDoBanco, dados: 'sintéticos' },
    total: evidencias.length,
    pass: evidencias.filter(e => e.veredito === 'PASS').length,
    fail: evidencias.filter(e => e.veredito === 'FAIL').length,
    naoTestado: evidencias.filter(e => e.veredito === 'NOT TESTED').length,
    controle: evidencias.filter(e => e.veredito === 'CONTROLE').length,
    informativas: evidencias.filter(e => e.veredito === 'INFO').length,
    // Ver A-07: nada é apagado, então a defasagem é declarada. Vazio significa
    // que a rodada reescreveu tudo o que havia.
    // `evidencias.json` fica FORA da conferência porque é escrito logo abaixo, e
    // no instante desta comparação ele ainda carrega a data da rodada anterior —
    // apontá-lo como defasado seria acusar o próprio arquivo que está nascendo.
    arquivosDeRodadaAnterior: arquivosAnteriores.filter(nome => {
      if (nome === 'evidencias.json') return false;
      try { return statSync(`${PASTA}/${nome}`).mtimeMs < INICIO_DA_RODADA; } catch { return false; }
    }),
    itens: evidencias
  };
  writeFileSync(`${PASTA}/evidencias.json`, `${JSON.stringify(resumo, null, 2)}\n`);

  console.log(`\n${resumo.pass} PASS, ${resumo.fail} FAIL, ${resumo.naoTestado} NOT TESTED`);
  console.log(`${resumo.controle} achados na tela de CONTROLE (dívida anterior ao módulo), ${resumo.informativas} linhas informativas`);
  console.log(`evidências em ${PASTA}/`);
  if (resumo.arquivosDeRodadaAnterior.length) {
    console.log(`${resumo.arquivosDeRodadaAnterior.length} arquivo(s) são de rodada ANTERIOR e foram preservados:`);
    for (const nome of resumo.arquivosDeRodadaAnterior) console.log(`  - ${nome}`);
  }
  if (problemas.length) {
    console.log('\nPROBLEMAS:');
    for (const p of problemas) console.log(`  - ${p}`);
  }
  process.exitCode = problemas.length ? 1 : 0;
} catch (erro) {
  console.error(`\nGATE INTERROMPIDO: ${erro.message}`);
  process.exitCode = 1;
} finally {
  encerrar();
}

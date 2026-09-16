#!/usr/bin/env node
// ============================================================================
// GATE VISUAL — MINHA FILIAÇÃO, MEU HISTÓRICO E A REVISÃO DA IMPORTAÇÃO.
//
// Teste de unidade prova que o dado certo está na tela. Não prova que a tela
// CABE. Overflow horizontal, alvo de toque pequeno demais e tabela que estoura
// a viewport são defeitos que só aparecem num navegador de verdade, com
// largura de verdade — e foi assim, num navegador, que a FASE 2.3 encontrou o
// que os mocks não encontraram.
//
// Este script SOBE a pilha real (API + build de produção servido), entra com
// uma conta de atleta e mede, em seis larguras:
//
//   * overflow horizontal do documento;
//   * elementos que ultrapassam a viewport;
//   * alvos de toque abaixo de 40px nas larguras de telefone;
//   * erros de página e respostas 5xx.
//
// Reprovar aqui é reprovar a fase. O script existe para saber dizer NÃO.
// ============================================================================

import { spawn } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4599));
const PORTA_WEB = Number(arg('porta-web', 5599));
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = arg('chromium', env.PLAYWRIGHT_CHROMIUM || undefined);
const DATABASE_URL = arg('db', env.QA_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_qa_resp?schema=public');

// As seis larguras pedidas. 320 é o piso real de telefone pequeno; 1440 é a
// mesa de trabalho do operador.
const LARGURAS = [320, 375, 390, 768, 1024, 1280, 1440];
const LARGURAS_DE_TOQUE = new Set([320, 375, 390]);
const ALVO_MINIMO = 40;

// `--manter` sobe a pilha com dados de QA e NÃO mede nada: fica de pé para
// alguém abrir no navegador. É o mesmo caminho que o gate percorre — mesma
// semeadura, mesmo build de produção, mesma API —, de modo que o que o
// responsável vê é exatamente o que o gate aprovou, e não um ambiente
// montado à parte que pode divergir.
const MANTER = argv.includes('--manter');

const problemas = [];
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  if (!passou) problemas.push(`${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
};

const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try {
      const resposta = await fetch(url);
      if (resposta.status < 500) return true;
    } catch { /* ainda subindo */ }
    await esperar(500);
  }
  return false;
}

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const resposta = await fetch(`${BASE_API}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await resposta.json().catch(() => ({}));
  if (resposta.status >= 400) {
    throw new Error(`${metodo} ${caminho} → ${resposta.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// CPF sintético válido — dado de QA, e só de QA.
function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const digito = pesoInicial => {
    const soma = base.concat(base.length === 9 ? [] : []).reduce((t, n, i) => t + n * (pesoInicial - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(10);
  const comD1 = base.concat([d1]);
  const soma2 = comD1.reduce((t, n, i) => t + n * (11 - i), 0);
  const resto2 = (soma2 * 10) % 11;
  const d2 = resto2 === 10 ? 0 : resto2;
  return base.join('') + d1 + d2;
}

const SENHA = 'senha-de-qa-123';
const conta = sufixo => ({
  name: `QA ${sufixo}`,
  email: `qa.${sufixo}.${Date.now().toString(36)}@mci.local`,
  password: SENHA,
  birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

// --------------------------------------------------------------- semeadura
//
// Dados FICTÍCIOS, criados num banco de QA dedicado e descartável. Nada aqui
// toca base de produção, e tudo é nomeado "QA" para que ninguém confunda.
async function semear() {
  const admin = await chamar('/auth/register', { metodo: 'POST', corpo: conta('admin') });
  // Papel privilegiado não é autoatribuível: promove-se direto no banco, como
  // um administrador faria.
  const { execSync } = await import('node:child_process');
  execSync(
    `psql "${DATABASE_URL.replace(/\?.*$/, '')}" -c "update \\"User\\" set role='SUPER_ADMIN' where id='${admin.user.id}'"`,
    { stdio: 'pipe' }
  );
  const relogado = await chamar('/auth/login', { metodo: 'POST', corpo: { email: admin.user.email, password: SENHA } });
  const tokenAdmin = relogado.token;

  const org = await chamar('/organizations', {
    metodo: 'POST', token: tokenAdmin,
    corpo: { name: 'Federação QA', slug: `qa-${Date.now().toString(36)}`, state: 'MT' }
  });

  const diretor = await chamar('/auth/register', { metodo: 'POST', corpo: conta('diretor') });
  await chamar(`/organizations/${org.id}/members`, {
    metodo: 'POST', token: tokenAdmin, corpo: { userId: diretor.user.id, role: 'EVENT_DIRECTOR' }
  });
  await chamar(`/organizations/${org.id}/members`, {
    metodo: 'POST', token: tokenAdmin, corpo: { userId: diretor.user.id, role: 'RANKING_MANAGER' }
  });
  const tokenDiretor = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: diretor.user.email, password: SENHA } })).token;

  const filiacao = await chamar('/affiliations', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'NPC Mato Grosso (QA)', code: 'QA-NPC-MT' }
  });

  const temporada = await chamar('/seasons', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'Temporada QA 2026', year: 2026 }
  });

  const atleta = await chamar('/auth/register', { metodo: 'POST', corpo: conta('atleta') });

  // Um evento com TRÊS classes, para que o histórico tenha mais de uma linha e
  // a tabela precise caber de verdade.
  const evento = await chamar('/events', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, name: 'Etapa QA de Responsividade',
      slug: `qa-ev-${Date.now().toString(36)}`,
      startDate: '2026-11-20T12:00:00.000Z', seasonId: temporada.id
    }
  });

  const categorias = await chamar('/categories', { token: tokenDiretor });
  const bikini = (categorias.items || categorias).find(c => c.code === 'BIKINI');
  const eventCategory = await chamar(`/events/${evento.id}/categories`, {
    metodo: 'POST', token: tokenDiretor, corpo: { categoryId: bikini.id }
  });

  const classes = [];
  for (const def of [
    { division: 'Absoluta', divisionCode: 'QA-ABS', name: 'Open', code: 'OPEN' },
    { division: 'Novatas', divisionCode: 'QA-NOV', name: 'Novice', code: 'NOVICE' },
    { division: 'Master', divisionCode: 'QA-MST', name: 'Master', code: 'MASTER' }
  ]) {
    const divisao = await chamar(`/event-categories/${eventCategory.id}/divisions`, {
      metodo: 'POST', token: tokenDiretor, corpo: { name: def.division, code: def.divisionCode }
    });
    const classe = await chamar(`/divisions/${divisao.id}/classes`, {
      metodo: 'POST', token: tokenDiretor, corpo: { name: def.name, code: def.code }
    });
    classes.push({ ...def, id: classe.id });
  }

  for (const status of ['PLANNED', 'REGISTRATIONS_OPEN']) {
    await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretor, corpo: { status } });
  }

  const inscricao = await chamar(`/events/${evento.id}/registrations`, {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      cpf: cpfDeQa(123456789),
      athlete: { fullName: 'Atleta QA de Responsividade', sex: 'FEMALE', state: 'MT', city: 'Cuiabá' },
      classIds: classes.map(c => c.id)
    }
  });
  const athleteId = inscricao.registration.athlete.id;

  // Liga a conta ao perfil e registra filiação + matrícula: é o que as duas
  // telas mostram.
  await chamar(`/athletes/${athleteId}`, {
    metodo: 'PATCH', token: tokenDiretor,
    corpo: { userId: atleta.user.id, affiliationId: filiacao.id, affiliationNumber: 'QA-88281' }
  });

  for (const status of ['REGISTRATIONS_CLOSED', 'IN_OPERATION']) {
    await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretor, corpo: { status } });
  }
  await chamar(`/registrations/${inscricao.registration.id}/checkin`, { metodo: 'POST', token: tokenDiretor, corpo: {} });
  await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretor, corpo: { status: 'IN_JUDGING' } });

  for (const classe of classes) {
    await chamar(`/classes/${classe.id}/result`, {
      metodo: 'POST', token: tokenDiretor, corpo: { entries: [{ athleteId, placing: 1 }] }
    });
  }
  // O Overall NÃO é declarado aqui de propósito: o gate precisa encontrar a
  // tela COM candidatos e SEM homologação, que é o estado em que o operador a
  // abre de verdade. Declarar na semeadura mediria só o estado final.
  for (const classe of classes) {
    await chamar(`/classes/${classe.id}/result/publish`, { metodo: 'POST', token: tokenDiretor, corpo: { note: 'QA' } });
  }

  return { emailAtleta: atleta.user.email, emailDiretor: diretor.user.email, eventoId: evento.id, athleteId };
}

// ------------------------------------------------------------------ medida

async function medirTela(pagina, rota, largura) {
  await pagina.setViewportSize({ width: largura, height: 900 });
  await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
  await esperar(400);

  return pagina.evaluate((alvoMinimo) => {
    const doc = document.documentElement;
    const larguraViewport = window.innerWidth;

    const estourando = [...document.querySelectorAll('body *')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.right <= larguraViewport + 1) return false;

        // `overflow-x: auto` é solução, não defeito — e a solução vale para a
        // SUBÁRVORE inteira, não só para o elemento que a declara.
        //
        // A primeira versão olhava só o próprio elemento, e por isso acusava
        // `table`, `thead`, `tr` e cada `th` de uma tabela que rolava
        // corretamente dentro do seu contêiner. Um gate que acusa o que está
        // certo é um gate que se aprende a ignorar.
        for (let pai = el; pai && pai !== document.body; pai = pai.parentElement) {
          const overflow = getComputedStyle(pai).overflowX;
          if (overflow === 'auto' || overflow === 'scroll') return false;
        }
        return true;
      })
      .slice(0, 5)
      .map(el => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`);

    const pequenos = [...document.querySelectorAll('button, a[href], [role="button"]')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < alvoMinimo || r.width < alvoMinimo);
      })
      .slice(0, 5)
      .map(el => `${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 18)}`);

    // Rolagem lateral DENTRO de um contêiner não quebra a página — mas
    // esconde coluna, e num telefone a coluna escondida costuma ser justamente
    // o total. Medido à parte para ser tratado como questão de produto, e não
    // confundido com layout quebrado.
    const rolagemLateral = [...document.querySelectorAll('.table-wrap')]
      .filter(el => el.scrollWidth > el.clientWidth + 1)
      .map(el => `${el.scrollWidth}>${el.clientWidth}`);

    return {
      rolagemLateral,
      overflowDoc: doc.scrollWidth > larguraViewport + 1,
      scrollWidth: doc.scrollWidth,
      viewport: larguraViewport,
      estourando,
      pequenos,
      texto: (document.body.innerText || '').slice(0, 400)
    };
  }, ALVO_MINIMO);
}

// -------------------------------------------------------------------- main

console.log('\n=== GATE VISUAL — FASE 9 ===\n');

try {
  console.log('preparando banco de QA…');
  const { execSync } = await import('node:child_process');
  const semSchema = DATABASE_URL.replace(/\?.*$/, '');
  const nomeDoBanco = semSchema.split('/').pop();
  const servidor = semSchema.slice(0, semSchema.lastIndexOf('/')) + '/postgres';
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL } });

  console.log('subindo API…');
  const api = spawn('node', ['server.js'], {
    env: {
      // A API sobe em `development` de propósito. A barreira de produção
      // (bcrypt forte, armazenamento persistente) existe e FUNCIONA — foi ela
      // que recusou a primeira tentativa deste script. O que este gate mede é
      // o BUILD DE PRODUÇÃO DO FRONTEND; forçar a API a passar pela barreira
      // exigiria afrouxá-la, e afrouxar uma barreira para rodar um teste é
      // como desligar o alarme para testar a porta.
      ...env, NODE_ENV: 'development', DATABASE_URL, PORT: String(PORTA_API),
      LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'qa-responsividade-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-resp-storage',
      // Sem isto o navegador nunca passa do login: a API só aceita a origem
      // declarada, e o preview do QA não é a origem padrão. Foi exatamente
      // este o primeiro veredito do gate — e ele acertou: os PASS de overflow
      // estavam medindo a TELA DE LOGIN. Um gate que mede a tela errada é um
      // gate que aprova qualquer coisa.
      CORS_ORIGINS: BASE_WEB
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; });
  api.stderr.on('data', d => { saidaApi += d; });

  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/api/v1/health`, 60)) {
    throw new Error(`API não subiu. Saída:\n${saidaApi.slice(-1200)}`);
  }
  console.log('API no ar.');

  console.log('semeando dados de QA…');
  const dadosSemeados = await semear();
  const { emailAtleta, emailDiretor, eventoId } = dadosSemeados;

  console.log('construindo e servindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: `${BASE_API}` } });
  // `--strictPort` porque a FASE 2.3 mediu o alvo errado uma vez: o preview
  // avisou que a porta estava ocupada, mudou sozinho, e o número medido veio
  // de um servidor de desenvolvimento esquecido.
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'], {
    cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env
  });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB, 60)) throw new Error('preview do frontend não subiu');
  console.log('frontend no ar.\n');

  if (MANTER) {
    console.log('\n============================================================');
    console.log('  AMBIENTE DE VISUALIZAÇÃO NO AR');
    console.log('============================================================\n');
    console.log(`  Web ........ ${BASE_WEB}`);
    console.log(`  API ........ ${BASE_API}\n`);
    console.log('  OPERADOR (homologa o Overall)');
    console.log(`    e-mail ... ${dadosSemeados.emailDiretor}`);
    console.log(`    senha .... ${SENHA}`);
    console.log('    caminho .. Admin › Overall\n');
    console.log('  ATLETA (vê filiação e histórico)');
    console.log(`    e-mail ... ${dadosSemeados.emailAtleta}`);
    console.log(`    senha .... ${SENHA}`);
    console.log('    caminho .. Minha filiação · Meu histórico\n');
    console.log('  Campeonato semeado: "Etapa QA de Responsividade"');
    console.log('    três classes (Open, Novice, Master), Overall POR HOMOLOGAR.\n');
    console.log('  Ctrl+C encerra.\n');
    // Segura o processo: os servidores são filhos dele.
    await new Promise(() => {});
  }

  const { chromium } = await import(CAMINHO_PLAYWRIGHT);
  const navegador = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const paginaAtleta = await contexto.newPage();

  const erros = new Set();
  paginaAtleta.on('pageerror', erro => erros.add(String(erro).slice(0, 160)));
  paginaAtleta.on('response', r => { if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 80)}`); });

  // Entrar como o atleta.
  await paginaAtleta.goto(`${BASE_WEB}/#entrar`, { waitUntil: 'networkidle' });
  await paginaAtleta.fill('input[type="email"]', emailAtleta);
  await paginaAtleta.fill('input[type="password"]', SENHA);
  await paginaAtleta.click('button[type="submit"]');
  await paginaAtleta.waitForTimeout(1500);

  const TELAS = [
    { rota: 'minha-filiacao', rotulo: 'Minha filiação', esperado: /matrícula/i },
    { rota: 'meu-historico', rotulo: 'Meu histórico', esperado: /participaç/i }
  ];

  for (const tela of TELAS) {
    console.log(`\n--- ${tela.rotulo} ---`);
    for (const largura of LARGURAS) {
      const m = await medirTela(paginaAtleta, tela.rota, largura);

      conferir(
        `${tela.rotulo} @ ${largura}px — sem overflow horizontal`,
        !m.overflowDoc,
        m.overflowDoc ? `scrollWidth ${m.scrollWidth} > viewport ${m.viewport}` : ''
      );
      conferir(
        `${tela.rotulo} @ ${largura}px — nenhum elemento fora da viewport`,
        m.estourando.length === 0,
        m.estourando.join(', ')
      );
      if (LARGURAS_DE_TOQUE.has(largura)) {
        // Num telefone, tabela que rola de lado esconde coluna. O histórico
        // vira lista de cartões nessas larguras — e este critério é o que
        // garante que ela virou mesmo.
        conferir(
          `${tela.rotulo} @ ${largura}px — sem rolagem lateral de tabela`,
          m.rolagemLateral.length === 0,
          m.rolagemLateral.join(', ')
        );
        conferir(
          `${tela.rotulo} @ ${largura}px — alvos de toque >= ${ALVO_MINIMO}px`,
          m.pequenos.length === 0,
          m.pequenos.join(', ')
        );
      }
      if (largura === 1440) {
        conferir(`${tela.rotulo} — a tela carregou o conteúdo esperado`, tela.esperado.test(m.texto),
          tela.esperado.test(m.texto) ? '' : m.texto.slice(0, 120).replace(/\n/g, ' | '));
      }
    }
  }

  // ------------------------------------------------ HOMOLOGAÇÃO DO OVERALL
  //
  // O fluxo inteiro, no navegador: entrar como OPERADOR, escolher o evento,
  // ver os candidatos, abrir a prévia, confirmar e conferir o estado
  // homologado. Medir só o layout provaria que a tela cabe; atravessar o fluxo
  // prova que ela FUNCIONA.
  console.log('\n--- Homologação do Overall (fluxo real) ---');

  // CONTEXTO NOVO para o operador, em vez de deslogar o atleta.
  //
  // Limpar o localStorage e voltar para /#entrar não funciona: a sessão também
  // vive no estado do React, e a aplicação redireciona quem já está
  // autenticado — a tela de login nunca aparece, e o `fill` espera por um
  // campo que não existe. Foi assim que este trecho reprovou na primeira
  // execução. Um contexto limpo é a forma honesta de trocar de usuário.
  const contextoOperador = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const pagina = await contextoOperador.newPage();
  pagina.on('pageerror', erro => erros.add(String(erro).slice(0, 160)));
  pagina.on('response', r => { if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 80)}`); });

  await pagina.goto(`${BASE_WEB}/#entrar`, { waitUntil: 'networkidle' });
  await pagina.fill('input[type="email"]', emailDiretor);
  await pagina.fill('input[type="password"]', SENHA);
  await pagina.click('button[type="submit"]');
  await pagina.waitForTimeout(1500);

  await pagina.setViewportSize({ width: 1440, height: 900 });
  await pagina.goto(`${BASE_WEB}/#admin/overall`, { waitUntil: 'networkidle' });
  await esperar(800);

  const seletor = await pagina.$('select[aria-label="Selecionar evento"]');
  conferir('a tela de homologação abre para o operador', Boolean(seletor));

  if (seletor) {
    await pagina.selectOption('select[aria-label="Selecionar evento"]', eventoId);
    await esperar(1200);

    const texto = await pagina.evaluate(() => document.body.innerText);
    conferir('mostra o campeonato e a classe absoluta', /Etapa QA de Responsividade/.test(texto) && /Open/.test(texto));
    conferir('NÃO oferece classe não absoluta', !/Novice|Master/i.test(texto), texto.match(/Novice|Master/i)?.[0] || '');

    const botoes = await pagina.$$('button:has-text("Declarar Overall")');
    conferir('cada candidato tem o mesmo botão — nenhum vem escolhido', botoes.length >= 1, `${botoes.length} botão(ões)`);

    if (botoes.length) {
      await botoes[0].click();
      await esperar(900);
      const dialogo = await pagina.$('[role="dialog"]');
      conferir('o clique abre a PRÉVIA, e não homologa', Boolean(dialogo));

      if (dialogo) {
        const textoDialogo = await dialogo.innerText();
        conferir('a prévia mostra a conta aberta (+10)', /\+10/.test(textoDialogo), textoDialogo.slice(0, 80).replace(/\n/g, ' | '));
        conferir('a prévia diz que a plataforma não decide', /não calcula|não decide/i.test(textoDialogo));

        // A prévia precisa caber nas larguras de telefone: modal cortado num
        // ato oficial é o pior lugar possível para um defeito de layout.
        for (const largura of [320, 375, 390]) {
          await pagina.setViewportSize({ width: largura, height: 900 });
          await esperar(300);
          const m = await pagina.evaluate(() => {
            const dlg = document.querySelector('[role="dialog"]');
            if (!dlg) return null;
            const r = dlg.getBoundingClientRect();
            return { dentro: r.left >= -1 && r.right <= window.innerWidth + 1, doc: document.documentElement.scrollWidth > window.innerWidth + 1 };
          });
          conferir(`prévia @ ${largura}px — modal dentro da viewport`, Boolean(m?.dentro));
          conferir(`prévia @ ${largura}px — sem overflow horizontal`, m ? !m.doc : false);
        }

        await pagina.setViewportSize({ width: 1440, height: 900 });
        await esperar(300);
        await pagina.click('button:has-text("Confirmar homologação")');
        await esperar(1500);

        const depois = await pagina.evaluate(() => document.body.innerText);
        conferir('estado HOMOLOGADO aparece depois da confirmação', /Overall declarado oficialmente/i.test(depois),
          depois.slice(0, 120).replace(/\n/g, ' | '));
        conferir('o botão de declarar some do recorte homologado', !/Declarar Overall/.test(depois));
        conferir('a correção existe como operação própria', /Revogar/i.test(depois));
      }
    }

    // Layout da tela de homologação nas sete larguras, já no estado final.
    for (const largura of LARGURAS) {
      await pagina.setViewportSize({ width: largura, height: 900 });
      await pagina.goto(`${BASE_WEB}/#admin/overall`, { waitUntil: 'networkidle' });
      await esperar(400);
      await pagina.selectOption('select[aria-label="Selecionar evento"]', eventoId).catch(() => {});
      await esperar(900);

      const m = await pagina.evaluate((alvoMinimo) => {
        const larguraViewport = window.innerWidth;
        const estourando = [...document.querySelectorAll('body *')].filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (r.right <= larguraViewport + 1) return false;
          for (let pai = el; pai && pai !== document.body; pai = pai.parentElement) {
            const o = getComputedStyle(pai).overflowX;
            if (o === 'auto' || o === 'scroll') return false;
          }
          return true;
        }).slice(0, 5).map(el => {
          const r = el.getBoundingClientRect();
          const est = getComputedStyle(el);
          return `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`
            + `[l=${Math.round(r.left)} w=${Math.round(r.width)} r=${Math.round(r.right)} minw=${est.minWidth} maxw=${est.maxWidth} disp=${est.display}]`;
        });

        const rolagem = [...document.querySelectorAll('.table-wrap')]
          .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => `${el.scrollWidth}>${el.clientWidth}`);

        const pequenos = [...document.querySelectorAll('button, a[href], [role="button"]')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.height < alvoMinimo || r.width < alvoMinimo);
        }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 18)}`);

        return {
          overflowDoc: document.documentElement.scrollWidth > larguraViewport + 1,
          estourando, rolagem, pequenos,
          carregou: /Homologação do Overall/i.test(document.body.innerText)
        };
      }, ALVO_MINIMO);

      conferir(`Homologação @ ${largura}px — a tela carregou`, m.carregou);
      conferir(`Homologação @ ${largura}px — sem overflow horizontal`, !m.overflowDoc);
      conferir(`Homologação @ ${largura}px — nenhum elemento fora da viewport`, m.estourando.length === 0, m.estourando.join(', '));
      if (LARGURAS_DE_TOQUE.has(largura)) {
        conferir(`Homologação @ ${largura}px — sem rolagem lateral de tabela`, m.rolagem.length === 0, m.rolagem.join(', '));
        conferir(`Homologação @ ${largura}px — alvos de toque >= ${ALVO_MINIMO}px`, m.pequenos.length === 0, m.pequenos.join(', '));
      }
    }
  }

  // ------------------------------------------------- 13.19/13.20 ESTABILIDADE
  //
  // Fluxo prolongado no navegador: entrar, passear por todas as telas, repetir.
  // O que se procura não é lentidão — é CRESCIMENTO: heap que sobe e não
  // volta, listener que se acumula, timer que nunca é limpo. Um vazamento não
  // aparece numa visita; aparece na centésima.
  //
  // A coleta é FORÇADA antes de cada leitura: sem isso o heap medido é lixo
  // ainda não recolhido, e qualquer número serve para provar qualquer coisa.
  console.log('\n--- Estabilidade (fluxo prolongado) ---');

  const CICLOS = Number(arg('ciclos-estabilidade', 25));
  const cdp = await contextoOperador.newCDPSession(pagina);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  const ROTEIRO = ['admin/overall', 'admin/ranking', 'admin/resultados', 'ranking', 'campeonatos', 'admin'];

  const medirEstado = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
    return {
      heap: m.JSHeapUsedSize ?? 0,
      listeners: m.JSEventListeners ?? 0,
      nos: m.Nodes ?? 0,
      documentos: m.Documents ?? 0
    };
  };

  // Aquecimento: a primeira volta paga compilação e cache, e misturá-la com o
  // resto faria qualquer medida parecer um vazamento.
  for (const rota of ROTEIRO) {
    await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
    await esperar(120);
  }
  const inicial = await medirEstado();

  for (let ciclo = 0; ciclo < CICLOS; ciclo += 1) {
    for (const rota of ROTEIRO) {
      await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
      await esperar(80);
    }
  }
  const final = await medirEstado();

  const crescimentoHeap = (final.heap - inicial.heap) / Math.max(1, inicial.heap);
  const crescimentoListeners = final.listeners - inicial.listeners;

  console.log(`  ${CICLOS} ciclos × ${ROTEIRO.length} telas = ${CICLOS * ROTEIRO.length} navegações`);
  console.log(`  heap      ${(inicial.heap / 1e6).toFixed(1)}MB → ${(final.heap / 1e6).toFixed(1)}MB  (${(crescimentoHeap * 100).toFixed(1)}%)`);
  console.log(`  listeners ${inicial.listeners} → ${final.listeners}  (${crescimentoListeners >= 0 ? '+' : ''}${crescimentoListeners})`);
  console.log(`  nós DOM   ${inicial.nos} → ${final.nos}`);
  console.log(`  documentos ${inicial.documentos} → ${final.documentos}`);

  // Os tetos são de FORMA, não de valor absoluto: 40% de folga cobre variação
  // de cache e de coletor, e ainda reprova um heap que dobra. Listener é mais
  // rígido porque ele não deveria crescer: a mesma tela montada de novo
  // desmonta o que montou.
  conferir('heap não cresce sem parar', crescimentoHeap < 0.40, `${(crescimentoHeap * 100).toFixed(1)}%`);
  conferir('listeners não se acumulam', crescimentoListeners <= 25, `${crescimentoListeners}`);
  conferir('documentos não vazam', final.documentos <= inicial.documentos + 2, `${inicial.documentos} → ${final.documentos}`);

  conferir('nenhum erro de página nem resposta 5xx', erros.size === 0, [...erros].join(' · '));

  await navegador.close();
} catch (erro) {
  console.error(`\nFALHA NA EXECUÇÃO: ${erro.message}`);
  problemas.push(`execução: ${erro.message}`);
} finally {
  encerrar();
}

console.log(`\n=== ${problemas.length ? `REPROVADO (${problemas.length})` : 'APROVADO'} ===`);
for (const p of problemas) console.log(`  · ${p}`);
process.exit(problemas.length ? 1 : 0);

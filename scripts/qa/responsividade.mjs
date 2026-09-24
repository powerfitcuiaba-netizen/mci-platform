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
// uma conta de atleta e mede, em QUINZE larguras:
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

// AS LARGURAS. 320 é o piso real de telefone pequeno; 1920 é a mesa de
// trabalho do operador em monitor cheio.
//
// 430, 560, 1180, 1366 e 1920 entraram nesta fase, pedidas na homologação: a
// primeira é o telefone grande atual, 560 é o ponto em que a barra superior
// troca de arranjo — e portanto o mais provável de quebrar —, 1180 é o tablet
// deitado, e as duas últimas são as telas que o operador usa de fato.
// 414, 820 e 1600 entraram na auditoria final, pedidas na homologação: 414 é
// o iPhone Plus/Max em retrato, 820 é o iPad em retrato — a largura onde o
// layout troca de arranjo sem ainda ser desktop — e 1600 é o monitor
// intermediário que ficava entre 1440 e 1920 sem nunca ter sido medido.
//
// As larguras anteriores FICAM. Trocar uma lista medida por outra perde
// cobertura em silêncio; a união custa alguns segundos e não perde nada.
const LARGURAS = [320, 375, 390, 414, 430, 560, 768, 820, 1024, 1180, 1280, 1366, 1440, 1600, 1920];
// Alvo de toque só é exigência onde o dedo é o ponteiro. Acima de 430 o mouse
// assume, e cobrar 40px de um botão de barra de ferramentas de desktop
// produziria reprovação sem defeito — foi exatamente o erro que a fase
// anterior cometeu e mediu.
const LARGURAS_DE_TOQUE = new Set([320, 375, 390, 414, 430]);
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

// O CPF do atleta semeado, na forma em que o servidor o devolve quando
// alguém o revela. Fictício, de banco de QA descartável — e é justamente por
// ser conhecido que o gate consegue afirmar que ele NÃO aparecia antes do
// pedido e APARECE depois.
const CPF_DO_ATLETA = cpfDeQa(123456789);
const CPF_DO_ATLETA_FORMATADO = `${CPF_DO_ATLETA.slice(0, 3)}.${CPF_DO_ATLETA.slice(3, 6)}.${CPF_DO_ATLETA.slice(6, 9)}-${CPF_DO_ATLETA.slice(9)}`;
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
      cpf: CPF_DO_ATLETA,
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
  const { emailAtleta, emailDiretor, eventoId, athleteId } = dadosSemeados;

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

  // `createRequire`, e não `import()`: o Playwright é CommonJS. Resolvido por
  // CAMINHO ABSOLUTO, o namespace ESM de um CJS não expõe `chromium` como export
  // nomeado — vem `undefined`, e o erro só aparece lá no `.launch`. Com o módulo
  // instalado em `node_modules` o especificador nu funcionava e o defeito ficava
  // escondido; numa instalação global, o gate inteiro não sobe.
  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  const { chromium } = exigir(CAMINHO_PLAYWRIGHT);
  const navegador = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const paginaAtleta = await contexto.newPage();

  const erros = new Set();
  // 401 NÃO É 5xx, e por isso passava despercebido — mas é ele que derruba a
  // sessão no cliente (`SESSAO_EXPIRADA`) e leva a aplicação de volta ao
  // login. Numa execução longa, uma única recusa dessas transforma todo teste
  // seguinte em "a tela não apareceu", sem dizer por quê. Agora diz.
  const naoAutorizadas = new Set();
  const espiar = pagina => {
    pagina.on('response', r => {
      if (r.status() === 401) naoAutorizadas.add(`${r.request().method()} ${r.url().replace(BASE_API, '')}`);
    });
  };

  paginaAtleta.on('pageerror', erro => erros.add(String(erro).slice(0, 160)));
  paginaAtleta.on('response', r => { if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 80)}`); });
  espiar(paginaAtleta);

  // Entrar como o atleta.
  await paginaAtleta.goto(`${BASE_WEB}/#entrar`, { waitUntil: 'networkidle' });
  await paginaAtleta.fill('input[type="email"]', emailAtleta);
  await paginaAtleta.fill('input[type="password"]', SENHA);
  await paginaAtleta.click('button[type="submit"]');
  await paginaAtleta.waitForTimeout(1500);

  const TELAS = [
    { rota: 'minha-filiacao', rotulo: 'Minha filiação', esperado: /matrícula/i },
    { rota: 'meu-historico', rotulo: 'Meu histórico', esperado: /participaç/i },
    // O RANKING PÚBLICO, que ganhou um terceiro seletor nesta fase.
    // Temporada → Categoria → Classe numa barra que já era apertada em 390:
    // é o lugar mais provável de a largura estourar, e é justamente o que
    // nenhum teste de unidade enxerga.
    { rota: 'ranking', rotulo: 'Ranking público', esperado: /ranking|temporada/i }
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
  espiar(pagina);

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
  // ======================================================================
  // A FASE DO ATLETA, NO NAVEGADOR.
  //
  // Teste de unidade prova que o componente chama a rota certa com o mock
  // certo. Não prova que o operador consegue chegar até ali, que a tela cabe,
  // nem que o recado da federação de fato aparece na cara de quem tem de vê-lo.
  //
  // Aqui o fluxo é atravessado inteiro, com a pilha real:
  //
  //   1. o operador acha o atleta na lista — e a lista NÃO mostra documento;
  //   2. abre o perfil, vê o CPF MASCARADO e pede o inteiro, que o servidor
  //      autoriza e audita;
  //   3. publica um recado para a federação;
  //   4. o ATLETA entra e recebe o recado por cima da tela; fecha; recarrega;
  //      e o recado não volta.
  //
  // O passo 4 é o que nenhum mock alcança: `showOnce` só prova que funciona
  // quando a segunda visita é uma segunda visita de verdade.
  // ======================================================================
  console.log('\n--- Administração → Atletas (lista e perfil) ---');

  await pagina.setViewportSize({ width: 1440, height: 900 });
  await pagina.goto(`${BASE_WEB}/#admin/atletas`, { waitUntil: 'networkidle' });
  await esperar(1000);

  const textoDaLista = await pagina.evaluate(() => document.body.innerText);
  conferir('a lista administrativa de atletas abre para o operador',
    /Atleta QA de Responsividade/.test(textoDaLista),
    textoDaLista.slice(0, 140).replace(/\n/g, ' | '));

  // O CPF NÃO APARECE NA LISTAGEM — nem inteiro, nem mascarado. Uma fila de
  // duzentos nomes com documento ao lado é um vazamento esperando um print.
  conferir('a listagem não mostra documento, nem mascarado',
    !/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(textoDaLista) && !/\*\*\*\.\d{3}/.test(textoDaLista),
    (textoDaLista.match(/[\d*]{3}\.[\d*]{3}\.[\d*]{3}-[\d*]{2}/) || [''])[0]);

  // A BUSCA VAI PARA O SERVIDOR E NÃO ENTRA NA URL. O termo é digitado; o que
  // se mede é que o hash da página não o carrega junto.
  const campoDeBusca = await pagina.$('input[aria-label="Buscar atleta"]');
  conferir('a lista tem campo de busca', Boolean(campoDeBusca));
  if (campoDeBusca) {
    // O TERMO DE BUSCA É DISTINTIVO DE PROPÓSITO: a primeira versão deste
    // gate procurou "Atleta" na URL e reprovou sozinha, porque a própria rota
    // se chama `#admin/atletas`. Um termo que não aparece em rota nenhuma é o
    // que torna a asserção capaz de distinguir.
    await campoDeBusca.fill('Responsividade');
    await esperar(1200);
    const depoisDaBusca = await pagina.evaluate(() => ({
      texto: document.body.innerText, hash: window.location.hash, busca: window.location.search
    }));
    conferir('a busca encontra o atleta', /Atleta QA de Responsividade/.test(depoisDaBusca.texto));
    conferir('o termo buscado não entra na URL',
      !/Responsividade/i.test(depoisDaBusca.hash) && !/Responsividade/i.test(depoisDaBusca.busca),
      `${depoisDaBusca.hash} ${depoisDaBusca.busca}`);
  }

  // O FILTRO DE ESTADO existe e recorta.
  const chipSuspenso = await pagina.$('button.chip:has-text("Suspenso")');
  conferir('o filtro por estado existe na lista', Boolean(chipSuspenso));
  if (chipSuspenso) {
    await chipSuspenso.click();
    await esperar(1000);
    const filtrado = await pagina.evaluate(() => document.body.innerText);
    conferir('filtrar por SUSPENSO tira o atleta ativo da lista',
      !/Atleta QA de Responsividade/.test(filtrado));
    await pagina.click('button.chip:has-text("Todos")');
    await esperar(900);
  }

  // ------------------------------------------------ o perfil e o documento
  await pagina.goto(`${BASE_WEB}/#admin/atletas/${athleteId}`, { waitUntil: 'networkidle' });
  await esperar(1100);

  const perfil = await pagina.evaluate(() => document.body.innerText);
  conferir('o perfil administrativo abre', /Atleta QA de Responsividade/.test(perfil),
    perfil.slice(0, 140).replace(/\n/g, ' | '));
  conferir('o perfil mostra o CPF MASCARADO por padrão',
    /\*\*\*\.\d{3}\.\d{3}-\*\*/.test(perfil),
    perfil.slice(0, 200).replace(/\n/g, ' | '));
  conferir('o CPF inteiro NÃO está na tela antes de alguém pedir',
    !new RegExp(CPF_DO_ATLETA_FORMATADO.replace(/\./g, '\\.')).test(perfil));

  // SÓ A AÇÃO QUE CABE NO ESTADO. Atleta ativo não tem "Reativar".
  conferir('atleta ativo não oferece Reativar',
    !(await pagina.$('button:has-text("Reativar")')));
  conferir('atleta ativo oferece Suspender e Arquivar',
    Boolean(await pagina.$('button:has-text("Suspender")')) && Boolean(await pagina.$('button:has-text("Arquivar")')));

  await pagina.click('button.chip:has-text("Cadastro")');
  await esperar(500);

  const botaoRevelar = await pagina.$('button:has-text("Ver CPF completo")');
  conferir('o perfil oferece pedir o CPF inteiro', Boolean(botaoRevelar));
  if (botaoRevelar) {
    await botaoRevelar.click();
    await esperar(1200);
    const revelado = await pagina.evaluate(() => document.body.innerText);
    conferir('o servidor devolve o CPF inteiro a quem pode',
      revelado.includes(CPF_DO_ATLETA_FORMATADO),
      revelado.slice(0, 200).replace(/\n/g, ' | '));
    conferir('a tela avisa que a consulta ficou registrada na auditoria',
      /registrada na auditoria/i.test(revelado));
  }

  // A ABA DO HISTÓRICO IMPORTADO abre e diz o estado em vez de ficar em branco.
  await pagina.click('button.chip:has-text("Histórico importado")');
  await esperar(1200);
  const importado = await pagina.evaluate(() => document.body.innerText);
  conferir('a aba de histórico importado abre',
    /Já vinculado a este atleta/.test(importado) && /Históricos que podem ser deste atleta/.test(importado),
    importado.slice(0, 160).replace(/\n/g, ' | '));
  conferir('sem candidatos, a tela diz que não há — não fica em branco',
    /Nenhum histórico candidato/.test(importado) || /Vincular a este atleta/.test(importado));

  // ------------------------------------------- o layout nas doze larguras
  for (const rota of [`admin/atletas`, `admin/atletas/${athleteId}`, 'admin/mensagens']) {
    const rotulo = rota.startsWith('admin/atletas/') ? 'Perfil do atleta' : (rota === 'admin/atletas' ? 'Lista de atletas' : 'Mensagens');
    console.log(`\n--- ${rotulo} (larguras) ---`);
    for (const largura of LARGURAS) {
      const m = await medirTela(pagina, rota, largura);
      conferir(`${rotulo} @ ${largura}px — sem overflow horizontal`, !m.overflowDoc,
        m.overflowDoc ? `scrollWidth ${m.scrollWidth} > viewport ${m.viewport}` : '');
      conferir(`${rotulo} @ ${largura}px — nenhum elemento fora da viewport`,
        m.estourando.length === 0, m.estourando.join(', '));
      if (LARGURAS_DE_TOQUE.has(largura)) {
        conferir(`${rotulo} @ ${largura}px — alvos de toque >= ${ALVO_MINIMO}px`,
          m.pequenos.length === 0, m.pequenos.join(', '));
      }
    }
  }

  // ------------------------------------------- o recado da federação
  console.log('\n--- Mensagem de abertura (fluxo real) ---');

  await pagina.setViewportSize({ width: 1440, height: 900 });
  await pagina.goto(`${BASE_WEB}/#admin/mensagens`, { waitUntil: 'networkidle' });
  await esperar(900);

  const botaoNova = await pagina.$('button:has-text("Nova mensagem")');
  conferir('a tela de mensagens abre para o operador', Boolean(botaoNova));

  const TITULO_DO_RECADO = 'Inscrições abertas para a etapa QA';
  const TEXTO_DO_RECADO = 'A etapa QA está com inscrições abertas até o fim do mês.';

  if (botaoNova) {
    await botaoNova.click();
    await esperar(600);
    await pagina.fill('[role="dialog"] input[type="text"]', TITULO_DO_RECADO);
    await pagina.fill('[role="dialog"] textarea', TEXTO_DO_RECADO);
    await pagina.click('[role="dialog"] button:has-text("Publicar")');
    await esperar(1500);

    const listaDeRecados = await pagina.evaluate(() => document.body.innerText);
    conferir('o recado publicado aparece na lista', listaDeRecados.includes(TITULO_DO_RECADO),
      listaDeRecados.slice(0, 160).replace(/\n/g, ' | '));
    // `innerText` devolve o texto JÁ transformado pelo CSS, e os selos são
    // `text-transform: uppercase`. Comparar sem ignorar caixa foi o que fez
    // esta asserção reprovar da primeira vez — contra uma tela correta.
    conferir('a lista diz que o recado está no ar e é de uma vez só',
      /no ar/i.test(listaDeRecados) && /uma vez por pessoa/i.test(listaDeRecados));
    conferir('a lista mostra a contagem de leituras', /0 leitura/.test(listaDeRecados));
  }

  // AGORA O ATLETA.
  //
  // O `reload()` NÃO é cerimônia: `goto` para o mesmo documento com outro hash
  // é navegação de mesma página — o React não remonta, e o componente do
  // recado continua com a lista que buscou quando a aplicação abriu, ainda
  // vazia. Foi exatamente assim que este trecho reprovou da primeira vez,
  // contra um backend que estava certo.
  //
  // E a correção não é só do gate: o recado É uma mensagem de ABERTURA. Ele é
  // buscado quando a aplicação abre, e quem já está com ela aberta o recebe na
  // próxima vez que abrir. Recarregar é, portanto, exatamente o gesto que se
  // quer medir.
  await paginaAtleta.setViewportSize({ width: 390, height: 844 });
  await paginaAtleta.goto(`${BASE_WEB}/#meu-painel`, { waitUntil: 'networkidle' });
  await paginaAtleta.reload({ waitUntil: 'networkidle' });
  await esperar(1800);

  const dialogoDoRecado = await paginaAtleta.$('[role="dialog"]');

  // DIAGNÓSTICO SÓ QUANDO REPROVA. "Não apareceu" tem pelo menos quatro causas
  // distintas — sessão sem cadastro de atleta, servidor sem recado, recado
  // fora da janela, componente não montado —, e distingui-las depois exige
  // subir a pilha inteira de novo. Estas seis linhas dizem qual foi, na hora,
  // e foi por elas que se soube que o backend estava certo e a navegação é que
  // não remontava a aplicação.
  if (!dialogoDoRecado) {
    const diagnostico = await paginaAtleta.evaluate(async (BASE_API_NO_NAVEGADOR) => {
      const token = localStorage.getItem('mci-auth-token');
      const chaves = Object.keys(localStorage);
      let sessao;
      let recados;
      try {
        const r = await fetch(`${BASE_API_NO_NAVEGADOR}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        sessao = await r.json();
      } catch (e) { sessao = { erro: String(e) }; }
      try {
        const r = await fetch(`${BASE_API_NO_NAVEGADOR}/me/notices`, { headers: { Authorization: `Bearer ${token}` } });
        recados = await r.json();
      } catch (e) { recados = { erro: String(e) }; }
      return {
        chaves, temToken: Boolean(token), sessao, recados,
        camadas: document.querySelectorAll('.modal-layer').length,
        raiz: document.getElementById('root') ? 'ok' : 'sem root',
        texto: (document.body.innerText || '').slice(0, 200)
      };
    }, BASE_API);
    console.log(`  [diagnóstico] camadas=${diagnostico.camadas} raiz=${diagnostico.raiz} athleteId=${diagnostico.sessao?.user?.athleteId} recados=${diagnostico.recados?.items?.length} deveExibir=${diagnostico.recados?.items?.[0]?.deveExibir}`);
    console.log(`  [diagnóstico] texto=${JSON.stringify(diagnostico.texto)}`);
    console.log(`  [diagnóstico] 401 vistos: ${[...naoAutorizadas].join(' · ') || 'nenhum'}`);
  }
  conferir('o recado aparece por cima da tela do atleta', Boolean(dialogoDoRecado));

  if (dialogoDoRecado) {
    const textoDoRecado = await dialogoDoRecado.innerText();
    // O remetente é comparado SEM CAIXA: `innerText` devolve o texto já
    // transformado pelo CSS, e a linha do remetente é `text-transform:
    // uppercase`. Foi a segunda vez que esta armadilha reprovou uma tela
    // correta neste gate.
    conferir('o recado traz título, remetente e texto',
      textoDoRecado.includes(TITULO_DO_RECADO) && /federação qa/i.test(textoDoRecado) && textoDoRecado.includes(TEXTO_DO_RECADO),
      textoDoRecado.slice(0, 160).replace(/\n/g, ' | '));

    // O MODAL PRECISA CABER NO TELEFONE. Um recado cortado é um recado não
    // comunicado, e o registro de leitura diria o contrário.
    const cabe = await paginaAtleta.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const r = dlg.getBoundingClientRect();
      return { dentro: r.left >= -1 && r.right <= window.innerWidth + 1, doc: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    conferir('o recado cabe em 390px', cabe.dentro && !cabe.doc);

    await paginaAtleta.click('[role="dialog"] .button-primary');
    await esperar(1200);
    conferir('fechar o recado tira o modal da tela', !(await paginaAtleta.$('[role="dialog"]')));

    // A SEGUNDA VISITA. É aqui que `showOnce` deixa de ser promessa: a
    // aplicação é remontada do zero, o servidor é consultado de novo, e o
    // recado lido não volta.
    await paginaAtleta.reload({ waitUntil: 'networkidle' });
    await esperar(1800);
    conferir('o recado já lido NÃO volta na visita seguinte',
      !(await paginaAtleta.$('[role="dialog"]')));
  }

  await paginaAtleta.setViewportSize({ width: 1440, height: 900 });

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

  // ------------------------------------------------------------------------
  // FASE 13.18 — MOVIMENTO REDUZIDO.
  //
  // `prefers-reduced-motion: reduce` não é preferência estética: quem tem
  // enxaqueca vestibular passa mal com movimento na tela. A regra existe no
  // CSS, mas regra escrita não é regra aplicada — basta uma animação declarada
  // com `!important` depois dela, ou um efeito feito em JavaScript, para que a
  // preferência deixe de valer sem que nada acuse.
  //
  // Aqui a preferência é EMULADA no navegador e o que se mede é o estilo
  // COMPUTADO de cada elemento animado, que é o que o usuário recebe.
  // ------------------------------------------------------------------------
  console.log('\n--- Movimento reduzido (prefers-reduced-motion) ---');

  const medirMovimento = async () => pagina.evaluate(() => {
    const emMs = valor => {
      const n = parseFloat(valor || '0');
      return valor && valor.includes('ms') ? n : n * 1000;
    };
    const moventes = [];
    for (const elemento of document.querySelectorAll('*')) {
      const estilo = getComputedStyle(elemento);
      const animacao = Math.max(...estilo.animationDuration.split(',').map(emMs), 0);
      const transicao = Math.max(...estilo.transitionDuration.split(',').map(emMs), 0);
      if (animacao > 1 || transicao > 1) {
        moventes.push({
          alvo: `${elemento.tagName.toLowerCase()}${elemento.className && typeof elemento.className === 'string' ? `.${elemento.className.trim().split(/\s+/)[0]}` : ''}`,
          animacao, transicao
        });
      }
    }
    return {
      moventes: moventes.slice(0, 12),
      quantos: moventes.length,
      rolagem: getComputedStyle(document.documentElement).scrollBehavior,
      texto: (document.body.textContent || '').trim().length
    };
  });

  const TELAS_DO_MOVIMENTO = ['admin/overall', 'ranking', 'campeonatos', 'admin'];

  // Primeiro SEM a preferência: se nada se move nem aqui, a medição seguinte
  // não prova nada — é o controle que impede um falso APROVADO.
  await pagina.emulateMedia({ reducedMotion: 'no-preference' });
  let comMovimento = 0;
  for (const rota of TELAS_DO_MOVIMENTO) {
    await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
    await esperar(150);
    comMovimento += (await medirMovimento()).quantos;
  }
  conferir('controle: com movimento permitido, há movimento na tela', comMovimento > 0, `${comMovimento} elementos`);

  await pagina.emulateMedia({ reducedMotion: 'reduce' });
  for (const rota of TELAS_DO_MOVIMENTO) {
    await pagina.goto(`${BASE_WEB}/#${rota}`, { waitUntil: 'networkidle' });
    await esperar(150);
    const m = await medirMovimento();

    conferir(
      `${rota} — nenhuma animação ou transição sobrevive ao movimento reduzido`,
      m.quantos === 0,
      m.moventes.map(x => `${x.alvo} anim ${x.animacao}ms trans ${x.transicao}ms`).join(', ')
    );
    conferir(`${rota} — rolagem deixa de ser suave`, m.rolagem === 'auto', m.rolagem);
    // A preferência tira o movimento, não o conteúdo.
    conferir(`${rota} — a tela continua mostrando conteúdo`, m.texto > 50, `${m.texto} caracteres`);
  }

  await pagina.emulateMedia({ reducedMotion: 'no-preference' });

  conferir('nenhum erro de página nem resposta 5xx', erros.size === 0, [...erros].join(' · '));
  // `/auth/me` responde 401 quando NÃO há token — é o caminho normal de quem
  // ainda não entrou, e o contexto de operador começa assim. O que não pode
  // acontecer é 401 em rota de dados, que significa sessão recusada no meio
  // do uso.
  const autenticadasRecusadas = [...naoAutorizadas].filter(u => !u.includes('/auth/'));
  conferir('nenhuma rota de dados recusou a sessão com 401',
    autenticadasRecusadas.length === 0, autenticadasRecusadas.join(' · '));

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

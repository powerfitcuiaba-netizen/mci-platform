#!/usr/bin/env node
// ============================================================================
// GATE E2E — O AUTOCADASTRO CONCLUI SOZINHO, E A TELA DO AUTOCADASTRO CABE.
//
// POR QUE ESTE GATE EXISTE, separado do gate visual da FASE 9.
//
// 1. A REGRA MUDOU, e o teste de unidade não pode provar a parte que importa.
//    Ele prova que o serviço devolve `conciliacao.estado`. Não prova que
//    NINGUÉM APERTOU NADA — porque num teste de unidade não há ninguém para
//    apertar. Aqui a fila do operador é aberta DE VERDADE, num navegador, e o
//    que se cobra é que ela esteja VAZIA depois de o atleta se cadastrar.
//
// 2. A TELA `minha-solicitacao` NUNCA FOI MEDIDA. O gate visual mede
//    `minha-filiacao`, `meu-historico` e `ranking` — e a tela do autocadastro
//    ficou de fora desde que existe. Ela é a PRIMEIRA que um atleta novo abre,
//    e é a única com formulário longo: o pior candidato possível a ficar sem
//    medição de largura.
//
// O QUE ESTE GATE SABE DIZER NÃO:
//   · o cadastro não concluir sozinho;
//   · o histórico não ser vinculado quando o CPF confere;
//   · alguém aparecer como revisor;
//   · a fila do operador receber o pedido do caminho normal;
//   · a recusa por colisão devolver frase genérica em vez de instrução;
//   · a tela estourar a largura, ou ter alvo de toque pequeno num telefone.
//
// Dados FICTÍCIOS, em banco de QA dedicado e descartável, recriado a cada
// execução. Nada aqui toca produção.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4601));
const PORTA_WEB = Number(arg('porta-web', 5601));
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = arg('chromium', env.PLAYWRIGHT_CHROMIUM || undefined);
const DATABASE_URL = arg('db', env.QA_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_qa_auto?schema=public');
const MANTER = argv.includes('--manter');

// As mesmas quinze larguras do gate visual. A união é de propósito: trocar uma
// lista medida por outra perde cobertura em silêncio.
const LARGURAS = [320, 375, 390, 414, 430, 560, 768, 820, 1024, 1180, 1280, 1366, 1440, 1600, 1920];
const LARGURAS_DE_TOQUE = new Set([320, 375, 390, 414, 430]);
const ALVO_MINIMO = 40;
const SENHA = 'senha-de-qa-123';

// A ENTIDADE OFICIAL DO CAMPEONATO, literal. O gate compara o texto da tela com
// esta constante: um caractere fora já é outro nome, e o atleta precisa
// reconhecer a entidade à qual ele é filiado.
const NOME_OFICIAL = 'NPC - National Physique Committe';
const CODIGO_OFICIAL = 'NPC';

const problemas = [];
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  if (!passou) problemas.push(`${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
};

const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* subindo */ }
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

// CPF sintético válido — dado de QA, e só de QA.
function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const d1cru = (base.reduce((t, n, i) => t + n * (10 - i), 0) * 10) % 11;
  const d1 = d1cru === 10 ? 0 : d1cru;
  const comD1 = base.concat([d1]);
  const d2cru = (comD1.reduce((t, n, i) => t + n * (11 - i), 0) * 10) % 11;
  const d2 = d2cru === 10 ? 0 : d2cru;
  return base.join('') + d1 + d2;
}

// Três pessoas, três desfechos — os três que a tela precisa saber contar.
const CPF_COM_HISTORICO = cpfDeQa(321456789);   // o arquivo tem este CPF
const CPF_SEM_HISTORICO = cpfDeQa(321456788);   // não está em lugar nenhum
const CPF_DIVERGENTE = cpfDeQa(321456787);      // matrícula igual, CPF outro
const MATRICULA_AMBIGUA = 'QA-AMB-1';

const conta = sufixo => ({
  name: `QA ${sufixo}`,
  email: `qa.${sufixo}.${Date.now().toString(36)}@mci.local`,
  password: SENHA,
  birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

// --------------------------------------------------------------- semeadura

async function semear() {
  const admin = await chamar('/auth/register', { metodo: 'POST', corpo: conta('admin') });
  execSync(
    `psql "${DATABASE_URL.replace(/\?.*$/, '')}" -c "update \\"User\\" set role='SUPER_ADMIN' where id='${admin.user.id}'"`,
    { stdio: 'pipe' }
  );
  const tokenAdmin = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: admin.user.email, password: SENHA } })).token;

  const org = await chamar('/organizations', {
    metodo: 'POST', token: tokenAdmin,
    corpo: { name: 'Federação QA Autocadastro', slug: `qa-auto-${Date.now().toString(36)}`, state: 'MT' }
  });

  // A PORTA E A ENTIDADE OFICIAL VÊM DO PROVISIONAMENTO REAL DO DEPLOY.
  //
  // Em produção o autocadastro nasce FECHADO — é o padrão da coluna, e abrir é
  // ato administrativo com auditoria. Foi exatamente esse estado que deixou o
  // campo "Entidade de filiação" vazio na tela, e por isso o gate deixou de
  // abrir a porta por conta própria: ele roda o MESMO script que o
  // `preDeployCommand` roda, com a MESMA variável, contra este banco de QA.
  //
  // Assim o gate mede a cadeia inteira — provisionamento, banco, endpoint,
  // frontend — em vez de semear o estado final e medir só a tela. Se o
  // provisionamento parar de funcionar, o gate cai aqui.
  console.log('  provisionando a entidade oficial pelo script do deploy…');
  execSync('node scripts/provisionar-contas-de-servico.js', {
    stdio: 'pipe',
    env: { ...env, DATABASE_URL, MCI_NPC_ORGANIZATION_ID: org.id, PROVISIONAR_ADMIN_EMAIL: admin.user.email }
  });

  const diretor = await chamar('/auth/register', { metodo: 'POST', corpo: conta('diretor') });
  for (const role of ['EVENT_DIRECTOR', 'RANKING_MANAGER']) {
    await chamar(`/organizations/${org.id}/members`, {
      metodo: 'POST', token: tokenAdmin, corpo: { userId: diretor.user.id, role }
    });
  }
  const tokenDiretor = (await chamar('/auth/login', { metodo: 'POST', corpo: { email: diretor.user.email, password: SENHA } })).token;

  // A ENTIDADE OFICIAL, LIDA DE VOLTA DA VITRINE PÚBLICA — a mesma rota que a
  // tela do atleta consome. Ler daqui, e não de um INSERT de fixture, é o que
  // torna o gate capaz de reprovar um endpoint quebrado.
  const vitrine = await chamar('/public/affiliations');
  const filiacao = (vitrine.items || []).find(f => f.code === CODIGO_OFICIAL);
  conferir(
    `a vitrine pública devolve a entidade oficial (code ${CODIGO_OFICIAL})`,
    Boolean(filiacao),
    filiacao ? '' : `recebido: ${JSON.stringify(vitrine).slice(0, 200)}`
  );
  if (!filiacao) throw new Error('sem entidade oficial na vitrine: o resto do gate mediria outra coisa');
  conferir(
    'e com o NOME OFICIAL exato',
    filiacao.name === NOME_OFICIAL,
    `recebido: ${JSON.stringify(filiacao.name)}`
  );
  conferir('kind ENTITY', filiacao.kind === 'ENTITY', `recebido: ${filiacao.kind}`);

  const temporada = await chamar('/seasons', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'Temporada QA 2026', year: 2026 }
  });
  await chamar(`/seasons/${temporada.id}/points-rules`, {
    metodo: 'PUT', token: tokenDiretor,
    corpo: { rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }] }
  });

  const evento = await chamar('/events', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, name: 'Etapa QA do Autocadastro',
      slug: `qa-auto-ev-${Date.now().toString(36)}`,
      startDate: '2026-11-20T12:00:00.000Z', city: 'Cuiabá', state: 'MT', seasonId: temporada.id
    }
  });

  // O HISTÓRICO QUE PRECEDE O CADASTRO — que é o ponto da regra nova.
  // Duas linhas com o CPF de quem ainda não tem conta, e uma terceira com a
  // matrícula ambígua e um CPF DIFERENTE, para o desfecho "precisa confirmar".
  const cabecalho = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,evento';
  const linhas = [
    `QA-1,${CPF_COM_HISTORICO},MARIANA QA,${CODIGO_OFICIAL},QA-777,BIKINI,Women's Bikini - Open Class A,1,Etapa QA do Autocadastro`,
    `QA-2,${CPF_COM_HISTORICO},MARIANA QA,${CODIGO_OFICIAL},QA-777,BIKINI,Women's Bikini - Open Class A,2,Etapa QA do Autocadastro`,
    `QA-3,${CPF_DIVERGENTE},OUTRA PESSOA QA,${CODIGO_OFICIAL},${MATRICULA_AMBIGUA},BIKINI,Women's Bikini - Open Class A,3,Etapa QA do Autocadastro`
  ];
  const lote = await chamar('/musclewar/imports', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, seasonId: temporada.id, eventId: evento.id,
      sourceType: 'CSV', sourceRef: 'qa-autocadastro.csv',
      content: [cabecalho, ...linhas].join('\n')
    }
  });
  await chamar(`/musclewar/imports/${lote.import.id}/apply`, { metodo: 'POST', token: tokenDiretor, corpo: {} });

  return { orgId: org.id, filiacaoId: filiacao.id, emailDiretor: diretor.user.email, tokenDiretor };
}

// ------------------------------------------------------------------ medida

async function medirLargura(pagina, largura) {
  await pagina.setViewportSize({ width: largura, height: 900 });
  await esperar(350);
  return pagina.evaluate((alvoMinimo) => {
    const larguraViewport = window.innerWidth;
    const estourando = [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (r.right <= larguraViewport + 1) return false;
      // `overflow-x: auto` é solução, não defeito — e vale para a subárvore.
      for (let pai = el; pai && pai !== document.body; pai = pai.parentElement) {
        const o = getComputedStyle(pai).overflowX;
        if (o === 'auto' || o === 'scroll') return false;
      }
      return true;
    }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`);

    // O DIAGNÓSTICO PRECISA NOMEAR O ELEMENTO. A primeira versão imprimia
    // só `input:` — tag sem texto, que não diz qual campo é e obriga a
    // adivinhar. Um gate que reprova sem dizer o quê é um gate que se aprende
    // a ignorar.
    // `label.button` ENTRA NA LISTA, e é consequência direta do descarte
    // acima: quando o input de arquivo é escondido atrás de um rótulo
    // estilizado, quem recebe o dedo é o RÓTULO. Descartar o input sem medir
    // o rótulo deixaria o alvo de toque real sem gate nenhum — a exclusão
    // teria criado um ponto cego em vez de corrigir um falso positivo.
    const pequenos = [...document.querySelectorAll('button, a[href], [role="button"], input, select, label.button')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        // Elemento escondido por acessibilidade (input de arquivo sob rótulo
        // estilizado) não é alvo de toque: quem recebe o dedo é o rótulo.
        const est = getComputedStyle(el);
        if (est.visibility === 'hidden' || est.opacity === '0' || est.position === 'absolute' && r.width <= 1) return false;
        return r.height < alvoMinimo;
      })
      .slice(0, 5)
      .map(el => {
        const r = el.getBoundingClientRect();
        const rotulo = el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.textContent || '';
        return `${el.tagName.toLowerCase()}[type=${el.type || '-'} id=${el.id || '-'} class=${String(el.className || '-').split(' ')[0]}]`
          + `"${rotulo.trim().slice(0, 24)}" h=${Math.round(r.height)}`;
      });

    // O QUE O CRITÉRIO DESCARTOU, declarado em vez de sumido.
    //
    // A exclusão de elemento escondido foi acrescentada DEPOIS de o gate
    // reprovar — e mudar o critério até a falha sumir é a pior coisa que se
    // pode fazer com um gate. Então o que foi descartado é impresso: quem
    // lê o relatório vê o elemento, a altura e por que ele não conta, e pode
    // discordar. Se um campo de verdade aparecer nesta lista, é defeito.
    const descartados = [...document.querySelectorAll('input, select, button')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.height >= alvoMinimo) return false;
        const est = getComputedStyle(el);
        return est.visibility === 'hidden' || est.opacity === '0'
          || (est.position === 'absolute' && r.width <= 1);
      })
      .slice(0, 5)
      .map(el => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}[type=${el.type || '-'} id=${el.id || '-'}] h=${Math.round(r.height)} w=${Math.round(r.width)}`;
      });

    return {
      overflowDoc: document.documentElement.scrollWidth > larguraViewport + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: larguraViewport,
      estourando, pequenos, descartados,
      texto: document.body.innerText || ''
    };
  }, ALVO_MINIMO);
}

// Cria conta, entra e abre o autocadastro. Contexto NOVO a cada pessoa: a
// sessão também vive no estado do React, e limpar o localStorage não basta —
// a aplicação redireciona quem já está autenticado e o formulário de login
// nunca aparece.
async function entrarComoNovaPessoa(navegador, sufixo, erros) {
  const dados = conta(sufixo);
  await chamar('/auth/register', { metodo: 'POST', corpo: dados });

  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const pagina = await contexto.newPage();
  pagina.on('pageerror', e => erros.add(String(e).slice(0, 160)));
  pagina.on('response', r => { if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 80)}`); });

  await pagina.goto(`${BASE_WEB}/#entrar`, { waitUntil: 'networkidle' });
  await pagina.fill('input[type="email"]', dados.email);
  await pagina.fill('input[type="password"]', SENHA);
  await pagina.click('button[type="submit"]');
  await esperar(1500);
  return { pagina, email: dados.email };
}

// OS CAMPOS SÃO ALCANÇADOS PELO RÓTULO, e não por `name` ou `id`.
//
// O formulário é montado por `<Field label=…>`, que não põe nenhum dos dois —
// e a primeira versão deste gate ficou 30s esperando `input[name="cpf"]` que
// nunca existiu. É o mesmo critério que os testes de unidade já usam
// (`getByLabelText`), e é o critério certo: se o rótulo mudar, o gate falha,
// que é exatamente o que se quer de uma tela que uma pessoa precisa entender.
const MATRICULA = /^Número de registro/i;

/**
 * A ENTIDADE NA TELA, conferida no navegador de verdade.
 *
 * É o sintoma que abriu esta fase: o campo aparecia vazio, com "Nenhuma
 * entidade de filiação ativa está disponível para a sua conta." As três
 * conferências abaixo são as três metades do defeito — a opção existir, o texto
 * ser o oficial, e a mensagem de impedimento ter ido embora.
 */
async function conferirEntidadeNaTela(pagina) {
  const seletor = pagina.getByLabel(/^Entidade de filiação/i);

  const opcoes = await seletor.evaluate(el =>
    [...el.options].map(o => ({ valor: o.value, texto: o.textContent.trim() })));
  const reais = opcoes.filter(o => o.valor);

  conferir('o select de entidade traz ao menos uma opção', reais.length >= 1,
    `opções: ${JSON.stringify(opcoes)}`);

  const oficial = reais.find(o => o.texto.startsWith(NOME_OFICIAL));
  conferir(`a opção mostra o texto exato "${NOME_OFICIAL}"`, Boolean(oficial),
    oficial ? '' : `textos: ${JSON.stringify(reais.map(o => o.texto))}`);

  // A PROVA NEGATIVA. A mensagem de impedimento é o sintoma original, e ela
  // precisa ter desaparecido da tela — não basta a opção existir ao lado dela.
  const corpo = await pagina.locator('body').innerText();
  conferir('a mensagem "Nenhuma entidade de filiação ativa" NÃO aparece',
    !/Nenhuma entidade de filia/i.test(corpo));

  return oficial;
}

async function preencher(pagina, { cpf, matricula }) {
  await pagina.goto(`${BASE_WEB}/#minha-solicitacao`, { waitUntil: 'networkidle' });
  await esperar(900);
  await pagina.getByLabel(/^CPF/i).fill(cpf);
  await pagina.getByLabel(/^Categoria de competição/i).selectOption('FEMALE');
  await esperar(500);

  // A ENTIDADE É SELECIONADA EXPLICITAMENTE, pelo valor que veio do endpoint.
  //
  // A versão anterior confiava em ela vir pré-selecionada por ser a única. Isso
  // media a conveniência, e não a escolha: com duas entidades na vitrine o gate
  // passaria sem que ninguém tivesse selecionado nada.
  const oficial = await conferirEntidadeNaTela(pagina);
  if (oficial) await pagina.getByLabel(/^Entidade de filiação/i).selectOption(oficial.valor);

  await pagina.getByLabel(MATRICULA).fill(matricula);
  await esperar(200);
}

// -------------------------------------------------------------------- main

console.log('\n=== GATE E2E — AUTOCADASTRO AUTOMÁTICO ===\n');

try {
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
      LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'qa-autocadastro-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-auto-storage',
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
  const semeado = await semear();

  console.log('construindo e servindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'], {
    cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env
  });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB, 60)) throw new Error('preview do frontend não subiu');
  console.log('frontend no ar.\n');

  if (MANTER) {
    console.log(`  Web ${BASE_WEB}   API ${BASE_API}`);
    console.log(`  OPERADOR: ${semeado.emailDiretor} / ${SENHA}`);
    console.log('  Crie uma conta e abra "Minha solicitação". Ctrl+C encerra.\n');
    await new Promise(() => {});
  }

  // `createRequire`, e não `import()`: o Playwright é CommonJS, e o namespace
  // ESM de um CJS resolvido por caminho absoluto não expõe `chromium` como
  // export nomeado — vem `undefined`, e o erro só aparece no `.launch`.
  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  const { chromium } = exigir(CAMINHO_PLAYWRIGHT);
  const navegador = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const erros = new Set();

  // ====================================================================
  // 1. O CAMINHO NORMAL — cadastro com histórico, sem ninguém aprovar.
  // ====================================================================
  console.log('--- Cadastro com histórico (o caminho que a regra mudou) ---');

  const { pagina } = await entrarComoNovaPessoa(navegador, 'mariana', erros);
  await preencher(pagina, { cpf: CPF_COM_HISTORICO, matricula: 'QA-777' });

  // A tela ANTES do envio: é aqui que o texto do botão importa.
  const antes = await pagina.evaluate(() => document.body.innerText);
  conferir('o botão fala em CONCLUIR, e não em enviar para análise',
    /concluir cadastro/i.test(antes) && !/enviar para an[áa]lise/i.test(antes),
    (antes.match(/enviar para an[áa]lise/i) || [''])[0]);

  await pagina.click('button[type="submit"]');
  await esperar(2500);

  const depois = await pagina.evaluate(() => document.body.innerText);
  conferir('a tela diz que o cadastro foi realizado', /cadastro realizado/i.test(depois),
    depois.slice(0, 160).replace(/\n/g, ' | '));
  conferir('a tela diz que o histórico foi vinculado automaticamente',
    /hist[óo]rico/i.test(depois) && /vinculamos/i.test(depois),
    depois.slice(0, 200).replace(/\n/g, ' | '));
  // O QUE NÃO PODE APARECER: qualquer promessa de análise futura.
  conferir('a tela NÃO manda esperar análise de ninguém',
    !/aguardando an[áa]lise|vai analisar|em an[áa]lise/i.test(depois),
    (depois.match(/aguardando an[áa]lise|vai analisar|em an[áa]lise/i) || [''])[0]);

  // O PERFIL ESTÁ ATIVO NA HORA — medido na tela do próprio atleta.
  await pagina.goto(`${BASE_WEB}/#meu-historico`, { waitUntil: 'networkidle' });
  await esperar(1500);
  const historico = await pagina.evaluate(() => document.body.innerText);
  conferir('o histórico do atleta já mostra a participação importada',
    /Etapa QA do Autocadastro/i.test(historico),
    historico.slice(0, 200).replace(/\n/g, ' | '));

  // ====================================================================
  // 2. A PROVA NEGATIVA — a fila do operador está VAZIA.
  //
  // É o item que nenhum teste de unidade alcança: lá não existe ninguém
  // para aprovar, então "não houve aprovação humana" é verdade por
  // construção. Aqui a fila é aberta de verdade, por um operador de
  // verdade, e o que se cobra é que o pedido NÃO esteja lá.
  // ====================================================================
  console.log('\n--- A fila do operador (prova negativa) ---');

  const contextoOperador = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const paginaOperador = await contextoOperador.newPage();
  paginaOperador.on('pageerror', e => erros.add(String(e).slice(0, 160)));
  paginaOperador.on('response', r => { if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 80)}`); });

  await paginaOperador.goto(`${BASE_WEB}/#entrar`, { waitUntil: 'networkidle' });
  await paginaOperador.fill('input[type="email"]', semeado.emailDiretor);
  await paginaOperador.fill('input[type="password"]', SENHA);
  await paginaOperador.click('button[type="submit"]');
  await esperar(1500);

  await paginaOperador.goto(`${BASE_WEB}/#admin/solicitacoes`, { waitUntil: 'networkidle' });
  await esperar(1500);
  const fila = await paginaOperador.evaluate(() => document.body.innerText);
  conferir('a tela da fila abre para o operador', !/n[ãa]o encontrad|403|sem permiss/i.test(fila),
    fila.slice(0, 120).replace(/\n/g, ' | '));
  conferir('NENHUMA aprovação humana: a pessoa que se cadastrou não está na fila',
    !/QA mariana/i.test(fila),
    fila.slice(0, 200).replace(/\n/g, ' | '));

  // E a conferência pela API, que é a autoridade: zero pedidos PENDING.
  const pendentes = await chamar(`/athlete-requests?organizationId=${semeado.orgId}&status=PENDING`,
    { token: semeado.tokenDiretor });
  conferir('a API confirma: nenhum pedido pendente no caminho normal',
    (pendentes.items || []).length === 0, `${(pendentes.items || []).length} pendente(s)`);

  // ====================================================================
  // 3. SEM HISTÓRICO — o cadastro sai, e a frase não inventa pendência.
  // ====================================================================
  console.log('\n--- Cadastro sem histórico ---');

  const semHist = await entrarComoNovaPessoa(navegador, 'semhistorico', erros);
  await preencher(semHist.pagina, { cpf: CPF_SEM_HISTORICO, matricula: 'QA-888' });
  await semHist.pagina.click('button[type="submit"]');
  await esperar(2500);
  const textoSemHist = await semHist.pagina.evaluate(() => document.body.innerText);
  conferir('diz que o cadastro foi realizado', /cadastro realizado/i.test(textoSemHist),
    textoSemHist.slice(0, 160).replace(/\n/g, ' | '));
  conferir('diz que o perfil está ATIVO, sem prometer análise',
    /ativo/i.test(textoSemHist) && !/aguard|an[áa]lise/i.test(textoSemHist),
    textoSemHist.slice(0, 200).replace(/\n/g, ' | '));

  // ====================================================================
  // 4. AMBIGUIDADE — o arquivo afirma outro CPF para a mesma matrícula.
  //    O cadastro SAI; o histórico NÃO é vinculado; a federação confirma.
  // ====================================================================
  console.log('\n--- Cadastro com histórico ambíguo ---');

  const ambigua = await entrarComoNovaPessoa(navegador, 'ambigua', erros);
  await preencher(ambigua.pagina, { cpf: cpfDeQa(321456700), matricula: MATRICULA_AMBIGUA });
  await ambigua.pagina.click('button[type="submit"]');
  await esperar(2500);
  const textoAmbigua = await ambigua.pagina.evaluate(() => document.body.innerText);
  conferir('o cadastro sai mesmo com histórico duvidoso', /cadastro realizado/i.test(textoAmbigua),
    textoAmbigua.slice(0, 160).replace(/\n/g, ' | '));
  conferir('a tela diz que a federação precisa confirmar',
    /confirmar/i.test(textoAmbigua) && /federa[çc]/i.test(textoAmbigua),
    textoAmbigua.slice(0, 220).replace(/\n/g, ' | '));

  // ====================================================================
  // 5. COLISÃO — o mesmo CPF de novo. A frase tem de dizer O QUE FAZER.
  // ====================================================================
  console.log('\n--- Cadastro que colide com identidade já existente ---');

  const colidente = await entrarComoNovaPessoa(navegador, 'colidente', erros);
  await preencher(colidente.pagina, { cpf: CPF_COM_HISTORICO, matricula: 'QA-999' });
  await colidente.pagina.click('button[type="submit"]');
  await esperar(2500);
  const textoColisao = await colidente.pagina.evaluate(() => document.body.innerText);
  conferir('a recusa manda procurar a federação, e não uma frase genérica',
    /procure a sua federa[çc]/i.test(textoColisao),
    textoColisao.slice(0, 220).replace(/\n/g, ' | '));
  conferir('a recusa NÃO diz qual identificador colidiu',
    !/CPF j[áa] cadastrado|matr[íi]cula j[áa]|ALREADY_REGISTERED|NUMBER_IN_USE/i.test(textoColisao),
    (textoColisao.match(/ALREADY_REGISTERED|NUMBER_IN_USE/i) || [''])[0]);
  // O formulário FICA preenchido: tentar de novo com os mesmos dados bate no
  // mesmo lugar, e limpar apagaria o trabalho da pessoa sem lhe dar o que fazer.
  const matriculaMantida = await colidente.pagina.getByLabel(MATRICULA).inputValue().catch(() => '');
  conferir('o formulário não é limpo numa recusa que a pessoa não pode resolver sozinha',
    matriculaMantida === 'QA-999', `valor: "${matriculaMantida}"`);

  // ====================================================================
  // 6. RESPONSIVIDADE DA TELA DO AUTOCADASTRO — nunca medida até aqui.
  // ====================================================================
  console.log('\n--- Responsividade de "Minha solicitação" (formulário) ---');

  const paraMedir = await entrarComoNovaPessoa(navegador, 'layout', erros);
  await paraMedir.pagina.goto(`${BASE_WEB}/#minha-solicitacao`, { waitUntil: 'networkidle' });
  await esperar(900);

  for (const largura of LARGURAS) {
    const m = await medirLargura(paraMedir.pagina, largura);

    conferir(`Minha solicitação @ ${largura}px — sem overflow horizontal`, !m.overflowDoc,
      m.overflowDoc ? `scrollWidth ${m.scrollWidth} > viewport ${m.viewport}` : '');
    conferir(`Minha solicitação @ ${largura}px — nenhum elemento fora da viewport`,
      m.estourando.length === 0, m.estourando.join(', '));
    if (LARGURAS_DE_TOQUE.has(largura)) {
      conferir(`Minha solicitação @ ${largura}px — alvos de toque >= ${ALVO_MINIMO}px`,
        m.pequenos.length === 0, m.pequenos.join(', '));
      if (m.descartados.length) {
        console.log(`          (descartados por estarem escondidos: ${m.descartados.join(', ')})`);
      }
    }
    if (largura === 1440) {
      conferir('Minha solicitação — o formulário carregou de fato',
        /CPF/i.test(m.texto) && /concluir cadastro/i.test(m.texto),
        m.texto.slice(0, 200).replace(/\n/g, ' | '));
    }
  }

  conferir('nenhum erro de página e nenhuma resposta 5xx', erros.size === 0, [...erros].slice(0, 4).join(' | '));

  await navegador.close();
} catch (erro) {
  problemas.push(`EXCEÇÃO: ${erro.message}`);
  console.error(`\nEXCEÇÃO: ${erro.stack}`);
} finally {
  encerrar();
}

console.log(`\n${'='.repeat(60)}`);
if (problemas.length) {
  console.log(`GATE REPROVADO — ${problemas.length} problema(s):\n`);
  for (const p of problemas) console.log(`  · ${p}`);
  process.exit(1);
}
console.log('GATE APROVADO — o autocadastro conclui sozinho e a tela cabe.');
process.exit(0);

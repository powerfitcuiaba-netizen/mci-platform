#!/usr/bin/env node
// ============================================================================
// CORRIGIR FILIAÇÃO, NUM NAVEGADOR DE VERDADE — O CASO REAL DO RAZOR.
//
// POR QUE ESTE ARREIO EXISTE
//
// A primeira versão desta funcionalidade passou em 18 testes de integração e
// NÃO atendia o caso real: o botão só aparecia em linha COM entidade, e a linha
// do Razor tem entidade NULA. Teste de integração não clica em botão — ele
// chama a rota. A condição de exibição vivia só no JSX, e ninguém a mediu.
//
// Este script mede o que a pessoa faz: entra, abre a revisão da importação,
// encontra a linha cuja ENTIDADE está vazia, clica no lápis, escolhe a entidade,
// digita a matrícula certa, valida, confirma — e confere na própria tela que os
// dois números aparecem, o da fonte e o corrigido.
//
// Ele sobe TUDO: PostgreSQL já existente, API, build do frontend, semeadura e
// Chromium. Nada é pedido ao operador além do banco.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/corrigir-filiacao-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
//
// A senha vem por variável de ambiente, nunca por argumento: argumento aparece
// em `ps` para qualquer usuário da máquina.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { entrar } from './entrar-na-plataforma.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4811));
const PORTA_WEB = Number(arg('porta-web', 5811));
const SAIDA = arg('saida', 'qa-corrigir-filiacao');
const MODULO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = env.CHROMIUM_PATH || null;
const SENHA = env.QA_PASSWORD;
const BANCO = env.DATABASE_URL;

if (!SENHA || !BANCO) {
  console.error('\n  Falta QA_PASSWORD e/ou DATABASE_URL no ambiente.\n');
  process.exit(1);
}

const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const EMAIL = 'qa.correcao@mci.local';

const processos = [];
const encerrar = () => processos.forEach(p => { try { p.kill('SIGTERM'); } catch { /* já morreu */ } });
process.on('exit', encerrar);
process.on('SIGINT', () => { encerrar(); process.exit(130); });

async function esperarPorta(url, tentativas = 90) {
  for (let i = 0; i < tentativas; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* ainda não subiu */ }
    await esperar(1000);
  }
  return false;
}

let token = null;
async function chamar(metodo, rota, corpo) {
  const r = await fetch(BASE_API + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await r.text();
  let dado; try { dado = texto ? JSON.parse(texto) : null; } catch { dado = texto; }
  return { status: r.status, dado };
}
const exigir = (r, oque) => {
  if (r.status >= 400) throw new Error(`${oque}: ${r.status} ${JSON.stringify(r.dado).slice(0, 300)}`);
  return r.dado;
};
// CPF válido pelo algoritmo, fictício por construção.
const cpfDeSemente = semente => {
  const n = String(semente).padStart(9, '0').slice(0, 9).split('').map(Number);
  const d = base => {
    let s = 0;
    for (let i = 0; i < base.length; i += 1) s += base[i] * (base.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = d(n);
  return [...n, d1, d([...n, d1])].join('');
};

const falhas = [];
const conferir = (condicao, oque) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${oque}`);
  if (!condicao) falhas.push(oque);
};

async function principal() {
  mkdirSync(SAIDA, { recursive: true });

  // ---------------------------------------------------------------- API
  console.log('subindo a API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1',
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-corrigir-filiacao-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_DIR: './uploads-qa-correcao',
      CORS_ORIGINS: `${BASE_WEB},http://localhost:${PORTA_WEB}`,
      RATE_LIMIT_ENABLED: 'false', TRUST_PROXY_HOPS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; });
  api.stderr.on('data', d => { saidaApi += d; });
  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/health`)) {
    throw new Error(`a API não subiu:\n${saidaApi.slice(-1500)}`);
  }

  // ------------------------------------------------------------ semeadura
  console.log('semeando o caso real do Razor…');
  try {
    execSync(`node scripts/criar-admin.js "QA Correcao" ${EMAIL}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch { console.log('  (administrador já existia)'); }

  token = exigir(await chamar('POST', '/auth/login', { email: EMAIL, password: SENHA }), 'login').token;

  const org = exigir(await chamar('POST', '/organizations',
    { name: `QA Correção ${Date.now()}`, slug: `qa-corr-${Date.now()}` }), 'organização');
  const npc = exigir(await chamar('POST', '/affiliations',
    { organizationId: org.id, name: 'NPC National Physique Committee', code: 'NPC' }), 'filiação NPC');
  const temporada = exigir(await chamar('POST', '/seasons',
    { organizationId: org.id, name: 'Temporada QA', year: 2026 }), 'temporada');
  exigir(await chamar('PUT', `/seasons/${temporada.id}/points-rules`, {
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  }), 'tabela de pontos');
  const evento = exigir(await chamar('POST', '/events', {
    organizationId: org.id, name: 'Razor', slug: `razor-${Date.now()}`,
    startDate: '2026-10-03T12:00:00.000Z', seasonId: temporada.id
  }), 'evento');
  exigir(await chamar('POST', '/athletes', {
    organizationId: org.id, fullName: 'Lucas Gouveia Lima', cpf: cpfDeSemente(293293293),
    sex: 'MALE', affiliationId: npc.id, affiliationNumber: '2932'
  }), 'atleta');

  // A LINHA DO RAZOR COMO ELA É: coluna de filiação VAZIA, matrícula 2952.
  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
  const LINHA = 'RAZOR-2952-MENS_BODYBUILDING,,Lucas Gouveia,,2952,MENS_BODYBUILDING,OPEN,1,,Razor,sim';
  const lote = exigir(await chamar('POST', '/musclewar/imports', {
    organizationId: org.id, seasonId: temporada.id, eventId: evento.id,
    sourceType: 'CSV', sourceRef: 'razor-qa.csv', content: `${CABECALHO}\n${LINHA}`
  }), 'importação');
  const importId = lote.import?.id ?? lote.id;
  exigir(await chamar('POST', `/musclewar/imports/${importId}/apply`), 'aplicar');

  const revisao = exigir(await chamar('GET', `/musclewar/imports/${importId}`), 'revisão');
  const linha = revisao.items[0];
  conferir(!linha.affiliationCode, 'a linha semeada tem ENTIDADE vazia');
  conferir(linha.memberNumber === '2952', 'e FILIAÇÃO 2952');
  conferir(linha.matchStatus === 'APPLIED', 'e STATUS APPLIED');
  conferir(!linha.athleteId, 'e nenhum dono');

  // ------------------------------------------------------------- frontend
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  // ------------------------------------------------------------- navegador
  console.log('abrindo o Chromium…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const pagina = await (await navegador.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  // ERRO DE CONSOLE É SINAL, MAS NEM TODO ERRO É DO PRODUTO.
  //
  // Esta máquina intercepta TLS com uma CA própria, e o Chromium não a conhece:
  // qualquer recurso externo (fonte, CDN) falha com ERR_CERT_AUTHORITY_INVALID.
  // Isso é do AMBIENTE, não da aplicação — e por isso o filtro guarda a ORIGEM
  // de cada falha em vez de só o texto: o que vem de 127.0.0.1 reprova, o que
  // vem de fora é registrado e contado à parte, sem mascarar nada.
  const erros = [];
  const falhasExternas = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');
  pagina.on('console', m => { if (m.type() === 'error' && daAplicacao(m.location()?.url)) erros.push(m.text()); });
  pagina.on('pageerror', e => erros.push(String(e)));
  pagina.on('requestfailed', r => {
    const registro = `${r.url()} — ${r.failure()?.errorText ?? '?'}`;
    (daAplicacao(r.url()) ? erros : falhasExternas).push(registro);
  });

  const print = async nome => pagina.screenshot({ path: `${SAIDA}/${nome}.png`, fullPage: false });

  // A ENTRADA MUDOU DE LUGAR: o hash vazio cai em `inicio`, que é tela pública,
  // então o formulário já não aparece sozinho. `entrar` dispensa a abertura da
  // marca e pede a entrada pelo convite da barra lateral — pela tela, sem
  // atalho de armazenamento.
  await entrar(pagina, BASE_WEB, { email: EMAIL, senha: SENHA });
  await pagina.waitForLoadState('networkidle');
  conferir(!(await pagina.content()).includes('Não foi possível conectar'), 'o login passou');
  await print('1-entrou');

  // A ROTA DIRETA. Clicar em texto do menu é frágil — "MuscleWare" aparece em
  // mais de um lugar, e foi exatamente isso que derrubou a primeira versão
  // deste arreio: ela acabou numa seção vazia e concluiu que o lápis sumira.
  await pagina.goto(`${BASE_WEB}/#/admin/musclewar`, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('table', { timeout: 20000 });
  await print('2-importacoes');
  conferir((await pagina.content()).includes('razor-qa.csv'), 'a lista mostra o lote semeado');

  // "Revisar" é o rótulo real do botão que abre a revisão do lote.
  await pagina.getByRole('button', { name: 'Revisar', exact: true }).first().click({ timeout: 15000 });
  await pagina.waitForSelector('.modal, [role=dialog]', { timeout: 15000 });
  await esperar(1500);
  await print('3-revisao-do-lote');
  conferir((await pagina.content()).includes('2952'), 'a revisão mostra a linha com 2952');

  // O LÁPIS. É este clique que a primeira versão desta funcionalidade não
  // oferecia, porque a linha não tem entidade.
  const lapis = pagina.getByRole('button', { name: /Corrigir a filiação da linha/i }).first();
  const temLapis = await lapis.isVisible({ timeout: 8000 }).catch(() => false);
  conferir(temLapis, 'A AÇÃO APARECE na linha SEM entidade');
  if (!temLapis) { await print('4b-sem-acao'); throw new Error('a ação não apareceu — o caso real continua sem porta'); }

  // DEFEITO 3 — RÓTULO VISÍVEL, SEM DEPENDER DE PASSAR O MOUSE.
  //
  // Antes a ação era um lápis de 14px cuja única explicação era o `title`: em
  // celular não existe passar o mouse, e em desktop ninguém passa o mouse num
  // ícone que não sabe que está lá. Foi assim que a funcionalidade ficou
  // invisível em produção, com API, RBAC e testes todos funcionando.
  const textoDaAcao = (await lapis.innerText()).trim();
  conferir(/Corrigir filia/i.test(textoDaAcao),
    `DEFEITO 3 — a ação tem RÓTULO VISÍVEL: "${textoDaAcao}"`);

  // DEFEITO 4 — A AÇÃO DENTRO DA TELA, inclusive em largura de celular.
  //
  // São onze colunas dentro de um contêiner que rola de lado: a coluna de ações
  // é a última e ficava fora do campo de visão. A coluna agora é fixa à
  // direita. A medida é a caixa do botão contra a largura da janela.
  for (const largura of [1280, 390]) {
    await pagina.setViewportSize({ width: largura, height: 900 });
    await esperar(400);
    const caixa = await lapis.boundingBox();
    const dentro = Boolean(caixa) && caixa.x >= 0 && caixa.x + caixa.width <= largura + 1;
    conferir(dentro,
      `DEFEITO 4 — a ação fica DENTRO da tela em ${largura}px `
      + `(x=${caixa ? Math.round(caixa.x) : '?'}, w=${caixa ? Math.round(caixa.width) : '?'})`);
    await print(`4-acao-visivel-${largura}`);
  }
  await pagina.setViewportSize({ width: 1280, height: 900 });
  await esperar(300);

  await lapis.click();
  await esperar(800);
  await print('5-modal-aberto');

  // SELETORES PELO RÓTULO ACESSÍVEL, e não por posição. `locator('select')`
  // pegava o filtro de situação da própria tela de revisão — o primeiro
  // <select> do documento. Um arreio que mira por posição mede o que calhou de
  // estar na frente.
  const campoEntidade = pagina.getByLabel(/Entidade correta/i);
  const campoMatricula = pagina.getByLabel(/Novo número de filiação/i);

  const temSelect = await campoEntidade.isVisible({ timeout: 10000 }).catch(() => false);
  conferir(temSelect, 'o modal pede a ENTIDADE (porque a fonte não a declarou)');
  if (!temSelect) { await print('5b-sem-campo-entidade'); throw new Error('o campo de entidade não apareceu'); }

  // DEFEITO 1, MEDIDO NOMEADAMENTE. O seletor existia e vinha VAZIO porque o
  // componente lia `entidades.dados` e o `useFetch` deste projeto devolve
  // `data`. Nenhum dos 861 testes de então viu isso: o campo estava no DOM.
  // Contar as opções é a única pergunta que separa "o campo existe" de "o campo
  // serve".
  const opcoes = await campoEntidade.locator('option').allTextContents();
  const reais = opcoes.filter(t => t.trim() && !/Selecione/i.test(t));
  conferir(reais.length > 0, `DEFEITO 1 — o seletor de entidade tem opções reais (${reais.length})`);
  conferir(reais.some(t => /NPC/.test(t)), 'DEFEITO 1 — e a NPC está entre elas');

  await campoEntidade.selectOption('NPC');
  await campoMatricula.fill('2932');

  // DEFEITO 5 — MOTIVO OBRIGATÓRIO. Uma correção administrativa sem motivo
  // escrito é um número trocado sem explicação: meses depois ninguém sabe se
  // foi digitação da fonte, troca de federação ou erro de quem corrigiu.
  const botaoValidar = pagina.getByRole('button', { name: /Validar e salvar/i });
  const travadoSemMotivo = await botaoValidar.isDisabled();
  conferir(travadoSemMotivo, 'DEFEITO 5 — sem MOTIVO, o botão de validar fica bloqueado');

  await pagina.getByLabel(/Motivo da correção/i).fill('Arquivo oficial trouxe 2952; matrícula real é 2932.');
  const liberadoComMotivo = await botaoValidar.isEnabled();
  conferir(liberadoComMotivo, 'DEFEITO 5 — com MOTIVO preenchido, o botão libera');
  await print('6-preenchido');

  await botaoValidar.click();
  await esperar(2000);
  await print('7-validado');
  const textoValidado = await pagina.content();
  conferir(textoValidado.includes('Lucas Gouveia Lima'), 'a validação encontrou o cadastro correto');
  conferir(textoValidado.includes('2932'), 'e mostra a filiação 2932');

  // DEFEITO 2, MEDIDO NOMEADAMENTE. `ModalActions` IGNORA children: ele monta
  // o seu próprio par Cancelar + submit a partir de `confirmLabel`. O botão de
  // confirmar era passado como children e simplesmente não existia — o fluxo de
  // dois passos terminava sem segundo passo, e o teste de integração nunca
  // soube, porque teste de integração chama rota.
  const botaoConfirmar = pagina.getByRole('button', { name: /Confirmar correção e vínculo/i });
  const temConfirmar = await botaoConfirmar.isVisible({ timeout: 10000 }).catch(() => false);
  conferir(temConfirmar, 'DEFEITO 2 — o botão "Confirmar correção e vínculo" EXISTE na tela');
  if (!temConfirmar) { await print('7b-sem-confirmar'); throw new Error('o segundo passo não tem botão'); }

  await botaoConfirmar.click();
  await esperar(2500);
  await print('8-confirmado');

  // A tela depois: os dois números, o efetivo e o da fonte.
  const depois = await pagina.content();
  conferir(depois.includes('2932'), 'a tela mostra a filiação corrigida');
  conferir(depois.includes('2952'), 'e continua mostrando o 2952 da fonte');
  conferir(/Fonte não informou a entidade|Fonte informou/.test(depois), 'com a nota de auditoria visível');

  // E o servidor concorda com a tela.
  const conferencia = exigir(await chamar('GET', `/musclewar/imports/${importId}`), 'revisão final');
  const final = conferencia.items[0];
  conferir(final.correctedMemberNumber === '2932', 'servidor: correctedMemberNumber = 2932');
  conferir(final.correctedAffiliationCode === 'NPC', 'servidor: correctedAffiliationCode = NPC');
  conferir(final.memberNumber === '2952', 'servidor: memberNumber original PRESERVADO');
  conferir(final.affiliationCode == null, 'servidor: affiliationCode original CONTINUA NULO');
  conferir(Boolean(final.athleteId), 'servidor: o resultado APPLIED ganhou dono');

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 3).join(' | ').slice(0, 500));
  if (falhasExternas.length) {
    console.log(`  · ${falhasExternas.length} falha(s) de recurso EXTERNO, do ambiente desta máquina:`);
    console.log('   ', falhasExternas.slice(0, 3).join(' | ').slice(0, 400));
  }

  await navegador.close();

  console.log(`\n  prints em ${SAIDA}/`);
  if (falhas.length) {
    console.error(`\n  FALHOU em ${falhas.length}:\n   - ${falhas.join('\n   - ')}\n`);
    process.exit(1);
  }
  console.log('\n  QA VISUAL: todas as conferências passaram.\n');
  // Os filhos (API e `vite preview`) seguram o event loop com stdio em pipe: sem
  // sair explicitamente, o arreio fica vivo depois de aprovar tudo, e quem o
  // chama não distingue "travou" de "passou".
  encerrar();
  process.exit(0);
}

principal().catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); process.exit(1); });

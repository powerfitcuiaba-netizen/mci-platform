#!/usr/bin/env node
// ============================================================================
// GATE DE ESTABILIDADE
//
// Um sistema com efeito tem uma forma própria de apodrecer: o efeito sai da
// tela, mas o que ele criou fica. Intervalo que continua batendo depois que a
// tela morreu; ouvinte que se soma a cada volta; `<audio>` que nunca para; nó
// de DOM que nunca é recolhido. Nada disso aparece na primeira volta — aparece
// na enésima, no ginásio, seis horas depois da abertura dos portões.
//
// Este script percorre o produto inteiro N vezes e mede o que sobra. Ele
// substitui a sonda que vivia fora do repositório na FASE 2.3: verificação boa
// que não é versionada é verificação que acontece uma vez só.
//
// USO
//   node scripts/qa/estabilidade.mjs --base http://127.0.0.1:5412 \
//                                    --email <operador> --senha-env SENHA_QA
//
// O que ele NÃO faz, de propósito:
//   - não cria dado de QA (isso é papel de quem prepara o ambiente);
//   - não lê senha de argumento (só de variável de ambiente);
//   - não inventa métrica que o navegador não meça de forma confiável.
//     Só entram aqui números que vêm do CDP (`Performance.getMetrics`) ou de
//     contagem direta no DOM.
// ============================================================================

import { argv, env, exit } from 'node:process';

const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : padrao;
};

const BASE = arg('base', 'http://127.0.0.1:5412');
const EMAIL = arg('email', 'qa.preview@mci.local');
const VAR_SENHA = arg('senha-env', 'SENHA_QA');
const CICLOS = Number(arg('ciclos', 6));
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = arg('chromium', env.PLAYWRIGHT_CHROMIUM || undefined);

const SENHA = env[VAR_SENHA];
if (!SENHA) {
  console.error(`Defina ${VAR_SENHA} no ambiente. Este script NÃO aceita senha por argumento: argumento aparece em \`ps\` e no histórico do shell.`);
  exit(2);
}

// ---------------------------------------------------------------- critérios
//
// Cada número abaixo é um limite de APROVAÇÃO, e cada um tem motivo.
// Crescimento zero é o alvo; a folga existe porque heap depois de coleta ainda
// oscila com o que o navegador decide manter em cache.
const CRITERIOS = Object.freeze({
  // Estruturas que a tela cria e precisa devolver ao sair. Tolerância
  // proporcional pequena: o que cresce de volta em volta não para de crescer.
  crescimentoDeNos: 0.15,
  folgaDeNos: 50,
  crescimentoDeOuvintes: 0.15,
  folgaDeOuvintes: 20,
  // Heap tem folga maior porque depende do coletor, não só do produto.
  crescimentoDeHeap: 0.30,
  folgaDeHeapMB: 3,
  // Estes são absolutos: não existe "um pouquinho de efeito preso".
  efeitosPresos: 0,
  audioTocando: 0,
  errosDePagina: 0,
  // O servidor de desenvolvimento mantém um intervalo próprio (HMR). Contra o
  // pacote de produção o esperado é zero.
  intervalosVivos: 1
});

const TELAS = ['Início', 'Campeonatos', 'Atletas', 'Eventos', 'Inscrições', 'Check-in', 'Pesagem',
               'Credenciamento', 'Palco', 'Resultados', 'Social', 'Messenger', 'Comunidades'];

// ------------------------------------------------------------ instrumentação
//
// Roda no navegador ANTES do produto. Envolve `setInterval` e `Audio` para que
// o que a tela cria fique contável — nada disto entra no pacote do produto.
const SONDA = () => {
  window.__qa = { intervalos: new Set(), audios: [] };
  const criarIntervalo = window.setInterval;
  const limparIntervalo = window.clearInterval;
  window.setInterval = function (...argumentos) {
    const id = criarIntervalo.apply(this, argumentos);
    window.__qa.intervalos.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    window.__qa.intervalos.delete(id);
    return limparIntervalo.call(this, id);
  };
  const AudioOriginal = window.Audio;
  window.Audio = function (...argumentos) {
    const elemento = new AudioOriginal(...argumentos);
    window.__qa.audios.push(elemento);
    return elemento;
  };
  window.Audio.prototype = AudioOriginal.prototype;
};

const problemas = [];
const erros = new Set();
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  if (!passou) problemas.push(rotulo);
};

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
await contexto.addInitScript(SONDA);

const pagina = await contexto.newPage();
const cdp = await contexto.newCDPSession(pagina);
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.enable');

pagina.on('pageerror', erro => erros.add(String(erro).slice(0, 160)));
pagina.on('response', resposta => { if (resposta.status() >= 500) erros.add(`${resposta.status()} ${resposta.url().slice(0, 80)}`); });

let pedidos = [];
pagina.on('request', requisicao => pedidos.push({ t: Date.now(), m: requisicao.method(), u: requisicao.url() }));

const medir = async () => {
  // Coleta forçada ANTES de ler: sem isso o heap medido é lixo ainda não
  // recolhido, e qualquer número serve para provar qualquer coisa.
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
  const noNavegador = await pagina.evaluate(() => ({
    intervalos: window.__qa.intervalos.size,
    audios: window.__qa.audios.length,
    audioTocando: window.__qa.audios.filter(a => !a.paused).length,
    efeitos: document.querySelectorAll('.campeao, .impacto, .pulso-ao-vivo').length,
    invisiveis: [...document.querySelectorAll('main *')]
      .filter(e => getComputedStyle(e).opacity === '0' && e.getBoundingClientRect().height > 0).length
  }));
  return { nos: m.Nodes, ouvintes: m.JSEventListeners, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), ...noNavegador };
};

const irPara = async rotulo => {
  const botao = pagina.getByRole('button', { name: rotulo, exact: true }).first();
  if (!(await botao.count())) return false;
  await botao.click();
  await pagina.waitForTimeout(700);
  // ESCOLHER O EVENTO É PARTE DA VOLTA, e não um detalhe.
  //
  // A primeira versão deste gate percorria as 13 telas e aprovava tudo — mas
  // aprovava um produto com a limpeza do polling do Check-in QUEBRADA. Motivo:
  // sem evento escolhido, `recarregarACada` é 0 e o intervalo nunca chega a
  // existir. O gate media uma tela que não estava ligada.
  //
  // Um mutante que sobrevive não é um mutante inofensivo: é um buraco no gate.
  const seletor = pagina.getByLabel('Selecionar evento').first();
  if (await seletor.count()) {
    const opcoes = await seletor.locator('option[value]:not([value=""])').all();
    if (opcoes.length) {
      const valor = await opcoes[0].getAttribute('value');
      await seletor.selectOption(valor);
      await pagina.waitForTimeout(900);
    }
  }
  return true;
};

console.log(`GATE DE ESTABILIDADE — ${CICLOS} voltas em ${BASE}\n`);

await pagina.addInitScript(() => {
  sessionStorage.setItem('mci-abertura-vista', '1');
  localStorage.setItem('mci-audio-enabled', 'false');
});
await pagina.goto(BASE, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(900);
await pagina.locator('input[type="email"]').first().fill(EMAIL);
await pagina.locator('input[type="password"]').first().fill(SENHA);
await pagina.getByRole('button', { name: /entrar/i }).last().click();
await pagina.waitForTimeout(2600);

if (!(await irPara('Início'))) {
  console.error('Não foi possível entrar: a navegação do painel não apareceu. Confira credenciais e base.');
  await navegador.close();
  exit(2);
}

// Volta de aquecimento: a primeira carga do pacote não é vazamento.
const aquecimento = await medir();
console.log('  aquecimento ', JSON.stringify(aquecimento));

const duplicadas = new Set();
const voltas = [];
for (let volta = 1; volta <= CICLOS; volta += 1) {
  pedidos = [];
  for (const tela of TELAS) await irPara(tela);
  await irPara('Início');
  await pagina.waitForTimeout(1200);

  // Duplicata = mesmo método e mesma URL da API em menos de 400 ms. Recurso
  // estático revalidado com 304 não conta: não é chamada repetida, é cache.
  const vistos = new Map();
  for (const p of pedidos) {
    if (!p.u.includes('/api/v1/')) continue;
    const chave = `${p.m} ${p.u}`;
    if (vistos.has(chave) && p.t - vistos.get(chave) < 400) duplicadas.add(`${chave.slice(0, 100)} (volta ${volta})`);
    vistos.set(chave, p.t);
  }

  const medida = await medir();
  voltas.push(medida);
  console.log(`  volta ${String(volta).padStart(2)}    ${JSON.stringify(medida)}`);
}

const primeira = voltas[0];
const ultima = voltas[voltas.length - 1];
const percentual = (depois, antes) => (antes === 0 ? 0 : +(((depois - antes) / antes) * 100).toFixed(1));

console.log('\nO QUE FICOU PRESO');
conferir('nenhum efeito preso na tela', ultima.efeitos <= CRITERIOS.efeitosPresos, `${ultima.efeitos}`);
conferir('nada ficou invisível esperando animação', ultima.invisiveis === 0, `${ultima.invisiveis}`);
conferir('nenhum áudio tocando', ultima.audioTocando <= CRITERIOS.audioTocando, `${ultima.audioTocando}`);
conferir('nenhum intervalo órfão ao sair das telas', ultima.intervalos <= CRITERIOS.intervalosVivos, `${ultima.intervalos} vivo(s)`);

console.log('\nO QUE CRESCEU');
console.log(`  nós DOM      ${primeira.nos} → ${ultima.nos}  (${percentual(ultima.nos, primeira.nos)}%)`);
console.log(`  ouvintes     ${primeira.ouvintes} → ${ultima.ouvintes}  (${percentual(ultima.ouvintes, primeira.ouvintes)}%)`);
console.log(`  heap         ${primeira.heapMB} MB → ${ultima.heapMB} MB  (${percentual(ultima.heapMB, primeira.heapMB)}%)`);
conferir('ouvintes não acumulam volta após volta',
  ultima.ouvintes <= primeira.ouvintes * (1 + CRITERIOS.crescimentoDeOuvintes) + CRITERIOS.folgaDeOuvintes);
conferir('nós DOM não acumulam volta após volta',
  ultima.nos <= primeira.nos * (1 + CRITERIOS.crescimentoDeNos) + CRITERIOS.folgaDeNos);
conferir('heap não cresce de forma linear',
  ultima.heapMB <= primeira.heapMB * (1 + CRITERIOS.crescimentoDeHeap) + CRITERIOS.folgaDeHeapMB);

console.log('\nREQUISIÇÕES');
conferir('nenhuma chamada de API duplicada', duplicadas.size === 0, `${duplicadas.size}`);
[...duplicadas].slice(0, 8).forEach(d => console.log('    -', d));
if (duplicadas.size) {
  console.log('    Atenção: em DESENVOLVIMENTO o React.StrictMode invoca cada efeito duas');
  console.log('    vezes de propósito. Meça o PACOTE DE PRODUÇÃO antes de tratar isso como defeito.');
}

console.log('\nERROS DE PÁGINA');
conferir('nenhum erro de página', erros.size <= CRITERIOS.errosDePagina, `${erros.size}`);
[...erros].slice(0, 8).forEach(e => console.log('    -', e));

await navegador.close();

console.log(`\n${problemas.length ? `REPROVADO — ${problemas.length} critério(s)` : 'APROVADO'}`);
problemas.forEach(p => console.log('  -', p));
exit(problemas.length ? 1 : 0);

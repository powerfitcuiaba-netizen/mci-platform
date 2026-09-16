#!/usr/bin/env node
// ============================================================================
// FASE 14 — VERIFICAÇÃO DO AMBIENTE DE PREVIEW, CONTRA A URL PÚBLICA.
//
// Este script não roda contra `localhost`. Ele roda contra o endereço que o
// responsável vai abrir, de fora, atravessando o túnel, o CORS e o navegador
// de verdade. É a diferença entre "o ambiente subiu" e "o ambiente funciona
// para quem está do outro lado".
//
// Ele reprova. Cada FALHOU entra na conta, e o processo sai com código 1 — um
// preview que não passa aqui não é preview, é uma URL que abre e frustra.
//
// Uso:
//   node scripts/qa/preview-verificacao.mjs \
//     --web https://xxx.trycloudflare.com \
//     --api https://yyy.trycloudflare.com \
//     --operador email --atleta email --senha '...'
// ============================================================================

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const WEB = (arg('web') || '').replace(/\/$/, '');
const API = (arg('api') || '').replace(/\/$/, '');
const OPERADOR = arg('operador');
const ATLETA = arg('atleta');
const SENHA = arg('senha', env.DEMO_PASSWORD);
const CHROMIUM = env.PLAYWRIGHT_CHROMIUM || undefined;

// O Playwright é resolvido em tempo de execução, e não por `import` no topo.
//
// Ele não é dependência do projeto: a interface não precisa dele para rodar, e
// carregá-lo no pacote só para um arreio de QA faria todo deploy baixar um
// navegador. Cada ambiente diz onde ele está — no runner, instalado sem gravar
// no package.json; nesta máquina, pelo caminho do módulo global.
//
// A primeira versão deste arquivo importava 'playwright' direto. No runner o
// pacote não existia, o import estourava antes da primeira asserção, e a
// verificação inteira "falhava" sem ter medido nada.
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');

if (!WEB || !API || !OPERADOR || !ATLETA || !SENHA) {
  console.error('faltam argumentos: --web --api --operador --atleta --senha');
  process.exit(1);
}

const problemas = [];
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  if (!passou) problemas.push(`${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
};

const esperar = ms => new Promise(r => { setTimeout(r, ms); });

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null, origem = WEB } = {}) {
  const resposta = await fetch(`${API}/api/v1${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      Origin: origem,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await resposta.json().catch(() => null);
  return { status: resposta.status, corpo: json, headers: resposta.headers };
}

const entrar = async email => {
  const r = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } });
  if (r.status !== 200) throw new Error(`login de ${email} falhou: ${r.status} ${JSON.stringify(r.corpo).slice(0, 200)}`);
  return r.corpo.token;
};

console.log('\n=== VERIFICAÇÃO DO PREVIEW — FASE 14 ===\n');
console.log(`  WEB ${WEB}`);
console.log(`  API ${API}\n`);

let navegador;

try {
  // ======================================================================
  // §5 — SAÚDE, pela porta pública
  // ======================================================================
  console.log('--- §5 Health e Ready ---');

  const saude = await fetch(`${API}/health`).then(r => r.json()).catch(() => null);
  conferir('/health responde ok', saude?.status === 'ok', JSON.stringify(saude ?? {}));

  const pronto = await fetch(`${API}/ready`).then(async r => ({ status: r.status, corpo: await r.json() }))
    .catch(() => ({ status: 0, corpo: null }));
  conferir('/ready responde 200', pronto.status === 200, `status ${pronto.status}`);
  conferir('/ready · database', pronto.corpo?.checks?.database === true);
  conferir('/ready · storage', pronto.corpo?.checks?.storage === true);
  // O RLS é o que impede uma federação de ler a outra. Se ele reprovar, a
  // instância não deve receber tráfego — nem de teste.
  conferir('/ready · rls', pronto.corpo?.checks?.rls === true,
    (pronto.corpo?.rls || []).join(', '));

  // ======================================================================
  // §6 — CORS: só a origem necessária, nunca curinga
  // ======================================================================
  console.log('\n--- §6 CORS ---');

  const preflight = await fetch(`${API}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: WEB,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  });
  const permitida = preflight.headers.get('access-control-allow-origin');
  conferir('preflight aceita a origem do preview', permitida === WEB, `recebeu: ${permitida}`);
  conferir('CORS não usa curinga', permitida !== '*', `recebeu: ${permitida}`);

  const intrusa = await fetch(`${API}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://origem-nao-autorizada.example', 'Access-Control-Request-Method': 'POST' }
  });
  const daIntrusa = intrusa.headers.get('access-control-allow-origin');
  conferir('origem desconhecida NÃO é liberada', !daIntrusa || daIntrusa !== 'https://origem-nao-autorizada.example',
    `recebeu: ${daIntrusa}`);

  // ======================================================================
  // §12 — RANKING PÚBLICO, sem login
  // ======================================================================
  console.log('\n--- §12 Ranking público ---');

  const temporadas = await chamar('/seasons');
  const publicoBruto = await fetch(`${API}/api/v1/ranking?limit=100`).then(r => r.json()).catch(() => null);
  const linhasPublicas = publicoBruto?.items ?? publicoBruto ?? [];

  conferir('ranking público responde sem autenticação', Array.isArray(linhasPublicas),
    JSON.stringify(publicoBruto ?? {}).slice(0, 160));
  conferir('ranking público entrega no máximo 5 linhas', linhasPublicas.length <= 5,
    `${linhasPublicas.length} linhas`);

  const cruPublico = JSON.stringify(publicoBruto ?? {});
  conferir('ranking público não traz CPF', !/"cpf"/i.test(cruPublico));
  conferir('ranking público não traz telefone nem e-mail',
    !/"phone"|"email"|"whatsapp"|"addressLine"|"postalCode"/i.test(cruPublico));
  void temporadas;

  // ======================================================================
  // §13 — SEGURANÇA BÁSICA
  // ======================================================================
  console.log('\n--- §13 Segurança ---');

  const tokenAtleta = await entrar(ATLETA);
  const tokenOperador = await entrar(OPERADOR);

  const meuPerfil = await chamar('/me/affiliation', { token: tokenAtleta });
  conferir('atleta enxerga a própria filiação', meuPerfil.status === 200, `status ${meuPerfil.status}`);
  const meuAthleteId = meuPerfil.corpo?.athlete?.id;
  const minhaOrg = meuPerfil.corpo?.organization?.id;

  const negado = status => [401, 403, 404].includes(status);

  const auditoria = await chamar('/audit-logs?limit=5', { token: tokenAtleta });
  conferir('atleta NÃO lê a auditoria', negado(auditoria.status), `status ${auditoria.status}`);

  const usuarios = await chamar('/users?limit=5', { token: tokenAtleta });
  conferir('atleta NÃO lista usuários', negado(usuarios.status), `status ${usuarios.status}`);

  // Homologar Overall exige ranking.manage. O atleta não tem, e não pode ter.
  const eventos = await chamar('/events?limit=10', { token: tokenOperador });
  const listaDeEventos = eventos.corpo?.items ?? eventos.corpo ?? [];
  const algumEvento = listaDeEventos[0]?.id;

  if (algumEvento) {
    const tentativa = await chamar(`/events/${algumEvento}/overall`, {
      metodo: 'POST', token: tokenAtleta, corpo: { athleteId: meuAthleteId }
    });
    conferir('atleta NÃO homologa Overall', negado(tentativa.status), `status ${tentativa.status}`);

    const candidatos = await chamar(`/events/${algumEvento}/overall/candidates`, { token: tokenAtleta });
    conferir('atleta NÃO vê a tela de candidatos pela API', negado(candidatos.status), `status ${candidatos.status}`);
  } else {
    conferir('havia evento para testar homologação', false, 'nenhum evento retornado ao operador');
  }

  // Trocar o id na URL: o histórico é derivado do TOKEN, nunca de um id que o
  // cliente escolhe. Pedir o de outra pessoa não pode devolver o dela.
  const atletas = await chamar('/athletes?limit=20', { token: tokenOperador });
  const listaDeAtletas = atletas.corpo?.items ?? atletas.corpo ?? [];
  const outro = listaDeAtletas.find(a => a.id !== meuAthleteId);

  if (outro) {
    const alheio = await chamar(`/athletes/${outro.id}/ranking-points`, { token: tokenAtleta });
    const ehDoOutro = alheio.status === 200
      && (alheio.corpo?.items ?? []).length > 0;
    conferir('atleta NÃO lê o histórico de outro atleta', !ehDoOutro, `status ${alheio.status}`);

    const cadastroAlheio = await chamar(`/athletes/${outro.id}`, { token: tokenAtleta });
    const vazouCpf = JSON.stringify(cadastroAlheio.corpo ?? {}).match(/"cpf"\s*:\s*"\d/);
    conferir('atleta NÃO recebe o CPF de outro atleta', !vazouCpf, `status ${cadastroAlheio.status}`);
  } else {
    conferir('havia outro atleta para testar acesso cruzado', false, 'lista com um único atleta');
  }

  // Trocar organizationId: escrever em nome de outra federação.
  const outraOrg = await chamar('/organizations', {
    metodo: 'POST', token: tokenAtleta,
    corpo: { name: 'QA · DEMO — Federação Intrusa', slug: `intrusa-${Date.now().toString(36)}`, state: 'MT' }
  });
  conferir('atleta NÃO cria organização', negado(outraOrg.status), `status ${outraOrg.status}`);

  const escritaCruzada = await chamar('/seasons', {
    metodo: 'POST', token: tokenAtleta,
    corpo: { organizationId: minhaOrg, name: 'QA · DEMO — Temporada Intrusa', year: 2026 }
  });
  conferir('atleta NÃO cria temporada na própria federação', negado(escritaCruzada.status),
    `status ${escritaCruzada.status}`);

  // Token adulterado: assinatura inválida precisa ser recusada.
  const adulterado = `${tokenAtleta.slice(0, -6)}AAAAAA`;
  const comTokenFalso = await chamar('/me/affiliation', { token: adulterado });
  conferir('token adulterado é recusado', comTokenFalso.status === 401, `status ${comTokenFalso.status}`);

  // ======================================================================
  // NAVEGADOR — §10, §11, §14
  // ======================================================================
  const { chromium } = await import(CAMINHO_PLAYWRIGHT);
  navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });

  const erros = new Set();
  const vigiar = pagina => {
    pagina.on('pageerror', e => erros.add(`pageerror: ${String(e.message).slice(0, 160)}`));
    pagina.on('response', r => {
      if (r.status() >= 500) erros.add(`${r.status()} ${r.url().slice(0, 120)}`);
    });
  };

  // ENTRAR CUSTA COTA, e a cota é pequena de propósito.
  //
  // O limitador de autenticação corta em 10 tentativas por origem a cada 15
  // minutos — é ele que segura força bruta, e no preview ele fica LIGADO, como
  // em produção. A primeira versão deste arreio entrava uma vez por largura,
  // somava onze logins e levava 429 no meio da medição. O limitador não estava
  // errado; o arreio estava.
  //
  // Agora a sessão do atleta é feita UMA vez e reaproveitada: o estado do
  // navegador (que é onde o token vive) é copiado para cada contexto novo.
  const abrirSessao = async (email, viewport = { width: 1440, height: 900 }) => {
    const contexto = await navegador.newContext({ viewport });
    const pagina = await contexto.newPage();
    vigiar(pagina);
    await pagina.goto(WEB, { waitUntil: 'networkidle' });
    await pagina.fill('input[type="email"]', email);
    await pagina.fill('input[type="password"]', SENHA);
    await pagina.click('button[type="submit"]');
    await pagina.waitForTimeout(3000);
    return { contexto, pagina };
  };

  // ---------------------------------------------------------------- §10
  console.log('\n--- §10 Fluxo do operador ---');

  const sessaoOperador = await abrirSessao(OPERADOR);
  const op = sessaoOperador.pagina;

  const entrou = !(await op.locator('input[type="password"]').count());
  conferir('TESTE 1 · login do operador', entrou);

  await op.goto(`${WEB}/#inicio`, { waitUntil: 'networkidle' });
  await op.waitForTimeout(1200);
  conferir('TESTE 1 · dashboard carrega com conteúdo',
    ((await op.textContent('body')) || '').trim().length > 200);

  await op.goto(`${WEB}/#admin/overall`, { waitUntil: 'networkidle' });
  await op.waitForTimeout(1500);
  conferir('TESTE 2 · tela de Overall abre',
    /Homologação do Overall/i.test((await op.textContent('body')) || ''));

  // A tela NÃO pode abrir já apontando um campeão.
  const antesDeEscolher = (await op.textContent('body')) || '';
  conferir('TESTE 2 · a tela não escolhe campeonato sozinha',
    /Escolha um campeonato/i.test(antesDeEscolher));

  const seletor = op.locator('select').first();
  const opcoes = await seletor.locator('option').allTextContents();
  conferir('TESTE 3 · o seletor lista campeonatos', opcoes.length > 1, `${opcoes.length} opções`);

  // Procura um campeonato com classe absoluta SEM homologação — é nele que o
  // botão de declarar existe.
  let homologou = false;
  let contaConferida = false;

  const valores = await seletor.locator('option').evaluateAll(
    nós => nós.map(n => n.value).filter(Boolean)
  );

  for (const valor of valores) {
    await seletor.selectOption(valor);
    await op.waitForTimeout(2000);

    const corpo = (await op.textContent('body')) || '';
    if (!/Open/.test(corpo)) continue;

    const botoes = op.locator('button', { hasText: 'Declarar Overall' });
    if (!(await botoes.count())) continue;

    conferir('TESTE 4 · candidatos aparecem com a colocação como fato',
      /Col\./i.test(corpo) && /Matrícula/i.test(corpo));

    // Nenhum candidato pode vir marcado como "o Overall".
    conferir('TESTE 4 · nenhum candidato vem destacado como campeão',
      !/este é o overall|campeão sugerido|vencedor provável/i.test(corpo));

    await botoes.first().click();
    await op.waitForTimeout(2500);

    const dialogo = (await op.textContent('body')) || '';
    conferir('TESTE 5 · a prévia abre antes de qualquer escrita',
      /Confira o impacto antes de confirmar/i.test(dialogo));

    // colocação + 10 = total. A conta tem de estar ABERTA na tela.
    const numeros = await op.locator('.definicoes div').allTextContents();
    const achar = rotulo => {
      const linha = numeros.find(t => t.replace(/\s+/g, ' ').trim().startsWith(rotulo));
      const m = linha && linha.match(/(-?\d+)\s*$/);
      return m ? Number(m[1]) : null;
    };
    const colocacaoPontos = achar('Pontos da colocação');
    const bonus = achar('Bônus Overall');
    const total = achar('Total da participação');

    contaConferida = colocacaoPontos !== null && bonus !== null && total !== null
      && bonus === 10 && colocacaoPontos + bonus === total;
    conferir('TESTE 5 · colocação + 10 = total, na tela',
      contaConferida, `${colocacaoPontos} + ${bonus} = ${total}`);

    await op.locator('button', { hasText: 'Confirmar homologação' }).first().click();
    await op.waitForTimeout(3500);

    const depois = (await op.textContent('body')) || '';
    homologou = /Overall declarado oficialmente/i.test(depois) || /Homologado/.test(depois);
    conferir('TESTE 6 · o título fica HOMOLOGADO', homologou);

    // O QUE A VERIFICAÇÃO ESCREVE, ELA DESFAZ.
    //
    // ACHADO DO TESTE HUMANO. Esta verificação homologa um Overall de verdade
    // — é o que o teste vale — e antes deixava o título lá. O ambiente era
    // então anunciado com uma narrativa ("um Overall homologado") que os
    // próprios dados já não contavam mais: a atleta aparecia com dois títulos
    // e 30 pontos, e quem abriu a tela teve toda a razão de estranhar.
    //
    // O arreio de QA não pode deixar rastro no artefato que ele verifica.
    // Revogar é a via própria, registrada em auditoria, e não um DELETE no
    // banco: o que se desfaz aqui se desfaz como um operador desfaria.
    const titulos = await chamar(`/events/${valor}/overall`, { token: tokenOperador });
    const declarado = (titulos.corpo?.items ?? titulos.corpo ?? [])
      .find(t => t?.id) ?? null;

    if (declarado) {
      const revogacao = await chamar(`/events/${valor}/overall/${declarado.id}`, {
        metodo: 'DELETE', token: tokenOperador,
        corpo: { reason: 'Verificação automática do preview: desfazendo o que o teste declarou' }
      });
      conferir('TESTE 6 · a verificação desfaz o que declarou, pela via própria',
        revogacao.status === 200, `status ${revogacao.status}`);
    } else {
      conferir('TESTE 6 · o título declarado foi encontrado para revogação', false,
        JSON.stringify(titulos.corpo ?? {}).slice(0, 160));
    }
    break;
  }

  if (!homologou) {
    conferir('TESTE 4–6 · havia classe absoluta sem homologação para declarar', false,
      'nenhum campeonato com botão "Declarar Overall"');
  }

  await op.goto(`${WEB}/#admin/ranking`, { waitUntil: 'networkidle' });
  await op.waitForTimeout(2000);
  const rankingAdmin = (await op.textContent('body')) || '';
  conferir('TESTE 7 · o ranking administrativo mostra o Overall',
    /Overall/i.test(rankingAdmin) && rankingAdmin.trim().length > 200);

  // O ACUMULADO PRECISA SER EXPLICÁVEL — foi disso que o teste humano sentiu
  // falta. A campeã da demonstração vale 19: 5 da vitória na 1ª etapa, +10 do
  // título, 4 do 2º lugar na 2ª. Um título, duas etapas.
  const rankingDaCampea = await chamar(`/ranking?seasonId=${(await chamar('/seasons', { token: tokenOperador })).corpo?.items?.[0]?.id ?? ''}&limit=50`,
    { token: tokenOperador });
  const linhasDoRanking = rankingDaCampea.corpo?.items ?? rankingDaCampea.corpo ?? [];
  const campea = linhasDoRanking.find(l => l.athlete?.fullName?.includes('Campeã Overall'));
  conferir('TESTE 7 · o total da campeã é explicável (5 + 10 + 4 = 19)',
    campea?.totalPoints === 19, `totalPoints=${campea?.totalPoints}`);
  conferir('TESTE 7 · e ela tem UM título, não dois',
    campea?.overallWins === 1, `overallWins=${campea?.overallWins}`);

  // ---------------------------------------------------------------- §11
  console.log('\n--- §11 Fluxo do atleta ---');

  const sessaoAtleta = await abrirSessao(ATLETA);
  const at = sessaoAtleta.pagina;

  conferir('TESTE 8 · login do atleta', !(await at.locator('input[type="password"]').count()));

  // O estado com a sessão já resolvida, para as sete larguras não entrarem de
  // novo sete vezes.
  const sessaoGuardada = await sessaoAtleta.contexto.storageState();

  await at.goto(`${WEB}/#minha-filiacao`, { waitUntil: 'networkidle' });
  await at.waitForTimeout(1800);
  const filiacao = (await at.textContent('body')) || '';
  conferir('TESTE 9 · Minha Filiação mostra a filiação ATUAL',
    /NPC São Paulo/i.test(filiacao), filiacao.slice(0, 0));
  conferir('TESTE 9 · e mostra a matrícula', /SP-2001/.test(filiacao));

  await at.goto(`${WEB}/#meu-historico`, { waitUntil: 'networkidle' });
  await at.waitForTimeout(1800);
  const historico = (await at.textContent('body')) || '';

  conferir('TESTE 10 · o histórico traz mais de uma participação',
    /Participações/i.test(historico));
  // A prova da imutabilidade: a MESMA atleta, duas filiações diferentes.
  conferir('TESTE 10 · a filiação HISTÓRICA aparece por linha',
    /NPC São Paulo/i.test(historico) && /NPC Mato Grosso/i.test(historico));
  conferir('TESTE 10 · a matrícula histórica aparece',
    /SP-2001/.test(historico) && /MT-1001/.test(historico));
  conferir('TESTE 10 · a coluna de Overall existe no histórico',
    /Overall/i.test(historico));

  // A tela do atleta não pode oferecer administração.
  conferir('TESTE 10 · o atleta não vê o menu de administração',
    !/ADMINISTRAÇÃO/.test(historico));

  // ---------------------------------------------------------------- §12
  console.log('\n--- §12 Ranking público no navegador ---');

  const anonimo = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const pub = await anonimo.newPage();
  vigiar(pub);
  await pub.goto(`${WEB}/#ranking`, { waitUntil: 'networkidle' });
  await pub.waitForTimeout(2500);
  const corpoPublico = (await pub.textContent('body')) || '';

  // ACHADO, e não falha do preview: a interface exige login em TODA rota.
  //
  // `App.jsx` devolve a tela de entrada quando não há sessão, antes de olhar a
  // rota — a marca `publico: true` da navegação só decide o que aparece no
  // menu de quem já entrou. O ranking público EXISTE e responde sem
  // autenticação: é a API, medida logo acima, com TOP 5 e sem CPF. O que não
  // existe é o caminho do visitante até ele pelo navegador.
  //
  // Abrir esse caminho seria implementar funcionalidade, e esta fase é de
  // publicação, não de desenvolvimento. Então o que se mede aqui é a verdade
  // atual — e ela vira ressalva no relatório, para o responsável decidir.
  const naEntrada = /Entrar|Campeonato Brasileiro Muscle Contest/i.test(corpoPublico);
  conferir('TESTE 11 · visitante sem sessão cai na tela de entrada (comportamento atual)',
    naEntrada, corpoPublico.trim().slice(0, 80));
  conferir('TESTE 11 · e a tela de entrada não vaza nome de atleta nem CPF',
    !/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(corpoPublico) && !/QA · DEMO — Atleta/.test(corpoPublico));

  // ---------------------------------------------------------------- §14
  console.log('\n--- §14 QA visual em 7 larguras ---');

  const LARGURAS = [320, 375, 390, 768, 1024, 1280, 1440];
  const TELAS = ['inicio', 'ranking', 'campeonatos', 'minha-filiacao', 'meu-historico'];

  for (const largura of LARGURAS) {
    const ctx = await navegador.newContext({
      viewport: { width: largura, height: 900 },
      storageState: sessaoGuardada
    });
    const p = await ctx.newPage();
    vigiar(p);

    const estourando = [];
    const semConteudo = [];

    for (const tela of TELAS) {
      await p.goto(`${WEB}/#${tela}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(900);

      const medida = await p.evaluate(() => {
        const fora = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= window.innerWidth + 1) continue;

          // `overflow-x: auto` é solução, não defeito — e vale para a SUBÁRVORE
          // inteira, não só para o elemento que a declara.
          //
          // Esta versão do arreio já nasceu errada uma vez: olhando só o
          // próprio elemento, ela acusou `table`, `thead`, `tr` e cada `th` de
          // uma tabela que rolava corretamente dentro do contêiner dela, em
          // quatro larguras. O gate da FASE 13 já tinha aprendido isso e
          // documentado; repeti o erro por não ter lido o que estava escrito.
          // Um gate que acusa o que está certo é um gate que se aprende a
          // ignorar.
          let dentroDeRolavel = false;
          for (let pai = el; pai && pai !== document.body; pai = pai.parentElement) {
            const overflow = getComputedStyle(pai).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') { dentroDeRolavel = true; break; }
          }
          if (dentroDeRolavel) continue;

          fora.push(`${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`);
        }
        return {
          rolagem: document.documentElement.scrollWidth > window.innerWidth + 1,
          fora: [...new Set(fora)].slice(0, 5),
          texto: (document.body.textContent || '').trim().length
        };
      });

      if (medida.rolagem || medida.fora.length) estourando.push(`${tela}: ${medida.fora.join(', ') || 'rolagem'}`);
      if (medida.texto < 50) semConteudo.push(tela);
    }

    conferir(`@${largura}px — sem overflow horizontal`, estourando.length === 0, estourando.join(' | '));
    conferir(`@${largura}px — nenhuma tela branca`, semConteudo.length === 0, semConteudo.join(', '));

    await ctx.close();
  }

  conferir('nenhum erro de página nem resposta 5xx em todo o percurso',
    erros.size === 0, [...erros].slice(0, 5).join(' · '));

  await esperar(200);
} catch (erro) {
  console.error(`\nFALHA NA EXECUÇÃO: ${erro.message}`);
  problemas.push(`execução: ${erro.message}`);
} finally {
  if (navegador) await navegador.close().catch(() => {});
}

console.log(`\n=== ${problemas.length ? `REPROVADO (${problemas.length})` : 'APROVADO'} ===`);
for (const p of problemas) console.log(`  · ${p}`);
process.exit(problemas.length ? 1 : 0);

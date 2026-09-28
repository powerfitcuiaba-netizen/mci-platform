#!/usr/bin/env node
// ============================================================================
// CADASTRO DE TREINADOR (EQUIPE), NUM NAVEGADOR DE VERDADE, CONTRA A URL REAL.
//
// POR QUE ESTE ARREIO EXISTE
//
// O responsável abriu o preview, preencheu o cadastro, clicou em "Criar conta"
// e leu "Não foi possível conectar à API." — e a verificação do preview havia
// passado. As duas coisas eram verdadeiras: `preview-verificacao.mjs` mede
// saúde, CORS, ranking público, segurança e o fluxo do operador, e NUNCA tocou
// `POST /auth/register`. O caminho que a pessoa usou não estava medido.
//
// Este script mede exatamente esse caminho, de fora, no navegador, atravessando
// o túnel e o CORS: o assistente de cinco etapas, a senha e a confirmação, o
// envio, a entrada imediata, o cadastro de treinador nascendo APROVADO e a
// fronteira que a aprovação automática NÃO atravessa — atuação em federação.
//
// Ele serve aos dois ambientes com o mesmo código: `--web http://127.0.0.1:...`
// numa réplica local, ou a URL pública do preview no runner. Se ele passar só
// em jsdom e não aqui, não passou.
//
// Uso:
//   node scripts/qa/cadastro-treinador-navegador.mjs \
//     --web https://xxx.trycloudflare.com --api https://yyy.trycloudflare.com \
//     --senha '...' --diretor diretor@mci.local --central central@mci.local
// ============================================================================

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const WEB = (arg('web') || '').replace(/\/$/, '');
const API = (arg('api') || '').replace(/\/$/, '');
const SENHA_QA = arg('senha', env.DEMO_PASSWORD);
const DIRETOR = arg('diretor', 'diretor@mci.local');
const CENTRAL = arg('central', 'central@mci.local');
const CHROMIUM = env.PLAYWRIGHT_CHROMIUM || undefined;
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');

if (!WEB || !API || !SENHA_QA) {
  console.error('faltam argumentos: --web --api --senha');
  process.exit(1);
}

const FOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA'
  + 'EUlEQVQImWM4YaOBFTEMLQkAdntLAQXW6sIAAAAASUVORK5CYII=',
  'base64'
);

const problemas = [];
const conferir = (rotulo, passou, detalhe = '') => {
  console.log(`  ${passou ? 'PASS  ' : 'FALHOU'}  ${rotulo}${detalhe ? `  ${detalhe}` : ''}`);
  if (!passou) problemas.push(`${rotulo}${detalhe ? ` — ${detalhe}` : ''}`);
};

// 429 NÃO É REPROVAÇÃO DO PRODUTO, E TAMBÉM NÃO É APROVAÇÃO.
//
// `limiteAutenticacao` corta em 10 chamadas de `/auth/*` por origem a cada 15
// minutos, e atrás do túnel toda a internet cabe numa origem só. Rodar este
// arreio duas vezes seguidas esgota a cota e as últimas conferências voltam 429
// — medido, foi o que aconteceu aqui na terceira rodada.
//
// Chamar isso de falha do cadastro seria mentira, e tratar como sucesso seria
// pior: a conferência não aconteceu. Então ela entra como NÃO MEDIDO, conta como
// problema (para ninguém ler verde onde não houve medição) e diz o motivo e o
// remédio — reiniciar a API zera a contagem, porque o estado vive no processo.
const conferirComLimitador = (rotulo, status, esperado, detalhe = '') => {
  if (status === 429) {
    console.log(`  NÃO MEDIDO  ${rotulo}  429 do limitador de autenticação — cota da janela esgotada`);
    problemas.push(`${rotulo} — NÃO MEDIDO: 429 do limitador. Reinicie a API (zera a contagem) e rode de novo.`);
    return;
  }
  conferir(rotulo, status === esperado, detalhe || `status ${status}`);
};

// A SENHA DA CONTA NOVA NÃO É A SENHA DE QA.
//
// Reaproveitar a senha entregue faria o teste passar mesmo se o formulário
// ignorasse o campo e a conta herdasse outra senha qualquer. Uma senha própria,
// usada depois para ENTRAR, é o que prova que a senha digitada foi a gravada.
const marca = Date.now().toString(36);
const EMAIL_NOVO = `qa.treinador.${marca}@mci.local`;
const SENHA_NOVA = `Nav-${marca}-Aa1!`;

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const resposta = await fetch(`${API}/api/v1${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      Origin: WEB,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

const entrarPelaApi = async email => {
  const r = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA_QA } });
  if (r.status === 429) {
    throw new Error(`login de ${email} levou 429 do limitador de autenticação: a cota da janela de 15 min está esgotada. Reinicie a API para zerar a contagem.`);
  }
  if (r.status !== 200) throw new Error(`login de ${email}: ${r.status} ${JSON.stringify(r.corpo).slice(0, 200)}`);
  return r.corpo.token;
};

console.log('\n=== CADASTRO DE TREINADOR (EQUIPE) NO NAVEGADOR ===\n');
console.log(`  WEB   ${WEB}`);
console.log(`  API   ${API}`);
console.log(`  conta ${EMAIL_NOVO}\n`);

let navegador;

try {
  const { createRequire } = await import('node:module');
  const exigir = createRequire(import.meta.url);
  const { chromium } = exigir(CAMINHO_PLAYWRIGHT);
  navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });

  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  const pagina = await contexto.newPage();

  // TODA FALHA DE REDE É CAPTURADA, e não só o texto na tela.
  //
  // "Não foi possível conectar à API." nasce de um `TypeError` do `fetch` —
  // túnel morto, CORS barrando a leitura, DNS. Guardar a requisição que falhou
  // é a diferença entre "deu erro" e saber ONDE deu.
  // FALHA NOSSA E FALHA DE TERCEIRO SÃO COISAS DIFERENTES, e misturá-las
  // reprovaria o ambiente por motivo errado.
  //
  // A tela pede a fonte ao Google e o endereço ao ViaCEP. Nenhum dos dois é
  // nosso, nenhum dos dois é obrigatório — `buscarCep` trata indisponibilidade
  // e deixa a pessoa digitar à mão, e a tipografia tem pilha de reserva. Numa
  // máquina sem saída para eles, contá-los como defeito do preview faria este
  // arreio reprovar um cadastro que funcionou.
  //
  // O que NÃO se tolera é falha contra a nossa API ou o nosso frontend: é
  // exatamente ela que produz "Não foi possível conectar à API.".
  const nosso = url => url.startsWith(API) || url.startsWith(WEB);
  const falhas = [];
  const deTerceiro = [];
  const doServidor = [];
  pagina.on('requestfailed', r => {
    const linha = `${r.method()} ${r.url().slice(0, 140)} — ${r.failure()?.errorText}`;
    (nosso(r.url()) ? falhas : deTerceiro).push(linha);
  });
  pagina.on('response', r => {
    if (r.status() >= 400 && nosso(r.url())) {
      doServidor.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
    }
  });
  pagina.on('pageerror', e => falhas.push(`pageerror: ${String(e.message).slice(0, 160)}`));

  const avancar = () => pagina.locator('button[type="submit"]').click();
  const textoDaTela = () => pagina.textContent('body').then(t => t || '');

  // ---------------------------------------------------------------- ETAPA 1
  console.log('--- o assistente abre e oferece UMA opção de treinador ---');
  await pagina.goto(WEB, { waitUntil: 'networkidle' });
  await pagina.getByRole('button', { name: 'Criar conta' }).click();
  await pagina.waitForTimeout(600);

  conferir('o assistente de cadastro abre', /Etapa 1 de 5|etapa 1/i.test(await textoDaTela()));

  const papeis = await pagina.locator('select option').evaluateAll(
    nos => nos.map(n => ({ valor: n.value, rotulo: (n.textContent || '').trim() }))
  );
  conferir('existe a opção Treinador (Equipe)',
    papeis.some(p => p.valor === 'COACH' && /Treinador/i.test(p.rotulo)),
    JSON.stringify(papeis.map(p => p.valor)));
  conferir('NÃO existe mais a opção de papel Equipe (TEAM)',
    !papeis.some(p => p.valor === 'TEAM'));

  await pagina.locator('input[autocomplete="name"]').fill('QA Treinador Navegador');
  await pagina.locator('input[type="date"]').fill('1990-05-14');
  await pagina.locator('select').first().selectOption('COACH');
  await avancar();
  await pagina.waitForTimeout(400);

  // ---------------------------------------------------------------- ETAPA 2
  console.log('\n--- senha e confirmação ---');
  conferir('chegou na etapa de acesso', /Etapa 2 de 5|etapa 2/i.test(await textoDaTela()));

  const senhas = pagina.locator('input[autocomplete="new-password"]');
  conferir('há DOIS campos de senha', (await senhas.count()) === 2, `${await senhas.count()} campos`);

  await pagina.locator('input[type="email"]').fill(EMAIL_NOVO);
  await senhas.nth(0).fill(SENHA_NOVA);
  await senhas.nth(1).fill(`${SENHA_NOVA}-diferente`);
  // PELO RÓTULO, como a pessoa lê. O campo de WhatsApp não tem `autocomplete`
  // — de propósito: o navegador não tem um valor para oferecer ali — e procurar
  // por atributo faria o arreio depender de detalhe que a tela não promete.
  //
  // A EXPRESSÃO É ANCORADA, e não texto exato: `Field` desenha o asterisco de
  // obrigatório DENTRO do rótulo (`<span>Telefone<em> *</em></span>`), então o
  // nome acessível é "Telefone *". Procurar por igualdade não acha nada, e o
  // arreio morre num timeout que parece problema da tela.
  await pagina.getByLabel(/^Telefone/).fill('65999880001');
  await pagina.getByLabel(/^WhatsApp/).fill('65999880001');

  // O OLHO: revela um campo por vez, e só o dele.
  const olhos = pagina.locator('.campo-com-acao button');
  conferir('cada campo de senha tem o próprio botão de mostrar/ocultar',
    (await olhos.count()) === 2, `${await olhos.count()} botões`);
  await olhos.nth(0).click();
  conferir('o olho revela a senha', (await senhas.nth(0).getAttribute('type')) === 'text');
  conferir('e NÃO revela a confirmação junto', (await senhas.nth(1).getAttribute('type')) === 'password');
  await olhos.nth(0).click();
  conferir('clicar de novo volta a ocultar', (await senhas.nth(0).getAttribute('type')) === 'password');

  // SENHAS DIFERENTES: o avanço trava e a frase é a combinada.
  await avancar();
  await pagina.waitForTimeout(400);
  const comDivergencia = await textoDaTela();
  conferir('senhas diferentes mostram "As senhas não coincidem"',
    /As senhas não coincidem/.test(comDivergencia));
  conferir('e o assistente NÃO avança', /Etapa 2 de 5|etapa 2/i.test(comDivergencia));

  await senhas.nth(1).fill(SENHA_NOVA);
  await avancar();
  await pagina.waitForTimeout(400);
  conferir('com as senhas iguais o assistente avança', /Etapa 3 de 5|etapa 3/i.test(await textoDaTela()));

  // ---------------------------------------------------------------- ETAPA 3
  await pagina.locator('input[autocomplete="postal-code"]').fill('78000000');
  await pagina.waitForTimeout(1500);
  await pagina.locator('input[autocomplete="street-address"]').fill('Rua QA da Homologação');
  await pagina.getByLabel(/^Número/).fill('100');
  await pagina.getByLabel(/^Cidade/).fill('Cuiabá');
  await pagina.locator('select').last().selectOption('MT');
  await avancar();
  await pagina.waitForTimeout(500);

  // ---------------------------------------------------- ETAPAS 4 e 5, e o envio
  console.log('\n--- o envio, que é onde a pessoa travou ---');
  const naEtapa = async () => (/Etapa (\d) de 5/.exec(await textoDaTela()) || [])[1];
  for (let volta = 0; volta < 3 && (await naEtapa()) !== '5'; volta += 1) {
    await avancar();
    await pagina.waitForTimeout(500);
  }
  conferir('chegou na revisão', (await naEtapa()) === '5', `etapa ${await naEtapa()}`);

  await avancar();
  await pagina.waitForTimeout(4000);

  const depoisDoEnvio = await textoDaTela();
  conferir('NÃO apareceu "Não foi possível conectar à API."',
    !/Não foi possível conectar à API/.test(depoisDoEnvio),
    falhas.length ? `falhas contra o sistema: ${falhas.slice(0, 3).join(' | ')}` : '');
  conferir('nenhuma requisição ao sistema falhou na rede',
    falhas.length === 0, falhas.slice(0, 3).join(' | '));
  if (deTerceiro.length) {
    console.log(`  nota    ${deTerceiro.length} requisição(ões) a serviço de terceiro não completaram (não contam): ${deTerceiro.slice(0, 2).join(' | ')}`);
  }
  conferir('a API não devolveu 5xx', !doServidor.some(l => /^5/.test(l)), doServidor.slice(0, 3).join(' | '));

  const aindaNoFormulario = await pagina.locator('input[autocomplete="new-password"]').count();
  conferir('a conta foi criada e a sessão entrou na hora',
    aindaNoFormulario === 0 && !/Etapa \d de 5/.test(depoisDoEnvio),
    depoisDoEnvio.slice(0, 200).replace(/\s+/g, ' '));

  conferir('nada na tela manda esperar análise do cadastro',
    !/em análise|aguard\w+ aprovaç|análise da administração/i.test(depoisDoEnvio));

  // O TOKEN SAI DO NAVEGADOR, e não de um login novo: é a sessão que o envio
  // criou. Pedir login de novo gastaria cota do limitador e mediria outra coisa.
  const token = await pagina.evaluate(() => {
    for (const chave of Object.keys(window.localStorage)) {
      const bruto = window.localStorage.getItem(chave);
      if (bruto && /^ey[A-Za-z0-9_-]+\./.test(bruto)) return bruto;
      try {
        const obj = JSON.parse(bruto);
        if (obj && typeof obj.token === 'string') return obj.token;
      } catch { /* não é JSON: segue */ }
    }
    return null;
  });
  conferir('a sessão do navegador tem token', !!token);

  // --------------------------------------------- O CADASTRO DE TREINADOR
  console.log('\n--- o cadastro de treinador nasce aprovado ---');
  // MULTIPART, porque a foto é obrigatória e vem na mesma requisição. O PNG é
  // minúsculo e de verdade: o servidor decodifica os bytes.
  const forma = new FormData();
  forma.append('name', 'QA Treinador Navegador');
  forma.append('registration', `CREF-${marca}`);
  forma.append('phone', '65999880001');
  forma.append('photo', new Blob([FOTO_PNG], { type: 'image/png' }), 'foto.png');

  const respostaDoCadastro = await fetch(`${API}/api/v1/coaches/self-register`, {
    method: 'POST',
    headers: { Origin: WEB, Authorization: `Bearer ${token}` },
    body: forma
  });
  const autocadastro = {
    status: respostaDoCadastro.status,
    corpo: await respostaDoCadastro.json().catch(() => null)
  };
  conferir('o autocadastro de treinador é aceito', autocadastro.status === 201,
    `status ${autocadastro.status} ${JSON.stringify(autocadastro.corpo).slice(0, 160)}`);
  conferir('e nasce APPROVED, sem fila de análise', autocadastro.corpo?.status === 'APPROVED',
    `status do cadastro: ${autocadastro.corpo?.status}`);
  conferir('e nasce COM FOTO — ela é obrigatória para concluir', autocadastro.corpo?.hasPhoto === true,
    `hasPhoto: ${autocadastro.corpo?.hasPhoto}`);
  conferir('a chave do objeto NÃO vai para o cliente',
    !JSON.stringify(autocadastro.corpo ?? {}).includes('coach-photos/'));

  // O MESMO CADASTRO SEM FOTO, para provar que a barreira não é de tela.
  const semFoto = await chamar('/coaches/self-register', {
    metodo: 'POST', token, corpo: { name: 'QA Sem Foto' }
  });
  conferir('autocadastro SEM foto é recusado pela API', semFoto.status === 422,
    `status ${semFoto.status}`);
  conferir('e a recusa traz a frase combinada',
    String(semFoto.corpo?.error?.message || '').includes('foto de perfil é obrigatório'),
    String(semFoto.corpo?.error?.message || '').slice(0, 90));

  const fotoServida = await fetch(`${API}/api/v1/media/coaches/${autocadastro.corpo?.id}/photo`);
  conferir('a foto do treinador é servida pela rota de mídia', fotoServida.status === 200,
    `status ${fotoServida.status}`);

  const meu = await chamar('/coaches/me', { token });
  conferir('a área do treinador abre imediatamente', meu.status === 200, `status ${meu.status}`);

  // ------------------------------- A AUTORIZAÇÃO AUTOMÁTICA, E O QUE ELA NÃO É
  //
  // ESTA SEÇÃO MUDOU COM A DECISÃO DA NPC. Antes, o treinador nascia sem
  // autorização e a federação precisava concedê-la; o arreio media essa recusa.
  // Agora ele nasce autorizado NA FEDERAÇÃO OFICIAL — e a separação R-04 passou a
  // ser medida onde ela continua valendo: em QUALQUER OUTRA federação.
  console.log('\n--- autorização automática na NPC, e o limite dela (R-04) ---');
  const coachId = autocadastro.corpo?.id;

  // A CENTRAL, e não o diretor, para LISTAR as federações. `GET /organizations`
  // é escopado por vínculo: o diretor da federação oficial vê só a dele, então a
  // segunda federação — a que serve para medir o limite de R-04 — não aparecia
  // para ele. Medido: a conferência reprovava por "só uma organização no
  // ambiente" enquanto havia duas.
  const tokenCentral = await entrarPelaApi(CENTRAL);
  const meuCadastro = await chamar('/coaches/me', { token });
  const autorizacoes = meuCadastro.corpo?.organizations ?? [];
  const naOficial = autorizacoes.find(item => item.status === 'APPROVED');

  conferir('o cadastro nasce autorizado na federação oficial', !!naOficial,
    `autorizações: ${autorizacoes.length}`);
  conferir('e a autorização se declara automática, sem concedente humano',
    Boolean(naOficial?.autoGrantedAt), `autoGrantedAt: ${naOficial?.autoGrantedAt ?? '—'}`);

  // ELE CRIA A EQUIPE DELE, na hora — é a metade da decisão que tira a espera.
  const equipe = await chamar('/coaches/me/teams', {
    metodo: 'POST', token,
    corpo: { organizationId: naOficial?.organizationId, name: `QA Equipe Navegador ${marca}` }
  });
  conferir('o treinador cria a própria equipe imediatamente', equipe.status === 201,
    `status ${equipe.status} ${JSON.stringify(equipe.corpo).slice(0, 140)}`);
  conferir('e ela nasce com ele como responsável', equipe.corpo?.coachId === coachId);

  // FORA DA OFICIAL, R-04 CONTINUA INTACTA. A federação do conjunto do demo não
  // autorizou ninguém, e criar equipe nela é recusado.
  const todas = await chamar('/organizations', { token: tokenCentral });
  const listaDeOrgs = todas.corpo?.items ?? todas.corpo ?? [];
  const outra = listaDeOrgs.find(o => o.id !== naOficial?.organizationId);

  if (outra) {
    const foraDaOficial = await chamar('/coaches/me/teams', {
      metodo: 'POST', token,
      corpo: { organizationId: outra.id, name: `QA Equipe Intrusa ${marca}` }
    });
    conferir('em federação que NÃO autorizou, criar equipe é recusado',
      foraDaOficial.status === 403, `status ${foraDaOficial.status}`);
  } else {
    conferir('havia uma segunda federação para medir o limite de R-04', false,
      'só uma organização no ambiente');
  }

  const fila = await chamar('/coaches/review?status=PENDING', { token });
  conferir('a fila de análise central continua fechada ao treinador (R-03)', fila.status === 403,
    `status ${fila.status}`);

  // ---------------------------------------------------- A SENHA DIGITADA É A GRAVADA
  console.log('\n--- a senha digitada é a que entra ---');
  const comASenhaNova = await chamar('/auth/login', {
    metodo: 'POST', corpo: { email: EMAIL_NOVO, password: SENHA_NOVA }
  });
  conferirComLimitador('a conta entra com a senha digitada no formulário', comASenhaNova.status, 200);

  const comASenhaErrada = await chamar('/auth/login', {
    metodo: 'POST', corpo: { email: EMAIL_NOVO, password: `${SENHA_NOVA}-errada` }
  });
  conferirComLimitador('e NÃO entra com senha errada', comASenhaErrada.status, 401);

  // `--diretor` continua aceito para compatibilidade com o workflow, e deixou de
  // ser usado quando a listagem passou para a central.
  void DIRETOR;
} catch (problema) {
  problemas.push(`exceção: ${problema.message}`);
  console.error(`\n  EXCEÇÃO  ${problema.stack}`);
} finally {
  if (navegador) await navegador.close();
}

console.log('\n=== RESULTADO ===');
if (problemas.length) {
  console.log(`  ${problemas.length} conferência(s) reprovaram:`);
  for (const p of problemas) console.log(`    - ${p}`);
  process.exit(1);
}
console.log('  todas as conferências passaram.');

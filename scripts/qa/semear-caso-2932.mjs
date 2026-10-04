#!/usr/bin/env node
// ============================================================================
// O CASO 2932, SEMEADO NO AMBIENTE DE PREVIEW — PARA TESTE HUMANO.
//
// Monta, pela API REAL e com dados FICTÍCIOS, o estado exato que a homologação
// da consolidação por filiação + matrícula pede para ser testada à mão:
//
//   * três resultados da MESMA matrícula (2932) na MESMA filiação, importados
//     ANTES de existir cadastro, sob TRÊS GRAFIAS diferentes do nome;
//   * uma linha SEM matrícula, que NÃO pode ser fundida;
//   * uma linha com a MESMA matrícula em OUTRA filiação, que também não pode;
//   * o cadastro do atleta SEM filiação — o estado que quebrava;
//   * um homônimo com matrícula diferente, como controle.
//
// O que a pessoa faz depois, pela interface: abre o perfil, preenche entidade
// de filiação + matrícula 2932, salva. O histórico tem de vir junto sozinho.
//
// NÃO É PRODUÇÃO. Nenhum nome, CPF ou resultado aqui corresponde a pessoa real:
// o CPF é gerado por algoritmo a partir de uma semente fixa e os campeonatos
// não existem. O ambiente de preview é público, e por isso nada real entra.
//
// Uso:
//   DEMO_ADMIN_PASSWORD='…' node scripts/qa/semear-caso-2932.mjs \
//     --api http://127.0.0.1:4000/api/v1 --admin-email semeadura.qa@mci.local
// ============================================================================

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const API = arg('api', 'http://127.0.0.1:4000/api/v1');
const EMAIL = arg('admin-email', env.DEMO_ADMIN_EMAIL);
const SENHA = env.DEMO_ADMIN_PASSWORD || env.DEMO_PASSWORD;

if (!EMAIL || !SENHA) {
  console.error('\n  Falta --admin-email e/ou DEMO_ADMIN_PASSWORD.\n');
  console.error('  A senha vem por variável de ambiente, nunca por argumento:');
  console.error('  argumento aparece em `ps` para qualquer usuário da máquina.\n');
  process.exit(1);
}

let token = null;
async function chamar(metodo, rota, corpo) {
  const resposta = await fetch(API + rota, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await resposta.text();
  let dado;
  try { dado = texto ? JSON.parse(texto) : null; } catch { dado = texto; }
  return { status: resposta.status, dado };
}

const exigir = (resposta, oque) => {
  if (resposta.status >= 400) {
    throw new Error(`${oque}: ${resposta.status} ${JSON.stringify(resposta.dado).slice(0, 300)}`);
  }
  return resposta.dado;
};

// CPF VÁLIDO PELO ALGORITMO, FICTÍCIO POR CONSTRUÇÃO. A semente é fixa para o
// ambiente ser reproduzível; o número não pertence a pessoa nenhuma.
const cpfDeSemente = semente => {
  const n = String(semente).padStart(9, '0').slice(0, 9).split('').map(Number);
  const d1 = (() => {
    let s = 0;
    for (let i = 0; i < 9; i += 1) s += n[i] * (10 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  })();
  const d2 = (() => {
    const c = [...n, d1];
    let s = 0;
    for (let i = 0; i < 10; i += 1) s += c[i] * (11 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  })();
  return [...n, d1, d2].join('');
};

const lista = resposta => {
  const d = resposta?.dado ?? resposta;
  return Array.isArray(d) ? d : (d?.items ?? d?.data ?? []);
};

async function filiacao(organizationId, name, code) {
  const criada = await chamar('POST', '/affiliations', { organizationId, name, code });
  if (criada.status < 400) return criada.dado;
  const existente = lista(await chamar('GET', `/affiliations?organizationId=${organizationId}`))
    .find(f => f.code === code);
  if (existente) return existente;
  throw new Error(`filiação ${code}: ${criada.status} ${JSON.stringify(criada.dado).slice(0, 200)}`);
}

async function principal() {
  token = exigir(await chamar('POST', '/auth/login', { email: EMAIL, password: SENHA }), 'login').token;

  const org = lista(await chamar('GET', '/organizations'))[0];
  if (!org) throw new Error('nenhuma organização visível para este ator');

  const mt = await filiacao(org.id, 'QA · Federação Mato-grossense (2932)', 'QA-MT');
  const sp = await filiacao(org.id, 'QA · Federação Paulista (2932)', 'QA-SP');

  const temporada = exigir(await chamar('POST', '/seasons', {
    organizationId: org.id, name: 'QA · Caso 2932 — Temporada', year: 2025
  }), 'temporada');

  // A TABELA DE PONTOS É A REGRA EXISTENTE. Este script não inventa pontuação:
  // ele declara a tabela da temporada, que é o que a organização faz.
  exigir(await chamar('PUT', `/seasons/${temporada.id}/points-rules`, {
    rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }]
  }), 'tabela de pontos');

  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,overall,evento';
  const conteudo = [
    CABECALHO,
    'QA-2932-A,,Lucas Lima,QA-MT,2932,MENS_BODYBUILDING,OPEN,2,80,,QA Campeonato Centro-Oeste',
    'QA-2932-B,,Lucas de Lima,QA-MT,2932,MENS_BODYBUILDING,OPEN,1,100,sim,QA Campeonato Nacional',
    'QA-2932-C,,LÚCAS GOUVÊIA LIMA,QA-MT,2932,MENS_BODYBUILDING,MASTER,3,60,,QA Copa Pantanal',
    // sem matrícula: nenhuma regra automática alcança, e está certo assim
    'QA-2932-SEM,,Lucas Lima,QA-MT,,MENS_BODYBUILDING,OPEN,1,100,,QA Copa Sem Matricula',
    // mesma matrícula, OUTRA filiação: é outra pessoa
    'QA-2932-SP,,Lucas Lima,QA-SP,2932,MENS_BODYBUILDING,OPEN,1,100,,QA Campeonato Paulista'
  ].join('\n');

  const lote = exigir(await chamar('POST', '/musclewar/imports', {
    organizationId: org.id, seasonId: temporada.id, sourceType: 'CSV',
    sourceRef: 'qa-caso-2932.csv', content: conteudo
  }), 'criar lote');
  const importId = lote.import?.id ?? lote.id;
  exigir(await chamar('POST', `/musclewar/imports/${importId}/apply`), 'aplicar lote');

  // O CADASTRO NASCE SEM FILIAÇÃO. É o estado que quebrava, e é o que a pessoa
  // vai corrigir pela tela.
  const lucas = exigir(await chamar('POST', '/athletes', {
    organizationId: org.id,
    fullName: 'Lucas Gouveia Lima',
    cpf: cpfDeSemente(293200001),
    sex: 'MALE', birthDate: '1994-03-11', state: 'MT', city: 'Cuiabá'
  }), 'cadastro do Lucas');

  // Controle: MESMO NOME da fonte, matrícula DIFERENTE. Não pode levar nada.
  const homonimo = exigir(await chamar('POST', '/athletes', {
    organizationId: org.id,
    fullName: 'Lucas Lima',
    cpf: cpfDeSemente(999900002),
    sex: 'MALE', birthDate: '1990-01-20', state: 'MT', city: 'Cuiabá',
    affiliationId: mt.id, affiliationNumber: '9999'
  }), 'homônimo de controle');

  console.log('CASO_2932_ATLETA_ID=' + lucas.id);
  console.log('CASO_2932_HOMONIMO_ID=' + homonimo.id);
  console.log('CASO_2932_TEMPORADA_ID=' + temporada.id);
  console.log('CASO_2932_FILIACAO=' + mt.name);
  console.log('CASO_2932_ORG_ID=' + org.id);
  console.log('');
  console.log('=== CASO 2932 SEMEADO ===');
  console.log(`  atleta SEM filiação:  ${lucas.fullName}  (${lucas.id})`);
  console.log(`  filiação a escolher:  ${mt.name}`);
  console.log('  matrícula a digitar:  2932');
  console.log('  esperado ao salvar:   3 resultados vinculados, 250 pontos');
  console.log('                        (240 de colocação + 10 de bônus de Overall)');
  console.log('  NÃO deve acontecer:   a linha sem matrícula entrar,');
  console.log(`                        a matrícula 2932 da ${sp.name} entrar,`);
  console.log(`                        o homônimo de matrícula 9999 receber nada`);
}

principal().catch(erro => {
  console.error(`FALHOU: ${erro.message}`);
  process.exitCode = 1;
});

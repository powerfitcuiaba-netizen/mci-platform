#!/usr/bin/env node
// ==========================================================================
// Diagnóstico do armazenamento compatível com S3 (Cloudflare R2, MinIO, S3…).
//
// Existe porque `/ready` responde `storage: false` e isso, sozinho, não diz o
// que corrigir. Aqui o ciclo inteiro é exercitado — HEAD, PUT, HEAD, GET,
// DELETE, HEAD — e cada passo informa o status HTTP e o `<Code>` do serviço.
//
// Rode no mesmo ambiente da aplicação, onde as variáveis já existem:
//
//     node scripts/diagnostico-r2.js
//
// NENHUM SEGREDO É IMPRESSO. A Access Key aparece apenas com os quatro
// últimos caracteres, para você confirmar QUAL chave está em uso sem expor
// nenhuma. O Secret nunca é impresso, nem parcialmente. O corpo bruto das
// respostas de erro também não: dele saem só `<Code>` e `<Message>`, porque o
// XML de erro de credencial carrega a Access Key inteira.
//
// O objeto de teste tem chave própria e datada, e é apagado no fim. Nada mais
// no bucket é tocado — não há listagem, não há remoção em massa.
// ==========================================================================

const { S3StorageProvider } = require('../src/services/storage/s3StorageProvider');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const VERMELHO = s => `\x1b[31m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

const cauda = valor => (valor ? `…${String(valor).slice(-4)}` : '(ausente)');

function lerAmbiente() {
  const bruto = {
    driver: process.env.STORAGE_DRIVER,
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE
  };

  // Espaço ou quebra de linha no fim do valor é o defeito de configuração mais
  // comum e o mais difícil de ver: o painel aceita, o olho não percebe, e a
  // assinatura passa a ser calculada sobre uma chave que termina em "\n".
  const sujos = Object.entries(bruto)
    .filter(([, valor]) => typeof valor === 'string' && valor !== valor.trim())
    .map(([nome]) => nome);

  return { bruto, sujos };
}

function descreverConfiguracao({ bruto, sujos }) {
  console.log('\n=== CONFIGURAÇÃO LIDA DO AMBIENTE ===\n');
  console.log(`  STORAGE_DRIVER ......... ${bruto.driver || VERMELHO('(ausente)')}`);
  console.log(`  S3_ENDPOINT ............ ${bruto.endpoint || VERMELHO('(ausente)')}`);
  console.log(`  S3_BUCKET .............. ${bruto.bucket || VERMELHO('(ausente)')}`);
  console.log(`  S3_REGION .............. ${bruto.region || CINZA('(ausente — usará us-east-1)')}`);
  console.log(`  S3_FORCE_PATH_STYLE .... ${bruto.forcePathStyle ?? CINZA('(ausente — usará true)')}`);
  console.log(`  S3_ACCESS_KEY_ID ....... ${cauda(bruto.accessKeyId)}   ${CINZA('(só os 4 últimos)')}`);
  console.log(`  S3_SECRET_ACCESS_KEY ... ${bruto.secretAccessKey ? CINZA('definido (nunca impresso)') : VERMELHO('(ausente)')}`);

  const avisos = [];
  if (sujos.length) {
    avisos.push(`espaço ou quebra de linha sobrando em: ${sujos.join(', ')} — remova e salve de novo`);
  }
  if (bruto.region && bruto.region !== 'auto' && /r2\.cloudflarestorage\.com/.test(bruto.endpoint || '')) {
    avisos.push(`o endpoint é do Cloudflare R2, que exige S3_REGION=auto — está "${bruto.region}"`);
  }
  if (/\/[^/]+\/?$/.test(String(bruto.endpoint || '').replace(/^https?:\/\/[^/]+/, '')) ) {
    avisos.push('o S3_ENDPOINT parece incluir um caminho: use só o host da conta, sem o bucket');
  }
  if (bruto.driver && bruto.driver !== 's3') {
    avisos.push(`STORAGE_DRIVER é "${bruto.driver}", então este diagnóstico não reflete o que a API usa`);
  }

  if (avisos.length) {
    console.log(`\n  ${VERMELHO('Atenção:')}`);
    for (const aviso of avisos) console.log(`    - ${aviso}`);
  }
  return avisos;
}

async function passo(rotulo, acao) {
  process.stdout.write(`  ${rotulo.padEnd(34)}`);
  try {
    const valor = await acao();
    console.log(VERDE('OK') + (valor === undefined ? '' : CINZA(`  ${valor}`)));
    return { ok: true, valor };
  } catch (erro) {
    const diag = erro?.diagnosticoStorage;
    const detalhe = diag
      ? `HTTP ${diag.statusHttp}${diag.codigoS3 ? ` (${diag.codigoS3})` : ''}`
      : (erro?.cause?.code || erro?.code || erro?.message || 'erro desconhecido');
    console.log(VERMELHO('FALHOU') + `  ${detalhe}`);
    return { ok: false, erro, detalhe };
  }
}

async function main() {
  const ambiente = lerAmbiente();
  descreverConfiguracao(ambiente);

  const { bruto } = ambiente;
  if (!bruto.endpoint || !bruto.bucket || !bruto.accessKeyId || !bruto.secretAccessKey) {
    console.log(`\n${VERMELHO('PARADO')}: faltam variáveis obrigatórias. Nada foi enviado ao serviço.\n`);
    process.exitCode = 2;
    return;
  }

  const provider = new S3StorageProvider({
    endpoint: bruto.endpoint.trim(),
    region: (bruto.region || '').trim() || undefined,
    bucket: bruto.bucket.trim(),
    accessKeyId: bruto.accessKeyId.trim(),
    secretAccessKey: bruto.secretAccessKey.trim(),
    forcePathStyle: String(bruto.forcePathStyle ?? 'true').trim() !== 'false'
  });

  const chave = `.mci-qa/r2-healthcheck-${Date.now()}`;
  const conteudo = Buffer.from(`diagnostico mci ${new Date().toISOString()}\n`);

  console.log('\n=== CICLO COMPLETO CONTRA O SERVIÇO ===\n');
  console.log(CINZA(`  objeto de teste: ${chave}\n`));

  const r = {};
  r.health = await passo('healthCheck (HEAD inexistente)', () => provider.healthCheck());
  r.put = await passo('PUT   grava o objeto', async () => {
    const saida = await provider.saveBuffer(chave, conteudo);
    return `${saida.sizeBytes} bytes`;
  });
  r.head = await passo('HEAD  confirma que existe', async () => (await provider.exists(chave)) ? 'existe' : 'NÃO existe');
  r.stat = await passo('STAT  tamanho e data', async () => {
    const info = await provider.stat(chave);
    return info ? `${info.sizeBytes} bytes` : 'sem metadados';
  });
  r.get = await passo('GET   lê de volta', async () => {
    const stream = await provider.createReadStream(chave);
    const pedacos = [];
    for await (const pedaco of stream) pedacos.push(pedaco);
    const lido = Buffer.concat(pedacos);
    if (!lido.equals(conteudo)) throw new Error('o conteúdo lido difere do gravado');
    return `${lido.length} bytes idênticos`;
  });
  r.del = await passo('DELETE remove o objeto', () => provider.remove(chave));
  r.sumiu = await passo('HEAD  confirma que sumiu', async () => (await provider.exists(chave)) ? 'AINDA existe' : 'removido');

  const falhas = Object.values(r).filter(x => !x.ok);
  console.log('');

  if (!falhas.length) {
    console.log(VERDE('  ARMAZENAMENTO OK') + ' — o ciclo inteiro passou e o objeto de teste foi removido.\n');
    return;
  }

  process.exitCode = 1;
  const primeira = falhas[0];
  const status = primeira.erro?.diagnosticoStorage?.statusHttp;
  const codigo = primeira.erro?.diagnosticoStorage?.codigoS3;

  console.log(`  ${VERMELHO('ARMAZENAMENTO COM FALHA')} — primeira falha: ${primeira.detalhe}\n`);
  console.log('  O que isso costuma significar:\n');

  const pistas = {
    InvalidAccessKeyId: 'a Access Key não existe no serviço. No R2, confira se você usou as credenciais\n    do token de R2 (que gera Access Key + Secret) e não um Account API Token.',
    SignatureDoesNotMatch: 'a Secret não corresponde à Access Key, ou algum valor tem espaço/quebra de linha\n    sobrando. Recadastre o par inteiro, colando sem espaços.',
    AccessDenied: 'a credencial é válida, mas o token não tem permissão neste bucket. Confira se o\n    token foi aplicado a ESTE bucket e com Object Read & Write.',
    NoSuchBucket: 'o bucket não existe nesta conta. Confira S3_BUCKET e se o endpoint é da conta certa.'
  };

  if (codigo && pistas[codigo]) console.log(`    ${pistas[codigo]}`);
  else if (status === 401 || status === 403) console.log('    credencial recusada ou sem permissão no bucket.');
  else if (status === 404) console.log('    o serviço respondeu, mas o recurso não existe — confira o bucket.');
  else if (status >= 500) console.log('    indisponibilidade do provedor. Não há o que corrigir na aplicação.');
  else console.log('    não houve resposta HTTP: rede, DNS ou endpoint inalcançável a partir daqui.');

  console.log(`\n  ${CINZA('O objeto de teste pode ter ficado para trás se a remoção não chegou a rodar:')}`);
  console.log(`  ${CINZA(chave)}\n`);
}

main().catch(erro => {
  console.error(`\n${VERMELHO('erro inesperado no diagnóstico')}: ${erro.message}\n`);
  process.exitCode = 1;
});

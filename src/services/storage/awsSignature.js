const crypto = require('crypto');

// ============================================================================
// Assinatura AWS Signature Version 4.
//
// Escrita à mão em vez de trazer o SDK da AWS: o provedor usa quatro verbos
// HTTP e nada mais, e o SDK adicionaria dezenas de megabytes de dependência
// transitiva à imagem para assinar quatro requisições. O algoritmo é público e
// estável, e o teste confere a implementação contra o vetor oficial da AWS.
//
// Vale para qualquer serviço compatível com S3 — MinIO, R2, Spaces, Backblaze,
// o próprio S3 —, porque todos falam o mesmo protocolo de assinatura.
// ============================================================================

const sha256Hex = dados => crypto.createHash('sha256').update(dados).digest('hex');
const hmac = (chave, dados) => crypto.createHmac('sha256', chave).update(dados).digest();

// Cada segmento do caminho é codificado, mas as barras permanecem: elas são a
// estrutura do caminho, não conteúdo. `encodeURIComponent` deixa passar alguns
// caracteres que a AWS exige codificados, daí o ajuste.
function codificarCaminho(caminho) {
  return String(caminho || '/')
    .split('/')
    .map(segmento => encodeURIComponent(segmento).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function instanteAmz(agora = new Date()) {
  const iso = agora.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dataCurta: iso.slice(0, 8) };
}

/**
 * Assina uma requisição e devolve os cabeçalhos que ela precisa carregar.
 *
 * @param {Object} req
 * @param {string} req.method    Verbo HTTP.
 * @param {string} req.host      Host de destino, sem esquema.
 * @param {string} req.path      Caminho, começando com barra.
 * @param {string} req.payloadHash sha256 do corpo em hexadecimal, usado na
 *                                requisição canônica (não vira cabeçalho aqui).
 * @param {Object} req.headers   Cabeçalhos adicionais a assinar.
 * @param {Object} credenciais   { accessKeyId, secretAccessKey, region, service }
 */
function assinar({ method, host, path: caminho, query = '', payloadHash, headers = {} }, credenciais, agora = new Date()) {
  const { amzDate, dataCurta } = instanteAmz(agora);
  const { accessKeyId, secretAccessKey, region, service = 's3' } = credenciais;

  // Só `host` e `x-amz-date` são universais. `x-amz-content-sha256` é exigência
  // do S3 e entra pelo provider, não aqui: o assinador precisa ser genérico o
  // bastante para bater com o vetor oficial da AWS, que não o inclui.
  const cabecalhos = {
    host,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([nome, valor]) => [nome.toLowerCase(), String(valor)]))
  };

  const nomesOrdenados = Object.keys(cabecalhos).sort();
  const cabecalhosCanonicos = nomesOrdenados.map(nome => `${nome}:${String(cabecalhos[nome]).trim()}\n`).join('');
  const cabecalhosAssinados = nomesOrdenados.join(';');

  const requisicaoCanonica = [
    method.toUpperCase(),
    codificarCaminho(caminho),
    query,
    cabecalhosCanonicos,
    cabecalhosAssinados,
    payloadHash
  ].join('\n');

  const escopo = `${dataCurta}/${region}/${service}/aws4_request`;
  const stringParaAssinar = [
    'AWS4-HMAC-SHA256',
    amzDate,
    escopo,
    sha256Hex(requisicaoCanonica)
  ].join('\n');

  const chaveData = hmac(`AWS4${secretAccessKey}`, dataCurta);
  const chaveRegiao = hmac(chaveData, region);
  const chaveServico = hmac(chaveRegiao, service);
  const chaveAssinatura = hmac(chaveServico, 'aws4_request');
  const assinatura = crypto.createHmac('sha256', chaveAssinatura).update(stringParaAssinar).digest('hex');

  return {
    ...cabecalhos,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${escopo}, SignedHeaders=${cabecalhosAssinados}, Signature=${assinatura}`
  };
}

module.exports = { assinar, sha256Hex, codificarCaminho };

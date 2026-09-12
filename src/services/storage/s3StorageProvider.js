const { Readable } = require('stream');
const { AppError } = require('../../utils/errors');
const { assinar, sha256Hex, codificarCaminho } = require('./awsSignature');

// ============================================================================
// Armazenamento em serviço compatível com S3.
//
// Implementa o mesmo contrato do LocalStorageProvider, então nada acima dele
// muda: os services continuam chamando storage.saveBuffer/createReadStream.
//
// Serve S3, MinIO, Cloudflare R2, DigitalOcean Spaces e Backblaze B2 — todos
// falam o mesmo protocolo. O endpoint é configurável justamente para isso.
//
// Nenhuma credencial aparece aqui: tudo vem do ambiente, e o provedor só é
// construído quando STORAGE_DRIVER=s3.
// ============================================================================

// Erro de serviço compatível com S3 vem em XML. Só dois elementos interessam,
// e nenhum deles é sensível: `<Code>` diz O QUE houve (InvalidAccessKeyId,
// SignatureDoesNotMatch, AccessDenied, NoSuchBucket) e `<Message>` explica em
// texto. O restante do corpo pode conter a Access Key e fica de fora.
function interpretarErroS3(corpo) {
  const texto = String(corpo || '');
  const pegar = etiqueta => (new RegExp(`<${etiqueta}>([^<]{0,200})</${etiqueta}>`, 'i').exec(texto) || [])[1] || '';
  return { codigo: pegar('Code').trim(), mensagem: pegar('Message').trim() };
}

class S3StorageProvider {
  constructor({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('provedor S3 exige endpoint, bucket, accessKeyId e secretAccessKey');
    }

    this.name = 's3';
    this.bucket = bucket;
    this.region = region || 'us-east-1';
    this.credenciais = { accessKeyId, secretAccessKey, region: this.region, service: 's3' };

    const url = new URL(endpoint);
    this.protocolo = url.protocol;
    this.hostBase = url.host;
    // Caminho (`host/bucket/chave`) é o que MinIO e a maioria dos compatíveis
    // usam; virtual-hosted (`bucket.host/chave`) é o padrão do S3 moderno.
    this.forcePathStyle = forcePathStyle;
  }

  // A chave é gerada pelo servidor, mas a conferência permanece: nada que
  // suba na hierarquia entra no caminho remoto.
  resolveKey(key) {
    const limpa = String(key || '').replace(/^\/+/, '');
    if (!limpa || limpa.split('/').some(parte => parte === '..' || parte === '.')) {
      throw new AppError(400, 'INVALID_STORAGE_KEY', 'Caminho de armazenamento inválido');
    }
    return limpa;
  }

  #destino(key) {
    const chave = this.resolveKey(key);
    if (this.forcePathStyle) {
      return { host: this.hostBase, caminho: `/${this.bucket}/${chave}` };
    }
    return { host: `${this.bucket}.${this.hostBase}`, caminho: `/${chave}` };
  }

  async #requisitar(method, key, { corpo = null, aceitarAusente = false } = {}) {
    const { host, caminho } = this.#destino(key);
    const payload = corpo ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);

    const cabecalhos = assinar(
      {
        method,
        host,
        path: caminho,
        query: '',
        payloadHash,
        headers: {
          'x-amz-content-sha256': payloadHash,
          ...(corpo ? { 'content-length': String(payload.length) } : {})
        }
      },
      this.credenciais
    );

    const resposta = await fetch(`${this.protocolo}//${host}${codificarCaminho(caminho)}`, {
      method,
      headers: cabecalhos,
      ...(corpo ? { body: payload } : {})
    });

    if (resposta.status === 404 && aceitarAusente) return null;

    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => '');
      const { codigo, mensagem } = interpretarErroS3(corpo);

      // O corpo BRUTO não entra na mensagem nem nos detalhes. Erros S3 de
      // credencial trazem a Access Key dentro do XML (`<AWSAccessKeyId>`), e
      // esta mensagem chega ao log — que é colado em chamado, em issue e em
      // conversa. `<Code>` e `<Message>` carregam o diagnóstico inteiro e
      // nenhum segredo, então são eles que saem daqui.
      const erro = new AppError(502, 'STORAGE_UNAVAILABLE',
        `Armazenamento respondeu ${resposta.status}${codigo ? ` (${codigo})` : ''} para ${method} ${key}`
        + `${mensagem ? `: ${mensagem}` : ''}`);

      // Propriedade INTERNA, de propósito. `details` não serve: o AppError o
      // ignora no construtor, e o errorHandler encaminharia o campo para o
      // cliente até em resposta 5xx. Isto aqui só é lido pela sonda /ready.
      erro.diagnosticoStorage = { statusHttp: resposta.status, codigoS3: codigo || null };
      throw erro;
    }

    return resposta;
  }

  async saveBuffer(key, buffer) {
    const conteudo = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    await this.#requisitar('PUT', key, { corpo: conteudo });
    return { key: this.resolveKey(key), sizeBytes: conteudo.length };
  }

  // O upload já chega em buffer (o middleware limita o tamanho antes), então
  // aqui o stream é apenas coletado. Envio em partes só faria sentido com o
  // teto de upload muito maior do que é hoje.
  async saveStream(key, readable) {
    const pedacos = [];
    for await (const pedaco of readable) pedacos.push(pedaco);
    return this.saveBuffer(key, Buffer.concat(pedacos));
  }

  async createReadStream(key) {
    const resposta = await this.#requisitar('GET', key);
    return Readable.fromWeb(resposta.body);
  }

  async exists(key) {
    const resposta = await this.#requisitar('HEAD', key, { aceitarAusente: true });
    return resposta !== null;
  }

  async remove(key) {
    await this.#requisitar('DELETE', key);
    return true;
  }

  async stat(key) {
    const resposta = await this.#requisitar('HEAD', key, { aceitarAusente: true });
    if (!resposta) return null;

    const tamanho = Number(resposta.headers.get('content-length') || 0);
    const modificado = resposta.headers.get('last-modified');
    return { sizeBytes: tamanho, modifiedAt: modificado ? new Date(modificado) : null };
  }

  // Lê uma chave que não existe: a resposta 404 prova que o bucket responde e
  // que a credencial é aceita. Um 403 viria como erro, que é o que se quer —
  // credencial errada não pode passar por "saudável".
  async healthCheck() {
    await this.#requisitar('HEAD', '.mci-healthcheck', { aceitarAusente: true });
    return true;
  }
}

module.exports = { S3StorageProvider, interpretarErroS3 };

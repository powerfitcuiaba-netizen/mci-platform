import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assinar, sha256Hex } = require('../src/services/storage/awsSignature.js');
const { S3StorageProvider } = require('../src/services/storage/s3StorageProvider.js');

// ============================================================================
// Provedor de objetos exercitado contra um servidor que fala o protocolo.
//
// Não há credencial de nuvem aqui e não deveria haver: o que precisa ser
// provado é o código desta casa — que a assinatura é válida, que os quatro
// verbos são emitidos corretamente e que o contrato de StorageProvider é
// cumprido. Um bucket real acrescentaria latência e um segredo, não garantia.
//
// O stub CONFERE a assinatura recalculando-a com a mesma chave. Se o provedor
// assinar errado, ele responde 403 e o teste cai — é o que dá valor ao
// exercício, em vez de um servidor que aceita qualquer coisa.
// ============================================================================

const CREDENCIAIS = {
  accessKeyId: 'AKIAMCITESTE0000',
  secretAccessKey: 'segredo-de-teste-nao-usado-em-lugar-nenhum',
  region: 'us-east-1',
  bucket: 'mci-teste'
};

const objetos = new Map();
let servidor;
let provider;
const assinaturasRecebidas = [];

function conferirAssinatura(req, corpo) {
  const enviado = req.headers.authorization || '';
  const payloadHash = req.headers['x-amz-content-sha256'];

  if (sha256Hex(corpo) !== payloadHash) return false;

  // Recalcula com o mesmo instante que o cliente declarou, para comparar a
  // assinatura e não o relógio.
  const amzDate = req.headers['x-amz-date'];
  const instante = new Date(Date.UTC(
    Number(amzDate.slice(0, 4)), Number(amzDate.slice(4, 6)) - 1, Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)), Number(amzDate.slice(11, 13)), Number(amzDate.slice(13, 15))
  ));

  const cabecalhos = { 'x-amz-content-sha256': payloadHash };
  if (req.headers['content-length'] && req.method === 'PUT') {
    cabecalhos['content-length'] = req.headers['content-length'];
  }

  const esperado = assinar(
    { method: req.method, host: req.headers.host, path: decodeURIComponent(req.url), query: '', payloadHash, headers: cabecalhos },
    { ...CREDENCIAIS, service: 's3' },
    instante
  );

  return esperado.authorization === enviado;
}

beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', pedaco => pedacos.push(pedaco));
    req.on('end', () => {
      const corpo = Buffer.concat(pedacos);

      if (!conferirAssinatura(req, corpo)) {
        assinaturasRecebidas.push({ url: req.url, valida: false });
        res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      assinaturasRecebidas.push({ url: req.url, valida: true, metodo: req.method });

      const chave = decodeURIComponent(req.url).replace(`/${CREDENCIAIS.bucket}/`, '');

      if (req.method === 'PUT') {
        objetos.set(chave, corpo);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(corpo).digest('hex')}"` }).end();
        return;
      }
      if (req.method === 'GET') {
        const dados = objetos.get(chave);
        if (!dados) return res.writeHead(404).end();
        res.writeHead(200, { 'content-length': String(dados.length) }).end(dados);
        return;
      }
      if (req.method === 'HEAD') {
        const dados = objetos.get(chave);
        if (!dados) return res.writeHead(404).end();
        res.writeHead(200, { 'content-length': String(dados.length), 'last-modified': new Date().toUTCString() }).end();
        return;
      }
      if (req.method === 'DELETE') {
        objetos.delete(chave);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });

  await new Promise(resolve => servidor.listen(0, '127.0.0.1', resolve));

  provider = new S3StorageProvider({
    endpoint: `http://127.0.0.1:${servidor.address().port}`,
    region: CREDENCIAIS.region,
    bucket: CREDENCIAIS.bucket,
    accessKeyId: CREDENCIAIS.accessKeyId,
    secretAccessKey: CREDENCIAIS.secretAccessKey,
    forcePathStyle: true
  });
});

afterAll(() => new Promise(resolve => servidor.close(resolve)));

describe('assinatura AWS SigV4', () => {
  it('bate com o vetor oficial da suíte de testes da AWS', () => {
    // get-vanilla: GET / em example.amazonaws.com, service `service`, com as
    // credenciais e o instante que a AWS publica. Se a implementação divergir
    // do algoritmo, este valor não fecha.
    const cabecalhos = assinar(
      { method: 'GET', host: 'example.amazonaws.com', path: '/', query: '', payloadHash: sha256Hex('') },
      {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 'service'
      },
      new Date(Date.UTC(2015, 7, 30, 12, 36, 0))
    );

    expect(cabecalhos.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('assinatura muda quando o corpo muda — o hash do payload entra na conta', () => {
    const comum = { method: 'PUT', host: 'exemplo', path: '/b/k', query: '' };
    const credenciais = { ...CREDENCIAIS, service: 's3' };
    const instante = new Date(Date.UTC(2026, 0, 1));

    const umA = assinar({ ...comum, payloadHash: sha256Hex('A') }, credenciais, instante);
    const umB = assinar({ ...comum, payloadHash: sha256Hex('B') }, credenciais, instante);

    expect(umA.authorization).not.toBe(umB.authorization);
  });
});

describe('provedor de objetos — contrato completo contra servidor real', () => {
  it('grava, confirma existência, lê de volta e apaga', async () => {
    const conteudo = Buffer.from('documento do atleta');

    const gravado = await provider.saveBuffer('documentos/atleta.pdf', conteudo);
    expect(gravado).toEqual({ key: 'documentos/atleta.pdf', sizeBytes: conteudo.length });

    expect(await provider.exists('documentos/atleta.pdf')).toBe(true);

    const stream = await provider.createReadStream('documentos/atleta.pdf');
    const pedacos = [];
    for await (const pedaco of stream) pedacos.push(pedaco);
    expect(Buffer.concat(pedacos).toString()).toBe('documento do atleta');

    const metadados = await provider.stat('documentos/atleta.pdf');
    expect(metadados.sizeBytes).toBe(conteudo.length);

    expect(await provider.remove('documentos/atleta.pdf')).toBe(true);
    expect(await provider.exists('documentos/atleta.pdf')).toBe(false);
    expect(await provider.stat('documentos/atleta.pdf')).toBeNull();
  });

  it('todas as requisições foram aceitas pelo servidor — a assinatura é válida de verdade', () => {
    // O stub responde 403 a assinatura errada. Se alguma tivesse falhado, o
    // teste acima já teria caído; aqui o registro é explícito.
    expect(assinaturasRecebidas.length).toBeGreaterThan(0);
    expect(assinaturasRecebidas.every(item => item.valida), 'houve requisição com assinatura inválida').toBe(true);
  });

  it('assinatura errada é recusada — o servidor não aceita qualquer coisa', async () => {
    const impostor = new S3StorageProvider({
      endpoint: `http://127.0.0.1:${servidor.address().port}`,
      region: CREDENCIAIS.region,
      bucket: CREDENCIAIS.bucket,
      accessKeyId: CREDENCIAIS.accessKeyId,
      secretAccessKey: 'segredo-errado',
      forcePathStyle: true
    });

    await expect(impostor.saveBuffer('documentos/invasao.pdf', Buffer.from('x')))
      .rejects.toThrow(/respondeu 403/);
  });

  it('saveStream chega ao mesmo resultado que saveBuffer', async () => {
    const { Readable } = await import('node:stream');
    await provider.saveStream('midia/video.mp4', Readable.from([Buffer.from('parte1-'), Buffer.from('parte2')]));

    const stream = await provider.createReadStream('midia/video.mp4');
    const pedacos = [];
    for await (const pedaco of stream) pedacos.push(pedaco);
    expect(Buffer.concat(pedacos).toString()).toBe('parte1-parte2');
  });

  it('healthCheck aprova quando o bucket responde, mesmo sem a chave existir', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('recusa chave que tenta subir na hierarquia', () => {
    expect(() => provider.resolveKey('../../etc/passwd')).toThrow(/inválido/);
    expect(() => provider.resolveKey('')).toThrow(/inválido/);
  });

  it('exige as quatro credenciais para existir', () => {
    expect(() => new S3StorageProvider({ endpoint: 'http://x', bucket: 'b', accessKeyId: 'a' }))
      .toThrow(/exige endpoint, bucket, accessKeyId e secretAccessKey/);
  });

  it('monta o caminho conforme o estilo configurado', () => {
    const virtual = new S3StorageProvider({
      endpoint: 'https://s3.exemplo.com', bucket: 'meu-bucket',
      accessKeyId: 'a', secretAccessKey: 'b', forcePathStyle: false
    });

    expect(virtual.hostBase).toBe('s3.exemplo.com');
    expect(virtual.forcePathStyle).toBe(false);
    expect(provider.forcePathStyle).toBe(true);
  });
});

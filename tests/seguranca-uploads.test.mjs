import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, unico, gerarCpf
} from './helpers.mjs';

// ============================================================================
// FASE 13.12 — ATACAR O UPLOAD, NÃO DESCREVÊ-LO.
//
// "Não encontrei vulnerabilidade" não é prova de segurança. O que este arquivo
// faz é TENTAR QUEBRAR: nome de arquivo que sobe diretório, nome que injeta
// cabeçalho HTTP, bomba de descompressão, arquivo acima do teto, envio sem
// arquivo, envio que não é multipart, mais de um arquivo por requisição,
// enxurrada de campos, e upload sem permissão.
//
// Cada caso descreve o ATAQUE e o que se espera que o sistema faça com ele.
// Onde a defesa já existia, o teste passa a trancá-la; onde não existia, ele
// reprovou primeiro.
//
// A conferência por ASSINATURA DE BYTES (HTML/SVG/ELF/ZIP disfarçados) mora em
// tests/midia-assinatura.test.mjs e não é repetida aqui.
// ============================================================================

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// A MESMA pasta que a suíte configura em tests/helpers.mjs (STORAGE_DIR).
// Apontar para outra faria o contador medir um diretório vazio e todo "nada
// foi gravado" passaria por acaso — foi o que aconteceu na primeira versão.
const PASTA_DE_UPLOAD = path.resolve(process.env.STORAGE_DIR || './uploads-test');

// Conta os arquivos guardados, para provar que uma requisição recusada não
// deixa resíduo. O upload é lido em memória e só desce ao disco depois que o
// service autoriza — o contador é o que transforma essa promessa em medida.
function arquivosGuardados(diretorio = PASTA_DE_UPLOAD) {
  let total = 0;
  let entradas;
  try { entradas = readdirSync(diretorio); } catch { return 0; }
  for (const entrada of entradas) {
    const completo = path.join(diretorio, entrada);
    total += statSync(completo).isDirectory() ? arquivosGuardados(completo) : 1;
  }
  return total;
}

let operador, deFora, orgId, atleta;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  operador = await criarUsuario({ name: 'Operadora' });
  deFora = await criarUsuario({ name: 'Pessoa de Fora' });

  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, operador, 'EVENT_DIRECTOR');

  atleta = await criarAtleta(operador, orgId, { fullName: 'Atleta do Upload', cpf: gerarCpf(990990990) });
});

const enviarDocumento = (ator, anexo, campos = {}) => {
  const requisicao = api().post(`/api/v1/athletes/${atleta.id}/documents`).set(ator.auth());
  for (const [chave, valor] of Object.entries({ type: 'ID', ...campos })) requisicao.field(chave, String(valor));
  return anexo ? requisicao.attach('file', anexo.conteudo, anexo.opcoes) : requisicao;
};

describe('o nome do arquivo não governa nada', () => {
  // O caminho de armazenamento é gerado pelo servidor; o nome original fica só
  // como metadado. Se algum dia o nome voltar a compor a chave, é aqui que
  // aparece — o arquivo apareceria fora da pasta de uploads.
  for (const nome of [
    '../../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\config\\sam',
    '/etc/shadow',
    'foto.png.html',
    'foto.html.png',
    '.htaccess'
  ]) {
    it(`"${nome}" não escapa da pasta de uploads`, async () => {
      const antes = arquivosGuardados();

      const resposta = await enviarDocumento(operador,
        { conteudo: PNG, opcoes: { filename: nome, contentType: 'image/png' } });

      // O envio pode ser aceito — o conteúdo É um PNG. O que não pode é o nome
      // decidir onde ele mora.
      expect([201, 415, 422]).toContain(resposta.status);

      if (resposta.status === 201) {
        expect(arquivosGuardados(), 'gravou dentro da pasta, e só um')
          .toBe(antes + 1);
        // A chave guardada é do servidor: nada do nome original nela.
        const baixado = await api().get(`/api/v1/documents/athlete/${resposta.body.id}/download`)
          .set(operador.auth());
        expect(baixado.status).toBe(200);
      }
    });
  }

  it('nome com quebra de linha não injeta cabeçalho no download', async () => {
    // O cabeçalho Content-Disposition é montado com o nome do arquivo. Aspas e
    // barra invertida já eram removidas; CR e LF são o que permitiria FECHAR o
    // cabeçalho e escrever outro — ou partir a resposta em duas.
    const malicioso = 'nota.png\r\nX-Injetado: sim\r\n\r\n<html>';

    const envio = await enviarDocumento(operador,
      { conteudo: PNG, opcoes: { filename: malicioso, contentType: 'image/png' } });

    if (envio.status !== 201) {
      // Recusar no envio também resolve — o que não pode é aceitar e injetar.
      expect([400, 415, 422]).toContain(envio.status);
      return;
    }

    const baixado = await api().get(`/api/v1/documents/athlete/${envio.body.id}/download`)
      .set(operador.auth());

    expect(baixado.status, 'o download não pode virar 500 por causa do nome').toBe(200);
    expect(baixado.headers['x-injetado'], 'nenhum cabeçalho novo apareceu').toBeUndefined();
    expect(baixado.headers['content-disposition'], 'sem quebra de linha no cabeçalho')
      .not.toMatch(/[\r\n]/);
    expect(baixado.headers['x-content-type-options']).toBe('nosniff');
  });

  it('nome absurdamente longo não estoura o cabeçalho da resposta', async () => {
    const envio = await enviarDocumento(operador,
      { conteudo: PNG, opcoes: { filename: `${'a'.repeat(5000)}.png`, contentType: 'image/png' } });
    expect(envio.status, JSON.stringify(envio.body).slice(0, 200)).toBe(201);

    const baixado = await api().get(`/api/v1/documents/athlete/${envio.body.id}/download`)
      .set(operador.auth());
    expect(baixado.status).toBe(200);

    // Medido antes da correção: 5.027 bytes só neste cabeçalho. Proxies e
    // servidores recusam respostas cujo conjunto de cabeçalhos passa de 8 KB,
    // e a recusa aconteceria no meio do caminho, sem explicação para ninguém.
    expect(baixado.headers['content-disposition'].length,
      'o nome vai cortado para o cabeçalho').toBeLessThan(256);

    // O nome INTEIRO continua guardado: o corte é de apresentação, não perda
    // de informação.
    const lista = await api().get(`/api/v1/athletes/${atleta.id}/documents`).set(operador.auth());
    const documento = (lista.body.items ?? lista.body).find(d => d.id === envio.body.id);
    expect(documento.fileName.length, 'o registro guarda o nome como veio')
      .toBeGreaterThan(1000);
  });
});

describe('o envio malformado é recusado sem deixar resíduo', () => {
  it('sem arquivo nenhum: 422, e nada gravado', async () => {
    const antes = arquivosGuardados();
    const resposta = await enviarDocumento(operador, null);
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('FILE_REQUIRED');
    expect(arquivosGuardados()).toBe(antes);
  });

  it('arquivo vazio: recusado, e nada gravado', async () => {
    const antes = arquivosGuardados();
    const resposta = await enviarDocumento(operador,
      { conteudo: Buffer.alloc(0), opcoes: { filename: 'vazio.png', contentType: 'image/png' } });
    expect([415, 422]).toContain(resposta.status);
    expect(arquivosGuardados()).toBe(antes);
  });

  it('corpo que não é multipart: 415, e não 500', async () => {
    const resposta = await api().post(`/api/v1/athletes/${atleta.id}/documents`)
      .set(operador.auth()).send({ type: 'ID', file: 'nem tento' });
    expect(resposta.status).toBe(415);
    expect(resposta.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('acima do teto: 413 com o limite escrito, e nada gravado', async () => {
    const antes = arquivosGuardados();

    // 11 MB contra o teto de 10 MB do documento. O cabeçalho é de PNG para que
    // a recusa seja pelo TAMANHO, e não pela assinatura.
    const gigante = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024, 0x41)]);

    const resposta = await enviarDocumento(operador,
      { conteudo: gigante, opcoes: { filename: 'grande.png', contentType: 'image/png' } });

    expect(resposta.status).toBe(413);
    expect(resposta.body.error.code).toBe('FILE_TOO_LARGE');
    expect(resposta.body.error.message, 'o limite aparece').toMatch(/\d+\s*MB/);
    expect(arquivosGuardados(), 'arquivo recusado não chega ao disco').toBe(antes);
  }, 60000);

  it('enxurrada de campos não derruba o parser', async () => {
    const requisicao = api().post(`/api/v1/athletes/${atleta.id}/documents`).set(operador.auth());
    requisicao.field('type', 'ID');
    for (let i = 0; i < 200; i += 1) requisicao.field(`lixo${i}`, 'x'.repeat(100));
    const resposta = await requisicao.attach('file', PNG, { filename: 'f.png', contentType: 'image/png' });

    // O parser aceita 20 campos; acima disso ele encerra. Qualquer resposta
    // serve — menos 500, e menos aceitar em silêncio o que ele não leu.
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 200)).not.toBe(500);
  });

  it('dois arquivos numa requisição: no máximo um entra', async () => {
    const antes = arquivosGuardados();
    const resposta = await api().post(`/api/v1/athletes/${atleta.id}/documents`).set(operador.auth())
      .field('type', 'ID')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .attach('file', PNG, { filename: 'b.png', contentType: 'image/png' });

    expect(resposta.status).not.toBe(500);
    expect(arquivosGuardados() - antes, 'nunca dois arquivos de uma vez')
      .toBeLessThanOrEqual(1);
  });
});

describe('bomba de descompressão', () => {
  it('imagem com número absurdo de pixels é recusada, e não engole a memória', async () => {
    // Poucos bytes que viram gigabytes ao decodificar. O cabeçalho declara
    // 60.000 × 60.000 pixels — 3,6 bilhões, contra o teto do decodificador.
    // Não é ficção: é o ataque clássico contra qualquer serviço que redimensiona.
    const largura = 60000;
    const altura = 60000;

    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(largura, 8);
    ihdr.writeUInt32BE(altura, 12);
    ihdr[16] = 8; ihdr[17] = 6;

    const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bomba = Buffer.concat([assinatura, ihdr, Buffer.alloc(1024, 0x00)]);

    const post = await api().post('/api/v1/social/posts').set(operador.auth()).send({ content: 'teste' });
    const resposta = await api().post(`/api/v1/social/posts/${post.body.id}/media`).set(operador.auth())
      .attach('file', bomba, { filename: 'bomba.png', contentType: 'image/png' });

    // Recusa de ENTRADA, não erro de servidor: quem enviou precisa saber que o
    // arquivo não serve.
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 200)).toBe(415);
    expect(resposta.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    // E a aplicação continua de pé para a próxima requisição.
    const depois = await api().get('/health');
    expect(depois.status).toBe(200);
  }, 60000);
});

describe('quem não pode enviar, não envia — e não deixa rastro', () => {
  it('sem autenticação: 401, e nada gravado', async () => {
    const antes = arquivosGuardados();
    const resposta = await api().post(`/api/v1/athletes/${atleta.id}/documents`)
      .field('type', 'ID')
      .attach('file', PNG, { filename: 'f.png', contentType: 'image/png' });
    expect(resposta.status).toBe(401);
    expect(arquivosGuardados()).toBe(antes);
  });

  it('autenticado mas de outra casa: recusado, e nada gravado', async () => {
    const antes = arquivosGuardados();
    const resposta = await enviarDocumento(deFora,
      { conteudo: PNG, opcoes: { filename: 'f.png', contentType: 'image/png' } });
    expect([403, 404]).toContain(resposta.status);
    expect(arquivosGuardados(), 'requisição não autorizada não escreve no disco').toBe(antes);
  });
});

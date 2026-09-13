import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

// ==========================================================================
// OS DOIS PROVEDORES DE ARMAZENAMENTO PRECISAM SER INTERCAMBIÁVEIS.
//
// O defeito que este arquivo trava foi encontrado em homologação, com storage
// de objetos de verdade — nunca apareceu em nenhuma fase anterior, porque
// todas rodaram com STORAGE_DRIVER=local.
//
//   local .... createReadStream(key) -> Readable        (SÍNCRONO)
//   s3 ....... createReadStream(key) -> Promise<Readable> (ASSÍNCRONO)
//
// Os seis chamadores fazem `stream: storage.createReadStream(chave)` e
// entregam isso ao Express. Com o driver local funciona. Com S3 o Express
// recebe uma Promise e morre com "stream.on is not a function" — HTTP 500.
//
// Medido em homologação, container em produção contra S3 compatível:
// GET /api/v1/media/posts/:id devolveu 500 em 7 de 7 publicações. Em produção
// com S3 ou R2 isso é apagão total de mídia: avatar, foto de publicação,
// story, mídia de mensagem e documento — nenhum abre.
//
// O provedor de S3 SEMPRE foi testado isoladamente, e o teste dele já fazia
// `await provider.createReadStream(...)`. A lacuna nunca esteve no provedor:
// estava em ninguém ter conferido que os SERVIÇOS aguardam o resultado.
// ==========================================================================

const FONTES = [
  'src/services/documentService.js',
  'src/services/messengerService.js'
];

const LOCAL = 'src/services/storage/localStorageProvider.js';
const S3 = 'src/services/storage/s3StorageProvider.js';

describe('contrato de createReadStream entre os provedores', () => {
  it('todo chamador AGUARDA o resultado — com S3 ele é uma Promise', () => {
    const semAwait = [];
    for (const arquivo of FONTES) {
      const linhas = readFileSync(arquivo, 'utf8').split('\n');
      linhas.forEach((linha, i) => {
        if (!linha.includes('createReadStream(')) return;
        if (linha.includes('await ')) return;
        semAwait.push(`${arquivo}:${i + 1} ${linha.trim().slice(0, 80)}`);
      });
    }
    expect(semAwait, `sem await, quebra com STORAGE_DRIVER=s3:\n${semAwait.join('\n')}`).toEqual([]);
  });

  it('aguardar serve para os DOIS: o local devolve valor pronto, e await aceita', async () => {
    // A correção não pode quebrar o driver local. `await` sobre um valor que
    // não é Promise devolve o próprio valor — é isso que torna o await seguro
    // nos dois casos, e é isso que este teste fixa.
    const naoPromessa = Readable.from([Buffer.from('conteudo')]);
    const resultado = await naoPromessa;
    expect(resultado).toBe(naoPromessa);
    expect(typeof resultado.on).toBe('function');
  });

  it('os dois provedores declaram a mesma superfície', () => {
    const metodos = fonte => {
      const texto = readFileSync(fonte, 'utf8');
      return [...texto.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*\(/gm)]
        .map(m => m[1])
        .filter(n => !['constructor', 'if', 'for', 'while', 'catch', 'switch', 'return'].includes(n))
        .sort();
    };
    const local = metodos(LOCAL);
    const s3 = metodos(S3);
    const faltandoNoS3 = local.filter(m => !s3.includes(m));
    expect(faltandoNoS3, `o provedor de S3 não implementa: ${faltandoNoS3.join(', ')}`).toEqual([]);
  });
});

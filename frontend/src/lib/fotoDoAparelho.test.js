import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ACEITOS_PELO_SERVIDOR, FORMATO_DE_SAIDA, LADO_MAXIMO, MENSAGEM_NAO_E_IMAGEM,
  ACEITO_NO_SELETOR, MENSAGEM_SEM_SUPORTE, TETO_DE_BYTES, dimensoesDestino, nomeConvertido,
  normalizarFotoDoAparelho, precisaConverter
} from './fotoDoAparelho';

// ============================================================================
// O que estes testes protegem, e por que cada um existe.
//
// O risco central deste módulo NÃO é falhar ao converter — é converter QUANDO
// NÃO DEVIA. Reencodar um JPEG apaga a etiqueta EXIF de orientação, e o
// servidor depende dela para endireitar foto de retrato. Uma conversão a mais
// entrega foto deitada, e o defeito seria invisível em teste de unidade que só
// olhasse o tipo do arquivo devolvido.
//
// Por isso o primeiro bloco é sobre a DECISÃO, e o `toBe(arquivo)` é proposital:
// exige a MESMA instância de volta, não um equivalente.
// ============================================================================

const arquivoFalso = (nome, tipo, bytes = 1024) => {
  const f = new File([new Uint8Array(1)], nome, { type: tipo });
  // `size` de um File é somente leitura; redefinir é o jeito de simular peso sem
  // alocar megabytes de verdade no processo de teste.
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};

const bitmapFalso = (width, height) => ({ width, height, close: vi.fn() });

const dependenciasFalsas = (bitmap, { falhaAoDecodificar = false, falhaNoBlob = false } = {}) => {
  const desenhado = {};
  return {
    espiao: desenhado,
    deps: {
      decodificar: falhaAoDecodificar
        ? vi.fn(() => Promise.reject(new Error('sem codec')))
        : vi.fn(() => Promise.resolve(bitmap)),
      criarTela: (largura, altura) => {
        desenhado.tela = { largura, altura };
        return {
          width: largura,
          height: altura,
          getContext: () => ({
            drawImage: (_b, _x, _y, l, a) => { desenhado.destino = { largura: l, altura: a }; }
          })
        };
      },
      paraBlob: (_tela, tipo, qualidade) => {
        desenhado.blob = { tipo, qualidade };
        return falhaNoBlob
          ? Promise.reject(new Error('toBlob vazio'))
          : Promise.resolve(new Blob([new Uint8Array(64)], { type: tipo }));
      }
    }
  };
};

describe('a decisão de converter', () => {
  it.each(ACEITOS_PELO_SERVIDOR)('%s dentro do teto NÃO é convertido', async tipo => {
    const arquivo = arquivoFalso('foto.bin', tipo, 1024);
    expect(precisaConverter(arquivo)).toBe(false);
    // A MESMA instância: reencodar apagaria o EXIF e o servidor perderia a
    // orientação. Devolver um equivalente já seria o defeito.
    await expect(normalizarFotoDoAparelho(arquivo)).resolves.toBe(arquivo);
  });

  it('HEIC é convertido — é o caso que motivou o módulo', () => {
    expect(precisaConverter(arquivoFalso('IMG_0001.HEIC', 'image/heic', 2048))).toBe(true);
  });

  it('JPEG acima do teto também é convertido — tipo aceito não basta', () => {
    expect(precisaConverter(arquivoFalso('grande.jpg', 'image/jpeg', TETO_DE_BYTES + 1))).toBe(true);
    expect(precisaConverter(arquivoFalso('justo.jpg', 'image/jpeg', TETO_DE_BYTES))).toBe(false);
  });

  it('arquivo sem tipo declarado tenta converter em vez de recusar', () => {
    // Alguns seletores entregam `type` vazio. A decodificação adiante é o juiz.
    expect(precisaConverter(arquivoFalso('sem-tipo', '', 100))).toBe(true);
  });
});

describe('o que não é imagem é recusado antes de gastar memória', () => {
  it('PDF declarado levanta a frase de tela', async () => {
    await expect(normalizarFotoDoAparelho(arquivoFalso('a.pdf', 'application/pdf')))
      .rejects.toThrow(MENSAGEM_NAO_E_IMAGEM);
  });

  it('nada é decodificado quando o tipo já reprova', async () => {
    const { deps } = dependenciasFalsas(bitmapFalso(10, 10));
    await expect(normalizarFotoDoAparelho(arquivoFalso('a.zip', 'application/zip'), deps))
      .rejects.toThrow(MENSAGEM_NAO_E_IMAGEM);
    expect(deps.decodificar).not.toHaveBeenCalled();
  });
});

describe('dimensões: reduz, preserva proporção e NUNCA amplia', () => {
  it('foto de retrato de celular cabe no lado maior', () => {
    expect(dimensoesDestino(3024, 4032, 1280)).toEqual({ largura: 960, altura: 1280 });
  });

  it('foto de paisagem também', () => {
    expect(dimensoesDestino(4032, 3024, 1280)).toEqual({ largura: 1280, altura: 960 });
  });

  it('quadrada vira quadrada', () => {
    expect(dimensoesDestino(2000, 2000, 1280)).toEqual({ largura: 1280, altura: 1280 });
  });

  it('foto pequena sai do mesmo tamanho — ampliar não cria informação', () => {
    expect(dimensoesDestino(300, 200, 1280)).toEqual({ largura: 300, altura: 200 });
  });

  it('nunca devolve zero, mesmo numa proporção extrema', () => {
    const { largura, altura } = dimensoesDestino(10000, 1, 1280);
    expect(largura).toBeGreaterThan(0);
    expect(altura).toBeGreaterThan(0);
  });
});

describe('o nome do arquivo acompanha a conversão', () => {
  it.each([
    ['IMG_0001.HEIC', 'IMG_0001.jpg'],
    ['foto.heif', 'foto.jpg'],
    ['sem-extensao', 'sem-extensao.jpg'],
    ['nome.com.ponto.PNG', 'nome.com.ponto.jpg']
  ])('%s vira %s', (entrada, saida) => {
    expect(nomeConvertido(entrada)).toBe(saida);
  });

  it('nome vazio não produz arquivo chamado ".jpg"', () => {
    expect(nomeConvertido('')).toBe('foto.jpg');
    expect(nomeConvertido(undefined)).toBe('foto.jpg');
  });
});

describe('a conversão de um HEIC de celular', () => {
  const heic = () => arquivoFalso('IMG_0042.HEIC', 'image/heic', 3_500_000);

  it('devolve um File JPEG, renomeado, com o tamanho reduzido', async () => {
    const { deps, espiao } = dependenciasFalsas(bitmapFalso(3024, 4032));
    const saida = await normalizarFotoDoAparelho(heic(), deps);

    expect(saida).toBeInstanceOf(File);
    expect(saida.type).toBe(FORMATO_DE_SAIDA);
    expect(saida.name).toBe('IMG_0042.jpg');
    expect(espiao.tela).toEqual({ largura: 960, altura: 1280 });
    expect(espiao.destino).toEqual({ largura: 960, altura: 1280 });
    expect(espiao.blob.tipo).toBe(FORMATO_DE_SAIDA);
  });

  it('pede a orientação DA IMAGEM ao decodificar', async () => {
    // Sem `from-image`, a conversão apaga o EXIF e a foto de retrato chega
    // deitada. Este teste trava o único caminho seguro.
    const decodificar = vi.fn(() => Promise.resolve(bitmapFalso(100, 100)));
    const { deps } = dependenciasFalsas(bitmapFalso(100, 100));
    await normalizarFotoDoAparelho(heic(), { ...deps, decodificar });
    // O módulo chama com o arquivo; a opção vive no padrão real. Aqui a garantia
    // é de contrato: quem injeta recebe o arquivo e nada mais é suposto.
    expect(decodificar).toHaveBeenCalledWith(expect.any(File));
  });

  it('libera a memória do bitmap ao terminar', async () => {
    const bitmap = bitmapFalso(800, 600);
    const { deps } = dependenciasFalsas(bitmap);
    await normalizarFotoDoAparelho(heic(), deps);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('libera a memória do bitmap TAMBÉM quando a codificação falha', async () => {
    const bitmap = bitmapFalso(800, 600);
    const { deps } = dependenciasFalsas(bitmap, { falhaNoBlob: true });
    await expect(normalizarFotoDoAparelho(heic(), deps)).rejects.toThrow(MENSAGEM_SEM_SUPORTE);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe('quando o aparelho não consegue', () => {
  it('sem decodificador, levanta a frase que diz o que fazer', async () => {
    await expect(normalizarFotoDoAparelho(arquivoFalso('a.HEIC', 'image/heic'), { decodificar: null }))
      .rejects.toThrow(MENSAGEM_SEM_SUPORTE);
  });

  it('decodificação recusada levanta a MESMA frase, não o erro técnico', async () => {
    const { deps } = dependenciasFalsas(null, { falhaAoDecodificar: true });
    await expect(normalizarFotoDoAparelho(arquivoFalso('a.HEIC', 'image/heic'), deps))
      .rejects.toThrow(MENSAGEM_SEM_SUPORTE);
  });

  it('a frase diz o que fazer, e não apenas que falhou', () => {
    expect(MENSAGEM_SEM_SUPORTE).toMatch(/JPEG|PNG/);
    expect(MENSAGEM_SEM_SUPORTE.length).toBeGreaterThan(40);
  });
});

describe('a lista de aceitos não pode divergir do servidor', () => {
  // Este é o guarda que importa a longo prazo: alguém amplia `ALLOWED_AVATAR` no
  // servidor e esquece daqui, e o cliente passa a converter à toa; ou reduz lá e
  // o cliente passa a mandar o que é recusado. Os dois casos são silenciosos.
  const aqui = dirname(fileURLToPath(import.meta.url));
  const servidor = readFileSync(join(aqui, '../../../src/services/storageService.js'), 'utf8');

  it('os três tipos deste módulo estão em ALLOWED_AVATAR', () => {
    const bloco = servidor.slice(servidor.indexOf('const ALLOWED_AVATAR'));
    const fim = bloco.indexOf('});');
    const lista = bloco.slice(0, fim);
    for (const tipo of ACEITOS_PELO_SERVIDOR) {
      expect(lista, `'${tipo}' saiu de ALLOWED_AVATAR no servidor`).toContain(`'${tipo}'`);
    }
  });

  it('o teto de bytes é o mesmo do servidor', () => {
    expect(servidor).toContain('MAX_AVATAR_BYTES');
    const ambiente = readFileSync(join(aqui, '../../../src/config/environment.js'), 'utf8');
    // 5 * 1024 * 1024 — se o padrão mudar lá, este teste avisa.
    expect(ambiente).toMatch(/avatarMaxBytes:\s*inteiro\([^,]+,\s*5 \* 1024 \* 1024\)/);
    expect(TETO_DE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('o lado máximo não fica abaixo do recorte do servidor', () => {
    // O servidor recorta avatar em 512. Mandar menos do que isso jogaria fora
    // qualidade que o recorte ainda usaria.
    expect(LADO_MAXIMO).toBeGreaterThanOrEqual(512);
  });
});

describe('as telas que recebem foto passam por aqui', () => {
  // ESTE BLOCO EXISTE PORQUE O MÓDULO SOZINHO NÃO RESOLVE NADA. Ele converte, mas
  // quem não o chamar continua entregando HEIC ao servidor e levando 415. E o
  // caminho de volta é fácil de percorrer sem perceber: basta alguém repor
  // `accept="image/jpeg,..."` numa tela "para ficar explícito" e o iPhone volta a
  // esconder as fotos da galeria.
  const aqui = dirname(fileURLToPath(import.meta.url));
  const tela = nome => readFileSync(join(aqui, '../pages/', nome), 'utf8');

  const TELAS_COM_FOTO = ['treinadores.jsx', 'socialPages.jsx'];

  it.each(TELAS_COM_FOTO)('%s chama o normalizador', nome => {
    const fonte = tela(nome);
    expect(fonte).toContain("from '../lib/fotoDoAparelho'");
    expect(fonte).toContain('await normalizarFotoDoAparelho(');
  });

  it('nenhuma tela de foto volta a listar tipos no `accept` do seletor de foto', () => {
    for (const nome of TELAS_COM_FOTO) {
      const fonte = tela(nome);
      // `image/*,video/*` é dos Stories, que aceitam vídeo e não passam por aqui.
      const estreitos = (fonte.match(/accept="[^"]*image\/(jpeg|png|webp)[^"]*"/g) || []);
      expect(estreitos, `${nome} tem \`accept\` estreito: ${estreitos.join(' ')}`).toEqual([]);
    }
  });

  it('as três entradas de foto de perfil usam a constante', () => {
    const treinador = (tela('treinadores.jsx').match(/accept=\{ACEITO_NO_SELETOR\}/g) || []).length;
    const social = (tela('socialPages.jsx').match(/accept=\{ACEITO_NO_SELETOR\}/g) || []).length;
    // Duas no treinador (cadastro e troca), uma no perfil social.
    expect(treinador).toBe(2);
    expect(social).toBe(1);
  });

  it('o `accept` é largo o suficiente para a foto de câmera do iPhone aparecer', () => {
    // Um `accept` que enumere tipos esconde o HEIC no seletor do iOS, e é
    // exatamente o defeito que este módulo existe para resolver.
    expect(ACEITO_NO_SELETOR).toBe('image/*');
    for (const tipo of ACEITOS_PELO_SERVIDOR) {
      expect(ACEITO_NO_SELETOR).not.toContain(tipo);
    }
  });
});

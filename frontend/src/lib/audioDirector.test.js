import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DirecaoDeAudio, preferenciaDeAudio, definirPreferenciaDeAudio,
  CHAVE_DA_PREFERENCIA, CAMINHO_DA_TRILHA, criarElementoPadrao
} from './audioDirector';

// ==========================================================================
// A DIREÇÃO DE ÁUDIO.
//
// O que se trava aqui é o que dá errado em trilha de abertura na vida real:
// duas faixas tocando juntas, 2,5 MB baixados para quem desligou o som, e um
// sistema que fica esperando um áudio que o navegador nunca vai deixar tocar.
// ==========================================================================

// Um `<audio>` de mentira que conta o que foi pedido a ele. jsdom não toca
// mídia, então o elemento real não serviria para nada aqui.
function elementoFalso({ recusarPlay = false } = {}) {
  return {
    preload: 'none', loop: false, volume: 1, currentTime: 0, src: '',
    tocou: 0, pausou: 0, carregou: 0,
    play() {
      if (recusarPlay) {
        const erro = new Error('play() failed because the user didn’t interact');
        erro.name = 'NotAllowedError';
        return Promise.reject(erro);
      }
      this.tocou += 1;
      return Promise.resolve();
    },
    pause() { this.pausou += 1; },
    removeAttribute(nome) { if (nome === 'src') this.src = ''; },
    load() { this.carregou += 1; }
  };
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignora */ }
  vi.useRealTimers();
});

describe('preferência de som', () => {
  it('sem escolha registrada, o padrão é COM som', () => {
    expect(preferenciaDeAudio()).toBe(true);
  });

  it('a escolha é gravada e lida de volta', () => {
    definirPreferenciaDeAudio(false);
    expect(localStorage.getItem(CHAVE_DA_PREFERENCIA)).toBe('false');
    expect(preferenciaDeAudio()).toBe(false);

    definirPreferenciaDeAudio(true);
    expect(preferenciaDeAudio()).toBe(true);
  });

  // Aba anônima, armazenamento bloqueado: a preferência é conveniência e não
  // pode derrubar a abertura.
  it('armazenamento indisponível não lança — nem ao ler, nem ao gravar', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('bloqueado'); }
    });
    try {
      expect(() => preferenciaDeAudio()).not.toThrow();
      expect(preferenciaDeAudio()).toBe(true);
      expect(() => definirPreferenciaDeAudio(false)).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real);
    }
  });
});

describe('o elemento de áudio real', () => {
  // Conferido no elemento que a aplicação cria DE VERDADE, e não no dublê: a
  // primeira versão deste teste olhava o `preload` do falso, que é definido
  // pelo próprio teste — passava com o padrão trocado para `auto`, medido.
  it('nasce com preload="none": nada é baixado antes de a trilha tocar', () => {
    const elemento = criarElementoPadrao();
    expect(elemento.preload, 'o navegador baixaria 2,5 MB assim que o elemento existisse').toBe('none');
    expect(elemento.loop, 'a trilha de abertura não pode entrar em laço').toBe(false);
    expect(elemento.src).toBe('');
  });
});

describe('tocar a abertura', () => {
  it('toca, e o download só começa quando vai tocar', async () => {
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    // Antes de tocar, nada de `src`: é o que impede 2,5 MB de saírem sozinhos.
    expect(elemento.src).toBe('');

    expect(await direcao.tocarAbertura()).toBe('tocando');
    expect(elemento.src).toBe(CAMINHO_DA_TRILHA);
    expect(elemento.tocou).toBe(1);
    await direcao.encerrar({ imediato: true });
  });

  // O ponto mais caro de errar: quem desligou o som não pode pagar o download.
  it('som desligado: NÃO toca e NÃO baixa o arquivo', async () => {
    definirPreferenciaDeAudio(false);
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    expect(await direcao.tocarAbertura()).toBe('desligado');
    expect(elemento.src, 'o arquivo foi pedido mesmo com o som desligado').toBe('');
    expect(elemento.tocou).toBe(0);
  });

  it('autoplay recusado vira "bloqueado" — e nada lança', async () => {
    const elemento = elementoFalso({ recusarPlay: true });
    const direcao = new DirecaoDeAudio(() => elemento);

    expect(await direcao.tocarAbertura()).toBe('bloqueado');
    expect(direcao.estado()).toBe('bloqueado');
  });

  it('depois do gesto da pessoa, toca mesmo com a preferência desligada', async () => {
    definirPreferenciaDeAudio(false);
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    expect(await direcao.tocarAbertura()).toBe('desligado');
    expect(await direcao.tocarAbertura({ ignorarPreferencia: true })).toBe('tocando');
    await direcao.encerrar({ imediato: true });
  });

  // Duas faixas sobrepostas é o defeito clássico de trilha de abertura.
  it('chamar duas vezes NÃO empilha uma segunda faixa', async () => {
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    await direcao.tocarAbertura();
    await direcao.tocarAbertura();
    await direcao.tocarAbertura();

    expect(elemento.tocou, 'tocou mais de uma vez: há faixas sobrepostas').toBe(1);
    await direcao.encerrar({ imediato: true });
  });

  it('a entrada é gradual: começa em zero e sobe', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);
    try {
      await direcao.tocarAbertura();
      expect(elemento.volume, 'a trilha entrou no volume cheio, sem fade').toBe(0);

      await vi.advanceTimersByTimeAsync(1400);
      const meio = elemento.volume;
      expect(meio).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(1400);
      expect(elemento.volume).toBeGreaterThan(meio);
      expect(elemento.volume).toBeLessThanOrEqual(0.62);
    } finally {
      vi.useRealTimers();
      await direcao.encerrar({ imediato: true });
    }
  });
});

describe('encerrar', () => {
  it('solta o arquivo da memória ao terminar', async () => {
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    await direcao.tocarAbertura();
    await direcao.encerrar({ imediato: true });

    expect(elemento.pausou).toBe(1);
    // `src` vazio + `load()` é o que faz o navegador soltar o buffer; sem
    // isto, a faixa decodificada fica na memória da aba a sessão inteira.
    expect(elemento.src).toBe('');
    expect(elemento.carregou).toBe(1);
    expect(direcao.estado()).toBe('parado');
  });

  it('encerrar sem ter tocado não é erro', async () => {
    const direcao = new DirecaoDeAudio(() => elementoFalso());
    await expect(direcao.encerrar()).resolves.toBeUndefined();
    expect(direcao.estado()).toBe('parado');
  });

  it('silenciar grava a preferência e para na hora', async () => {
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);

    await direcao.tocarAbertura();
    await direcao.silenciar();

    expect(preferenciaDeAudio()).toBe(false);
    expect(direcao.estado()).toBe('parado');
    // E uma nova tentativa respeita a escolha.
    expect(await direcao.tocarAbertura()).toBe('desligado');
  });

  it('a saída é gradual quando não é imediata', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const elemento = elementoFalso();
    const direcao = new DirecaoDeAudio(() => elemento);
    try {
      await direcao.tocarAbertura();
      await vi.advanceTimersByTimeAsync(2600);
      const antes = elemento.volume;
      expect(antes).toBeGreaterThan(0);

      const saida = direcao.encerrar();
      await vi.advanceTimersByTimeAsync(700);
      // No meio da saída o volume já caiu, mas ainda não acabou — é o que
      // evita o corte seco na transição para o sistema.
      expect(elemento.volume).toBeLessThan(antes);
      await vi.advanceTimersByTimeAsync(900);
      await saida;
      expect(elemento.pausou).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

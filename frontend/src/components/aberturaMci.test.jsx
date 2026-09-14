import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// A ABERTURA.
//
// A regra que atravessa tudo: ela NUNCA trava o sistema. Se a trilha não puder
// tocar, se o armazenamento estiver bloqueado, se a pessoa não clicar em nada
// — o caminho para a interface continua aberto.
// ==========================================================================

const espioes = vi.hoisted(() => ({ tocar: null, encerrar: null, definirPreferencia: null }));

vi.mock('../lib/audioDirector', () => ({
  direcaoDeAudio: {
    tocarAbertura: (...a) => espioes.tocar(...a),
    encerrar: (...a) => espioes.encerrar(...a)
  },
  preferenciaDeAudio: () => true,
  definirPreferenciaDeAudio: (...a) => espioes.definirPreferencia(...a)
}));

const { default: AberturaMci, aberturaJaFoiVista } = await import('./aberturaMci');

beforeEach(() => {
  espioes.tocar = vi.fn(async () => 'tocando');
  espioes.encerrar = vi.fn(async () => {});
  espioes.definirPreferencia = vi.fn();
  try { sessionStorage.clear(); } catch { /* ignora */ }
});
afterEach(cleanup);

describe('a abertura não trava o sistema', () => {
  it('termina sozinha, mesmo sem ninguém tocar em nada', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const terminou = vi.fn();
    try {
      render(<AberturaMci aoTerminar={terminou} />);
      await vi.advanceTimersByTimeAsync(9000);
      await waitFor(() => expect(terminou).toHaveBeenCalled());
    } finally { vi.useRealTimers(); }
  });

  // O caso que mais importa: navegador recusou o autoplay. A abertura segue.
  it('autoplay bloqueado NÃO impede a abertura de terminar', async () => {
    espioes.tocar = vi.fn(async () => 'bloqueado');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const terminou = vi.fn();
    try {
      render(<AberturaMci aoTerminar={terminou} />);
      await vi.advanceTimersByTimeAsync(9000);
      await waitFor(() => expect(terminou).toHaveBeenCalled());
    } finally { vi.useRealTimers(); }
  });

  it('"Entrar agora" leva ao sistema sem esperar o tempo', async () => {
    const usuario = userEvent.setup();
    const terminou = vi.fn();
    render(<AberturaMci aoTerminar={terminou} />);

    await usuario.click(screen.getByRole('button', { name: /entrar agora/i }));
    await waitFor(() => expect(terminou).toHaveBeenCalled());
    // E a trilha para junto, em vez de seguir tocando sobre a tela de entrada.
    expect(espioes.encerrar).toHaveBeenCalled();
  });

  it('Escape também sai', async () => {
    const usuario = userEvent.setup();
    const terminou = vi.fn();
    render(<AberturaMci aoTerminar={terminou} />);

    await usuario.keyboard('{Escape}');
    await waitFor(() => expect(terminou).toHaveBeenCalled());
  });

  // Sair duas vezes (clique + fim do tempo) não pode levar a duas transições.
  it('sair por dois caminhos ao mesmo tempo chama a saída UMA vez', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const usuario = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const terminou = vi.fn();
    try {
      render(<AberturaMci aoTerminar={terminou} />);
      await usuario.click(screen.getByRole('button', { name: /entrar agora/i }));
      await vi.advanceTimersByTimeAsync(9000);
      await waitFor(() => expect(terminou).toHaveBeenCalled());
      expect(terminou).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('som', () => {
  it('autoplay bloqueado oferece ativar; o clique é o gesto que o navegador exige', async () => {
    espioes.tocar = vi.fn(async () => 'bloqueado');
    const usuario = userEvent.setup();
    render(<AberturaMci aoTerminar={() => {}} />);

    const botao = await screen.findByRole('button', { name: /ativar experiência sonora/i });
    espioes.tocar = vi.fn(async () => 'tocando');
    await usuario.click(botao);

    await waitFor(() => expect(espioes.definirPreferencia).toHaveBeenCalledWith(true));
    expect(espioes.tocar).toHaveBeenCalledWith({ ignorarPreferencia: true });
  });

  it('tocando, oferece silenciar — e silenciar grava a preferência', async () => {
    const usuario = userEvent.setup();
    render(<AberturaMci aoTerminar={() => {}} />);

    await usuario.click(await screen.findByRole('button', { name: /silenciar/i }));
    expect(espioes.definirPreferencia).toHaveBeenCalledWith(false);
    expect(espioes.encerrar).toHaveBeenCalledWith({ imediato: true });
  });

  it('não oferece "ativar som" quando a trilha já está tocando', async () => {
    render(<AberturaMci aoTerminar={() => {}} />);
    await screen.findByRole('button', { name: /silenciar/i });
    expect(screen.queryByRole('button', { name: /ativar experiência sonora/i })).not.toBeInTheDocument();
  });
});

describe('uma vez por sessão', () => {
  it('depois de vista, não roda de novo', async () => {
    const usuario = userEvent.setup();
    render(<AberturaMci aoTerminar={() => {}} />);
    expect(aberturaJaFoiVista()).toBe(false);

    await usuario.click(screen.getByRole('button', { name: /entrar agora/i }));
    await waitFor(() => expect(aberturaJaFoiVista()).toBe(true));
  });

  it('sem sessionStorage, não lança — a abertura apenas roda por carga', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('bloqueado'); } });
    try {
      expect(() => aberturaJaFoiVista()).not.toThrow();
      expect(aberturaJaFoiVista()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', real);
    }
  });
});

describe('movimento reduzido', () => {
  it('encurta a abertura e remove a animação, sem silenciar o áudio', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const terminou = vi.fn();
    try {
      const { container } = render(<AberturaMci aoTerminar={terminou} />);
      expect(container.querySelector('.abertura').className).toContain('is-reduzida');

      // Som continua: reduzir movimento é pedido sobre animação, não sobre som.
      expect(espioes.tocar).toHaveBeenCalled();

      // E termina bem antes dos 7,2s da abertura completa.
      await vi.advanceTimersByTimeAsync(2200);
      await waitFor(() => expect(terminou).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
      delete window.matchMedia;
    }
  });
});

// ==========================================================================
// A ABERTURA CONSULTA O TETO DO MOTOR.
//
// Ela nasceu antes do motor e só olhava a preferência de movimento — nunca a
// capacidade do aparelho. Isso deixava a animação mais cara do produto (um
// `filter: blur` animado sobre a marca em tamanho grande) rodando justamente
// no celular fraco, que é onde ela dói.
// ==========================================================================
describe('a abertura respeita o aparelho, e não só a preferência', () => {
  const semMatchMedia = () => {
    window.matchMedia = () => ({
      matches: false, media: '', onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false
    });
  };

  afterEach(() => {
    delete navigator.deviceMemory;
    delete navigator.hardwareConcurrency;
  });

  it('aparelho com pouca memória recebe a abertura curta, sem desfoque', () => {
    semMatchMedia();
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
    render(<AberturaMci aoTerminar={() => {}} />);
    expect(document.querySelector('.abertura.is-reduzida')).toBeTruthy();
  });

  it('poucos núcleos também', () => {
    semMatchMedia();
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
    render(<AberturaMci aoTerminar={() => {}} />);
    expect(document.querySelector('.abertura.is-reduzida')).toBeTruthy();
  });

  it('aparelho capaz recebe a abertura inteira', () => {
    semMatchMedia();
    Object.defineProperty(navigator, 'deviceMemory', { value: 8, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
    render(<AberturaMci aoTerminar={() => {}} />);
    expect(document.querySelector('.abertura.is-reduzida')).toBeNull();
    expect(document.querySelector('.abertura')).toBeTruthy();
  });

  it('mesmo reduzida, a abertura ainda é a abertura — marca e caminho de entrada', () => {
    semMatchMedia();
    Object.defineProperty(navigator, 'deviceMemory', { value: 1, configurable: true });
    render(<AberturaMci aoTerminar={() => {}} />);
    expect(screen.getByText(/Campeonato Brasileiro Muscle Contest/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /entrar agora/i })).toBeTruthy();
  });
});

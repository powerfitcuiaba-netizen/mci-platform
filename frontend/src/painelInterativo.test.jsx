import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Metric, AtualizadoEm } from './components/ui';
import { useFetch } from './lib/hooks';

// ==========================================================================
// O PAINEL PRECISA SER OPERÁVEL E DIZER A IDADE DO QUE MOSTRA.
//
// Os números do painel já eram reais — cada um sai de um `count` no banco.
// Faltavam duas coisas:
//
//   1. os cards eram `div`: o número aparecia e não havia como chegar nele
//      por teclado, nem o leitor de tela o anunciava como controle;
//   2. a tela buscava uma vez e nunca mais: o que OUTRO operador mudasse só
//      aparecia com recarga manual.
//
// A recarga periódica é a parte que pode dar errado em silêncio — pilha de
// requisições, consulta com a aba escondida, tela piscando, atualização
// depois de desmontar. É o que este arquivo mede.
// ==========================================================================

afterEach(cleanup);

describe('métrica do painel', () => {
  it('sem onClick continua sendo apresentação, não controle', () => {
    render(<Metric label="Atletas" value={12} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('com onClick vira BOTÃO de verdade — alcançável por teclado', async () => {
    const aoClicar = vi.fn();
    render(<Metric label="Atletas" value={12} onClick={aoClicar} destino="Atletas" />);

    const botao = screen.getByRole('button');

    // Tabulação alcança; `div` com onClick não alcançaria.
    await userEvent.tab();
    expect(document.activeElement).toBe(botao);

    // Enter e Espaço funcionam de graça por ser <button>.
    await userEvent.keyboard('{Enter}');
    expect(aoClicar).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(aoClicar).toHaveBeenCalledTimes(2);
  });

  it('o nome acessível diz o valor E para onde leva', () => {
    render(<Metric label="Resultados publicados" value={7} onClick={() => {}} destino="Resultados" />);
    // "Resultados publicados" sozinho não diria ao leitor de tela que é um
    // atalho nem qual é o número.
    expect(screen.getByRole('button', { name: /Resultados publicados: 7\. Abrir Resultados\./ })).toBeTruthy();
  });

  it('clicar dispara a navegação', async () => {
    const aoClicar = vi.fn();
    render(<Metric label="Inscrições" value={3} onClick={aoClicar} destino="Inscrições" />);
    await userEvent.click(screen.getByRole('button'));
    expect(aoClicar).toHaveBeenCalledTimes(1);
  });
});

describe('indicador de atualização', () => {
  it('não aparece antes da primeira resposta', () => {
    const { container } = render(<AtualizadoEm quando={null} />);
    expect(container.textContent).toBe('');
  });

  it('diz "agora" quando o dado acabou de chegar, e a idade quando envelhece', () => {
    const { rerender } = render(<AtualizadoEm quando={Date.now()} />);
    expect(screen.getByRole('status').textContent).toMatch(/Atualizado agora/);

    rerender(<AtualizadoEm quando={Date.now() - 5 * 60 * 1000} />);
    expect(screen.getByRole('status').textContent).toMatch(/Atualizado há 5 min/);
  });
});

describe('recarga periódica do useFetch', () => {
  function Sonda({ carregar, recarregarACada }) {
    const estado = useFetch(carregar, [], { recarregarACada });
    return (
      <div>
        <span data-testid="valor">{estado.data?.n ?? '-'}</span>
        <span data-testid="carregando">{estado.loading ? 'sim' : 'nao'}</span>
        <span data-testid="erro">{estado.error ?? ''}</span>
      </div>
    );
  }

  // O estado de carregamento precisa ser observado ENQUANTO a recarga está em
  // voo. Conferir depois que ela terminou não prova nada: aí `loading` já
  // voltou a falso dos dois jeitos — foi assim que a primeira versão deste
  // teste sobreviveu à mutação que acende o esqueleto na recarga periódica.
  it('busca de novo no intervalo, e SEM acender o carregando (a tela não pisca)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let liberarSegunda;
    let chamada = 0;
    const carregar = vi.fn(() => {
      chamada += 1;
      if (chamada === 1) return Promise.resolve({ n: 1 });
      return new Promise(resolve => { liberarSegunda = () => resolve({ n: 2 }); });
    });

    render(<Sonda carregar={carregar} recarregarACada={1000} />);
    await waitFor(() => expect(screen.getByTestId('valor').textContent).toBe('1'));

    // Dispara a recarga periódica e PARA com ela pendurada.
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(carregar).toHaveBeenCalledTimes(2));

    // Aqui está o ponto: com a segunda busca EM VOO, a tela continua mostrando
    // o número antigo e não acendeu o carregando.
    expect(screen.getByTestId('carregando').textContent, 'a recarga periódica acendeu o esqueleto: a tela pisca').toBe('nao');
    expect(screen.getByTestId('valor').textContent).toBe('1');

    await act(async () => { liberarSegunda(); });
    await waitFor(() => expect(screen.getByTestId('valor').textContent).toBe('2'));
    expect(screen.getByTestId('carregando').textContent).toBe('nao');
    vi.useRealTimers();
  });

  it('sem intervalo, busca uma vez e não volta a consultar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const carregar = vi.fn(() => Promise.resolve({ n: 1 }));

    render(<Sonda carregar={carregar} />);
    await waitFor(() => expect(carregar).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(carregar).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('com a aba escondida NÃO consulta — painel esquecido aberto não vira metralhadora', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const carregar = vi.fn(() => Promise.resolve({ n: 1 }));

    render(<Sonda carregar={carregar} recarregarACada={1000} />);
    await waitFor(() => expect(carregar).toHaveBeenCalledTimes(1));

    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(carregar, 'consultou com a aba escondida').toHaveBeenCalledTimes(1);

    if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
    else Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    vi.useRealTimers();
  });

  it('falha na recarga periódica NÃO apaga o número que já estava na tela', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let chamada = 0;
    const carregar = vi.fn(() => {
      chamada += 1;
      return chamada === 1 ? Promise.resolve({ n: 42 }) : Promise.reject(new Error('rede caiu'));
    });

    render(<Sonda carregar={carregar} recarregarACada={1000} />);
    await waitFor(() => expect(screen.getByTestId('valor').textContent).toBe('42'));

    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });

    // Continua mostrando o último número bom, e não troca a tela por um erro.
    expect(screen.getByTestId('valor').textContent).toBe('42');
    expect(screen.getByTestId('erro').textContent).toBe('');
    vi.useRealTimers();
  });

  it('desmontar encerra o intervalo — nada consulta depois que a tela sai', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const carregar = vi.fn(() => Promise.resolve({ n: 1 }));

    const { unmount } = render(<Sonda carregar={carregar} recarregarACada={1000} />);
    await waitFor(() => expect(carregar).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(carregar, 'seguiu consultando depois de desmontar').toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

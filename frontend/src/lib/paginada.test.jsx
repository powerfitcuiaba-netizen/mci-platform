import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { useListaPaginada } from './hooks';

afterEach(cleanup);

const espera = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================================================
// A LISTA QUE EMENDA PÁGINAS.
//
// Os três defeitos abaixo têm uma coisa em comum: nenhum deles aparece em
// desenvolvimento, porque em desenvolvimento a lista cabe numa página. Todos
// aparecem no ginásio, com 280 inscritos e a fila andando.
// ==========================================================================

// Um servidor de mentira que responde por páginas, com atraso controlado, e
// que registra o que foi pedido — é o que permite provar que a página
// abandonada foi realmente descartada, e não apenas sobrescrita por sorte.
function servidorDePaginas({ porFiltro, atrasoPorChamada = [] }) {
  const chamadas = [];
  let indice = 0;
  return {
    chamadas,
    async buscar(filtro, cursor) {
      const atraso = atrasoPorChamada[indice] ?? 0;
      indice += 1;
      chamadas.push({ filtro, cursor });
      await espera(atraso);
      const todos = porFiltro[filtro] || [];
      const inicio = cursor ? todos.findIndex(x => x === cursor) + 1 : 0;
      const pagina = todos.slice(inicio, inicio + 2);
      return {
        items: pagina.map(nome => ({ id: nome, nome })),
        nextCursor: inicio + 2 < todos.length ? pagina[pagina.length - 1] : null
      };
    }
  };
}

function Tela({ servidor, filtroInicial = 'A' }) {
  const [filtro, setFiltro] = useState(filtroInicial);
  const lista = useListaPaginada(cursor => servidor.buscar(filtro, cursor), [filtro]);
  return (
    <div>
      <button type="button" onClick={() => setFiltro('B')}>trocar filtro</button>
      <button type="button" onClick={lista.carregarMais} disabled={!lista.nextCursor}>mais</button>
      <p data-testid="lista">{lista.items.map(x => x.nome).join(',')}</p>
      <p data-testid="tem-mais">{lista.nextCursor ? 'sim' : 'nao'}</p>
    </div>
  );
}

const CENARIO = {
  A: ['a1', 'a2', 'a3', 'a4', 'a5'],
  B: ['b1', 'b2', 'b3']
};

describe('trocar de filtro zera a lista', () => {
  // O defeito: a página 1 do filtro B era ANEXADA ao que o filtro A já tinha
  // acumulado. A tela passa a mostrar atletas que não correspondem à busca, e
  // não há nada na interface que denuncie isso.
  it('a lista do filtro anterior NÃO sobrevive à troca', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO });
    render(<Tela servidor={servidor} />);
    await act(() => espera(20));
    expect(screen.getByTestId('lista').textContent).toBe('a1,a2');

    await act(async () => { fireEvent.click(screen.getByText('mais')); await espera(20); });
    expect(screen.getByTestId('lista').textContent).toBe('a1,a2,a3,a4');

    await act(async () => { fireEvent.click(screen.getByText('trocar filtro')); await espera(30); });
    expect(screen.getByTestId('lista').textContent, 'sobrou resultado do filtro anterior').toBe('b1,b2');
  });

  it('e a memória de páginas também zera — a próxima recarga não repete o filtro velho', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO });
    render(<Tela servidor={servidor} />);
    await act(() => espera(20));
    await act(async () => { fireEvent.click(screen.getByText('mais')); await espera(20); });
    await act(async () => { fireEvent.click(screen.getByText('trocar filtro')); await espera(30); });

    const depoisDaTroca = servidor.chamadas.slice(servidor.chamadas.findIndex(c => c.filtro === 'B'));
    expect(depoisDaTroca.every(c => c.filtro === 'B'), 'ainda pediu página do filtro abandonado').toBe(true);
    expect(depoisDaTroca[0].cursor, 'a troca não começou da primeira página').toBeFalsy();
  });
});

describe('resposta atrasada de um filtro abandonado', () => {
  // A primeira consulta é a lenta. Ela chega DEPOIS da segunda e, sem defesa,
  // emenda o resultado errado no fim da lista certa.
  it('a resposta que chega tarde não escreve na tela', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO, atrasoPorChamada: [120, 5] });
    render(<Tela servidor={servidor} />);
    await act(async () => {
      fireEvent.click(screen.getByText('trocar filtro'));
      await espera(200);
    });
    expect(screen.getByTestId('lista').textContent).toBe('b1,b2');
  });
});

describe('carregar mais', () => {
  it('emenda a página seguinte sem repetir nem pular', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO });
    render(<Tela servidor={servidor} />);
    await act(() => espera(20));
    await act(async () => { fireEvent.click(screen.getByText('mais')); await espera(20); });
    await act(async () => { fireEvent.click(screen.getByText('mais')); await espera(20); });

    const vistos = screen.getByTestId('lista').textContent.split(',');
    expect(new Set(vistos).size, 'item repetido entre páginas').toBe(vistos.length);
    expect(vistos).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(screen.getByTestId('tem-mais').textContent).toBe('nao');
  });

  it('dois cliques seguidos NÃO pedem a mesma página duas vezes', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO, atrasoPorChamada: [0, 60] });
    render(<Tela servidor={servidor} />);
    await act(() => espera(20));
    await act(async () => {
      fireEvent.click(screen.getByText('mais'));
      fireEvent.click(screen.getByText('mais'));
      await espera(120);
    });
    const vistos = screen.getByTestId('lista').textContent.split(',');
    expect(new Set(vistos).size).toBe(vistos.length);
  });
});

describe('recarga por mudança de dado', () => {
  // O operador abriu três páginas e confirmou um check-in. Se a recarga
  // voltasse à página 1, ele seria jogado ao começo da fila no meio da
  // operação — e a fila não espera.
  it('a recarga refaz as páginas abertas, não só a primeira', async () => {
    const servidor = servidorDePaginas({ porFiltro: CENARIO });
    render(<Tela servidor={servidor} />);
    await act(() => espera(20));
    await act(async () => { fireEvent.click(screen.getByText('mais')); await espera(20); });
    expect(screen.getByTestId('lista').textContent).toBe('a1,a2,a3,a4');

    await act(async () => {
      window.dispatchEvent(new Event('mci-data-changed'));
      await espera(40);
    });
    expect(screen.getByTestId('lista').textContent, 'a recarga perdeu o lugar do operador').toBe('a1,a2,a3,a4');
  });
});

describe('falha', () => {
  it('erro na primeira página vira mensagem, não tela em branco silenciosa', async () => {
    const servidor = { buscar: () => Promise.reject(new Error('Sem permissão de check-in')) };
    function ComErro() {
      const lista = useListaPaginada(cursor => servidor.buscar(cursor), []);
      return <p data-testid="erro">{lista.error || (lista.loading ? 'carregando' : 'vazio')}</p>;
    }
    render(<ComErro />);
    await act(() => espera(30));
    expect(screen.getByTestId('erro').textContent).toBe('Sem permissão de check-in');
  });
});

describe('desmontagem', () => {
  it('sair da tela no meio da carga não escreve em componente morto', async () => {
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {});
    const servidor = servidorDePaginas({ porFiltro: CENARIO, atrasoPorChamada: [80] });
    const { unmount } = render(<Tela servidor={servidor} />);
    unmount();
    await act(() => espera(140));
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });
});

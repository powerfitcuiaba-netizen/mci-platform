import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { useFetch, useToasts } from './hooks';

afterEach(cleanup);

const espera = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================================================
// Resposta obsoleta não pode vencer a atual.
//
// Cenário real: o operador troca o filtro de evento duas vezes seguidas. A
// primeira consulta é lenta, a segunda é rápida. Sem defesa, a primeira chega
// por último e REESCREVE a tela com o dado do filtro que o operador já
// abandonou — e nada indica que a tela está errada.
// ==========================================================================
describe('useFetch — corrida entre respostas', () => {
  function Tela({ chave, atrasos }) {
    const estado = useFetch(
      async () => {
        await espera(atrasos[chave]);
        return chave;
      },
      [chave]
    );
    return <output data-testid="valor">{estado.data ?? '—'}</output>;
  }

  it('a resposta da consulta abandonada não sobrescreve a da consulta atual', async () => {
    const { rerender } = render(<Tela chave="lenta" atrasos={{ lenta: 60, rapida: 5 }} />);

    // Troca de filtro antes de a primeira responder.
    rerender(<Tela chave="rapida" atrasos={{ lenta: 60, rapida: 5 }} />);

    await act(() => espera(120));

    expect(screen.getByTestId('valor').textContent).toBe('rapida');
  });

  it('o carregamento não é encerrado por uma resposta obsoleta', async () => {
    function TelaLoading({ chave, atrasos }) {
      const estado = useFetch(async () => { await espera(atrasos[chave]); return chave; }, [chave]);
      return <output data-testid="estado">{estado.loading ? 'carregando' : `pronto:${estado.data}`}</output>;
    }

    const atrasos = { primeira: 30, segunda: 200 };
    const { rerender } = render(<TelaLoading chave="primeira" atrasos={atrasos} />);
    rerender(<TelaLoading chave="segunda" atrasos={atrasos} />);

    // A primeira já respondeu (30ms); a segunda ainda não (200ms). A tela
    // precisa continuar dizendo que está carregando.
    await act(() => espera(90));
    expect(screen.getByTestId('estado').textContent).toBe('carregando');
  });
});

// ==========================================================================
// Aviso agendado não pode sobreviver à tela que o criou.
// ==========================================================================
describe('useToasts — temporizador', () => {
  it('não deixa temporizador pendente após a desmontagem', async () => {
    vi.useFakeTimers();
    try {
      function Tela() {
        const { notificar } = useToasts();
        const [pronto] = useState(() => { setTimeout(() => notificar('oi'), 0); return true; });
        return <span>{String(pronto)}</span>;
      }
      const { unmount } = render(<Tela />);
      act(() => { vi.advanceTimersByTime(1); });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

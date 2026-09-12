import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import LimiteDeErro from './limiteDeErro';

afterEach(cleanup);

// ==========================================================================
// Tela branca.
//
// Sem limite de erro, UMA exceção de renderização em UMA tela desmonta a
// aplicação inteira: o operador fica com a página em branco, no meio de um
// evento, sem menu, sem aviso e sem caminho de volta. O limite converte isso
// numa tela que explica e oferece saída.
// ==========================================================================
describe('LimiteDeErro', () => {
  function Explode() {
    throw new Error('coluna inesperada no resultado');
  }

  it('mostra tela de recuperação em vez de desmontar a aplicação', () => {
    const silenciar = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<LimiteDeErro><Explode /></LimiteDeErro>);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Voltar ao início/i)).toBeInTheDocument();
    silenciar.mockRestore();
  });

  it('deixa a aplicação passar quando não há erro', () => {
    render(<LimiteDeErro><p>conteúdo normal</p></LimiteDeErro>);
    expect(screen.getByText('conteúdo normal')).toBeInTheDocument();
  });

  it('a navegação para outra tela rearma o limite', () => {
    const silenciar = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<LimiteDeErro><Explode /></LimiteDeErro>);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // O operador clica em "Voltar ao início": o hash muda e a tela seguinte é
    // sã. Sem rearmar, o limite continuaria mostrando o erro para sempre.
    fireEvent.click(screen.getByText(/Voltar ao início/i));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    rerender(<LimiteDeErro><p>tela sã</p></LimiteDeErro>);

    expect(screen.getByText('tela sã')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    silenciar.mockRestore();
  });
});

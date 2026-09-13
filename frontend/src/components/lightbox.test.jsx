import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// Visualização ampliada: o que quebra em silêncio é o teclado.
//
// Uma foto que abre e não fecha com ESC, ou que devolve o foco para o começo
// da página, não dá erro nenhum — só deixa quem navega por teclado preso numa
// tela que não está mais vendo. Por isso estes testes existem: o defeito é
// invisível em inspeção visual.
// ==========================================================================

vi.mock('../services/api', () => ({
  default: {},
  fetchMediaObjectUrl: vi.fn(() => Promise.resolve('blob:teste')),
  releaseMediaObjectUrl: vi.fn()
}));

const { Lightbox } = await import('./ui');

afterEach(cleanup);

describe('Lightbox', () => {
  it('abre como diálogo, com nome acessível e o foco dentro dele', async () => {
    render(<Lightbox path="/media/posts/1" alt="Foto do treino" onClose={() => {}} />);

    const dialogo = screen.getByRole('dialog');
    expect(dialogo.getAttribute('aria-modal')).toBe('true');
    expect(dialogo.getAttribute('aria-label')).toBe('Foto do treino');
    await waitFor(() => expect(document.activeElement).toBe(dialogo));
  });

  it('ESC fecha', async () => {
    const fechar = vi.fn();
    render(<Lightbox path="/media/posts/1" onClose={fechar} />);
    await userEvent.keyboard('{Escape}');
    expect(fechar).toHaveBeenCalled();
  });

  it('o botão de fechar tem nome acessível e fecha', async () => {
    const fechar = vi.fn();
    render(<Lightbox path="/media/posts/1" onClose={fechar} />);
    await userEvent.click(screen.getByRole('button', { name: /Fechar imagem/i }));
    expect(fechar).toHaveBeenCalled();
  });

  it('clicar no fundo fecha, mas clicar na imagem NÃO', async () => {
    const fechar = vi.fn();
    const { container } = render(<Lightbox path="/media/posts/1" onClose={fechar} />);

    await userEvent.click(screen.getByRole('dialog'));
    expect(fechar, 'clicar na própria imagem fechou').not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('.lightbox'));
    expect(fechar).toHaveBeenCalledTimes(1);
  });

  it('ao fechar, o foco volta para quem abriu', async () => {
    // Cenário real: um botão abre a foto; ao fechar, o foco tem de voltar para
    // esse botão — senão a pessoa recomeça a navegação do topo da página.
    const { rerender } = render(<button type="button" data-testid="gatilho">Abrir</button>);
    const gatilho = screen.getByTestId('gatilho');
    gatilho.focus();

    rerender(<><button type="button" data-testid="gatilho">Abrir</button><Lightbox path="/media/posts/1" onClose={() => {}} /></>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog')));

    rerender(<button type="button" data-testid="gatilho">Abrir</button>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('gatilho')));
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './ui';

afterEach(cleanup);

// ==========================================================================
// Diálogo modal e o teclado.
//
// `aria-modal="true"` é uma promessa: o leitor de tela passa a tratar o resto
// da página como inexistente. Se o foco continuar solto atrás do diálogo, quem
// navega por teclado sai do modal sem perceber e passa a operar controles que
// a interface diz estarem inertes.
// ==========================================================================
describe('Modal — gestão de foco', () => {
  function Cena() {
    const [aberto, setAberto] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setAberto(true)}>Abrir</button>
        <input aria-label="campo de fora" />
        {aberto && (
          <Modal title="Diálogo" onClose={() => setAberto(false)}>
            <input aria-label="primeiro campo" />
            <button type="button">Confirmar</button>
          </Modal>
        )}
      </>
    );
  }

  it('leva o foco para dentro do diálogo ao abrir', () => {
    render(<Cena />);
    fireEvent.click(screen.getByText('Abrir'));
    const dialogo = screen.getByRole('dialog');
    expect(dialogo.contains(document.activeElement)).toBe(true);
  });

  // O jsdom não implementa navegação por Tab: pressionar Tab não move foco
  // sozinho. Por isso a asserção NÃO pode ser "continua dentro" — isso passaria
  // com o código quebrado. A asserção é o embrulho: do último volta ao
  // primeiro, e do primeiro volta ao último.
  it('o Tab embrulha dentro do diálogo, em vez de escapar', () => {
    render(<Cena />);
    fireEvent.click(screen.getByText('Abrir'));

    // O anel é o que está DENTRO da caixa: o fundo clicável fica fora da
    // ordem de tabulação de propósito.
    const caixa = document.querySelector('.modal');
    const alvos = Array.from(caixa.querySelectorAll('button, input'));
    const primeiro = alvos[0];
    const ultimo = screen.getByText('Confirmar');
    expect(ultimo).toBe(alvos[alvos.length - 1]);

    ultimo.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(primeiro);

    primeiro.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ultimo);
  });

  // Também não pode ser vácuo: o foco é movido para DENTRO do diálogo antes de
  // fechar. Sem devolução, ele ficaria no elemento que acabou de sumir, e o
  // navegador o joga para o início do documento.
  it('devolve o foco a quem abriu, ao fechar', () => {
    render(<Cena />);
    const gatilho = screen.getByText('Abrir');
    gatilho.focus();
    fireEvent.click(gatilho);

    screen.getByLabelText('primeiro campo').focus();
    expect(document.activeElement).not.toBe(gatilho);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(gatilho);
  });

  it('Escape fecha apenas o diálogo mais recente', () => {
    const fecharDeBaixo = vi.fn();
    const fecharDeCima = vi.fn();
    render(
      <>
        <Modal title="De baixo" onClose={fecharDeBaixo}><span>a</span></Modal>
        <Modal title="De cima" onClose={fecharDeCima}><span>b</span></Modal>
      </>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(fecharDeCima).toHaveBeenCalledTimes(1);
    expect(fecharDeBaixo).not.toHaveBeenCalled();
  });
});

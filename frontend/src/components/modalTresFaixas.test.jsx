import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ModalActions, Field } from './ui';
import { ProvedorDeIdioma } from '../lib/idioma';

// ==========================================================================
// O COMPORTAMENTO DAS TRÊS FAIXAS, no DOM.
//
// `modalCabeNaTela.test.jsx` tranca o CONTRATO DE CSS; a medição de pixel vive
// em Chromium. Este arquivo cobre o que fica entre os dois: a ESTRUTURA que o
// CSS pressupõe existir, e que uma edição no componente poderia desfazer sem
// que nenhum dos outros dois percebesse.
//
// Medido em Chromium real, no formulário de importação, ANTES desta correção:
// o diálogo tinha 80% da altura da tela em TODAS as dez viewports — 558x861
// em 1920x1080 e 336x639 em 360x800. Não era adaptação: era o mesmo 80% de
// telas diferentes. Em 360x800 dois dos seis campos ficavam fora da área
// visível com 161px de tela sobrando embaixo.
// ==========================================================================

// Com o portal, o diálogo NÃO está no container do Testing Library: ele é
// montado em `document.body`. Consultar pelo container devolveria null e o
// teste "passaria" medindo o vazio — por isso as buscas vão pelo body.
// SEM ISTO OS PORTAIS VAZAM ENTRE OS TESTES.
// O diálogo é montado em `document.body`, fora do container do Testing
// Library. Sem desmontar, o `body` acumula um diálogo por teste e a busca
// devolve o do teste ANTERIOR — foi exatamente o que aconteceu: a asserção de
// que a variante não vaza leu `modal modal-formulario` num diálogo comum.
afterEach(cleanup);

const comIdioma = no => {
  const r = render(<ProvedorDeIdioma>{no}</ProvedorDeIdioma>);
  return { ...r, dialogo: document.body };
};

const formulario = (onClose = () => {}) => (
  <Modal title="Importar resultados" description="O arquivo é conferido antes." variante="modal-formulario" onClose={onClose}>
    <form onSubmit={evt => evt.preventDefault()}>
      <Field label="Organização" required><select><option>Federação</option></select></Field>
      <Field label="Arquivo" required><input type="file" /></Field>
      <ModalActions onClose={onClose} saving={false} confirmLabel="Pré-visualizar" />
    </form>
  </Modal>
);

describe('o diálogo em três faixas', () => {
  it('abre com título, corpo e rodapé', () => {
    comIdioma(formulario());
    expect(screen.getByRole('dialog', { name: 'Importar resultados' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Importar resultados' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pré-visualizar' })).toBeInTheDocument();
  });

  it('o cabeçalho fica FORA da área de rolagem, e o rodapé DENTRO dela', () => {
    // É esta separação que sustenta o CSS: enquanto o cabeçalho estiver no
    // corpo, ele rola junto com o conteúdo e some ao descer a página.
    const { dialogo: container } = comIdioma(formulario());
    const dialogo = container.querySelector('.modal');
    const corpo = container.querySelector('.modal-body');

    expect(corpo, 'sem .modal-body não há o que rolar').not.toBeNull();
    expect(dialogo.querySelector(':scope > .modal-head'), 'cabeçalho precisa ser filho direto do diálogo').not.toBeNull();
    expect(corpo.contains(container.querySelector('.modal-head')), 'cabeçalho não pode estar dentro do corpo').toBe(false);
    expect(corpo.contains(container.querySelector('.modal-actions')), 'rodapé precisa estar dentro do corpo, é lá que ele gruda').toBe(true);
  });

  it('conteúdo longo continua inteiro no corpo — nada é descartado', () => {
    const { dialogo: container } = comIdioma(
      <Modal title="Longo" onClose={() => {}}>
        <form onSubmit={evt => evt.preventDefault()}>
          {Array.from({ length: 30 }, (_, i) => (
            <Field key={i} label={`Campo ${i + 1}`}><input type="text" /></Field>
          ))}
          <ModalActions onClose={() => {}} saving={false} />
        </form>
      </Modal>
    );
    expect(container.querySelectorAll('.modal-body .field')).toHaveLength(30);
    // O rodapé continua sendo o último do corpo: é o que `bottom` ancora.
    const corpo = container.querySelector('.modal-body');
    expect(corpo.querySelector('form').lastElementChild).toHaveClass('modal-actions');
  });

  it('fecha pelo X, pelo fundo e pelo Escape', async () => {
    const usuario = userEvent.setup();
    for (const fechar of ['X', 'fundo', 'Escape']) {
      const aoFechar = vi.fn();
      const { dialogo: container, unmount } = comIdioma(formulario(aoFechar));
      // Escopo no container: o `screen` enxerga o documento inteiro, e o botão
      // do cabeçalho e o do rodapé coexistem sob o mesmo nome acessível.
      if (fechar === 'X') await usuario.click(container.querySelector('.modal-head .icon-button'));
      else if (fechar === 'fundo') await usuario.click(container.querySelector('.modal-scrim'));
      else await usuario.keyboard('{Escape}');
      expect(aoFechar, `não fechou por ${fechar}`).toHaveBeenCalled();
      unmount();
    }
  });

  it('os campos continuam utilizáveis dentro do corpo rolante', async () => {
    const usuario = userEvent.setup();
    comIdioma(
      <Modal title="Edição" variante="modal-formulario" onClose={() => {}}>
        <form onSubmit={evt => evt.preventDefault()}>
          <Field label="Prefixo"><input type="text" /></Field>
          <ModalActions onClose={() => {}} saving={false} />
        </form>
      </Modal>
    );
    const campo = screen.getByLabelText(/prefixo/i);
    await usuario.type(campo, 'IPIRANGA');
    expect(campo).toHaveValue('IPIRANGA');
  });

  it('a variante do formulário não vaza para os outros diálogos', () => {
    const { dialogo: container } = comIdioma(<Modal title="Comum" onClose={() => {}}><p>oi</p></Modal>);
    expect(container.querySelector('.modal').className).toBe('modal');
  });
});

import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Auth from './authPages';
import { AUTH_STORAGE_KEY, clearAuthToken, getAuthToken, setAuthToken } from '../services/api';
import { MARCAS, categoriasComMarcas } from '../lib/patrocinadores';

// A tela de entrada mudou de aparência, e ganhou dois controles que MUDAM
// comportamento. O que este arquivo protege é o comportamento — não o desenho.

const entrar = vi.fn();

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ login: entrar })
}));

// Esta configuração não liga os globais do Vitest, então a limpeza automática
// do Testing Library não roda: sem isto cada `render` EMPILHA outra tela no
// documento, e as buscas passam a achar "vários elementos" — foi exatamente o
// que aconteceu aqui antes.
afterEach(cleanup);

const telaLimpa = () => {
  try { localStorage.clear(); } catch { /* bloqueado */ }
  try { sessionStorage.clear(); } catch { /* bloqueado */ }
};

describe('tela de entrada — o formulário continua o mesmo', () => {
  beforeEach(() => { entrar.mockReset(); entrar.mockResolvedValue({ id: 1 }); telaLimpa(); });

  it('envia email e senha para o login', async () => {
    const usuario = userEvent.setup();
    render(<Auth />);
    await usuario.type(screen.getByLabelText(/email/i), 'atleta@exemplo.com');
    await usuario.type(screen.getByLabelText(/senha/i), 'senha-bem-longa');
    await usuario.click(screen.getByRole('button', { name: /entrar/i }));
    expect(entrar).toHaveBeenCalledTimes(1);
    expect(entrar.mock.calls[0][0]).toMatchObject({ email: 'atleta@exemplo.com', password: 'senha-bem-longa' });
  });

  it('a recusa do servidor aparece com papel de alerta', async () => {
    entrar.mockRejectedValueOnce(new Error('Credenciais inválidas'));
    const usuario = userEvent.setup();
    render(<Auth />);
    await usuario.type(screen.getByLabelText(/email/i), 'a@b.com');
    await usuario.type(screen.getByLabelText(/senha/i), 'senha-bem-longa');
    await usuario.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Credenciais inválidas');
  });
});

describe('lembrar de mim', () => {
  beforeEach(() => { entrar.mockReset(); entrar.mockResolvedValue({ id: 1 }); telaLimpa(); });

  it('vem marcada, e manda lembrar = true', async () => {
    const usuario = userEvent.setup();
    render(<Auth />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    await usuario.type(screen.getByLabelText(/email/i), 'a@b.com');
    await usuario.type(screen.getByLabelText(/senha/i), 'senha-bem-longa');
    await usuario.click(screen.getByRole('button', { name: /entrar/i }));
    expect(entrar.mock.calls[0][0].lembrar).toBe(true);
  });

  it('desmarcada, manda lembrar = false', async () => {
    const usuario = userEvent.setup();
    render(<Auth />);
    await usuario.click(screen.getByRole('checkbox'));
    await usuario.type(screen.getByLabelText(/email/i), 'a@b.com');
    await usuario.type(screen.getByLabelText(/senha/i), 'senha-bem-longa');
    await usuario.click(screen.getByRole('button', { name: /entrar/i }));
    expect(entrar.mock.calls[0][0].lembrar).toBe(false);
  });

  it('o alvo de toque é o rótulo inteiro, não só a caixinha', async () => {
    // No telefone ninguém acerta 17px de propósito. Clicar no TEXTO precisa
    // alternar a caixa.
    const usuario = userEvent.setup();
    render(<Auth />);
    const caixa = screen.getByRole('checkbox');
    expect(caixa).toBeChecked();
    await usuario.click(screen.getByText(/lembrar de mim/i));
    expect(caixa).not.toBeChecked();
  });
});

describe('onde o token fica guardado', () => {
  beforeEach(telaLimpa);

  it('lembrando, sobrevive a fechar o navegador', () => {
    setAuthToken('token-do-atleta', { lembrar: true });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-do-atleta');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthToken()).toBe('token-do-atleta');
  });

  it('sem lembrar, acaba junto com a aba', () => {
    setAuthToken('token-do-atleta', { lembrar: false });
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-do-atleta');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthToken()).toBe('token-do-atleta');
  });

  it('NUNCA fica nos dois lugares — trocar de escolha apaga o anterior', () => {
    // Sem isto nasce sessão fantasma: a pessoa desmarca "lembrar", fecha o
    // navegador e continua entrada por causa do que sobrou no localStorage.
    setAuthToken('token-antigo', { lembrar: true });
    setAuthToken('token-novo', { lembrar: false });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-novo');

    setAuthToken('token-mais-novo', { lembrar: true });
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-mais-novo');
  });

  it('sair limpa os dois cofres', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, 'resto-antigo');
    sessionStorage.setItem(AUTH_STORAGE_KEY, 'resto-da-aba');
    clearAuthToken();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(getAuthToken()).toBeNull();
  });

  it('sem dizer nada, mantém o comportamento antigo: localStorage', () => {
    // Cadastro e renovação de sessão não perguntam nada à pessoa. Mudar o
    // padrão deles por tabela derrubaria quem já estava entrado.
    setAuthToken('token-sem-escolha');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe('token-sem-escolha');
  });
});

describe('esqueci a senha', () => {
  beforeEach(() => { entrar.mockReset(); entrar.mockResolvedValue({ id: 1 }); telaLimpa(); });

  it('começa fechado e abre no clique', async () => {
    const usuario = userEvent.setup();
    render(<Auth />);
    const botao = screen.getByRole('button', { name: /esqueci a senha/i });
    expect(botao).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: /recupera/i })).toBeNull();
    await usuario.click(botao);
    expect(botao).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: /recupera/i })).toBeInTheDocument();
  });

  it('NÃO oferece campo nem botão de envio de link', async () => {
    // O projeto não tem provedor de envio, rota de redefinição nem tabela de
    // token. Um formulário de "enviar link" mandaria a pessoa esperar um e-mail
    // que nunca chega.
    const usuario = userEvent.setup();
    render(<Auth />);
    await usuario.click(screen.getByRole('button', { name: /esqueci a senha/i }));
    const painel = screen.getByRole('region', { name: /recupera/i });
    expect(within(painel).queryByRole('textbox')).toBeNull();
    expect(within(painel).queryByRole('button')).toBeNull();
    expect(painel.textContent).toMatch(/federa/i);
  });

  it('abrir o painel não envia nada nem mexe no formulário', async () => {
    const usuario = userEvent.setup();
    render(<Auth />);
    await usuario.type(screen.getByLabelText(/email/i), 'a@b.com');
    await usuario.click(screen.getByRole('button', { name: /esqueci a senha/i }));
    expect(entrar).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/email/i)).toHaveValue('a@b.com');
  });
});

describe('parede de patrocínio na entrada', () => {
  beforeEach(telaLimpa);

  it('anuncia cada patrocinador UMA vez, apesar das cópias da esteira', () => {
    // As cópias existem para cobrir a janela. Anunciar o mesmo patrocinador
    // quatro vezes é ruído para quem usa leitor de tela.
    //
    // A busca é DENTRO da parede de propósito: a marca da federação no topo da
    // tela e o patrocinador Silver "Muscle Contest International" são a mesma
    // marca em papéis diferentes, e têm o mesmo texto alternativo. Procurar no
    // documento inteiro acusaria duplicata onde não há.
    const { container } = render(<Auth />);
    const parede = within(container.querySelector('.parede-patro'));
    for (const marca of MARCAS) {
      expect(parede.getAllByAltText(marca.nome), `${marca.nome} aparece mais de uma vez`).toHaveLength(1);
    }
  });

  it('as cópias ficam fora da árvore de acessibilidade', () => {
    const { container } = render(<Auth />);
    const grupos = container.querySelectorAll('.esteira-grupo');
    expect(grupos.length).toBeGreaterThan(categoriasComMarcas().length);
    const clones = [...grupos].filter(g => g.getAttribute('aria-hidden') === 'true');
    expect(clones.length).toBeGreaterThan(0);
    for (const clone of clones) {
      for (const img of clone.querySelectorAll('img')) expect(img.getAttribute('alt')).toBe('');
    }
  });

  it('mostra as quatro faixas, na ordem da hierarquia', () => {
    const { container } = render(<Auth />);
    const rotulos = [...container.querySelectorAll('.faixa-patro-cab span')].map(e => e.textContent);
    expect(rotulos).toHaveLength(categoriasComMarcas().length);
    // O rótulo passa pelo dicionário: o que aparece na tela NÃO pode ser a
    // chave crua. Se `t` não achasse a entrada, devolveria 'patrocinio.gold'.
    for (const rotulo of rotulos) expect(rotulo).not.toMatch(/^patrocinio\./);
    // E o nome da cota vendida em contrato continua lá.
    expect(rotulos.join(' | ')).toMatch(/Global/);
    expect(rotulos.join(' | ')).toMatch(/Diamante/);
    expect(rotulos.join(' | ')).toMatch(/Gold/);
    expect(rotulos.join(' | ')).toMatch(/Silver/);
  });

  it('as faixas vizinhas correm em sentidos opostos', () => {
    const { container } = render(<Auth />);
    const sentidos = [...container.querySelectorAll('.esteira')].map(e => e.dataset.sentido);
    expect(sentidos.length).toBe(categoriasComMarcas().length);
    for (let i = 1; i < sentidos.length; i += 1) {
      expect(sentidos[i], `faixa ${i} repete o sentido da anterior`).not.toBe(sentidos[i - 1]);
    }
  });

  it('a parede fica DEPOIS do formulário no documento', () => {
    // É contexto, não é o que a pessoa veio fazer. Na ordem de leitura e na de
    // tabulação, o formulário vem primeiro.
    const { container } = render(<Auth />);
    const formulario = container.querySelector('form');
    const parede = container.querySelector('.parede-patro');
    expect(formulario.compareDocumentPosition(parede) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('cada arte aponta para um arquivo em /patrocinadores/', () => {
    const { container } = render(<Auth />);
    const parede = within(container.querySelector('.parede-patro'));
    for (const marca of MARCAS) {
      expect(parede.getByAltText(marca.nome).getAttribute('src')).toBe(`/patrocinadores/${marca.arquivo}`);
    }
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// O ASSISTENTE DE CADASTRO.
//
// O que se prova aqui não é que os campos aparecem — é o que o assistente
// MANDA e o que ele RECUSA a mandar:
//
//  - o corpo do cadastro nunca leva CPF (o servidor o recusa);
//  - dois cliques no botão não criam duas contas;
//  - o serviço de CEP fora não trava o cadastro;
//  - um erro numa etapa que a pessoa não está vendo a leva de volta até ele.
// ==========================================================================

const espioes = vi.hoisted(() => ({ register: null, buscarCep: null }));

// Os dois mocks DELEGAM em vez de devolver o espião capturado: a fábrica roda
// uma vez só, e devolver `espioes.register` direto congelaria o valor que ele
// tinha naquele instante — cada `beforeEach` trocaria o espião sem que o
// componente visse a troca.
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ register: (...argumentos) => espioes.register(...argumentos) })
}));

vi.mock('../lib/cep', async () => {
  const real = await vi.importActual('../lib/cep');
  return { ...real, buscarCep: (...argumentos) => espioes.buscarCep(...argumentos) };
});

const { default: CadastroWizard } = await import('./cadastroWizard');

beforeEach(() => {
  espioes.register = vi.fn(() => Promise.resolve({ id: 'u1' }));
  espioes.buscarCep = vi.fn(async () => ({ situacao: 'indisponivel' }));
});
afterEach(cleanup);

// Os rótulos são ancorados em `^` porque `Field` põe a dica DENTRO do
// <label>: o nome acessível do campo CEP é "CEP * Preenchemos o endereço para
// você.", que casa com /Endereço/ e colide com o campo Endereço.
const digitar = async (usuario, rotulo, valor) => {
  const campo = screen.getByLabelText(new RegExp(`^${rotulo}`, 'i'));
  await usuario.clear(campo);
  await usuario.type(campo, valor);
  return campo;
};

const continuar = async usuario => usuario.click(screen.getByRole('button', { name: /continuar|criar conta/i }));

// Preenche do zero até a etapa pedida.
async function ate(etapa, usuario, { papel = 'MEDIA' } = {}) {
  if (etapa > 1) {
    await digitar(usuario, 'Nome completo', 'Maria Silva');
    await digitar(usuario, 'Data de nascimento', '1995-03-10');
    await usuario.selectOptions(screen.getByLabelText(/^Você é/i), papel);
    await continuar(usuario);
  }
  if (etapa > 2) {
    await digitar(usuario, 'E-mail', 'maria@mci.test');
    await digitar(usuario, 'Senha', 'senha-forte-2026');
    await digitar(usuario, 'Telefone', '65999991234');
    await digitar(usuario, 'WhatsApp', '65988884321');
    await continuar(usuario);
  }
  if (etapa > 3) {
    await digitar(usuario, 'CEP', '78000000');
    await digitar(usuario, 'Endereço', 'Avenida Rubens de Mendonça');
    await digitar(usuario, 'Número', '1856');
    await digitar(usuario, 'Cidade', 'Cuiabá');
    await usuario.selectOptions(screen.getByLabelText(/^UF/i), 'MT');
    await continuar(usuario);
  }
  for (let atual = 4; atual < etapa; atual += 1) await continuar(usuario);
}

describe('navegação por etapas', () => {
  it('não avança com a etapa 1 vazia, e acusa no campo', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await continuar(usuario);

    expect(await screen.findByText('Informe seu nome completo')).toBeInTheDocument();
    // Continua na etapa 1: o rótulo da etapa 2 não apareceu.
    expect(screen.queryByLabelText(/^E-mail/i)).not.toBeInTheDocument();
  });

  it('o erro some assim que a pessoa corrige o campo', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await continuar(usuario);
    expect(await screen.findByText('Informe seu nome completo')).toBeInTheDocument();

    await digitar(usuario, 'Nome completo', 'Maria');
    expect(screen.queryByText('Informe seu nome completo')).not.toBeInTheDocument();
  });

  it('voltar preserva o que já foi digitado', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(2, usuario);
    await usuario.click(screen.getByRole('button', { name: /voltar/i }));

    expect(screen.getByLabelText(/^Nome completo/i)).toHaveValue('Maria Silva');
  });

  it('a etapa 4 fala de filiação para atleta, e não fala para os demais', async () => {
    const usuario = userEvent.setup();
    const { unmount } = render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(4, usuario, { papel: 'ATHLETE' });
    expect(screen.getByText(/Sua filiação é confirmada pela federação/i)).toBeInTheDocument();

    unmount();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);
    await ate(4, usuario, { papel: 'MEDIA' });
    expect(screen.getByText(/Não precisamos de mais nada/i)).toBeInTheDocument();
  });
});

describe('CEP', () => {
  it('preenche endereço, cidade e UF quando encontra', async () => {
    espioes.buscarCep = vi.fn(async () => ({
      situacao: 'encontrado',
      endereco: { addressLine: 'Avenida Historiador Rubens de Mendonça', bairro: 'Bosque', city: 'Cuiabá', state: 'MT' }
    }));
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(3, usuario);
    await digitar(usuario, 'CEP', '78000000');

    await waitFor(() => expect(screen.getByLabelText(/^Endereço/i)).toHaveValue('Avenida Historiador Rubens de Mendonça'));
    expect(screen.getByLabelText(/^Cidade/i)).toHaveValue('Cuiabá');
    expect(screen.getByLabelText(/^UF/i)).toHaveValue('MT');
  });

  // Quem digitou o endereço antes de completar o CEP não pode ver o próprio
  // texto ser trocado pelo do serviço — é o jeito mais rápido de mandar uma
  // pessoa para o endereço errado sem ela perceber.
  it('a consulta NÃO sobrescreve o que a pessoa já digitou à mão', async () => {
    espioes.buscarCep = vi.fn(async () => ({
      situacao: 'encontrado',
      endereco: { addressLine: 'Rua Do Serviço', bairro: 'Centro', city: 'Várzea Grande', state: 'MT' }
    }));
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(3, usuario);
    await digitar(usuario, 'Endereço', 'Rua Que Eu Digitei');
    await digitar(usuario, 'Cidade', 'Cuiabá');
    await digitar(usuario, 'CEP', '78000000');

    await waitFor(() => expect(espioes.buscarCep).toHaveBeenCalled());
    expect(screen.getByLabelText(/^Endereço/i)).toHaveValue('Rua Que Eu Digitei');
    expect(screen.getByLabelText(/^Cidade/i)).toHaveValue('Cuiabá');
    // O que estava vazio, sim, é preenchido.
    expect(screen.getByLabelText(/^UF/i)).toHaveValue('MT');
  });

  // O ponto mais importante desta tela: o ViaCEP não é nosso.
  it('serviço de CEP fora NÃO impede o cadastro — a pessoa preenche à mão', async () => {
    espioes.buscarCep = vi.fn(async () => ({ situacao: 'indisponivel' }));
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(4, usuario);

    // Chegou à etapa 4 mesmo com o serviço fora.
    expect(screen.getByText(/Não precisamos de mais nada/i)).toBeInTheDocument();
    expect(espioes.buscarCep).toHaveBeenCalled();
  });

  it('não consulta a rede a cada tecla, só ao completar 8 dígitos', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(3, usuario);
    espioes.buscarCep.mockClear();
    await digitar(usuario, 'CEP', '78000000');

    expect(espioes.buscarCep).toHaveBeenCalledTimes(1);
  });
});

describe('envio', () => {
  it('manda o cadastro normalizado e SEM CPF', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);

    await ate(5, usuario, { papel: 'ATHLETE' });
    await usuario.click(screen.getByRole('button', { name: /criar conta/i }));

    await waitFor(() => expect(espioes.register).toHaveBeenCalledTimes(1));
    const corpo = espioes.register.mock.calls[0][0];

    expect(corpo.phone).toBe('65999991234');
    expect(corpo.postalCode).toBe('78000000');
    expect(corpo.state).toBe('MT');
    expect(corpo.role).toBe('ATHLETE');
    // Mesmo sendo atleta: o CPF vai na SOLICITAÇÃO, depois. Mandá-lo aqui
    // transformaria todo cadastro de atleta num 400.
    expect(corpo).not.toHaveProperty('cpf');
    expect(corpo).not.toHaveProperty('affiliationId');
  });

  // DOIS envios ANTES de o estado assentar.
  //
  // `usuario.click` duas vezes não provaria nada: o primeiro clique deixa o
  // botão `disabled` e o segundo nem chega ao manipulador — o teste passaria
  // mesmo sem trava alguma (medido: sobreviveu à remoção da trava). Dois
  // `submit` síncronos no formulário reproduzem o caso real, em que os dois
  // eventos chegam antes de o React re-renderizar.
  it('dois envios antes de o estado assentar criam uma conta só', async () => {
    let liberar;
    espioes.register = vi.fn(() => new Promise(resolve => { liberar = resolve; }));

    const usuario = userEvent.setup();
    const { container } = render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);
    await ate(5, usuario);

    const formulario = container.querySelector('form');
    fireEvent.submit(formulario);
    fireEvent.submit(formulario);

    await waitFor(() => expect(espioes.register).toHaveBeenCalled());
    expect(espioes.register).toHaveBeenCalledTimes(1);
    liberar({ id: 'u1' });
  });

  it('e-mail já cadastrado devolve a pessoa à etapa do e-mail, com o erro no campo', async () => {
    const recusa = Object.assign(new Error('E-mail já cadastrado'), { status: 409 });
    espioes.register = vi.fn(() => Promise.reject(recusa));

    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);
    await ate(5, usuario);
    await usuario.click(screen.getByRole('button', { name: /criar conta/i }));

    // Voltou para a etapa 2 — deixá-la na revisão com um erro sobre um campo
    // que ela não vê é um beco sem saída.
    expect(await screen.findByText('Este e-mail já está cadastrado')).toBeInTheDocument();
    expect(screen.getByLabelText(/^E-mail/i)).toHaveValue('maria@mci.test');
  });

  it('falha de rede deixa tentar de novo em vez de travar o botão', async () => {
    espioes.register = vi.fn(() => Promise.reject(new Error('Não foi possível conectar à API.')));

    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);
    await ate(5, usuario);
    await usuario.click(screen.getByRole('button', { name: /criar conta/i }));

    expect(await screen.findByText('Não foi possível conectar à API.')).toBeInTheDocument();

    const botao = screen.getByRole('button', { name: /criar conta/i });
    expect(botao).toBeEnabled();
    await usuario.click(botao);
    expect(espioes.register).toHaveBeenCalledTimes(2);
  });

  // Este teste prova o BLOQUEIO na etapa, e não a revalidação final.
  //
  // Foi medido: removendo a revalidação de todas as etapas em `enviar`, ele
  // continuava passando — porque a pessoa nunca chega ao envio, `avancar` já
  // a barra na etapa 1. A revalidação final permanece no código como segunda
  // linha, mas é inalcançável pela interface, e afirmar que este teste a cobre
  // seria falso.
  it('apagar um campo já validado impede voltar à revisão, e nada é enviado', async () => {
    const usuario = userEvent.setup();
    render(<CadastroWizard aoVoltarParaEntrada={() => {}} />);
    await ate(5, usuario);

    await usuario.click(screen.getAllByRole('button', { name: /editar/i })[0]);
    await usuario.clear(screen.getByLabelText(/^Nome completo/i));
    await continuar(usuario);
    expect(await screen.findByText('Informe seu nome completo')).toBeInTheDocument();

    expect(espioes.register).not.toHaveBeenCalled();
  });
});

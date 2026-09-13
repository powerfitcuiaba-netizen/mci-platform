import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// SOLICITAÇÃO DE PERFIL DE ATLETA — as duas pontas.
//
// Os dublês devolvem o formato REAL da API — `{ items: [...] }` para as
// listagens, objeto puro para as demais. Na primeira versão deste arquivo eles
// devolviam um array em `meus`, que é o que eu tinha suposto; os testes
// passaram todos e a tela quebrava no navegador, porque a suposição estava nos
// dois lados. Um dublê que inventa o formato só testa a própria invenção.
//
// A regra que este arquivo existe para defender: **CPF nunca aparece em
// listagem, nunca viaja em URL**. Ele é digitado por quem é dono dele, sai
// uma vez no corpo de uma resposta para um operador autorizado, e some da
// tela no momento em que o pedido é decidido.
//
// O resto — situação, cancelamento, recusa com motivo, não analisar o próprio
// pedido — é o que faz a fila contar a história certa.
// ==========================================================================

const espioes = vi.hoisted(() => ({
  meus: null, criar: null, cancelar: null, filiacoes: null,
  listar: null, analisar: null, aprovar: null, rejeitar: null, usuario: null
}));

vi.mock('../services/api', () => {
  const api = {
    athleteRequests: {
      meus: (...a) => espioes.meus(...a),
      criar: (...a) => espioes.criar(...a),
      cancelar: (...a) => espioes.cancelar(...a),
      listar: (...a) => espioes.listar(...a),
      analisar: (...a) => espioes.analisar(...a),
      aprovar: (...a) => espioes.aprovar(...a),
      rejeitar: (...a) => espioes.rejeitar(...a)
    },
    affiliations: { list: (...a) => espioes.filiacoes(...a) }
  };
  return { api, default: api, refreshData: () => {} };
});

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: espioes.usuario, refreshSession: () => Promise.resolve(null) })
}));

const { default: MinhaSolicitacao } = await import('./minhaSolicitacao');
const { default: AdminSolicitacoes } = await import('./adminSolicitacoes');

const PEDIDO = {
  id: 'ped-1', userId: 'u-atleta', organizationId: 'org-1',
  fullName: 'Maria Silva', sex: 'FEMALE', birthDate: '1995-03-10T12:00:00.000Z',
  affiliationId: 'fil-1', affiliationNumber: 'NPC-123',
  affiliation: { id: 'fil-1', name: 'Federação de Mato Grosso', code: 'FMT', state: 'MT' },
  user: { id: 'u-atleta', name: 'Maria Silva', email: 'maria@mci.test', city: 'Cuiabá', state: 'MT' },
  status: 'PENDING', rejectionReason: null, createdAt: '2026-09-01T12:00:00.000Z',
  reviewedAt: null, reviewedById: null, athleteId: null
};

beforeEach(() => {
  espioes.usuario = { id: 'u-atleta', name: 'Maria Silva', athleteId: null };
  espioes.meus = vi.fn(async () => ({ items: [] }));
  espioes.criar = vi.fn(async () => ({ ...PEDIDO }));
  espioes.cancelar = vi.fn(async () => ({ ...PEDIDO, status: 'CANCELLED' }));
  espioes.filiacoes = vi.fn(async () => ({
    items: [
      { id: 'fil-1', name: 'Federação de Mato Grosso', code: 'FMT', state: 'MT', active: true },
      { id: 'fil-2', name: 'Federação Extinta', code: 'FEX', state: 'GO', active: false }
    ]
  }));
  espioes.listar = vi.fn(async () => ({ items: [{ ...PEDIDO }], nextCursor: null }));
  espioes.analisar = vi.fn(async () => ({ ...PEDIDO, cpf: '11144477735' }));
  espioes.aprovar = vi.fn(async () => ({ ...PEDIDO, status: 'APPROVED' }));
  espioes.rejeitar = vi.fn(async () => ({ ...PEDIDO, status: 'REJECTED' }));
});
afterEach(cleanup);

const preencherPedido = async usuario => {
  await usuario.type(screen.getByLabelText(/^CPF/i), '11144477735');
  await usuario.selectOptions(screen.getByLabelText(/^Categoria de competição/i), 'FEMALE');
  await waitFor(() => expect(screen.getByLabelText(/^Entidade de filiação/i)).toBeEnabled());
  await usuario.selectOptions(screen.getByLabelText(/^Entidade de filiação/i), 'fil-1');
  await usuario.type(screen.getByLabelText(/^Número de registro/i), 'NPC-123');
};

// =========================== MINHA SOLICITAÇÃO =============================

describe('minha solicitação', () => {
  it('envia o pedido com o CPF só com dígitos, e sem escolher a organização', async () => {
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);

    await screen.findByLabelText(/^CPF/i);
    await preencherPedido(usuario);
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    await waitFor(() => expect(espioes.criar).toHaveBeenCalledTimes(1));
    const corpo = espioes.criar.mock.calls[0][0];

    expect(corpo.cpf).toBe('11144477735');
    expect(corpo.affiliationId).toBe('fil-1');
    expect(corpo.affiliationNumber).toBe('NPC-123');
    // A federação é DERIVADA da filiação no servidor. Mandá-la daqui deixaria
    // o cliente escolher a que federação endereçar o próprio pedido.
    expect(corpo).not.toHaveProperty('organizationId');
  });

  it('CPF com dígito verificador errado nem chega à rede', async () => {
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);

    await screen.findByLabelText(/^CPF/i);
    await usuario.type(screen.getByLabelText(/^CPF/i), '11144477736');
    await usuario.selectOptions(screen.getByLabelText(/^Categoria de competição/i), 'FEMALE');
    await waitFor(() => expect(screen.getByLabelText(/^Entidade de filiação/i)).toBeEnabled());
    await usuario.selectOptions(screen.getByLabelText(/^Entidade de filiação/i), 'fil-1');
    await usuario.type(screen.getByLabelText(/^Número de registro/i), 'NPC-123');
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    expect(await screen.findByText('CPF inválido')).toBeInTheDocument();
    expect(espioes.criar).not.toHaveBeenCalled();
  });

  // Depois do envio o CPF não pode continuar legível para quem passar pelo
  // computador.
  it('o CPF sai da tela assim que o pedido é aceito', async () => {
    espioes.criar = vi.fn(async () => ({ ...PEDIDO }));
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);

    await screen.findByLabelText(/^CPF/i);
    await preencherPedido(usuario);
    const campo = screen.getByLabelText(/^CPF/i);
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    await waitFor(() => expect(campo).toHaveValue(''));
  });

  it('filiação inativa não é oferecida — escolhê-la terminaria em 422', async () => {
    render(<MinhaSolicitacao notificar={() => {}} />);

    const seletor = await screen.findByLabelText(/^Entidade de filiação/i);
    await waitFor(() => expect(seletor).toBeEnabled());
    const opcoes = within(seletor).getAllByRole('option').map(o => o.textContent);

    expect(opcoes.join(' ')).toContain('Federação de Mato Grosso');
    expect(opcoes.join(' ')).not.toContain('Federação Extinta');
  });

  it('pedido em análise mostra a situação e o caminho para desistir, sem formulário', async () => {
    espioes.meus = vi.fn(async () => ({ items: [{ ...PEDIDO }] }));
    render(<MinhaSolicitacao notificar={() => {}} />);

    expect(await screen.findByText(/está na fila da federação/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancelar solicitação/i })).toBeInTheDocument();
    // Com um pedido em aberto, pedir de novo daria 409.
    expect(screen.queryByLabelText(/^CPF/i)).not.toBeInTheDocument();
  });

  // O servidor não devolve o CPF nesta rota. Se um dia devolver, esta tela não
  // pode passar a exibi-lo por acidente.
  it('a tela do solicitante não mostra CPF nenhum, mesmo se a API mandar', async () => {
    espioes.meus = vi.fn(async () => ({ items: [{ ...PEDIDO, cpf: '11144477735' }] }));
    render(<MinhaSolicitacao notificar={() => {}} />);

    await screen.findByText(/está na fila da federação/i);
    expect(document.body.textContent).not.toContain('11144477735');
    expect(document.body.textContent).not.toContain('111.444.777-35');
  });

  // O motivo aparece em DOIS lugares de propósito, e não é engano: no aviso
  // acima do formulário, que diz o que corrigir agora, e no histórico, que é o
  // registro do que já aconteceu. O teste confere o aviso, que é o que a
  // pessoa lê antes de digitar de novo.
  it('recusa anterior mostra o motivo no aviso e deixa pedir de novo', async () => {
    espioes.meus = vi.fn(async () => ({
      items: [{ ...PEDIDO, id: 'ped-0', status: 'REJECTED', rejectionReason: 'Número de registro não confere' }]
    }));
    render(<MinhaSolicitacao notificar={() => {}} />);

    const aviso = await screen.findByRole('status');
    expect(within(aviso).getByText(/Sua última solicitação foi recusada/i)).toBeInTheDocument();
    expect(within(aviso).getByText(/Número de registro não confere/)).toBeInTheDocument();

    expect(screen.getByLabelText(/^CPF/i)).toBeInTheDocument();
  });

  it('quem já é atleta não vê formulário de solicitação', async () => {
    espioes.usuario = { id: 'u-atleta', name: 'Maria Silva', athleteId: 'atl-1' };
    render(<MinhaSolicitacao notificar={() => {}} />);

    expect(await screen.findByText(/Você já compete pela MCI/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^CPF/i)).not.toBeInTheDocument();
  });
});

// ============================ FILA DO OPERADOR =============================

describe('fila do operador', () => {
  beforeEach(() => { espioes.usuario = { id: 'u-operador', name: 'Operador', athleteId: null }; });

  // A regra mais importante da fila.
  it('a LISTAGEM não traz nem mostra CPF', async () => {
    render(<AdminSolicitacoes notificar={() => {}} />);

    await screen.findAllByText('Maria Silva');
    expect(document.body.textContent).not.toContain('11144477735');
    expect(document.body.textContent).not.toContain('111.444.777-35');
    // A listagem também não pede o pedido individual, que é quem traz o CPF.
    expect(espioes.analisar).not.toHaveBeenCalled();
  });

  it('o CPF só aparece ao abrir UM pedido, e vai pelo corpo — nunca na URL', async () => {
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);

    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);

    expect(await screen.findByText('111.444.777-35')).toBeInTheDocument();
    expect(espioes.analisar).toHaveBeenCalledWith('ped-1');
    // Um único argumento: o id. Nada de objeto de consulta levando CPF.
    expect(espioes.analisar.mock.calls[0]).toHaveLength(1);
  });

  it('aprovar diz o que vai acontecer antes de acontecer', async () => {
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);
    await screen.findByText('111.444.777-35');

    expect(screen.getByText(/Aprovar cria o perfil de atleta de/i)).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: /aprovar e criar atleta/i }));

    await waitFor(() => expect(espioes.aprovar).toHaveBeenCalledWith('ped-1'));
  });

  it('recusar exige motivo, e o motivo é o que viaja', async () => {
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);
    await screen.findByText('111.444.777-35');

    await usuario.click(screen.getByRole('button', { name: /^recusar$/i }));

    const confirmar = screen.getByRole('button', { name: /confirmar recusa/i });
    // Recusa sem motivo deixaria o solicitante sem saber o que corrigir.
    expect(confirmar).toBeDisabled();

    await usuario.type(screen.getByLabelText(/^Motivo da recusa/i), 'Número de registro não confere');
    expect(confirmar).toBeEnabled();
    await usuario.click(confirmar);

    await waitFor(() => expect(espioes.rejeitar).toHaveBeenCalledWith('ped-1', 'Número de registro não confere'));
  });

  // Quem pede não concede. O servidor recusa com SELF_REVIEW_FORBIDDEN; a tela
  // não deve oferecer um botão que só existe para dar erro.
  it('o próprio solicitante não recebe botão de aprovar nem de recusar', async () => {
    espioes.usuario = { id: 'u-atleta', name: 'Maria Silva', athleteId: null };
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);

    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);
    await screen.findByText(/Esta solicitação é sua/i);

    expect(screen.queryByRole('button', { name: /aprovar e criar atleta/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^recusar$/i })).not.toBeInTheDocument();
  });

  it('pedido já decidido não oferece decisão de novo', async () => {
    espioes.listar = vi.fn(async () => ({ items: [{ ...PEDIDO, status: 'APPROVED' }], nextCursor: null }));
    espioes.analisar = vi.fn(async () => ({ ...PEDIDO, status: 'APPROVED', cpf: null, reviewedAt: '2026-09-02T12:00:00.000Z' }));

    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);

    expect(await screen.findByText(/já foi aprovada/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aprovar e criar atleta/i })).not.toBeInTheDocument();
    // Aprovado já não guarda o documento: ele vive em AthleteIdentity.
    expect(screen.getByText(/Já não está guardado neste pedido/i)).toBeInTheDocument();
  });

  it('o filtro de situação vai para o servidor, e não é peneira de tela', async () => {
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await screen.findAllByText('Maria Silva');

    expect(espioes.listar.mock.calls[0][0]).toMatchObject({ status: 'PENDING' });

    await usuario.click(screen.getByRole('button', { name: /^recusadas$/i }));
    await waitFor(() => {
      const ultima = espioes.listar.mock.calls.at(-1)[0];
      expect(ultima).toMatchObject({ status: 'REJECTED' });
    });
  });
});

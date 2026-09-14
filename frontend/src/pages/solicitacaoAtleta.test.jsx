import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  listar: null, analisar: null, aprovar: null, rejeitar: null, usuario: null,
  enviarFoto: null, removerFoto: null, escopada: null, buscarMidia: null
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
      rejeitar: (...a) => espioes.rejeitar(...a),
      enviarFoto: (...a) => espioes.enviarFoto(...a),
      removerFoto: (...a) => espioes.removerFoto(...a)
    },
    // A vitrine de autocadastro. `affiliations.list` continua existindo para o
    // operador, mas a tela do solicitante NÃO a usa — ela devolve vazio para
    // quem não tem vínculo.
    publicApi: { affiliations: (...a) => espioes.filiacoes(...a) },
    affiliations: { list: (...a) => espioes.escopada(...a) }
  };
  return {
    api,
    default: api,
    refreshData: () => {},
    // `ui.jsx` importa estes dois daqui. Fora do dublê, `ProtectedMedia`
    // chamaria `undefined` e derrubaria a árvore inteira — o corpo fica vazio
    // e o erro sai como "não achei o texto", que manda procurar no lugar errado.
    fetchMediaObjectUrl: (...a) => espioes.buscarMidia(...a),
    releaseMediaObjectUrl: () => {}
  };
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
  // `ProtectedMedia` busca a imagem com o token e devolve um object URL —
  // jsdom não traz `fetch` nem `createObjectURL`.
  espioes.buscarMidia = vi.fn(async () => 'blob:midia');
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:previa');
  globalThis.URL.revokeObjectURL = vi.fn();

  espioes.usuario = { id: 'u-atleta', name: 'Maria Silva', athleteId: null };
  espioes.meus = vi.fn(async () => ({ items: [] }));
  espioes.criar = vi.fn(async () => ({ ...PEDIDO }));
  espioes.cancelar = vi.fn(async () => ({ ...PEDIDO, status: 'CANCELLED' }));
  // A vitrine já devolve só o elegível — é o servidor que filtra.
  espioes.filiacoes = vi.fn(async () => ({
    items: [
      { id: 'fil-1', name: 'NPC — National Physique Committee', code: 'NPC', kind: 'ENTITY', state: 'MT', organization: { name: 'Federação de Mato Grosso' } }
    ]
  }));
  espioes.escopada = vi.fn(async () => ({ items: [] }));
  espioes.enviarFoto = vi.fn(async () => ({ ...PEDIDO, hasPhoto: true }));
  espioes.removerFoto = vi.fn(async () => ({ ...PEDIDO, hasPhoto: false }));
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

  // A tela do solicitante NÃO pode usar `GET /affiliations`: aquela rota é
  // escopada ao vínculo do ator, e quem acabou de criar conta não tem nenhum —
  // devolvia vazio e a solicitação era impossível. Este teste trava a origem
  // da lista, que é o bloqueio que a FASE 1.1 veio resolver.
  it('a lista vem da vitrine de autocadastro, e não da rota escopada por vínculo', async () => {
    render(<MinhaSolicitacao notificar={() => {}} />);

    const seletor = await screen.findByLabelText(/^Entidade de filiação/i);
    await waitFor(() => expect(seletor).toBeEnabled());
    expect(within(seletor).getAllByRole('option').map(o => o.textContent).join(' ')).toContain('NPC');

    expect(espioes.filiacoes).toHaveBeenCalled();
    expect(espioes.escopada, 'a tela usou a rota escopada, que devolve vazio para conta nova').not.toHaveBeenCalled();

    // O `limit` que a tela manda tem de caber no teto das rotas públicas
    // (100). Mandar 200 devolvia 400 e a lista vinha vazia — medido no
    // navegador, porque o dublê aceitava qualquer coisa.
    const parametros = espioes.filiacoes.mock.calls[0][0];
    if (parametros?.limit !== undefined) expect(parametros.limit).toBeLessThanOrEqual(100);
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

  // A decisão é de OUTRA pessoa, noutra sessão. Sem recarga, quem fica na
  // tela esperando vê "em análise" para sempre — medido no navegador.
  it('com pedido em análise a tela volta a consultar sozinha; decidido, para', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      espioes.meus = vi.fn(async () => ({ items: [{ ...PEDIDO }] }));
      render(<MinhaSolicitacao notificar={() => {}} />);
      await waitFor(() => expect(espioes.meus).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(61000);
      await waitFor(() => expect(espioes.meus.mock.calls.length).toBeGreaterThan(1));

      // Decidido: o ciclo para. Uma última consulta ainda sai — é a que
      // DESCOBRE a decisão, e o intervalo só se desarma depois que o estado
      // muda. O que não pode é continuar consultando a cada minuto para
      // sempre: em três ciclos (180s), no máximo essa única sobra.
      espioes.meus = vi.fn(async () => ({ items: [{ ...PEDIDO, status: 'APPROVED' }] }));
      // Um ciclo de cada vez, com espaço para o React reprocessar entre eles:
      // avançar 180s de uma vez dispara os três tiques antes de o efeito
      // desarmar, e mediria o agendador de teste, não o comportamento.
      for (let ciclo = 0; ciclo < 3; ciclo += 1) {
        await vi.advanceTimersByTimeAsync(61000);
        await waitFor(() => expect(true).toBe(true));
      }
      expect(espioes.meus.mock.calls.length, 'continuou consultando depois de decidido').toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
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

// ============================== A FOTO ====================================

describe('foto da solicitação', () => {
  const imagem = (nome = 'foto.png', tipo = 'image/png', bytes = 2048) =>
    new File([new Uint8Array(bytes)], nome, { type: tipo });

  beforeEach(() => {
    // jsdom não implementa object URLs; a pré-visualização depende deles.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:previa');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  const escolherFoto = async (usuario, arquivo) => {
    const entrada = document.getElementById('entrada-da-foto');
    await usuario.upload(entrada, arquivo);
  };

  it('a foto escolhida aparece em pré-visualização, e nada sobe ainda', async () => {
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByLabelText(/^CPF/i);

    await escolherFoto(usuario, imagem());

    expect(await screen.findByAltText(/Pré-visualização da foto/i)).toBeInTheDocument();
    // O envio só acontece quando a solicitação existir: antes disso não há id.
    expect(espioes.enviarFoto).not.toHaveBeenCalled();
    expect(espioes.criar).not.toHaveBeenCalled();
  });

  // `userEvent.upload` respeita o `accept` do input e DESCARTA o arquivo antes
  // de disparar `change` — o teste passaria sem conferência nenhuma na tela.
  // `fireEvent.change` entrega o arquivo como faz quem escolhe "todos os
  // arquivos" no seletor do sistema, que é o caso real que a conferência pega.
  it('tipo não aceito é barrado antes de qualquer chamada', async () => {
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByLabelText(/^CPF/i);

    const entrada = document.getElementById('entrada-da-foto');
    fireEvent.change(entrada, { target: { files: [imagem('desenho.svg', 'image/svg+xml')] } });

    expect(await screen.findByText(/precisa ser JPG, PNG ou WebP/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/Pré-visualização da foto/i)).not.toBeInTheDocument();
  });

  it('arquivo grande demais é barrado com os dois tamanhos na mensagem', async () => {
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByLabelText(/^CPF/i);

    fireEvent.change(document.getElementById('entrada-da-foto'), { target: { files: [imagem('grande.png', 'image/png', 6 * 1024 * 1024)] } });

    expect(await screen.findByText(/limite é 5,0 MB/i)).toBeInTheDocument();
    expect(espioes.enviarFoto).not.toHaveBeenCalled();
  });

  // A ordem importa: a rota da foto é `/athlete-requests/:id/photo`, e o id só
  // existe depois de a solicitação nascer.
  it('a solicitação nasce PRIMEIRO, e a foto sobe com o id dela', async () => {
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByLabelText(/^CPF/i);

    await preencherPedido(usuario);
    await escolherFoto(usuario, imagem());
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    await waitFor(() => expect(espioes.enviarFoto).toHaveBeenCalled());
    expect(espioes.criar).toHaveBeenCalledTimes(1);
    expect(espioes.enviarFoto.mock.calls[0][0]).toBe('ped-1');
    expect(espioes.enviarFoto.mock.calls[0][1]).toBeInstanceOf(File);
  });

  it('sem foto escolhida, o envio não chama a rota de foto', async () => {
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByLabelText(/^CPF/i);

    await preencherPedido(usuario);
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    await waitFor(() => expect(espioes.criar).toHaveBeenCalled());
    expect(espioes.enviarFoto).not.toHaveBeenCalled();
  });

  // O caso que mais confunde quem está preenchendo: a solicitação ENTROU e só
  // a foto falhou. Dizer "falhou" sem qualificar faria a pessoa tentar de novo
  // e bater num 409 de pedido duplicado.
  it('foto que falha depois da solicitação criada não faz a pessoa reenviar tudo', async () => {
    espioes.enviarFoto = vi.fn(async () => { throw new Error('Arquivo inválido.'); });
    const avisos = [];
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={(texto, tom) => avisos.push({ texto, tom })} />);
    await screen.findByLabelText(/^CPF/i);

    await preencherPedido(usuario);
    await escolherFoto(usuario, imagem());
    await usuario.click(screen.getByRole('button', { name: /enviar para análise/i }));

    await waitFor(() => expect(avisos.length).toBeGreaterThan(0));
    const aviso = avisos.at(-1);
    expect(aviso.texto).toMatch(/Solicitação enviada/i);
    expect(aviso.texto).toMatch(/foto não subiu/i);
    expect(aviso.texto).toMatch(/reenviá-la/i);
    // A solicitação foi criada uma única vez — nada de tentar de novo.
    expect(espioes.criar).toHaveBeenCalledTimes(1);
  });

  it('com pedido em análise, a foto pode ser trocada sem cancelar o pedido', async () => {
    espioes.meus = vi.fn(async () => ({ items: [{ ...PEDIDO, hasPhoto: true }] }));
    const usuario = userEvent.setup();
    render(<MinhaSolicitacao notificar={() => {}} />);
    await screen.findByText(/está na fila da federação/i);

    await escolherFoto(usuario, imagem('nova.png'));

    await waitFor(() => expect(espioes.enviarFoto).toHaveBeenCalledWith('ped-1', expect.any(File)));
  });

  it('o operador vê a foto na análise, buscada com o token e não por <img src> cru', async () => {
    espioes.usuario = { id: 'u-operador', name: 'Operador', athleteId: null };
    espioes.analisar = vi.fn(async () => ({ ...PEDIDO, cpf: '11144477735', hasPhoto: true }));

    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);
    await screen.findByText('111.444.777-35');

    // `ProtectedMedia` busca COM o token e expõe um object URL; um
    // <img src="/media/..."> cru não mandaria cabeçalho e levaria 401.
    await waitFor(() => expect(espioes.buscarMidia).toHaveBeenCalled());
    expect(espioes.buscarMidia).toHaveBeenCalledWith('/media/athlete-requests/ped-1/photo');
  });

  it('pedido sem foto avisa o operador em vez de mostrar um quadro vazio', async () => {
    espioes.usuario = { id: 'u-operador', name: 'Operador', athleteId: null };
    const usuario = userEvent.setup();
    render(<AdminSolicitacoes notificar={() => {}} />);
    await usuario.click((await screen.findAllByRole('button', { name: /^ver/i }))[0]);
    await screen.findByText('111.444.777-35');

    expect(screen.getByText(/veio sem foto/i)).toBeInTheDocument();
  });
});

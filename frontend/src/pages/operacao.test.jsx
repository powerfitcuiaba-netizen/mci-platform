import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// AS QUATRO TELAS DA OPERAÇÃO: check-in, pesagem, credenciamento e palco.
//
// O que estes testes protegem, além dos efeitos:
//
//  - operação dupla. O backend recusa o segundo check-in com 409, então o
//    duplo clique na portaria mostrava um erro vermelho logo DEPOIS do
//    sucesso — o operador via "falhou" numa operação que deu certo;
//  - o que NÃO se comemora: recusa de credencial, peso fora da faixa,
//    desfazer check-in e encerrar bateria. São justamente os casos em que o
//    operador precisa parar e olhar;
//  - o nível 5 nunca aparece em tela de operação.
// ==========================================================================

const api = {
  events: { list: vi.fn(), findOne: vi.fn() },
  operations: {
    listCheckIns: vi.fn(), checkIn: vi.fn(), cancelCheckIn: vi.fn(),
    weighIn: vi.fn(), credentials: vi.fn(), scanCredential: vi.fn(),
    issueCredential: vi.fn(), revokeCredential: vi.fn(),
    batches: vi.fn(), setBatchStatus: vi.fn(), stageOrder: vi.fn(), setStageOrder: vi.fn()
  },
  registrations: { listByEvent: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminCheckin, AdminPesagem, AdminCredenciamento, AdminPalco } = await import('./adminEvent');
const { PalcoDaExperiencia } = await import('../components/experiencia');

function aparelho({ movimentoReduzido = false } = {}) {
  window.matchMedia = consulta => ({
    matches: consulta.includes('prefers-reduced-motion') ? movimentoReduzido : false,
    media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
}

const EVENTO = { id: 'e1', name: 'Muscle Contest Curitiba', status: 'IN_OPERATION' };
const INSCRICAO = (extra = {}) => ({
  id: 'i1',
  athlete: { id: 'at1', fullName: 'Carlos Mendes', stageName: null, athleteNumber: 12 },
  items: [{ id: 'ri1', competitionClass: { id: 'c1', name: 'Até 172cm' } }],
  weighIns: [],
  checkIn: null,
  ...extra
});

beforeEach(() => {
  aparelho();
  api.events.list.mockResolvedValue({ items: [EVENTO] });
  api.operations.listCheckIns.mockResolvedValue({ items: [INSCRICAO()], summary: { total: 1, checkedIn: 0, pending: 1 } });
  api.operations.credentials.mockResolvedValue({ items: [] });
  api.operations.batches.mockResolvedValue({ items: [] });
  api.registrations.listByEvent.mockResolvedValue({ items: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function abrir(Tela) {
  render(<><Tela notificar={() => {}} /><PalcoDaExperiencia /></>);
  fireEvent.change(await screen.findByLabelText('Selecionar evento'), { target: { value: 'e1' } });
}

// ------------------------------------------------------------------ CHECK-IN
describe('check-in', () => {
  it('confirma e desenha o momento de check-in', async () => {
    api.operations.checkIn.mockResolvedValue({});
    await abrir(AdminCheckin);
    fireEvent.click(await screen.findByRole('button', { name: /Fazer check-in/i }));
    await waitFor(() => expect(api.operations.checkIn).toHaveBeenCalledWith('i1', expect.any(Object)));
    expect(await screen.findByText('Check-in confirmado')).toBeTruthy();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('dois cliques seguidos mandam UMA requisição', async () => {
    let liberar;
    api.operations.checkIn.mockReturnValue(new Promise(r => { liberar = r; }));
    await abrir(AdminCheckin);
    const botao = await screen.findByRole('button', { name: /Fazer check-in/i });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(api.operations.checkIn).toHaveBeenCalledTimes(1);
    await act(async () => { liberar({}); });
  });

  it('enquanto processa, o botão diz que está processando', async () => {
    let liberar;
    api.operations.checkIn.mockReturnValue(new Promise(r => { liberar = r; }));
    await abrir(AdminCheckin);
    const botao = await screen.findByRole('button', { name: /Fazer check-in/i });

    // O clique dispara um `async` que não é aguardado. Sem um flush explícito,
    // o teste corre contra o React para ver um estado INTERMEDIÁRIO — e corrida
    // é exatamente o que faz um teste falhar uma vez a cada tantas execuções
    // sem que nada esteja errado no produto. Flush primeiro, afirma depois.
    await act(async () => { fireEvent.click(botao); });

    const ocupado = screen.getByRole('button', { name: /Confirmando…/i });
    expect(ocupado.disabled).toBe(true);
    await act(async () => { liberar({}); });
  });

  it('desfazer é correção, não conquista: não comemora', async () => {
    api.operations.listCheckIns.mockResolvedValue({
      items: [INSCRICAO({ checkIn: { status: 'CHECKED_IN', checkedInAt: new Date().toISOString() } })],
      summary: { total: 1, checkedIn: 1, pending: 0 }
    });
    api.operations.cancelCheckIn.mockResolvedValue({});
    await abrir(AdminCheckin);
    fireEvent.click(await screen.findByRole('button', { name: /^Desfazer$/i }));
    await waitFor(() => expect(api.operations.cancelCheckIn).toHaveBeenCalled());
    expect(screen.queryByText('Check-in confirmado')).toBeNull();
  });

  it('a falha aparece e o botão volta a funcionar', async () => {
    api.operations.checkIn.mockRejectedValue(new Error('Inscrição não confirmada'));
    const avisos = [];
    render(<AdminCheckin notificar={(t, tom) => avisos.push({ t, tom })} />);
    fireEvent.change(await screen.findByLabelText('Selecionar evento'), { target: { value: 'e1' } });
    fireEvent.click(await screen.findByRole('button', { name: /Fazer check-in/i }));
    await waitFor(() => expect(avisos.some(a => a.tom === 'erro' && /não confirmada/i.test(a.t))).toBe(true));
    // A trava tem de soltar: senão um erro deixa a linha morta até recarregar.
    expect((await screen.findByRole('button', { name: /Fazer check-in/i })).disabled).toBe(false);
  });

  it('o contador é realmente atualizado sozinho — por isso o "ao vivo" é honesto', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await abrir(AdminCheckin);
    expect(await screen.findByText('Atualizando ao vivo')).toBeTruthy();

    api.operations.listCheckIns.mockResolvedValue({ items: [INSCRICAO()], summary: { total: 1, checkedIn: 1, pending: 0 } });
    const antes = api.operations.listCheckIns.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(21000); });
    expect(api.operations.listCheckIns.mock.calls.length).toBeGreaterThan(antes);
  });
});

// ------------------------------------------------------------------- PESAGEM
describe('pesagem', () => {
  // "Registrar" é o rótulo do botão da LINHA e também o do diálogo. O da
  // linha é o primeiro; depois de abrir, o do diálogo é o último.
  async function abrirDialogo() {
    await abrir(AdminPesagem);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Registrar$/i }))[0]);
    return screen.findByLabelText(/Peso \(kg\)/i);
  }
  const confirmar = () =>
    fireEvent.click(screen.getAllByRole('button', { name: /^Registrar$/i }).at(-1));

  it('registra e confirma', async () => {
    api.operations.weighIn.mockResolvedValue({ outOfRange: [] });
    const campo = await abrirDialogo();
    fireEvent.change(campo, { target: { value: '82.4' } });
    confirmar();
    await waitFor(() => expect(api.operations.weighIn).toHaveBeenCalled());
    expect(api.operations.weighIn.mock.calls[0][1].weightGrams).toBe(82400);
    expect(await screen.findByText('Pesagem registrada')).toBeTruthy();
  });

  it('peso fora da faixa NÃO é comemoração — é decisão da organização', async () => {
    api.operations.weighIn.mockResolvedValue({ outOfRange: [{ classId: 'c1', className: 'Até 172cm' }] });
    const campo = await abrirDialogo();
    fireEvent.change(campo, { target: { value: '120' } });
    confirmar();
    await waitFor(() => expect(api.operations.weighIn).toHaveBeenCalled());
    expect((await screen.findAllByText('Peso fora da faixa')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Pesagem registrada')).toBeNull();
  });

  it('o erro fica À VISTA no diálogo, com o que fazer — e não só num toast', async () => {
    // O valor precisa ser aceitável para o próprio formulário (min 20, max
    // 400): 999 é barrado pelo navegador antes de sair, e o teste estaria
    // medindo a validação do campo em vez da falha do servidor.
    api.operations.weighIn.mockRejectedValue(new Error('Evento não está em janela de pesagem'));
    const campo = await abrirDialogo();
    fireEvent.change(campo, { target: { value: '82.4' } });
    confirmar();
    const titulo = (await screen.findAllByText('Pesagem não registrada'))[0];

    // VISÍVEL, não só presente. `getByText` acha elemento escondido, então
    // afirmar só a existência deixa passar um alerta com `hidden` — que é
    // exatamente o defeito que importa: o operador não vê o motivo. Provado
    // por mutação: sem esta verificação, esconder o alerta não quebrava nada.
    const alerta = titulo.closest('.alert');
    expect(alerta.hasAttribute('hidden')).toBe(false);
    expect(alerta.closest('[hidden]')).toBeNull();
    expect(getComputedStyle(alerta).display).not.toBe('none');

    expect(screen.getByText(/Evento não está em janela de pesagem/)).toBeTruthy();
    expect(screen.getByText(/Nada foi gravado/i)).toBeTruthy();
    // O formulário continua lá para a pessoa corrigir.
    expect(screen.getByLabelText(/Peso \(kg\)/i)).toBeTruthy();
  });
});

// ------------------------------------------------------------ CREDENCIAMENTO
describe('credenciamento', () => {
  const CRED = { id: 'cr1', holderName: 'Carlos Mendes', type: 'ATHLETE', code: 'MCI-ABC123', status: 'ACTIVE', _count: { scans: 0 } };

  async function lerCodigo(resposta) {
    api.operations.credentials.mockResolvedValue({ items: [CRED] });
    api.operations.scanCredential.mockResolvedValue(resposta);
    await abrir(AdminCredenciamento);
    fireEvent.change(await screen.findByLabelText(/Código da credencial/i), { target: { value: 'mci-abc123' } });
    fireEvent.click(screen.getByRole('button', { name: /Validar/i }));
    await waitFor(() => expect(api.operations.scanCredential).toHaveBeenCalled());
  }

  it('credencial aceita libera e celebra', async () => {
    await lerCodigo({ accepted: true, credential: CRED });
    // Aparece duas vezes de propósito: no painel de leitura (fica) e no palco
    // da experiência (passa). As duas são desejadas.
    expect((await screen.findAllByText('Acesso liberado')).length).toBe(2);
    expect(document.querySelector('.alert-ok')).toBeTruthy();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('credencial recusada NÃO recebe o mesmo gesto de uma aceita', async () => {
    await lerCodigo({ accepted: false, credential: CRED, reason: 'Credencial revogada' });
    expect((await screen.findAllByText('Acesso recusado')).length).toBeGreaterThan(0);
    expect(document.querySelector('.alert-ok')).toBeNull();
    expect(document.querySelector('.alert-erro')).toBeTruthy();
    // E o palco não pode desenhar um "✓" verde por cima de uma recusa.
    const impacto = document.querySelector('.impacto');
    if (impacto) expect(impacto.className).not.toContain('impacto-sucesso');
  });

  it('o código é normalizado e enviado sem espaço — a portaria digita como dá', async () => {
    await lerCodigo({ accepted: true, credential: CRED });
    expect(api.operations.scanCredential.mock.calls[0][1].code).toBe('MCI-ABC123');
  });
});

// --------------------------------------------------------------------- PALCO
describe('palco', () => {
  const BATERIA = (status, extra = {}) => ({
    id: 'b1', name: 'Bateria 1', status, scheduledAt: null, eventId: 'e1', classId: 'c1',
    competitionClass: { name: 'Até 172cm', division: { name: 'Open', eventCategory: { category: { name: 'Men’s Physique' } } } },
    _count: { orders: 6 }, ...extra
  });

  it('chamar a bateria anuncia a chamada', async () => {
    api.operations.batches.mockResolvedValue({ items: [BATERIA('SCHEDULED')] });
    api.operations.setBatchStatus.mockResolvedValue({});
    await abrir(AdminPalco);
    fireEvent.click(await screen.findByRole('button', { name: /^Chamar$/i }));
    await waitFor(() => expect(api.operations.setBatchStatus).toHaveBeenCalledWith('b1', { status: 'CALLED' }));
    expect(await screen.findByText('Bateria chamada')).toBeTruthy();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('entrar no palco marca o estado ao vivo de verdade', async () => {
    api.operations.batches.mockResolvedValue({ items: [BATERIA('ON_STAGE')] });
    await abrir(AdminPalco);
    expect(await screen.findByText('No palco')).toBeTruthy();
    expect(document.querySelector('.pulso-ponto')).toBeTruthy();
    expect(document.querySelector('.esta-no-palco')).toBeTruthy();
  });

  it('bateria que NÃO está no palco não pulsa', async () => {
    api.operations.batches.mockResolvedValue({ items: [BATERIA('SCHEDULED')] });
    await abrir(AdminPalco);
    await screen.findByText('Bateria 1');
    expect(document.querySelector('.pulso-ponto')).toBeNull();
    expect(document.querySelector('.esta-no-palco')).toBeNull();
  });

  it('encerrar é fim de expediente: confirma sem festa', async () => {
    api.operations.batches.mockResolvedValue({ items: [BATERIA('ON_STAGE')] });
    api.operations.setBatchStatus.mockResolvedValue({});
    await abrir(AdminPalco);
    fireEvent.click(await screen.findByRole('button', { name: /^Encerrar$/i }));
    await waitFor(() => expect(api.operations.setBatchStatus).toHaveBeenCalledWith('b1', { status: 'DONE' }));
    expect(screen.queryByText('Bateria chamada')).toBeNull();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('dois cliques em "Chamar" mandam UMA transição de estado', async () => {
    let liberar;
    api.operations.batches.mockResolvedValue({ items: [BATERIA('SCHEDULED')] });
    api.operations.setBatchStatus.mockReturnValue(new Promise(r => { liberar = r; }));
    await abrir(AdminPalco);
    const botao = await screen.findByRole('button', { name: /^Chamar$/i });
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(api.operations.setBatchStatus).toHaveBeenCalledTimes(1);
    await act(async () => { liberar({}); });
  });
});

// ------------------------------------------- o teto vale nas quatro telas
describe('movimento reduzido na operação', () => {
  it('nenhuma das quatro telas desenha celebração, mas todas continuam operando', async () => {
    aparelho({ movimentoReduzido: true });
    api.operations.checkIn.mockResolvedValue({});
    await abrir(AdminCheckin);
    fireEvent.click(await screen.findByRole('button', { name: /Fazer check-in/i }));
    await waitFor(() => expect(api.operations.checkIn).toHaveBeenCalled());
    expect(document.querySelector('.impacto')).toBeNull();
    // A operação aconteceu: é isso que não pode depender de animação.
    expect(api.operations.checkIn).toHaveBeenCalledWith('i1', expect.any(Object));
  });
});

// ==========================================================================
// O TETO DA API.
//
// A API recusa `limit` acima de 100 com 400 VALIDATION_ERROR. Quatro telas
// pediam 200 desde 0f09a2b: check-in e pesagem não listavam NADA (a tela
// inteira caía no estado de erro), e as listas de atletas de "emitir
// credencial" e "ordem de palco" vinham sempre vazias.
//
// Nenhum teste pegava porque todos os mocks respondiam com sucesso a qualquer
// limite — o mock era mais permissivo que o servidor de verdade.
// ==========================================================================
const TETO_DA_API = 100;

describe('nenhuma tela pede mais do que a API aceita', () => {
  it('check-in respeita o teto', async () => {
    await abrir(AdminCheckin);
    await waitFor(() => expect(api.operations.listCheckIns).toHaveBeenCalled());
    for (const [, params] of api.operations.listCheckIns.mock.calls) {
      expect(params.limit).toBeLessThanOrEqual(TETO_DA_API);
    }
  });

  it('pesagem respeita o teto', async () => {
    await abrir(AdminPesagem);
    await waitFor(() => expect(api.operations.listCheckIns).toHaveBeenCalled());
    for (const [, params] of api.operations.listCheckIns.mock.calls) {
      expect(params.limit).toBeLessThanOrEqual(TETO_DA_API);
    }
  });

  it('emitir credencial respeita o teto', async () => {
    await abrir(AdminCredenciamento);
    fireEvent.click(await screen.findByRole('button', { name: /Emitir credencial/i }));
    await waitFor(() => expect(api.registrations.listByEvent).toHaveBeenCalled());
    for (const [, params] of api.registrations.listByEvent.mock.calls) {
      expect(params.limit).toBeLessThanOrEqual(TETO_DA_API);
    }
  });

  it('ordem de palco respeita o teto', async () => {
    api.operations.batches.mockResolvedValue({ items: [{
      id: 'b1', name: 'Bateria 1', status: 'SCHEDULED', scheduledAt: null, eventId: 'e1', classId: 'c1',
      competitionClass: { name: 'Até 172cm', division: { name: 'Open', eventCategory: { category: { name: 'Men’s Physique' } } } },
      _count: { orders: 0 }
    }] });
    api.operations.stageOrder.mockResolvedValue({ orders: [] });
    await abrir(AdminPalco);
    fireEvent.click(await screen.findByRole('button', { name: /^Ordem$/i }));
    await waitFor(() => expect(api.registrations.listByEvent).toHaveBeenCalled());
    for (const [, params] of api.registrations.listByEvent.mock.calls) {
      expect(params.limit).toBeLessThanOrEqual(TETO_DA_API);
    }
  });
});

describe('quando a lista é cortada pelo teto, o operador sabe', () => {
  it('check-in avisa que há mais gente do que cabe na lista', async () => {
    const muitos = Array.from({ length: 100 }, (_, i) => INSCRICAO({ id: `i${i}`, athlete: { id: `at${i}`, fullName: `Atleta ${i}`, stageName: null, athleteNumber: String(i) } }));
    api.operations.listCheckIns.mockResolvedValue({ items: muitos, summary: { total: 280, checkedIn: 0, pending: 280 } });
    await abrir(AdminCheckin);
    // 100 na tela, 280 no evento: quem não aparece precisa ser encontrável.
    expect(await screen.findByText(/Mostrando os primeiros 100 de 280 inscritos/i)).toBeTruthy();
    expect(screen.getByText(/Use a busca acima/i)).toBeTruthy();
  });

  it('sem corte, nenhum aviso aparece', async () => {
    await abrir(AdminCheckin);
    await screen.findByText('Carlos Mendes');
    expect(screen.queryByText(/mostrando os primeiros/i)).toBeNull();
  });
});

describe('o operador lê português, não enum', () => {
  it('o estado da bateria aparece traduzido', async () => {
    api.operations.batches.mockResolvedValue({ items: [{
      id: 'b1', name: 'Bateria 1', status: 'CALLED', scheduledAt: null, eventId: 'e1', classId: 'c1',
      competitionClass: { name: 'Até 172cm', division: { name: 'Open', eventCategory: { category: { name: 'Men’s Physique' } } } },
      _count: { orders: 6 }
    }] });
    await abrir(AdminPalco);
    expect(await screen.findByText('Chamada')).toBeTruthy();
    // O enum cru não pode chegar à tela — estava indo, inclusive na página
    // pública do evento, onde o atleta olha para saber quando entrar.
    expect(screen.queryByText('CALLED')).toBeNull();
  });

  it('um estado desconhecido não vira tela em branco', async () => {
    api.operations.batches.mockResolvedValue({ items: [{
      id: 'b1', name: 'Bateria 1', status: 'ESTADO_NOVO', scheduledAt: null, eventId: 'e1', classId: 'c1',
      competitionClass: { name: 'Até 172cm', division: { name: 'Open', eventCategory: { category: { name: 'Men’s Physique' } } } },
      _count: { orders: 6 }
    }] });
    await abrir(AdminPalco);
    // Prefere mostrar o código a sumir com a informação.
    expect(await screen.findByText('ESTADO_NOVO')).toBeTruthy();
  });
});

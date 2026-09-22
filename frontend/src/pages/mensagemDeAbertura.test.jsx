import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// A MENSAGEM DE ABERTURA — as duas pontas.
//
// DO LADO DO ATLETA, o que esta suíte tranca:
//
//   * QUEM DECIDE SE ABRE É O SERVIDOR. `deveExibir` vem pronto, já com a
//     janela de validade conferida e o `showOnce` cruzado contra a leitura
//     desta pessoa. A tela não recalcula — um segundo lugar decidindo quando
//     mostrar um recado oficial é um segundo lugar para ela divergir.
//
//   * FECHAR É LER. Não existe "fechar sem marcar": quem viu foi comunicado.
//
//   * UM DE CADA VEZ. Dois modais empilhados viram um borrão que a pessoa
//     fecha no reflexo, e o segundo recado morre junto com o primeiro.
//
//   * O CORPO É TEXTO. Marcação que viesse no recado sai como texto literal
//     na tela — visível, e inofensiva.
//
// DO LADO DE QUEM ESCREVE: a validade, a contagem de leituras e a recusa de
// apagar ficam visíveis, porque são exatamente as três coisas que se esquecem.
// ==========================================================================

const api = {
  me: { notices: vi.fn(), readNotice: vi.fn() },
  athleteNotices: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ADMIN', organizations: [{ organizationId: 'o1', role: 'ADMIN' }] } })
}));

const MensagemDaFederacao = (await import('../components/mensagemDaFederacao')).default;
const { AdminMensagens } = await import('./adminMensagens');

const aviso = (extra = {}) => ({
  id: 'n1',
  organizationId: 'o1',
  organization: { id: 'o1', name: 'MCI Brasil' },
  title: 'Inscrições abertas',
  body: 'A etapa de outubro está com inscrições abertas.',
  startsAt: null, endsAt: null, showOnce: true, active: true,
  createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z',
  createdBy: { id: 'u1', name: 'Administrador' },
  readAt: null, deveExibir: true,
  _count: { reads: 0 },
  ...extra
});

const notificacoes = [];
const notificar = (texto, tom) => notificacoes.push({ texto, tom });

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.me.notices.mockReset();
  api.me.readNotice.mockReset();
  api.me.readNotice.mockResolvedValue({ read: true });
  for (const fn of Object.values(api.athleteNotices)) fn.mockReset();
  notificacoes.length = 0;
});
afterEach(cleanup);

// -------------------------------------------------------- lado do atleta

describe('o recado por cima da tela', () => {
  const abrir = async items => {
    api.me.notices.mockResolvedValue({ items });
    render(<MensagemDaFederacao />);
  };

  it('abre o que o servidor mandou exibir, com o remetente antes do texto', async () => {
    await abrir([aviso()]);
    const dialogo = await screen.findByRole('dialog');

    expect(within(dialogo).getByText('Inscrições abertas')).toBeTruthy();
    expect(within(dialogo).getByText('MCI Brasil')).toBeTruthy();
    expect(within(dialogo).getByText(/inscrições abertas\.$/i)).toBeTruthy();
  });

  it('NÃO abre o que o servidor não mandou exibir, mesmo estando na lista', async () => {
    await abrir([aviso({ deveExibir: false, readAt: '2026-09-21T10:00:00.000Z' })]);
    await waitFor(() => expect(api.me.notices).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lista vazia não abre nada', async () => {
    await abrir([]);
    await waitFor(() => expect(api.me.notices).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fechar marca como lido — não existe fechar sem marcar', async () => {
    await abrir([aviso()]);
    const dialogo = await screen.findByRole('dialog');

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Entendi' }));

    await waitFor(() => expect(api.me.readNotice).toHaveBeenCalledWith('n1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('um de cada vez: o segundo recado só aparece depois que o primeiro fecha', async () => {
    await abrir([aviso(), aviso({ id: 'n2', title: 'Prazo de filiação' })]);

    const primeiro = await screen.findByRole('dialog');
    expect(within(primeiro).getByText('Inscrições abertas')).toBeTruthy();
    expect(screen.queryByText('Prazo de filiação')).toBeNull();

    fireEvent.click(within(primeiro).getByRole('button', { name: 'Entendi' }));

    const segundo = await screen.findByRole('dialog');
    expect(within(segundo).getByText('Prazo de filiação')).toBeTruthy();
  });

  it('recado que se repete oferece "Fechar", e não "Entendi"', async () => {
    await abrir([aviso({ showOnce: false })]);
    const dialogo = await screen.findByRole('dialog');

    // O modal já tem um X rotulado "Fechar"; o que muda é o botão de ação.
    expect(dialogo.querySelector('.button-primary').textContent).toBe('Fechar');
    expect(within(dialogo).queryByRole('button', { name: 'Entendi' })).toBeNull();
  });

  it('marcação que falha não prende o recado na tela', async () => {
    api.me.readNotice.mockRejectedValue(new Error('rede indisponível'));
    await abrir([aviso()]);
    const dialogo = await screen.findByRole('dialog');

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Entendi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('o corpo é TEXTO: marcação que viesse no recado não vira elemento', async () => {
    await abrir([aviso({ body: 'Atenção <img src=x onerror="alert(1)"> pessoal' })]);
    const dialogo = await screen.findByRole('dialog');

    expect(dialogo.querySelector('img')).toBeNull();
    expect(within(dialogo).getByText(/<img src=x onerror="alert\(1\)">/)).toBeTruthy();
  });

  it('linhas em branco viram parágrafos, e não um bloco só', async () => {
    await abrir([aviso({ body: 'Primeiro parágrafo.\n\nSegundo parágrafo.' })]);
    const dialogo = await screen.findByRole('dialog');

    expect(within(dialogo).getByText('Primeiro parágrafo.')).toBeTruthy();
    expect(within(dialogo).getByText('Segundo parágrafo.')).toBeTruthy();
  });
});

// ----------------------------------------------------- lado de quem escreve

describe('a tela de quem publica', () => {
  const abrirAdmin = async items => {
    api.athleteNotices.list.mockResolvedValue({ items });
    render(<AdminMensagens notificar={notificar} />);
    await screen.findByText('Inscrições abertas');
  };

  it('mostra a validade, a repetição e quantas pessoas já leram', async () => {
    await abrirAdmin([aviso({
      startsAt: '2026-10-01T03:00:00.000Z',
      endsAt: '2026-10-31T03:00:00.000Z',
      _count: { reads: 42 }
    })]);

    expect(screen.getByText(/42 leitura/)).toBeTruthy();
    expect(screen.getByText('No ar')).toBeTruthy();
    expect(screen.getByText('Uma vez por pessoa')).toBeTruthy();
  });

  it('sem janela, diz que não há prazo em vez de mostrar campo vazio', async () => {
    await abrirAdmin([aviso()]);
    expect(screen.getByText(/Sem prazo definido/)).toBeTruthy();
  });

  it('publicar manda título, texto, janela e repetição', async () => {
    await abrirAdmin([aviso()]);
    fireEvent.click(screen.getByRole('button', { name: /Nova mensagem/i }));

    const titulo = await screen.findByLabelText(/Título/i);
    fireEvent.change(titulo, { target: { value: 'Prazo de filiação' } });
    fireEvent.change(screen.getByLabelText(/^Texto/i), { target: { value: 'Renove até 30 de outubro.' } });

    api.athleteNotices.create.mockResolvedValue(aviso({ id: 'n9' }));
    fireEvent.submit(titulo.closest('form'));

    await waitFor(() => expect(api.athleteNotices.create).toHaveBeenCalled());
    const corpo = api.athleteNotices.create.mock.calls[0][0];
    expect(corpo).toMatchObject({
      organizationId: 'o1',
      title: 'Prazo de filiação',
      body: 'Renove até 30 de outubro.',
      startsAt: null,
      endsAt: null,
      showOnce: true
    });
  });

  it('desativar não apaga: chama a edição com active falso', async () => {
    await abrirAdmin([aviso()]);
    api.athleteNotices.update.mockResolvedValue(aviso({ active: false }));

    fireEvent.click(screen.getByRole('button', { name: /Desativar/i }));

    await waitFor(() => expect(api.athleteNotices.update).toHaveBeenCalledWith('n1', { active: false }));
    expect(api.athleteNotices.remove).not.toHaveBeenCalled();
  });

  it('a recusa de apagar aparece verbatim, com a contagem e o caminho da desativação', async () => {
    await abrirAdmin([aviso({ _count: { reads: 42 } })]);
    fireEvent.click(screen.getByRole('button', { name: /Excluir/i }));

    const recusa = 'Esta mensagem já foi lida por 42 pessoa(s) e não pode ser apagada: '
      + 'a marcação de leitura é o registro de que elas foram comunicadas. Desative a mensagem '
      + 'para tirá-la do ar sem apagar esse registro.';
    api.athleteNotices.remove.mockRejectedValue(new Error(recusa));

    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getAllByRole('button', { name: /^Excluir$/i }).at(-1));

    await within(dialogo).findByText(recusa);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

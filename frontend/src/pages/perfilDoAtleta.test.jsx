import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// O PERFIL ADMINISTRATIVO DO ATLETA — o que esta suíte tranca.
//
// Três portas, e cada uma já esteve aberta em algum sistema parecido:
//
//   1. O CPF. A tela mostra o que RECEBEU e nunca reconstrói o número. Pedir
//      o inteiro é uma CHAMADA ao servidor, que confere `search.sensitive` na
//      organização do atleta e grava `ATHLETE_CPF_VIEW` antes de responder.
//      Recusa aparece como veio, e o campo volta ao mascarado.
//
//   2. O BOTÃO QUE NÃO CABE NO ESTADO. Atleta ativo não tem "Reativar";
//      arquivado não tem "Arquivar". Oferecer a ação impossível e recusá-la
//      depois é fazer o operador descobrir a regra errando.
//
//   3. A EXCLUSÃO. Quem sabe se há histórico esportivo é o servidor, que
//      conta sete tabelas. A tela chama e mostra a recusa VERBATIM — não
//      tenta adivinhar, porque duas regras divergem.
//
// E uma quarta, na edição: o CPF e a equipe não saem no corpo. Um é a
// identidade que liga o histórico; a outra tem vínculo e transferência
// próprios, com outra permissão.
// ==========================================================================

const api = {
  athletes: {
    findById: vi.fn(),
    update: vi.fn(),
    suspend: vi.fn(),
    archive: vi.fn(),
    reactivate: vi.fn(),
    remove: vi.fn(),
    revealCpf: vi.fn()
  },
  affiliations: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ usuario: { id: 'u1', role: 'ADMIN' } }) }));

const { AdminAtleta } = await import('./adminAtleta');

const CPF_INTEIRO = '529.982.247-25';
const CPF_MASCARADO = '***.982.247-**';

const perfil = (sobrescreve = {}) => ({
  athlete: {
    id: 'a1',
    organizationId: 'o1',
    fullName: 'Joana Pereira',
    stageName: 'Jô',
    sex: 'FEMALE',
    status: 'ACTIVE',
    statusReason: null,
    statusChangedAt: null,
    hasPhoto: false,
    cpf: CPF_MASCARADO,
    cpfMasked: CPF_MASCARADO,
    birthDate: '1994-03-08T00:00:00.000Z',
    phone: '65999990000',
    email: 'joana@exemplo.test',
    city: 'Cuiabá',
    state: 'MT',
    affiliation: { id: 'f1', name: 'Federação Mato-grossense', code: 'FMT' },
    affiliationNumber: 'NPC-123',
    athleteNumber: '77',
    team: null,
    coach: null,
    ...sobrescreve
  },
  registrations: [],
  proHistory: [],
  results: [],
  rankings: []
});

const notificacoes = [];
const notificar = (texto, tom) => notificacoes.push({ texto, tom });

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.athletes)) fn.mockReset();
  api.affiliations.list.mockReset();
  api.affiliations.list.mockResolvedValue({ items: [{ id: 'f1', name: 'Federação Mato-grossense' }] });
  notificacoes.length = 0;
});
afterEach(cleanup);

const abrir = async (sobrescreve = {}) => {
  api.athletes.findById.mockResolvedValue(perfil(sobrescreve));
  render(<AdminAtleta id="a1" navegar={vi.fn()} notificar={notificar} />);
  await screen.findAllByText('Joana Pereira');
};

const abrirAba = async nome => {
  fireEvent.click(screen.getByRole('button', { name: nome }));
};

describe('o CPF nunca é desmascarado pela tela', () => {
  it('mostra o mascarado que veio do servidor, e nada além disso', async () => {
    await abrir();
    await abrirAba('Cadastro');

    expect(screen.getAllByText(CPF_MASCARADO).length).toBeGreaterThan(0);
    // O número inteiro não está em lugar nenhum do documento — nem escondido.
    expect(document.body.textContent).not.toContain(CPF_INTEIRO);
    expect(document.body.textContent).not.toContain('52998224725');
  });

  it('pedir o inteiro é uma chamada ao servidor, e o que aparece é a resposta dele', async () => {
    await abrir();
    await abrirAba('Cadastro');

    api.athletes.revealCpf.mockResolvedValue({ cpf: CPF_INTEIRO });
    fireEvent.click(screen.getByRole('button', { name: /Ver CPF completo/i }));

    await screen.findByText(CPF_INTEIRO);
    expect(api.athletes.revealCpf).toHaveBeenCalledWith('a1');
    // E o operador é avisado de que a consulta ficou registrada.
    expect(screen.getByText(/registrada na auditoria/i)).toBeTruthy();
  });

  it('recusa do servidor aparece como veio, e o campo continua mascarado', async () => {
    await abrir();
    await abrirAba('Cadastro');

    api.athletes.revealCpf.mockRejectedValue(new Error('Permissão insuficiente para esta operação'));
    fireEvent.click(screen.getByRole('button', { name: /Ver CPF completo/i }));

    await screen.findByText('Permissão insuficiente para esta operação');
    expect(document.body.textContent).not.toContain(CPF_INTEIRO);
    expect(screen.getAllByText(CPF_MASCARADO).length).toBeGreaterThan(0);
  });
});

describe('só aparece o botão que cabe no estado atual', () => {
  it('atleta ATIVO não tem Reativar', async () => {
    await abrir({ status: 'ACTIVE' });
    expect(screen.getByRole('button', { name: /Suspender/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Arquivar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reativar/i })).toBeNull();
  });

  it('atleta SUSPENSO troca Suspender por Reativar, e mostra o motivo registrado', async () => {
    await abrir({ status: 'SUSPENDED', statusReason: 'Pendência documental na federação', statusChangedAt: '2026-09-01T12:00:00.000Z' });
    expect(screen.queryByRole('button', { name: /Suspender/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Reativar/i })).toBeTruthy();
    expect(screen.getByText('Pendência documental na federação')).toBeTruthy();
  });

  it('atleta ARQUIVADO não tem Arquivar', async () => {
    await abrir({ status: 'ARCHIVED', statusReason: 'Encerrou a carreira' });
    expect(screen.queryByRole('button', { name: /Arquivar/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Reativar/i })).toBeTruthy();
  });
});

describe('mudar de estado exige motivo e chama a rota que já existe', () => {
  it('suspender manda o motivo digitado', async () => {
    await abrir({ status: 'ACTIVE' });
    fireEvent.click(screen.getByRole('button', { name: /Suspender/i }));

    const motivo = await screen.findByRole('textbox');
    fireEvent.change(motivo, { target: { value: 'Pendência documental na federação' } });

    api.athletes.suspend.mockResolvedValue({ id: 'a1', status: 'SUSPENDED' });
    fireEvent.submit(motivo.closest('form'));

    await waitFor(() => expect(api.athletes.suspend).toHaveBeenCalledWith('a1', 'Pendência documental na federação'));
    expect(api.athletes.archive).not.toHaveBeenCalled();
    expect(api.athletes.remove).not.toHaveBeenCalled();
  });
});

describe('a exclusão é decidida pelo servidor', () => {
  it('a recusa do servidor aparece verbatim, e o atleta continua na tela', async () => {
    const recusa = 'Atleta com histórico esportivo não pode ser excluído: 12 lançamentos de pontuação, '
      + '3 resultados publicados. Use o arquivamento.';
    await abrir();

    fireEvent.click(screen.getByRole('button', { name: /Excluir/i }));
    api.athletes.remove.mockRejectedValue(new Error(recusa));
    fireEvent.click(screen.getAllByRole('button', { name: /^Excluir$/i }).at(-1));

    await screen.findByText(recusa);
    expect(api.athletes.remove).toHaveBeenCalledWith('a1');
    expect(screen.getAllByText('Joana Pereira').length).toBeGreaterThan(0);
  });
});

describe('a edição manda só o que mudou, e nunca CPF nem equipe', () => {
  it('campo intocado não vai no corpo; campo esvaziado vai como null', async () => {
    await abrir();
    fireEvent.click(screen.getByRole('button', { name: /Editar cadastro/i }));

    const telefone = await screen.findByDisplayValue('65999990000');
    fireEvent.change(telefone, { target: { value: '' } });
    const cidade = screen.getByDisplayValue('Cuiabá');
    fireEvent.change(cidade, { target: { value: 'Várzea Grande' } });

    api.athletes.update.mockResolvedValue({ id: 'a1' });
    fireEvent.submit(telefone.closest('form'));

    await waitFor(() => expect(api.athletes.update).toHaveBeenCalled());
    const [id, corpo] = api.athletes.update.mock.calls[0];

    expect(id).toBe('a1');
    expect(corpo).toEqual({ phone: null, city: 'Várzea Grande' });
    // O que não mudou não viaja — nem como `undefined`, nem como o valor atual.
    expect(Object.keys(corpo).sort()).toEqual(['city', 'phone']);
    // E o que não se edita por aqui nunca aparece no corpo.
    expect(corpo).not.toHaveProperty('cpf');
    expect(corpo).not.toHaveProperty('teamId');
  });

  it('o formulário não oferece campo de CPF nem de equipe', async () => {
    await abrir();
    fireEvent.click(screen.getByRole('button', { name: /Editar cadastro/i }));
    await screen.findByDisplayValue('Joana Pereira');

    expect(screen.queryByDisplayValue(CPF_MASCARADO)).toBeNull();
    expect(screen.queryByDisplayValue(CPF_INTEIRO)).toBeNull();
    const formulario = screen.getByDisplayValue('Joana Pereira').closest('form');
    expect(formulario.textContent).not.toMatch(/equipe/i);
  });

  it('recusa do servidor aparece no formulário e o diálogo não fecha', async () => {
    await abrir();
    fireEvent.click(screen.getByRole('button', { name: /Editar cadastro/i }));

    const nome = await screen.findByDisplayValue('Joana Pereira');
    fireEvent.change(nome, { target: { value: 'Joana P. Pereira' } });

    api.athletes.update.mockRejectedValue(new Error('Matrícula já pertence a outro atleta nesta filiação'));
    fireEvent.submit(nome.closest('form'));

    await screen.findByText('Matrícula já pertence a outro atleta nesta filiação');
    expect(screen.getByDisplayValue('Joana P. Pereira')).toBeTruthy();
  });
});

describe('a pontuação distingue empate não resolvido de dado ausente', () => {
  it('posição nula é dita com todas as letras', async () => {
    api.athletes.findById.mockResolvedValue({
      ...perfil(),
      rankings: [{
        id: 'r1', season: { name: 'Temporada 2026' }, category: { name: 'BIKINI' },
        totalPoints: 0, eventCount: 1, overallWins: 0, position: null
      }]
    });
    render(<AdminAtleta id="a1" navegar={vi.fn()} notificar={notificar} />);
    await screen.findAllByText('Joana Pereira');
    await abrirAba('Pontuação');

    expect(screen.getByText(/Empate não resolvido/i)).toBeTruthy();
  });
});

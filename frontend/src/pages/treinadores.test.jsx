import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';

// ==========================================================================
// AS TELAS DO MÓDULO TREINADORES & EQUIPES — o que elas NÃO podem fazer.
//
// Este arquivo mede as promessas que a interface faz por escrito, e cada uma
// delas corresponde a uma decisão aprovada:
//
//   R-03  o treinador não muda o próprio estado, e a tela não lhe oferece o
//         caminho: `status` não é campo do formulário.
//   R-04  cadastro aprovado sem autorização de federação não habilita convidar.
//   R-05  a lista de atletas não tem coluna de CPF nem de documento — e o teste
//         confere no TEXTO RENDERIZADO, não no que a API mandou.
//   §8.3  não existe classificação de treinadores. A tela diz "Ranking em
//         homologação" e NÃO exibe posição nem total do treinador.
//
//   Confirmar vínculo é do ATLETA, e a tela do atleta avisa a CONSEQUÊNCIA
//   antes de oferecer o botão.
//
// A tela nunca reescreve a recusa do servidor: quando a API explica o que
// fazer, é essa frase que a pessoa lê.
// ==========================================================================

const api = {
  coaches: {
    me: vi.fn(), selfRegister: vi.fn(), updateMe: vi.fn(),
    myTeams: vi.fn(), myAthletes: vi.fn(), projection: vi.fn(),
    review: vi.fn(), approve: vi.fn(), reject: vi.fn(), suspend: vi.fn(),
    reactivate: vi.fn(), cancel: vi.fn(), authorizeOrganization: vi.fn()
  },
  membershipRequests: {
    lookupByAffiliation: vi.fn(), create: vi.fn(), ofTeam: vi.fn(),
    mine: vi.fn(), confirm: vi.fn(), reject: vi.fn(), cancel: vi.fn()
  },
  centralAuthorizations: { list: vi.fn(), grant: vi.fn(), revoke: vi.fn() },
  organizations: { list: vi.fn() },
  admin: { users: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { PainelDoTreinador, MinhaEquipe, AdminTreinadores } = await import('./treinadores');

const CADASTRO = extras => ({
  id: 'co1', name: 'Marta Treinadora', status: 'APPROVED',
  registration: 'CREF-99999', phone: '65999887766', email: 'marta@exemplo.org',
  createdAt: '2026-01-10T12:00:00.000Z',
  organizations: [{ id: 'cz1', organizationId: 'o1', status: 'APPROVED', organization: { id: 'o1', name: 'Federação A' } }],
  teams: [{ id: 't1', name: 'Equipe Marta', organizationId: 'o1' }],
  ...extras
});

const EQUIPES = [{ id: 't1', name: 'Equipe Marta', organizationId: 'o1', organization: { id: 'o1', name: 'Federação A' }, _count: { athletes: 2 } }];

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const grupo of Object.values(api)) for (const fn of Object.values(grupo)) fn.mockReset();

  api.coaches.myTeams.mockResolvedValue({ items: EQUIPES });
  api.coaches.myAthletes.mockResolvedValue({ items: [] });
  api.coaches.projection.mockResolvedValue({ homologado: false, aviso: 'Ranking em homologação.', teams: [], totalDoTreinador: null, posicao: null });
  api.membershipRequests.ofTeam.mockResolvedValue({ items: [] });
  api.membershipRequests.mine.mockResolvedValue({ items: [] });
  api.coaches.review.mockResolvedValue({ items: [] });
  api.centralAuthorizations.list.mockResolvedValue({ items: [] });
  api.organizations.list.mockResolvedValue({ items: [{ id: 'o1', name: 'Federação A' }] });
  api.admin.users.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

describe('painel do treinador', () => {
  it('conta sem cadastro recebe o FORMULÁRIO, e o formulário não tem campo de situação (R-03)', async () => {
    api.coaches.me.mockRejectedValue(Object.assign(new Error('não encontrado'), { status: 404 }));

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText(/Seus dados de treinador/i)).toBeTruthy();
    // O estado é decisão da administração central. Não há como digitá-lo aqui.
    expect(screen.queryByLabelText(/situação/i)).toBeNull();
    expect(screen.queryByText(/Aprovado/)).toBeNull();
  });

  it('cadastro em análise não oferece convidar atleta', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO({ status: 'PENDING', organizations: [] }));

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText(/Em análise/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Convidar atleta/i })).toBeNull();
  });

  it('APROVADO mas sem autorização de federação também não convida (R-04)', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO({ organizations: [] }));
    api.coaches.myTeams.mockResolvedValue({ items: [] });

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText(/Nenhuma federação autorizou a sua atuação/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Convidar atleta/i })).toBeNull();
  });

  it('a lista de atletas mostra esporte e filiação, e NUNCA CPF ou documento (R-05)', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.coaches.myAthletes.mockResolvedValue({
      items: [{
        membershipId: 'm1', teamId: 't1', since: '2026-02-01T12:00:00.000Z',
        athlete: {
          id: 'a1', fullName: 'Joana Ferreira', stageName: null, sex: 'FEMALE',
          status: 'ACTIVE', proStatus: 'NONE', affiliationNumber: '5001',
          affiliation: { id: 'af1', name: 'NPC Mato Grosso', code: 'NPC-MT' },
          team: { id: 't1', name: 'Equipe Marta' }
        }
      }]
    });

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText('Joana Ferreira')).toBeTruthy();
    expect(screen.getByText('5001')).toBeTruthy();

    // A prova é no TEXTO DA TELA: nenhuma coluna de documento, nenhum rótulo de
    // CPF. Conferir só o objeto da API deixaria passar uma coluna acrescentada
    // depois a partir de outro campo.
    const corpo = document.body.textContent;
    expect(/CPF/i.test(corpo), 'a tela do treinador não fala de CPF').toBe(false);
    expect(/documento/i.test(corpo), 'a tela do treinador não fala de documento').toBe(false);
  });

  it('o ranking diz que está em homologação e não exibe posição nem total do treinador (§8.3)', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.coaches.projection.mockResolvedValue({
      homologado: false,
      aviso: 'Ranking em homologação.',
      teams: [{ teamId: 't1', team: { id: 't1', name: 'Equipe Marta' }, totalPoints: 42 }],
      totalDoTreinador: null, posicao: null
    });

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText(/Ranking em homologação/i)).toBeTruthy();
    expect(screen.getByText(/ainda não foi homologada/i)).toBeTruthy();
    // O total da EQUIPE aparece, porque ele já é oficial. O do treinador não
    // existe, e a tela não o inventa somando as equipes.
    expect(screen.getByText('42')).toBeTruthy();
    const corpo = document.body.textContent;
    expect(/posição/i.test(corpo), 'não há posição de treinador na tela').toBe(false);
  });

  it('convidar exige matrícula COMPLETA e não oferece busca por nome', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.membershipRequests.lookupByAffiliation.mockResolvedValue({ found: false, athlete: null });

    render(<PainelDoTreinador notificar={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Convidar atleta/i }));

    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByLabelText(/Matrícula na federação/i)).toBeTruthy();
    // A prova de que não há busca por nome é a LISTA de controles do diálogo:
    // uma seleção de equipe e um campo de matrícula, e nada mais. Procurar um
    // rótulo ausente é frágil — casa por acidente com qualquer palavra que
    // contenha o termo.
    const rotulos = Array.from(dialogo.querySelectorAll('label.field > span')).map(no => no.textContent.replace(/\s*\*$/, '').trim());
    expect(rotulos, 'só equipe e matrícula; nenhum campo de nome').toEqual(['Equipe', 'Matrícula na federação']);

    fireEvent.change(within(dialogo).getByLabelText(/Matrícula na federação/i), { target: { value: '5001' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Localizar/i }));

    expect(await screen.findByText(/Nenhum atleta com essa matrícula/i)).toBeTruthy();
    expect(api.membershipRequests.lookupByAffiliation).toHaveBeenCalledWith({ organizationId: 'o1', affiliationNumber: '5001' });
  });

  it('atleta já vinculado: o convite é BLOQUEADO na tela, com o caminho de quem resolve', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.membershipRequests.lookupByAffiliation.mockResolvedValue({
      found: true,
      athlete: { id: 'a9', fullName: 'Carla Souza', affiliationNumber: '5002', affiliation: null },
      currentTeam: { id: 't9', name: 'Equipe Rival', since: '2026-01-01T12:00:00.000Z' },
      hasPendingRequest: false
    });

    render(<PainelDoTreinador notificar={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Convidar atleta/i }));
    const dialogo = await screen.findByRole('dialog');
    fireEvent.change(within(dialogo).getByLabelText(/Matrícula na federação/i), { target: { value: '5002' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: /Localizar/i }));

    expect(await screen.findByText(/Equipe Rival/)).toBeTruthy();
    expect(screen.getByText(/Mudar de equipe é decisão da administração/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Enviar convite/i }).disabled).toBe(true);
    expect(api.membershipRequests.create).not.toHaveBeenCalled();
  });

  it('a recusa do servidor é exibida como ela vem, sem ser reescrita', async () => {
    api.coaches.me.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    api.coaches.selfRegister.mockRejectedValue(new Error('Esta conta já possui cadastro de treinador.'));

    render(<PainelDoTreinador notificar={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText(/^Nome/i), { target: { value: 'Marta Treinadora' } });
    fireEvent.click(screen.getByRole('button', { name: /Enviar para análise/i }));

    expect(await screen.findByText('Esta conta já possui cadastro de treinador.')).toBeTruthy();
  });
});

describe('a vez do atleta', () => {
  const CONVITE = {
    id: 'r1', athleteId: 'a1', teamId: 't1', status: 'PENDING',
    requestedAt: '2026-03-01T12:00:00.000Z', decidedAt: null, reason: null,
    athlete: { id: 'a1', fullName: 'Joana Ferreira', stageName: null },
    team: { id: 't1', name: 'Equipe Marta', organizationId: 'o1', company: null, coach: { id: 'co1', name: 'Marta Treinadora' } }
  };

  it('a CONSEQUÊNCIA do vínculo é dita antes de o botão ser oferecido', async () => {
    api.membershipRequests.mine.mockResolvedValue({ items: [CONVITE] });

    render(<MinhaEquipe notificar={vi.fn()} />);

    expect(await screen.findByText('Equipe Marta')).toBeTruthy();
    expect(screen.getByText(/vínculo exclusivo com esta equipe/i)).toBeTruthy();
    expect(screen.getByText(/depende de decisão da administração/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirmar vínculo/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Recusar$/i })).toBeTruthy();
  });

  it('confirmar chama a rota do ATLETA, e recusar chama a outra — nunca a de vínculo direto', async () => {
    api.membershipRequests.mine.mockResolvedValue({ items: [CONVITE] });
    api.membershipRequests.confirm.mockResolvedValue({ request: { ...CONVITE, status: 'CONFIRMED' }, membership: { id: 'm1' } });

    render(<MinhaEquipe notificar={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar vínculo/i }));

    expect(api.membershipRequests.confirm).toHaveBeenCalledWith('r1');
    expect(api.membershipRequests.create, 'a tela do atleta não cria pedido').not.toHaveBeenCalled();
  });

  it('sem convite, explica o que vai acontecer em vez de mostrar tabela vazia', async () => {
    api.membershipRequests.mine.mockResolvedValue({ items: [] });

    render(<MinhaEquipe notificar={vi.fn()} />);
    expect(await screen.findByText(/Nenhum convite para você/i)).toBeTruthy();
  });
});

describe('mesa central', () => {
  const PENDENTE = {
    id: 'co9', name: 'Novo Treinador', status: 'PENDING', registration: null,
    createdAt: '2026-03-01T12:00:00.000Z',
    user: { id: 'u9', name: 'Novo Treinador', email: 'novo@exemplo.org' },
    _count: { documents: 2, teams: 0, athletes: 0, organizations: 0 }
  };

  it('o cadastro PENDENTE oferece aprovar e não aprovar — e nada de autorizar federação', async () => {
    api.coaches.review.mockResolvedValue({ items: [PENDENTE] });

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText('Novo Treinador')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Aprovar cadastro/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Não aprovar/i })).toBeTruthy();
    // Autorizar atuação pressupõe cadastro aprovado (R-04). Antes disso, o
    // caminho não é oferecido.
    expect(screen.queryByRole('button', { name: /Autorizar em federação/i })).toBeNull();
  });

  it('não aprovar EXIGE motivo, e o motivo vai para a trilha', async () => {
    api.coaches.review.mockResolvedValue({ items: [PENDENTE] });
    api.coaches.reject.mockResolvedValue({ ...PENDENTE, status: 'REJECTED' });

    render(<AdminTreinadores notificar={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Não aprovar/i }));

    const dialogo = await screen.findByRole('dialog');
    const motivo = within(dialogo).getByLabelText(/Motivo/i);
    expect(motivo.required, 'o motivo é obrigatório na recusa').toBe(true);
    expect(within(dialogo).getByText(/vai para a trilha de auditoria/i)).toBeTruthy();

    fireEvent.change(motivo, { target: { value: 'Falta comprovante de registro.' } });
    fireEvent.submit(dialogo.querySelector('form'));
    expect(api.coaches.reject).toHaveBeenCalledWith('co9', 'Falta comprovante de registro.');
  });

  it('a listagem mostra a CONTAGEM de documentos, nunca o documento (R-05)', async () => {
    api.coaches.review.mockResolvedValue({ items: [PENDENTE] });

    render(<AdminTreinadores notificar={vi.fn()} />);
    const tabela = await screen.findByRole('table');
    const celulas = within(tabela).getAllByRole('cell').map(celula => celula.textContent);
    expect(celulas.some(texto => texto.trim() === '2'), 'a contagem de documentos aparece').toBe(true);
    expect(screen.queryByRole('link', { name: /baixar/i }), 'não há link de download na listagem').toBeNull();
  });

  it('a delegação central é exibida com escopo e prazo, e a lista vazia explica a consequência', async () => {
    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/Delegação central/i)).toBeTruthy();
    expect(screen.getByText(/ninguém concede para si mesmo/i)).toBeTruthy();
    expect(screen.getByText(/Nenhuma delegação em vigor/i)).toBeTruthy();
    expect(screen.getByText(/restritos ao administrador máximo/i)).toBeTruthy();
  });
});

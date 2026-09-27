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
    reactivate: vi.fn(), cancel: vi.fn(), authorizeOrganization: vi.fn(),
    revokeOrganization: vi.fn(), authorizable: vi.fn()
  },
  membershipRequests: {
    lookupByAffiliation: vi.fn(), create: vi.fn(), ofTeam: vi.fn(),
    mine: vi.fn(), confirm: vi.fn(), reject: vi.fn(), cancel: vi.fn()
  },
  centralAuthorizations: { list: vi.fn(), grant: vi.fn(), revoke: vi.fn() },
  // O cartão de ranking precisa da TEMPORADA antes de pedir a projeção: a rota
  // recusa com 422 quando ela falta (ver o teste de regressão no fim do arquivo).
  ranking: { seasons: vi.fn() },
  organizations: { list: vi.fn() },
  admin: { users: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

// QUEM É A CONTA — a tela pergunta antes de decidir o que mostrar.
//
// Isto é conveniência, e não barreira: o servidor continua recusando o que a
// conta não pode. O que a tela evita é oferecer ação que seria recusada — foi
// exatamente o que a homologação manual encontrou no passo F4, com o diretor de
// federação recebendo duas caixas de "não foi possível carregar".
let usuario = { role: 'SUPER_ADMIN', organizations: [] };
const DIRETOR_DE_FEDERACAO = { role: 'ATHLETE', organizations: [{ organizationId: 'o1', role: 'EVENT_DIRECTOR' }] };
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: usuario }) }));

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
  usuario = { role: 'SUPER_ADMIN', organizations: [] };

  api.coaches.myTeams.mockResolvedValue({ items: EQUIPES });
  api.coaches.myAthletes.mockResolvedValue({ items: [] });
  api.coaches.projection.mockResolvedValue({ homologado: false, aviso: 'Ranking em homologação.', teams: [], totalDoTreinador: null, posicao: null });
  api.membershipRequests.ofTeam.mockResolvedValue({ items: [] });
  api.membershipRequests.mine.mockResolvedValue({ items: [] });
  api.coaches.review.mockResolvedValue({ items: [] });
  api.centralAuthorizations.list.mockResolvedValue({ items: [] });
  api.organizations.list.mockResolvedValue({ items: [{ id: 'o1', name: 'Federação A' }] });
  api.admin.users.mockResolvedValue({ items: [] });
  api.ranking.seasons.mockResolvedValue([{ id: 's2026', name: 'Temporada 2026', year: 2026 }]);
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
    //
    // `findByText` e não `getByText`: o cartão resolve a TEMPORADA antes de
    // pedir a projeção (a rota recusa sem ela), então o número chega um salto
    // depois do aviso de homologação, que é texto fixo.
    expect(await screen.findByText('42')).toBeTruthy();
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

// ==========================================================================
// REGRESSÃO DO QA VISUAL EM CHROMIUM.
//
// Os quatro defeitos abaixo não apareceram em teste de unidade nenhum: só
// existem quando há layout, largura de viewport e navegador de verdade. Foram
// MEDIDOS no gate `scripts/qa/visual-treinadores.mjs` e estão presos aqui na
// forma que o jsdom alcança — a estrutura do DOM e a chamada de API — para que
// a correção não se perca numa edição futura. O gate visual continua sendo a
// medida da largura; estes testes são a trava da estrutura.
// ==========================================================================
describe('regressão do QA visual', () => {
  it('toda tabela mora dentro de .table-wrap — é ela que rola de lado', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.coaches.myAthletes.mockResolvedValue({
      items: [{
        membershipId: 'm1', teamId: 't1', since: '2026-02-01T12:00:00.000Z',
        athlete: {
          id: 'a1', fullName: 'Carla Souza', stageName: null, sex: 'FEMALE',
          status: 'ACTIVE', proStatus: 'NONE', affiliationNumber: '5001',
          affiliation: { id: 'af1', name: 'NPC Mato Grosso', code: 'NPC-MT' },
          team: { id: 't1', name: 'Equipe Marta' }
        }
      }]
    });

    const { container } = render(<PainelDoTreinador notificar={vi.fn()} />);
    await screen.findByText(/Carla Souza/i);

    const tabelas = [...container.querySelectorAll('table')];
    expect(tabelas.length, 'há tabela para conferir').toBeGreaterThan(0);
    for (const tabela of tabelas) {
      // `.table` sozinha não rola: quem rola é o embrulho (`styles.css`,
      // `.table-wrap { overflow-x: auto }`). Sem ele, medido em Chromium, a
      // tabela empurrava o documento inteiro para fora da viewport em 360px.
      expect(tabela.closest('.table-wrap'), 'a tabela está dentro de .table-wrap').toBeTruthy();
    }
  });

  it('.modal-actions só existe dentro de diálogo — fora dele a faixa vaza do cartão', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());

    const { container } = render(<PainelDoTreinador notificar={vi.fn()} />);
    await screen.findByText(/Situação cadastral/i);

    // A regra de `.modal-actions` cancela o padding do diálogo com margem
    // horizontal NEGATIVA. Dentro de um `.card` essa mesma margem faz a faixa
    // de botões ultrapassar o cartão — medido nas oito larguras da matriz.
    for (const faixa of container.querySelectorAll('.modal-actions')) {
      expect(faixa.closest('[role="dialog"]'), '.modal-actions fora de diálogo').toBeTruthy();
    }
  });

  it('todo select tem a classe que garante o alvo de toque de 40px', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.coaches.myTeams.mockResolvedValue({ items: [...EQUIPES, { id: 't2', name: 'Equipe Beta', organizationId: 'o1', organization: { id: 'o1', name: 'Federação A' }, _count: { athletes: 0 } }] });

    const { container } = render(<PainelDoTreinador notificar={vi.fn()} />);
    await screen.findByText(/Situação cadastral/i);

    for (const seletor of container.querySelectorAll('select')) {
      // `select` cru mediu 23px de altura em Chromium, contra o piso de 40.
      // `.select-control` (ou o `.field` que embrulha o campo de formulário) é
      // quem carrega o `min-height`.
      const temClasse = seletor.classList.contains('select-control') || seletor.closest('.field');
      expect(temClasse, `select sem classe de alvo de toque: ${seletor.outerHTML.slice(0, 80)}`).toBeTruthy();
    }
  });

  it('a projeção do ranking só é pedida COM temporada, e nunca sem ela', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());

    render(<PainelDoTreinador notificar={vi.fn()} />);
    // A temporada chega primeiro; a projeção, depois dela.
    await vi.waitFor(() => expect(api.coaches.projection).toHaveBeenCalled());

    for (const [, consulta] of api.coaches.projection.mock.calls) {
      // Sem `seasonId` a rota responde 422 SEASON_REQUIRED — e está certa: somar
      // temporadas diferentes não significa nada. Quem errava era a tela.
      expect(consulta?.seasonId, 'a projeção foi pedida sem temporada').toBe('s2026');
    }
  });

  it('os convites aparecem mesmo quando as equipes chegam DEPOIS do cadastro', async () => {
    // O DEFEITO QUE ESTE TESTE PRENDE, medido em Chromium real: a equipe
    // escolhida vinha de `useState(equipes[0]?.id)`, que lê a lista uma única
    // vez. Quando `GET /coaches/me/teams` respondia depois de `GET /coaches/me`
    // — ordem que o navegador decide, não o código —, o estado nascia vazio e
    // nunca se corrigia: o painel dizia "Nenhum convite enviado" sem NUNCA
    // chamar `GET /membership-requests`. Aqui a demora é forçada, para que a
    // ordem ruim seja a ordem certa do teste.
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.coaches.myTeams.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ items: EQUIPES }), 60))
    );
    api.membershipRequests.ofTeam.mockResolvedValue({
      items: [{
        id: 'pr1', status: 'PENDING', requestedAt: '2026-03-01T12:00:00.000Z',
        athlete: { id: 'a9', fullName: 'Joana Ferreira', stageName: null }
      }]
    });

    render(<PainelDoTreinador notificar={vi.fn()} />);

    expect(await screen.findByText(/Joana Ferreira/i)).toBeTruthy();
    expect(api.membershipRequests.ofTeam).toHaveBeenCalledWith({ teamId: 't1' });
  });

  it('sem temporada cadastrada a projeção NÃO é chamada, e o aviso de homologação continua', async () => {
    api.coaches.me.mockResolvedValue(CADASTRO());
    api.ranking.seasons.mockResolvedValue([]);

    render(<PainelDoTreinador notificar={vi.fn()} />);

    // O aviso do §8.3 não depende de número nenhum: é ele que fica no lugar da
    // classificação que não existe.
    expect(await screen.findByText(/Ranking em homologação/i)).toBeTruthy();
    // Esperar a lista de temporadas CHEGAR antes de afirmar a ausência: sem
    // isso o teste passaria por ser rápido, e não por estar certo.
    await vi.waitFor(() => expect(api.ranking.seasons).toHaveBeenCalled());
    expect(api.coaches.projection).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// ACHADO A-11 — A TELA DE DECISÃO NÃO PODE DIZER "NADA AQUI" QUANDO FOI RECUSA.
//
// As duas listas da mesa central engoliam a falha com `.catch(() => ({ items: []
// }))`. Numa tela de análise de cadastro, isso é o pior resultado possível: 403,
// 500 e fila genuinamente vazia produziam a MESMA tela, e quem analisa concluía
// que não havia pendência quando o que houve foi recusa de permissão.
//
// Os testes abaixo medem a distinção, e medem também que ela é EXCLUSIVA: o
// estado de recusa não vem acompanhado do texto de vazio.
// ==========================================================================
describe('A-11: estados da tela administrativa são um por vez', () => {
  const recusa403 = () => Object.assign(new Error('Você não tem permissão para esta operação'), { status: 403 });

  it('403 na fila de análise mostra RECUSA, e não fila vazia', async () => {
    api.coaches.review.mockRejectedValue(recusa403());

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/não tem permissão para analisar cadastros/i)).toBeTruthy();
    expect(screen.queryByText(/Nenhum cadastro nesta situação|fila está vazia/i),
      'recusa e vazio não aparecem juntos').toBeNull();
    // E há caminho de saída: o estado de erro oferece tentar de novo.
    expect(screen.getAllByRole('button', { name: /tentar de novo/i }).length).toBeGreaterThan(0);
  });

  it('403 na delegação central mostra RECUSA, e não "nenhuma delegação em vigor"', async () => {
    api.centralAuthorizations.list.mockRejectedValue(recusa403());

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/não tem permissão para ver ou conceder delegação/i)).toBeTruthy();
    expect(screen.queryByText(/Nenhuma delegação em vigor/i)).toBeNull();
  });

  it('falha que NÃO é recusa mostra a mensagem do servidor, não a de permissão', async () => {
    api.coaches.review.mockRejectedValue(Object.assign(new Error('A API demorou demais para responder.'), { status: 504 }));

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/A API demorou demais para responder/i)).toBeTruthy();
    expect(screen.queryByText(/não tem permissão para analisar/i)).toBeNull();
  });

  it('fila realmente vazia continua explicando o vazio — uma vez só', async () => {
    api.coaches.review.mockResolvedValue({ items: [] });

    render(<AdminTreinadores notificar={vi.fn()} />);

    const vazios = await screen.findAllByText(/Nenhum cadastro|Nenhuma delegação/i);
    // Um texto de vazio por seção: a fila e a delegação. Antes da correção, a
    // fila trazia DOIS (o genérico do AsyncSection e o próprio).
    expect(vazios.length).toBe(2);
    expect(screen.queryByText(/não tem permissão/i)).toBeNull();
  });
});

// ==========================================================================
// F-04 — A FEDERAÇÃO PRECISA VER O QUE PODE FAZER.
//
// O achado veio da homologação manual: o diretor de federação, que tem
// `coaches.authorize_org` e não tem `coaches.approve`, abria a tela e via duas
// caixas de "não foi possível carregar" e um botão de conceder delegação que a
// API nunca aceitaria. A ação que era dele — autorizar atuação — não existia em
// lugar nenhum da interface.
// ==========================================================================
describe('F-04: atuação na federação', () => {
  const APROVADO = {
    id: 'co5', name: 'Marta Treinadora', registration: 'CREF-99999',
    city: 'Cuiabá', state: 'MT', authorization: null
  };
  const FEDERACOES = { items: [{ id: 'o1', name: 'Federação A' }] };

  it('o diretor vê a lista da federação, e NÃO vê a fila central nem a delegação', async () => {
    usuario = DIRETOR_DE_FEDERACAO;
    api.organizations.list.mockResolvedValue(FEDERACOES);
    api.coaches.authorizable.mockResolvedValue({ items: [APROVADO] });

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/Atuação na sua federação/i)).toBeTruthy();
    // A lista só é pedida DEPOIS que as federações chegam — o escopo é
    // obrigatório na rota, e pedir sem ele seria pedir para ser recusado.
    expect(await screen.findByText('Marta Treinadora')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Autorizar atuação/i })).toBeTruthy();

    // O que não é dele não aparece — e não aparece como recusa, aparece como
    // ausência. Oferecer ação que a API recusa não é segurança nem cortesia.
    expect(screen.queryByText(/Delegação central/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Conceder delegação/i })).toBeNull();
    expect(api.coaches.review, 'a fila da mesa central nem é pedida').not.toHaveBeenCalled();
  });

  it('autorizar usa a federação já escolhida, sem oferecer outra', async () => {
    usuario = DIRETOR_DE_FEDERACAO;
    api.organizations.list.mockResolvedValue(FEDERACOES);
    api.coaches.authorizable.mockResolvedValue({ items: [APROVADO] });
    api.coaches.authorizeOrganization.mockResolvedValue({ id: 'cz9', status: 'APPROVED' });

    render(<AdminTreinadores notificar={vi.fn()} />);
    await screen.findByText('Marta Treinadora');
    fireEvent.click(screen.getByRole('button', { name: /Autorizar atuação/i }));

    const dialogo = await screen.findByRole('dialog');
    // Sem seletor de federação: o escopo é o da lista que está sendo olhada.
    expect(within(dialogo).queryByRole('combobox'), 'não há escolha de outra federação').toBeNull();
    expect(within(dialogo).getByText('Federação A')).toBeTruthy();
    expect(within(dialogo).getByRole('button', { name: /Autorizar atuação/i }),
      'o rótulo do diálogo é o da seção, não o da fila central').toBeTruthy();

    fireEvent.submit(dialogo.querySelector('form'));
    expect(api.coaches.authorizeOrganization).toHaveBeenCalledWith('co5', { organizationId: 'o1', reason: undefined });
  });

  it('quem já está autorizado recebe revogar, e a revogação exige motivo', async () => {
    usuario = DIRETOR_DE_FEDERACAO;
    api.organizations.list.mockResolvedValue(FEDERACOES);
    api.coaches.authorizable.mockResolvedValue({
      items: [{ ...APROVADO, authorization: { id: 'cz1', status: 'APPROVED', grantedAt: '2026-09-01T12:00:00.000Z' } }]
    });
    api.coaches.revokeOrganization.mockResolvedValue({ id: 'cz1', status: 'REVOKED' });

    render(<AdminTreinadores notificar={vi.fn()} />);
    expect(await screen.findByText(/Autorizado/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Autorizar atuação/i }), 'já autorizado não reautoriza').toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Revogar atuação/i }));
    const dialogo = await screen.findByRole('dialog');
    const motivo = within(dialogo).getByLabelText(/Motivo/i);
    expect(motivo.required, 'a revogação exige motivo').toBe(true);

    fireEvent.change(motivo, { target: { value: 'Encerrou a atuação nesta federação.' } });
    fireEvent.submit(dialogo.querySelector('form'));
    expect(api.coaches.revokeOrganization)
      .toHaveBeenCalledWith('co5', { organizationId: 'o1', reason: 'Encerrou a atuação nesta federação.' });
  });

  it('a mesa central continua vendo as três seções — a correção não tirou nada dela', async () => {
    api.coaches.review.mockResolvedValue({ items: [] });
    api.organizations.list.mockResolvedValue(FEDERACOES);
    api.coaches.authorizable.mockResolvedValue({ items: [] });
    api.centralAuthorizations.list.mockResolvedValue({ items: [] });

    render(<AdminTreinadores notificar={vi.fn()} />);

    expect(await screen.findByText(/Cadastros/i)).toBeTruthy();
    expect(screen.getByText(/Atuação na sua federação/i)).toBeTruthy();
    expect(screen.getByText(/Delegação central/i)).toBeTruthy();
  });
});

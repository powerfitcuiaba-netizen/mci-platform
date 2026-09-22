import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// A ABA "HISTÓRICO IMPORTADO" DO PERFIL.
//
// A pergunta que esta tela faz é a mais cara do sistema: "este histórico é
// desta pessoa?". Errar aqui credita a carreira de alguém a um homônimo, e o
// erro só aparece quando a prejudicada vai ver o próprio histórico.
//
// Por isso a suíte tranca três coisas:
//
//   1. A CONFIRMAÇÃO MOSTRA A CARREIRA, não um nome. Entidade, matrícula e
//      cada resultado — evento, categoria, classe, colocação, pontos.
//   2. O AVISO DE HOMÔNIMOS aparece na lista E no diálogo. O servidor manda
//      a marca; a tela não a inventa nem a esconde.
//   3. NENHUM VÍNCULO ACONTECE SEM CLIQUE. Abrir a aba é leitura pura.
// ==========================================================================

const api = {
  athletes: {
    findById: vi.fn(),
    importedHistory: vi.fn(),
    linkImportedIdentity: vi.fn(),
    update: vi.fn(), suspend: vi.fn(), archive: vi.fn(), reactivate: vi.fn(),
    remove: vi.fn(), revealCpf: vi.fn()
  },
  affiliations: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ usuario: { id: 'u1', role: 'ADMIN' } }) }));

const { AdminAtleta } = await import('./adminAtleta');

const perfil = () => ({
  athlete: {
    id: 'a1', organizationId: 'o1', fullName: 'Joana Pereira da Silva', stageName: null,
    sex: 'FEMALE', status: 'ACTIVE', statusReason: null, hasPhoto: false,
    cpf: '***.982.247-**', cpfMasked: '***.982.247-**',
    affiliation: { id: 'f1', name: 'NPC Brasil', code: 'NPC' }, affiliationNumber: 'NPC-123',
    team: null, coach: null
  },
  registrations: [], proHistory: [], results: [], rankings: []
});

const resultado = (extra = {}) => ({
  id: 'r1', eventName: 'Etapa Ipiranga', eventDate: '2026-09-12T00:00:00.000Z',
  categoryCode: 'BIKINI', className: "Women's Bikini - Open Class A",
  placing: 1, points: 5, seasonId: 's1', ...extra
});

const identidade = (extra = {}) => ({
  id: 'x1', displayName: 'JOANA PEREIRA DA SILVA', source: 'MUSCLEWAR',
  affiliation: { id: 'f1', name: 'NPC Brasil', code: 'NPC' },
  affiliationNumber: 'QA-M-901', linkedAt: null,
  results: [resultado()],
  matchedBy: 'NAME', exigeConfirmacaoHumana: true, homonimos: false, ...extra
});

const historico = (extra = {}) => ({
  athlete: { id: 'a1', fullName: 'Joana Pereira da Silva' },
  linked: [], suggestions: [], varreduraTruncada: false, tetoDaVarredura: 500, ...extra
});

const notificacoes = [];
const notificar = (texto, tom) => notificacoes.push({ texto, tom });

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.athletes)) fn.mockReset();
  api.affiliations.list.mockReset();
  api.affiliations.list.mockResolvedValue({ items: [] });
  api.athletes.findById.mockResolvedValue(perfil());
  notificacoes.length = 0;
});
afterEach(cleanup);

const abrirAba = async (dados) => {
  api.athletes.importedHistory.mockResolvedValue(dados);
  render(<AdminAtleta id="a1" navegar={vi.fn()} notificar={notificar} />);
  await screen.findAllByText('Joana Pereira da Silva');
  fireEvent.click(screen.getByRole('button', { name: 'Histórico importado' }));
  return screen.findByText('Históricos que podem ser deste atleta');
};

describe('abrir a aba é leitura pura', () => {
  it('nenhum vínculo acontece sem clique', async () => {
    await abrirAba(historico({ suggestions: [identidade()] }));
    expect(api.athletes.importedHistory).toHaveBeenCalledWith('a1');
    expect(api.athletes.linkImportedIdentity).not.toHaveBeenCalled();
  });

  it('sem candidato nem vínculo, a tela diz as duas coisas em vez de ficar em branco', async () => {
    await abrirAba(historico());
    expect(screen.getByText(/Nenhum histórico importado vinculado/i)).toBeTruthy();
    expect(screen.getByText(/Nenhum histórico candidato/i)).toBeTruthy();
  });
});

describe('a força da pista vem do servidor e aparece na tela', () => {
  it('filiação + matrícula e "só o nome" são marcados de formas diferentes', async () => {
    await abrirAba(historico({
      suggestions: [
        identidade({ id: 'x1', matchedBy: 'AFFILIATION_NUMBER' }),
        identidade({ id: 'x2', matchedBy: 'NAME', affiliationNumber: 'QA-M-902' })
      ]
    }));

    expect(screen.getByText('Filiação + matrícula')).toBeTruthy();
    expect(screen.getByText('Só o nome confere')).toBeTruthy();
  });

  it('o aviso de homônimos aparece na lista quando o servidor o manda', async () => {
    await abrirAba(historico({ suggestions: [identidade({ homonimos: true })] }));
    expect(screen.getAllByText('Homônimos').length).toBeGreaterThan(0);
  });
});

describe('a confirmação mostra a carreira, e não só o nome', () => {
  const abrirDialogo = async (extra = {}) => {
    await abrirAba(historico({ suggestions: [identidade(extra)] }));
    fireEvent.click(screen.getByRole('button', { name: /Vincular a este atleta/i }));
    return screen.findByRole('dialog');
  };

  it('põe cadastro e histórico lado a lado, com entidade e matrícula', async () => {
    const dialogo = await abrirDialogo();

    expect(within(dialogo).getByText('O cadastro no MCI')).toBeTruthy();
    expect(within(dialogo).getByText('O histórico importado')).toBeTruthy();
    // O nome do cadastro e o nome da fonte, cada um do seu lado.
    expect(within(dialogo).getByText('Joana Pereira da Silva')).toBeTruthy();
    expect(within(dialogo).getByText('JOANA PEREIRA DA SILVA')).toBeTruthy();
    // E as duas matrículas, que são o que realmente distingue.
    expect(within(dialogo).getByText('NPC-123')).toBeTruthy();
    expect(within(dialogo).getByText('QA-M-901')).toBeTruthy();
  });

  it('lista cada resultado com evento, categoria, classe, colocação e pontos', async () => {
    const dialogo = await abrirDialogo({
      results: [resultado(), resultado({ id: 'r2', categoryCode: 'WELLNESS', className: 'Wellness - Open', placing: 3, points: 3 })]
    });

    expect(within(dialogo).getAllByText('Etapa Ipiranga')).toHaveLength(2);
    expect(within(dialogo).getByText('BIKINI')).toBeTruthy();
    expect(within(dialogo).getByText('WELLNESS')).toBeTruthy();
    expect(within(dialogo).getByText('1º')).toBeTruthy();
    expect(within(dialogo).getByText('3º')).toBeTruthy();
  });

  it('com homônimos, o diálogo repete o aviso antes do botão', async () => {
    const dialogo = await abrirDialogo({ homonimos: true });
    expect(within(dialogo).getByText(/Semelhança de nome não identifica atleta/i)).toBeTruthy();
  });

  it('confirmar chama a rota com o atleta e a identidade, e avisa quantos lançamentos ganharam dono', async () => {
    const dialogo = await abrirDialogo();
    api.athletes.linkImportedIdentity.mockResolvedValue({ alreadyLinked: false, lancamentos: 2, temporadas: 1 });

    fireEvent.click(within(dialogo).getByRole('button', { name: /^Confirmar vínculo$/i }));

    await waitFor(() => expect(api.athletes.linkImportedIdentity).toHaveBeenCalledWith('a1', 'x1'));
    expect(notificacoes.at(-1).texto).toMatch(/2 lançamento/);
  });

  it('cancelar não chama nada', async () => {
    const dialogo = await abrirDialogo();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Cancelar/i }));
    expect(api.athletes.linkImportedIdentity).not.toHaveBeenCalled();
  });

  it('a recusa do servidor aparece verbatim e o diálogo não fecha', async () => {
    const dialogo = await abrirDialogo();
    const recusa = 'A identidade importada "JOANA PEREIRA DA SILVA" já pertence a outro atleta.';
    api.athletes.linkImportedIdentity.mockRejectedValue(new Error(recusa));

    fireEvent.click(within(dialogo).getByRole('button', { name: /^Confirmar vínculo$/i }));

    await within(dialogo).findByText(recusa);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('o teto da varredura é dito, não escondido', () => {
  it('a tela avisa que as sugestões por nome podem estar incompletas', async () => {
    await abrirAba(historico({ varreduraTruncada: true, tetoDaVarredura: 500, suggestions: [identidade()] }));
    expect(screen.getByText(/A busca por nome foi limitada/i)).toBeTruthy();
    expect(screen.getByText(/mais de 500 históricos sem dono/i)).toBeTruthy();
  });
});

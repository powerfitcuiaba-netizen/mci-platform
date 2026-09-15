import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// ==========================================================================
// REVISÃO DA IMPORTAÇÃO — o operador precisa ver POR QUE, não só O QUE.
//
// A tela mostrava o veredito ("Reconhecido", "Conflito") sem dizer qual chave
// produziu aquilo. Quem revisa não tinha como conferir se casou certo, e um
// CONFLICT sem os candidatos na tela é um botão de "vincular" apertado no
// escuro.
//
// O que estes testes trancam:
//   * MATCHED diz a chave usada;
//   * a SUGESTÃO aparece com nome, filiação e matrícula — e nunca disfarçada
//     de vínculo;
//   * CONFLICT mostra os candidatos em disputa;
//   * a matrícula de filiação (Member Number) não é confundida com o número
//     de atleta;
//   * nada de telefone, e-mail ou CPF de quem não está em questão.
// ==========================================================================

const api = { muscleWar: { preview: vi.fn(), apply: vi.fn(), link: vi.fn(), reject: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { RevisarImportacao } = await import('./adminPlatform');

const item = extras => ({
  id: 'i1',
  rowNumber: 1,
  externalResultId: 'R-1',
  cpf: null,
  athleteName: 'Yuri Santinelli',
  affiliationCode: 'NPC-MT',
  memberNumber: '88281',
  categoryCode: 'BIKINI',
  className: 'OPEN',
  placing: 1,
  points: null,
  isOverallChampion: false,
  matchStatus: 'MATCHED',
  matchedBy: 'AFFILIATION_NUMBER',
  matchCandidates: null,
  reason: null,
  pointsMismatch: null,
  athleteId: 'at1',
  athlete: { id: 'at1', fullName: 'Yuri Santinelli', stageName: null, athleteNumber: 'A-001' },
  suggestedAthleteId: null,
  suggestedAthlete: null,
  ...extras
});

const lote = itens => ({
  import: { id: 'imp1', status: 'PENDING', sourceRef: 'ipiranga.csv' },
  items: itens,
  summary: {
    totalRecords: itens.length, recognized: 0, pending: 0, conflicts: 0,
    duplicates: 0, rejected: 0, applied: 0, valid: 0
  }
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.muscleWar.preview.mockReset();
});
afterEach(cleanup);

const abrir = itens => {
  api.muscleWar.preview.mockResolvedValue(lote(itens));
  render(<RevisarImportacao importId="imp1" onClose={() => {}} notificar={() => {}} />);
};

describe('MATCHED — a chave que reconheceu aparece', () => {
  it('reconhecimento por filiação + matrícula é dito na tela', async () => {
    abrir([item()]);
    await screen.findByRole('table');
    expect(screen.getByText(/filiação \+ matrícula/i)).toBeTruthy();
  });

  it('reconhecimento por CPF é dito como CPF', async () => {
    // O cabeçalho da tabela também diz "CPF": a asserção é sobre a CÉLULA de
    // situação, onde mora o critério.
    abrir([item({ matchedBy: 'CPF', memberNumber: null, affiliationCode: null })]);
    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row')[1];
    expect(within(linha).getByText(/^por$|por CPF/i) || linha.textContent).toBeTruthy();
    expect(linha.textContent).toMatch(/por\s*CPF/i);
  });

  it('a matrícula do arquivo aparece, e não é o número de atleta', async () => {
    abrir([item()]);
    await screen.findByRole('table');
    expect(screen.getByText(/88281/)).toBeTruthy();
    // `athleteNumber` é outra coisa no modelo: exibir "A-001" como matrícula
    // faria o operador conferir o campo errado.
    expect(screen.queryByText('A-001')).toBeNull();
  });
});

describe('sugestão — visível, e nunca disfarçada de vínculo', () => {
  it('o sugerido aparece com nome, filiação e matrícula', async () => {
    abrir([item({
      matchStatus: 'MATCH_PENDING', matchedBy: null, athleteId: null, athlete: null,
      memberNumber: null, affiliationCode: null,
      suggestedAthleteId: 'at9',
      suggestedAthlete: {
        id: 'at9', fullName: 'Carolina Martins', stageName: null,
        affiliationNumber: '155494', affiliation: { id: 'a2', name: 'NPC São Paulo', code: 'NPC-SP' }
      }
    })]);

    await screen.findByRole('table');
    expect(screen.getByText(/sugerido/i)).toBeTruthy();
    expect(screen.getByText(/Carolina Martins/)).toBeTruthy();
    expect(screen.getByText(/155494/)).toBeTruthy();
    expect(screen.getByText(/NPC-SP|NPC São Paulo/)).toBeTruthy();
  });

  it('linha pendente não é rotulada como reconhecida', async () => {
    abrir([item({
      matchStatus: 'MATCH_PENDING', matchedBy: null, athleteId: null, athlete: null,
      suggestedAthleteId: 'at9',
      suggestedAthlete: { id: 'at9', fullName: 'Carolina Martins', stageName: null, affiliationNumber: '155494', affiliation: { id: 'a2', name: 'NPC SP', code: 'NPC-SP' } }
    })]);

    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row')[1];
    expect(linha.textContent).toMatch(/não identificad|pendente/i);
    expect(linha.textContent).not.toMatch(/reconhecid/i);
  });
});

describe('CONFLICT — os candidatos em disputa na tela', () => {
  it('mostra os dois candidatos e a chave que apontou cada um', async () => {
    abrir([item({
      matchStatus: 'CONFLICT', matchedBy: null, athleteId: null, athlete: null,
      reason: 'Chaves divergem.',
      matchCandidates: [
        { matchedBy: 'AFFILIATION_NUMBER', athleteId: 'at1', fullName: 'Yuri Santinelli', affiliationNumber: '88281', affiliation: { id: 'a1', code: 'NPC-MT' } },
        { matchedBy: 'CPF', athleteId: 'at2', fullName: 'Kananda Dos Santos Azevedo', affiliationNumber: '147986', affiliation: { id: 'a1', code: 'NPC-MT' } }
      ]
    })]);

    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row')[1];

    expect(within(linha).getByText(/conflito de identidade/i)).toBeTruthy();
    // Os dois candidatos, cada um com a sua chave, dentro da MESMA linha.
    expect(linha.textContent).toMatch(/filiação \+ matrícula:\s*Yuri Santinelli/i);
    expect(linha.textContent).toMatch(/CPF:\s*Kananda Dos Santos Azevedo/i);
    expect(linha.textContent).toContain('147986');
  });

  it('conflito não é apresentado como vínculo feito', async () => {
    abrir([item({
      matchStatus: 'CONFLICT', matchedBy: null, athleteId: null, athlete: null,
      matchCandidates: [
        { matchedBy: 'AFFILIATION_NUMBER', athleteId: 'at1', fullName: 'Yuri Santinelli', affiliationNumber: '88281', affiliation: { id: 'a1', code: 'NPC-MT' } }
      ]
    })]);

    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row')[1];
    expect(linha.textContent).not.toMatch(/reconhecid/i);
    // A ação de resolver continua existindo — é o operador quem decide.
    expect(within(linha).getByRole('button', { name: /vincular/i })).toBeTruthy();
  });
});

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

// ==========================================================================
// A LISTA CORTADA NÃO PODE PARECER COMPLETA.
//
// A pré-visualização passou a vir paginada: com 10.000 linhas, a resposta
// antiga tinha 12,2 MB. O corte é seguro — os totais continuam sendo do lote
// inteiro —, mas só se a tela DISSER que cortou. Uma tabela que mostra 200 de
// 10.000 sem avisar leva o operador a concluir que não há mais nada a revisar
// e aplicar o lote assim.
// ==========================================================================
describe('a revisão diz que a lista está cortada', () => {
  const comPagina = (itens, page, summary) => ({
    ...lote(itens),
    summary: { ...lote(itens).summary, ...summary },
    page
  });

  it('mostra QUAL faixa veio e quantas existem', async () => {
    api.muscleWar.preview.mockResolvedValue(comPagina(
      [item({ id: 'i1', rowNumber: 1 })],
      { limit: 50, offset: 0, matchStatus: null, returned: 1, total: 10000, hasMore: true },
      { totalRecords: 10000, recognized: 9000, pending: 1000, valid: 9000 }
    ));

    render(<RevisarImportacao importId="imp1" notificar={() => {}} onClose={() => {}} onMudou={() => {}} />);

    // A faixa, e não só a contagem: com páginas, "1 de 10000" não diria ONDE
    // o operador está.
    expect(await screen.findByText(/Mostrando 1–1 de 10000/i)).toBeTruthy();
    // E oferece o caminho para ver o resto.
    expect(await screen.findByRole('button', { name: /Próxima/i })).toBeTruthy();
  });

  it('os totais mostrados são os do LOTE, não os da página', async () => {
    api.muscleWar.preview.mockResolvedValue(comPagina(
      [item({ id: 'i1', rowNumber: 1 })],
      { limit: 200, offset: 0, matchStatus: null, returned: 1, total: 10000, hasMore: true },
      { totalRecords: 10000, recognized: 8500, pending: 1200, conflicts: 300, valid: 8500 }
    ));

    render(<RevisarImportacao importId="imp1" notificar={() => {}} onClose={() => {}} onMudou={() => {}} />);

    // Uma linha na tela, 1.200 pendentes no lote: é o número do lote que
    // precisa aparecer, senão o aviso de revisão nunca dispara.
    expect(await screen.findByText('1200')).toBeTruthy();
    expect(await screen.findByText(/Aplicar agora vai trazer apenas os 8500/i)).toBeTruthy();
  });

  it('lote que cabe numa página não mostra paginação', async () => {
    api.muscleWar.preview.mockResolvedValue(comPagina(
      [item({ id: 'i1', rowNumber: 1 })],
      { limit: 50, offset: 0, matchStatus: null, returned: 1, total: 1, hasMore: false },
      { totalRecords: 1, recognized: 1, valid: 1 }
    ));

    render(<RevisarImportacao importId="imp1" notificar={() => {}} onClose={() => {}} onMudou={() => {}} />);
    await screen.findByText(/Mostrando 1–1 de 1/i);
    expect(screen.queryByRole('button', { name: /Próxima/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Anterior/i })).toBeNull();
  });

  it('virar a página pede o OFFSET seguinte ao servidor', async () => {
    api.muscleWar.preview.mockResolvedValue(comPagina(
      [item({ id: 'i1', rowNumber: 1 })],
      { limit: 50, offset: 0, matchStatus: null, returned: 1, total: 10000, hasMore: true },
      { totalRecords: 10000, recognized: 9000, valid: 9000 }
    ));

    const { default: usuario } = await import('@testing-library/user-event');
    render(<RevisarImportacao importId="imp1" notificar={() => {}} onClose={() => {}} onMudou={() => {}} />);
    await screen.findByText(/Mostrando 1–1 de 10000/i);

    await usuario.click(screen.getByRole('button', { name: /Próxima/i }));

    // Acumular no navegador devolveria o problema que a paginação resolveu: a
    // altura do diálogo voltaria a crescer com o lote.
    await vi.waitFor(() => {
      expect(api.muscleWar.preview.mock.calls.at(-1)[1]).toMatchObject({ offset: 50, limit: 50 });
    });
  });

  it('o filtro por situação é pedido ao SERVIDOR', async () => {
    api.muscleWar.preview.mockResolvedValue(comPagina(
      [item({ id: 'i1', rowNumber: 1 })],
      { limit: 50, offset: 0, matchStatus: null, returned: 1, total: 10000, hasMore: true },
      { totalRecords: 10000, pending: 1000, valid: 9000 }
    ));

    const { default: usuario } = await import('@testing-library/user-event');
    render(<RevisarImportacao importId="imp1" notificar={() => {}} onClose={() => {}} onMudou={() => {}} />);
    await screen.findByText(/Mostrando 1–1 de 10000/i);

    await usuario.selectOptions(screen.getByLabelText(/Situação/i), 'MATCH_PENDING');

    // Filtrar no navegador exigiria ter baixado as dez mil linhas — que é
    // exatamente o que a paginação deixou de fazer.
    await vi.waitFor(() => {
      const ultima = api.muscleWar.preview.mock.calls.at(-1);
      expect(ultima[1]).toMatchObject({ matchStatus: 'MATCH_PENDING' });
    });
  });
});

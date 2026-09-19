import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import usuario from '@testing-library/user-event';

// ==========================================================================
// O QUE SAI DO SISTEMA NUM ARQUIVO.
//
// O export leva o recorte da tela — a página atual, com os filtros aplicados —
// e nada além disso. Não existe porta no servidor para "baixar a importação
// inteira", e inventar uma seria outra funcionalidade, com outra pergunta de
// autorização.
//
// O CPF É A ÚNICA COISA QUE O ARQUIVO MOSTRA DIFERENTE DA TELA, e é decisão,
// não descuido: a tela exige sessão autenticada com permissão de revisão; a
// planilha, depois de baixada, viaja por e-mail e mensagem sem controle
// nenhum. A máscara preserva o que o CPF serve para fazer aqui — conferir de
// quem é a linha — sem levar o documento inteiro junto.
// ==========================================================================

const api = { muscleWar: { preview: vi.fn(), apply: vi.fn(), link: vi.fn() }, athletes: { list: vi.fn() } };
vi.mock('../services/api', () => ({
  default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn()
}));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'SUPER_ADMIN', organizations: [] } }) }));

const { RevisarImportacao } = await import('./adminPlatform');

const EVENTO = {
  id: 'ev1', name: 'Etapa Ipiranga', slug: 'etapa-ipiranga',
  startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiabá', state: 'MT'
};

const previa = (items, page = {}) => ({
  import: { id: 'imp1', organizationId: 'org1', status: 'PENDING', sourceRef: 'ipiranga_resultados.csv', eventId: 'ev1', event: EVENTO },
  summary: { totalRecords: items.length, recognized: items.length, valid: items.length, pending: 0, conflicts: 0, duplicates: 0, rejected: 0, applied: 0 },
  page: { limit: 50, offset: 0, matchStatus: null, returned: items.length, total: items.length, hasMore: false, ...page },
  categories: [{ code: 'MENS_BODYBUILDING', count: items.length }],
  items
});

// O clique gera um Blob e um link temporário; o teste intercepta os dois para
// ler o que de fato seria gravado no disco de quem baixou.
let baixado = null;
beforeEach(() => {
  vi.clearAllMocks();
  baixado = null;
  globalThis.URL.createObjectURL = vi.fn(blob => { baixado = blob; return 'blob:fake'; });
  globalThis.URL.revokeObjectURL = vi.fn();
  api.athletes.list.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

const conteudoBaixado = async () => (baixado ? baixado.text() : null);

const abrirEExportar = async dados => {
  api.muscleWar.preview.mockResolvedValue(dados);
  render(<RevisarImportacao importId="imp1" notificar={vi.fn()} onClose={vi.fn()} onMudou={vi.fn()} />);
  await screen.findByRole('button', { name: /Exportar/i });
  await usuario.click(screen.getByRole('button', { name: /Exportar/i }));
  return conteudoBaixado();
};

describe('o arquivo carrega o que a revisão mostra', () => {
  it('traz cabeçalho e a linha, com os campos que o operador confere', async () => {
    const csv = await abrirEExportar(previa([{
      id: 'i1', rowNumber: 1, matchStatus: 'MATCHED', athleteName: 'Atleta Um',
      affiliationCode: 'NPC', memberNumber: '88281', categoryCode: 'MENS_BODYBUILDING',
      className: "Men's Bodybuilding - Open", placing: 1, points: 5, cpf: '12345678909'
    }]));

    expect(csv).toContain('"Atleta"');
    expect(csv).toContain('"Matrícula"');
    expect(csv).toContain('"Situação"');
    expect(csv).toContain('"Atleta Um"');
    expect(csv).toContain('"88281"');
    expect(csv).toContain('"MENS_BODYBUILDING"');
  });

  it('o CPF sai MASCARADO — a planilha não leva o documento inteiro', async () => {
    const csv = await abrirEExportar(previa([{
      id: 'i1', rowNumber: 1, matchStatus: 'MATCHED', athleteName: 'Atleta Um',
      memberNumber: '88281', className: "Men's Bodybuilding - Open", placing: 1, cpf: '12345678909'
    }]));

    // As DUAS formas do documento, porque a primeira versão deste teste
    // procurava só a crua e passou com o CPF inteiro no arquivo: os pontos da
    // máscara de digitação quebravam o `toContain`.
    expect(csv, 'o CPF cru não pode sair num arquivo').not.toContain('12345678909');
    expect(csv, 'nem o CPF formatado, que é o mesmo documento').not.toContain('123.456.789-09');
    expect(csv, 'as três primeiras e as duas últimas casas somem').toContain('***.456.789-**');
  });

  it('nome com vírgula não vira duas colunas', async () => {
    // Sem aspas no campo, "Souza, Junior" quebraria a linha inteira na
    // planilha de quem abrir — e o erro só apareceria lá, não aqui.
    const csv = await abrirEExportar(previa([{
      id: 'i1', rowNumber: 1, matchStatus: 'MATCHED', athleteName: 'Souza, Junior',
      memberNumber: '88281', className: "Men's Bodybuilding - Open", placing: 1
    }]));

    expect(csv).toContain('"Souza, Junior"');
  });

  it('traz a situação por extenso, e não o código interno', async () => {
    const csv = await abrirEExportar(previa([{
      id: 'i1', rowNumber: 1, matchStatus: 'MATCH_PENDING', athleteName: 'Atleta Um',
      memberNumber: '88281', className: "Men's Bodybuilding - Open", placing: 1,
      reason: 'Atleta não encontrado'
    }]));

    // Quem abre a planilha não sabe o que é MATCH_PENDING.
    expect(csv).not.toContain('MATCH_PENDING');
    expect(csv).toContain('"Atleta não encontrado"');
  });

  it('sem linhas, não há o que exportar', async () => {
    api.muscleWar.preview.mockResolvedValue(previa([]));
    render(<RevisarImportacao importId="imp1" notificar={vi.fn()} onClose={vi.fn()} onMudou={vi.fn()} />);
    const botao = await screen.findByRole('button', { name: /Exportar/i });
    expect(botao.disabled, 'botão que baixa arquivo vazio é armadilha').toBe(true);
  });
});

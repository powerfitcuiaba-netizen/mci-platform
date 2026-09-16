import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// O FORMULÁRIO DE IMPORTAÇÃO PRECISA DECLARAR O QUE O ARQUIVO NÃO DIZ.
//
// O arquivo oficial de uma etapa não traz identificador de resultado nem
// coluna de filiação. As duas coisas existem — só não estão no arquivo — e
// quem sabe delas é o operador que tem o evento na frente.
//
// O que estes testes trancam, e por quê:
//
//   * campo em branco NÃO viaja. Mandar `externalIdPrefix: ''` ligaria a
//     derivação de identificador sem que ninguém tivesse pedido, que é
//     exatamente o acidente que "derivar é opt-in" existe para impedir;
//   * o que o operador escreve chega ao servidor sem espaço sobrando, porque
//     um prefixo com espaço na ponta produziria uma chave diferente na
//     próxima importação e a idempotência deixaria de valer;
//   * a tela diz que a prévia não aplica nada.
// ==========================================================================

const api = { muscleWar: { create: vi.fn() }, organizations: { list: vi.fn() }, ranking: { seasons: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { NovaImportacao } = await import('./adminPlatform');

const ARQUIVO = 'Member Number,Class,First Name,Last Name,Placing\n88281,Bikini Open,Yuri,Santinelli,1\n';

beforeEach(() => {
  vi.clearAllMocks();
  api.organizations.list.mockResolvedValue({ items: [{ id: 'org1', name: 'MCI Brasil' }] });
  api.ranking.seasons.mockResolvedValue({ items: [{ id: 's1', name: 'Temporada', year: 2026 }] });
  api.muscleWar.create.mockResolvedValue({ import: { id: 'imp1' } });
});
afterEach(cleanup);

async function preencher(usuario, { prefixo, filiacao } = {}) {
  const { container } = render(<NovaImportacao notificar={vi.fn()} onClose={vi.fn()} onCriada={vi.fn()} />);

  await usuario.selectOptions(await screen.findByRole('combobox', { name: /organização/i }), 'org1');

  const arquivo = new File([ARQUIVO], 'etapa.csv', { type: 'text/csv' });
  // Pelo tipo do campo, e não pelo rótulo: as dicas dos outros campos também
  // falam em "arquivo", e a busca por texto acharia três.
  await usuario.upload(container.querySelector('input[type="file"]'), arquivo);
  // A leitura é assíncrona; sem esperar, o resto corre antes de o conteúdo
  // existir no estado.
  await screen.findByText(/caracteres lidos/i);

  if (prefixo) await usuario.type(screen.getByLabelText(/prefixo do identificador/i), prefixo);
  if (filiacao) await usuario.type(screen.getByLabelText(/filiação de toda a etapa/i), filiacao);

  // Submissão direta em vez de clique no botão. No jsdom o `input[type=file]`
  // perde os arquivos no re-render que o próprio upload provoca, e a validação
  // nativa do `required` passa a barrar o envio — um navegador de verdade
  // mantém a seleção. O que está sob teste aqui é o CORPO que o formulário
  // monta, não a validação de HTML, e travar o teste nesse artefato mediria o
  // jsdom em vez da tela.
  fireEvent.submit(container.querySelector('form'));
  await screen.findByRole('button', { name: /pré-visualizar/i });

  return api.muscleWar.create.mock.calls[0]?.[0];
}

describe('declaração do lote no formulário de importação', () => {
  it('campos em branco não viajam para o servidor', async () => {
    const corpo = await preencher(userEvent.setup());

    expect(corpo).toBeDefined();
    expect(corpo).not.toHaveProperty('externalIdPrefix');
    expect(corpo).not.toHaveProperty('defaultAffiliationCode');
  });

  it('o que o operador declara chega ao servidor', async () => {
    const corpo = await preencher(userEvent.setup(), { prefixo: 'IPIRANGA', filiacao: 'NPC' });

    expect(corpo.externalIdPrefix).toBe('IPIRANGA');
    expect(corpo.defaultAffiliationCode).toBe('NPC');
  });

  it('espaço sobrando não entra na chave', async () => {
    // '  IPIRANGA ' e 'IPIRANGA' produziriam chaves diferentes para a mesma
    // participação, e a segunda importação do mesmo arquivo somaria de novo.
    const corpo = await preencher(userEvent.setup(), { prefixo: '  IPIRANGA ', filiacao: ' NPC ' });

    expect(corpo.externalIdPrefix).toBe('IPIRANGA');
    expect(corpo.defaultAffiliationCode).toBe('NPC');
  });

  it('só espaço em branco continua sendo campo não declarado', async () => {
    const corpo = await preencher(userEvent.setup(), { prefixo: '   ' });
    expect(corpo).not.toHaveProperty('externalIdPrefix');
  });

  it('a tela avisa que a prévia não aplica nada', async () => {
    render(<NovaImportacao notificar={vi.fn()} onClose={vi.fn()} onCriada={vi.fn()} />);
    expect(await screen.findByText(/nada é aplicado antes da sua confirmação/i)).toBeTruthy();
  });

  it('o operador é avisado de que Total Score não pontua', async () => {
    render(<NovaImportacao notificar={vi.fn()} onClose={vi.fn()} onCriada={vi.fn()} />);
    expect(await screen.findByText(/Total Score não é lido como pontuação/i)).toBeTruthy();
  });
});

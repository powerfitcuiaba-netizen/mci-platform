import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// HOMOLOGAÇÃO DO OVERALL — a tela que REGISTRA uma decisão, e não a toma.
//
// O que esta tela não pode fazer, e cada teste tranca uma porta:
//
//   * oferecer classe que não é absoluta — Novice, Master e afins não entram
//     na lista de homologação;
//   * destacar o 1º lugar como se fosse o campeão Overall — a colocação é
//     fato, a escolha é do operador;
//   * homologar com um clique só;
//   * esconder o impacto antes da confirmação;
//   * oferecer "declarar" num recorte que já tem campeão homologado.
// ==========================================================================

const api = {
  events: { list: vi.fn() },
  ranking: {
    overallCandidates: vi.fn(),
    overallPreview: vi.fn(),
    declararOverall: vi.fn(),
    revokeOverall: vi.fn()
  }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminOverall } = await import('./adminOverall');

// `notificar` REAL do projeto: (texto, tom). O teste passava `() => {}`, que
// aceita qualquer coisa — e por isso não pegou a chamada com um OBJETO, que
// derrubava a aplicação inteira com React error #31 na confirmação. Quem
// pegou foi o navegador. O espião abaixo cobra a assinatura.
const notificacoes = [];
const notificar = (texto, tom) => {
  if (typeof texto !== 'string') throw new TypeError(`notificar espera texto, recebeu ${typeof texto}`);
  notificacoes.push({ texto, tom });
};

const EVENTO = {
  id: 'ev1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba',
  startDate: '2026-11-20T12:00:00.000Z',
  season: { id: 's1', name: 'Temporada 2026', year: 2026 },
  organization: { id: 'o1', name: 'MCI Brasil' }
};

const candidato = (nome, placing, extras = {}) => ({
  placing, status: 'RANKED',
  athlete: { id: `at-${nome}`, fullName: nome, stageName: null },
  affiliationNumber: '88281',
  affiliation: { id: 'a1', name: 'NPC Mato Grosso', code: 'NPC-MT' },
  ...extras
});

const grupoOpen = (extras = {}) => ({
  competitionClass: { id: 'cl1', name: 'Open', code: 'OPEN' },
  division: { id: 'd1', name: 'Absoluta', code: 'ABS' },
  category: { id: 'c1', code: 'BIKINI', name: 'Bikini' },
  declaredTitle: null,
  candidates: [candidato('PRIMEIRA', 1), candidato('SEGUNDA', 2), candidato('TERCEIRA', 3)],
  ...extras
});

const PREVIA = {
  event: { id: 'ev1', name: 'Etapa Cuiabá' },
  athlete: {
    id: 'at-TERCEIRA', fullName: 'TERCEIRA', stageName: null,
    affiliationNumber: '88281', affiliation: { id: 'a1', name: 'NPC Mato Grosso', code: 'NPC-MT' }
  },
  category: { id: 'c1', code: 'BIKINI', name: 'Bikini' },
  competitionClass: { id: 'cl1', name: 'Open', code: 'OPEN' },
  overallBonus: 10,
  participation: { placing: 3, placementPoints: 3, pointsBefore: 3, pointsAfter: 13 },
  seasonImpact: 10,
  alreadyDeclared: false
};

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of [api.events.list, api.ranking.overallCandidates, api.ranking.overallPreview, api.ranking.declararOverall, api.ranking.revokeOverall]) fn.mockReset();
  api.events.list.mockResolvedValue({ items: [{ id: 'ev1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba', startDate: EVENTO.startDate, status: 'RESULTS_PUBLISHED' }], nextCursor: null });
});
afterEach(cleanup);

// A tela começa sem evento escolhido — o operador seleciona, como em todas as
// telas administrativas do projeto. O helper faz essa escolha para não repetir
// o mesmo `fireEvent` em cada teste.
const abrir = async (items, extras = {}) => {
  api.ranking.overallCandidates.mockResolvedValue({ event: EVENTO, items, ...extras });
  notificacoes.length = 0;
  render(<AdminOverall notificar={notificar} />);

  const seletor = await screen.findByLabelText(/selecionar evento/i);
  await waitFor(() => expect(within(seletor).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(seletor, { target: { value: 'ev1' } });
  await waitFor(() => expect(api.ranking.overallCandidates).toHaveBeenCalledWith('ev1'));
};

describe('o campeonato e o recorte', () => {
  it('mostra campeonato, temporada e organização', async () => {
    await abrir([grupoOpen()]);
    // O nome do campeonato aparece também na opção do seletor: a asserção é
    // sobre o CABEÇALHO do painel, que é onde o operador confirma em qual
    // evento está mexendo.
    expect(await screen.findByRole('heading', { name: /Etapa Cuiabá/ })).toBeTruthy();
    expect(screen.getByText(/Temporada 2026/)).toBeTruthy();
    expect(screen.getByText(/MCI Brasil/)).toBeTruthy();
  });

  it('SÓ classes absolutas aparecem — a API já as filtra, e a tela não inventa outras', async () => {
    await abrir([grupoOpen()]);
    await screen.findByRole('heading', { name: /Etapa Cuiabá/ });

    expect(screen.getAllByText(/Open/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Novice/i)).toBeNull();
    expect(screen.queryByText(/Master/i)).toBeNull();
  });

  it('evento sem classe absoluta diz isso, e não oferece homologação', async () => {
    await abrir([]);
    expect(await screen.findByText(/nenhuma classe absoluta/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /declarar overall/i })).toBeNull();
  });
});

describe('os candidatos', () => {
  it('lista posição, nome, matrícula e filiação', async () => {
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');
    const linhas = within(tabela).getAllByRole('row').slice(1);

    expect(linhas).toHaveLength(3);
    expect(linhas[0].textContent).toContain('PRIMEIRA');
    expect(linhas[0].textContent).toContain('88281');
    expect(linhas[0].textContent).toContain('NPC Mato Grosso');
  });

  it('o 1º lugar NÃO é destacado como campeão Overall', async () => {
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');
    const primeira = within(tabela).getAllByRole('row')[1];

    // A colocação aparece como fato. O que não pode aparecer é qualquer coisa
    // que dê a entender que o sistema escolheu.
    expect(primeira.textContent).not.toMatch(/campeã?o overall|sugerid|provável/i);
    // E todos os candidatos têm o mesmo botão: nenhum vem pré-selecionado.
    const botoes = within(tabela).getAllByRole('button', { name: /declarar overall/i });
    expect(botoes).toHaveLength(3);
  });
});

describe('prévia e dupla confirmação', () => {
  it('clicar em declarar abre a PRÉVIA, e não homologa nada', async () => {
    api.ranking.overallPreview.mockResolvedValue(PREVIA);
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');

    const linhaTerceira = within(tabela).getAllByRole('row').find(l => l.textContent.includes('TERCEIRA'));
    fireEvent.click(within(linhaTerceira).getByRole('button', { name: /declarar overall/i }));

    // O título da página também diz "Homologação do Overall": o que prova a
    // prévia é o DIÁLOGO ter aberto.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(api.ranking.overallPreview).toHaveBeenCalled();
    expect(api.ranking.declararOverall, 'abrir a prévia não homologa').not.toHaveBeenCalled();
  });

  it('a prévia mostra a conta aberta: 3 + 10 = 13, e o impacto no acumulado', async () => {
    api.ranking.overallPreview.mockResolvedValue(PREVIA);
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row').find(l => l.textContent.includes('TERCEIRA'));
    fireEvent.click(within(linha).getByRole('button', { name: /declarar overall/i }));

    const dialogo = await screen.findByRole('dialog');
    expect(dialogo.textContent).toMatch(/3º/);
    expect(dialogo.textContent).toMatch(/13/);
    expect(dialogo.textContent).toMatch(/88281/);

    // A LINHA do bônus, e não o texto solto do diálogo. Asserção larga passava
    // mesmo com o bônus apagado, porque "+10" também aparece no impacto no
    // acumulado — duas informações diferentes que por acaso têm o mesmo número.
    const linhaDoBonus = [...dialogo.querySelectorAll('dt')].find(dt => /bônus overall/i.test(dt.textContent));
    expect(linhaDoBonus, 'a prévia tem linha de bônus').toBeTruthy();
    expect(linhaDoBonus.parentElement.textContent).toMatch(/\+10/);

    const linhaDoTotal = [...dialogo.querySelectorAll('dt')].find(dt => /total da participação/i.test(dt.textContent));
    expect(linhaDoTotal.parentElement.textContent).toMatch(/13/);
    // A frase que a fase exige: a plataforma não decide.
    expect(dialogo.textContent).toMatch(/não calcula|não decide/i);
  });

  it('a homologação só acontece na CONFIRMAÇÃO explícita', async () => {
    api.ranking.overallPreview.mockResolvedValue(PREVIA);
    api.ranking.declararOverall.mockResolvedValue({ id: 't1', athleteId: 'at-TERCEIRA' });
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row').find(l => l.textContent.includes('TERCEIRA'));
    fireEvent.click(within(linha).getByRole('button', { name: /declarar overall/i }));

    const dialogo = await screen.findByRole('dialog');
    expect(api.ranking.declararOverall).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: /confirmar homologação/i }));
    await waitFor(() => expect(api.ranking.declararOverall).toHaveBeenCalledTimes(1));
    expect(api.ranking.declararOverall).toHaveBeenCalledWith('ev1', expect.objectContaining({ athleteId: 'at-TERCEIRA' }));

    // E a notificação de SUCESSO sai, na assinatura que o aplicativo usa.
    //
    // Conferir só "houve notificação" não bastava: o espião lança quando recebe
    // objeto, o `catch` do componente engole a exceção e notifica o ERRO — e a
    // contagem continuava 1. Foi assim que a chamada com objeto, que derruba a
    // aplicação de verdade, sobreviveu à primeira rodada de mutação.
    await waitFor(() => expect(notificacoes.length).toBe(1));
    expect(typeof notificacoes[0].texto).toBe('string');
    expect(notificacoes[0].texto, 'a notificação é de sucesso').toMatch(/homologado/i);
    expect(notificacoes[0].tom, 'e não de erro').toBeUndefined();
  });

  it('cancelar fecha sem homologar', async () => {
    api.ranking.overallPreview.mockResolvedValue(PREVIA);
    await abrir([grupoOpen()]);
    const tabela = await screen.findByRole('table');
    const linha = within(tabela).getAllByRole('row').find(l => l.textContent.includes('TERCEIRA'));
    fireEvent.click(within(linha).getByRole('button', { name: /declarar overall/i }));

    const dialogo = await screen.findByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: /cancelar/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.ranking.declararOverall).not.toHaveBeenCalled();
  });
});

describe('estado homologado', () => {
  it('recorte já homologado mostra HOMOLOGADO e não oferece declarar', async () => {
    await abrir([grupoOpen({
      declaredTitle: { id: 't1', athleteId: 'at-PRIMEIRA', categoryId: 'c1', declaredAt: '2026-11-21T10:00:00.000Z' }
    })]);

    await screen.findByRole('table');
    expect(screen.getByText(/Overall declarado oficialmente/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /declarar overall/i }), 'sem botão de declarar').toBeNull();
    // A correção existe, e é operação própria.
    expect(screen.getByRole('button', { name: /revogar/i })).toBeTruthy();
  });

  it('revogar exige motivo antes de enviar', async () => {
    api.ranking.revokeOverall.mockResolvedValue({ revoked: true });
    await abrir([grupoOpen({
      declaredTitle: { id: 't1', athleteId: 'at-PRIMEIRA', categoryId: 'c1', declaredAt: '2026-11-21T10:00:00.000Z' }
    })]);

    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: /revogar/i }));

    const dialogo = await screen.findByRole('dialog');
    const confirmar = within(dialogo).getByRole('button', { name: /revogar homologação/i });
    expect(confirmar.disabled, 'sem motivo, não dá para revogar').toBe(true);

    fireEvent.change(within(dialogo).getByRole('textbox'), { target: { value: 'Ata oficial corrigida' } });
    expect(within(dialogo).getByRole('button', { name: /revogar homologação/i }).disabled).toBe(false);

    fireEvent.click(within(dialogo).getByRole('button', { name: /revogar homologação/i }));
    await waitFor(() => expect(api.ranking.revokeOverall).toHaveBeenCalledWith('ev1', 't1', { reason: 'Ata oficial corrigida' }));
  });
});

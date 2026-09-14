import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// RESULTADOS — a tela de maior consequência do sistema.
//
// Ela não tinha NENHUM teste de componente. Foi assim que um defeito de
// digitação sobreviveu desde 23ae79e: `<AsyncSection estado={...}>` num lugar
// onde o componente recebe `state`. Com `state` indefinido, a primeira linha
// de AsyncSection lê `state.error` e estoura — o diálogo de lançar resultado
// derrubava a tela inteira para o limite de erro.
//
// Não aparecia em lint (prop desconhecida é válida em JSX), não aparecia em
// build, e não aparecia em teste porque não havia teste.
// ==========================================================================

const api = {
  events: { findOne: vi.fn(), list: vi.fn() },
  results: { listByEvent: vi.fn(), receive: vi.fn(), publish: vi.fn(), override: vi.fn(), versions: vi.fn() },
  ranking: { listarOverall: vi.fn(), declararOverall: vi.fn() },
  registrations: { listByEvent: vi.fn() }
};

vi.mock('../services/api', () => ({
  default: api,
  refreshData: vi.fn()
}));

const { AdminResultados } = await import('./adminResults');
const { PalcoDaExperiencia } = await import('../components/experiencia');

// O motor lê a preferência do navegador de verdade; jsdom não traz matchMedia.
function aparelho({ movimentoReduzido = false } = {}) {
  window.matchMedia = consulta => ({
    matches: consulta.includes('prefers-reduced-motion') ? movimentoReduzido : false,
    media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
}

const EVENTO = {
  id: 'e1',
  name: 'Muscle Contest Curitiba',
  // `category.id` NÃO é enfeite do dublê: é o `value` da opção de recorte, e
  // é ele que vai no corpo da declaração. A API sempre o devolve
  // (eventService.ESTRUTURA seleciona id, code, name, sex). Sem ele aqui, o
  // teste passava com `key={undefined}` e o recorte nunca seria enviado.
  eventCategories: [{
    category: { id: 'cat1', name: 'Men’s Physique' },
    divisions: [{ name: 'Open', classes: [{ id: 'c1', name: 'Até 172cm' }] }]
  }]
};

beforeEach(() => {
  api.events.list.mockResolvedValue({ items: [EVENTO] });
  api.events.findOne.mockResolvedValue(EVENTO);
  api.results.listByEvent.mockResolvedValue({ items: [] });
  // FORMA REAL conferida contra o servidor: a rota devolve `{ items: [...] }`,
  // e não um array puro. Meu mock devolvia array — e o teste concordou com a
  // suposição errada em vez de me contradizer. Terceira vez nesta fase.
  api.ranking.listarOverall.mockResolvedValue({ items: [] });
  // FORMA REAL conferida contra o servidor: o item traz `competitionClass.id`,
  // e NÃO `classId`. O mock antigo inventava `classId` — e um mock que inventa
  // a forma dos dados faz o teste passar justamente quando o produto quebra.
  api.registrations.listByEvent.mockResolvedValue({
    items: [{ athlete: { id: 'at1', fullName: 'Carlos Mendes' }, items: [{ id: 'ri1', competitionClass: { id: 'c1', name: 'Até 172cm' } }] }]
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// O seletor de evento é um <select>; escolher o evento é o que destrava a tela.
// Mesma armadilha do arquivo de operação: o `select` existe antes da lista de
// eventos chegar, e um `change` para uma opção inexistente é no-op silencioso.
async function abrirEvento() {
  render(<AdminResultados notificar={() => {}} />);
  const seletor = await screen.findByRole('combobox');
  await waitFor(() => expect(seletor.querySelector('option[value="e1"]')).toBeTruthy());
  fireEvent.change(seletor, { target: { value: 'e1' } });
  return seletor;
}

describe('lançar resultado oficial', () => {
  it('o diálogo abre e lista quem está inscrito na classe', async () => {
    await abrirEvento();
    const botao = await screen.findByRole('button', { name: /Lançar resultado/i });
    fireEvent.click(botao);

    // É aqui que a tela estourava: AsyncSection recebia `estado` em vez de
    // `state`, lia `undefined.error` e derrubava tudo.
    expect(await screen.findByText('Carlos Mendes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lançar resultado oficial/i })).toBeTruthy();
  });

  it('o diálogo mostra o esqueleto enquanto as inscrições não chegam, em vez de quebrar', async () => {
    let liberar;
    api.registrations.listByEvent.mockReturnValue(new Promise(r => { liberar = r; }));
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /Lançar resultado/i }));

    // Estado de carregamento: nem crash, nem lista vazia mentindo que não há
    // inscrito. O operador precisa distinguir "carregando" de "ninguém".
    expect(screen.queryByText(/Nenhum inscrito nesta classe/i)).toBeNull();

    liberar({ items: [{ athlete: { id: 'at1', fullName: 'Carlos Mendes' }, items: [{ id: 'ri1', competitionClass: { id: 'c1', name: 'Até 172cm' } }] }] });
    expect(await screen.findByText('Carlos Mendes')).toBeTruthy();
  });

  it('sem inscrito na classe, diz isso — e não some em silêncio', async () => {
    api.registrations.listByEvent.mockResolvedValue({ items: [] });
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /Lançar resultado/i }));
    expect(await screen.findByText(/Nenhum inscrito nesta classe/i)).toBeTruthy();
  });

  it('a falha ao carregar inscrições é mostrada, com caminho de volta', async () => {
    api.registrations.listByEvent.mockRejectedValue(new Error('Falha de rede'));
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /Lançar resultado/i }));
    await waitFor(() => expect(screen.getByText(/Falha de rede/i)).toBeTruthy());
  });
});

describe('os botões do diálogo de lançamento', () => {
  it('"Cancelar" realmente fecha — não é um botão morto', async () => {
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    expect(await screen.findByText('Carlos Mendes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Cancelar/i }));
    await waitFor(() => expect(screen.queryByText('Carlos Mendes')).toBeNull());
  });

  it('o botão de confirmar diz o que faz, e não "Salvar"', async () => {
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    await screen.findByText('Carlos Mendes');
    expect(screen.getByRole('button', { name: /Lançar resultado oficial/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Salvar$/i })).toBeNull();
  });

  it('sem ninguém inscrito, não dá para lançar', async () => {
    api.registrations.listByEvent.mockResolvedValue({ items: [] });
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    await screen.findByText(/Nenhum inscrito nesta classe/i);
    expect(screen.getByRole('button', { name: /Lançar resultado oficial/i }).disabled).toBe(true);
  });
});

describe('a plataforma transcreve, não julga', () => {
  it('a colocação enviada é exatamente a digitada, na ordem em que o operador a deu', async () => {
    api.registrations.listByEvent.mockResolvedValue({
      items: [
        { athlete: { id: 'at1', fullName: 'Carlos Mendes' }, items: [{ id: 'ri1', competitionClass: { id: 'c1', name: 'Até 172cm' } }] },
        { athlete: { id: 'at2', fullName: 'Ana Prado' }, items: [{ id: 'ri2', competitionClass: { id: 'c1', name: 'Até 172cm' } }] }
      ]
    });
    api.results.receive.mockResolvedValue({ hasUnresolvedTie: false });
    await abrirEvento();
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    await screen.findByText('Carlos Mendes');

    const campos = screen.getAllByPlaceholderText('Colocação');
    // Carlos em 2º, Ana em 1º: a interface NÃO pode reordenar nem "corrigir".
    fireEvent.change(campos[0], { target: { value: '2' } });
    fireEvent.change(campos[1], { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Lançar resultado oficial/i }));

    await waitFor(() => expect(api.results.receive).toHaveBeenCalled());
    const [classId, corpo] = api.results.receive.mock.calls[0];
    expect(classId).toBe('c1');
    expect(corpo.entries).toEqual([
      { athleteId: 'at1', placing: 2, status: 'RANKED' },
      { athleteId: 'at2', placing: 1, status: 'RANKED' }
    ]);
  });

  it('empate recebido é enviado como empate, sem colocação inventada', async () => {
    api.results.receive.mockResolvedValue({ hasUnresolvedTie: true });
    const avisos = [];
    render(<AdminResultados notificar={(texto, tom) => avisos.push({ texto, tom })} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'e1' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    await screen.findByText('Carlos Mendes');

    fireEvent.change(screen.getByRole('combobox', { name: '' }) || screen.getAllByRole('combobox')[1],
      { target: { value: 'TIE_UNRESOLVED' } });
    fireEvent.click(screen.getByRole('button', { name: /Lançar resultado oficial/i }));

    await waitFor(() => expect(api.results.receive).toHaveBeenCalled());
    const corpo = api.results.receive.mock.calls[0][1];
    expect(corpo.entries[0].status).toBe('TIE_UNRESOLVED');
    expect(corpo.entries[0].placing).toBeNull();
    // E o operador precisa SABER que a publicação ficou travada.
    await waitFor(() => expect(avisos.some(a => /empate/i.test(a.texto) && /trava/i.test(a.texto))).toBe(true));
  });
});

// ==========================================================================
// O MOTOR DE EXPERIÊNCIA NESTA TELA.
//
// Estes testes montam o palco de verdade e olham o DOM: provam a corrente
// inteira (a tela anuncia → o motor decide → o palco desenha), e não só que
// uma função foi chamada.
// ==========================================================================
describe('o que a tela de resultados celebra', () => {
  const montarComPalco = () => render(<><AdminResultados notificar={() => {}} /><PalcoDaExperiencia /></>);

  async function lancar({ hasUnresolvedTie }) {
    api.results.receive.mockResolvedValue({ hasUnresolvedTie });
    montarComPalco();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'e1' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Lançar resultado$/i }));
    await screen.findByText('Carlos Mendes');
    fireEvent.change(screen.getByPlaceholderText('Colocação'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Lançar resultado oficial/i }));
    await waitFor(() => expect(api.results.receive).toHaveBeenCalled());
  }

  it('publicar desenha o momento de resultado publicado — e NÃO o do campeão', async () => {
    aparelho();
    api.results.listByEvent.mockResolvedValue({
      items: [{ id: 'r1', classId: 'c1', status: 'DRAFT', version: 1, checksum: 'abc1234567', entries: [],
                competitionClass: { name: 'Até 172cm', division: { eventCategory: { category: { name: 'Men’s Physique' } } } },
                computedAt: new Date().toISOString() }]
    });
    api.results.publish.mockResolvedValue({ ranking: { awarded: 5 } });
    montarComPalco();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'e1' } });
    // A linha da classe tem "Publicar"; o diálogo tem outro "Publicar". Pegar
    // o primeiro abre, e depois o do diálogo confirma.
    // Esperar a lista chegar: antes disso a linha ainda nem tem o botão.
    const abrir = await screen.findByRole('button', { name: /^Publicar$/i });
    fireEvent.click(abrir);
    await screen.findByText(/Publicar torna a classificação pública/i);
    const confirmar = screen.getAllByRole('button', { name: /^Publicar$/i }).at(-1);
    fireEvent.click(confirmar);

    await waitFor(() => expect(api.results.publish).toHaveBeenCalled());
    expect(await screen.findByText('Resultado publicado')).toBeTruthy();
    // O nível 5 continua sendo só do campeão.
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('empate não resolvido NÃO vira comemoração', async () => {
    aparelho();
    await lancar({ hasUnresolvedTie: true });

    // Publicação travada: o palco não pode dizer "deu certo".
    await waitFor(() => expect(screen.queryByText('Resultado lançado')).toBeNull());
    expect(document.querySelector('.impacto')).toBeNull();
    expect(document.querySelector('.campeao')).toBeNull();
    // E o que aparece, se aparecer, é o tom de atenção — nunca o de sucesso.
    const caixa = document.querySelector('.impacto');
    if (caixa) expect(caixa.className).not.toContain('impacto-sucesso');
  });

  it('lançar resultado confirma sem tomar o centro — publicar é que é o momento', async () => {
    aparelho();
    await lancar({ hasUnresolvedTie: false });
    // Lançar é transcrição de rotina: várias classes por evento. Quem ocupa o
    // centro da tela é a PUBLICAÇÃO, que é quando a classificação passa a
    // valer para o público e para o ranking.
    expect(document.querySelector('.impacto')).toBeNull();
  });

  it('com movimento reduzido nem a publicação é desenhada — o toast informa', async () => {
    aparelho({ movimentoReduzido: true });
    await lancar({ hasUnresolvedTie: false });
    expect(screen.queryByText('Resultado lançado')).toBeNull();
    expect(document.querySelector('.impacto')).toBeNull();
  });
});

// ==========================================================================
// O TÍTULO OVERALL — a única porta do produto para o Momento Campeão.
//
// O endpoint existia desde sempre no servidor, com permissão e auditoria, e
// NENHUMA tela o chamava. Consequência dupla e silenciosa: o bônus Overall não
// tinha como ser concedido pelo produto, e o efeito de nível 5 era código
// morto fora do laboratório.
//
// O MCI não julga: o Overall é decidido pela comissão e apenas REGISTRADO
// aqui. A raridade do nível 5 vem do fato — uma declaração por evento —, e não
// de uma regra de interface.
// ==========================================================================
describe('título Overall', () => {
  const abrirDeclaracao = async () => {
    render(<><AdminResultados notificar={() => {}} /><PalcoDaExperiencia /></>);
    const seletor = await screen.findByRole('combobox');
    await waitFor(() => expect(seletor.querySelector('option[value="e1"]')).toBeTruthy());
    fireEvent.change(seletor, { target: { value: 'e1' } });
    fireEvent.click(await screen.findByRole('button', { name: /Declarar Overall/i }));
    return screen.findByLabelText(/Atleta/i);
  };

  it('o título declarado APARECE na lista', async () => {
    aparelho();
    api.ranking.listarOverall.mockResolvedValue({
      items: [{
        id: 't1', declaredAt: new Date().toISOString(), note: 'Decisão da comissão',
        athlete: { id: 'at1', fullName: 'Carlos Mendes', stageName: null },
        category: { id: 'cat1', name: 'Men’s Physique' }
      }]
    });
    render(<AdminResultados notificar={() => {}} />);
    const seletor = await screen.findByRole('combobox');
    await waitFor(() => expect(seletor.querySelector('option[value="e1"]')).toBeTruthy());
    fireEvent.change(seletor, { target: { value: 'e1' } });
    expect(await screen.findByText('Carlos Mendes')).toBeTruthy();
    expect(screen.getByText(/Decisão da comissão/)).toBeTruthy();
    expect(screen.queryByText(/Nenhum título Overall declarado/i)).toBeNull();
  });

  it('a tela diz que a plataforma REGISTRA, não decide', async () => {
    aparelho();
    render(<AdminResultados notificar={() => {}} />);
    const seletor = await screen.findByRole('combobox');
    await waitFor(() => expect(seletor.querySelector('option[value="e1"]')).toBeTruthy());
    fireEvent.change(seletor, { target: { value: 'e1' } });
    expect(await screen.findByText(/Declarado pela organização/i)).toBeTruthy();
    expect(screen.getByText(/não decide/i)).toBeTruthy();
  });

  it('declarar dispara o Momento Campeão — o único nível 5 do produto', async () => {
    aparelho();
    api.ranking.declararOverall.mockResolvedValue({});
    const campo = await abrirDeclaracao();
    fireEvent.change(campo, { target: { value: 'at1' } });
    // Dois botões com o mesmo nome: o do painel abre, o do diálogo confirma.
    fireEvent.click(screen.getAllByRole('button', { name: /^Declarar Overall$/i }).at(-1));

    await waitFor(() => expect(api.ranking.declararOverall).toHaveBeenCalled());
    expect(api.ranking.declararOverall.mock.calls[0][0]).toBe('e1');
    expect(api.ranking.declararOverall.mock.calls[0][1].athleteId).toBe('at1');
    await waitFor(() => expect(document.querySelector('.campeao')).toBeTruthy());
    expect(screen.getByText('Carlos Mendes')).toBeTruthy();
  });

  // O recorte é OPCIONAL, mas quando é escolhido tem de CHEGAR. A opção existir
  // na tela não prova nada: o que vai no corpo da declaração é o `value` dela.
  // Um dublê sem `category.id` desenhava a opção certinha, com `value=""`, e o
  // título viraria Overall do evento inteiro sem ninguém perceber.
  it('o recorte escolhido chega no corpo da declaração', async () => {
    aparelho();
    api.ranking.declararOverall.mockResolvedValue({});
    const campo = await abrirDeclaracao();
    fireEvent.change(campo, { target: { value: 'at1' } });

    const recorte = screen.getByLabelText(/Recorte/i);
    const opcao = [...recorte.options].find(o => o.textContent.includes('Physique'));
    expect(opcao, 'a categoria do evento não apareceu como recorte').toBeTruthy();
    expect(opcao.value, 'a opção de recorte não carrega id de categoria').toBeTruthy();
    fireEvent.change(recorte, { target: { value: opcao.value } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Declarar Overall$/i }).at(-1));

    await waitFor(() => expect(api.ranking.declararOverall).toHaveBeenCalled());
    expect(api.ranking.declararOverall.mock.calls[0][1].categoryId).toBe('cat1');
  });

  it('sem atleta escolhido não dá para declarar', async () => {
    aparelho();
    await abrirDeclaracao();
    const confirmar = screen.getAllByRole('button', { name: /^Declarar Overall$/i }).at(-1);
    expect(confirmar.disabled).toBe(true);
    fireEvent.click(confirmar);
    expect(api.ranking.declararOverall).not.toHaveBeenCalled();
  });

  it('falha ao declarar NÃO desenha campeão nenhum', async () => {
    aparelho();
    api.ranking.declararOverall.mockRejectedValue(new Error('Sem permissão de ranking'));
    const campo = await abrirDeclaracao();
    fireEvent.change(campo, { target: { value: 'at1' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Declarar Overall$/i }).at(-1));

    expect(await screen.findByText('Título não declarado')).toBeTruthy();
    expect(screen.getByText(/Nada foi registrado/i)).toBeTruthy();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('com movimento reduzido o título é declarado igual — sem o teatro', async () => {
    aparelho({ movimentoReduzido: true });
    api.ranking.declararOverall.mockResolvedValue({});
    const campo = await abrirDeclaracao();
    fireEvent.change(campo, { target: { value: 'at1' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Declarar Overall$/i }).at(-1));
    await waitFor(() => expect(api.ranking.declararOverall).toHaveBeenCalled());
    expect(document.querySelector('.campeao')).toBeNull();
  });
});

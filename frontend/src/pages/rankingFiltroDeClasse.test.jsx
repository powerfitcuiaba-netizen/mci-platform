import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// TEMPORADA → CATEGORIA → CLASSE, E A LISTA DE CLASSES VEM DO SERVIDOR.
//
// A classe não existe fora de uma categoria: "Masters 35+" de Women's
// Physique e "Masters 35+" de Bikini são classes diferentes. Por isso o
// terceiro seletor só passa a valer depois do segundo.
//
// E A LISTA NUNCA PODE ESTAR ESCRITA AQUI. Classe nova entra pela importação
// de um campeonato — uma lista no código só saberia das que existiam no dia
// em que alguém a digitou, e a etapa seguinte traria uma classe que a tela
// não teria como oferecer.
// ==========================================================================

const api = {
  ranking: {
    list: vi.fn(), seasons: vi.fn(), superOverall: vi.fn(),
    teams: vi.fn(), companies: vi.fn(), classes: vi.fn()
  },
  categories: { list: vi.fn() },
  events: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { Ranking } = await import('./publicPages');

const CATEGORIAS = [
  { id: 'cat-wp', code: 'WOMENS_PHYSIQUE', name: "Women's Physique" },
  { id: 'cat-fig', code: 'FIGURE', name: 'Figure' }
];

const CLASSES_DE_WP = [
  { id: 'cl-open', code: 'OPEN', name: 'Open', displayName: 'Open', categoryId: null },
  { id: 'cl-m35', code: 'MASTERS_35', name: 'Masters 35+', displayName: 'Masters 35+', categoryId: 'cat-wp' }
];

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.ranking)) fn.mockReset();
  api.categories.list.mockReset();
  api.ranking.seasons.mockResolvedValue({ items: [{ id: 's1', name: 'Temporada 2026', year: 2026 }] });
  api.ranking.list.mockResolvedValue({ items: [], season: null, publicView: true });
  api.ranking.superOverall.mockResolvedValue([]);
  api.ranking.teams.mockResolvedValue([]);
  api.ranking.companies.mockResolvedValue([]);
  api.ranking.classes.mockResolvedValue({ items: CLASSES_DE_WP });
  api.categories.list.mockResolvedValue({ items: CATEGORIAS });
  api.events.list.mockResolvedValue({ items: [] });
});

afterEach(() => cleanup());

const seletorDeClasse = () => screen.getByLabelText('Classe');

describe('o ranking recorta por classe, e a classe vem do servidor', () => {
  it('o seletor de classe existe e começa desabilitado, sem categoria escolhida', async () => {
    render(<Ranking />);
    await screen.findByLabelText('Categoria');

    const classe = seletorDeClasse();
    // Desabilitado, e não ausente: escondê-lo faria a terceira etapa do
    // filtro aparecer e sumir, e quem não a viu não descobre que ela existe.
    expect(classe.disabled).toBe(true);
    expect(classe.value).toBe('');

    // Sem categoria, nada é pedido ao servidor.
    expect(api.ranking.classes).not.toHaveBeenCalled();
  });

  it('escolher a categoria busca AS CLASSES DAQUELA CATEGORIA e habilita o seletor', async () => {
    render(<Ranking />);
    const categoria = await screen.findByLabelText('Categoria');

    await userEvent.selectOptions(categoria, 'cat-wp');

    await waitFor(() => expect(api.ranking.classes).toHaveBeenCalled());
    // O recorte viaja na chamada: a lista é da categoria, não da organização
    // inteira.
    expect(api.ranking.classes.mock.calls.at(-1)[0]).toMatchObject({ categoryId: 'cat-wp' });

    await waitFor(() => expect(seletorDeClasse().disabled).toBe(false));
  });

  it('as opções mostram o displayName, e nunca o código técnico', async () => {
    render(<Ranking />);
    await userEvent.selectOptions(await screen.findByLabelText('Categoria'), 'cat-wp');

    await waitFor(() => expect(seletorDeClasse().disabled).toBe(false));
    const textos = [...seletorDeClasse().options].map(o => o.textContent);

    expect(textos).toContain('Todas as classes');
    expect(textos).toContain('Masters 35+');
    expect(textos).toContain('Open');
    // MASTERS_35 é identidade técnica. Não é o que se lê numa tela pública.
    expect(textos).not.toContain('MASTERS_35');
  });

  it('escolher a classe recorta o ranking por ela', async () => {
    render(<Ranking />);
    await userEvent.selectOptions(await screen.findByLabelText('Categoria'), 'cat-wp');
    await waitFor(() => expect(seletorDeClasse().disabled).toBe(false));

    await userEvent.selectOptions(seletorDeClasse(), 'cl-m35');

    await waitFor(() => expect(api.ranking.list.mock.calls.at(-1)[0]).toMatchObject({
      categoryId: 'cat-wp', catalogClassId: 'cl-m35'
    }));
  });

  it('trocar de categoria zera a classe — o cruzamento incoerente nem chega a ser pedido', async () => {
    render(<Ranking />);
    const categoria = await screen.findByLabelText('Categoria');

    await userEvent.selectOptions(categoria, 'cat-wp');
    await waitFor(() => expect(seletorDeClasse().disabled).toBe(false));
    await userEvent.selectOptions(seletorDeClasse(), 'cl-m35');
    await waitFor(() => expect(api.ranking.list.mock.calls.at(-1)[0].catalogClassId).toBe('cl-m35'));

    // Masters 35+ é de Women's Physique. Ao trocar para Figure, a classe não
    // pode viajar junto: o servidor recusaria com 422, e o operador veria um
    // erro que ele não causou.
    await userEvent.selectOptions(categoria, 'cat-fig');

    await waitFor(() => expect(api.ranking.list.mock.calls.at(-1)[0]).toMatchObject({ categoryId: 'cat-fig' }));
    expect(api.ranking.list.mock.calls.at(-1)[0].catalogClassId).toBeUndefined();
    expect(seletorDeClasse().value).toBe('');
  });
});

describe('o recorte por classe é do campeonato, e só dele', () => {
  it('nas abas de Super Overall, equipes e empresas o seletor de classe não existe', async () => {
    render(<Ranking />);
    await screen.findByLabelText('Categoria');
    expect(screen.queryByLabelText('Classe')).not.toBeNull();

    // Super Overall, equipes e empresas agregam por outro caminho e não
    // aceitam recorte de classe. Um seletor à vista que não filtra é pior do
    // que seletor nenhum.
    for (const aba of ['Super Overall', 'Equipes', 'Empresas']) {
      await userEvent.click(screen.getByRole('button', { name: new RegExp(aba, 'i') }));
      await waitFor(() => expect(screen.queryByLabelText('Classe')).toBeNull());
    }

    await userEvent.click(screen.getByRole('button', { name: /campeonato/i }));
    await waitFor(() => expect(screen.queryByLabelText('Classe')).not.toBeNull());
  });
});

describe('nenhuma lista de classes está escrita no código da tela', () => {
  it('o arquivo da página não contém código de classe nem de categoria', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Caminho a partir do cwd: no ambiente jsdom `import.meta.url` não é uma
    // URL de arquivo, e `new URL(...)` levanta antes de ler qualquer coisa.
    const fonte = readFileSync(join(process.cwd(), 'src', 'pages', 'publicPages.jsx'), 'utf8');

    // FORA DE COMENTÁRIO. A explicação precisa poder citar os nomes — e é
    // justamente o que um filtro por início de linha não enxerga: o comentário
    // JSX `{/* ... */}` continua nas linhas seguintes sem nenhum prefixo, e a
    // primeira versão deste teste reprovou a própria frase que diz que
    // MASTERS_35 não aparece na tela. Bloco inteiro fora, e depois as de linha.
    const codigo = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(linha => !linha.trim().startsWith('//'))
      .join('\n');

    for (const proibido of ['MASTERS_35', 'OPEN_CLASS_A', 'WOMENS_PHYSIQUE', 'CLASSIC_PHYSIQUE', "'BIKINI'"]) {
      expect(codigo, `${proibido} não pode estar escrito na tela`).not.toContain(proibido);
    }
  });
});

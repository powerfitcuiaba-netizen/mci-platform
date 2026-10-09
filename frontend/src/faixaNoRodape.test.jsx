import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';



// ==========================================================================
// A FAIXA DE PATROCÍNIO NO CASCO — onde ela aparece, e onde NÃO aparece.
//
// O componente em si está medido em `components/faixaDePatrocinio.test.jsx`.
// Aqui a pergunta é outra, e é de produto: a faixa acompanha a VITRINE, e só
// ela. Messenger é conversa de altura cheia; `admin/*` são tabelas de operação
// com coluna de ações grudada. Uma faixa de patrocínio ali comeria altura de
// trabalho de quem opera um campeonato sob pressão.
//
// A condição não é uma segunda lista: é a MESMA bandeira `publico: true` de
// `NAVEGACAO_PRINCIPAL` que decide a guarda de sessão. Marcar uma tela nova
// como pública passa a mostrar a faixa nela, de graça e num lugar só.
//
// E a faixa NÃO depende de sessão: ela aparece para o visitante anônimo e para
// quem está logado, porque patrocínio é exposição, não conteúdo restrito.
// ==========================================================================

const respostas = vi.hoisted(() => ({ user: null }));
// O CATÁLOGO VEM DO BANCO. Esta fixture imita `/public/sponsors`: já ordenada
// pelo servidor, só com quem está ativo, e SEM `logoKey` — a chave de
// armazenamento não sai da API, o que sai é `hasLogo`.
const CATALOGO_MOCK = vi.hoisted(() => ([
  { id: 's1', code: 'MAX-TITANIUM', name: 'Max Titanium', level: 'GLOBAL', sortOrder: 0, active: true, siteUrl: null, hasLogo: true },
  { id: 's2', code: 'CIMERIAN', name: 'Cimerian', level: 'GLOBAL', sortOrder: 1, active: true, siteUrl: null, hasLogo: true },
  { id: 's3', code: 'SOLDIERS', name: 'Soldiers Nutrition', level: 'DIAMANTE', sortOrder: 0, active: true, siteUrl: null, hasLogo: true },
  { id: 's4', code: 'BLACK-SKULL', name: 'Black Skull', level: 'GOLD', sortOrder: 0, active: true, siteUrl: null, hasLogo: true },
  { id: 's5', code: 'TAN-MASTERS', name: 'Tan Masters', level: 'SILVER', sortOrder: 0, active: true, siteUrl: null, hasLogo: true }
]));

vi.mock('./services/api', () => {
  const vazio = { items: [], nextCursor: null };
  const api = {
    auth: {
      me: vi.fn(() => (respostas.user
        ? Promise.resolve({ user: respostas.user })
        : Promise.reject(new Error('sem sessão')))),
      login: vi.fn(), register: vi.fn()
    },
    publicApi: {
      summary: vi.fn(() => Promise.resolve({ events: 0, athletes: 0, proAthletes: 0, publishedResults: 0, openSeasons: 0, upcoming: [] })),
      events: vi.fn(() => Promise.resolve(vazio)),
      event: vi.fn(() => Promise.resolve(null)),
      athletes: vi.fn(() => Promise.resolve(vazio)),
      athlete: vi.fn(() => Promise.resolve({ athlete: null, results: [], titles: 0, rankings: [] })),
      sponsors: vi.fn(() => Promise.resolve({ items: CATALOGO_MOCK }))
    },
    ranking: {
      list: vi.fn(() => Promise.resolve({ items: [], season: null, nextCursor: null, publicView: true, publicLimit: 5 })),
      seasons: vi.fn(() => Promise.resolve(vazio)),
      classes: vi.fn(() => Promise.resolve(vazio)),
      superOverall: vi.fn(() => Promise.resolve(vazio)),
      teams: vi.fn(() => Promise.resolve(vazio)),
      companies: vi.fn(() => Promise.resolve(vazio))
    },
    categories: { list: vi.fn(() => Promise.resolve(vazio)) },
    notifications: { list: vi.fn(() => Promise.resolve({ items: [], unreadCount: 0 })) },
    messenger: { conversations: vi.fn(() => Promise.resolve({ items: [], totalUnread: 0 })) },
    social: { feed: vi.fn(() => Promise.resolve(vazio)), stories: vi.fn(() => Promise.resolve({ items: [] })), me: vi.fn() },
    communities: { list: vi.fn(() => Promise.resolve(vazio)) },
    events: { list: vi.fn(() => Promise.resolve(vazio)) },
    dashboard: {
      admin: vi.fn(() => Promise.resolve({
        events: { active: 0, total: 0 }, athletes: { total: 0, pro: 0 },
        registrations: 0, checkIns: 0, weighIns: 0, batches: 0,
        publishedResults: 0, muscleWarImports: 0, alerts: []
      })),
      athlete: vi.fn(() => Promise.resolve({}))
    },
    search: vi.fn(() => Promise.resolve({ query: '', results: {} })),
    audit: vi.fn(() => Promise.resolve(vazio))
  };
  return {
    default: api, api,
    getAuthToken: () => (respostas.user ? 'token-de-teste' : null),
    setAuthToken: vi.fn(), clearAuthToken: vi.fn(), refreshData: vi.fn(),
    SESSAO_EXPIRADA: 'mci-sessao-expirada',
    fetchMediaObjectUrl: vi.fn(() => Promise.reject(new Error('sem mídia'))),
    releaseMediaObjectUrl: vi.fn(),
    urlDeMidiaPublica: caminho => `http://api.test${caminho}`
  };
});

const { default: App } = await import('./App');

const ADMIN = {
  id: 'u9', name: 'Diretora', email: 'd@mci.test', role: 'SUPER_ADMIN', status: 'ACTIVE',
  organizations: [{ organizationId: 'org1', role: 'EVENT_DIRECTOR', name: 'Federação A', slug: 'fed-a' }]
};

// A abertura da marca roda antes de qualquer rota e esconderia o casco. Marcar
// como vista é o que a própria abertura faz ao terminar.
beforeEach(() => {
  respostas.user = null;
  try { sessionStorage.setItem('mci-abertura-vista', 'true'); } catch { /* sem armazenamento */ }
});
afterEach(cleanup);

const abrir = async rota => {
  window.location.hash = `#/${rota}`;
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector('.shell')).toBeTruthy());
  return container;
};

const PUBLICAS = ['inicio', 'campeonatos', 'atletas', 'ranking'];
const FECHADAS = ['meu-painel', 'messenger', 'admin', 'admin/atletas', 'minha-conta'];

describe('a faixa acompanha a vitrine', () => {
  for (const rota of PUBLICAS) {
    it(`aparece em #/${rota}, sem login`, async () => {
      const container = await abrir(rota);
      await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
    });
  }

  it('aparece também na ficha de um atleta, que é rota pública com id', async () => {
    const container = await abrir('atletas/atl1');
    await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
  });

  it('aparece para quem ESTÁ logado: patrocínio é exposição, não conteúdo restrito', async () => {
    respostas.user = ADMIN;
    const container = await abrir('ranking');
    await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
  });
});

describe('e NÃO invade o resto do sistema', () => {
  for (const rota of FECHADAS) {
    it(`não aparece em #/${rota}`, async () => {
      respostas.user = ADMIN;
      const container = await abrir(rota);
      // Espera o casco assentar antes de afirmar a ausência, senão o teste
      // passaria só por ter olhado cedo demais.
      await waitFor(() => expect(container.querySelector('.topbar')).toBeTruthy());
      expect(container.querySelector('.rodape-patro'),
        `a faixa invadiu #/${rota}`).toBeNull();
    });
  }

  it('não aparece na tela de ENTRADA — lá quem recebe os patrocinadores é a parede', async () => {
    // Render próprio: sem sessão numa rota fechada o casco nem existe, é a
    // tela de acesso que ocupa a página. Esperar por `.shell` aqui esperaria
    // para sempre — e o helper `abrir` espera.
    window.location.hash = '#/meu-painel';
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Entrar/i })).toBeTruthy());

    expect(container.querySelector('.shell'), 'o casco não devia estar aqui').toBeNull();
    expect(container.querySelector('.rodape-patro')).toBeNull();
    // E a parede da entrada continua lá: os patrocinadores não sumiram, eles
    // estão na apresentação que é desta tela.
    expect(container.querySelector('.parede-patro')).toBeTruthy();
  });
});

describe('o layout da vitrine não é invadido', () => {
  it('a faixa é irmã do conteúdo, DEPOIS dele, e não está por cima de nada', async () => {
    const container = await abrir('ranking');
    await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());

    const conteudo = container.querySelector('main');
    const faixa = container.querySelector('.rodape-patro');

    // Em fluxo, e depois do conteúdo na ordem do documento e de tabulação.
    expect(faixa.parentElement).toBe(conteudo.parentElement);
    expect(conteudo.compareDocumentPosition(faixa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Nada de sobreposição: sem posicionamento e sem empilhamento declarados
    // no elemento. Quem cobre modal, menu, dropdown ou toast é quem sai do
    // fluxo — e esta faixa não sai.
    expect(faixa.style.position).toBe('');
    expect(faixa.style.zIndex).toBe('');
  });

  it('o menu, a barra de topo e o conteúdo continuam de pé com a faixa no ar', async () => {
    const container = await abrir('ranking');
    await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
    expect(container.querySelector('nav.sidebar, nav')).toBeTruthy();
    expect(container.querySelector('.topbar')).toBeTruthy();
    expect(container.querySelector('main')).toBeTruthy();
  });

  it('e as marcas que ela mostra são as do catálogo, nenhuma a mais', async () => {
    const container = await abrir('ranking');
    await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
    // Toda arte é servida pela rota de mídia, por ID de patrocinador — nunca
    // por caminho de arquivo, e nunca por um id que não esteja no catálogo.
    const ids = new Set(CATALOGO_MOCK.map(p => p.id));
    const imagens = [...container.querySelectorAll('.rodape-patro img')];
    expect(imagens.length, 'a faixa não desenhou nenhuma arte').toBeGreaterThan(0);
    for (const img of imagens) {
      const src = img.getAttribute('src');
      const achado = /\/media\/sponsors\/([^/]+)\/logo$/.exec(src);
      expect(achado, `${src} não é a rota de logo do catálogo`).toBeTruthy();
      expect(ids.has(achado[1]), `${achado[1]} não está no catálogo`).toBe(true);
    }
  });
});

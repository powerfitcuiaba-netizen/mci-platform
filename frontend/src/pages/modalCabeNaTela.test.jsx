import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O cwd do Vitest é `frontend/`; `import.meta.url` não chega como file:// sob
// o transform, então a leitura é por caminho relativo à raiz do pacote.
const ler = caminho => readFileSync(resolve('src', caminho), 'utf8');

// ==========================================================================
// O DIÁLOGO PRECISA CABER NA TELA — E O RODAPÉ É O QUE SOME PRIMEIRO.
//
// Medido num Chromium real, com a revisão do Ipiranga (191 linhas), ANTES
// desta correção:
//
//   1366x768 .. rodapé em [776..833]  →  65px fora da viewport
//   1280x720 .. rodapé em [776..833]  → 113px fora
//    390x844 .. rodapé em [1002..1115] → 271px fora
//
// O operador não conseguia alcançar "Aplicar" sem rolar dentro do diálogo, e
// o cabeçalho sumia junto. A causa eram três coisas somadas: o modal inteiro
// rolava como uma caixa só, a tabela carregava 340px FIXOS de altura, e não
// havia teto de viewport na largura.
//
// jsdom não calcula layout, então este arquivo NÃO mede pixels: ele tranca o
// CONTRATO de CSS que a medição provou correto. A medição em navegador vive
// em `scripts/qa/modal-na-viewport.mjs` e é executável sob demanda.
// ==========================================================================

const css = ler('styles.css');

const regra = seletor => {
  const i = css.indexOf(`\n${seletor} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};

// `regra` acha o seletor só quando ele abre a linha exatamente como escrito.
// Para os recortes com combinador (`.tabela-em-modal .table td:nth-child(3)`)
// vale a pena procurar pelo seletor escapado, fora de qualquer @media.
const corpoDe = seletor => {
  const escapado = seletor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const achado = new RegExp(`(?:^|\\})\\s*${escapado}\\s*\\{([^{}]*)\\}`, 'm').exec(css);
  return achado ? achado[1] : null;
};

// Recorta o conteúdo de um `@media (...)`, com um nível de aninhamento.
const dentroDaMedia = condicao => {
  const escapado = condicao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const achado = new RegExp(`@media\\s*${escapado}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*)`, 'm').exec(css);
  return achado ? achado[1] : null;
};

describe('o diálogo cabe na viewport', () => {
  // O CONTRATO MUDOU, E FICOU MAIS FORTE.
  //
  // Até aqui o teto era `min(80vh, 80dvh)`: um número escolhido à mão, três
  // vezes (92, depois 88, depois 80), sempre pelo mesmo motivo — o rodapé
  // saindo da tela. Escolher 80 não garantia nada; garantia que naquele
  // conteúdo, naquele idioma e naquele zoom o rodapé tinha cabido.
  //
  // Agora quem define o espaço é a CAMADA, e o diálogo ocupa o que ela deixa:
  // `max-height: 100%` resolve contra a área de grade, que já é a viewport
  // menos o padding da camada. Muda o padding numa faixa de tela e a conta
  // acompanha sozinha. Não há mais número a escolher.
  it('o diálogo ocupa o espaço que a camada deixa, sem número escolhido à mão', () => {
    const modal = regra('.modal');
    // DOIS tetos, e o menor vence: `100%` é a área de grade da camada — a
    // conta certa; `100dvh` é o cinto para o dia em que a camada voltar a
    // ficar presa a um ancestral com `transform`, quando o `%` passa a mentir.
    expect(modal, 'sem max-height o diálogo cresce com o conteúdo').toMatch(/max-height:\s*min\(100%,\s*calc\(100dvh/);
    expect(modal, 'o teto em unidade de viewport é o que sobrevive a um ancestral transformado').toMatch(/dvh/);
    expect(modal, 'sem max-width o diálogo passa da largura da tela').toMatch(/max-width:\s*96vw/);
    // `dvh` acompanha a barra de endereço do celular que aparece e some; `vh`
    // sozinho mede a tela com a barra recolhida e joga o rodapé para baixo dela.
    expect(regra('.modal-layer'), 'a camada precisa medir a viewport dinâmica').toMatch(/max-height:\s*100dvh/);
  });

  it('o diálogo NÃO é o contêiner de rolagem — quem rola é o corpo', () => {
    // Enquanto o diálogo inteiro rolava, a altura do miolo era o que sobrava
    // de um cabeçalho e um rodapé medidos à mão. Separando as faixas, o miolo
    // passa a ser calculado pelo navegador, não anotado por alguém.
    expect(regra('.modal'), 'o diálogo não pode rolar').toMatch(/overflow:\s*hidden/);
    expect(regra('.modal'), 'as três faixas exigem coluna flex').toMatch(/flex-direction:\s*column/);
    // `hidden auto`: vertical rola, horizontal não — é o que impede uma tabela
    // larga de empurrar o diálogo para fora da viewport lateralmente.
    expect(regra('.modal-body'), 'o corpo é quem rola').toMatch(/overflow:\s*hidden auto/);
    // Sem `min-height: 0` o flex não deixa o item encolher abaixo do conteúdo,
    // e o miolo volta a empurrar o rodapé para fora. É a linha que sustenta
    // tudo o que este arquivo protege.
    expect(regra('.modal-body'), 'sem min-height:0 o rodapé sai da tela').toMatch(/min-height:\s*0/);
  });

  it('cabeçalho e rodapé não rolam com o conteúdo', () => {
    // O cabeçalho deixou de ser `sticky`: virou faixa própria do flex, que é
    // mais forte — `sticky` só não rola enquanto a âncora segura; `flex: 0 0
    // auto` está fora da área de rolagem e não rola nunca.
    expect(regra('.modal-head'), 'cabeçalho precisa ser faixa fixa do flex').toMatch(/flex:\s*0 0 auto/);
    // O rodapé continua `sticky`, agora ancorado ao corpo: ele nasce dentro do
    // `<form>` de cada tela, aninhado, e não há como içá-lo para fora sem
    // mudar as 73 chamadas do diálogo.
    expect(regra('.modal-actions'), 'rodapé precisa ser sticky').toMatch(/position:\s*sticky/);
    // Fundo opaco: sem ele o conteúdo passa por baixo e fica ilegível.
    expect(regra('.modal-head')).toMatch(/background:\s*var\(--superficie-3\)/);
    expect(regra('.modal-actions')).toMatch(/background:\s*var\(--superficie-3\)/);
  });

  it('a tabela do diálogo tem altura proporcional à tela, nunca um número fixo', () => {
    const tabela = regra('.tabela-em-modal');
    expect(tabela).toMatch(/max-height:\s*min\([^)]*dvh[^)]*\)/);
    expect(tabela).toMatch(/overflow:\s*auto/);
  });

  // A REGRESSÃO QUE ESTA CORREÇÃO EXISTE PARA IMPEDIR QUE VOLTE.
  it('nenhuma faixa de tela reintroduz um custo do resto medido à mão', () => {
    // Eram cinco: 450, 566, 292, 345 e 620 pixels, um por viewport, cada um
    // válido só para o conteúdo e o idioma em que foi medido. Em inglês e
    // espanhol os rótulos são mais longos, o cabeçalho cresce, e a conta
    // passava a cortar exatamente o que deveria proteger.
    const declaracoes = css.match(/--custo-do-resto\s*:/g) || [];
    expect(declaracoes, 'o número medido à mão voltou ao CSS').toHaveLength(0);
  });

  it('nenhuma tabela de diálogo voltou a usar altura fixa em pixels', () => {
    const pagina = ler('pages/adminPlatform.jsx');
    // Era exatamente esta a forma do defeito: `style={{ maxHeight: 340 }}`.
    expect(pagina, 'altura fixa inline voltou ao diálogo').not.toMatch(/maxHeight:\s*\d+/);
  });

  // O QUE O PORTAL GARANTE, E POR QUE ELE É OBRIGATÓRIO.
  it('o diálogo é montado no body, fora da árvore da página', () => {
    const fonte = ler('components/ui.jsx');
    // `position: fixed` só mede a viewport enquanto NENHUM ancestral tiver
    // `transform`, `filter`, `perspective`, `contain` ou `will-change`. Medido
    // na aplicação real: `.page` carrega `transform: matrix(1,0,0,1,0,0)` —
    // identidade, sem efeito visual — e isso bastava para a camada medir
    // 390x442 em vez de 390x844.
    expect(fonte, 'sem portal a camada volta a ficar presa a um ancestral transformado').toMatch(/createPortal\(/);
    expect(fonte, 'o destino precisa ser o body').toMatch(/document\.body/);
  });

  it('a camada do diálogo prende a rolagem', () => {
    expect(regra('.modal-layer')).toMatch(/overflow:\s*hidden/);
  });

  it('o diálogo largo para em 1280px e nunca passa de 90vw', () => {
    // `min(100%, 1100px)` com `max-width: 96vw` fazia o diálogo encostar quase
    // nas bordas em telas médias: em 1280 sobravam 26px de cada lado, e a
    // revisão parecia uma página, não um diálogo. `90vw` reserva 5% de cada
    // lado em QUALQUER largura, que é o que garante a moldura no notebook
    // estreito sem encolher o diálogo no monitor grande.
    const achado = /width:\s*min\(\s*(\d+)px\s*,\s*(\d+)vw\s*\)/.exec(regra('.modal-wide'));
    expect(achado, '.modal-wide não declara min(Xpx, Yvw)').not.toBeNull();
    expect(Number(achado[1]), 'teto de 1280px').toBeLessThanOrEqual(1280);
    expect(Number(achado[2]), 'nunca ocupar a tela inteira').toBeLessThanOrEqual(90);
  });
});

// ==========================================================================
// O SEGUNDO DEFEITO, QUE A MEDIÇÃO DE CAIXA SOZINHA NÃO PEGAVA.
//
// O modal cabia — e a tabela, não. Ela era mais larga que a área útil do
// diálogo, e a coluna de AÇÃO ("Vincular") ficava fora em TODA viewport,
// alcançável só arrastando a tabela de lado. Medido no mesmo Chromium:
//
//   1920x1080 .. área útil 1128px .. tabela 1254px  → 126px de ação escondida
//
// A prova de pixel deste contrato está em `scripts/qa/modal-na-viewport.mjs`,
// que reprova as quatro viewports de 1280 para cima se ele for desfeito.
// ==========================================================================
describe('as onze colunas cabem, e quem rola de lado é a tabela', () => {
  it('.table-wrap é o contêiner que rola na horizontal', () => {
    expect(regra('.table-wrap')).toMatch(/overflow-x:\s*auto/);
  });

  it('a tabela do diálogo tem régua mínima, e ela não passa da área útil', () => {
    const achado = /min-width:\s*(\d+)px/.exec(corpoDe('.tabela-em-modal .table'));
    expect(achado, 'sem régua o navegador espreme as 11 colunas até o texto virar três linhas').not.toBeNull();
    expect(Number(achado[1])).toBeGreaterThanOrEqual(1000);
    // Passar disto devolve o defeito: a ação da linha sai do diálogo no desktop.
    expect(Number(achado[1])).toBeLessThanOrEqual(1180 - 48);
  });

  it('o cabeçalho dentro do diálogo pode quebrar em duas linhas', () => {
    // "Pts arquivo" numa linha só reservava 104px de largura que as 191 linhas
    // pagavam. O cabeçalho aparece uma vez; as linhas, 191.
    expect(corpoDe('.tabela-em-modal .table th')).toMatch(/white-space:\s*normal/);
  });

  it('nome, classe e situação têm piso E teto de largura', () => {
    // O teto é o que impede um dado mais comprido que o do teste de esticar a
    // coluna e empurrar a ação da linha para fora do diálogo.
    for (const coluna of [3, 7, 10]) {
      const corpo = corpoDe(`.tabela-em-modal .table td:nth-child(${coluna})`);
      expect(corpo, `coluna ${coluna} sem regra de largura`).not.toBeNull();
      expect(corpo).toMatch(/min-width:\s*\d+px/);
      expect(corpo).toMatch(/max-width:\s*\d+px/);
    }
  });

  it('nenhuma célula do diálogo usa -webkit-line-clamp', () => {
    // Tentativa descartada: `display: -webkit-box` briga com o layout de
    // tabela, a altura da linha continua vindo da célula mais alta, e a
    // terceira linha aparecia pela metade — cortada no meio da palavra, sem
    // reticências. Dar largura resolve sem esconder nada.
    for (const trecho of css.match(/\.tabela-em-modal[^{}]*\{[^{}]*\}/g) || []) {
      expect(trecho).not.toMatch(/-webkit-line-clamp/);
    }
  });
});

describe('o resumo de sete métricas muda de forma por viewport, e só por ela', () => {
  it('no desktop as sete ficam em UMA linha', () => {
    const cards = regra('.import-summary');
    expect(cards).toMatch(/grid-template-columns:\s*repeat\(\s*7\s*,/);
    // `auto-fit` com piso de 132px produzia de 4 a 7 colunas conforme a
    // largura, então a mesma tela mudava de forma sem motivo e o operador
    // reaprendia onde cada número ficava. Sete declaradas dão leitura estável.
    expect(cards).not.toMatch(/auto-fit|auto-fill/);
  });

  it('no tablet são 4 + 3', () => {
    expect(dentroDaMedia('(max-width: 1100px)')).toMatch(/\.import-summary\s*\{[^{}]*repeat\(\s*4\s*,/);
  });

  it('no celular são 2 colunas', () => {
    expect(dentroDaMedia('(max-width: 560px)')).toMatch(/\.import-summary\s*\{[^{}]*repeat\(\s*2\s*,/);
  });
});

describe('a nomenclatura visível é MuscleWare', () => {
  // ESTE TESTE MUDOU DE LUGAR PORQUE O TEXTO MUDOU DE LUGAR.
  //
  // Ele procurava a grafia oficial dentro das TELAS. Com a interface passando
  // pelo dicionário, o texto visível não mora mais lá — e um teste que
  // continuasse olhando o componente encontraria só `t('plataforma.muscleWare')`,
  // aprovando qualquer grafia que estivesse do outro lado da chave.
  //
  // Olhar o dicionário é mais forte do que era antes: cobre os TRÊS idiomas.
  // O nome do produto não se traduz, e agora isso é medido em português,
  // inglês e espanhol de uma vez.
  const DICIONARIOS = ['lib/idiomas/ptBR.js', 'lib/idiomas/en.js', 'lib/idiomas/es.js'];

  it.each(DICIONARIOS)('%s traz a grafia oficial do produto', arquivo => {
    const fonte = ler(arquivo);
    expect(fonte).toMatch(/'plataforma\.muscleWare': 'MuscleWare'/);
    // Em inglês o nome do produto não fica no fim da frase ("Import
    // MuscleWare results"), e é exatamente por isso que a conferência é pela
    // PRESENÇA do nome, e não pela posição dele.
    expect(fonte).toMatch(/'plataforma\.importarResultados': '[^']*MuscleWare[^']*'/);
  });

  it('a navegação continua trazendo a grafia oficial', () => {
    expect(ler('lib/idiomas/ptBR.js')).toMatch(/'nav\.admin\/musclewar': 'MuscleWare'/);
  });

  it('nenhum texto de interface usa a grafia antiga', () => {
    // Identificador (`AdminMuscleWar`) e rota (`admin/musclewar`) são contrato
    // técnico e permanecem, por instrução explícita — por isso a busca é só
    // nos dicionários, onde só mora texto visível.
    for (const arquivo of DICIONARIOS) {
      const antiga = ler(arquivo).match(/MuscleWar(?!e)/g);
      expect(antiga, `grafia antiga em ${arquivo}`).toBeNull();
    }
  });
});

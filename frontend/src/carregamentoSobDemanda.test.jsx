import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// O PRIMEIRO CARREGAMENTO NÃO CARREGA A ADMINISTRAÇÃO.
//
// Antes deste guarda, `App.jsx` importava de forma ansiosa as 22 telas de
// operação. O pacote de produção saía num bloco único de 892,55 kB (229,40 kB
// comprimido), e quem só queria ver a vitrine baixava tudo antes da primeira
// pintura. Depois do corte: 674,17 kB (189,52 kB comprimido) mais treze blocos
// que só descem quando a tela é aberta.
//
// O defeito é fácil de reintroduzir sem perceber: basta alguém precisar de um
// componente de `adminPlatform` e escrever `import { X } from './pages/...'` no
// topo. O pacote volta a inchar em silêncio — nenhum teste falha, nenhuma tela
// quebra, e só um build comparado com o anterior denunciaria. Este arquivo é
// esse build comparado, em forma de asserção.
//
// A conferência é no CÓDIGO-FONTE de propósito. Medir o pacote exigiria rodar
// o empacotador dentro do teste, o que o tornaria lento e dependente da
// ferramenta; e o que se quer travar é a DECISÃO — "estas telas entram sob
// demanda" —, que mora no import.
// ============================================================================

const aqui = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(aqui, 'App.jsx'), 'utf8');

// Os módulos que NÃO pertencem ao primeiro carregamento. `treinadores` entra na
// lista pelo mesmo motivo que os `admin*`: é tela de quem treina, e a maioria
// de quem abre a plataforma não treina ninguém.
const SOB_DEMANDA = [
  'pages/adminEvent',
  'pages/adminResults',
  'pages/adminPlatform',
  'pages/adminOverall',
  'pages/adminLancamentos',
  'pages/adminSolicitacoes',
  'pages/adminAtletas',
  'pages/adminAtleta',
  'pages/adminMensagens',
  'pages/treinadores'
];

// Os que DEVEM continuar ansiosos: são o caminho quente. Adiá-los trocaria
// bytes por espera onde mais gente passa.
const ANSIOSOS = [
  'pages/authPages',
  'pages/publicPages',
  'pages/mePages'
];

const importaEstaticamente = modulo => {
  // `import ... from './pages/x'` — a forma estática. Um `import('./pages/x')`
  // dentro de uma seta NÃO casa, que é exatamente a distinção que importa.
  const padrao = new RegExp(`^\\s*import\\s[^\\n]*from\\s+['"]\\./${modulo}['"]`, 'm');
  return padrao.test(APP);
};

describe('o primeiro carregamento não traz as telas de operação', () => {
  it.each(SOB_DEMANDA)('%s entra sob demanda, e não no topo', modulo => {
    expect(
      importaEstaticamente(modulo),
      `'${modulo}' voltou a ser importado de forma estática em App.jsx. `
      + 'Isso devolve o módulo ao bloco inicial e desfaz o corte: use '
      + '`sob(() => import(...), \'Nome\')`, como as outras telas de operação.'
    ).toBe(false);
  });

  it.each(SOB_DEMANDA)('%s é alcançado por import() dinâmico', modulo => {
    expect(
      APP.includes(`import('./${modulo}')`),
      `'${modulo}' não aparece em nenhum import() dinâmico de App.jsx. `
      + 'Se a tela foi removida, tire-a desta lista; se foi renomeada, '
      + 'atualize o caminho aqui junto.'
    ).toBe(true);
  });

  it.each(ANSIOSOS)('%s continua no primeiro carregamento, de propósito', modulo => {
    expect(
      importaEstaticamente(modulo),
      `'${modulo}' é caminho quente e deixou de ser importado no topo. `
      + 'Adiá-lo troca bytes por espera onde mais gente passa.'
    ).toBe(true);
  });

  it('a espera pelo bloco tem esqueleto, e não tela branca', () => {
    expect(APP).toMatch(/<Suspense\s+fallback=\{<Skeleton/);
  });

  it('o limite de erro envolve a suspensão — falha ao baixar bloco é erro de tela', () => {
    // A ordem importa: <LimiteDeErro><Suspense>…</Suspense></LimiteDeErro>.
    // Invertida, uma falha de rede ao buscar o bloco derrubaria o casco inteiro
    // em vez de só a área de conteúdo.
    const trecho = APP.slice(APP.indexOf('<main>'), APP.indexOf('</main>') + 7);
    expect(trecho.indexOf('<LimiteDeErro')).toBeGreaterThan(-1);
    expect(trecho.indexOf('<Suspense')).toBeGreaterThan(trecho.indexOf('<LimiteDeErro'));
  });
});

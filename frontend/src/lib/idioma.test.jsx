import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ProvedorDeIdioma, useIdioma, traduzir, idiomaPreferido,
  IDIOMAS, IDIOMA_PADRAO, CHAVES, chavesDoIdioma
} from './idioma';
import SeletorDeIdioma from '../components/seletorDeIdioma';
import {
  estadoDaImportacao, estadoDeMatch, criterioDeMatch, papel, estadoDaEntrada,
  definirIdiomaDosRotulos, ESTADO_DA_IMPORTACAO, ESTADO_MATCH, PAPEL
} from './format';

// ============================================================================
// O IDIOMA TROCA O TEXTO, E SÓ O TEXTO.
//
// A garantia que este arquivo existe para dar não é "a tradução está bonita" —
// é que trocar de idioma NÃO alcança nada além do que a pessoa lê. Código de
// enum, código de categoria, identificador externo, chave de idempotência e
// pontuação continuam byte a byte os mesmos em português, inglês e espanhol.
//
// É a diferença entre uma camada de apresentação e uma regressão silenciosa:
// se `MATCH_PENDING` virasse "Pending linkage" no banco, a idempotência do
// importador passaria a depender do idioma de quem clicou.
// ============================================================================

function Sonda() {
  const { idioma, t } = useIdioma();
  return (
    <div>
      <span data-testid="idioma">{idioma}</span>
      <span data-testid="inicio">{t('nav.inicio')}</span>
      <span data-testid="pendente">{t('vinculo.pendente')}</span>
      <span data-testid="resumo">{t('importacao.resumo', { n: 191 })}</span>
    </div>
  );
}

const montar = inicial => render(
  <ProvedorDeIdioma inicial={inicial}><SeletorDeIdioma /><Sonda /></ProvedorDeIdioma>
);

const clicar = nome => fireEvent.click(screen.getByRole('button', { name: nome }));

beforeEach(() => {
  try { globalThis.localStorage?.clear(); } catch { /* aba sem armazenamento */ }
  definirIdiomaDosRotulos(IDIOMA_PADRAO);
});
afterEach(() => { cleanup(); definirIdiomaDosRotulos(IDIOMA_PADRAO); });

describe('o idioma começa em português', () => {
  it('sem preferência guardada, o padrão é pt-BR', () => {
    expect(IDIOMA_PADRAO).toBe('pt-BR');
    expect(idiomaPreferido()).toBe('pt-BR');
    montar();
    expect(screen.getByTestId('idioma').textContent).toBe('pt-BR');
    expect(screen.getByTestId('inicio').textContent).toBe('Início');
  });

  it('as três bandeiras estão disponíveis, e só as três', () => {
    montar();
    expect(IDIOMAS.map(i => i.codigo)).toEqual(['pt-BR', 'en', 'es']);
    for (const idioma of IDIOMAS) {
      const botao = screen.getByRole('button', { name: idioma.nome });
      expect(botao).toBeTruthy();
      // A bandeira é decorativa: quem informa é o nome, no `aria-label`.
      expect(botao.querySelector('[aria-hidden="true"]').textContent).toBe(idioma.bandeira);
    }
  });

  it('o idioma em vigor é anunciado por aria-pressed, e não só por cor', () => {
    montar();
    expect(screen.getByRole('button', { name: 'Português' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Español' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('trocar de idioma, e voltar', () => {
  it('pt-BR → en → es → pt-BR, sem recarregar e sem sair da sessão', () => {
    montar();
    expect(screen.getByTestId('inicio').textContent).toBe('Início');

    clicar('English');
    expect(screen.getByTestId('idioma').textContent).toBe('en');
    expect(screen.getByTestId('inicio').textContent).toBe('Home');
    expect(screen.getByTestId('pendente').textContent).toBe('Pending linkage');

    clicar('Español');
    expect(screen.getByTestId('idioma').textContent).toBe('es');
    expect(screen.getByTestId('inicio').textContent).toBe('Inicio');
    expect(screen.getByTestId('pendente').textContent).toBe('Pendiente de vinculación');

    clicar('Português');
    expect(screen.getByTestId('idioma').textContent).toBe('pt-BR');
    expect(screen.getByTestId('inicio').textContent).toBe('Início');
    expect(screen.getByTestId('pendente').textContent).toBe('Pendente de vínculo');
  });

  it('a preferência sobrevive a uma nova montagem — é o que "recarregar" significa aqui', () => {
    montar();
    clicar('Español');
    expect(idiomaPreferido()).toBe('es');

    cleanup();
    // Montar de novo é o equivalente, em teste de componente, a abrir a página
    // outra vez: nenhum estado de React atravessa, só o que foi guardado.
    render(<ProvedorDeIdioma><Sonda /></ProvedorDeIdioma>);
    expect(screen.getByTestId('idioma').textContent).toBe('es');
    expect(screen.getByTestId('inicio').textContent).toBe('Inicio');
  });

  it('o atributo lang do documento acompanha — quem ouve a tela também troca', () => {
    montar();
    expect(document.documentElement.lang).toBe('pt-BR');
    clicar('English');
    expect(document.documentElement.lang).toBe('en');
    clicar('Español');
    expect(document.documentElement.lang).toBe('es');
  });

  it('idioma desconhecido não é aceito, venha de onde vier', () => {
    try { globalThis.localStorage.setItem('mci.idioma', 'klingon'); } catch { /* sem armazenamento */ }
    expect(idiomaPreferido()).toBe('pt-BR');
    montar('tlh');
    expect(screen.getByTestId('idioma').textContent).toBe('pt-BR');
  });
});

describe('os três dicionários cobrem as mesmas chaves', () => {
  it('nenhuma chave existe em um idioma e falta no outro', () => {
    // A COMPARAÇÃO É DE CHAVES, NÃO DE TEXTOS.
    //
    // A primeira versão deste teste exigia que a tradução fosse DIFERENTE do
    // português, e acusou sete entradas: "Campeonatos", "Resultados",
    // "Filtrar", "Confirmar" e afins coincidem de verdade entre português e
    // espanhol. Manter aquela regra exigiria uma lista de exceções que cresce
    // até ninguém mais lê-la — e uma lista que ninguém lê deixa passar a
    // tradução realmente esquecida, que é o que o teste deveria pegar.
    //
    // O invariante que importa é o conjunto de chaves: se uma entrada existe
    // em português e não existe em inglês, a tela cai no recuo e mostra
    // português no meio do inglês.
    const emPortugues = [...chavesDoIdioma('pt-BR')].sort();
    for (const codigo of ['en', 'es']) {
      const doIdioma = [...chavesDoIdioma(codigo)].sort();
      expect(doIdioma, `o dicionário de ${codigo} diverge do de pt-BR`).toEqual(emPortugues);
    }
    expect(CHAVES.length).toBe(emPortugues.length);
  });

  it('nenhuma tradução ficou vazia', () => {
    for (const codigo of ['pt-BR', 'en', 'es']) {
      const vazias = chavesDoIdioma(codigo).filter(chave => !String(traduzir(codigo, chave)).trim());
      expect(vazias, `chaves vazias em ${codigo}`).toEqual([]);
    }
  });

  it('a interpolação funciona nos três, e o número vem de fora', () => {
    for (const codigo of ['pt-BR', 'en', 'es']) {
      const texto = traduzir(codigo, 'importacao.resumo', { n: 191 });
      expect(texto, codigo).toContain('191');
      expect(texto, `${codigo} não pode ter marcador solto`).not.toContain('{n}');
    }
    // E o número NÃO está escrito no dicionário: ele vem do backend.
    expect(traduzir('pt-BR', 'importacao.resumo')).toContain('{n}');
  });

  it('chave inexistente devolve a própria chave, e não espaço em branco', () => {
    expect(traduzir('en', 'chave.que.nao.existe')).toBe('chave.que.nao.existe');
  });
});

describe('o idioma NÃO alcança dado nem código interno', () => {
  it('os códigos de enum são os mesmos nos três idiomas', () => {
    const codigos = () => [...Object.keys(ESTADO_DA_IMPORTACAO), ...Object.keys(PAPEL)];
    const emPortugues = codigos();
    for (const codigo of ['en', 'es']) {
      definirIdiomaDosRotulos(codigo);
      expect(codigos(), `os códigos mudaram em ${codigo}`).toEqual(emPortugues);
    }
  });

  it('o RÓTULO traduz, o TOM não — tom é semântica, não texto', () => {
    definirIdiomaDosRotulos('pt-BR');
    const pt = estadoDaImportacao('APPLIED');
    definirIdiomaDosRotulos('en');
    const en = estadoDaImportacao('APPLIED');
    definirIdiomaDosRotulos('es');
    const es = estadoDaImportacao('APPLIED');

    expect(pt.rotulo).toBe('Aplicado');
    expect(en.rotulo).toBe('Applied');
    expect(es.rotulo).toBe('Aplicada');
    // O tom vira COR na tela. Traduzir a cor seria traduzir a informação.
    expect(en.tom).toBe(pt.tom);
    expect(es.tom).toBe(pt.tom);
  });

  it('os estados da REVISÃO traduzem sem que o código mude', () => {
    // O português aqui NÃO é "Pendente de vínculo": o produto escolheu "Não
    // identificado", com a justificativa escrita no próprio mapa ("Pendente"
    // não dizia o que estava pendente). A tradução espelha a escolha em vez de
    // reintroduzir pela porta dos fundos o termo que foi abandonado.
    const esperado = {
      'pt-BR': { MATCH_PENDING: 'Não identificado', CONFLICT: 'Conflito', MATCHED: 'Reconhecido' },
      en: { MATCH_PENDING: 'Not identified', CONFLICT: 'Conflict', MATCHED: 'Recognized' },
      es: { MATCH_PENDING: 'No identificado', CONFLICT: 'Conflicto', MATCHED: 'Reconocido' }
    };
    for (const [codigo, mapa] of Object.entries(esperado)) {
      definirIdiomaDosRotulos(codigo);
      for (const [enumCru, rotuloEsperado] of Object.entries(mapa)) {
        expect(estadoDeMatch(enumCru).rotulo, `${enumCru} em ${codigo}`).toBe(rotuloEsperado);
        // O CÓDIGO no mapa não mudou — só o texto que sai pela função.
        expect(Object.keys(ESTADO_MATCH)).toContain(enumCru);
      }
    }
  });

  it('o critério que reconheceu a linha também traduz', () => {
    const esperado = {
      'pt-BR': 'filiação + matrícula',
      en: 'affiliation + member number',
      es: 'afiliación + matrícula'
    };
    for (const [codigo, texto] of Object.entries(esperado)) {
      definirIdiomaDosRotulos(codigo);
      expect(criterioDeMatch('AFFILIATION_NUMBER'), codigo).toBe(texto);
      // CPF é sigla oficial brasileira: não se traduz em idioma nenhum.
      expect(criterioDeMatch('CPF'), codigo).toBe('CPF');
    }
  });

  it('APPLIED significa coisas diferentes em dois mapas, e cada um traduz o seu', () => {
    // A prova de que a tradução é por MAPA: o mesmo código, dois mapas, e o
    // espanhol difere em gênero porque "importación" e "resultado" diferem.
    definirIdiomaDosRotulos('es');
    expect(estadoDaImportacao('APPLIED').rotulo).toBe('Aplicada');
    definirIdiomaDosRotulos('pt-BR');
    expect(estadoDaImportacao('APPLIED').rotulo).toBe('Aplicado');
  });

  it('enum desconhecido devolve o CÓDIGO em qualquer idioma — nunca branco', () => {
    for (const codigo of ['pt-BR', 'en', 'es']) {
      definirIdiomaDosRotulos(codigo);
      expect(estadoDaEntrada('ESTADO_QUE_AINDA_NAO_EXISTE').rotulo).toBe('ESTADO_QUE_AINDA_NAO_EXISTE');
      expect(papel('PAPEL_NOVO').rotulo).toBe('PAPEL_NOVO');
    }
  });
});

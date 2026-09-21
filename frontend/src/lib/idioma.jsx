import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { definirIdiomaDosRotulos } from './format';
import ptBR from './idiomas/ptBR';
import en from './idiomas/en';
import es from './idiomas/es';

// ============================================================================
// IDIOMA DA INTERFACE — pt-BR, en, es.
//
// O QUE ESTA CAMADA É, E O QUE ELA NUNCA PODE SER
//
// É camada de APRESENTAÇÃO. Traduz o que a pessoa lê, e nada além disso.
// Nenhum código interno muda de idioma: `MATCH_PENDING` continua
// `MATCH_PENDING` no banco, na API e na chave de idempotência; `categoryCode`,
// `externalResultId`, `identityKey` e `sourceKey` continuam byte a byte os
// mesmos. Trocar de idioma não pode alterar um ponto de ranking, uma
// colocação, um vínculo ou uma política — e há teste cobrando exatamente isso.
//
// DADO OFICIAL NÃO É RÓTULO. O nome de um campeonato, de uma federação, de uma
// atleta, de uma equipe e de uma classe vêm do banco e saem como estão. O que
// se traduz é o RÓTULO da interface em volta deles: "Ranking Geral", "Pendente
// de vínculo", "Aplicar". Traduzir "Women's Bikini" seria reescrever o
// regulamento pela porta dos fundos.
//
// POR QUE UM DICIONÁRIO, E NÃO CONDICIONAL ESPALHADA
//
// `if (idioma === 'en')` no meio da tela é a forma mais barata de começar e a
// mais cara de manter: a tradução fica espalhada por onde o texto aparece, e o
// terceiro idioma exige visitar tudo de novo. Aqui a chave é o contrato e as
// três traduções ficam lado a lado — ver uma faltando é ver uma linha curta.
//
// SEM DEPENDÊNCIA NOVA. Uma biblioteca de i18n resolveria plural, gênero e
// formatação de data por idioma. Nada disso é necessário aqui ainda: o que
// existe é substituição de texto com interpolação simples, e `Intl`, que já
// vem no runtime, cuida de data e número. Trazer um pacote para isto seria
// peso sem contrapartida.
// ============================================================================

export const IDIOMAS = Object.freeze([
  { codigo: 'pt-BR', bandeira: '🇧🇷', nome: 'Português', curto: 'PT' },
  { codigo: 'en', bandeira: '🇺🇸', nome: 'English', curto: 'EN' },
  { codigo: 'es', bandeira: '🇪🇸', nome: 'Español', curto: 'ES' }
]);

export const IDIOMA_PADRAO = 'pt-BR';

const CHAVE_DE_PREFERENCIA = 'mci.idioma';

// OS TRÊS DICIONÁRIOS MORAM EM ARQUIVOS PRÓPRIOS.
//
// Ficaram juntos enquanto eram cem chaves. Passaram de mil, e um arquivo único
// deixou de caber na cabeça de quem revisa: para conferir uma tradução era
// preciso rolar por duas outras. Separados, a revisão de um idioma é a leitura
// de um arquivo, e o `diff` de uma tradução nova não carrega as outras duas.
//
// A paridade entre eles não depende de disciplina: `idioma.test.jsx` reprova
// chave que exista num idioma e falte noutro, e tradução vazia.
const DICIONARIO = {
  'pt-BR': ptBR,
  en,
  es
};

export const CHAVES = Object.freeze(Object.keys(DICIONARIO[IDIOMA_PADRAO]));

/**
 * As chaves que um idioma declara.
 *
 * Serve ao teste que compara os três dicionários. A comparação é de CHAVES, e
 * não de textos: português e espanhol são línguas irmãs, e "Campeonatos",
 * "Resultados", "Filtrar" e "Confirmar" coincidem de verdade em muitas
 * entradas. Exigir texto diferente transformaria coincidência legítima em
 * falha, e a lista de exceções cresceria até ninguém mais lê-la.
 */
export const chavesDoIdioma = codigo => Object.keys(DICIONARIO[codigo] ?? {});

const ehIdiomaConhecido = codigo => IDIOMAS.some(i => i.codigo === codigo);

/**
 * Preferência guardada. O armazenamento do navegador pode lançar — aba
 * anônima, dado do site bloqueado —, e um idioma é conveniência: falhar em
 * lê-lo NÃO pode impedir a tela de abrir.
 */
export function idiomaPreferido() {
  try {
    const guardado = globalThis.localStorage?.getItem(CHAVE_DE_PREFERENCIA);
    return ehIdiomaConhecido(guardado) ? guardado : IDIOMA_PADRAO;
  } catch {
    return IDIOMA_PADRAO;
  }
}

function guardarIdioma(codigo) {
  try {
    globalThis.localStorage?.setItem(CHAVE_DE_PREFERENCIA, codigo);
  } catch {
    // Preferência não é dado: perdê-la custa um clique na próxima visita.
  }
}

/**
 * Traduz uma chave. Interpola `{nome}` com os valores recebidos.
 *
 * O RECUO É EM CASCATA, e cada degrau existe por um motivo diferente:
 * o idioma escolhido, depois o português (tradução que ainda não chegou), e
 * por fim a própria chave. Devolver a chave é feio de propósito — texto
 * faltando tem de ser visível para quem desenvolve, e nunca virar espaço em
 * branco para quem usa.
 */
export function traduzir(idioma, chave, valores = {}) {
  const texto = DICIONARIO[idioma]?.[chave] ?? DICIONARIO[IDIOMA_PADRAO]?.[chave] ?? chave;
  return String(texto).replace(/\{(\w+)\}/g, (inteiro, nome) =>
    (Object.prototype.hasOwnProperty.call(valores, nome) ? String(valores[nome]) : inteiro));
}

const ContextoDeIdioma = createContext(null);

export function ProvedorDeIdioma({ children, inicial }) {
  const [idioma, definir] = useState(() => (ehIdiomaConhecido(inicial) ? inicial : idiomaPreferido()));

  useEffect(() => {
    guardarIdioma(idioma);
    // Os rótulos de enum vivem em `format.js` e são chamados de dezenas de
    // lugares sem contexto. Avisá-lo daqui mantém as duas camadas no mesmo
    // idioma sem obrigar cada chamada a receber um parâmetro a mais.
    definirIdiomaDosRotulos(idioma);
    // `lang` no documento é o que leitor de tela e corretor ortográfico leem
    // para escolher a pronúncia. Sem isto a interface troca de idioma para os
    // olhos e continua em português para quem ouve.
    if (globalThis.document?.documentElement) {
      globalThis.document.documentElement.lang = idioma;
    }
  }, [idioma]);

  const valor = useMemo(() => ({
    idioma,
    definirIdioma: codigo => { if (ehIdiomaConhecido(codigo)) definir(codigo); },
    t: (chave, valores) => traduzir(idioma, chave, valores)
  }), [idioma]);

  return <ContextoDeIdioma.Provider value={valor}>{children}</ContextoDeIdioma.Provider>;
}

/**
 * Fora do provedor devolve o padrão em vez de lançar: um componente isolado
 * num teste, ou uma tela de erro montada antes da árvore, precisa renderizar.
 */
// NEGRITO DENTRO DE UMA FRASE, SEM INJETAR HTML.
//
// Algumas frases têm um trecho em destaque no meio ("abriremos a página
// **Minha solicitação**, onde você informa..."). Quebrá-las em três chaves
// obrigaria cada idioma a manter a mesma ORDEM de palavras — e não mantém:
// em inglês o destaque cai antes do substantivo que em português vem depois.
//
// Então a frase fica inteira, com `<b>` marcando o trecho, e este componente
// a converte em nós React. NÃO é `dangerouslySetInnerHTML`: o texto é
// FATIADO, só `<b>` vira elemento, e qualquer outra marcação que entrasse na
// tradução sairia como texto literal na tela — visível, e inofensiva.
export function TextoRico({ chave, valores }) {
  const { t } = useIdioma();

  return (
    <>
      {t(chave, valores).split(/(<b>.*?<\/b>)/g).filter(Boolean).map((pedaco, indice) => (
        pedaco.startsWith('<b>') && pedaco.endsWith('</b>')
          ? <strong key={`${indice}:${pedaco}`}>{pedaco.slice(3, -4)}</strong>
          : <span key={`${indice}:${pedaco}`}>{pedaco}</span>
      ))}
    </>
  );
}

export function useIdioma() {
  return useContext(ContextoDeIdioma) ?? {
    idioma: IDIOMA_PADRAO,
    definirIdioma: () => {},
    t: (chave, valores) => traduzir(IDIOMA_PADRAO, chave, valores)
  };
}

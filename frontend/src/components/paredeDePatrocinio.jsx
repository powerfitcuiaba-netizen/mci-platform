import { useLayoutEffect, useRef, useState } from 'react';
import { useIdioma } from '../lib/idioma';
import {
  CATEGORIAS_COM_PASTILHA,
  CHAVE_DO_ROTULO,
  caminhoDaMarca,
  categoriasComMarcas,
  copiasNecessarias,
  duracaoDoCiclo,
  marcasDaCategoria,
  sentidoDaFaixa
} from '../lib/patrocinadores';

// A parede de patrocínio da tela de entrada.
//
// Uma faixa por categoria, cada uma correndo em esteira, em sentidos
// alternados. Tudo aqui é apresentação: nenhuma decisão de autorização ou de
// regra de negócio mora neste arquivo.
//
// A ESTEIRA NÃO É UM `marquee`
//
// O trilho leva N cópias do mesmo grupo e desloca -100%/N num ciclo. Quando o
// ciclo reinicia, a cópia 2 está exatamente onde a cópia 1 estava: a emenda cai
// em cima de si mesma e não existe salto visível. Isso só vale se o passo do
// ciclo for IGUAL à largura do grupo — por isso N é medido, não chutado.
//
// A VELOCIDADE É CONSTANTE EM PIXELS POR SEGUNDO
//
// Uma duração fixa faria a faixa com mais marcas correr mais rápido, porque
// percorreria mais pixels no mesmo tempo. A duração sai da largura medida:
// grupo ÷ 42 px/s. Assim as quatro faixas andam no mesmo ritmo, com contagens
// de marcas diferentes.
//
// POR QUE `offsetWidth`, E NÃO `getBoundingClientRect().width`
//
// O retângulo do cliente vem DEPOIS das transformações dos ancestrais. Se
// qualquer pai estiver escalado, a largura medida não é a largura de layout, e
// a conta de cópias e de duração sai errada — já saiu: 57 px/s onde deviam ser
// 42. `offsetWidth` é a largura de layout, imune a isso.

const PARADA_DA_MEDICAO = 120;

/** Uma marca dentro da caixa da própria categoria. */
function Marca({ marca, pastilha, oculta }) {
  return (
    <div className={`patro${pastilha ? ' patro-pastilha' : ''}`}>
      <img
        src={caminhoDaMarca(marca)}
        // O clone existe só para cobrir a janela. Anunciar o mesmo
        // patrocinador quatro vezes é ruído para quem usa leitor de tela.
        alt={oculta ? '' : marca.nome}
        // Sem `loading="lazy"`: os clones repetem a MESMA URL do original, e o
        // navegador serve todos da mesma resposta. Adiar não pouparia byte
        // nenhum e arriscaria clone em branco dentro do `overflow: hidden`.
        decoding="async"
        draggable="false"
      />
    </div>
  );
}

function Faixa({ categoria, indice }) {
  const { t } = useIdioma();
  const marcas = marcasDaCategoria(categoria);
  const pastilha = CATEGORIAS_COM_PASTILHA.includes(categoria);
  const janelaRef = useRef(null);
  const grupoRef = useRef(null);
  const [copias, setCopias] = useState(2);
  const [duracao, setDuracao] = useState(null);

  // `useLayoutEffect` e não `useEffect`: a medição tem de acontecer antes da
  // pintura, senão o primeiro quadro mostra a esteira com a duração errada e a
  // animação dá um pulo visível quando o valor certo chega.
  useLayoutEffect(() => {
    const janela = janelaRef.current;
    const grupo = grupoRef.current;
    if (!janela || !grupo) return undefined;

    let agendado = null;
    const medir = () => {
      const larguraDoGrupo = grupo.offsetWidth;
      if (!larguraDoGrupo) return;
      setCopias(copiasNecessarias(larguraDoGrupo, janela.clientWidth));
      setDuracao(duracaoDoCiclo(larguraDoGrupo));
    };
    medir();

    // A medição refaz a conta quando a tela muda de tamanho. O adiamento evita
    // refazer a cada pixel de um arrasto de janela.
    if (typeof ResizeObserver !== 'function') return undefined;
    const observador = new ResizeObserver(() => {
      if (agendado) clearTimeout(agendado);
      agendado = setTimeout(medir, PARADA_DA_MEDICAO);
    });
    observador.observe(janela);
    return () => {
      if (agendado) clearTimeout(agendado);
      observador.disconnect();
    };
    // As marcas de uma categoria são fixas; o que muda é o tamanho da janela.
  }, [categoria]);

  if (!marcas.length) return null;

  const grupos = [];
  for (let i = 0; i < copias; i += 1) {
    grupos.push(
      <div
        key={i}
        className={`esteira-grupo esteira-grupo-${categoria}`}
        ref={i === 0 ? grupoRef : undefined}
        aria-hidden={i > 0 ? 'true' : undefined}
      >
        {marcas.map(marca => (
          <Marca key={marca.arquivo} marca={marca} pastilha={pastilha} oculta={i > 0} />
        ))}
      </div>
    );
  }

  return (
    <div className={`faixa-patro t-${categoria}`}>
      <div className="faixa-patro-cab">
        <span>{t(CHAVE_DO_ROTULO[categoria])}</span>
        <i />
      </div>
      <div className="esteira" ref={janelaRef} data-sentido={sentidoDaFaixa(indice)}>
        <div
          className="esteira-trilho"
          style={{
            '--copias': copias,
            // Enquanto a medição não chega, a esteira fica PARADA em vez de
            // correr num ritmo inventado.
            ...(duracao ? { '--dur': `${duracao.toFixed(2)}s` } : { animation: 'none' })
          }}
        >
          {grupos}
        </div>
      </div>
    </div>
  );
}

/**
 * A parede inteira.
 *
 * Com `prefers-reduced-motion` nenhuma faixa anda: viram listas estáticas com
 * TODAS as marcas visíveis. Uma parede de patrocínio não pode depender de
 * animação para ser vista — quem liga a preferência precisa enxergar todo mundo,
 * não um trecho. O CSS cuida disso; aqui o componente só não atrapalha.
 */
export default function ParedeDePatrocinio() {
  const { t } = useIdioma();
  const categorias = categoriasComMarcas();
  if (!categorias.length) return null;

  return (
    <section className="parede-patro" aria-label={t('patrocinio.parede')}>
      {categorias.map((categoria, indice) => (
        <Faixa key={categoria} categoria={categoria} indice={indice} />
      ))}
    </section>
  );
}

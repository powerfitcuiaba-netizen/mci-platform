import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { copiasNecessarias, duracaoDoCiclo } from '../lib/patrocinadores';

// A ESTEIRA — a mecânica do movimento contínuo, num lugar só.
//
// POR QUE ELA SAIU DA PAREDE DE PATROCÍNIO
//
// A parede da entrada tinha esta lógica dentro dela. Quando o rodapé da
// vitrine passou a precisar da mesma esteira, havia dois caminhos: copiar a
// medição para o componente novo, ou extraí-la. Copiar criaria duas marquees
// que começam iguais e divergem no primeiro ajuste — e a conta de cópias é
// justamente a parte que já saiu errada uma vez.
//
// A ESTEIRA NÃO É UM `marquee`
//
// O trilho leva N cópias do mesmo grupo e desloca -100%/N num ciclo. Quando o
// ciclo reinicia, a cópia 2 está exatamente onde a cópia 1 estava: a emenda cai
// em cima de si mesma e não existe salto visível. Isso só vale se o passo do
// ciclo for IGUAL à largura do grupo — por isso N é MEDIDO, não chutado.
//
// A VELOCIDADE É CONSTANTE EM PIXELS POR SEGUNDO
//
// Uma duração fixa faria a faixa com mais itens correr mais rápido, porque
// percorreria mais pixels no mesmo tempo. A duração sai da largura medida:
// grupo ÷ `PIXELS_POR_SEGUNDO`. Assim todas as esteiras do produto andam no
// mesmo ritmo, com contagens de itens diferentes.
//
// POR QUE `offsetWidth`, E NÃO `getBoundingClientRect().width`
//
// O retângulo do cliente vem DEPOIS das transformações dos ancestrais. Se
// qualquer pai estiver escalado, a largura medida não é a largura de layout, e
// a conta de cópias e de duração sai errada — já saiu: 57 px/s onde deviam ser
// 42. `offsetWidth` é a largura de layout, imune a isso.
//
// O QUE ESTE COMPONENTE NÃO FAZ
//
// Ele não sabe o que está transportando. Não busca dado, não decide o que é
// elegível, não conhece patrocinador. Recebe uma lista pronta e uma função que
// desenha um item; quem decide o conteúdo é quem o usa.

const PARADA_DA_MEDICAO = 120;

/**
 * @param {object[]} itens       o que anda na esteira, já na ordem final
 * @param {function} chave       item → chave estável de React
 * @param {function} desenhar    (item, ehClone) → nó; `ehClone` existe para o
 *                               clone não ser anunciado de novo ao leitor de tela
 * @param {string}   classeDoGrupo  classe extra do grupo, para o espaçamento
 * @param {string}   sentido     'esquerda' (padrão) ou 'direita'
 * @param {string}   rotulo      aria-label da janela, quando ela for a região
 */
export default function Esteira({
  itens,
  chave,
  desenhar,
  classeDoGrupo = '',
  sentido = 'esquerda',
  rotulo = undefined
}) {
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
    // A lista é estável durante a vida da tela; o que muda é o tamanho dela.
  }, [itens.length]);

  if (!itens.length) return null;

  const grupos = [];
  for (let i = 0; i < copias; i += 1) {
    grupos.push(
      <div
        key={i}
        className={`esteira-grupo ${classeDoGrupo}`.trim()}
        ref={i === 0 ? grupoRef : undefined}
        aria-hidden={i > 0 ? 'true' : undefined}
      >
        {/* `Fragment` e não uma `div`: um invólucro aqui viraria o filho flex
            do grupo, e o espaçamento e o `flex: 0 0 auto` que a caixa do item
            já declara passariam a valer para o invólucro, não para ela. */}
        {itens.map(item => (
          <Fragment key={chave(item)}>{desenhar(item, i > 0)}</Fragment>
        ))}
      </div>
    );
  }

  return (
    <div className="esteira" ref={janelaRef} data-sentido={sentido} aria-label={rotulo}>
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
  );
}

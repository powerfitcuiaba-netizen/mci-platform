import { caminhoDaMarca } from '../lib/patrocinadores';

// UMA MARCA DENTRO DA CAIXA DA PRÓPRIA CATEGORIA.
//
// A caixa é do CSS (`--caixa-l` / `--caixa-a`, declaradas por `.t-<categoria>`);
// aqui só se decide o que é anunciado e como o arquivo é carregado. A arte
// nunca é esticada: o CSS limita largura e altura em pixels e a imagem encaixa
// na própria proporção.
//
// NÃO HÁ LINK, e a ausência é informação. O catálogo
// (`lib/patrocinadores.js`) não guarda site de patrocinador — não existe o
// campo. Envolver a logo num `<a>` exigiria inventar o endereço, e uma âncora
// que não leva a lugar nenhum é pior que nenhuma âncora: ela promete um
// destino ao teclado e ao leitor de tela. No dia em que o catálogo ganhar
// `site`, o link entra aqui, num lugar só, para a parede e o rodapé juntos.
// `classe` existe para o rodapé: lá a cota é declarada na PRÓPRIA caixa
// (`t-global`, `t-silver`…), porque a faixa é uma só e cada marca carrega a
// escala da sua cota. Na parede a cota está na linha, que é de uma categoria
// inteira. Um invólucro extra resolveria também, mas viraria o filho flex do
// grupo e o `flex: 0 0 auto` da caixa deixaria de valer onde importa.
export default function Marca({ marca, pastilha = false, oculta = false, prioridade = 'auto', classe = '' }) {
  return (
    <div className={`patro${pastilha ? ' patro-pastilha' : ''}${classe ? ` ${classe}` : ''}`}>
      <img
        src={caminhoDaMarca(marca)}
        // O clone existe só para cobrir a janela. Anunciar o mesmo
        // patrocinador quatro vezes é ruído para quem usa leitor de tela.
        alt={oculta ? '' : marca.nome}
        // Sem `loading="lazy"`: os clones repetem a MESMA URL do original, e o
        // navegador serve todos da mesma resposta. Adiar não pouparia byte
        // nenhum e arriscaria clone em branco dentro do `overflow: hidden`.
        //
        // `fetchpriority` é o que protege a tela: no rodapé da vitrine as 15
        // artes entram atrás do conteúdo que a pessoa foi ler, em vez de
        // disputar banda com ele. São 141 KB no total, servidos por caminho
        // estático — mas disputar o primeiro quadro com o ranking seria trocar
        // LCP por logo.
        fetchPriority={prioridade}
        decoding="async"
        draggable="false"
      />
    </div>
  );
}

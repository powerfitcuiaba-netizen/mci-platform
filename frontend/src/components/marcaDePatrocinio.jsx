import { urlDaLogo, nivelEmClasse } from '../lib/catalogoDePatrocinio';
import { CATEGORIAS_COM_PASTILHA } from '../lib/patrocinadores';

// UMA MARCA DENTRO DA CAIXA DO PRÓPRIO NÍVEL.
//
// A caixa é do CSS (`--caixa-l` / `--caixa-a`, declaradas por `.t-<nivel>`);
// aqui só se decide o que é anunciado, como o arquivo é carregado e se a logo
// vira link. A arte nunca é esticada nem cortada: o CSS limita largura e
// altura em pixels e a imagem encaixa na própria proporção.
//
// O LINK SÓ EXISTE QUANDO O SITE EXISTE. `siteUrl` é opcional no catálogo, e
// as 15 marcas migradas vieram sem site — a lista antiga nunca guardou um.
// Envolver a logo num `<a>` sem destino prometeria um site ao teclado e ao
// leitor de tela. Quando o administrador preenche o campo, o link aparece
// sozinho, aqui, para a parede e para o rodapé de uma vez.
//
// `rel="noopener noreferrer"` com `target="_blank"`: sem `noopener` a página
// aberta recebe uma referência para a nossa janela e pode trocá-la de
// endereço.
export default function Marca({ patrocinador, oculta = false, prioridade = 'auto', classe = '' }) {
  const nivel = nivelEmClasse(patrocinador);
  const pastilha = CATEGORIAS_COM_PASTILHA.includes(nivel);
  const alt = oculta ? '' : `Logo ${patrocinador.name}`;

  const arte = (
    <img
      src={urlDaLogo(patrocinador)}
      // O clone existe só para cobrir a janela. Anunciar o mesmo patrocinador
      // quatro vezes é ruído para quem usa leitor de tela.
      alt={alt}
      // Sem `loading="lazy"`: os clones repetem a MESMA URL do original, e o
      // navegador serve todos da mesma resposta. Adiar não pouparia byte
      // nenhum e arriscaria clone em branco dentro do `overflow: hidden`.
      //
      // `fetchpriority` é o que protege a tela: no rodapé da vitrine as artes
      // entram atrás do conteúdo que a pessoa foi ler, em vez de disputar
      // banda com ele.
      fetchPriority={prioridade}
      decoding="async"
      draggable="false"
    />
  );

  const caixa = `patro${pastilha ? ' patro-pastilha' : ''} t-${nivel}${classe ? ` ${classe}` : ''}`;

  // Clone NÃO recebe link: ele está fora da árvore de acessibilidade, e uma
  // âncora ali voltaria a criar parada de tabulação para a mesma marca.
  if (!patrocinador.siteUrl || oculta) return <div className={caixa}>{arte}</div>;

  return (
    <a
      className={`${caixa} patro-link`}
      href={patrocinador.siteUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Visitar o site de ${patrocinador.name}`}
    >
      {arte}
    </a>
  );
}

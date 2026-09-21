import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { IDIOMAS, useIdioma } from '../lib/idioma';

// ============================================================================
// SELETOR DE IDIOMA — três bandeiras em tela larga, um botão no celular.
//
// POR QUE BOTÕES, E NÃO UM `<select>`
//
// São três opções, sempre as mesmas, e a escolhida precisa ficar VISÍVEL sem
// abrir nada. Um `<select>` esconde duas e exige dois toques; três botões
// mostram o estado e trocam num toque só — que é o que importa numa barra que
// o operador usa em pé, de celular, com o ginásio funcionando.
//
// A BANDEIRA SOZINHA NÃO INFORMA, e é por isso que ela nunca vem sozinha:
// `aria-label` com o nome do idioma no próprio idioma ("Português", "English",
// "Español"), `title` para quem usa mouse, e `aria-pressed` dizendo qual está
// em vigor. Bandeira é atalho visual para quem já sabe; o nome é o que
// responde para quem não sabe e para quem não enxerga.
//
// POR QUE O CELULAR GANHOU UM BOTÃO SÓ
//
// Três opções lado a lado custavam 100px e mediam 31x32 cada. Dois problemas
// num número só: a barra superior somava 412px numa viewport de 360 — 52 a
// mais do que existe, com rolagem horizontal medida em Chromium real —, e
// 31px fica abaixo do piso de 40px de alvo de toque que a suíte já protege.
//
// Aumentar as três para 44px resolveria o toque e PIORARIA a largura: 132px em
// vez de 100. Um botão de 44px resolve os dois: as ações caem de 256 para 200,
// a barra fecha em 356, e o alvo passa a cumprir o piso. As três línguas
// continuam todas lá, a um toque de distância.
// ============================================================================

export default function SeletorDeIdioma() {
  const { idioma, definirIdioma, t } = useIdioma();
  const [aberto, setAberto] = useState(false);
  const caixa = useRef(null);

  const emVigorAgora = IDIOMAS.find(i => i.codigo === idioma) ?? IDIOMAS[0];

  // Fechar ao clicar fora e no Escape. `mousedown` e não `click`: o clique de
  // um botão de dentro chegaria depois do fechamento e o menu piscaria.
  useEffect(() => {
    if (!aberto) return undefined;
    const foraDaqui = evento => { if (!caixa.current?.contains(evento.target)) setAberto(false); };
    const aoTeclar = evento => { if (evento.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', foraDaqui);
    window.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('mousedown', foraDaqui);
      window.removeEventListener('keydown', aoTeclar);
    };
  }, [aberto]);

  const opcao = (opcaoIdioma, classe) => {
    const emVigor = opcaoIdioma.codigo === idioma;
    return (
      <button
        key={opcaoIdioma.codigo}
        type="button"
        className={`${classe}${emVigor ? ' is-active' : ''}`}
        aria-pressed={emVigor}
        aria-label={opcaoIdioma.nome}
        title={opcaoIdioma.nome}
        lang={opcaoIdioma.codigo}
        onClick={() => { definirIdioma(opcaoIdioma.codigo); setAberto(false); }}
      >
        {/* A bandeira é decorativa PARA O LEITOR DE TELA: o nome do idioma já
            está no `aria-label`, e deixá-la acessível faria o leitor anunciar
            "bandeira do Brasil Português". */}
        <span className="seletor-idioma-bandeira" aria-hidden="true">{opcaoIdioma.bandeira}</span>
        <span className="seletor-idioma-sigla" aria-hidden="true">{opcaoIdioma.curto}</span>
      </button>
    );
  };

  return (
    <div className="seletor-idioma-raiz" ref={caixa}>
      {/* Tela larga: as três à vista, como sempre foram. */}
      <div className="seletor-idioma" role="group" aria-label={t('idioma.escolher')}>
        {IDIOMAS.map(opcaoIdioma => opcao(opcaoIdioma, 'seletor-idioma-opcao'))}
      </div>

      {/* Celular: um botão de 44px que abre as três. O globo diz "idioma" a
          quem não lê o texto; a bandeira em vigor diz QUAL está valendo. */}
      <button
        type="button"
        className="icon-button seletor-idioma-botao"
        aria-label={t('idioma.abrirMenu')}
        aria-expanded={aberto}
        aria-haspopup="menu"
        onClick={() => setAberto(a => !a)}
      >
        <Globe size={16} />
        <span className="seletor-idioma-atual" aria-hidden="true">{emVigorAgora.bandeira}</span>
      </button>

      {aberto && (
        <div className="seletor-idioma-menu" role="menu" aria-label={t('idioma.escolher')}>
          {IDIOMAS.map(opcaoIdioma => opcao(opcaoIdioma, 'seletor-idioma-item'))}
        </div>
      )}
    </div>
  );
}

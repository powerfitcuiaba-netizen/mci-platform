import { IDIOMAS, useIdioma } from '../lib/idioma';

// ============================================================================
// SELETOR DE IDIOMA — três bandeiras, no canto superior direito.
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
// A sigla ao lado (PT/EN/ES) aparece em tela larga e some no celular, onde o
// espaço do cabeçalho é disputado com a busca e as notificações. A bandeira
// permanece nos dois — o controle nunca desaparece, só encolhe.
// ============================================================================

export default function SeletorDeIdioma() {
  const { idioma, definirIdioma, t } = useIdioma();

  return (
    <div className="seletor-idioma" role="group" aria-label={t('idioma.escolher')}>
      {IDIOMAS.map(opcao => {
        const emVigor = opcao.codigo === idioma;
        return (
          <button
            key={opcao.codigo}
            type="button"
            className={`seletor-idioma-opcao${emVigor ? ' is-active' : ''}`}
            aria-pressed={emVigor}
            aria-label={opcao.nome}
            title={opcao.nome}
            lang={opcao.codigo}
            onClick={() => definirIdioma(opcao.codigo)}
          >
            {/* A bandeira é decorativa PARA O LEITOR DE TELA: o nome do idioma
                já está no `aria-label`, e deixá-la acessível faria o leitor
                anunciar "bandeira do Brasil Português". */}
            <span className="seletor-idioma-bandeira" aria-hidden="true">{opcao.bandeira}</span>
            <span className="seletor-idioma-sigla" aria-hidden="true">{opcao.curto}</span>
          </button>
        );
      })}
    </div>
  );
}

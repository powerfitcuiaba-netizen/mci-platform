import { useEffect, useRef, useState } from 'react';
import { MarcaMci } from './ui';
import { direcaoDeAudio, definirPreferenciaDeAudio } from '../lib/audioDirector';
import { NIVEL, podeAnimar } from '../lib/experiencia';
import { useIdioma } from '../lib/idioma';

// ============================================================================
// ABERTURA DO MCI.
//
// A marca aparece, a trilha entra, a interface é revelada. Nada além disso:
// a identidade visual do sistema já existe (`MarcaMci`, a paleta, o gradiente
// vermelho-ciano da barra lateral) e a abertura a APRESENTA — não inventa
// outra.
//
// O QUE ELA NUNCA FAZ:
//
//   - travar. A abertura roda por tempo, não por evento de áudio. Se a trilha
//     não puder tocar, ela segue igual, em silêncio;
//   - repetir. Uma vez por sessão do navegador, e não a cada navegação;
//   - impedir a saída. Escape, clique em "Entrar agora" ou o fim do tempo
//     levam ao sistema.
//
// `prefers-reduced-motion` encurta tudo e remove o movimento — mas NÃO
// silencia: reduzir movimento é pedido sobre animação, não sobre som. Quem
// não quer som desliga no controle, que é outra coisa.
// ============================================================================

const CHAVE_DA_SESSAO = 'mci-abertura-vista';
const DURACAO_MS = 7200;
const DURACAO_REDUZIDA_MS = 1800;

export function aberturaJaFoiVista() {
  try {
    return sessionStorage.getItem(CHAVE_DA_SESSAO) === 'true';
  } catch {
    // Sem armazenamento, a abertura roda uma vez por carga de página. É o
    // comportamento degradado aceitável — nunca o contrário (repetir sempre).
    return false;
  }
}

function marcarComoVista() {
  try { sessionStorage.setItem(CHAVE_DA_SESSAO, 'true'); } catch { /* aba anônima */ }
}

export default function AberturaMci({ aoTerminar }) {
  const { t } = useIdioma();
  const [saindo, setSaindo] = useState(false);
  const [audio, setAudio] = useState('parado');
  const encerrada = useRef(false);

  // A ABERTURA CONSULTA O TETO DO MOTOR, como qualquer outro efeito.
  //
  // Ela nasceu antes do motor e tinha a própria cópia de
  // `prefereMenosMovimento` — segunda verdade sobre a mesma pergunta. Pior: só
  // olhava a preferência de movimento, e NÃO a capacidade do aparelho. Isso
  // deixava a animação mais cara do produto inteiro (um `filter: blur`
  // animado sobre a marca em tamanho grande) rodando justamente no celular
  // fraco, que é onde ela dói.
  //
  // Medido: capturar um quadro DURANTE a abertura custa ~12s contra ~0,2s com
  // a tela parada, e o custo não muda com a resolução — é a composição do
  // desfoque, não o número de pixels.
  //
  // A abertura é nível CINEMATOGRÁFICO. Quem não alcança esse teto — seja por
  // preferência, seja por aparelho — recebe a versão curta e sem desfoque, que
  // continua sendo a abertura: a marca, o nome e a entrada no sistema.
  const reduzido = useRef(!podeAnimar(NIVEL.CINEMATOGRAFICO));
  const duracao = reduzido.current ? DURACAO_REDUZIDA_MS : DURACAO_MS;

  // Encerrar é idempotente: o tempo pode acabar enquanto a pessoa clica em
  // "Entrar agora", e as duas coisas chamariam isto.
  const encerrar = useRef(() => {});
  encerrar.current = () => {
    if (encerrada.current) return;
    encerrada.current = true;
    setSaindo(true);
    // O áudio some junto com a imagem, em vez de continuar tocando sobre a
    // tela de entrada.
    direcaoDeAudio.encerrar();
    marcarComoVista();
    // Espera o esmaecimento terminar antes de trocar a tela, para a transição
    // não ter corte seco.
    setTimeout(() => aoTerminar(), reduzido.current ? 120 : 620);
  };

  useEffect(() => {
    let vivo = true;
    direcaoDeAudio.tocarAbertura().then(estado => { if (vivo) setAudio(estado); });

    const relogio = setTimeout(() => encerrar.current(), duracao);
    const aoTeclar = evento => { if (evento.key === 'Escape') encerrar.current(); };
    window.addEventListener('keydown', aoTeclar);

    return () => {
      vivo = false;
      clearTimeout(relogio);
      window.removeEventListener('keydown', aoTeclar);
      // Sair da abertura por qualquer caminho para a trilha: sem isto, um
      // recarregamento no meio deixaria o áudio tocando sem tela.
      direcaoDeAudio.encerrar({ imediato: true });
    };
  }, [duracao]);

  // O navegador recusou o autoplay. A abertura já está rodando em silêncio; o
  // clique aqui é o gesto que a política do navegador exige.
  const ativarSom = async () => {
    definirPreferenciaDeAudio(true);
    setAudio(await direcaoDeAudio.tocarAbertura({ ignorarPreferencia: true }));
  };

  return (
    <div
      className={`abertura${saindo ? ' is-saindo' : ''}${reduzido.current ? ' is-reduzida' : ''}`}
      role="dialog"
      aria-label={t('abertura.rotulo')}
    >
      <div className="abertura-palco">
        <MarcaMci largura={260} className="abertura-marca" />
        <p className="abertura-legenda">Campeonato Brasileiro Muscle Contest</p>
      </div>

      <div className="abertura-acoes">
        {audio === 'bloqueado' && (
          <button type="button" className="button button-secondary button-sm" onClick={ativarSom}>
            🔊 {t('abertura.ativarSom')}
          </button>
        )}
        {audio === 'tocando' && (
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => { definirPreferenciaDeAudio(false); direcaoDeAudio.encerrar({ imediato: true }); setAudio('desligado'); }}
          >
            🔇 {t('abertura.silenciar')}
          </button>
        )}
        <button type="button" className="button button-ghost button-sm" onClick={() => encerrar.current()}>
          {t('abertura.entrarAgora')}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { MarcaMci } from './ui';
import { direcaoDeAudio, definirPreferenciaDeAudio } from '../lib/audioDirector';

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

const prefereMenosMovimento = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export default function AberturaMci({ aoTerminar }) {
  const [saindo, setSaindo] = useState(false);
  const [audio, setAudio] = useState('parado');
  const encerrada = useRef(false);
  const reduzido = useRef(prefereMenosMovimento());
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
      aria-label="Abertura do MCI Platform"
    >
      <div className="abertura-palco">
        <MarcaMci largura={260} className="abertura-marca" />
        <p className="abertura-legenda">Campeonato Brasileiro Muscle Contest</p>
      </div>

      <div className="abertura-acoes">
        {audio === 'bloqueado' && (
          <button type="button" className="button button-secondary button-sm" onClick={ativarSom}>
            🔊 Ativar experiência sonora
          </button>
        )}
        {audio === 'tocando' && (
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={() => { definirPreferenciaDeAudio(false); direcaoDeAudio.encerrar({ imediato: true }); setAudio('desligado'); }}
          >
            🔇 Silenciar
          </button>
        )}
        <button type="button" className="button button-ghost button-sm" onClick={() => encerrar.current()}>
          Entrar agora
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Check, Trophy } from 'lucide-react';
import {
  NIVEL, MCIEvento, podeAnimar, ouvirExperiencia, estiloDaSequencia, prefereMenosMovimento
} from '../lib/experiencia';

// ============================================================================
// OS COMPONENTES DA EXPERIÊNCIA.
//
// Todos seguem a mesma disciplina: quando o motor diz que não pode animar, o
// componente ainda RENDERIZA A INFORMAÇÃO — só sem o teatro. Nenhum efeito aqui
// é a única forma de o usuário saber o que aconteceu.
// ============================================================================

// ---------------------------------------------------------------- Revelação
//
// Entrada em sequência dos blocos de uma tela. Envolve, não substitui: o filho
// é renderizado igual, com um atraso calculado pelo motor.
//
// O elemento NÃO nasce invisível quando o movimento está reduzido — nasce
// pronto. Nascer com `opacity: 0` esperando animação é como telas somem para
// quem desligou animação.
export function Revelacao({ indice = 0, children, className = '', as: Tag = 'div', ...resto }) {
  const anima = podeAnimar(NIVEL.TRANSICAO);
  // O atraso NÃO é guardado aqui de novo: `estiloDaSequencia` já devolve `{}`
  // sob a mesma condição. Um teste de mutação mostrou que a guarda duplicada
  // era inobservável — duas cópias da mesma verdade, e a segunda só serviria
  // para divergir da primeira algum dia.
  return (
    <Tag
      className={`${anima ? 'revela' : ''} ${className}`.trim()}
      style={estiloDaSequencia(indice)}
      {...resto}
    >
      {children}
    </Tag>
  );
}

// ------------------------------------------------------- Varredura de energia
//
// Uma linha de luz atravessa o elemento UMA VEZ, quando ele é novo ou acabou de
// mudar. `varre` já existia no sistema (na barra de progresso ao vivo, em
// laço); aqui ela é usada como gesto pontual, que é o que a torna notável.
//
// Repetir sem motivo é o que mata o efeito: se tudo varre o tempo todo, nada
// chama atenção.
export function VarreduraDeEnergia({ ativa = true, children, className = '' }) {
  const anima = ativa && podeAnimar(NIVEL.MICRO) && !prefereMenosMovimento();
  return <div className={`${anima ? 'varredura' : ''} ${className}`.trim()}>{children}</div>;
}

// -------------------------------------------------------------- Pulso ao vivo
//
// Só para dado REALMENTE em tempo real. Usar pulsação para fingir que algo está
// vivo é mentir com animação — e o operador confia nesse ponto para saber se
// pode agir sobre o número.
export function PulsoAoVivo({ rotulo = 'AO VIVO', className = '' }) {
  return (
    <span className={`pulso-ao-vivo ${className}`.trim()} role="status">
      <span className="pulso-ponto" aria-hidden="true" />
      {rotulo}
    </span>
  );
}

// ------------------------------------------------------------ Palco de eventos
//
// Ouve o motor e desenha o que for anunciado. Um só no aplicativo inteiro,
// montado na casca — sem isso, dois palcos desenhariam a mesma celebração duas
// vezes.
const DURACAO = { [NIVEL.EVENTO]: 2200, [NIVEL.MOMENTO]: 2800, [NIVEL.CINEMATOGRAFICO]: 5200 };

export function PalcoDaExperiencia() {
  const [emCena, setEmCena] = useState(null);
  const relogio = useRef(null);

  useEffect(() => ouvirExperiencia(momento => {
    // Um momento novo substitui o anterior em vez de empilhar: duas celebrações
    // sobrepostas viram ruído, e a segunda é sempre a mais recente.
    if (relogio.current) clearTimeout(relogio.current);
    setEmCena(momento);
    relogio.current = setTimeout(() => setEmCena(null), DURACAO[momento.nivel] ?? 2200);
  }), []);

  useEffect(() => () => { if (relogio.current) clearTimeout(relogio.current); }, []);

  if (!emCena) return null;
  if (emCena.evento === MCIEvento.CAMPEAO) return <MomentoCampeao momento={emCena} />;
  return <ImpactoDeSucesso momento={emCena} />;
}

// ----------------------------------------------------------- Impacto de êxito
//
// A confirmação de uma operação que importa: credenciar, pesar, dar check-in.
// NÃO substitui o feedback funcional — o toast continua, a lista continua
// atualizando. Isto é o reconhecimento por cima.
export function ImpactoDeSucesso({ momento }) {
  // Nível MOMENTO (resultado publicado) ganha a varredura de energia POR CIMA
  // da caixa — o mesmo efeito que já existe, não um segundo. É o que separa
  // "confirmou" de "isto agora é oficial e público", sem chegar perto do
  // nível 5, que continua sendo só do campeão.
  const comVarredura = momento.nivel >= NIVEL.MOMENTO && podeAnimar(NIVEL.MOMENTO);

  return (
    <div className={`impacto impacto-${momento.tom}`} role="status" aria-live="polite">
      <div className={`impacto-caixa${comVarredura ? ' varredura' : ''}`}>
        <span className="impacto-marca" aria-hidden="true"><Check size={26} strokeWidth={3} /></span>
        <strong>{momento.titulo || 'Pronto'}</strong>
        {momento.descricao && <p>{momento.descricao}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Momento campeão
//
// O ÚNICO nível 5 da operação, e o mais fácil de estragar: se aparecer a cada
// resultado, deixa de significar campeão e passa a significar "salvou". Só é
// disparado por quem declara um campeão geral — está anotado no motor e na
// documentação.
//
// As partículas são poucas e finitas. Partícula infinita em tela de trabalho é
// bateria de celular indo embora enquanto alguém confere pesagem.
const PARTICULAS = 14;

export function MomentoCampeao({ momento }) {
  const cinematografico = podeAnimar(NIVEL.CINEMATOGRAFICO);

  return (
    <div className="campeao" role="status" aria-live="polite">
      {cinematografico && (
        <div className="campeao-particulas" aria-hidden="true">
          {Array.from({ length: PARTICULAS }, (_, i) => (
            <span key={i} style={{ '--i': i, left: `${(i * 7 + 6) % 96}%` }} />
          ))}
        </div>
      )}
      <div className="campeao-caixa">
        <Trophy size={30} aria-hidden="true" />
        <span className="campeao-titulo">{momento.titulo || 'Campeão geral'}</span>
        {momento.nome && <strong className="campeao-nome">{momento.nome}</strong>}
        {momento.descricao && <p className="campeao-legenda">{momento.descricao}</p>}
      </div>
    </div>
  );
}

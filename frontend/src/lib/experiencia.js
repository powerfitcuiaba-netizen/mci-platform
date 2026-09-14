// ============================================================================
// MCI EXPERIENCE ENGINE — o motor.
//
// POR QUE ELE EXISTE: sem um lugar central, "animar o sistema" vira dezenas de
// `transition` soltas que ninguém consegue calibrar depois. Aqui ficam as três
// decisões que toda tela consulta: QUANTO um gesto vale, SE ele deve acontecer,
// e COMO ele é anunciado.
//
// POR QUE NÃO HÁ BIBLIOTECA DE MOTION: medido no baseline — o projeto não tem
// GSAP, Framer nem Tailwind, e o pacote inteiro tem 485 kB. GSAP somaria ~70 kB
// e Framer ~110 kB para fazer o que `transform`/`opacity` já fazem na GPU. Numa
// fase cujo objetivo é PERCEPÇÃO DE VELOCIDADE, pagar isso seria trabalhar
// contra o próprio objetivo. O motor orquestra; o CSS anima.
// ============================================================================

// ---------------------------------------------------------------- os níveis
//
// A regra de ouro desta fase: se o efeito chama mais atenção que a informação,
// o efeito está errado. Os níveis existem para isso ser DECISÃO e não acidente
// — cada efeito declara quanto vale, e o que vale pouco fica discreto.
export const NIVEL = Object.freeze({
  ESTATICO: 0,        // não se move. A maioria da interface.
  MICRO: 1,           // hover, foco, press — resposta ao dedo
  TRANSICAO: 2,       // troca de tela, abrir painel
  EVENTO: 3,          // salvou, credenciou, confirmou
  MOMENTO: 4,         // resultado publicado
  CINEMATOGRAFICO: 5  // abertura, campeão geral — raríssimo
});

// Os eventos que o sistema sabe celebrar. Nomear é o que impede "cada tela
// inventa o seu": quem quiser um efeito novo acrescenta aqui, e a revisão vê.
export const MCIEvento = Object.freeze({
  SUCESSO: 'sucesso',
  AVISO: 'aviso',
  ERRO: 'erro',
  CHECKIN: 'checkin',
  PESAGEM: 'pesagem',
  CREDENCIADO: 'credenciado',
  RESULTADO_PUBLICADO: 'resultado-publicado',
  AO_VIVO: 'ao-vivo',
  CAMPEAO: 'campeao',
  NOVIDADE: 'novidade'
});

// Cada evento declara nível e tom. `nivel` decide a intensidade; `tom` decide a
// cor, reaproveitando a paleta que o sistema já tem.
export const ASSINATURA = Object.freeze({
  [MCIEvento.SUCESSO]: { nivel: NIVEL.EVENTO, tom: 'sucesso' },
  [MCIEvento.AVISO]: { nivel: NIVEL.MICRO, tom: 'atencao' },
  [MCIEvento.ERRO]: { nivel: NIVEL.MICRO, tom: 'perigo' },
  [MCIEvento.CHECKIN]: { nivel: NIVEL.EVENTO, tom: 'sucesso' },
  [MCIEvento.PESAGEM]: { nivel: NIVEL.EVENTO, tom: 'sucesso' },
  [MCIEvento.CREDENCIADO]: { nivel: NIVEL.EVENTO, tom: 'sucesso' },
  [MCIEvento.RESULTADO_PUBLICADO]: { nivel: NIVEL.MOMENTO, tom: 'ciano' },
  [MCIEvento.AO_VIVO]: { nivel: NIVEL.MICRO, tom: 'perigo' },
  // O único nível 5 em operação normal. Ver `MomentoCampeao`.
  [MCIEvento.CAMPEAO]: { nivel: NIVEL.CINEMATOGRAFICO, tom: 'ouro' },
  [MCIEvento.NOVIDADE]: { nivel: NIVEL.MICRO, tom: 'ciano' }
});

// ------------------------------------------------------- o guarda de decência
//
// Uma preferência de sistema vence qualquer efeito que eu ache bonito. Lida na
// hora, não em cache: a pessoa pode mudar a configuração com a aba aberta.
export function prefereMenosMovimento() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// O TETO de intensidade que este dispositivo/pessoa aceita agora.
//
// Com movimento reduzido, nada passa de MICRO: a informação continua inteira, o
// deslocamento e as partículas somem. Não é desligar funcionalidade — é a mesma
// tela sem o teatro.
export function tetoDeIntensidade() {
  if (prefereMenosMovimento()) return NIVEL.MICRO;

  // Dispositivo declaradamente fraco não recebe partícula. `deviceMemory` e
  // `hardwareConcurrency` não existem em todo navegador; ausência não é sinal
  // de fraqueza, então o padrão é permitir.
  try {
    const memoria = navigator.deviceMemory;
    const nucleos = navigator.hardwareConcurrency;
    if ((memoria && memoria <= 2) || (nucleos && nucleos <= 2)) return NIVEL.TRANSICAO;
  } catch {
    /* navegador sem as dicas: segue o teto cheio */
  }
  return NIVEL.CINEMATOGRAFICO;
}

// A pergunta que todo efeito faz antes de acontecer.
export const podeAnimar = nivel => nivel <= tetoDeIntensidade();

// ------------------------------------------------------------------ o anúncio
//
// Um barramento minúsculo: quem EXECUTA a ação anuncia o que aconteceu, e quem
// DESENHA decide como mostrar. Sem isto, cada tela precisaria conhecer o
// componente de celebração — e a celebração viraria dependência de regra de
// negócio.
const OUVINTES = new Set();

export function ouvirExperiencia(ouvinte) {
  OUVINTES.add(ouvinte);
  return () => OUVINTES.delete(ouvinte);
}

/**
 * Anuncia um momento. `detalhe` traz o texto humano do que aconteceu.
 * Devolve `false` quando o nível não passa do teto — quem chamou cai então no
 * feedback simples (o toast de sempre), que NUNCA é substituído.
 */
export function anunciar(evento, detalhe = {}) {
  const assinatura = ASSINATURA[evento];
  if (!assinatura) return false;
  if (!podeAnimar(assinatura.nivel)) return false;

  for (const ouvinte of OUVINTES) {
    try {
      ouvinte({ evento, ...assinatura, ...detalhe });
    } catch {
      // Um ouvinte quebrado não derruba a operação que ele só observa.
    }
  }
  return true;
}

// ---------------------------------------------------------------- a sequência
//
// Entrada em sequência (stagger). O atraso é CALCULADO e tem teto: sem teto,
// uma lista de 600 atletas faria o último aparecer 27 segundos depois — que é
// como se transforma uma animação bonita numa tela travada.
export const ATRASO_DO_PASSO = 45;
export const TETO_DE_ATRASO = 360;

export function atrasoDaSequencia(indice) {
  if (!podeAnimar(NIVEL.TRANSICAO)) return 0;
  return Math.min(Math.max(0, indice) * ATRASO_DO_PASSO, TETO_DE_ATRASO);
}

// O estilo pronto para o elemento. Devolve objeto vazio quando não deve animar,
// para o elemento nascer NO LUGAR em vez de nascer invisível esperando efeito.
export function estiloDaSequencia(indice) {
  const atraso = atrasoDaSequencia(indice);
  return atraso ? { animationDelay: `${atraso}ms` } : {};
}

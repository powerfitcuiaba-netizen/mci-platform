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

// ------------------------------------------------------------------- os atos
//
// O ATO é o estado narrativo da tela, derivado da rota. Ele NÃO é um efeito:
// serve para dizer quanta presença aquele momento merece.
//
//   ENTRAR      abertura e login — a chegada
//   OPERAR      o dia de trabalho: rápido, preciso, sem cerimônia
//   COMPETIR    o piso do evento: palco e resultados
//   CONSAGRAR   a declaração do campeão
//
// REGRA DE SEGURANÇA: o ato só pode BAIXAR a intensidade, nunca subir. O teto
// (`tetoDeIntensidade`) continua sendo a autoridade — preferência de movimento
// e capacidade do aparelho vencem o ato sempre. Um ato capaz de elevar o nível
// viraria porta lateral para burlar a acessibilidade.
//
// Por isso o Ato III não sobe efeito nenhum: ele acrescenta PROFUNDIDADE, uma
// luz estática que não se move e não custa quadro. A diferença entre operar e
// competir se sente pelo ambiente, não por mais coisa piscando.
export const ATO = Object.freeze({
  ENTRAR: 'entrar',
  OPERAR: 'operar',
  COMPETIR: 'competir',
  CONSAGRAR: 'consagrar'
});

// As rotas do piso do evento. Curta de propósito: se metade do sistema fosse
// "competir", competir não significaria nada.
const ROTAS_DE_COMPETICAO = Object.freeze(['admin/palco', 'admin/resultados']);

export function atoDaRota(rota) {
  if (!rota) return ATO.OPERAR;
  return ROTAS_DE_COMPETICAO.some(alvo => rota === alvo || rota.startsWith(`${alvo}/`))
    ? ATO.COMPETIR
    : ATO.OPERAR;
}

// ------------------------------------------------------------- onde confirmar
//
// O NÍVEL decide a intensidade; o nível também decide ONDE o gesto acontece.
// Esta regra nasceu de um defeito real de operação: o check-in desenhava uma
// caixa no CENTRO da tela, e numa competição de 280 atletas essa caixa
// apareceria 280 vezes por cima da lista que o operador está usando — inclusive
// por cima do contador que ela mesma está comemorando.
//
//   linha   nível <= EVENTO           confirma ONDE a ação aconteceu
//   centro  nível MOMENTO             ocupa o meio da tela por alguns segundos
//   tela    nível CINEMATOGRAFICO     toma a tela inteira
//
// O centro da tela é espaço caro: quem o ocupa interrompe. Operação repetida
// nunca interrompe — ela confirma ao lado do dedo e segue.
export const POSICAO = Object.freeze({ LINHA: 'linha', CENTRO: 'centro', TELA: 'tela' });

export function posicaoDoNivel(nivel) {
  if (nivel >= NIVEL.CINEMATOGRAFICO) return POSICAO.TELA;
  if (nivel >= NIVEL.MOMENTO) return POSICAO.CENTRO;
  return POSICAO.LINHA;
}

// Cada evento declara nível e tom. `nivel` decide a intensidade; `tom` decide a
// cor, reaproveitando a paleta que o sistema já tem. `posicao` vem do nível —
// derivada, e não escrita à mão, para não existir evento de nível 3 que alguém
// marcou "centro" num descuido.
const assinatura = (nivel, tom) => ({ nivel, tom, posicao: posicaoDoNivel(nivel) });

export const ASSINATURA = Object.freeze({
  [MCIEvento.SUCESSO]: assinatura(NIVEL.EVENTO, 'sucesso'),
  [MCIEvento.AVISO]: assinatura(NIVEL.MICRO, 'atencao'),
  [MCIEvento.ERRO]: assinatura(NIVEL.MICRO, 'perigo'),
  [MCIEvento.CHECKIN]: assinatura(NIVEL.EVENTO, 'sucesso'),
  [MCIEvento.PESAGEM]: assinatura(NIVEL.EVENTO, 'sucesso'),
  [MCIEvento.CREDENCIADO]: assinatura(NIVEL.EVENTO, 'sucesso'),
  [MCIEvento.RESULTADO_PUBLICADO]: assinatura(NIVEL.MOMENTO, 'ciano'),
  [MCIEvento.AO_VIVO]: assinatura(NIVEL.MICRO, 'perigo'),
  // O único nível 5 em operação normal. Ver `MomentoCampeao`.
  [MCIEvento.CAMPEAO]: assinatura(NIVEL.CINEMATOGRAFICO, 'ouro'),
  [MCIEvento.NOVIDADE]: assinatura(NIVEL.MICRO, 'ciano')
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

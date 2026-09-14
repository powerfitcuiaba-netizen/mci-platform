// ============================================================================
// DIREÇÃO DE ÁUDIO — trilha oficial da abertura.
//
// UMA instância, um arquivo, um lugar. Não há `AudioContext` aqui de
// propósito: é uma faixa só, tocada do começo ao fim, e um `<audio>` faz isso
// com uma fração da memória e sem os problemas de ciclo de vida que um
// contexto de áudio traz (contexto suspenso, contexto por aba, contexto que
// nunca é fechado).
//
// TRÊS REGRAS QUE MANDAM AQUI:
//
//   1. A preferência da pessoa vence sempre. Som desligado significa que o
//      arquivo NEM É BAIXADO — 2,5 MB que não se pede a quem não quer ouvir.
//
//   2. A política de autoplay do navegador é respeitada, não contornada. Se
//      `play()` for recusado, a abertura continua em silêncio e a tela oferece
//      ativar o som. Nada trava esperando áudio.
//
//   3. Nunca há duas instâncias. Uma segunda chamada durante a reprodução é
//      ignorada, e não empilha uma segunda faixa por cima da primeira.
// ============================================================================

export const CHAVE_DA_PREFERENCIA = 'mci-audio-enabled';
export const CAMINHO_DA_TRILHA = '/audio/mci-opening-theme.mp3';

// 0.62: confortável para quem abre o sistema às 7h da manhã com fone de
// ouvido, e alto o bastante para a abertura ter presença numa caixa de
// notebook. A masterização da faixa é uniforme, então não há trecho que
// estoure nesse nível.
const VOLUME_ALVO = 0.62;
const ENTRADA_MS = 2600;
const SAIDA_MS = 1400;
const PASSO_MS = 50;

// `localStorage` pode lançar (aba anônima, armazenamento bloqueado). A
// preferência é conveniência: falhar em lê-la não pode derrubar a abertura.
export function preferenciaDeAudio() {
  try {
    const guardado = localStorage.getItem(CHAVE_DA_PREFERENCIA);
    // Sem escolha registrada, o padrão é COM som: é uma abertura, e quem não
    // quiser desliga num clique. A escolha passa a valer nas próximas sessões.
    return guardado === null ? true : guardado === 'true';
  } catch {
    return true;
  }
}

export function definirPreferenciaDeAudio(ativa) {
  try {
    localStorage.setItem(CHAVE_DA_PREFERENCIA, String(Boolean(ativa)));
  } catch {
    /* armazenamento indisponível: vale só para esta aba */
  }
}

export function criarElementoPadrao() {
  const elemento = new Audio();
  // `none` é o ponto: sem isto o navegador começa a baixar 2,5 MB assim que o
  // elemento existe, mesmo que a faixa nunca toque.
  elemento.preload = 'none';
  elemento.loop = false;
  return elemento;
}

class DirecaoDeAudio {
  constructor(criarElemento = criarElementoPadrao) {
    this.criarElemento = criarElemento;
    this.elemento = null;
    this.relogio = null;
    this.estadoAtual = 'parado';
  }

  estado() { return this.estadoAtual; }

  // Interrompe qualquer transição em curso. Sem isto, um fade-out iniciado
  // enquanto o fade-in ainda corre resulta nos dois disputando o volume.
  pararTransicao() {
    if (this.relogio) { clearInterval(this.relogio); this.relogio = null; }
  }

  transicionar(de, para, duracao) {
    return new Promise(resolve => {
      if (!this.elemento) { resolve(); return; }
      this.pararTransicao();

      const passos = Math.max(1, Math.round(duracao / PASSO_MS));
      let passo = 0;
      this.elemento.volume = de;

      this.relogio = setInterval(() => {
        passo += 1;
        const progresso = Math.min(1, passo / passos);
        if (this.elemento) this.elemento.volume = Math.max(0, Math.min(1, de + (para - de) * progresso));
        if (progresso >= 1) { this.pararTransicao(); resolve(); }
      }, PASSO_MS);
    });
  }

  /**
   * Toca a trilha da abertura.
   * Devolve 'tocando', 'bloqueado' (autoplay recusado), 'desligado'
   * (preferência da pessoa) ou 'indisponivel' (sem suporte a áudio).
   */
  async tocarAbertura({ ignorarPreferencia = false } = {}) {
    if (!ignorarPreferencia && !preferenciaDeAudio()) return (this.estadoAtual = 'desligado');
    // Já tocando: NÃO empilha uma segunda faixa.
    if (this.estadoAtual === 'tocando') return this.estadoAtual;

    try {
      if (!this.elemento) this.elemento = this.criarElemento();
      // O `src` só é definido agora: é aqui que o download começa, e só para
      // quem vai mesmo ouvir.
      if (!this.elemento.src) this.elemento.src = CAMINHO_DA_TRILHA;
      this.elemento.currentTime = 0;
      this.elemento.volume = 0;

      await this.elemento.play();
    } catch {
      // NotAllowedError (autoplay), NotSupportedError, rede: para a abertura é
      // tudo a mesma coisa — segue em silêncio, e a tela oferece ativar.
      return (this.estadoAtual = 'bloqueado');
    }

    this.estadoAtual = 'tocando';
    // A entrada é cinematográfica: de 0 ao volume alvo ao longo da abertura,
    // em vez de começar no volume cheio.
    this.transicionar(0, VOLUME_ALVO, ENTRADA_MS);
    return this.estadoAtual;
  }

  // Encerra com fade-out, para a transição para o sistema não ter corte seco
  // nem estalo.
  async encerrar({ imediato = false } = {}) {
    if (!this.elemento) { this.estadoAtual = 'parado'; return; }

    if (!imediato && this.estadoAtual === 'tocando') {
      await this.transicionar(this.elemento.volume, 0, SAIDA_MS);
    }
    this.pararTransicao();

    try {
      this.elemento.pause();
      // Solta o buffer: sem isto o arquivo decodificado fica na memória da aba
      // por toda a sessão, depois de já ter tocado uma vez.
      this.elemento.removeAttribute('src');
      this.elemento.load();
    } catch {
      /* elemento já descartado */
    }
    this.elemento = null;
    this.estadoAtual = 'parado';
  }

  silenciar() {
    definirPreferenciaDeAudio(false);
    return this.encerrar({ imediato: true });
  }
}

// A instância única da aplicação. Importar este módulo duas vezes devolve a
// mesma direção — é o que impede duas faixas tocando juntas.
export const direcaoDeAudio = new DirecaoDeAudio();

// Exportada só para os testes poderem criar uma direção com elemento falso.
export { DirecaoDeAudio };

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NIVEL, MCIEvento, ASSINATURA, podeAnimar, tetoDeIntensidade, prefereMenosMovimento,
  anunciar, ouvirExperiencia, atrasoDaSequencia, estiloDaSequencia, TETO_DE_ATRASO,
  ATO, atoDaRota
} from './experiencia';

// ==========================================================================
// O MOTOR DE EXPERIÊNCIA.
//
// O que se trava aqui é o que faz um sistema animado virar um sistema lento:
// efeito que ignora a preferência de movimento, sequência sem teto que empilha
// atraso em lista grande, e celebração que acontece quando não devia.
// ==========================================================================

const comMovimentoReduzido = reduzido => {
  window.matchMedia = vi.fn(() => ({ matches: reduzido, addEventListener() {}, removeEventListener() {} }));
};

beforeEach(() => { comMovimentoReduzido(false); });

describe('teto de intensidade', () => {
  it('sem restrição, tudo é permitido', () => {
    expect(tetoDeIntensidade()).toBe(NIVEL.CINEMATOGRAFICO);
    expect(podeAnimar(NIVEL.CINEMATOGRAFICO)).toBe(true);
  });

  // A preferência do sistema vence qualquer efeito. É a regra que impede a
  // fase inteira de virar um problema de acessibilidade.
  it('movimento reduzido derruba o teto para MICRO', () => {
    comMovimentoReduzido(true);
    expect(tetoDeIntensidade()).toBe(NIVEL.MICRO);
    expect(podeAnimar(NIVEL.MICRO)).toBe(true);
    expect(podeAnimar(NIVEL.TRANSICAO)).toBe(false);
    expect(podeAnimar(NIVEL.CINEMATOGRAFICO)).toBe(false);
  });

  it('matchMedia ausente não derruba nada', () => {
    window.matchMedia = undefined;
    expect(() => prefereMenosMovimento()).not.toThrow();
    expect(prefereMenosMovimento()).toBe(false);
  });

  // Celular fraco não recebe partícula, mas continua com transição: cortar
  // tudo deixaria a interface sem resposta nenhuma ao toque.
  it('dispositivo declaradamente fraco perde os níveis caros, não todos', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { deviceMemory: 2, hardwareConcurrency: 2 }
    });
    try {
      expect(tetoDeIntensidade()).toBe(NIVEL.TRANSICAO);
      expect(podeAnimar(NIVEL.TRANSICAO)).toBe(true);
      expect(podeAnimar(NIVEL.CINEMATOGRAFICO), 'celular fraco recebeu partícula').toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', real);
    }
  });
});

describe('sequência de entrada', () => {
  it('o atraso cresce por item', () => {
    expect(atrasoDaSequencia(0)).toBe(0);
    expect(atrasoDaSequencia(1)).toBeGreaterThan(0);
    expect(atrasoDaSequencia(3)).toBeGreaterThan(atrasoDaSequencia(1));
  });

  // O ponto: uma lista de 600 atletas faria o último entrar 27 segundos depois.
  // É assim que uma animação bonita vira uma tela travada.
  it('o atraso TEM TETO — lista grande não empilha', () => {
    expect(atrasoDaSequencia(600)).toBe(TETO_DE_ATRASO);
    expect(atrasoDaSequencia(10000)).toBe(TETO_DE_ATRASO);
    expect(TETO_DE_ATRASO).toBeLessThanOrEqual(400);
  });

  it('com movimento reduzido não há atraso nenhum', () => {
    comMovimentoReduzido(true);
    expect(atrasoDaSequencia(5)).toBe(0);
    // E o estilo sai VAZIO: o elemento nasce no lugar, e não invisível
    // esperando uma animação que não vai acontecer.
    expect(estiloDaSequencia(5)).toEqual({});
  });

  it('índice negativo não vira atraso negativo', () => {
    expect(atrasoDaSequencia(-3)).toBe(0);
  });
});

describe('anúncio de momentos', () => {
  it('entrega o momento a quem estiver ouvindo', () => {
    const ouvinte = vi.fn();
    const parar = ouvirExperiencia(ouvinte);
    try {
      expect(anunciar(MCIEvento.CREDENCIADO, { titulo: 'Atleta credenciado' })).toBe(true);
      expect(ouvinte).toHaveBeenCalledTimes(1);
      const momento = ouvinte.mock.calls[0][0];
      expect(momento.evento).toBe(MCIEvento.CREDENCIADO);
      expect(momento.nivel).toBe(NIVEL.EVENTO);
      expect(momento.titulo).toBe('Atleta credenciado');
    } finally { parar(); }
  });

  it('parar de ouvir realmente para', () => {
    const ouvinte = vi.fn();
    ouvirExperiencia(ouvinte)();
    anunciar(MCIEvento.SUCESSO);
    expect(ouvinte).not.toHaveBeenCalled();
  });

  // O anúncio é observação, não regra de negócio: um ouvinte quebrado não pode
  // derrubar a operação que acabou de dar certo.
  it('ouvinte que lança NÃO derruba o anúncio nem os outros ouvintes', () => {
    const bom = vi.fn();
    const parar1 = ouvirExperiencia(() => { throw new Error('quebrei'); });
    const parar2 = ouvirExperiencia(bom);
    try {
      expect(() => anunciar(MCIEvento.SUCESSO)).not.toThrow();
      expect(bom).toHaveBeenCalled();
    } finally { parar1(); parar2(); }
  });

  it('evento desconhecido não anuncia nada', () => {
    const ouvinte = vi.fn();
    const parar = ouvirExperiencia(ouvinte);
    try {
      expect(anunciar('inventado')).toBe(false);
      expect(ouvinte).not.toHaveBeenCalled();
    } finally { parar(); }
  });

  // O caso que importa para acessibilidade: com movimento reduzido a
  // celebração NÃO acontece, e quem chamou recebe `false` para cair no
  // feedback simples — que nunca é substituído.
  it('com movimento reduzido, o campeão não sobe ao palco e o chamador sabe', () => {
    comMovimentoReduzido(true);
    const ouvinte = vi.fn();
    const parar = ouvirExperiencia(ouvinte);
    try {
      expect(anunciar(MCIEvento.CAMPEAO, { nome: 'Carlos' })).toBe(false);
      expect(ouvinte).not.toHaveBeenCalled();
      // Mas um aviso de nível MICRO continua passando.
      expect(anunciar(MCIEvento.ERRO)).toBe(true);
    } finally { parar(); }
  });
});

describe('as assinaturas', () => {
  it('todo evento declarado tem nível e tom', () => {
    for (const evento of Object.values(MCIEvento)) {
      expect(ASSINATURA[evento], `${evento} sem assinatura`).toBeTruthy();
      expect(ASSINATURA[evento].nivel).toBeTypeOf('number');
      expect(ASSINATURA[evento].tom).toBeTypeOf('string');
    }
  });

  // A decisão de produto mais importante desta fase: o campeão é raro. Se
  // outro evento subir para o nível 5, o efeito deixa de significar campeão.
  it('CAMPEÃO é o ÚNICO nível 5 da operação', () => {
    const cinematograficos = Object.entries(ASSINATURA)
      .filter(([, a]) => a.nivel === NIVEL.CINEMATOGRAFICO)
      .map(([evento]) => evento);
    expect(cinematograficos).toEqual([MCIEvento.CAMPEAO]);
  });

  it('nenhuma operação rotineira passa do nível EVENTO', () => {
    for (const evento of [MCIEvento.SUCESSO, MCIEvento.CHECKIN, MCIEvento.PESAGEM, MCIEvento.CREDENCIADO, MCIEvento.AVISO, MCIEvento.ERRO, MCIEvento.NOVIDADE, MCIEvento.AO_VIVO]) {
      expect(ASSINATURA[evento].nivel, `${evento} está caro demais`).toBeLessThanOrEqual(NIVEL.EVENTO);
    }
  });
});

// ==========================================================================
// OS ATOS.
//
// A regra que mais importa aqui não é qual rota é qual ato — é que o ato SÓ
// PODE BAIXAR a intensidade. Um ato capaz de elevar o nível viraria porta
// lateral para burlar a preferência de movimento e o aparelho fraco.
// ==========================================================================
describe('os atos', () => {
  it('palco e resultados são o piso do evento', () => {
    expect(atoDaRota('admin/palco')).toBe(ATO.COMPETIR);
    expect(atoDaRota('admin/resultados')).toBe(ATO.COMPETIR);
    expect(atoDaRota('admin/palco/b1')).toBe(ATO.COMPETIR);
  });

  it('o resto do sistema é operar — e isso é de propósito', () => {
    for (const rota of ['', 'inicio', 'campeonatos', 'atletas', 'admin', 'admin/checkin',
                        'admin/pesagem', 'admin/credenciamento', 'admin/inscricoes',
                        'social', 'messenger', 'ranking']) {
      expect(atoDaRota(rota), rota).toBe(ATO.OPERAR);
    }
  });

  it('uma rota que só COMEÇA parecida não vira competição', () => {
    // "admin/resultados-antigos" não é a tela de resultados.
    expect(atoDaRota('admin/resultados-antigos')).toBe(ATO.OPERAR);
    expect(atoDaRota('admin/palcox')).toBe(ATO.OPERAR);
  });

  it('rota ausente não quebra', () => {
    expect(atoDaRota(undefined)).toBe(ATO.OPERAR);
    expect(atoDaRota(null)).toBe(ATO.OPERAR);
  });

  it('o ato NÃO participa do teto de intensidade — só o motor decide', () => {
    // A garantia estrutural: `atoDaRota` é função pura da rota e não toca em
    // `tetoDeIntensidade`. Se um dia alguém ligar os dois, este teste é o lugar
    // onde a conversa acontece.
    const fonte = atoDaRota.toString();
    expect(fonte).not.toMatch(/teto|podeAnimar|NIVEL/i);
  });
});

import { describe, it, expect } from 'vitest';
import { dicaDeResultadosPublicados } from './format';
import { traduzir } from './idioma';

// ============================================================================
// A LEGENDA DO CARTÃO "RESULTADOS PUBLICADOS".
//
// O cartão marcava zero com o ledger cheio porque contava só a apuração
// recebida pelo MCI. Corrigido o número, ficou a segunda metade do problema: um
// total sozinho não diz de onde ele vem, e foi essa opacidade que transformou
// "o cartão está errado" em uma investigação.
//
// Esta legenda é a explicação na tela. O que se cobra aqui é que ela apareça
// quando há o que dizer, e SOMENTE quando há — legenda que repete o número é
// ruído, e o cartão tem três deles do lado.
// ============================================================================

const t = (chave, valores) => traduzir('pt-BR', chave, valores);

describe('legenda de composição do cartão', () => {
  it('o histórico importado aparece, porque era a metade invisível', () => {
    expect(dicaDeResultadosPublicados({ received: 0, imported: 191 }, t))
      .toBe('191 do histórico importado');
  });

  it('com as duas origens, a legenda fala da importada', () => {
    // Uma linha só, e ela cita a parte que o operador não tinha como ver. O
    // total já está no cartão; repetir a soma não acrescenta nada.
    expect(dicaDeResultadosPublicados({ received: 12, imported: 191 }, t))
      .toBe('191 do histórico importado');
  });

  it('sem histórico importado, a legenda fala da apuração recebida', () => {
    expect(dicaDeResultadosPublicados({ received: 12, imported: 0 }, t))
      .toBe('12 apurados no MCI');
  });

  it('sem resultado nenhum, não há legenda', () => {
    expect(dicaDeResultadosPublicados({ received: 0, imported: 0 }, t)).toBeNull();
  });

  it('a composição ausente não quebra o cartão', () => {
    // O endpoint pode estar em versão anterior durante um deploy, e o cartão
    // precisa renderizar o total sem legenda em vez de estourar.
    expect(dicaDeResultadosPublicados(undefined, t)).toBeNull();
    expect(dicaDeResultadosPublicados(null, t)).toBeNull();
    expect(dicaDeResultadosPublicados({}, t)).toBeNull();
  });

  it('as três traduções existem e interpolam o número', () => {
    for (const idioma of ['pt-BR', 'en', 'es']) {
      const frase = traduzir(idioma, 'publico.resultadosDoHistorico', { n: 191 });
      // Recuo em cascata devolve a própria chave quando a tradução falta: ver a
      // chave na tela é o sintoma, e é ele que esta asserção recusa.
      expect(frase, idioma).not.toBe('publico.resultadosDoHistorico');
      expect(frase, idioma).toContain('191');
      expect(traduzir(idioma, 'publico.resultadosRecebidos', { n: 12 }), idioma).toContain('12');
    }
  });
});

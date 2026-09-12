import { describe, it, expect } from 'vitest';
import { aconteceHoje, seloDoEvento } from './format';

// ==========================================================================
// O selo do evento no dia da competição.
//
// A regra é de APRESENTAÇÃO, e não de estado: nada no banco muda sozinho. Um
// evento só está "em operação" quando alguém o colocou lá, porque esse estado
// libera check-in, pesagem, credencial e palco. O que a tela faz é dizer a
// verdade sobre o dia de hoje.
// ==========================================================================

const evento = (extra = {}) => ({
  status: 'PLANNED',
  timezone: 'America/Sao_Paulo',
  startDate: '2026-11-14T12:00:00.000Z',
  endDate: '2026-11-14T12:00:00.000Z',
  ...extra
});

const AGORA_NO_DIA = new Date('2026-11-14T15:00:00.000Z');
const AGORA_ANTES  = new Date('2026-11-10T15:00:00.000Z');
const AGORA_DEPOIS = new Date('2026-11-20T15:00:00.000Z');

describe('aconteceHoje', () => {
  it('reconhece o dia do evento', () => {
    expect(aconteceHoje(evento(), AGORA_NO_DIA)).toBe(true);
    expect(aconteceHoje(evento(), AGORA_ANTES)).toBe(false);
    expect(aconteceHoje(evento(), AGORA_DEPOIS)).toBe(false);
  });

  it('cobre o intervalo inteiro de um evento de dois dias', () => {
    const fitPira = evento({ startDate: '2026-11-07T12:00:00.000Z', endDate: '2026-11-08T12:00:00.000Z' });
    expect(aconteceHoje(fitPira, new Date('2026-11-07T18:00:00.000Z'))).toBe(true);
    expect(aconteceHoje(fitPira, new Date('2026-11-08T18:00:00.000Z'))).toBe(true);
    expect(aconteceHoje(fitPira, new Date('2026-11-09T18:00:00.000Z'))).toBe(false);
  });

  // O caso que decide: às 03h30 UTC de 15/11 já é dia 15 em São Paulo, mas
  // ainda é dia 14 em Manaus. Comparar em UTC apagaria o selo do evento de
  // Manaus enquanto ele ainda está acontecendo.
  it('usa o fuso DO EVENTO, não o do servidor nem o do navegador', () => {
    const meia_noite_e_meia_em_sp = new Date('2026-11-15T03:30:00.000Z');
    expect(aconteceHoje(evento({ timezone: 'America/Manaus' }), meia_noite_e_meia_em_sp)).toBe(true);
    expect(aconteceHoje(evento({ timezone: 'America/Sao_Paulo' }), meia_noite_e_meia_em_sp)).toBe(false);
  });

  it('evento sem data não acontece hoje', () => {
    expect(aconteceHoje({ status: 'PLANNED', startDate: null, endDate: null }, AGORA_NO_DIA)).toBe(false);
  });
});

describe('seloDoEvento', () => {
  it('fora do dia, mostra o estado como sempre mostrou', () => {
    const selo = seloDoEvento(evento(), AGORA_ANTES);
    expect(selo.rotulo).toBe('Planejado');
    expect(selo.aoVivo).toBe(false);
  });

  it('no dia, um evento que ainda não começou vira "Hoje" — isso é recado para o operador', () => {
    const selo = seloDoEvento(evento(), AGORA_NO_DIA);
    expect(selo.rotulo).toBe('Hoje');
    expect(selo.aoVivo).toBe(true);
  });

  it('no dia e em operação, vira "Ao vivo"', () => {
    for (const status of ['IN_OPERATION', 'IN_JUDGING']) {
      const selo = seloDoEvento(evento({ status }), AGORA_NO_DIA);
      expect(selo.rotulo, status).toBe('Ao vivo');
      expect(selo.aoVivo, status).toBe(true);
      expect(selo.tom, status).toBe('perigo');
    }
  });

  // Sem isto, uma etapa esquecida em IN_OPERATION pulsaria "ao vivo" para
  // sempre, e o selo perderia todo o significado.
  it('em operação mas fora do dia NÃO pulsa: mostra o estado real', () => {
    const selo = seloDoEvento(evento({ status: 'IN_OPERATION' }), AGORA_DEPOIS);
    expect(selo.rotulo).toBe('Em operação');
    expect(selo.aoVivo).toBe(false);
  });

  it('evento cancelado no dia continua cancelado — nunca "hoje"', () => {
    const selo = seloDoEvento(evento({ status: 'CANCELLED' }), AGORA_NO_DIA);
    expect(selo.rotulo).toBe('Cancelado');
    expect(selo.aoVivo).toBe(false);
  });

  it('rascunho no dia não vaza como "hoje": rascunho nem é público', () => {
    expect(seloDoEvento(evento({ status: 'DRAFT' }), AGORA_NO_DIA).rotulo).toBe('Rascunho');
  });

  it('resultado já publicado no dia não volta a "hoje"', () => {
    for (const status of ['RESULTS_IN_REVIEW', 'RESULTS_PUBLISHED', 'CLOSED']) {
      expect(seloDoEvento(evento({ status }), AGORA_NO_DIA).aoVivo, status).toBe(false);
    }
  });

  it('inscrições abertas no dia do evento também viram "Hoje"', () => {
    const selo = seloDoEvento(evento({ status: 'REGISTRATIONS_CLOSED' }), AGORA_NO_DIA);
    expect(selo.rotulo).toBe('Hoje');
    expect(selo.aoVivo).toBe(true);
  });
});

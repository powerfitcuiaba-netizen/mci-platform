import { describe, it, expect } from 'vitest';
import { iniciais, mascararCpf, pesoEmKg, somenteDigitos, TRANSICOES_EVENTO, ESTADO_EVENTO, desde } from './format';

describe('formatação', () => {
  it('monta iniciais a partir das duas primeiras palavras', () => {
    expect(iniciais('Ana Paula Souza')).toBe('AP');
    expect(iniciais('Bruno')).toBe('B');
    expect(iniciais('')).toBe('?');
  });

  it('mascara o CPF conforme o usuário digita, sem passar de 11 dígitos', () => {
    expect(mascararCpf('111')).toBe('111');
    expect(mascararCpf('111444')).toBe('111.444');
    expect(mascararCpf('11144477735')).toBe('111.444.777-35');
    expect(mascararCpf('111444777359999')).toBe('111.444.777-35');
  });

  it('converte gramas em quilos com vírgula decimal', () => {
    expect(pesoEmKg(58400)).toBe('58,40 kg');
    expect(pesoEmKg(null)).toBe('—');
  });

  it('extrai apenas dígitos', () => {
    expect(somenteDigitos('111.444.777-35')).toBe('11144477735');
    expect(somenteDigitos(null)).toBe('');
  });

  it('descreve momento relativo em português', () => {
    expect(desde(new Date().toISOString())).toBe('agora');
    expect(desde(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min');
    expect(desde(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3 h');
  });

  it('não devolve data para valor ausente', () => {
    expect(desde(null)).toBe('');
  });
});

describe('máquina de estados exibida na interface', () => {
  it('cobre todos os estados do evento com rótulo', () => {
    for (const estado of Object.keys(TRANSICOES_EVENTO)) {
      expect(ESTADO_EVENTO[estado], estado).toBeDefined();
    }
  });

  it('não oferece caminho que o servidor recusaria', () => {
    // Espelho da máquina de estados do backend: publicar direto do rascunho
    // não é transição válida, e a interface não pode sugerir isso.
    expect(TRANSICOES_EVENTO.DRAFT).not.toContain('RESULTS_PUBLISHED');
    expect(TRANSICOES_EVENTO.REGISTRATIONS_OPEN).not.toContain('IN_JUDGING');
    expect(TRANSICOES_EVENTO.RESULTS_PUBLISHED).toEqual(['CLOSED']);
    expect(TRANSICOES_EVENTO.CLOSED).toEqual([]);
    expect(TRANSICOES_EVENTO.CANCELLED).toEqual([]);
  });
});

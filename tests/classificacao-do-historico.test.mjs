import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { classificar, CLASSES } = require_('../scripts/diagnostico-historico-por-filiacao.js');

// ============================================================================
// A CLASSIFICAÇÃO DO HISTÓRICO ÓRFÃO — a regra, sem banco.
//
// Antes de religar um resultado a um atleta é preciso dizer, sem adivinhar, em
// qual dos cinco estados ele está. A decisão é pura: depende só do que a
// identidade tem (entidade, número, dono) e de quantos cadastros existem com
// aquele par. Por ser pura, ela se prova aqui, em milissegundos, sem PostgreSQL
// — e o script que roda contra produção usa EXATAMENTE esta função.
//
// O QUE ESTE ARQUIVO PROTEGE
//
// A tentação, num backfill, é "religar o que der". A classe AMBIGUOUS existe
// para dizer não: dois cadastros com o mesmo par é um erro de cadastro, e
// escolher um deles por semelhança de nome credita a carreira de alguém a
// outra pessoa — um estrago que nenhuma revisão posterior desfaz, porque o
// histórico original já não existe para comparar.
// ============================================================================

const NPC = 'aff_npc';
const pares = entradas => new Map(entradas);

describe('as cinco classes do histórico importado', () => {
  it('já tem dono: ALREADY_LINKED, e nada mais é perguntado', () => {
    const identidade = { athleteId: 'atl_1', affiliationId: NPC, affiliationNumber: '2932' };
    // Mesmo havendo dois candidatos, quem já tem dono não é candidato a nada.
    const candidatos = pares([[`${NPC}:2932`, [{ id: 'a' }, { id: 'b' }]]]);
    expect(classificar(identidade, candidatos)).toBe('ALREADY_LINKED');
  });

  it('par completo e UM cadastro: MATCHABLE', () => {
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: '2932' };
    const candidatos = pares([[`${NPC}:2932`, [{ id: 'atl_1', fullName: 'Lucas Alves Soares' }]]]);
    expect(classificar(identidade, candidatos)).toBe('MATCHABLE');
  });

  it('par completo e DOIS cadastros: AMBIGUOUS — ninguém escolhe por semelhança', () => {
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: '2932' };
    const candidatos = pares([[`${NPC}:2932`, [
      { id: 'atl_1', fullName: 'Lucas Alves Soares' },
      { id: 'atl_2', fullName: 'Lucas A. Soares' }
    ]]]);
    // Os nomes são parecidíssimos. Isso NÃO é desempate: é exatamente o caso
    // em que escolher o "mais parecido" credita o resultado ao atleta errado.
    expect(classificar(identidade, candidatos)).toBe('AMBIGUOUS');
  });

  it('par completo e NENHUM cadastro: NO_CANDIDATE — é o caminho normal', () => {
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: '2932' };
    // Histórico carregado antes de existir cadastro é para o que o MCI foi
    // construído. Não é defeito: resolve-se sozinho quando o atleta aparecer.
    expect(classificar(identidade, pares([]))).toBe('NO_CANDIDATE');
  });

  it('sem número: MISSING_NUMBER, mesmo com entidade', () => {
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: null };
    expect(classificar(identidade, pares([]))).toBe('MISSING_NUMBER');
  });

  it('sem entidade: MISSING_NUMBER, mesmo com número', () => {
    const identidade = { athleteId: null, affiliationId: null, affiliationNumber: '2932' };
    // Número sem federação não identifica: duas federações emitem o mesmo.
    expect(classificar(identidade, pares([]))).toBe('MISSING_NUMBER');
  });

  it('número vazio não é número', () => {
    for (const vazio of [null, undefined, '']) {
      const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: vazio };
      expect(classificar(identidade, pares([]))).toBe('MISSING_NUMBER');
    }
  });

  it('o número é comparado como TEXTO: 02932 não é 2932', () => {
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: '02932' };
    // Só existe cadastro para "2932". Se a comparação virasse número, os dois
    // se fundiriam — e fundir dois atletas apaga a carreira de um deles.
    const candidatos = pares([[`${NPC}:2932`, [{ id: 'atl_1' }]]]);
    expect(classificar(identidade, candidatos)).toBe('NO_CANDIDATE');
  });

  it('a entidade faz parte da chave: o mesmo número em outra federação não casa', () => {
    const identidade = { athleteId: null, affiliationId: 'aff_outra', affiliationNumber: '2932' };
    const candidatos = pares([[`${NPC}:2932`, [{ id: 'atl_1' }]]]);
    expect(classificar(identidade, candidatos)).toBe('NO_CANDIDATE');
  });

  it('nome NÃO entra na decisão — nem é lido', () => {
    // A identidade nem sequer carrega nome aqui, e a classificação funciona.
    // Se o nome tivesse qualquer papel, esta chamada quebraria.
    const identidade = { athleteId: null, affiliationId: NPC, affiliationNumber: '2932' };
    const candidatos = pares([[`${NPC}:2932`, [{ id: 'atl_1' }]]]);
    expect(classificar(identidade, candidatos)).toBe('MATCHABLE');
  });

  it('toda classe devolvida pertence à lista declarada', () => {
    const casos = [
      { athleteId: 'x', affiliationId: NPC, affiliationNumber: '1' },
      { athleteId: null, affiliationId: NPC, affiliationNumber: '1' },
      { athleteId: null, affiliationId: null, affiliationNumber: '1' },
      { athleteId: null, affiliationId: NPC, affiliationNumber: null }
    ];
    const candidatos = pares([[`${NPC}:1`, [{ id: 'a' }]]]);
    for (const caso of casos) expect(CLASSES).toContain(classificar(caso, candidatos));
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { escolherModo } = require_('../scripts/lib/ator.js');

// ============================================================================
// O ATOR DO DIAGNÓSTICO, RESOLVIDO POR E-MAIL — a regra, sem banco.
//
// POR QUE ISTO EXISTE
//
// Os diagnósticos rodam sob RLS, e RLS precisa de um ator. Até aqui o operador
// tinha que descobrir o próprio UUID na mão, e a interface não o mostra —
// investigar um problema virava caçar um identificador interno.
//
// A escolha entre "--ator <uuid>" e "--email <e-mail>" é decisão PURA: só
// depende do que foi digitado. Por ser pura, prova-se aqui em milissegundos, e
// é a mesma função que os dois scripts usam contra produção.
//
// O QUE ESTE ARQUIVO PROTEGE
//
// Os dois juntos. Se alguém passar `--ator` E `--email`, qual deles manda não
// está dito em lugar nenhum — e um script de diagnóstico que escolhe sozinho,
// em silêncio, pode rodar com as permissões da conta errada e produzir um
// relatório que parece verdadeiro e não é. Recusar é a única resposta honesta.
// ============================================================================

describe('como o diagnóstico decide quem é o ator', () => {
  it('só o e-mail: modo EMAIL, em minúsculas', () => {
    expect(escolherModo({ email: 'Falcao@Exemplo.COM' }))
      .toEqual({ modo: 'EMAIL', valor: 'falcao@exemplo.com' });
  });

  it('e-mail com espaço em volta é aparado', () => {
    expect(escolherModo({ email: '  falcao@exemplo.com  ' }).valor).toBe('falcao@exemplo.com');
  });

  it('só o identificador: modo ID, preservado como veio', () => {
    // O id NÃO é passado para minúsculas: cuid e uuid distinguem caixa, e
    // "normalizar" um identificador opaco é inventar um identificador diferente.
    expect(escolherModo({ ator: 'cKx9AbC123' })).toEqual({ modo: 'ID', valor: 'cKx9AbC123' });
  });

  it('OS DOIS JUNTOS É RECUSA — não se escolhe em silêncio', () => {
    const r = escolherModo({ ator: 'abc', email: 'falcao@exemplo.com' });
    expect(r.erro).toBeTruthy();
    expect(r.modo).toBeUndefined();
    expect(r.erro).toMatch(/nunca os dois/i);
  });

  it('nenhum dos dois: recusa, e a mensagem ensina o caminho curto', () => {
    const r = escolherModo({});
    expect(r.erro).toBeTruthy();
    // A mensagem precisa oferecer o e-mail PRIMEIRO: é o que o operador sabe
    // de cabeça. O UUID vem depois, entre parênteses, para quem já o tem.
    expect(r.erro).toMatch(/--email/);
  });

  it('texto que não é e-mail é recusado antes de chegar ao banco', () => {
    const r = escolherModo({ email: 'falcao' });
    expect(r.erro).toMatch(/não parece um e-mail/i);
  });

  it('e-mail vazio não vira consulta', () => {
    for (const vazio of ['', '   ', null, undefined]) {
      expect(escolherModo({ email: vazio }).erro, `para ${JSON.stringify(vazio)}`).toBeTruthy();
    }
  });

  it('a decisão NUNCA devolve modo e erro ao mesmo tempo', () => {
    const casos = [
      {}, { email: 'a@b.c' }, { ator: 'x' }, { ator: 'x', email: 'a@b.c' },
      { email: 'nao-e-email' }, { email: '' }
    ];
    for (const caso of casos) {
      const r = escolherModo(caso);
      expect(Boolean(r.erro) !== Boolean(r.modo), JSON.stringify(caso)).toBe(true);
    }
  });
});

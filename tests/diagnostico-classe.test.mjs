import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ==========================================================================
// O DIAGNÓSTICO É RODADO CONTRA PRODUÇÃO. TRÊS COISAS PRECISAM SER VERDADE.
//
// `scripts/diagnostico-classe.sql` responde as oito perguntas do GATE 20
// sobre os lançamentos históricos antes de qualquer reparo ser autorizado.
// Quem o roda aponta para a base real da federação.
//
// 1. ELE NÃO PODE ESCREVER. Um UPDATE que entre nesse arquivo por descuido é
//    executado em produção por alguém que leu "somente leitura" no cabeçalho
//    e confiou. A conferência é de COMANDO, não de intenção.
//
// 2. ELE NÃO PODE SELECIONAR DADO DE PESSOA. Diagnóstico circula: vai para
//    chat, para e-mail, para captura de tela. CPF, telefone, e-mail e data de
//    nascimento não têm recorte onde aparecer numa pergunta sobre classe.
//
// 3. ELE PRECISA DIZER QUEM PERGUNTOU. Sob FORCE ROW LEVEL SECURITY, uma
//    conexão sem contexto de ator devolve ZERO LINHA — e zero lido como
//    "não existe" é a falsa aprovação mais cara que esta base pode produzir.
//    A PARTE 0 existe para que a saída diga em qual dos dois casos está.
// ==========================================================================

const ARQUIVO = path.join(process.cwd(), 'scripts', 'diagnostico-classe.sql');
const sql = readFileSync(ARQUIVO, 'utf8');

// Linhas de comando de verdade: sem comentário de linha inteira e sem `\echo`.
const linhasDeComando = sql
  .split('\n')
  .map(linha => linha.trim())
  .filter(linha => linha && !linha.startsWith('--') && !linha.startsWith('\\echo'));

describe('o diagnóstico de classe é somente leitura', () => {
  it('não contém nenhum comando de escrita ou de esquema', () => {
    const proibidos = [
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'DROP', 'ALTER',
      'CREATE', 'GRANT', 'REVOKE', 'COPY', 'MERGE', 'REINDEX', 'VACUUM'
    ];

    const encontrados = [];
    for (const linha of linhasDeComando) {
      for (const comando of proibidos) {
        // Palavra inteira: "DELETE" pega, "deleted_at" não.
        if (new RegExp(`\\b${comando}\\b`, 'i').test(linha)) encontrados.push(`${comando} em: ${linha}`);
      }
    }

    expect(encontrados, encontrados.join('\n')).toEqual([]);
  });

  it('não abre transação — um diagnóstico esquecido aberto trava produção', () => {
    // NAS LINHAS DE COMANDO, e não no arquivo inteiro: o cabeçalho diz, em
    // português, que não há BEGIN aqui — e uma busca no texto cru acusaria
    // exatamente a frase que promete o contrário do que ela acusa.
    const comandos = linhasDeComando.join('\n').toUpperCase();
    for (const proibido of ['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION', 'LOCK']) {
      expect(comandos, proibido).not.toContain(proibido);
    }
  });

  it('toda instrução é SELECT', () => {
    // Primeira palavra de cada comando terminado em ";".
    const comandos = linhasDeComando.join(' ').split(';').map(c => c.trim()).filter(Boolean);
    expect(comandos.length, 'há comandos a conferir').toBeGreaterThan(4);
    for (const comando of comandos) {
      expect(comando.slice(0, 6).toUpperCase(), comando.slice(0, 80)).toBe('SELECT');
    }
  });

  it('não seleciona CPF, telefone, e-mail nem data de nascimento', () => {
    const sensiveis = ['cpf', 'phone', 'telefone', 'email', 'birthdate', 'birth_date'];
    for (const campo of sensiveis) {
      const achados = linhasDeComando.filter(linha => new RegExp(`\\b"?${campo}"?\\b`, 'i').test(linha));
      expect(achados, `${campo} aparece em: ${achados.join(' | ')}`).toEqual([]);
    }
  });

  it('a PARTE 0 pergunta quem está conectado e se o RLS está em vigor', () => {
    expect(sql).toContain('current_user');
    expect(sql).toContain('rolbypassrls');
    expect(sql).toContain('relforcerowsecurity');
  });

  it('confere as duas regras de unicidade do catálogo, que são SQL escrito à mão', () => {
    // Índice parcial não é expresso pelo Prisma: ele vive só na migration, e
    // some sem aviso no primeiro `db push`. O diagnóstico o lista para que a
    // ausência apareça na saída, e não numa duplicata meses depois.
    expect(sql).toContain('pg_indexes');
    expect(sql).toContain("tablename = 'ClassCatalog'");
  });
});

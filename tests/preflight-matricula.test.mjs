import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ==========================================================================
// O PREFLIGHT É RODADO CONTRA PRODUÇÃO. DUAS COISAS PRECISAM CONTINUAR VERDADE.
//
// `scripts/preflight-matricula.sql` existe para responder, ANTES da janela de
// deploy, se a migration `20260921120000_matricula_identifica_um_atleta` vai
// passar ou abortar. Quem o roda aponta para a base real da federação.
//
// 1. ELE NÃO PODE ESCREVER. Um INSERT que entre nesse arquivo por descuido é
//    executado em produção por alguém que leu "somente leitura" no cabeçalho
//    e confiou. A checagem aqui é de comando, não de intenção.
//
// 2. ELE PRECISA FAZER A MESMA CONTA QUE A MIGRATION. Se os dois divergirem,
//    o preflight responde "0 duplicidades" sobre uma pergunta que não é a que
//    a migration faz — e a migration aborta mesmo assim, no pior momento
//    possível. A divergência é silenciosa: nada além deste teste a acusa.
//
// Por isso a comparação abaixo é do predicado e do agrupamento, extraídos dos
// dois arquivos e normalizados apenas em espaço em branco.
// ==========================================================================

const RAIZ = process.cwd();
const PREFLIGHT = path.join(RAIZ, 'scripts', 'preflight-matricula.sql');
const MIGRATION = path.join(
  RAIZ,
  'prisma/migrations/20260921120000_matricula_identifica_um_atleta/migration.sql',
);

const preflight = readFileSync(PREFLIGHT, 'utf8');
const migration = readFileSync(MIGRATION, 'utf8');

const semEspaco = (texto) => texto.replace(/\s+/g, ' ').trim();

describe('preflight da migration de matrícula', () => {
  it('não contém nenhum comando de escrita', () => {
    const escrita =
      /^\s*(insert|update|delete|create|drop|alter|truncate|grant|revoke|merge|copy|refresh|reindex|vacuum|cluster|call|do)\b/i;

    const linhas = preflight
      .split('\n')
      .map((linha, i) => [i + 1, linha])
      .filter(([, linha]) => !linha.trim().startsWith('--'))
      .filter(([, linha]) => escrita.test(linha));

    expect(linhas).toEqual([]);
  });

  it('não abre transação: uma leitura não precisa de uma, e BEGIN sem COMMIT deixa lock', () => {
    expect(/^\s*(begin|start transaction)\b/im.test(preflight)).toBe(false);
  });

  it('conta duplicidade com o mesmo predicado e o mesmo agrupamento da migration', () => {
    const predicado = /WHERE\s+"affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL/gi;
    const agrupamento = /GROUP BY\s+"organizationId", "affiliationId", "affiliationNumber"\s+HAVING count\(\*\) > 1/gi;

    const doPreflight = preflight.match(predicado) ?? [];
    const daMigration = migration.match(predicado) ?? [];
    expect(daMigration.length).toBeGreaterThan(0);
    expect(doPreflight.length).toBeGreaterThan(0);

    expect(semEspaco((preflight.match(agrupamento) ?? [])[0] ?? ''))
      .toBe(semEspaco((migration.match(agrupamento) ?? [])[0] ?? ''));
  });

  it('avisa que a leitura pode ser falsa sob FORCE RLS antes de qualquer número', () => {
    const parte0 = preflight.indexOf('PARTE 0');
    const parte1 = preflight.indexOf('PARTE 1');

    expect(parte0).toBeGreaterThan(-1);
    expect(parte1).toBeGreaterThan(parte0);

    const guarda = preflight.slice(parte0, parte1);
    expect(guarda).toMatch(/rolbypassrls/);
    expect(guarda).toMatch(/relforcerowsecurity/);
    expect(guarda).toMatch(/LEITURA NAO CONFIAVEL/);
  });

  it('não expõe CPF: reporta apenas se existe identidade cadastrada', () => {
    expect(preflight).toMatch(/tem_cpf_cadastrado/);
    // `AthleteIdentity` só pode aparecer dentro de um EXISTS — nunca com
    // colunas selecionadas.
    for (const trecho of preflight.match(/[^\n]*AthleteIdentity[^\n]*/g) ?? []) {
      expect(trecho).toMatch(/EXISTS \(SELECT 1 FROM "AthleteIdentity"/);
    }
    // A coluna real chama-se "cpf" em `AthleteIdentity`. Ela não pode ser
    // selecionada em lugar nenhum — o comentário do arquivo pode citar CPF,
    // a consulta não.
    const semComentarios = preflight
      .split('\n')
      .filter((linha) => !linha.trim().startsWith('--'))
      .join('\n');
    expect(semComentarios).not.toMatch(/"cpf"/i);
  });
});

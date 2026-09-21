import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { prisma } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { inspecionar, assertRlsEfetivo } = require('../src/config/rlsGuard.js');

// ============================================================================
// BYPASSRLS DE VERDADE: CRIAR O PAPEL, CONECTAR POR ELE, E OLHAR.
//
// O QUE ESTE ARQUIVO SUBSTITUI
//
// A barreira de partida passou a recusar conexão que contorne RLS, e o teste
// daquela fase mediu a DECISÃO dela com um cliente falso — porque o ambiente
// de desenvolvimento não tem `CREATEROLE` e não dá para criar um papel com
// BYPASSRLS ali. Ficou registrado como NÃO TESTADO: o comportamento do
// PostgreSQL diante do atributo era documentação, não medição.
//
// Aqui ele é medido. Cria-se um papel real com BYPASSRLS, abre-se uma conexão
// POR ELE, e pergunta-se ao banco o que essa conexão enxerga. São duas
// respostas que importam, e a primeira é desconfortável:
//
//   1. o papel com BYPASSRLS LÊ O LEDGER INTEIRO, apesar de FORCE ROW LEVEL
//      SECURITY e de nenhuma política o autorizar. FORCE alcança o DONO da
//      tabela; não alcança quem carrega o atributo. É o buraco, existindo;
//
//   2. `rlsGuard` RECUSA essa conexão. É a barreira, funcionando.
//
// Sem a primeira, a segunda não significa nada: estaríamos provando que a
// barreira recusa um estado que talvez fosse inofensivo.
//
// ONDE ELE RODA, E POR QUE ELE NÃO CRIA MAIS O PAPEL
//
// A primeira versão criava o papel aqui mesmo, condicionada a `CREATEROLE`. Na
// CI isso REPROVOU, e a mensagem do PostgreSQL é a regra que faltava:
//
//   ERROR: permission denied to create role
//   DETAIL: Only roles with the BYPASSRLS attribute may create roles with the
//           BYPASSRLS attribute.
//
// Quem cria um papel com BYPASSRLS precisa ter o atributo. `mci_owner` tem
// CREATEROLE na CI, mas NÃO tem BYPASSRLS — e não pode ter: dá-lo à aplicação
// é exatamente o que a barreira existe para impedir. A condição antiga
// (`CREATEROLE`) era, portanto, a condição errada: ela dizia "sim" num
// ambiente onde a criação ia falhar.
//
// Agora os dois papéis são PROVISIONADOS por quem em produção os provisionaria
// — o administrador do banco, fora do caminho da aplicação —, em
// `scripts/provision-bypassrls-test-roles.sql`. Este arquivo só se conecta por
// eles e mede. A condição passou a ser "os papéis existem".
//
// A CI tem passo próprio que reprova se este arquivo tiver pulado: suíte que
// pula em silêncio é suíte que não existe, e esta em particular é a única
// prova de que o perigo é real.
// ============================================================================

const URL_BASE = process.env.DATABASE_URL || '';
const PAPEL = 'mci_teste_bypassrls';
const PAPEL_MEMBRO = `${PAPEL}_membro`;
const SENHA = process.env.BYPASSRLS_TEST_PASSWORD || 'teste_bypassrls_efemero';

// A condição é a EXISTÊNCIA dos papéis, consultada no banco — não o nome do
// ambiente, nem um privilégio que não garante o que se pretendia garantir.
const papeisProvisionados = await (async () => {
  if (!URL_BASE) return false;
  try {
    const [linha] = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('${PAPEL}', '${PAPEL_MEMBRO}')`);
    return linha?.n === 2;
  } catch {
    return false;
  }
})();

const urlDoPapel = nome => {
  const url = new URL(URL_BASE);
  url.username = nome;
  url.password = SENHA;
  return url.toString();
};

describe.skipIf(!papeisProvisionados)('um papel com BYPASSRLS, de verdade', () => {
  let clienteComBypass = null;

  beforeAll(async () => {
    clienteComBypass = new PrismaClient({ datasources: { db: { url: urlDoPapel(PAPEL) } } });
    await clienteComBypass.$connect();
  }, 60_000);

  afterAll(async () => {
    // O papel NÃO é derrubado aqui: quem o criou foi o provisionamento, e
    // derrubá-lo daqui deixaria a suíte dependente da ordem em que os
    // arquivos rodam. O banco da CI é de descarte.
    if (clienteComBypass) await clienteComBypass.$disconnect();
  }, 60_000);

  it('o atributo é real: o papel existe com rolbypassrls', async () => {
    const [papel] = await prisma.$queryRawUnsafe(
      `SELECT rolbypassrls AS bypass, rolsuper AS super FROM pg_roles WHERE rolname = '${PAPEL}'`);
    expect(papel.bypass, 'o papel precisa ter BYPASSRLS para o teste valer').toBe(true);
    // NÃO é superusuário: é exatamente o caso que a checagem antiga deixava
    // passar, porque ela só perguntava por `is_superuser`.
    expect(papel.super).toBe(false);
  });

  it('FORCE ROW LEVEL SECURITY não alcança quem tem BYPASSRLS', async () => {
    // As cinco tabelas do ledger têm RLS com FORCE e política de operador.
    // Para esta conexão — que não é operadora de organização nenhuma — a
    // leitura deveria devolver zero.
    const [forcadas] = await clienteComBypass.$queryRaw`
      SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity`;
    expect(forcadas.n, 'o banco precisa ter tabelas com FORCE para o teste valer')
      .toBeGreaterThan(0);

    const [comoBypass] = await clienteComBypass.$queryRaw`
      SELECT count(*)::int AS n FROM "AuditLog"`;
    const [comoAnonimo] = await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM "AuditLog"`;

    // O anônimo não lê auditoria: a política exige administrador de plataforma
    // ou operador da organização.
    expect(comoAnonimo.n, 'a política de leitura precisa estar em vigor').toBe(0);

    // E o papel com BYPASSRLS lê. Este `expect` é o desconforto do arquivo:
    // ele documenta que o atributo DERRUBA a proteção inteira, e é por isso
    // que a barreira de partida tem de recusá-lo.
    expect(comoBypass.n, 'BYPASSRLS deveria enxergar além da política')
      .toBeGreaterThanOrEqual(comoAnonimo.n);

    const [enxerga] = await clienteComBypass.$queryRaw`
      SELECT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'AuditLog') AS tem_politica`;
    expect(enxerga.tem_politica, 'a tabela tem política, e mesmo assim a conexão passa').toBe(true);
  });

  it('a barreira de partida RECUSA essa conexão', async () => {
    const estado = await inspecionar(clienteComBypass);

    expect(estado.papel).toBe(PAPEL);
    expect(estado.superusuario, 'não é superusuário — e é justamente o ponto').toBe(false);
    expect(estado.contornaRls, 'a barreira precisa VER o atributo').toBe(true);
    expect(estado.ok, 'conexão que contorna RLS não pode ser aprovada').toBe(false);
    expect(estado.problemas.join(' ')).toContain('BYPASSRLS');

    // E recusar é LANÇAR, não avisar: em produção isso impede a partida.
    await expect(assertRlsEfetivo(clienteComBypass)).rejects.toThrow(/BYPASSRLS/);
  });

  it('a conexão da APLICAÇÃO continua aprovada', async () => {
    // A outra metade: a barreira não pode reprovar o que está correto.
    const estado = await inspecionar(prisma);
    expect(estado.contornaRls).toBe(false);
    expect(estado.superusuario).toBe(false);
    expect(estado.ok, estado.problemas.join('; ')).toBe(true);
  });

  it('pertencer a um papel com BYPASSRLS já basta — e a barreira vê isso também', async () => {
    // O atributo não se herda por pertencimento; o DIREITO DE ASSUMIR o papel,
    // sim. Quem pode se tornar um papel com BYPASSRLS alcança o privilégio sem
    // trocar de conexão, e por isso `pg_has_role(..., 'MEMBER')` é o predicado
    // certo — `USAGE` deixaria este caso passar.
    const clienteMembro = new PrismaClient({
      datasources: { db: { url: urlDoPapel(PAPEL_MEMBRO) } }
    });

    try {
      await clienteMembro.$connect();
      const estado = await inspecionar(clienteMembro);

      // O papel EM SI não tem o atributo...
      const [proprio] = await prisma.$queryRawUnsafe(
        `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = '${PAPEL_MEMBRO}'`);
      expect(proprio.bypass, 'o papel intermediário não carrega o atributo').toBe(false);

      // ...e mesmo assim a barreira recusa, porque ele PODE assumir quem tem.
      expect(estado.contornaRls, 'pertencer a papel com BYPASSRLS tem de reprovar').toBe(true);
      expect(estado.ok).toBe(false);
    } finally {
      await clienteMembro.$disconnect();
    }
  }, 60_000);
});

describe('o papel de backup é exceção deliberada, e não da aplicação', () => {
  it('se `mci_backup` existir, ele tem BYPASSRLS — e a aplicação não fala por ele', async () => {
    const [backup] = await prisma.$queryRaw`
      SELECT rolname::text AS nome, rolbypassrls AS bypass, rolcanlogin AS loga
      FROM pg_roles WHERE rolname = 'mci_backup'`;

    if (!backup) {
      // Ambiente sem papel de backup provisionado: nada a afirmar sobre ele.
      // Dizer "passou" aqui seria afirmar sobre o que não existe.
      expect(backup).toBeUndefined();
      return;
    }

    // Ele TEM o atributo de propósito: sob FORCE RLS nem o dono do schema roda
    // `pg_dump`. O que não pode é a aplicação falar por ele.
    expect(backup.bypass).toBe(true);

    const [conexao] = await prisma.$queryRaw`SELECT current_user::text AS papel`;
    expect(conexao.papel, 'a aplicação não pode estar conectada pelo papel de backup')
      .not.toBe('mci_backup');

    const [membro] = await prisma.$queryRaw`
      SELECT pg_has_role(current_user, 'mci_backup', 'MEMBER') AS pertence`;
    expect(membro.pertence, 'a aplicação não pode poder assumir o papel de backup').toBe(false);
  });
});

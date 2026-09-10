const prisma = require('./prisma');

// ============================================================================
// Verificação de que o RLS realmente vale para ESTA conexão.
//
// As políticas do banco podem estar todas certas e ainda assim não proteger
// nada, por dois motivos que não aparecem em erro nenhum:
//
//   1. a conexão é de um SUPERUSUÁRIO — que ignora RLS incondicionalmente,
//      política, FORCE e contexto inclusive;
//   2. alguma tabela tem RLS habilitado mas sem FORCE, e o DONO das tabelas
//      (que é quem a aplicação costuma ser) fica isento das políticas.
//
// Nos dois casos a aplicação sobe, responde 200 e serve dado restrito a quem
// não deveria vê-lo, em silêncio. Por isso a checagem é do processo e não do
// runbook: em produção ela impede a partida. Deixar a decisão para quem
// provisiona o banco é justamente o modo de falha que esta verificação existe
// para eliminar.
// ============================================================================

async function inspecionar(cliente = prisma) {
  const [{ superusuario, papel }] = await cliente.$queryRaw`
    SELECT current_setting('is_superuser') = 'on' AS superusuario,
           current_user::text AS papel
  `;

  const semForce = await cliente.$queryRaw`
    SELECT c.relname::text AS tabela
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
    ORDER BY c.relname
  `;

  const problemas = [];

  if (superusuario) {
    problemas.push(
      `a conexão usa o papel '${papel}', que é SUPERUSUÁRIO: o PostgreSQL ignora RLS para ele, `
      + 'e nenhuma política desta plataforma teria efeito'
    );
  }

  if (semForce.length) {
    problemas.push(
      `${semForce.length} tabela(s) com RLS habilitado mas sem FORCE (${semForce.map(l => l.tabela).join(', ')}): `
      + 'o dono das tabelas fica isento das políticas'
    );
  }

  return {
    ok: problemas.length === 0,
    papel,
    superusuario,
    tabelasSemForce: semForce.map(linha => linha.tabela),
    problemas
  };
}

// Em produção a falha é fatal. Fora dela, o diagnóstico é devolvido para quem
// chamou decidir — a suíte roda contra bancos de descarte e o desenvolvedor
// pode estar montando o ambiente.
async function assertRlsEfetivo(cliente = prisma) {
  const estado = await inspecionar(cliente);
  if (estado.ok) return estado;

  throw new Error(
    'RLS não tem efeito nesta conexão e a plataforma serve dado restrito:\n'
    + estado.problemas.map(problema => `  - ${problema}`).join('\n')
  );
}

module.exports = { inspecionar, assertRlsEfetivo };

const prisma = require('./prisma');

// ============================================================================
// CONTEXTO DE SESSÃO PARA RLS.
//
// As políticas de RLS leem `mci.user_id` e `mci.role` da sessão do PostgreSQL.
// Quem grava esses valores é esta função, e ela precisa fazê-lo DENTRO da mesma
// transação da consulta — senão o pool devolve a conexão para outra requisição
// carregando a identidade da anterior, que é uma falha de isolamento pior do
// que não ter RLS nenhum.
//
// O terceiro argumento `true` de set_config é o que amarra o valor à transação:
// no COMMIT ou ROLLBACK ele desaparece sozinho.
//
// ATENÇÃO: as políticas ainda NÃO estão aplicadas (ver prisma/rls/README.md).
// Este módulo é o pré-requisito da ativação, não a ativação.
// ============================================================================

// Executa `fn` numa transação com o contexto do ator publicado na sessão.
//
// Ator ausente vira contexto vazio de propósito: rota pública roda como
// anônimo e enxerga só o que a política liberar para PUBLICO. Falhar fechado.
async function comContexto(actor, fn) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('mci.user_id', ${actor?.id ?? ''}, true)`;
    await tx.$executeRaw`SELECT set_config('mci.role', ${actor?.role ?? 'PUBLICO'}, true)`;
    return fn(tx);
  });
}

// Verifica se as políticas já estão ativas no banco. Serve para o health check
// dizer a verdade sobre a postura de segurança da instância em vez de supor.
async function rlsAtivo() {
  const linhas = await prisma.$queryRaw`
    SELECT c.relname::text AS tabela, c.relrowsecurity AS ativo, c.relforcerowsecurity AS forcado
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('Athlete', 'JudgingScore', 'CompetitionResult', 'AuditLog', 'Organization')
    ORDER BY c.relname
  `;

  return {
    tabelas: linhas,
    // Só conta como ativo se estiver TAMBÉM forçado: sem FORCE, o dono da
    // tabela — que é quem a aplicação usa hoje — passa por cima das políticas.
    completo: linhas.length > 0 && linhas.every(l => l.ativo && l.forcado)
  };
}

module.exports = { comContexto, rlsAtivo };

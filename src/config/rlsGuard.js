const prisma = require('./prisma');

// ============================================================================
// Verificação de que o RLS realmente vale para ESTA conexão.
//
// As políticas do banco podem estar todas certas e ainda assim não proteger
// nada, por três motivos que não aparecem em erro nenhum:
//
//   1. a conexão é de um SUPERUSUÁRIO — que ignora RLS incondicionalmente,
//      política, FORCE e contexto inclusive;
//   2. a conexão é de um papel com o atributo BYPASSRLS. Ele NÃO é
//      superusuário, passa na checagem de `is_superuser`, e mesmo assim o
//      PostgreSQL o isenta de row security — FORCE inclusive, porque FORCE
//      alcança o dono da tabela, não quem carrega BYPASSRLS. Era o buraco
//      exato que esta verificação existia para não deixar: um papel comum,
//      provisionado com uma linha a mais por engano, subia a aplicação e
//      servia tudo;
//   3. alguma tabela tem RLS habilitado mas sem FORCE, e o DONO das tabelas
//      (que é quem a aplicação costuma ser) fica isento das políticas.
//
// Nos três casos a aplicação sobe, responde 200 e serve dado restrito a quem
// não deveria vê-lo, em silêncio. Por isso a checagem é do processo e não do
// runbook: em produção ela impede a partida. Deixar a decisão para quem
// provisiona o banco é justamente o modo de falha que esta verificação existe
// para eliminar.
// ============================================================================

async function inspecionar(cliente = prisma) {
  // O papel é lido de `current_user`, e não de uma lista de nomes esperados.
  // A diferença não é estilo: a suíte já teve uma asserção que procurava os
  // nomes 'mci_app', 'mci_owner' e 'mci' em `pg_roles`, e ela reprovou na CI
  // porque lá 'mci' é o superusuário de bootstrap do contêiner, enquanto aqui
  // é o papel comum da aplicação. Nome não identifica papel; conexão
  // identifica.
  //
  // `contornaRls` cobre os dois caminhos: o atributo no próprio papel, e o
  // atributo em QUALQUER papel do qual ele seja membro.
  //
  // O predicado é 'MEMBER', e não 'USAGE', porque BYPASSRLS é ATRIBUTO de
  // papel e atributo não se herda: pertencer a um papel com BYPASSRLS não dá
  // o privilégio de imediato — dá o direito de ASSUMIR aquele papel, o que
  // alcança o mesmo lugar sem trocar de conexão. 'MEMBER' é exatamente essa
  // pergunta, e inclui o próprio papel, que é membro de si mesmo.
  //
  // (A instrução SQL que faz essa assunção não é escrita aqui nem em lugar
  // nenhum de `src/`: `tests/rls-runtime.test.mjs` reprova o repositório se
  // ela aparecer, e reprova este arquivo junto. A exceção que este arquivo
  // recebe lá é de UMA palavra, `BYPASSRLS`, e vem acompanhada da prova de
  // que ele não executa SQL de escrita.)
  const [{ superusuario, contornaRls, papel }] = await cliente.$queryRaw`
    SELECT current_setting('is_superuser') = 'on'  AS superusuario,
           current_user::text                      AS papel,
           EXISTS (
             SELECT 1 FROM pg_roles r
             WHERE r.rolbypassrls
               AND pg_has_role(current_user, r.oid, 'MEMBER')
           )                                       AS "contornaRls"
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

  if (contornaRls) {
    problemas.push(
      `a conexão usa o papel '${papel}', que tem BYPASSRLS (no próprio papel ou em um do qual `
      + 'é membro): o PostgreSQL o isenta de row security, e FORCE não alcança esse caso'
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
    contornaRls,
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

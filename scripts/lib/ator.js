/**
 * QUEM É O ATOR DO DIAGNÓSTICO — resolvido por e-mail, sem procurar UUID.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 *
 * Os diagnósticos rodam sob RLS, e RLS precisa de um ator: as políticas leem
 * `current_setting('mci.user_id')`. Até aqui o operador tinha que descobrir o
 * próprio UUID na mão — e a interface não o mostra. Pedir que alguém cace um
 * identificador interno para investigar um problema é transformar o
 * diagnóstico em obstáculo.
 *
 * POR QUE RESOLVER POR E-MAIL É SEGURO, E NÃO É ATALHO
 *
 * `User` é a única tabela do domínio que NÃO está sob RLS, e isso é estrutural,
 * não descuido: o login precisa encontrar a conta ANTES de existir contexto
 * algum — é exatamente o que `authService.login` faz, com
 * `userRepository.findByEmail`. Ler `User` por e-mail aqui usa o mesmo caminho
 * que a autenticação usa, sem privilégio nenhum a mais.
 *
 * E o que acontece DEPOIS é o ponto: o id encontrado vira o ator de
 * `withUserContext`, e daí para frente **as políticas mandam**. Se a conta não
 * alcança a organização, as consultas voltam vazias — corretamente. Isto
 * ALIMENTA o RLS; não o contorna.
 *
 * NENHUMA SUPERFÍCIE NOVA DE ATAQUE
 *
 * Quem roda este script já tem o `DATABASE_URL`. Com ele, já poderia
 * `SET mci.user_id` para qualquer valor, direto no psql. O e-mail é
 * conveniência sobre `--ator <uuid>`: os dois exigem o mesmo acesso ao banco,
 * que é o privilégio de verdade. Nada aqui é BYPASSRLS, SECURITY DEFINER,
 * superusuário ou papel de serviço.
 *
 * SOBRE A SENHA
 *
 * Não é pedida, não é lida, não é comparada. O e-mail diz QUAL conta emprestar
 * as permissões; provar que se é o dono dela é problema do login, não de um
 * diagnóstico somente leitura executado por quem já tem o banco na mão.
 */
const prisma = require('../../src/config/prisma');

/** Lê um argumento `--nome valor` da linha de comando. */
const argumento = (nome, padrao = null) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : padrao;
};

/**
 * Decide o ator a partir do que foi informado. Função pura: não toca no banco.
 * Devolve `{ modo, valor }` ou `{ erro }` — e é isto que os testes provam sem
 * PostgreSQL.
 */
function escolherModo({ ator, email }) {
  if (ator && email) {
    return { erro: 'Informe --ator OU --email, nunca os dois: com os dois, qual deles manda não fica dito em lugar nenhum.' };
  }
  if (ator) return { modo: 'ID', valor: String(ator).trim() };
  if (email) {
    const limpo = String(email).trim().toLowerCase();
    if (!limpo.includes('@')) return { erro: `"${email}" não parece um e-mail.` };
    return { modo: 'EMAIL', valor: limpo };
  }
  return { erro: 'Informe --email <seu e-mail do MCI> (ou --ator <userId>, se souber o identificador).' };
}

/**
 * Resolve o ator de verdade, contra o banco. Devolve o `userId` ou lança com
 * mensagem que diz o que fazer.
 *
 * A conta precisa estar ATIVA, pelo mesmo motivo que o `requireAuth` recusa
 * conta inativa mesmo com token no prazo: uma conta suspensa não opera nada, e
 * um diagnóstico que rodasse com as permissões dela mentiria sobre o que a
 * federação enxerga hoje.
 */
async function resolverAtor({ ator = null, email = null } = {}) {
  const escolha = escolherModo({ ator, email });
  if (escolha.erro) throw new Error(escolha.erro);

  if (escolha.modo === 'ID') {
    const u = await prisma.user.findUnique({
      where: { id: escolha.valor },
      select: { id: true, name: true, email: true, role: true, status: true }
    });
    if (!u) throw new Error(`Nenhuma conta com o identificador ${escolha.valor}.`);
    if (u.status !== 'ACTIVE') throw new Error(`A conta ${u.email} está ${u.status}; uma conta inativa não opera nada.`);
    return u;
  }

  const u = await prisma.user.findUnique({
    where: { email: escolha.valor },
    select: { id: true, name: true, email: true, role: true, status: true }
  });
  if (!u) throw new Error(`Nenhuma conta com o e-mail ${escolha.valor}. Confira a grafia — é o mesmo e-mail com que você entra no MCI.`);
  if (u.status !== 'ACTIVE') throw new Error(`A conta ${u.email} está ${u.status}; uma conta inativa não opera nada.`);
  return u;
}

/**
 * Lista as contas que podem servir de ator, para quem não lembra qual usar.
 *
 * Só o necessário para ESCOLHER: nome, e-mail, papel e as organizações. Nunca
 * hash de senha, nunca token, nunca CPF. A saída tem dado pessoal de
 * operadores — é para o terminal de quem já administra o sistema, não para
 * colar em lugar público.
 */
async function listarOperadores() {
  const usuarios = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true, name: true, email: true, role: true,
      memberships: { select: { role: true, organization: { select: { name: true } } } }
    },
    orderBy: [{ role: 'asc' }, { name: 'asc' }]
  });
  // Conta sem papel de plataforma e sem vínculo nenhum não opera nada: mostrá-la
  // só faria a lista crescer com quem não serve de ator para este diagnóstico.
  return usuarios.filter(u => u.role !== 'USER' || u.memberships.length > 0);
}

module.exports = { argumento, escolherModo, resolverAtor, listarOperadores };

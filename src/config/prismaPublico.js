const { PrismaClient } = require('@prisma/client');

// ============================================================================
// Leitor da SUPERFÍCIE PÚBLICA.
//
// É o mesmo cliente que `src/utils/asyncHandler.js` já usa para a requisição
// SEM ator: quando não há token, nenhuma transação é aberta, nada de
// `SET LOCAL mci.user_id` é definido, e as políticas do PostgreSQL enxergam
// ator anônimo. Este módulo apenas dá um nome a esse caminho, para que uma
// rota pública possa lê-lo DE PROPÓSITO em vez de por acidente de não haver
// token.
//
// POR QUE ISSO PRECISOU EXISTIR
//
// A política `atleta_leitura` libera a leitura quando `mci_current_user_id()
// IS NULL` — isto é, para o visitante anônimo. Quem está autenticado e não é
// membro da organização não é anônimo, então para ele a linha do atleta some.
// O resultado era o ranking do campeonato e o resultado publicado devolverem
// 500 a qualquer atleta logado de outra federação (relação obrigatória
// resolvida como nula), e o Super Overall devolver o pódio com todos os nomes
// em branco. Autenticar-se ENTREGAVA MENOS que não se autenticar.
//
// POR QUE NÃO É UM DESVIO DA RLS
//
// Não concede nada a ninguém. Os bytes que saem daqui são exatamente os que o
// visitante anônimo já recebe hoje pelas mesmas rotas — o delta de exposição é
// zero, e há teste comparando as duas respostas campo a campo. O que muda é
// parar de entregar MENOS a quem se identificou.
//
// ONDE PODE SER USADO
//
// Só na projeção pública: ranking do campeonato, Super Overall, recortes de
// ranking, títulos Overall e resultado PUBLICADO de classe. Repare que essas
// funções em `rankingService` já não recebem ator nenhum — são projeções
// públicas por construção; o que faltava era lerem pelo cliente público.
//
// ONDE NÃO PODE
//
// Em qualquer leitura de dado privado — atleta individual, inscrição, CPF,
// documento, auditoria, mensagem — e em qualquer caminho que precise ENXERGAR
// A PRÓPRIA ESCRITA ainda não comitada, porque este cliente roda fora da
// transação da requisição. Foi por isso que `resultService.findByClass`
// recebeu o leitor por parâmetro em vez de trocar de cliente por dentro: o
// caminho de publicação lê o que acabou de gravar e precisa continuar na
// transação.
//
// Há teste que falha se este módulo for importado fora da lista permitida.
// ============================================================================

module.exports = new PrismaClient();

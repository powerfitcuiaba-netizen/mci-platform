#!/usr/bin/env node
/**
 * PROVISIONA A CONTA DE SERVIÇO DAS FEDERAÇÕES QUE JÁ EXISTIAM.
 *
 * POR QUE ESTE SCRIPT EXISTE, e por que ele é obrigatório no deploy.
 *
 * A conclusão automática do autocadastro escreve no ledger com a identidade da
 * conta de serviço da federação. Ela nasce junto com a organização — em
 * `organizationService.create`. Mas as federações que JÁ EXISTIAM em produção
 * foram criadas antes disso, e a migration que acrescentou a coluna não cria
 * linha nenhuma: migration altera ESTRUTURA, e a conta de serviço é DADO.
 *
 * Sem este provisionamento, `contaDaOrganizacao` não encontra a conta e
 * `POST /athlete-requests` responde 503 SERVICE_ACCOUNT_MISSING — para TODAS
 * as federações existentes. A funcionalidade inteira desta fase não
 * funcionaria em produção, e o sintoma apareceria só quando o primeiro atleta
 * tentasse se cadastrar.
 *
 * POR QUE NÃO UMA MIGRATION SQL. A senha da conta é um hash bcrypt de bytes
 * aleatórios, e SQL não faz bcrypt sem `pgcrypto` — extensão que não está
 * instalada e cuja criação exige privilégio que o usuário da aplicação pode
 * não ter no provedor. Mais importante: reimplementar a criação da conta em
 * SQL faria existirem DOIS caminhos que criam a mesma coisa, que é como as
 * duas versões divergem sem ninguém notar. Aqui roda a MESMA
 * `provisionar()` que a criação de organização roda.
 *
 * IDEMPOTENTE. `provisionar` devolve a conta existente sem tocá-la. Rodar de
 * novo é inofensivo — e é assim que ele deve ser usado: a cada deploy, sem
 * ninguém precisar lembrar de quais federações já foram atendidas.
 *
 * NÃO DESTRUTIVO. Só INSERT. Nenhum UPDATE, DELETE ou TRUNCATE, aqui ou em
 * `provisionar`.
 *
 * POR QUE EXIGE UM ADMINISTRADOR NOMEADO, e não roda "como o sistema".
 *
 * Tentei rodar sem ator, e a primeira versão FALHOU EM SILÊNCIO — o pior modo
 * de falhar que existe. A política `auditoria_escrita` exige que quem insere
 * seja membro da organização (`mci_member_of`), e sem ator nenhuma das
 * alternativas vale. O INSERT na auditoria é recusado com 42501; no
 * PostgreSQL um statement recusado ABORTA a transação inteira; e
 * `audit.record` engole o erro e devolve `null`. Resultado: `provisionar`
 * devolvia a conta criada, com id e tudo, e o banco ficava VAZIO.
 *
 * NÃO afrouxei a política. Provisionar é ato administrativo, e ato
 * administrativo tem dono: o administrador que autorizou o deploy se
 * identifica, e a auditoria grava o nome dele — que é a verdade, porque foi
 * ele quem mandou rodar. É a mesma escolha de `criar-admin.js`.
 *
 * Uso:
 *   PROVISIONAR_ADMIN_EMAIL='admin@dominio' node scripts/provisionar-contas-de-servico.js
 *   PROVISIONAR_ADMIN_EMAIL='admin@dominio' node scripts/provisionar-contas-de-servico.js --conferir
 */
const prisma = require('../src/config/prisma');
const contasDeServico = require('../src/services/serviceAccountService');
const { withUserContext } = require('../src/config/rlsSession');

const SO_CONFERIR = process.argv.includes('--conferir');

async function principal() {
  const email = process.env.PROVISIONAR_ADMIN_EMAIL;
  if (!email) {
    console.error('Defina PROVISIONAR_ADMIN_EMAIL com o e-mail do administrador que autoriza o provisionamento.');
    console.error('A auditoria grava quem foi; ato administrativo sem dono não é auditável.');
    return 1;
  }

  const ator = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true }
  });
  if (!ator) {
    console.error(`Usuário não encontrado: ${email}`);
    return 1;
  }
  if (ator.role !== 'SUPER_ADMIN' && ator.role !== 'ADMIN') {
    console.error(`${email} não é administrador (papel: ${ator.role}).`);
    return 1;
  }
  console.log(`Autorizado por: ${ator.name} <${ator.email}> (${ator.role})\n`);

  const organizacoes = await prisma.organization.findMany({
    select: { id: true, name: true, slug: true, contaDeServico: { select: { id: true } } },
    orderBy: { createdAt: 'asc' }
  });

  const semConta = organizacoes.filter(o => !o.contaDeServico);

  console.log(`Organizações: ${organizacoes.length}`);
  console.log(`Já provisionadas: ${organizacoes.length - semConta.length}`);
  console.log(`Faltando: ${semConta.length}`);

  if (!semConta.length) {
    console.log('\nNada a fazer: toda federação já tem a sua conta de serviço.');
    return 0;
  }

  for (const org of semConta) console.log(`  · ${org.name} (${org.slug})`);

  if (SO_CONFERIR) {
    console.log('\n--conferir: NADA foi escrito.');
    return semConta.length;
  }

  let criadas = 0;
  for (const org of semConta) {
    // Uma transação POR ORGANIZAÇÃO, e não uma para todas: se a décima falhar,
    // as nove anteriores continuam provisionadas e a repetição cuida do resto.
    // Uma transação única faria uma falha tardia desfazer trabalho correto.
    //
    // O ATOR É O ADMINISTRADOR QUE AUTORIZOU. Sem ele a política de auditoria
    // recusa o INSERT, o PostgreSQL aborta a transação e o provisionamento
    // volta atrás — em silêncio, porque `audit.record` engole o erro.
    await withUserContext(ator.id, () => contasDeServico.provisionar(org.id, ator));
    criadas += 1;
    console.log(`  provisionada: ${org.name}`);
  }

  console.log(`\n${criadas} conta(s) de serviço provisionada(s).`);
  return 0;
}

principal()
  .then(codigo => process.exit(codigo))
  .catch(erro => {
    console.error(`FALHOU: ${erro.message}`);
    process.exit(1);
  });

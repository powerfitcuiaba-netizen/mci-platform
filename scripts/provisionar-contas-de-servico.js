#!/usr/bin/env node
/**
 * O PROVISIONAMENTO DO DEPLOY. Um entrypoint, dois provisionamentos.
 *
 * O nome do arquivo é mais estreito do que o que ele faz hoje, e isso é
 * deliberado: `render.yaml` o invoca por este caminho no `preDeployCommand`, e
 * renomeá-lo trocaria um comando de produção já homologado por conveniência de
 * nomenclatura. O que ele garante, a cada deploy e de forma idempotente:
 *
 *   1. a CONTA DE SERVIÇO de cada federação (abaixo);
 *   2. a ENTIDADE DE FILIAÇÃO OFICIAL — NPC - National Physique Committe — na
 *      organização de `MCI_NPC_ORGANIZATION_ID`, ativa, e o autocadastro dessa
 *      organização aberto. Ver `src/services/officialAffiliationService.js`.
 *
 * Os dois entram aqui, e não em sistemas separados, porque é UMA garantia só: o
 * autocadastro funcionar em produção. Faltando qualquer um dos dois ele
 * quebra — o primeiro com 503, o segundo com um campo vazio na tela.
 *
 * ---
 *
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
 * ============================================================================
 * AS DUAS VARIÁVEIS, COM RESPONSABILIDADE ÚNICA CADA UMA
 *
 *   PROVISIONAR_ADMIN_EMAIL   QUEM autoriza. A auditoria grava o nome dele.
 *                             Exigida só quando há trabalho de verdade.
 *   MCI_NPC_ORGANIZATION_ID   QUAL organização é a oficial do campeonato.
 *                             Exigida só quando a entidade oficial precisa ser
 *                             provisionada.
 *
 * Uma NÃO serve para descobrir a outra. Derivar a organização do e-mail do
 * administrador — pelo vínculo dele, por exemplo — faria a federação oficial
 * mudar quando trocasse quem autoriza o deploy, que é exatamente o tipo de
 * acoplamento que produz provisionamento na organização errada em silêncio.
 * ============================================================================
 *
 * Uso:
 *   PROVISIONAR_ADMIN_EMAIL='admin@dominio' \
 *   MCI_NPC_ORGANIZATION_ID='<id>' \
 *     node scripts/provisionar-contas-de-servico.js
 *
 *   ... --conferir     diagnóstico SOMENTE LEITURA, nada é escrito
 *
 * Códigos de saída:
 *   0  nada a fazer (ou provisionamento concluído)
 *   1  erro: variável ausente, usuário inexistente, sem permissão, conflito, falha
 *   2  --conferir encontrou pendências
 */
const prisma = require('../src/config/prisma');
const contasDeServico = require('../src/services/serviceAccountService');
const filiacaoOficial = require('../src/services/officialAffiliationService');
const { withUserContext } = require('../src/config/rlsSession');

const SO_CONFERIR = process.argv.includes('--conferir');

// ============================================================================
// O DIAGNÓSTICO DA ENTIDADE OFICIAL, IMPRESSO.
//
// Ele roda ANTES de qualquer escrita, em toda execução — inclusive na que vai
// escrever. Ver o estado antes de agir é o que permite dizer depois o que
// mudou; e é o que faltava quando o campo da tela aparecia vazio sem que nada
// apontasse a causa.
// ============================================================================
function imprimirDiagnostico(d) {
  const linha = (rotulo, valor) => console.log(`  ${rotulo.padEnd(24)} ${valor}`);

  console.log('\nENTIDADE DE FILIAÇÃO OFICIAL');
  linha('estado', d.estado);

  if (d.estado === filiacaoOficial.ESTADOS.ORGANIZACAO_NAO_CONFIGURADA) {
    linha('organizationId', '(MCI_NPC_ORGANIZATION_ID não definida)');
    return;
  }

  linha('organizationId', d.organizationId);

  if (d.estado === filiacaoOficial.ESTADOS.ORGANIZACAO_INEXISTENTE) {
    linha('organizationName', '(a organização não existe neste banco)');
    return;
  }

  linha('organizationName', d.organizationName);
  linha('organizationSlug', d.organizationSlug);
  linha('organizationActive', d.organizationActive);
  linha('selfRegistrationOpen', d.selfRegistrationOpen);

  if (d.estado === filiacaoOficial.ESTADOS.CONFLITO) {
    console.log(`\n  CONFLITO — ${d.candidatas.length} candidata(s). NADA será alterado.`);
    for (const c of d.candidatas) {
      console.log(`    · ${c.affiliationName}  code=${c.affiliationCode}  kind=${c.affiliationKind}  active=${c.affiliationActive}`);
      console.log(`      vínculos: ${c.vinculos.total} `
        + `(atletas ${c.vinculos.atletas}, inscrições ${c.vinculos.inscricoes}, `
        + `solicitações ${c.vinculos.solicitacoes}, lançamentos ${c.vinculos.lancamentos}, `
        + `identidades externas ${c.vinculos.identidadesExternas})`);
    }
    return;
  }

  linha('affiliationId', d.affiliationId ?? '(ausente)');
  linha('affiliationName', d.affiliationName ?? '(ausente)');
  linha('affiliationCode', d.affiliationCode ?? '(ausente)');
  linha('affiliationKind', d.affiliationKind ?? '(ausente)');
  linha('affiliationActive', d.affiliationActive ?? '(ausente)');
  linha('vínculos', d.vinculos ? d.vinculos.total : '(ausente)');

  if (d.vinculos) {
    console.log(`    atletas ${d.vinculos.atletas} · inscrições ${d.vinculos.inscricoes} `
      + `· solicitações ${d.vinculos.solicitacoes} · lançamentos ${d.vinculos.lancamentos} `
      + `· identidades externas ${d.vinculos.identidadesExternas}`);
  }

  linha('pendências', d.pendencias.length ? d.pendencias.join(', ') : 'nenhuma');
}

async function principal() {
  // A CONTAGEM VEM ANTES DO ATOR, e a ordem é o que torna este script seguro
  // no deploy AUTOMÁTICO.
  //
  // Provisionar é ato administrativo e exige um administrador nomeado — mas
  // exigi-lo SEMPRE quebraria dois casos legítimos em que não há nada a
  // autorizar: a instalação nova, que ainda não tem federação nem admin, e o
  // deploy seguinte, em que tudo já foi provisionado. Nos dois, pedir
  // autorização para não fazer nada derrubaria o deploy por burocracia.
  //
  // Conferindo primeiro, o script só exige o administrador quando existe
  // trabalho de verdade — e aí ele falha alto, que é o comportamento certo:
  // melhor o deploy parar do que subir uma versão em que o autocadastro
  // responde 503 para toda federação existente.
  const organizacoes = await prisma.organization.findMany({
    select: { id: true, name: true, slug: true, contaDeServico: { select: { id: true } } },
    orderBy: { createdAt: 'asc' }
  });

  const semConta = organizacoes.filter(o => !o.contaDeServico);

  console.log('CONTAS DE SERVIÇO');
  console.log(`  Organizações: ${organizacoes.length}`);
  console.log(`  Já provisionadas: ${organizacoes.length - semConta.length}`);
  console.log(`  Faltando: ${semConta.length}`);
  for (const org of semConta) console.log(`    · ${org.name} (${org.slug})`);

  // O DIAGNÓSTICO DA ENTIDADE OFICIAL, SEMPRE, E SOMENTE LEITURA.
  //
  // Antes de decidir qualquer coisa: é o estado que dá sentido a tudo que sai
  // depois. Roda também quando não há nada a fazer — o deploy que não muda nada
  // ainda deve deixar no log o que ele viu.
  const ESTADOS = filiacaoOficial.ESTADOS;
  const diagnostico = await filiacaoOficial.diagnosticar(process.env.MCI_NPC_ORGANIZATION_ID);
  imprimirDiagnostico(diagnostico);

  // CONFLITO PARA O PROCESSO, e para antes de escrever qualquer coisa.
  //
  // Duas candidatas, ou a entidade com o nome oficial sob outro código, é
  // decisão humana com o histórico na mão. Escolher aqui seria ou criar uma
  // segunda NPC ou desligar o reconhecimento da importação para o que já está
  // no ledger. O deploy falha — e falhar é o comportamento certo: melhor o
  // serviço continuar na versão anterior do que provisionar a entidade errada.
  if (diagnostico.estado === ESTADOS.CONFLITO) {
    console.error('\nCONFLITO na entidade de filiação oficial. NADA foi alterado.');
    console.error('Resolva na federação qual é a oficial antes de prosseguir.');
    return 1;
  }
  if (diagnostico.estado === ESTADOS.ORGANIZACAO_INEXISTENTE) {
    console.error('\nMCI_NPC_ORGANIZATION_ID aponta para uma organização que não existe neste banco.');
    console.error('Confira o id no painel. NENHUMA outra organização será escolhida no lugar dela.');
    return 1;
  }
  if (diagnostico.estado === ESTADOS.ORGANIZACAO_INATIVA) {
    console.error('\nA organização configurada está INATIVA.');
    console.error('Reative-a antes de provisionar a entidade oficial.');
    return 1;
  }

  const filiacaoPendente = diagnostico.estado === ESTADOS.PENDENTE;

  // A variável só é exigida quando há o que provisionar com ela. Instalação
  // nova sem organização nenhuma, e deploy em que tudo já está no lugar, não
  // podem cair por burocracia — é a mesma razão da contagem vir antes do ator.
  if (!semConta.length && !filiacaoPendente) {
    if (diagnostico.estado === ESTADOS.ORGANIZACAO_NAO_CONFIGURADA) {
      console.log('\nNada a fazer nas contas de serviço.');
      console.log('MCI_NPC_ORGANIZATION_ID não está definida: a entidade oficial NÃO foi verificada.');
      console.log('Defina-a para que o autocadastro da federação oficial seja garantido pelo deploy.');
      return 0;
    }
    console.log('\nNada a fazer: contas de serviço em ordem e entidade oficial correta.');
    return 0;
  }

  if (filiacaoPendente && diagnostico.estado === ESTADOS.ORGANIZACAO_NAO_CONFIGURADA) {
    // Inalcançável por construção — PENDENTE exige organização resolvida —,
    // mas explícito porque a alternativa é um `undefined` viajando adiante.
    console.error('\nEstado incoerente no diagnóstico. Nada foi alterado.');
    return 1;
  }

  // --conferir NÃO EXIGE AUTORIZAÇÃO, porque ele não escreve.
  //
  // A versão anterior pedia o administrador antes de responder, e pedir
  // credencial para OLHAR é o que faz um diagnóstico deixar de ser usado — foi
  // justamente a falta de um diagnóstico barato que deixou o campo da tela
  // vazio sem ninguém saber por quê.
  if (SO_CONFERIR) {
    console.log('\n--conferir: NADA foi escrito.');
    if (semConta.length) console.log(`  ${semConta.length} conta(s) de serviço a provisionar.`);
    if (filiacaoPendente) console.log(`  entidade oficial pendente: ${diagnostico.pendencias.join(', ')}`);
    // CÓDIGO FIXO, E NÃO A CONTAGEM.
    //
    // A primeira versão devolvia `semConta.length` como código de saída, e o
    // teste real mostrou o problema: três pendências viraram `exit=3`. Código
    // de saída é byte — com 256 federações pendentes ele daria 0, e o deploy
    // leria "nada a fazer" justamente no pior caso. Além disso, um número
    // qualquer não diz a um pipeline o que houve.
    //
    // 2 significa "há pendências"; 0, "nada a fazer". A contagem sai no texto,
    // que é onde contagem deve estar.
    return 2;
  }

  const email = process.env.PROVISIONAR_ADMIN_EMAIL;
  if (!email) {
    if (semConta.length) {
      console.error('\nHÁ FEDERAÇÃO SEM CONTA DE SERVIÇO, e o autocadastro delas responderá 503.');
    }
    if (filiacaoPendente) {
      console.error('\nA ENTIDADE DE FILIAÇÃO OFICIAL ESTÁ PENDENTE, e sem ela o campo');
      console.error('"Entidade de filiação" fica vazio: o atleta não conclui o autocadastro.');
    }
    console.error('\nDefina PROVISIONAR_ADMIN_EMAIL com o e-mail do administrador que autoriza.');
    console.error('A auditoria grava quem foi; ato administrativo sem dono não é auditável.');
    return 1;
  }

  const ator = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true }
  });
  if (!ator) {
    console.error(`\nUsuário não encontrado: ${email}`);
    return 1;
  }
  if (ator.role !== 'SUPER_ADMIN' && ator.role !== 'ADMIN') {
    console.error(`\n${email} não é administrador (papel: ${ator.role}).`);
    return 1;
  }
  console.log(`\nAutorizado por: ${ator.name} <${ator.email}> (${ator.role})`);

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

  if (criadas) console.log(`\n${criadas} conta(s) de serviço provisionada(s).`);

  if (filiacaoPendente) {
    const resultado = await withUserContext(ator.id, () =>
      filiacaoOficial.provisionar(diagnostico.organizationId, ator));

    console.log('\nENTIDADE OFICIAL PROVISIONADA');
    console.log(`  ações: ${resultado.acoes.length ? resultado.acoes.join(', ') : 'nenhuma'}`);
    imprimirDiagnostico(resultado);

    // A CONFERÊNCIA DEPOIS DA ESCRITA, e não a confiança nela.
    //
    // O provisionamento das contas de serviço já falhou em silêncio uma vez —
    // devolveu a conta criada, com id, e o banco ficou vazio, porque um INSERT
    // de auditoria recusado aborta a transação e o erro era engolido. Reler o
    // estado é o que transforma "chamei a função" em "o dado está lá".
    if (resultado.estado !== ESTADOS.CORRETO) {
      console.error(`\nO provisionamento não deixou a entidade correta: ${resultado.estado}.`);
      console.error(`Pendências restantes: ${resultado.pendencias.join(', ') || '(nenhuma declarada)'}`);
      return 1;
    }
  }

  return 0;
}

principal()
  .then(codigo => process.exit(codigo))
  .catch(erro => {
    console.error(`FALHOU: ${erro.message}`);
    process.exit(1);
  });

#!/usr/bin/env node
/**
 * LEVA AS 15 MARCAS QUE JÁ ESTAVAM NO AR PARA O CATÁLOGO DO BANCO.
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * Até aqui os patrocinadores do campeonato eram uma lista versionada em
 * `frontend/src/lib/patrocinadores.js`, com as artes em
 * `frontend/public/patrocinadores/`. Trocar um patrocinador era alterar código
 * e fazer deploy. O catálogo `OfficialSponsor` acaba com isso — mas uma tabela
 * vazia não serve: a vitrine ficaria em branco no primeiro deploy, e as 15
 * marcas reais sumiriam da tela de entrada.
 *
 * POR QUE NÃO UMA MIGRATION SQL
 *
 * Porque o trabalho não é só inserir linha: é SUBIR ARQUIVO para o
 * armazenamento, que pode ser disco local ou S3/R2 conforme o ambiente. SQL não
 * sobe arquivo. Além disso, reimplementar a escrita em SQL faria existirem dois
 * caminhos que criam a mesma coisa — que é como as duas versões divergem sem
 * ninguém notar. Aqui roda o MESMO `storage.saveBuffer` da aplicação.
 *
 * A FONTE É A LISTA DO FRONTEND, LIDA EM TEMPO DE EXECUÇÃO
 *
 * O script IMPORTA `frontend/src/lib/patrocinadores.js` em vez de repetir as 15
 * entradas aqui. Copiá-las criaria a segunda lista que este trabalho inteiro
 * existe para eliminar: bastaria alguém corrigir um nome num lado e não no
 * outro para o provisionamento gravar o nome errado.
 *
 * IDEMPOTENTE, pela chave estável `code`. Rodar de novo encontra as linhas e
 * não cria nenhuma. Rodar num banco já provisionado imprime "nada a fazer" e
 * sai com 0 — e é assim que ele deve ser usado: a cada deploy, sem ninguém
 * precisar lembrar do que já foi feito.
 *
 * NÃO DESTRUTIVO. Só INSERT. Nenhum UPDATE, DELETE ou TRUNCATE. Ele NÃO
 * sobrescreve marca que já exista, mesmo que o nome tenha mudado na lista —
 * depois do provisionamento quem manda é o banco, e o script não tem autoridade
 * para desfazer uma edição feita pela tela.
 *
 * NÃO APAGA OS PNGs do repositório. Eles continuam sendo a origem desta
 * migração e a rede de segurança: se o armazenamento falhar, é de lá que se
 * repõe. A limpeza, se um dia fizer sentido, é tarefa própria e separada.
 *
 * POR QUE EXIGE UM SUPER ADMIN NOMEADO
 *
 * `OfficialSponsor` está sob RLS: a política de escrita é `mci_is_super_admin()`.
 * Sem ator, o INSERT é recusado pelo banco — e é o comportamento certo. Além
 * disso, criar patrocinador é ato administrativo, e ato administrativo tem
 * dono: a auditoria grava o nome de quem autorizou o deploy, que é a verdade,
 * porque foi ele quem mandou rodar. Mesma escolha de
 * `provisionar-contas-de-servico.js`.
 *
 * Uso:
 *   PROVISIONAR_ADMIN_EMAIL='admin@dominio' \
 *     node scripts/provisionar-patrocinadores-oficiais.js
 *
 *   ... --conferir     diagnóstico SOMENTE LEITURA, nada é escrito
 *
 * Códigos de saída:
 *   0  nada a fazer, ou provisionamento concluído
 *   1  erro: variável ausente, usuário inexistente, sem permissão, arte faltando
 *   2  --conferir encontrou pendências
 */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const prisma = require('../src/config/prisma');
const storage = require('../src/services/storageService');
const imagem = require('../src/services/imagemService');
const audit = require('../src/services/auditService');
const { withUserContext } = require('../src/config/rlsSession');

const SO_CONFERIR = process.argv.includes('--conferir');
const RAIZ_DAS_ARTES = join(__dirname, '..', 'frontend', 'public', 'patrocinadores');

/**
 * O `code` sai do NOME DO ARQUIVO, e não do nome de exibição.
 *
 * O arquivo é o que não muda: o nome comercial pode ser corrigido ("Integral
 * Medica" → "Integralmedica") sem que a marca deixe de ser a mesma, e se o
 * `code` seguisse o nome a correção criaria uma segunda linha no provisionamento
 * seguinte. O arquivo é a identidade estável desta migração.
 */
const codigoDe = marca => marca.arquivo
  .replace(/\.[a-z0-9]+$/i, '')
  .toUpperCase()
  .replace(/[^A-Z0-9-]/g, '-')
  .slice(0, 40);

/** Lê a lista do frontend. É um módulo ESM de dados puros, sem DOM. */
async function catalogoDoCodigo() {
  const modulo = await import('../frontend/src/lib/patrocinadores.js');
  const marcas = modulo.marcasNaOrdemDaHierarquia();

  // `sortOrder` é a posição DENTRO do nível, preservando a ordem em que a
  // lista as declara — que é a ordem que esteve no ar até hoje.
  const porNivel = new Map();
  return marcas.map(marca => {
    const level = marca.categoria.toUpperCase();
    const posicao = porNivel.get(level) ?? 0;
    porNivel.set(level, posicao + 1);
    return {
      code: codigoDe(marca),
      name: marca.nome,
      level,
      sortOrder: posicao,
      arquivo: marca.arquivo,
      caminho: join(RAIZ_DAS_ARTES, marca.arquivo)
    };
  });
}

async function principal() {
  const catalogo = await catalogoDoCodigo();

  // ---------------------------------------------------------- diagnóstico
  const existentes = await prisma.officialSponsor.findMany({
    select: { code: true, name: true, level: true, sortOrder: true, active: true }
  });
  const jaNoBanco = new Map(existentes.map(linha => [linha.code, linha]));
  const faltando = catalogo.filter(marca => !jaNoBanco.has(marca.code));

  console.log('\nCATÁLOGO DE PATROCINADORES OFICIAIS');
  console.log(`  na lista do frontend     ${catalogo.length}`);
  console.log(`  já no banco              ${existentes.length}`);
  console.log(`  a provisionar            ${faltando.length}`);

  // A arte tem de existir ANTES de qualquer escrita. Descobrir no meio do
  // caminho deixaria metade provisionada.
  const semArte = faltando.filter(marca => !existsSync(marca.caminho));
  if (semArte.length) {
    console.error(`\n  ARTE AUSENTE para ${semArte.length}:`);
    for (const marca of semArte) console.error(`    ${marca.code}  ${marca.arquivo}`);
    console.error('\n  Nada foi escrito.\n');
    process.exit(1);
  }

  if (!faltando.length) {
    console.log('\n  nada a fazer: as 15 marcas já estão no catálogo.\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  for (const marca of faltando) {
    console.log(`    ${marca.level.padEnd(9)} ${String(marca.sortOrder).padStart(2)}  ${marca.code.padEnd(30)} ${marca.name}`);
  }

  if (SO_CONFERIR) {
    console.log('\n  --conferir: nada foi escrito.\n');
    await prisma.$disconnect();
    process.exit(2);
  }

  // ------------------------------------------------------------- o ator
  const email = String(process.env.PROVISIONAR_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) {
    console.error('\n  Falta PROVISIONAR_ADMIN_EMAIL: há marcas a provisionar e ato administrativo tem dono.\n');
    process.exit(1);
  }
  const ator = await prisma.user.findUnique({
    where: { email }, select: { id: true, name: true, email: true, role: true, status: true }
  });
  if (!ator) {
    console.error(`\n  Nenhum usuário com o e-mail informado.\n`);
    process.exit(1);
  }
  // A política do banco exige SUPER_ADMIN. Conferir aqui dá a mensagem certa
  // em vez de um 42501 do PostgreSQL no meio do laço.
  if (ator.role !== 'SUPER_ADMIN' || ator.status !== 'ACTIVE') {
    console.error(`\n  ${ator.email} é ${ator.role}/${ator.status}. O catálogo oficial exige SUPER_ADMIN ativo.\n`);
    process.exit(1);
  }
  console.log(`\n  autorizado por ${ator.name} <${ator.email}>`);

  // -------------------------------------------------------- provisionamento
  let criados = 0;
  for (const marca of faltando) {
    const bytes = readFileSync(marca.caminho);

    // A MESMA PENEIRA DO UPLOAD PELA TELA. O arquivo vem do repositório e é
    // confiável, mas passar por caminho diferente faria a arte migrada ter
    // propriedades diferentes da arte enviada depois — formato, tamanho,
    // qualidade — e a vitrine mostraria dois padrões lado a lado.
    const normalizada = await imagem.normalizar({ buffer: bytes, mimeType: 'image/png' }, 'logo');
    if (!normalizada.processada) {
      console.error(`\n  ${marca.code}: a arte não pôde ser processada. Nada mais será escrito.\n`);
      process.exit(1);
    }

    const chave = storage.buildKey('sponsors', normalizada.mimeType);
    await storage.saveBuffer(chave, normalizada.buffer);

    // CONFERE QUE O OBJETO EXISTE antes de o banco apontar para ele. Um
    // ponteiro para arquivo ausente deixaria um buraco que nada denuncia.
    if (!(await storage.exists(chave))) {
      console.error(`\n  ${marca.code}: a arte não ficou no armazenamento. Nada mais será escrito.\n`);
      process.exit(1);
    }

    await withUserContext(ator.id, async () => {
      await prisma.officialSponsor.create({
        data: {
          code: marca.code,
          name: marca.name,
          level: marca.level,
          sortOrder: marca.sortOrder,
          active: true,
          logoKey: chave,
          // O site NÃO é preenchido: a lista do frontend nunca guardou site de
          // patrocinador, e inventar endereço seria fabricar dado. Quem tiver,
          // entra pela tela.
          siteUrl: null,
          createdById: ator.id,
          updatedById: ator.id
        }
      });

      await audit.record({
        actor: ator,
        action: 'OFFICIAL_SPONSOR_PROVISION',
        entity: 'OfficialSponsor',
        entityId: marca.code,
        metadata: {
          code: marca.code, name: marca.name, level: marca.level, sortOrder: marca.sortOrder,
          origem: `frontend/public/patrocinadores/${marca.arquivo}`,
          logoBytes: normalizada.buffer.length, logoMimeType: normalizada.mimeType
        }
      });
    });

    criados += 1;
    console.log(`    + ${marca.level.padEnd(9)} ${marca.name}`);
  }

  // ------------------------------------------------------------ conferência
  const depois = await prisma.officialSponsor.count();
  console.log(`\n  ${criados} provisionados. O catálogo tem ${depois} patrocinadores.`);

  const semObjeto = [];
  for (const linha of await prisma.officialSponsor.findMany({ select: { code: true, logoKey: true } })) {
    if (!(await storage.exists(linha.logoKey))) semObjeto.push(linha.code);
  }
  if (semObjeto.length) {
    console.error(`\n  ATENÇÃO: ${semObjeto.length} apontam para arte ausente: ${semObjeto.join(', ')}\n`);
    process.exit(1);
  }
  console.log('  toda arte referenciada existe no armazenamento.\n');

  await prisma.$disconnect();
  process.exit(0);
}

principal().catch(async erro => {
  console.error('\n  ERRO:', erro.message, '\n');
  try { await prisma.$disconnect(); } catch { /* o processo vai morrer de qualquer forma */ }
  process.exit(1);
});

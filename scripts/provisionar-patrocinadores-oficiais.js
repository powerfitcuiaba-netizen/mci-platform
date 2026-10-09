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
 * A FONTE É `data/patrocinadores/`, E O MOTIVO É O EMPACOTAMENTO
 *
 * A primeira versão importava `frontend/src/lib/patrocinadores.js` e lia as
 * artes de `frontend/public/patrocinadores/`. No repositório isso funciona — e
 * foi assim que o roteiro de QA passou. NA IMAGEM NÃO: o `.dockerignore`
 * exclui `frontend` e o `Dockerfile` copia `prisma`, `src`, `scripts`, `data` e
 * `server.js`. O script subiu para produção sem o dado que ele lê, o catálogo
 * ficou VAZIO e a vitrine ficou sem patrocinador nenhum.
 *
 * É a mesma falha que `tests/empacotamento-importador.test.mjs` já existia para
 * impedir, registrada lá com todas as letras: "o script que existe na imagem e
 * o dado que ele lê precisam viajar juntos". Aquele teste cobria o importador
 * de campeonatos; agora cobre este também.
 *
 * `data/` é o diretório que este repositório usa para dado que o script precisa
 * em produção, e é o único que entra na imagem. A cópia em `frontend/` continua
 * existindo e é cobrada por teste: `catalogo.json` tem de bater com
 * `marcasNaOrdemDaHierarquia()`, e cada PNG daqui tem de ser byte a byte igual
 * ao de lá. Divergir reprova.
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
 * Uso (no deploy, pelo `preDeployCommand`, ou à mão no shell do serviço):
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
const RAIZ_DA_SEMENTE = join(__dirname, '..', 'data', 'patrocinadores');
const ARQUIVO_DO_CATALOGO = join(RAIZ_DA_SEMENTE, 'catalogo.json');

// O `code` de cada marca vem pronto do `catalogo.json`, derivado do NOME DO
// ARQUIVO e não do nome de exibição: o arquivo é o que não muda. O nome
// comercial pode ser corrigido ("Integral Medica" → "Integralmedica") sem que a
// marca deixe de ser a mesma, e um `code` que seguisse o nome criaria uma
// segunda linha no provisionamento seguinte. Quem cobra essa derivação é
// `tests/empacotamento-importador.test.mjs`.

/**
 * Lê a semente de `data/patrocinadores/catalogo.json`.
 *
 * A AUSÊNCIA DO ARQUIVO É DITA COM TODAS AS LETRAS. Antes, a fonte era um
 * `import` do frontend, e numa imagem sem ele o script morria com um
 * `ERR_MODULE_NOT_FOUND` que não explica nada a quem lê o log do deploy às
 * duas da manhã. Falha de empacotamento tem de se apresentar como falha de
 * empacotamento.
 */
function catalogoDaSemente() {
  if (!existsSync(ARQUIVO_DO_CATALOGO)) {
    console.error(
      `\n  A semente do catálogo não está nesta instalação: ${ARQUIVO_DO_CATALOGO}\n`
      + '  Isto é falha de EMPACOTAMENTO, não de banco. A imagem precisa trazer\n'
      + '  `data/` inteiro — confira o COPY do Dockerfile e o .dockerignore.\n'
      + '  Nada foi escrito.\n'
    );
    process.exit(1);
  }

  const marcas = JSON.parse(readFileSync(ARQUIVO_DO_CATALOGO, 'utf8'));
  return marcas.map(marca => ({
    code: marca.code,
    name: marca.name,
    level: marca.level,
    sortOrder: marca.sortOrder,
    arquivo: marca.arquivo,
    caminho: join(RAIZ_DA_SEMENTE, marca.arquivo)
  }));
}

async function principal() {
  const catalogo = catalogoDaSemente();

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

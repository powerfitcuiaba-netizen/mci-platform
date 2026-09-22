#!/usr/bin/env node
// ==========================================================================
// RECONSTITUI A CLASSE DOS LANÇAMENTOS HISTÓRICOS JÁ APLICADOS.
//
//   node scripts/backfill-classe-do-catalogo.js                 # diagnóstico
//   node scripts/backfill-classe-do-catalogo.js --aplicar       # escreve
//   node scripts/backfill-classe-do-catalogo.js --temporada=<id>
//
// O QUE ELE FAZ, E SOBRETUDO O QUE ELE NÃO FAZ
//
// Os resultados já aplicados nasceram antes de `RankingPoint.catalogClassId`
// existir. A classe deles está gravada — como TEXTO, em
// `ExternalResult.className`, que é exatamente o que o arquivo de origem
// escreveu. Este script lê esse texto, resolve a classe no catálogo da
// organização pela MESMA função que a importação usa, e preenche a referência
// que faltava.
//
// ELE NÃO CRIA ExternalResult. NÃO CRIA RankingPoint. NÃO ALTERA placing,
// points, superOverallPoints, eventId, seasonId, organizationId nem
// categoryId. A única coluna que ele escreve é `catalogClassId`, e só onde
// ela está nula.
//
// SEM `--aplicar` NADA É ESCRITO: a execução padrão é diagnóstico, e imprime
// a quantidade exata que seria alterada, por categoria e por classe. É essa
// saída que se apresenta ANTES de autorizar a escrita.
//
// IDEMPOTENTE. Rodar duas vezes não encontra mais nada para fazer: o filtro é
// `catalogClassId: null`, e a resolução da classe reusa a que já existe.
// ==========================================================================

const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');
const { nomeDeExibicaoDaClasse, resolverClasseDoCatalogo } = require('../src/utils/classeDoCatalogo');

const temFlag = nome => process.argv.includes(`--${nome}`);
const argumento = (nome, padrao = null) => {
  const achado = process.argv.find(a => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
};

function encerrar(mensagem) {
  console.error(`\n  ${mensagem}\n`);
  process.exit(1);
}

async function main() {
  const aplicar = temFlag('aplicar');
  const temporadaId = argumento('temporada');

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  if (!admin) encerrar('Nenhum SUPER_ADMIN ativo. As tabelas têm RLS forçado e a leitura sem contexto de ator devolve zero linha — o que pareceria "nada a fazer".');

  await withUserContext(admin.id, async () => {
    const onde = {
      catalogClassId: null,
      ...(temporadaId ? { seasonId: temporadaId } : {})
    };

    const pendentes = await prisma.rankingPoint.findMany({
      where: onde,
      select: {
        id: true, organizationId: true, categoryId: true, source: true,
        category: { select: { code: true } },
        externalResult: { select: { className: true } }
      }
    });

    // O TEXTO DA CLASSE VEM DO RESULTADO EXTERNO, que é onde ele foi gravado
    // no momento da aplicação. Quando não houver — lançamento do caminho
    // interno, que tem `classId` e não precisa disto —, a linha é contada
    // como sem origem de classe e NÃO é tocada.
    const classificadas = new Map();
    const semOrigem = [];

    for (const ponto of pendentes) {
      const texto = ponto.externalResult?.className ?? null;
      const nome = nomeDeExibicaoDaClasse({ className: texto });
      if (!nome || !ponto.organizationId) { semOrigem.push(ponto); continue; }

      const chave = `${ponto.organizationId}|${ponto.categoryId ?? ''}|${nome}`;
      if (!classificadas.has(chave)) {
        classificadas.set(chave, {
          organizationId: ponto.organizationId,
          categoryId: ponto.categoryId ?? null,
          categoryCode: ponto.category?.code ?? '(sem categoria)',
          displayName: nome,
          pontos: []
        });
      }
      classificadas.get(chave).pontos.push(ponto.id);
    }

    const grupos = [...classificadas.values()].sort((a, b) =>
      `${a.categoryCode}${a.displayName}`.localeCompare(`${b.categoryCode}${b.displayName}`));

    console.log('\n  LANÇAMENTOS SEM CLASSE DO CATÁLOGO');
    console.log(`  temporada ...................... ${temporadaId ?? '(todas)'}`);
    console.log(`  lançamentos sem catalogClassId . ${pendentes.length}`);
    console.log(`  com texto de classe na origem .. ${pendentes.length - semOrigem.length}`);
    console.log(`  sem texto de classe ............ ${semOrigem.length}  (não serão tocados)`);
    console.log('\n  categoria | classe | quantidade');
    for (const grupo of grupos) {
      console.log(`    ${grupo.categoryCode.padEnd(20)} ${grupo.displayName.padEnd(28)} ${String(grupo.pontos.length).padStart(4)}`);
    }

    if (!aplicar) {
      console.log(`\n  DIAGNÓSTICO — nada foi escrito. ${pendentes.length - semOrigem.length} lançamentos SERIAM alterados.`);
      console.log('  Para escrever: --aplicar\n');
      return;
    }

    let atualizados = 0;
    let classesCriadas = 0;

    for (const grupo of grupos) {
      const antes = await prisma.classCatalog.count({ where: { organizationId: grupo.organizationId } });

      const classe = await resolverClasseDoCatalogo(prisma, {
        organizationId: grupo.organizationId,
        categoryId: grupo.categoryId,
        displayName: grupo.displayName
      });

      if (!classe) continue;
      classesCriadas += (await prisma.classCatalog.count({ where: { organizationId: grupo.organizationId } })) - antes;

      // SÓ `catalogClassId`, e só onde ela está nula. O `where` repete a
      // condição de nulidade de propósito: entre a leitura e a escrita pode
      // ter passado outra execução, e sobrescrever o que ela resolveu seria
      // reescrever história por causa de uma corrida.
      const escrita = await prisma.rankingPoint.updateMany({
        where: { id: { in: grupo.pontos }, catalogClassId: null },
        data: { catalogClassId: classe.id }
      });
      atualizados += escrita.count;
    }

    console.log(`\n  APLICADO. ${atualizados} lançamentos receberam a classe; ${classesCriadas} classes criadas no catálogo.`);
    console.log('  Nenhum ExternalResult criado, nenhum RankingPoint criado, nenhuma pontuação alterada.');
    console.log('  Rode `POST /api/v1/seasons/<id>/recompute` para que a projeção pública passe a enxergar o recorte.\n');
  });
}

main()
  .catch(erro => { console.error(erro); process.exit(1); })
  .finally(() => prisma.$disconnect());

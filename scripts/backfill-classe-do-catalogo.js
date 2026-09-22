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
// existir. A informação para reconstituí-la está gravada — no `ExternalResult`
// daquele lançamento, que guarda o que o arquivo de origem escreveu.
//
// A ÚNICA COLUNA QUE ESTE SCRIPT ESCREVE É `RankingPoint.catalogClassId`, e
// só onde ela está nula. Ele NÃO cria ExternalResult, NÃO cria RankingPoint,
// NÃO cria atleta e NÃO altera placing, points, placementPoints, overallBonus,
// adjustmentPoints, superOverallPoints, categoryId, eventId, seasonId,
// organizationId, athleteId, externalResultId, source, filiação ou invalidação.
//
// SEM `--aplicar` NADA É ESCRITO: a execução padrão é diagnóstico, e imprime
// a quantidade exata que seria alterada, por categoria e por classe. É essa
// saída que se apresenta ANTES de autorizar a escrita.
//
// IDEMPOTENTE. Rodar duas vezes não encontra mais nada para fazer: o filtro é
// `catalogClassId: null`, repetido também no `where` da escrita.
//
// ==========================================================================
// A CATEGORIA VEM DO `ExternalResult`, E NÃO DO LANÇAMENTO.
// ==========================================================================
//
// A primeira versão deste script lia `RankingPoint.categoryId`. Medido na base
// real da federação: os 191 resultados do Ipiranga estão com `categoryId`
// NULO. Com aquela leitura, as 191 linhas cairiam todas como classe GENÉRICA
// da organização — "Masters 35+" solta, sem dono —, e o recorte
// `BIKINI + Masters 35+` deixaria de existir como coisa própria.
//
// Pior: "Masters 35+" de Bikini e "Masters 35+" de Men's Physique virariam a
// MESMA classe. Duas participações de categorias diferentes somadas sob um
// rótulo que não é de nenhuma das duas.
//
// A categoria original não se perdeu: ela está em `ExternalResult.categoryCode`,
// que é o que o arquivo de origem declarou e a importação gravou. É de lá que
// este script parte.
//
// O `Category.id` resolvido serve PARA UMA COISA SÓ: encontrar a classe certa
// no catálogo da organização. Ele NÃO é escrito em `RankingPoint.categoryId` —
// reconstituir aquela coluna é outra decisão, com outro alcance, e não é esta.
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

const SEM_CATEGORIA = '(sem código de categoria na origem)';

async function main() {
  const aplicar = temFlag('aplicar');
  const temporadaId = argumento('temporada');

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  if (!admin) encerrar('Nenhum SUPER_ADMIN ativo. As tabelas têm RLS forçado e a leitura sem contexto de ator devolve zero linha — o que pareceria "nada a fazer".');

  await withUserContext(admin.id, async () => {
    const pendentes = await prisma.rankingPoint.findMany({
      where: {
        catalogClassId: null,
        ...(temporadaId ? { seasonId: temporadaId } : {})
      },
      select: {
        id: true, organizationId: true,
        // `categoryCode` e `className` são o que o arquivo de origem escreveu,
        // gravados na aplicação. São a fonte desta reconstituição.
        externalResult: { select: { categoryCode: true, className: true } }
      }
    });

    // O CATÁLOGO OFICIAL, LIDO UMA VEZ. `Category.code` é único e global — a
    // categoria esportiva é a mesma para todas as organizações. O que é da
    // organização é o CATÁLOGO DE CLASSES, e o recorte por `organizationId`
    // acontece lá, em `resolverClasseDoCatalogo`.
    const categorias = new Map(
      (await prisma.category.findMany({ select: { id: true, code: true } }))
        .map(categoria => [categoria.code.toUpperCase(), categoria])
    );

    const grupos = new Map();
    const semTextoDeClasse = [];
    const semCodigoDeCategoria = [];
    const conflitos = new Map();

    for (const ponto of pendentes) {
      const nome = nomeDeExibicaoDaClasse({ className: ponto.externalResult?.className ?? null });

      // Sem texto de classe não há o que reconstituir — é o lançamento do
      // caminho interno, que tem `classId` e não precisa disto. Não é tocado.
      if (!nome || !ponto.organizationId) { semTextoDeClasse.push(ponto); continue; }

      const codigo = (ponto.externalResult?.categoryCode ?? '').trim().toUpperCase();

      // SEM CÓDIGO DE CATEGORIA A LINHA NÃO É ESCRITA.
      //
      // Cair na classe genérica aqui seria inventar: "Masters 35+" sem dono
      // some junto com o de todas as outras categorias, e o recorte que este
      // trabalho existe para criar deixa de existir. A linha fica pendente e
      // aparece no diagnóstico, que é o estado honesto.
      if (!codigo) { semCodigoDeCategoria.push(ponto); continue; }

      const categoria = categorias.get(codigo);

      // CÓDIGO QUE NÃO É DO CATÁLOGO OFICIAL: CONFLITO, e não categoria nova.
      // O MCI não inventa categoria — nem aqui, nem na importação.
      if (!categoria) {
        if (!conflitos.has(codigo)) conflitos.set(codigo, { codigo, pontos: [] });
        conflitos.get(codigo).pontos.push(ponto.id);
        continue;
      }

      const chave = `${ponto.organizationId}|${categoria.id}|${nome}`;
      if (!grupos.has(chave)) {
        grupos.set(chave, {
          organizationId: ponto.organizationId,
          categoryId: categoria.id,
          categoryCode: categoria.code,
          displayName: nome,
          pontos: []
        });
      }
      grupos.get(chave).pontos.push(ponto.id);
    }

    const ordenados = [...grupos.values()].sort((a, b) =>
      `${a.categoryCode}${a.displayName}`.localeCompare(`${b.categoryCode}${b.displayName}`));

    const resolviveis = ordenados.reduce((soma, grupo) => soma + grupo.pontos.length, 0);
    const emConflito = [...conflitos.values()].reduce((soma, c) => soma + c.pontos.length, 0);

    console.log('\n  LANÇAMENTOS SEM CLASSE DO CATÁLOGO');
    console.log(`  temporada ...................... ${temporadaId ?? '(todas)'}`);
    console.log(`  total pendente ................. ${pendentes.length}`);
    console.log(`  com categoria resolvida ........ ${resolviveis}`);
    console.log(`  sem categoria resolvida ........ ${emConflito + semCodigoDeCategoria.length}`);
    console.log(`  com texto de classe ............ ${pendentes.length - semTextoDeClasse.length}`);
    console.log(`  sem texto de classe ............ ${semTextoDeClasse.length}  (não serão tocados)`);
    console.log(`  conflitos de categoria ......... ${emConflito}  (não serão tocados)`);

    console.log('\n  categoria | classe | quantidade');
    for (const grupo of ordenados) {
      console.log(`    ${grupo.categoryCode.padEnd(20)} ${grupo.displayName.padEnd(28)} ${String(grupo.pontos.length).padStart(4)}`);
    }

    if (conflitos.size || semCodigoDeCategoria.length) {
      console.log('\n  CONFLITOS DE CATEGORIA — nenhuma destas linhas é escrita');
      console.log('  categoryCode | quantidade | motivo');
      for (const conflito of [...conflitos.values()].sort((a, b) => a.codigo.localeCompare(b.codigo))) {
        console.log(`    ${conflito.codigo.padEnd(28)} ${String(conflito.pontos.length).padStart(4)}  código não existe no catálogo oficial de categorias`);
      }
      if (semCodigoDeCategoria.length) {
        console.log(`    ${SEM_CATEGORIA.padEnd(28)} ${String(semCodigoDeCategoria.length).padStart(4)}  a origem não declarou categoria; resolver como classe genérica seria inventar`);
      }
    }

    if (!aplicar) {
      console.log(`\n  DIAGNÓSTICO — nada foi escrito. ${resolviveis} lançamentos SERIAM alterados.`);
      console.log('  Para escrever: --aplicar\n');
      return;
    }

    let atualizados = 0;
    let classesCriadas = 0;

    for (const grupo of ordenados) {
      const antes = await prisma.classCatalog.count({ where: { organizationId: grupo.organizationId } });

      // A MESMA resolução que a importação usa — específica da categoria
      // primeiro, genérica na ausência dela, criação idempotente no fim, e a
      // violação de unicidade tratada como releitura, não como erro.
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

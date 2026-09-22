#!/usr/bin/env node
// ==========================================================================
// RECONSTITUI A CATEGORIA DOS LANÇAMENTOS HISTÓRICOS JÁ APLICADOS.
//
//   node scripts/backfill-categoria-do-lancamento.js                 # auditoria
//   node scripts/backfill-categoria-do-lancamento.js --aplicar       # escreve
//   node scripts/backfill-categoria-do-lancamento.js --temporada=<id>
//
// A ÚNICA COLUNA QUE ESTE SCRIPT ESCREVE É `RankingPoint.categoryId`, e só
// onde ela está NULA. Ele NÃO cria ExternalResult, NÃO cria RankingPoint, NÃO
// cria atleta, NÃO cria categoria e NÃO altera placing, placingOriginal,
// didNotShow, points, placementPoints, overallBonus, adjustmentPoints,
// superOverallPoints, superOverallEligible, isOverallChampion, catalogClassId,
// classId, athleteId, externalAthleteId, externalResultId, eventId, seasonId,
// organizationId, source, equipe, empresa, filiação ou invalidação.
//
// SEM `--aplicar` NADA É ESCRITO: a execução padrão é auditoria, e imprime a
// quantidade exata que seria alterada, por categoria. É essa saída que se
// apresenta ANTES de autorizar a escrita.
//
// IDEMPOTENTE. Rodar duas vezes não encontra mais nada para fazer: o filtro é
// `categoryId: null`, repetido também no `where` da escrita.
//
// ==========================================================================
// A CATEGORIA VEM DO `ExternalResult.categoryCode`, E DE MAIS NADA.
// ==========================================================================
//
// O caminho é um só, e é exato:
//
//     ExternalResult.categoryCode -> Category.code -> Category.id
//
// NÃO se usa o nome da classe para descobrir a categoria. NÃO existe fallback
// genérico. NÃO se cria categoria. NÃO se infere, NÃO se aproxima texto, e
// NÃO se escolhe categoria arbitrária. O MCI não inventa categoria — nem na
// importação, nem aqui.
//
// ==========================================================================
// AUDITORIA PRIMEIRO, E A APLICAÇÃO RECUSA SE A AUDITORIA NÃO FECHAR.
// ==========================================================================
//
// Se qualquer linha ficar sem resolver — código ausente na origem, código
// fora do catálogo oficial, ou dois registros de catálogo disputando o mesmo
// código —, `--aplicar` NÃO escreve nada e sai com erro. Não é conservadorismo
// decorativo: escrever a parte que resolveu deixaria a base em dois estados,
// e o operador teria de descobrir sozinho quais linhas ficaram para trás.
// ==========================================================================

const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');

const temFlag = nome => process.argv.includes(`--${nome}`);
const argumento = (nome, padrao = null) => {
  const achado = process.argv.find(a => a.startsWith(`--${nome}=`));
  return achado ? achado.slice(nome.length + 3) : padrao;
};

function encerrar(mensagem) {
  console.error(`\n  ${mensagem}\n`);
  process.exit(1);
}

const SEM_CODIGO = '(sem código de categoria na origem)';

// O prazo padrão de transação do Prisma é de 5 segundos. `withUserContext`
// abre UMA transação interativa para o script inteiro — auditoria e escrita —,
// e contra banco gerenciado, com latência de rede, 191 linhas em oito grupos
// passam folgadamente disso. O prazo dilatado é do script, e de mais nada:
// nenhuma requisição HTTP passa por aqui.
const PRAZO = { timeout: 120000, maxWait: 30000 };

async function main() {
  const aplicar = temFlag('aplicar');
  const temporadaId = argumento('temporada');

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  if (!admin) encerrar('Nenhum SUPER_ADMIN ativo. As tabelas têm RLS forçado e a leitura sem contexto de ator devolve zero linha — o que pareceria "nada a fazer".');

  const codigoDeSaida = await withUserContext(admin.id, async () => {
    const recorte = { categoryId: null, ...(temporadaId ? { seasonId: temporadaId } : {}) };

    const pendentes = await prisma.rankingPoint.findMany({
      where: recorte,
      select: {
        id: true, organizationId: true, seasonId: true,
        catalogClassId: true,
        // O que o arquivo de origem escreveu, gravado na aplicação. É a fonte
        // desta reconstituição, e a única.
        externalResult: { select: { categoryCode: true } }
      }
    });

    // O CATÁLOGO OFICIAL, LIDO UMA VEZ. `Category.code` é único e global — a
    // categoria esportiva é a mesma para todas as organizações.
    //
    // O mapa é montado detectando COLISÃO: a unicidade do banco é sobre o
    // texto exato, e duas linhas de catálogo cujos códigos só diferem em
    // caixa passariam por ela. Se isso existir, a correspondência deixa de ser
    // "exatamente uma" e a linha vira ambiguidade — não escolha nossa.
    const catalogo = await prisma.category.findMany({ select: { id: true, code: true } });
    const categorias = new Map();
    const ambiguos = new Set();
    for (const categoria of catalogo) {
      const chave = categoria.code.toUpperCase();
      if (categorias.has(chave)) ambiguos.add(chave);
      categorias.set(chave, categoria);
    }

    const grupos = new Map();
    const semCodigo = [];
    const conflitos = new Map();

    const conflitar = (codigo, motivo, pontoId) => {
      if (!conflitos.has(codigo)) conflitos.set(codigo, { codigo, motivo, pontos: [] });
      conflitos.get(codigo).pontos.push(pontoId);
    };

    for (const ponto of pendentes) {
      const codigo = (ponto.externalResult?.categoryCode ?? '').trim().toUpperCase();

      // SEM CÓDIGO NA ORIGEM A LINHA NÃO É ESCRITA. Não há de onde tirar a
      // categoria, e adivinhá-la pelo nome da classe é exatamente o que esta
      // correção não faz.
      if (!codigo) { semCodigo.push(ponto); continue; }

      if (ambiguos.has(codigo)) { conflitar(codigo, 'mais de uma categoria no catálogo responde por este código', ponto.id); continue; }

      const categoria = categorias.get(codigo);

      // CÓDIGO QUE NÃO É DO CATÁLOGO OFICIAL: CONFLITO, e não categoria nova.
      if (!categoria) { conflitar(codigo, 'código não existe no catálogo oficial de categorias', ponto.id); continue; }

      if (!grupos.has(categoria.id)) {
        grupos.set(categoria.id, { categoryId: categoria.id, categoryCode: categoria.code, pontos: [] });
      }
      grupos.get(categoria.id).pontos.push(ponto.id);
    }

    const ordenados = [...grupos.values()].sort((a, b) => a.categoryCode.localeCompare(b.categoryCode));
    const resolvidos = ordenados.reduce((soma, grupo) => soma + grupo.pontos.length, 0);
    const emConflito = [...conflitos.values()].reduce((soma, c) => soma + c.pontos.length, 0);
    const naoResolvidos = emConflito + semCodigo.length;

    console.log('\n  LANÇAMENTOS SEM CATEGORIA');
    console.log(`  temporada ...................... ${temporadaId ?? '(todas)'}`);
    console.log(`  total analisado ................ ${pendentes.length}`);
    console.log(`  resolvidos ..................... ${resolvidos}`);
    console.log(`  não resolvidos ................. ${naoResolvidos}`);
    console.log(`  conflitos ...................... ${emConflito}`);
    console.log(`  categorias encontradas ......... ${ordenados.length}`);
    // A classe já reconstituída é acompanhada de propósito: ela NÃO é tocada
    // aqui, e ver o número antes e depois é o que prova isso.
    console.log(`  com classe do catálogo ......... ${pendentes.filter(p => p.catalogClassId).length}  (não serão tocados)`);

    console.log('\n  categoria | quantidade');
    for (const grupo of ordenados) {
      console.log(`    ${grupo.categoryCode.padEnd(22)} ${String(grupo.pontos.length).padStart(4)}`);
    }

    if (conflitos.size || semCodigo.length) {
      console.log('\n  NÃO RESOLVIDOS — nenhuma destas linhas é escrita');
      console.log('  categoryCode | quantidade | motivo');
      for (const conflito of [...conflitos.values()].sort((a, b) => a.codigo.localeCompare(b.codigo))) {
        console.log(`    ${conflito.codigo.padEnd(28)} ${String(conflito.pontos.length).padStart(4)}  ${conflito.motivo}`);
      }
      if (semCodigo.length) {
        console.log(`    ${SEM_CODIGO.padEnd(28)} ${String(semCodigo.length).padStart(4)}  a origem não declarou categoria; deduzi-la pelo nome da classe seria inventar`);
      }
    }

    if (!aplicar) {
      console.log(`\n  AUDITORIA — nada foi escrito. ${resolvidos} lançamentos SERIAM alterados.`);
      if (naoResolvidos) {
        console.log(`  ATENÇÃO: ${naoResolvidos} não resolvidos. Com qualquer um deles, --aplicar RECUSA escrever.`);
      }
      console.log('  Para escrever: --aplicar\n');
      return 0;
    }

    // A APLICAÇÃO SÓ ACONTECE COM A AUDITORIA FECHADA.
    if (naoResolvidos) {
      console.error(`\n  RECUSADO: ${naoResolvidos} lançamentos não resolvidos. Nada foi escrito.`);
      console.error('  Resolva a origem desses registros antes de aplicar — escrever só a parte que');
      console.error('  resolveu deixaria a base em dois estados, e o resto teria de ser descoberto a mão.\n');
      return 1;
    }

    let atualizados = 0;
    for (const grupo of ordenados) {
      // SÓ `categoryId`, e só onde ela está nula. O `where` repete a condição
      // de nulidade de propósito: entre a leitura e a escrita pode ter passado
      // outra execução, e sobrescrever o que ela resolveu seria reescrever
      // história por causa de uma corrida.
      const escrita = await prisma.rankingPoint.updateMany({
        where: { id: { in: grupo.pontos }, categoryId: null },
        data: { categoryId: grupo.categoryId }
      });
      atualizados += escrita.count;
    }

    // AUDITORIA PÓS-APLICAÇÃO, DENTRO DA MESMA TRANSAÇÃO. Conferir depois, em
    // outra conexão, mediria um estado que já passou por mais coisa.
    const restantes = await prisma.rankingPoint.count({ where: recorte });

    console.log(`\n  APLICADO. ${atualizados} lançamentos receberam a categoria.`);
    console.log(`  ainda sem categoria ............ ${restantes}`);
    console.log('  Nenhum lançamento criado, nenhum removido, nenhuma pontuação alterada, nenhuma classe alterada.');
    console.log(`  Rode \`POST /api/v1/seasons/${temporadaId ?? '<id>'}/recompute\` para a projeção pública enxergar o recorte.\n`);

    return restantes === 0 ? 0 : 1;
  }, PRAZO);

  process.exitCode = codigoDeSaida;
}

main()
  .catch(erro => { console.error(erro); process.exit(1); })
  .finally(() => prisma.$disconnect());

#!/usr/bin/env node
// ============================================================================
// DATASET SINTÉTICO DE CARGA — exclusivamente QA.
//
// Semeia volume por SQL em massa, e não pela API. Criar 10.000 atletas pelo
// caminho de inscrição levaria horas e mediria o balcão de inscrição, não o
// ranking. O que interessa aqui é o VOLUME no banco: é ele que decide se uma
// consulta usa índice ou varre a tabela.
//
// Tudo é FICTÍCIO e vai para um banco descartável. Nomes levam "QA" e os CPFs
// são sintéticos — nenhum dado real entra aqui, e este script nunca deve
// apontar para produção. A guarda no início recusa qualquer URL que não
// contenha "qa".
// ============================================================================

import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

export const URL_QA = arg('db', env.QA_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_qa_carga?schema=public');

// Guarda de destino. Um script que escreve 100.000 linhas não pode ter chance
// de apontar para a base errada por variável de ambiente esquecida.
export function exigirBancoDeQa(url = URL_QA) {
  const nome = url.replace(/\?.*$/, '').split('/').pop();
  if (!/qa/i.test(nome)) {
    throw new Error(`Recusado: "${nome}" não parece banco de QA. O nome precisa conter "qa".`);
  }
  return nome;
}

export function recriarBanco(url = URL_QA) {
  const nome = exigirBancoDeQa(url);
  const semSchema = url.replace(/\?.*$/, '');
  const servidor = semSchema.slice(0, semSchema.lastIndexOf('/')) + '/postgres';
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nome}\\" with (force)"`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nome}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL: url } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL: url } });
  return nome;
}

// CPF sintético com dígitos verificadores corretos: o cadastro valida, e um
// CPF inválido faria a semeadura falhar por motivo que não é o do teste.
export function cpfSintetico(semente) {
  const base = String(semente % 1000000000).padStart(9, '0').split('').map(Number);
  const d1bruto = base.reduce((t, n, i) => t + n * (10 - i), 0);
  const d1 = (d1bruto * 10) % 11 % 10;
  const comD1 = [...base, d1];
  const d2bruto = comD1.reduce((t, n, i) => t + n * (11 - i), 0);
  const d2 = (d2bruto * 10) % 11 % 10;
  return base.join('') + d1 + d2;
}

const id = (prefixo, n) => `qa${prefixo}${String(n).padStart(10, '0')}`;

/**
 * Semeia o cenário de carga.
 *
 * @param {number} atletas        quantos atletas
 * @param {number} pontosPorAtleta quantas participações pontuadas cada um tem
 * @param {number} organizacoes    quantas federações (isolamento multi-tenant)
 */
export async function semear(prisma, { atletas, pontosPorAtleta, organizacoes = 2, categorias = 4 }) {
  const agora = new Date();
  const iso = agora.toISOString();

  // --- organizações, temporadas, filiações
  const orgs = [];
  for (let o = 0; o < organizacoes; o += 1) {
    orgs.push({
      id: id('org', o),
      name: `QA Federação ${o}`,
      slug: `qa-fed-${o}`,
      seasonId: id('sea', o),
      affiliationId: id('afi', o),
      eventId: id('evt', o)
    });
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO "Organization" (id, name, slug, timezone, active, "selfRegistrationOpen", "createdAt", "updatedAt")
    VALUES ${orgs.map(o => `('${o.id}','${o.name}','${o.slug}','America/Cuiaba',true,false,'${iso}','${iso}')`).join(',')}
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RankingSeason" (id, "organizationId", name, year, status, "createdAt", "updatedAt")
    VALUES ${orgs.map(o => `('${o.seasonId}','${o.id}','QA Temporada ${o.slug}',2026,'OPEN','${iso}','${iso}')`).join(',')}
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Affiliation" (id, "organizationId", name, code, kind, state, active, "createdAt", "updatedAt")
    VALUES ${orgs.map(o => `('${o.affiliationId}','${o.id}','QA NPC ${o.slug}','QA-NPC-${o.slug}','ENTITY','MT',true,'${iso}','${iso}')`).join(',')}
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Event" (id, "organizationId", "seasonId", name, slug, status, "startDate", timezone, "createdAt", "updatedAt")
    VALUES ${orgs.map(o => `('${o.eventId}','${o.id}','${o.seasonId}','QA Etapa ${o.slug}','qa-etapa-${o.slug}','RESULTS_PUBLISHED','${iso}','America/Cuiaba','${iso}','${iso}')`).join(',')}
  `);

  // --- categorias do catálogo (já semeadas por prisma/seed.js)
  const doCatalogo = await prisma.category.findMany({ select: { id: true }, take: categorias });
  if (!doCatalogo.length) throw new Error('catálogo de categorias vazio — rode prisma/seed.js');

  // --- classes: uma ABSOLUTA e uma não, por categoria e por organização
  const classes = [];
  for (const [o, org] of orgs.entries()) {
    for (const [c, categoria] of doCatalogo.entries()) {
      const eventCategoryId = id('eca', o * 100 + c);
      const divisionId = id('div', o * 100 + c);
      classes.push({
        eventCategoryId, divisionId, categoryId: categoria.id, eventId: org.eventId,
        open: id('cls', o * 1000 + c * 2),
        novice: id('cls', o * 1000 + c * 2 + 1)
      });
    }
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO "EventCategory" (id, "eventId", "categoryId", "sortOrder", "createdAt")
    VALUES ${classes.map(c => `('${c.eventCategoryId}','${c.eventId}','${c.categoryId}',0,'${iso}')`).join(',')}
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Division" (id, "eventCategoryId", name, code, "sortOrder", "createdAt", "updatedAt")
    VALUES ${classes.map(c => `('${c.divisionId}','${c.eventCategoryId}','QA Divisão','QA-DIV',0,'${iso}','${iso}')`).join(',')}
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "CompetitionClass" (id, "divisionId", name, code, "sortOrder", "superOverallEligible", active, "createdAt", "updatedAt")
    VALUES ${classes.flatMap(c => [
      `('${c.open}','${c.divisionId}','Open','OPEN',0,true,true,'${iso}','${iso}')`,
      `('${c.novice}','${c.divisionId}','Novice','NOVICE',1,false,true,'${iso}','${iso}')`
    ]).join(',')}
  `);

  // --- ATOR DE SEMEADURA.
  //
  // `Athlete` e `AthleteIdentity` têm RLS FORÇADA: nem o dono da tabela
  // escreve nelas sem contexto. A saída NÃO é afrouxar a política — ela é
  // exatamente o que esta fase existe para exercitar. A saída é criar um
  // operador de verdade e semear COMO ELE, que é o caminho pelo qual os dados
  // entrariam na vida real.
  const semeadorId = id('usr', 0);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "User" (id, name, email, "passwordHash", role, status, "createdAt", "updatedAt")
    VALUES ('${semeadorId}','QA Semeador','qa.semeador@mci.local','$2a$04$qaqaqaqaqaqaqaqaqaqaqe','SUPER_ADMIN','ACTIVE','${iso}','${iso}')
    ON CONFLICT (id) DO NOTHING
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "OrganizationMember" (id, "organizationId", "userId", role, "createdAt", "updatedAt")
    VALUES ${orgs.map((o, i) => `('${id('mbr', i)}','${o.id}','${semeadorId}','RANKING_MANAGER','${iso}','${iso}')`).join(',')}
  `);

  // Cada lote abre a sua própria transação com o ator definido: `set_config`
  // com `is_local = true` só vale dentro da transação, que é justamente a
  // garantia de que o contexto não vaza para outra conexão do pool.
  const comoSemeador = async instrucoes => prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT set_config('mci.user_id', '${semeadorId}', true)`);
    for (const sql of instrucoes) await tx.$executeRawUnsafe(sql);
  }, { timeout: 120000 });

  // --- atletas, em lotes: uma instrução com 10.000 VALUES estoura o parser.
  const LOTE = 500;
  for (let inicio = 0; inicio < atletas; inicio += LOTE) {
    const fim = Math.min(inicio + LOTE, atletas);
    const linhas = [];
    const identidades = [];
    for (let a = inicio; a < fim; a += 1) {
      const org = orgs[a % orgs.length];
      linhas.push(`('${id('ath', a)}','${org.id}','QA Atleta ${a}','${a % 2 ? 'MALE' : 'FEMALE'}','BR','MT','QA City','${org.affiliationId}','QA-${a}','NONE','${iso}','${iso}')`);
      // `AthleteIdentity` é identificada pelo próprio athleteId — não tem id
      // próprio. É a tabela que isola o CPF sob política de linha.
      identidades.push(`('${id('ath', a)}','${org.id}','${cpfSintetico(a + 1000)}','${iso}','${iso}')`);
    }
    await comoSemeador([
      `INSERT INTO "Athlete" (id, "organizationId", "fullName", sex, country, state, city, "affiliationId", "affiliationNumber", "proStatus", "createdAt", "updatedAt")
       VALUES ${linhas.join(',')}`,
      `INSERT INTO "AthleteIdentity" ("athleteId", "organizationId", cpf, "createdAt", "updatedAt")
       VALUES ${identidades.join(',')}`
    ]);
  }

  // --- pontos de ranking: o volume que decide se a consulta usa índice.
  //
  // `resultId` fica NULO: a unicidade é (seasonId, athleteId, resultId), e o
  // PostgreSQL trata NULL como distinto — é o que permite várias participações
  // por atleta sem inventar resultados falsos. As parcelas seguem a regra
  // oficial: `points = placementPoints + overallBonus`.
  const TABELA = [5, 4, 3, 2, 1];
  let escritos = 0;
  for (let inicio = 0; inicio < atletas; inicio += LOTE) {
    const fim = Math.min(inicio + LOTE, atletas);
    const linhas = [];
    for (let a = inicio; a < fim; a += 1) {
      const org = orgs[a % orgs.length];
      for (let p = 0; p < pontosPorAtleta; p += 1) {
        const classe = classes[(a + p) % classes.length];
        const ehAbsoluta = p % 2 === 0;
        const colocacao = (a + p) % 5 + 1;
        const placement = TABELA[colocacao - 1];
        // Um campeão Overall a cada 500 atletas, e só na absoluta.
        const bonus = (ehAbsoluta && a % 500 === 0 && p === 0) ? 10 : 0;
        const pontos = placement + bonus;
        const elegivel = ehAbsoluta;
        linhas.push(
          `('${id('rkp', escritos)}','${org.seasonId}','${id('ath', a)}','${classe.categoryId}','EVENT','${org.eventId}',`
          + `${colocacao},${placement},${bonus},${bonus > 0},${elegivel},${pontos},${elegivel ? pontos : 0},`
          + `'${ehAbsoluta ? classe.open : classe.novice}','${org.affiliationId}','QA-${a}','${iso}','${iso}')`
        );
        escritos += 1;
      }
    }
    if (!linhas.length) continue;
    await prisma.$executeRawUnsafe(`
      INSERT INTO "RankingPoint"
        -- source e placing ENTRE ASPAS: no PostgreSQL 16 "source" e palavra do
        -- MERGE, e sem aspas o parser quebra no identificador SEGUINTE. O erro
        -- aponta para "placing", que nao tem nada de errado.
        (id, "seasonId", "athleteId", "categoryId", "source", "eventId",
         "placing", "placementPoints", "overallBonus", "isOverallChampion", "superOverallEligible", points, "superOverallPoints",
         "classId", "affiliationId", "affiliationNumber", "awardedAt", "createdAt")
      VALUES ${linhas.join(',')}
    `);
  }

  // --- agregado: o ranking derivado, que é o que `GET /ranking` lê.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Ranking" (id, "seasonId", "athleteId", "categoryId", "totalPoints", "eventCount",
                           "overallWins", "firstPlaceCount", "secondPlaceCount", "thirdPlaceCount",
                           "fourthPlaceCount", "fifthPlaceCount",
                           position, "tieUnresolved", "updatedAt")
    SELECT
      'qagg' || lpad((row_number() over ())::text, 10, '0'),
      p."seasonId", p."athleteId", NULL,
      sum(p.points)::int, count(distinct p."eventId")::int,
      sum(case when p."isOverallChampion" then 1 else 0 end)::int,
      sum(case when p.placing = 1 then 1 else 0 end)::int,
      sum(case when p.placing = 2 then 1 else 0 end)::int,
      sum(case when p.placing = 3 then 1 else 0 end)::int,
      0, 0,
      (row_number() over (partition by p."seasonId" order by sum(p.points) desc, p."athleteId"))::int,
      false, '${iso}'
    FROM "RankingPoint" p
    GROUP BY p."seasonId", p."athleteId"
  `);

  await prisma.$executeRawUnsafe('ANALYZE');

  return {
    organizacoes: orgs,
    atletas,
    pontos: escritos,
    classes: classes.length * 2
  };
}

// Execução direta: `node scripts/qa/dataset.mjs --atletas 1000 --pontos 10`
if (import.meta.url === `file://${process.argv[1]}`) {
  const atletas = Number(arg('atletas', 1000));
  const pontosPorAtleta = Number(arg('pontos', 10));

  console.log(`recriando ${exigirBancoDeQa()}…`);
  recriarBanco();

  const prisma = new PrismaClient({ datasources: { db: { url: URL_QA } } });
  console.time('semeadura');
  const resumo = await semear(prisma, { atletas, pontosPorAtleta });
  console.timeEnd('semeadura');
  console.log(JSON.stringify(resumo, (chave, valor) => (chave === 'organizacoes' ? `${valor.length} org(s)` : valor), 2));
  await prisma.$disconnect();
}

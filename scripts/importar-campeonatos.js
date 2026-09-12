#!/usr/bin/env node
// ==========================================================================
// Carrega o calendário oficial de campeonatos numa temporada.
//
//   node scripts/importar-campeonatos.js --dry-run
//   node scripts/importar-campeonatos.js
//   node scripts/importar-campeonatos.js --organizacao=<slug> --status=DRAFT
//
// A fonte é data/campeonatos-2026.json, transcrição literal do PDF oficial.
// NADA é inferido: onde o documento diz "a confirmar", o campo entra vazio.
// Cidade inventada em calendário de campeonato vira atleta viajando para o
// lugar errado.
//
// IDEMPOTENTE. A chave é o slug. Rodar duas vezes não duplica evento: o que já
// existe é atualizado. E o status de um evento que já existe NUNCA é rebaixado
// — se a etapa já abriu inscrição ou está em operação, reimportar o calendário
// não pode jogá-la de volta para "planejado".
// ==========================================================================

const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../src/config/prisma');
const audit = require('../src/services/auditService');
const { withUserContext } = require('../src/config/rlsSession');

const ARQUIVO = path.join(__dirname, '..', 'data', 'campeonatos-2026.json');

// Fuso por unidade federativa. O evento guarda o próprio fuso porque chamada de
// palco e pesagem são exibidas nele: Manaus e Cuiabá não estão no horário de
// São Paulo, e uma bateria anunciada com uma hora de diferença é problema real
// de operação, não detalhe.
const FUSO_POR_UF = {
  AM: 'America/Manaus', RR: 'America/Boa_Vista', RO: 'America/Porto_Velho',
  AC: 'America/Rio_Branco', MT: 'America/Cuiaba', MS: 'America/Campo_Grande'
};
const fusoDe = uf => FUSO_POR_UF[uf] || 'America/Sao_Paulo';

// Meio-dia UTC, e não meia-noite: às 00:00Z a data já virou no Brasil, e o
// evento de 12/09 apareceria como 11/09 na tela. É a convenção que a suíte já
// usa.
const noMeioDia = data => new Date(`${data}T12:00:00.000Z`);

function gerarSlug(nome, ano) {
  const base = nome
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}-${ano}`.slice(0, 80);
}

const argumento = (nome, padrao = null) => {
  const encontrado = process.argv.find(a => a.startsWith(`--${nome}=`));
  return encontrado ? encontrado.split('=').slice(1).join('=') : padrao;
};
const temFlag = nome => process.argv.includes(`--${nome}`);

const encerrar = (mensagem, codigo = 1) => { console.error(mensagem); process.exit(codigo); };

async function main() {
  const ensaio = temFlag('dry-run');
  const statusAlvo = argumento('status', 'PLANNED');
  if (!['DRAFT', 'PLANNED'].includes(statusAlvo)) {
    encerrar('--status aceita apenas DRAFT ou PLANNED. Abrir inscrição é ato do operador, não da importação.');
  }

  const dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  const { eventos, temporada: nomeTemporada, ano } = dados;

  // O ator precisa existir antes de tudo: as tabelas têm RLS forçado, e
  // escrita sem contexto de ator não enxerga a própria linha.
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
  if (!admin) encerrar('Nenhum SUPER_ADMIN ativo. Crie o primeiro administrador antes (scripts/criar-admin.js).');

  await withUserContext(admin.id, async () => {
    const organizacoes = await prisma.organization.findMany({ select: { id: true, name: true, slug: true } });
    const slugPedido = argumento('organizacao');

    let organizacao;
    if (slugPedido) {
      organizacao = organizacoes.find(o => o.slug === slugPedido);
      if (!organizacao) encerrar(`Organização "${slugPedido}" não encontrada. Existentes: ${organizacoes.map(o => o.slug).join(', ') || '(nenhuma)'}`);
    } else if (organizacoes.length === 1) {
      organizacao = organizacoes[0];
    } else {
      encerrar(organizacoes.length === 0
        ? 'Nenhuma organização cadastrada. Crie a federação promotora antes de importar o calendário.'
        : `Há ${organizacoes.length} organizações. Escolha uma: --organizacao=<slug>\n  ${organizacoes.map(o => `${o.slug}  (${o.name})`).join('\n  ')}`);
    }

    let temporada = await prisma.rankingSeason.findFirst({
      where: { organizationId: organizacao.id, name: nomeTemporada }
    });

    console.log(`organização ...... ${organizacao.name} (${organizacao.slug})`);
    console.log(`temporada ........ ${nomeTemporada}${temporada ? ' (já existia)' : ' (será criada)'}`);
    console.log(`status dos novos . ${statusAlvo}`);
    console.log(`${ensaio ? 'ENSAIO — nada será gravado' : 'gravando'}\n`);

    if (!temporada && !ensaio) {
      temporada = await prisma.rankingSeason.create({
        data: {
          organizationId: organizacao.id, name: nomeTemporada, year: ano, status: 'OPEN',
          startDate: noMeioDia(`${ano}-01-01`), endDate: noMeioDia(`${ano}-12-31`)
        }
      });
      await audit.record({
        actor: admin, action: 'SEASON_CREATE', entity: 'RankingSeason', entityId: temporada.id,
        organizationId: organizacao.id, metadata: { via: 'scripts/importar-campeonatos.js', nome: nomeTemporada, ano }
      });
    }

    const resumo = { criados: 0, atualizados: 0, inalterados: 0 };
    const semCidade = [];
    const semLocal = [];

    for (const evento of eventos) {
      const slug = gerarSlug(evento.nome, ano);
      const existente = await prisma.event.findUnique({ where: { slug } });

      const campos = {
        name: evento.nome,
        // Não há campo de endereço no modelo: o endereço completo vai para a
        // descrição, que é o que a página pública do evento exibe.
        description: evento.endereco || null,
        venue: evento.local || null,
        city: evento.cidade || null,
        state: evento.uf || null,
        timezone: fusoDe(evento.uf),
        startDate: noMeioDia(evento.inicio),
        endDate: noMeioDia(evento.fim || evento.inicio),
        seasonId: temporada ? temporada.id : null
      };

      if (!evento.cidade) semCidade.push(`${String(evento.n).padStart(2)} ${evento.nome}`);
      if (!evento.local) semLocal.push(`${String(evento.n).padStart(2)} ${evento.nome}`);

      if (!existente) {
        resumo.criados += 1;
        if (!ensaio) {
          const criado = await prisma.event.create({
            data: { ...campos, slug, organizationId: organizacao.id, status: statusAlvo, createdById: admin.id }
          });
          await audit.record({
            actor: admin, action: 'EVENT_CREATE', entity: 'Event', entityId: criado.id,
            organizationId: organizacao.id,
            metadata: { via: 'scripts/importar-campeonatos.js', fonte: dados.fonte, numeroNoDocumento: evento.n }
          });
        }
        console.log(`  + ${String(evento.n).padStart(2)}  ${evento.nome.padEnd(30)} ${evento.inicio}  ${slug}`);
        continue;
      }

      const mudou = Object.entries(campos).some(([chave, valor]) => {
        const atual = existente[chave];
        if (valor instanceof Date) return new Date(atual).getTime() !== valor.getTime();
        return (atual ?? null) !== (valor ?? null);
      });

      if (!mudou) {
        resumo.inalterados += 1;
        continue;
      }

      resumo.atualizados += 1;
      if (!ensaio) {
        // `status` fica FORA do update de propósito: reimportar o calendário não
        // pode rebaixar uma etapa que já abriu inscrição ou está em operação.
        await prisma.event.update({ where: { id: existente.id }, data: campos });
        await audit.record({
          actor: admin, action: 'EVENT_UPDATE', entity: 'Event', entityId: existente.id,
          organizationId: organizacao.id,
          metadata: { via: 'scripts/importar-campeonatos.js', fonte: dados.fonte, numeroNoDocumento: evento.n }
        });
      }
      console.log(`  ~ ${String(evento.n).padStart(2)}  ${evento.nome.padEnd(30)} ${evento.inicio}  ${slug}  (atualizado, status preservado: ${existente.status})`);
    }

    console.log(`\ncriados ${resumo.criados} · atualizados ${resumo.atualizados} · já iguais ${resumo.inalterados} · total ${eventos.length}`);

    if (semCidade.length) {
      console.log(`\nSEM CIDADE no documento — ${semCidade.length} evento(s). Ficaram VAZIOS, nada foi inferido:`);
      for (const linha of semCidade) console.log(`   ${linha}`);
    }
    if (semLocal.length) {
      console.log(`\nSEM LOCAL no documento — ${semLocal.length} evento(s):`);
      for (const linha of semLocal) console.log(`   ${linha}`);
    }
    if (ensaio) console.log('\nENSAIO: nada foi gravado. Rode sem --dry-run para aplicar.');
  });
}

main()
  .catch(erro => encerrar(`Falhou: ${erro.message}`))
  .finally(() => prisma.$disconnect());

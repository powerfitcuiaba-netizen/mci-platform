import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, comoAtor } from './helpers.mjs';

// ==========================================================================
// A CARGA DO CALENDÁRIO PRECISA PODER SER REPETIDA.
//
// O calendário oficial é carregado por um script de linha de comando, rodado
// à mão em produção. Um script assim é rodado de novo por motivos banais: o
// operador não tem certeza se a primeira vez funcionou, a conexão caiu no
// meio, o deploy foi refeito. Se a segunda execução duplicar as 47 etapas, o
// calendário público passa a mostrar cada campeonato duas vezes — e o
// operador não tem como saber qual das duas linhas recebeu as inscrições.
//
// `tests/empacotamento-importador.test.mjs` já cobre o empacotamento, o
// --dry-run e a recusa com várias organizações. O que NÃO estava coberto é o
// que este arquivo fecha: rodar de verdade, duas e três vezes, e provar que o
// resultado lógico não muda — e que uma etapa que já saiu do planejamento não
// é rebaixada pela reimportação.
// ==========================================================================

const RAIZ = process.cwd();
const CALENDARIO = JSON.parse(readFileSync(path.join(RAIZ, 'data', 'campeonatos-2026.json'), 'utf8'));
const TOTAL = CALENDARIO.eventos.length;

const importar = (args = []) => spawnSync(
  process.execPath,
  [path.join(RAIZ, 'scripts', 'importar-campeonatos.js'), ...args],
  { cwd: RAIZ, env: process.env, encoding: 'utf8', timeout: 180000 }
);

// A fotografia lógica do calendário: o que precisa permanecer estável entre
// execuções. `id` entra de propósito — se o importador recriasse a linha em
// vez de atualizar, o id mudaria e as inscrições apontariam para um evento
// que não é mais o exibido.
const fotografia = async () => {
  const eventos = await prisma.event.findMany({
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true, name: true, startDate: true, endDate: true, city: true, state: true, venue: true, organizationId: true, seasonId: true, status: true }
  });
  return eventos.map(e => ({ ...e, startDate: e.startDate.toISOString(), endDate: e.endDate?.toISOString() ?? null }));
};

let admin;

beforeAll(() => garantirCatalogo());

describe('carga do calendário: repetir não duplica', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
    await criarOrganizacao(admin, { name: 'Muscle Contest Brasil' });
  });

  it('primeira execução cria as 47 etapas do documento oficial', async () => {
    const r = importar();
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`criados ${TOTAL}`));

    expect(await prisma.event.count()).toBe(TOTAL);

    // Nenhum slug repetido: o slug é a chave lógica da carga.
    const slugs = (await prisma.event.findMany({ select: { slug: true } })).map(e => e.slug);
    expect(new Set(slugs).size).toBe(TOTAL);
  });

  it('segunda e terceira execução não duplicam, não recriam e não alteram o resultado lógico', async () => {
    expect(importar().status).toBe(0);
    const depoisDaPrimeira = await fotografia();
    expect(depoisDaPrimeira).toHaveLength(TOTAL);

    const segunda = importar();
    expect(segunda.status, segunda.stderr).toBe(0);
    expect(segunda.stdout).toMatch(new RegExp(`criados 0`));
    expect(segunda.stdout).toMatch(new RegExp(`já iguais ${TOTAL}`));

    const terceira = importar();
    expect(terceira.status, terceira.stderr).toBe(0);
    expect(terceira.stdout).toMatch(new RegExp(`criados 0`));

    expect(await prisma.event.count()).toBe(TOTAL);
    // Igualdade campo a campo, id incluído: nada foi recriado.
    expect(await fotografia()).toEqual(depoisDaPrimeira);
  });

  it('repetir não cria uma segunda temporada', async () => {
    importar(); importar(); importar();
    expect(await prisma.rankingSeason.count()).toBe(1);
  });

  it('a etapa que já saiu do planejamento NÃO é rebaixada pela reimportação', async () => {
    expect(importar().status).toBe(0);

    // O operador move uma etapa adiante na máquina de estados — é o caso real
    // que torna a reimportação perigosa.
    //
    // O `venue` é sujado de propósito JUNTO. Sem isso o importador considera a
    // linha idêntica ao calendário, pula o UPDATE inteiro e o status nunca é
    // exercitado: o teste passaria mesmo com a proteção removida. Medido — a
    // primeira versão deste teste sobreviveu à mutação que reescreve o status.
    const etapa = await prisma.event.findFirst({ orderBy: { slug: 'asc' } });
    await comoAtor(admin, () => prisma.event.update({
      where: { id: etapa.id }, data: { status: 'REGISTRATIONS_OPEN', venue: 'Ginásio divergente do calendário' }
    }));

    const r = importar();
    expect(r.status, r.stderr).toBe(0);

    expect(r.stdout, 'o importador não passou pelo caminho de UPDATE: o teste não provaria nada')
      .toMatch(/atualizados 1/);

    const depois = await prisma.event.findUnique({ where: { id: etapa.id } });
    // O campo do CALENDÁRIO volta ao que diz o documento oficial...
    expect(depois.venue).not.toBe('Ginásio divergente do calendário');
    // ...e o campo OPERACIONAL é preservado.
    expect(depois.status, 'reimportar rebaixou uma etapa que já estava com inscrições abertas').toBe('REGISTRATIONS_OPEN');
  });

  it('reimportar preserva as inscrições já recebidas — a linha é atualizada, não trocada', async () => {
    expect(importar().status).toBe(0);
    const antes = await prisma.event.findFirst({ orderBy: { slug: 'asc' }, select: { id: true, slug: true } });

    expect(importar().status).toBe(0);

    const depois = await prisma.event.findUnique({ where: { slug: antes.slug }, select: { id: true } });
    expect(depois.id, 'o id mudou: a etapa foi recriada e qualquer inscrição apontaria para a linha antiga').toBe(antes.id);
  });
});

describe('carga do calendário: escolha da organização', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
  });

  it('sem nenhuma organização, recusa e não grava nada', async () => {
    const r = importar();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Nenhuma organização cadastrada/);
    expect(await prisma.event.count()).toBe(0);
  });

  it('com exatamente uma organização, usa essa — não há ambiguidade a resolver', async () => {
    const org = await criarOrganizacao(admin, { name: 'Federação Única' });
    expect(importar().status).toBe(0);

    const eventos = await prisma.event.findMany({ select: { organizationId: true } });
    expect(eventos).toHaveLength(TOTAL);
    expect(new Set(eventos.map(e => e.organizationId))).toEqual(new Set([org.id]));
  });

  it('com duas organizações, recusa escolher sozinho e NÃO grava em nenhuma', async () => {
    await criarOrganizacao(admin, { name: 'Federação A' });
    await criarOrganizacao(admin, { name: 'Federação B' });

    const r = importar();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Há 2 organizações/);
    expect(r.stderr).toMatch(/--organizacao=/);
    expect(await prisma.event.count()).toBe(0);
  });

  it('com --organizacao, grava exatamente na federação pedida e em nenhuma outra', async () => {
    const a = await criarOrganizacao(admin, { name: 'Federação A' });
    const b = await criarOrganizacao(admin, { name: 'Federação B' });

    const r = importar([`--organizacao=${b.slug}`]);
    expect(r.status, r.stderr).toBe(0);

    expect(await prisma.event.count({ where: { organizationId: b.id } })).toBe(TOTAL);
    expect(await prisma.event.count({ where: { organizationId: a.id } })).toBe(0);
  });

  it('slug de organização inexistente é recusado — nada de cair na primeira da lista', async () => {
    await criarOrganizacao(admin, { name: 'Federação A' });

    const r = importar(['--organizacao=nao-existe']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não encontrada/);
    expect(await prisma.event.count()).toBe(0);
  });

  it('sem SUPER_ADMIN ativo, recusa — escrita sob RLS exige ator', async () => {
    await criarOrganizacao(admin, { name: 'Federação Única' });
    await prisma.user.update({ where: { id: admin.id }, data: { status: 'SUSPENDED' } });

    const r = importar();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SUPER_ADMIN/);
    expect(await prisma.event.count()).toBe(0);
  });
});

describe('carga do calendário: o ensaio não escreve', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
    await criarOrganizacao(admin, { name: 'Federação Única' });
  });

  it('--dry-run não cria evento, temporada nem linha de auditoria', async () => {
    const r = importar(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ENSAIO — nada será gravado');
    expect(r.stdout).toMatch(new RegExp(`criados ${TOTAL}`));

    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.rankingSeason.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('o ensaio DEPOIS da carga relata tudo como já igual, e continua sem escrever', async () => {
    expect(importar().status).toBe(0);
    const antes = await fotografia();
    const auditoriaAntes = await prisma.auditLog.count();

    const ensaio = importar(['--dry-run']);
    expect(ensaio.status, ensaio.stderr).toBe(0);
    // O ensaio precisa dizer a verdade sobre o que faria: depois de uma carga
    // completa, a resposta honesta é "nada a fazer". Um ensaio que anuncia 47
    // alterações inexistentes treina o operador a ignorar o ensaio.
    expect(ensaio.stdout).toMatch(new RegExp(`criados 0`));
    expect(ensaio.stdout).toMatch(new RegExp(`atualizados 0`));
    expect(ensaio.stdout).toMatch(new RegExp(`já iguais ${TOTAL}`));

    expect(await fotografia()).toEqual(antes);
    expect(await prisma.auditLog.count()).toBe(auditoriaAntes);
  });
});

describe('carga do calendário: não invade outra federação', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
  });

  // `Event.slug` é único no banco INTEIRO, não por organização. Antes desta
  // proteção, importar o calendário da federação A encontrava pelo slug uma
  // etapa da federação B e a ATUALIZAVA: nome, ginásio e cidade trocados pelos
  // do calendário da A, e o `seasonId` apontando para a temporada da A — os
  // pontos daquela etapa iriam para o ranking da federação errada. A federação
  // A ficava com 46 das 47 etapas e o script saía com código 0.
  it('recusa a carga inteira quando um slug do calendário é de outra federação, e não grava NADA', async () => {
    const a = await criarOrganizacao(admin, { name: 'Federação A' });
    const b = await criarOrganizacao(admin, { name: 'Federação B' });

    const slugColidente = CALENDARIO.eventos
      .map(e => e.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + `-${CALENDARIO.ano}`)[0];

    const doB = await comoAtor(admin, () => prisma.event.create({
      data: {
        organizationId: b.id, name: 'Etapa própria da B', slug: slugColidente,
        status: 'REGISTRATIONS_OPEN',
        startDate: new Date('2026-05-05T12:00:00.000Z'), endDate: new Date('2026-05-05T12:00:00.000Z'),
        venue: 'Ginásio da B', city: 'Salvador', state: 'BA', createdById: admin.id
      }
    }));

    const r = importar([`--organizacao=${a.slug}`]);

    expect(r.status, 'a carga deveria ter sido recusada').not.toBe(0);
    expect(r.stderr).toMatch(/OUTRA federação/);
    expect(r.stderr).toContain(slugColidente);

    // A etapa da B está intacta, campo a campo.
    const depois = await prisma.event.findUnique({ where: { id: doB.id } });
    expect(depois.name).toBe('Etapa própria da B');
    expect(depois.venue).toBe('Ginásio da B');
    expect(depois.city).toBe('Salvador');
    expect(depois.organizationId).toBe(b.id);
    expect(depois.status).toBe('REGISTRATIONS_OPEN');
    expect(depois.seasonId, 'a etapa da B foi vinculada à temporada da A').toBeNull();

    // E a federação A não recebeu meia carga.
    expect(await prisma.event.count({ where: { organizationId: a.id } })).toBe(0);
    expect(await prisma.rankingSeason.count({ where: { organizationId: a.id } })).toBe(0);
  });

  it('o ensaio também recusa a colisão — o operador descobre ANTES de gravar', async () => {
    const a = await criarOrganizacao(admin, { name: 'Federação A' });
    const b = await criarOrganizacao(admin, { name: 'Federação B' });
    const slugColidente = CALENDARIO.eventos
      .map(e => e.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + `-${CALENDARIO.ano}`)[0];

    await comoAtor(admin, () => prisma.event.create({
      data: {
        organizationId: b.id, name: 'Etapa própria da B', slug: slugColidente, status: 'PLANNED',
        startDate: new Date('2026-05-05T12:00:00.000Z'), endDate: new Date('2026-05-05T12:00:00.000Z'),
        createdById: admin.id
      }
    }));

    const r = importar([`--organizacao=${a.slug}`, '--dry-run']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OUTRA federação/);
  });

  it('sem colisão, duas federações convivem: a carga da A não toca nos eventos da B', async () => {
    const a = await criarOrganizacao(admin, { name: 'Federação A' });
    const b = await criarOrganizacao(admin, { name: 'Federação B' });

    const doB = await comoAtor(admin, () => prisma.event.create({
      data: {
        organizationId: b.id, name: 'Etapa exclusiva da B', slug: 'etapa-exclusiva-da-b-2026',
        status: 'IN_OPERATION',
        startDate: new Date('2026-05-05T12:00:00.000Z'), endDate: new Date('2026-05-05T12:00:00.000Z'),
        venue: 'Ginásio da B', city: 'Salvador', state: 'BA', createdById: admin.id
      }
    }));

    const r = importar([`--organizacao=${a.slug}`]);
    expect(r.status, r.stderr).toBe(0);

    expect(await prisma.event.count({ where: { organizationId: a.id } })).toBe(TOTAL);

    const depois = await prisma.event.findUnique({ where: { id: doB.id } });
    expect(depois).toMatchObject({
      name: 'Etapa exclusiva da B', venue: 'Ginásio da B', city: 'Salvador',
      status: 'IN_OPERATION', organizationId: b.id, seasonId: null
    });
  });
});

describe('carga do calendário: carga parcial é recuperável', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
    await criarOrganizacao(admin, { name: 'Federação Única' });
  });

  // A carga inteira roda numa transação só — é o `withUserContext` que a abre,
  // e o teste de atomicidade logo abaixo prova isso. Ainda assim o calendário
  // pode acabar incompleto por caminhos que a transação não cobre: alguém
  // apagar etapas, uma carga feita com um recorte diferente do arquivo, ou uma
  // etapa nova acrescentada ao documento oficial depois da primeira carga. O
  // que precisa ser verdade nesses casos é que rodar de novo completa o
  // serviço sem duplicar nada e sem mexer no que já entrou.
  it('rodar de novo depois de uma carga interrompida completa o calendário sem duplicar', async () => {
    expect(importar().status).toBe(0);
    const completo = await fotografia();

    // Simula a interrupção: parte das etapas nunca chegou a ser gravada.
    const sobreviventes = await prisma.event.findMany({ orderBy: { slug: 'asc' }, take: 20, select: { id: true } });
    await comoAtor(admin, () => prisma.event.deleteMany({
      where: { id: { notIn: sobreviventes.map(e => e.id) } }
    }));
    expect(await prisma.event.count()).toBe(20);

    const retomada = importar();
    expect(retomada.status, retomada.stderr).toBe(0);
    expect(retomada.stdout).toMatch(new RegExp(`criados ${TOTAL - 20}`));
    expect(retomada.stdout).toMatch(/já iguais 20/);

    expect(await prisma.event.count()).toBe(TOTAL);

    // As 20 que sobreviveram mantiveram o mesmo id — não foram recriadas.
    const idsDepois = new Set((await prisma.event.findMany({ select: { id: true } })).map(e => e.id));
    for (const s of sobreviventes) expect(idsDepois.has(s.id)).toBe(true);

    // E o calendário final é logicamente igual ao de uma carga limpa.
    const refeito = await fotografia();
    expect(refeito.map(e => e.slug)).toEqual(completo.map(e => e.slug));
    expect(refeito).toHaveLength(TOTAL);
  });
});

describe('carga do calendário: superfície de ataque', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
    await criarOrganizacao(admin, { name: 'Federação Única' });
  });

  // A proteção mais forte do importador é NÃO ter porta: ele é um script de
  // linha de comando, roda no shell do servidor, e nenhuma requisição HTTP o
  // dispara. Se um dia alguém expuser isso como rota, este teste cai.
  it('nenhuma rota HTTP dispara a importação do calendário', async () => {
    const atleta = await criarUsuario({ name: 'Atleta curiosa' });

    for (const caminho of [
      '/api/v1/events/import', '/api/v1/events/importar', '/api/v1/import/events',
      '/api/v1/campeonatos/importar', '/api/v1/admin/importar-campeonatos'
    ]) {
      for (const token of [null, atleta.auth(), admin.auth()]) {
        const requisicao = api().post(caminho);
        const resposta = await (token ? requisicao.set(token) : requisicao).send({});
        expect([401, 403, 404], `${caminho} respondeu ${resposta.status}: existe rota de importação exposta`)
          .toContain(resposta.status);
      }
    }

    expect(await prisma.event.count()).toBe(0);
  });

  it('--organizacao não é concatenado em SQL: carga maliciosa vira "não encontrada"', async () => {
    for (const carga of [
      "'; DROP TABLE \"Event\"; --",
      '../../../etc/passwd',
      '%00admin',
      'federacao-unica OR 1=1'
    ]) {
      const r = importar([`--organizacao=${carga}`]);
      expect(r.status, `aceitou "${carga}"`).not.toBe(0);
      expect(r.stderr).toMatch(/não encontrada/);
    }

    // O banco continua de pé e nada foi gravado.
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.event.count()).toBe(0);
  });

  it('--status só aceita DRAFT ou PLANNED: a importação nunca abre inscrição', async () => {
    for (const proibido of ['REGISTRATIONS_OPEN', 'IN_OPERATION', 'RESULTS_PUBLISHED', 'CLOSED', 'qualquer-coisa']) {
      const r = importar([`--status=${proibido}`]);
      expect(r.status, `aceitou --status=${proibido}`).not.toBe(0);
      expect(r.stderr).toMatch(/--status aceita apenas DRAFT ou PLANNED/);
    }
    expect(await prisma.event.count()).toBe(0);
  });

  it('as etapas nascem em estado de preparo, nunca operando', async () => {
    expect(importar().status).toBe(0);
    const estados = await prisma.event.groupBy({ by: ['status'], _count: true });
    expect(estados).toEqual([{ status: 'PLANNED', _count: TOTAL }]);

    // E nenhuma inscrição, bateria ou resultado apareceu do nada.
    expect(await prisma.registration.count()).toBe(0);
    expect(await prisma.result.count()).toBe(0);
  });

  it('a carga fica registrada na auditoria, com autor e origem', async () => {
    expect(importar().status).toBe(0);

    // `AuditLog` está sob RLS: ler sem contexto de ator devolve lista vazia,
    // o que faria este teste passar por engano se ele esperasse zero.
    const linhas = await comoAtor(admin, () => prisma.auditLog.findMany({ where: { action: 'EVENT_CREATE' } }));
    expect(linhas).toHaveLength(TOTAL);
    expect(linhas.every(l => l.userId === admin.id)).toBe(true);
    expect(linhas.every(l => l.metadata?.via === 'scripts/importar-campeonatos.js')).toBe(true);
  });
});

describe('carga do calendário: a carga é tudo ou nada', () => {
  beforeEach(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora da carga' });
    await criarOrganizacao(admin, { name: 'Federação Única' });
  });

  // As 47 etapas, a temporada e as 47 linhas de auditoria entram na MESMA
  // transação. Estourar o prazo no meio precisa deixar o banco exatamente como
  // estava — meia carga é o pior desfecho, porque o operador vê campeonatos na
  // tela e conclui que deu certo.
  //
  // O prazo é apertado para 1ms via ambiente: é a forma de provocar o estouro
  // sem depender de latência real nem de sorte de cronômetro.
  it('estourar o prazo da transação não deixa NADA gravado', async () => {
    // A linha de base não é zero: criar o administrador e a federação no
    // beforeEach já registra auditoria. O que se mede é o DELTA da carga.
    const auditoriaAntes = await comoAtor(admin, () => prisma.auditLog.count());

    const r = spawnSync(
      process.execPath,
      [path.join(RAIZ, 'scripts', 'importar-campeonatos.js')],
      { cwd: RAIZ, env: { ...process.env, PRAZO_CARGA_MS: '1' }, encoding: 'utf8', timeout: 180000 }
    );

    expect(r.status, 'a carga deveria ter falhado com o prazo de 1ms').not.toBe(0);

    expect(await prisma.event.count(), 'sobrou etapa de uma carga que falhou').toBe(0);
    expect(await prisma.rankingSeason.count(), 'sobrou temporada de uma carga que falhou').toBe(0);
    expect(await comoAtor(admin, () => prisma.auditLog.count()), 'sobrou auditoria de uma carga que falhou').toBe(auditoriaAntes);
  });

  it('com prazo normal a mesma carga entra inteira', async () => {
    const r = importar();
    expect(r.status, r.stderr).toBe(0);
    expect(await prisma.event.count()).toBe(TOTAL);
    expect(await prisma.rankingSeason.count()).toBe(1);
  });
});

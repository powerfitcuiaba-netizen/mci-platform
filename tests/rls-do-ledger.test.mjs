import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O LEDGER PASSOU A TER DONO DECLARADO — E ESTE ARQUIVO COBRA ISSO.
//
// POR QUE ELE PRECISOU EXISTIR
//
// `ExternalResult`, `RankingPoint` e `Ranking` NUNCA tiveram política de RLS.
// Elas estavam protegidas assim mesmo, mas por DEDUÇÃO: `athleteId` era NOT
// NULL, toda linha pertencia a um atleta, todo atleta pertence a uma
// organização. O isolamento era consequência de uma coluna obrigatória, e não
// de uma regra escrita.
//
// Esta fase desfez exatamente essa dedução: o resultado histórico existe antes
// do cadastro, e `athleteId` virou nulável. Sem uma coluna `organizationId`
// própria e sem política, uma linha com `athleteId` nulo não teria caminho
// nenhum até um tenant — ficaria visível para qualquer conexão.
//
// Então a proteção deixou de ser deduzida e passou a ser declarada. O que este
// arquivo mede é a proteção NOVA, nas cinco tabelas, contra três olhares que
// não podem ver nada: o anônimo, o atleta comum e o operador da federação
// vizinha.
//
// E mede também o outro lado, que é onde este tipo de mudança costuma quebrar
// sem avisar: a superfície PÚBLICA do ranking continua respondendo.
// ============================================================================

const TABELAS_DO_LEDGER = ['ExternalAthlete', 'ExternalResult', 'RankingPoint'];
const TABELAS_PUBLICADAS = ['Ranking', 'PublicRankingEntry'];

let admin;
let orgA;
let orgB;
let gerenteA;
let gerenteB;
let atletaComum;
let seasonA;
let filiacaoA;

const csv = linhas => [
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento',
  ...linhas
].join('\n');

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  orgB = await criarOrganizacao(admin, { name: 'Federação B' });

  gerenteA = await criarUsuario({ name: 'Gerente A' });
  await vincular(orgA.id, gerenteA, 'RANKING_MANAGER');
  gerenteB = await criarUsuario({ name: 'Gerente B' });
  await vincular(orgB.id, gerenteB, 'RANKING_MANAGER');

  // Atleta sem vínculo de operação em organização nenhuma.
  atletaComum = await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });

  filiacaoA = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: orgA.id, name: 'Federação Mato-grossense', code: 'FED-MT' })).body;

  seasonA = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: orgA.id, name: 'Temporada A 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonA}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }] });

  // Histórico da federação A, sem atleta cadastrado nenhum: é justamente a
  // linha que a dedução antiga não conseguiria proteger.
  const lote = await api().post('/api/v1/musclewar/imports').set(gerenteA.auth()).send({
    organizationId: orgA.id, seasonId: seasonA, sourceType: 'CSV',
    sourceRef: unico('rls') + '.csv',
    content: csv([
      'RLS-1,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa A',
      'RLS-2,JOANA SOUZA,FED-MT,NPC-1002,BIKINI,OPEN,2,Etapa A'
    ])
  });
  await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerenteA.auth());
});

describe('as cinco tabelas têm RLS ligado, forçado e com política', () => {
  it('RLS e FORCE estão ativos — sem FORCE, o dono do schema passa por cima', async () => {
    const estado = await prisma.$queryRaw`
      SELECT c.relname::text AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS forcado
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('ExternalAthlete','ExternalResult','RankingPoint','Ranking','PublicRankingEntry')
      ORDER BY c.relname`;

    expect(estado).toHaveLength(5);
    for (const linha of estado) {
      expect(linha.rls, `${linha.tabela} sem RLS`).toBe(true);
      // FORCE é o que impede o DONO das tabelas de ficar isento. Sem ele a
      // aplicação subiria e serviria dado alheio em silêncio — é o modo de
      // falha que `src/config/rlsGuard.js` existe para recusar.
      expect(linha.forcado, `${linha.tabela} sem FORCE`).toBe(true);
    }
  });

  it('cada comando tem política própria — não basta SELECT protegido', async () => {
    const politicas = await prisma.$queryRaw`
      SELECT tablename::text AS tabela, cmd::text AS comando
      FROM pg_policies
      WHERE tablename IN ('ExternalAthlete','ExternalResult','RankingPoint','Ranking','PublicRankingEntry')`;

    for (const tabela of [...TABELAS_DO_LEDGER, ...TABELAS_PUBLICADAS]) {
      const comandos = politicas.filter(p => p.tabela === tabela).map(p => p.comando).sort();
      expect(comandos, `${tabela} precisa de política para os quatro comandos`)
        .toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });
});

describe('quem não é operador da organização não alcança o ledger', () => {
  it('o operador da federação vizinha não LÊ nada', async () => {
    const visto = await comoAtor(gerenteB, async tx => ({
      identidades: await tx.externalAthlete.count(),
      externos: await tx.externalResult.count(),
      pontos: await tx.rankingPoint.count()
    }));

    // Não é "não veio no filtro do serviço": a linha não existe para esta
    // conexão, no banco.
    expect(visto).toEqual({ identidades: 0, externos: 0, pontos: 0 });
  });

  it('o atleta comum não LÊ nada', async () => {
    const visto = await comoAtor(atletaComum, async tx => ({
      identidades: await tx.externalAthlete.count(),
      externos: await tx.externalResult.count(),
      pontos: await tx.rankingPoint.count()
    }));
    expect(visto).toEqual({ identidades: 0, externos: 0, pontos: 0 });
  });

  it('o ANÔNIMO não LÊ nada — e é o caso que mais importa', async () => {
    // `prisma` sem contexto é a conexão sem `mci.user_id`: o visitante. Antes
    // desta fase ele lia o ledger inteiro, porque não havia política nenhuma.
    const visto = {
      identidades: await prisma.externalAthlete.count(),
      externos: await prisma.externalResult.count(),
      pontos: await prisma.rankingPoint.count()
    };
    expect(visto).toEqual({ identidades: 0, externos: 0, pontos: 0 });
  });

  it('o DONO lê o próprio histórico, e só o dele', async () => {
    // A leitura mais legítima que existe: a pessoa consultando o que ela mesma
    // competiu. A primeira versão da política a barrava — o atleta não é
    // operador —, e `GET /me/history` devolvia vazio.
    // Pelo ADMIN: `RANKING_MANAGER` gere ranking, não cadastro de atleta — e
    // essa separação de papéis é justamente uma das coisas que o produto
    // protege.
    const dona = await criarAtleta(admin, orgA.id, {
      fullName: 'MARIA DA SILVA', cpf: gerarCpf(515151515),
      affiliationId: filiacaoA.id, affiliationNumber: 'NPC-1001'
    });
    const usuarioDela = await criarUsuario({ role: 'ATHLETE', name: 'Maria' });
    await comoAtor(admin, tx => tx.athlete.update({
      where: { id: dona.id }, data: { userId: usuarioDela.id }
    }));

    // O cadastro aparece DEPOIS do histórico: é o fluxo desta fase inteira.
    const muscleWar = await import('../src/services/muscleWarService.js');
    await comoAtor(gerenteA, () => muscleWar.vincularPendentesDoAtleta(
      { ...dona, organizationId: orgA.id, affiliationId: filiacaoA.id, affiliationNumber: 'NPC-1001' },
      { id: gerenteA.id }
    ));

    const seus = await comoAtor(usuarioDela, tx => tx.rankingPoint.findMany());
    expect(seus, 'o dono precisa enxergar o próprio lançamento').toHaveLength(1);
    expect(seus[0].athleteId).toBe(dona.id);
  });

  it('SEM DONO NÃO É DE TODO MUNDO — athleteId nulo não vaza', async () => {
    // O RISCO DESTA POLÍTICA, escrito como teste.
    //
    // `athleteId` pode ser NULO: o resultado histórico carregado antes do
    // cadastro não tem dono. Uma comparação descuidada com nulo tornaria essas
    // linhas visíveis a QUALQUER pessoa autenticada — o oposto exato do que
    // esta fase construiu. `mci_atleta_do_usuario` recusa nulo antes de
    // qualquer outra coisa, e é isto que confere.
    const semVinculo = await criarUsuario({ role: 'ATHLETE', name: 'Curiosa' });

    const semDono = await comoAtor(gerenteA, tx => tx.rankingPoint.count({ where: { athleteId: null } }));
    expect(semDono, 'o cenário precisa ter lançamento sem dono').toBe(2);

    // Autenticada, sem ser dona de nada e sem ser operadora: não vê NADA.
    const vistoPorEla = await comoAtor(semVinculo, async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count()
    }));
    expect(vistoPorEla).toEqual({ pontos: 0, externos: 0 });
  });

  it('o operador da própria organização LÊ — senão a proteção seria só quebra', async () => {
    const visto = await comoAtor(gerenteA, async tx => ({
      identidades: await tx.externalAthlete.count(),
      externos: await tx.externalResult.count(),
      pontos: await tx.rankingPoint.count()
    }));
    expect(visto).toEqual({ identidades: 2, externos: 2, pontos: 2 });
  });
});

describe('IDOR: saber o id não dá acesso a ele', () => {
  it('o vizinho não alcança as linhas da federação A NEM POR ID', async () => {
    // Os ids são colhidos por quem PODE, e depois usados por quem não pode —
    // que é exatamente a forma do ataque: o identificador vaza por um log, um
    // print, uma URL, e a pergunta é se ele sozinho abre a porta.
    const alvos = await comoAtor(gerenteA, async tx => ({
      identidade: (await tx.externalAthlete.findFirst()).id,
      externo: (await tx.externalResult.findFirst()).id,
      ponto: (await tx.rankingPoint.findFirst()).id,
      ranking: (await tx.ranking.findFirst()).id,
      projecao: (await tx.publicRankingEntry.findFirst()).id
    }));

    await comoAtor(gerenteB, async tx => {
      expect(await tx.externalAthlete.findUnique({ where: { id: alvos.identidade } })).toBeNull();
      expect(await tx.externalResult.findUnique({ where: { id: alvos.externo } })).toBeNull();
      expect(await tx.rankingPoint.findUnique({ where: { id: alvos.ponto } })).toBeNull();
    });
  });

  it('o vizinho não ESCREVE nas linhas da federação A', async () => {
    const alvos = await comoAtor(gerenteA, async tx => ({
      identidade: (await tx.externalAthlete.findFirst()).id,
      ponto: (await tx.rankingPoint.findFirst()).id
    }));

    await comoAtor(gerenteB, async tx => {
      // `updateMany` conta zero: a linha não está no alcance da política, e
      // por isso não há o que atualizar. Silencioso e correto — o contrário
      // seria alterar dado alheio e devolver sucesso.
      const sequestro = await tx.externalAthlete.updateMany({
        where: { id: alvos.identidade }, data: { displayName: 'SEQUESTRADA' }
      });
      expect(sequestro.count).toBe(0);

      const adulteracao = await tx.rankingPoint.updateMany({
        where: { id: alvos.ponto }, data: { points: 999 }
      });
      expect(adulteracao.count).toBe(0);

      const remocao = await tx.rankingPoint.deleteMany({ where: { id: alvos.ponto } });
      expect(remocao.count).toBe(0);
    });

    // E o dado continua intacto do lado de quem é dono dele.
    const depois = await comoAtor(gerenteA, tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));
    expect(depois.map(p => p.points)).toEqual([5, 4]);
    expect(await comoAtor(gerenteA, tx => tx.externalAthlete.count({ where: { displayName: 'SEQUESTRADA' } }))).toBe(0);
  });

  it('o vizinho não INSERE linha na organização alheia', async () => {
    const seasonDoVizinho = seasonA;
    await comoAtor(gerenteB, async tx => {
      // A política de INSERT exige ser operador da organização da LINHA. Um
      // `organizationId` escrito à mão no payload não muda quem o autor é.
      await expect(tx.externalAthlete.create({
        data: {
          organizationId: orgA.id, source: 'MUSCLEWAR',
          identityKey: `AFF:${filiacaoA.id}:INTRUSA`, displayName: 'INTRUSA'
        }
      })).rejects.toThrow();

      await expect(tx.rankingPoint.create({
        data: {
          seasonId: seasonDoVizinho, organizationId: orgA.id, source: 'MUSCLEWAR',
          points: 999, placementPoints: 999
        }
      })).rejects.toThrow();
    });
  });
});

describe('a superfície pública continua de pé', () => {
  it('o anônimo LÊ o ranking publicado — sem tocar no ledger', async () => {
    const ranking = await api().get('/api/v1/ranking').query({ seasonId: seasonA });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items.length).toBeGreaterThan(0);
    expect(ranking.body.items[0].totalPoints).toBe(5);

    // E continua sem enxergar UMA linha sequer do ledger.
    expect(await prisma.rankingPoint.count()).toBe(0);
    expect(await prisma.externalResult.count()).toBe(0);
  });

  it('Super Overall, recortes, equipes e empresas respondem para o anônimo', async () => {
    for (const rota of ['/api/v1/ranking/super-overall', '/api/v1/ranking/teams', '/api/v1/ranking/companies']) {
      const resposta = await api().get(rota).query({ seasonId: seasonA });
      expect(resposta.status, `${rota} devolveu ${resposta.status}`).toBe(200);
    }

    const recorte = await api().get('/api/v1/ranking/by').query({ seasonId: seasonA, categoryId: undefined });
    expect([200, 400]).toContain(recorte.status);
  });

  it('a projeção pública NÃO carrega a trilha administrativa', async () => {
    // O que a projeção NÃO tem é tão importante quanto o que ela tem: quem
    // atribuiu, quem invalidou, por quê, e a partir de qual resultado. Isso é
    // auditoria, não ranking, e não sai da tabela privada.
    const colunas = (await prisma.$queryRaw`
      SELECT column_name::text AS nome FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'PublicRankingEntry'`).map(l => l.nome);

    for (const proibida of ['awardedById', 'voidedById', 'voidReason', 'resultId',
      'externalResultId', 'affiliationId', 'affiliationNumber', 'placingOriginal', 'resultVersion']) {
      expect(colunas, `${proibida} não pode estar na projeção pública`).not.toContain(proibida);
    }
  });
});

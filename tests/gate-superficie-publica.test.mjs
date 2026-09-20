import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// GATE DA SUPERFÍCIE PÚBLICA — O QUE O VISITANTE ALCANÇA, MEDIDO.
//
// POR QUE ESTE ARQUIVO EXISTE
//
// A fase do histórico anterior ao cadastro fechou o ledger com RLS de operador
// e criou uma PROJEÇÃO pública para as rotas anônimas. Isso trocou uma
// pergunta por outra: antes era "o ledger está exposto?"; agora é "a projeção
// leva junto alguma coisa que não devia?".
//
// A política de leitura de `Ranking` e `PublicRankingEntry` é:
//
//   mci_operator_of("organizationId") OR mci_ranking_publicado("seasonId")
//
// e `mci_ranking_publicado` é "a temporada existe E a organização está ativa".
// ELA NÃO CONSULTA ESTADO DE PUBLICAÇÃO — e não poderia: o produto não tem
// esse estado. `SeasonStatus` é OPEN ou CLOSED, e as duas são situações
// legítimas de uma temporada real, não rascunho.
//
// Então o que este arquivo mede é o que de fato existe para medir:
//
//   · o ledger continua fechado para quem não é operador;
//   · a projeção carrega SÓ o que o ranking público precisa;
//   · o que sai pela API não traz campo administrativo nenhum;
//   · uma federação não alcança dado de outra, nem com id em mãos;
//   · organização DESATIVADA some da superfície pública — que é o único
//     controle de publicação que a política de fato exerce;
//   · temporada encerrada continua pública, porque ranking de campeonato
//     encerrado é o dado mais público que existe.
//
// O QUE ELE NÃO MEDE, E POR QUÊ: "temporada não publicada". Esse estado não
// existe no produto. Inventar um fixture para ele seria medir uma regra que
// ninguém escreveu.
// ============================================================================

const CAMPOS_PROIBIDOS_NA_PROJECAO = [
  'awardedById', 'voidedById', 'voidReason', 'resultId', 'externalResultId',
  'affiliationId', 'affiliationNumber', 'placingOriginal', 'resultVersion',
  'cpf', 'phone', 'email', 'birthDate', 'passwordHash'
];

let admin;
let orgA;
let orgB;
let gerenteA;
let gerenteB;
let curiosa;
let seasonA;
let seasonB;
let filiacaoA;

const csv = linhas => [
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento',
  ...linhas
].join('\n');

async function montarFederacao(admin, nome, codigo, prefixo) {
  const org = await criarOrganizacao(admin, { name: nome });
  const gerente = await criarUsuario({ name: `Gerente ${nome}` });
  await vincular(org.id, gerente, 'RANKING_MANAGER');

  const filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org.id, name: nome, code: codigo })).body;

  const season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: `Temporada ${nome}`, year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }] });

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId: org.id, seasonId: season, sourceType: 'CSV',
    sourceRef: unico(prefixo) + '.csv',
    content: csv([
      `${prefixo}-1,ATLETA PRIMEIRA ${prefixo},${codigo},${prefixo}-1001,BIKINI,OPEN,1,Etapa ${prefixo}`,
      `${prefixo}-2,ATLETA SEGUNDA ${prefixo},${codigo},${prefixo}-1002,BIKINI,OPEN,2,Etapa ${prefixo}`
    ])
  });
  await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

  return { org, gerente, filiacao, season };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

  const a = await montarFederacao(admin, 'Federacao A', 'FED-A', 'AA');
  orgA = a.org; gerenteA = a.gerente; filiacaoA = a.filiacao; seasonA = a.season;

  const b = await montarFederacao(admin, 'Federacao B', 'FED-B', 'BB');
  orgB = b.org; gerenteB = b.gerente; seasonB = b.season;

  // Autenticada, sem papel de operação em organização nenhuma.
  curiosa = await criarUsuario({ role: 'ATHLETE', name: 'Curiosa' });
});

// ------------------------------------------------------------------ §4 e §2
describe('§4 enumeração direta: o que cada olhar alcança no banco', () => {
  it('o ANÔNIMO não lê NENHUMA das três tabelas do ledger', async () => {
    const visto = {
      rankingPoint: await prisma.rankingPoint.count(),
      externalResult: await prisma.externalResult.count(),
      externalAthlete: await prisma.externalAthlete.count()
    };
    expect(visto).toEqual({ rankingPoint: 0, externalResult: 0, externalAthlete: 0 });
  });

  it('a AUTENTICADA sem papel também não lê o ledger', async () => {
    const visto = await comoAtor(curiosa, async tx => ({
      rankingPoint: await tx.rankingPoint.count(),
      externalResult: await tx.externalResult.count(),
      externalAthlete: await tx.externalAthlete.count()
    }));
    expect(visto).toEqual({ rankingPoint: 0, externalResult: 0, externalAthlete: 0 });
  });

  it('Ranking e a projeção SÃO legíveis — e este é o preço declarado', async () => {
    // Não é achado escondido: é a política, escrita e conferida. As duas
    // tabelas existem PARA SEREM PUBLICADAS. O que as protege não é o acesso
    // à linha — é não haver, nelas, nada que não possa sair.
    const ranking = await prisma.ranking.count();
    const projecao = await prisma.publicRankingEntry.count();
    expect(ranking).toBeGreaterThan(0);
    expect(projecao).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------- §3
describe('§3 a projeção carrega só o que o ranking precisa', () => {
  it('nenhuma coluna administrativa existe na tabela', async () => {
    const colunas = (await prisma.$queryRaw`
      SELECT column_name::text AS nome FROM information_schema.columns
      WHERE table_schema='public' AND table_name='PublicRankingEntry'`).map(l => l.nome);

    for (const proibida of CAMPOS_PROIBIDOS_NA_PROJECAO) {
      expect(colunas, `${proibida} não pode existir na projeção`).not.toContain(proibida);
    }
  });

  it('cada coluna que existe tem função no ranking público', async () => {
    // A lista é FECHADA de propósito: coluna nova na projeção passa a exigir
    // decisão consciente, em vez de entrar de carona num `select` qualquer.
    const colunas = (await prisma.$queryRaw`
      SELECT column_name::text AS nome FROM information_schema.columns
      WHERE table_schema='public' AND table_name='PublicRankingEntry'`).map(l => l.nome).sort();

    expect(colunas).toEqual([
      'athleteId',          // o dono, quando há — liga a linha ao perfil público
      'categoryId',         // recorte
      'classId',            // recorte
      'companyId',          // ranking de empresas
      'competitorKey',      // agregação
      'didNotShow',         // participação de zero ponto
      'displayName',        // nome conforme a fonte, para quem não tem cadastro
      'eventId',            // recorte
      'externalAthleteId',  // a identidade externa
      'id',
      'isOverallChampion',  // contador de desempate
      'organizationId',     // é o que a política confere
      'placing',            // contador de desempate
      'points',             // ranking do campeonato
      'seasonId',
      'sourceKey',          // participações distintas
      'superOverallEligible',
      'superOverallPoints', // ranking anual
      'teamId',             // ranking de equipes
      'updatedAt',
      'voided'              // lançamento invalidado conta participação, não ponto
    ].sort());
  });
});

// ---------------------------------------------------------------------- §7
describe('§7 as rotas públicas: o que sai no corpo da resposta', () => {
  const ROTAS_PUBLICAS = [
    '/api/v1/ranking',
    '/api/v1/ranking/super-overall',
    '/api/v1/ranking/teams',
    '/api/v1/ranking/companies'
  ];

  it('todas respondem 200 ao anônimo', async () => {
    for (const rota of ROTAS_PUBLICAS) {
      const r = await api().get(rota).query({ seasonId: seasonA });
      expect(r.status, `${rota} devolveu ${r.status}`).toBe(200);
    }
  });

  it('NENHUM campo administrativo sai no corpo de NENHUMA delas', async () => {
    for (const rota of ROTAS_PUBLICAS) {
      const r = await api().get(rota).query({ seasonId: seasonA });
      const corpo = JSON.stringify(r.body);
      for (const proibido of CAMPOS_PROIBIDOS_NA_PROJECAO) {
        expect(corpo, `${rota} vazou "${proibido}"`).not.toContain(`"${proibido}"`);
      }
    }
  });

  it('o CPF não sai por rota pública nenhuma, em forma nenhuma', async () => {
    const cpf = gerarCpf(454545454);
    await criarAtleta(admin, orgA.id, {
      fullName: 'ATLETA PRIMEIRA AA', cpf,
      affiliationId: filiacaoA.id, affiliationNumber: 'AA-1001'
    });

    const cadastrada = await comoAtor(admin, tx => tx.athlete.findFirst({
      where: { affiliationNumber: 'AA-1001' }
    }));
    const muscleWar = await import('../src/services/muscleWarService.js');
    await comoAtor(gerenteA, () => muscleWar.vincularPendentesDoAtleta(
      { ...cadastrada, organizationId: orgA.id, affiliationId: filiacaoA.id, affiliationNumber: 'AA-1001' },
      { id: gerenteA.id }
    ));

    const formatado = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    for (const rota of ROTAS_PUBLICAS) {
      const corpo = JSON.stringify((await api().get(rota).query({ seasonId: seasonA })).body);
      expect(corpo, `${rota} vazou CPF cru`).not.toContain(cpf);
      expect(corpo, `${rota} vazou CPF formatado`).not.toContain(formatado);
    }
  });

  it('temporada inexistente não devolve dado de ninguém', async () => {
    for (const rota of ROTAS_PUBLICAS) {
      const r = await api().get(rota).query({ seasonId: 'nao-existe-esta-temporada' });
      expect([200, 400, 404]).toContain(r.status);
      if (r.status === 200) {
        expect(r.body.items ?? [], `${rota} devolveu linhas para temporada inexistente`).toHaveLength(0);
      }
    }
  });
});

// ---------------------------------------------------------------------- §5
describe('§5 cross-tenant: A não alcança B', () => {
  it('o ranking público de A não traz NENHUMA linha de B', async () => {
    const r = await api().get('/api/v1/ranking').query({ seasonId: seasonA });
    const corpo = JSON.stringify(r.body);
    expect(corpo).toContain('ATLETA PRIMEIRA AA');
    expect(corpo, 'linha da federação B apareceu no ranking de A').not.toContain('BB');
  });

  it('e o ranking de B não traz NENHUMA linha de A — o isolamento vale nos dois sentidos', async () => {
    // A SIMETRIA NÃO É ENFEITE. Sem ela, o teste anterior passaria trivialmente
    // caso a temporada de B não tivesse nada publicado: "o ranking de A não
    // contém B" é verdade de graça quando B está vazia. Medir o outro sentido
    // prova que as duas federações têm dado público de verdade e que mesmo
    // assim nenhuma alcança a outra.
    const r = await api().get('/api/v1/ranking').query({ seasonId: seasonB });
    expect(r.status).toBe(200);
    const corpo = JSON.stringify(r.body);
    expect(corpo, 'a temporada de B precisa ter dado público próprio').toContain('ATLETA PRIMEIRA BB');
    expect(corpo, 'linha da federação A apareceu no ranking de B').not.toContain('AA');
  });

  it('o operador de A não lê o ledger de B, nem com o id na mão', async () => {
    const idsDeB = await comoAtor(gerenteB, async tx => ({
      ponto: (await tx.rankingPoint.findFirst()).id,
      externo: (await tx.externalResult.findFirst()).id,
      identidade: (await tx.externalAthlete.findFirst()).id
    }));

    await comoAtor(gerenteA, async tx => {
      expect(await tx.rankingPoint.findUnique({ where: { id: idsDeB.ponto } })).toBeNull();
      expect(await tx.externalResult.findUnique({ where: { id: idsDeB.externo } })).toBeNull();
      expect(await tx.externalAthlete.findUnique({ where: { id: idsDeB.identidade } })).toBeNull();
    });
  });

  it('organizationId escrito na query NÃO atravessa tenant', async () => {
    // A organização dona da TEMPORADA é quem manda; o parâmetro é do cliente,
    // e cliente não decide de quem é o dado.
    const r = await api().get('/api/v1/ranking')
      .query({ seasonId: seasonA, organizationId: orgB.id });
    expect(r.status).toBe(200);
    const corpo = JSON.stringify(r.body);
    expect(corpo, 'trocar organizationId trouxe dado da outra federação').not.toContain('BB');
  });

  it('o operador de A não ESCREVE na projeção pública de B', async () => {
    // ESCOPADO À ORGANIZAÇÃO DE B, e não `findFirst()` solto. B ENXERGA as
    // linhas de A — a leitura da projeção é pública —, então a consulta sem
    // escopo pegava uma linha de A, e a escrita legítima de A sobre a própria
    // linha era acusada como invasão. Falso positivo do arreio, não do
    // produto; o teste só vale se o alvo for comprovadamente de B.
    const alvo = await comoAtor(gerenteB, tx => tx.publicRankingEntry.findFirst({
      where: { organizationId: orgB.id }
    }));
    expect(alvo, 'o alvo precisa ser uma linha da federação B').toBeTruthy();
    expect(alvo.organizationId).toBe(orgB.id);

    await comoAtor(gerenteA, async tx => {
      const adulterado = await tx.publicRankingEntry.updateMany({
        where: { id: alvo.id }, data: { points: 999 }
      });
      expect(adulterado.count).toBe(0);
      expect(await tx.publicRankingEntry.deleteMany({ where: { id: alvo.id } })).toEqual({ count: 0 });
    });

    const depois = await comoAtor(gerenteB, tx => tx.publicRankingEntry.findUnique({ where: { id: alvo.id } }));
    expect(depois.points).toBe(alvo.points);
  });
});

// ---------------------------------------------------------------------- §6
describe('§6 estado da temporada e da organização', () => {
  it('temporada ENCERRADA continua pública — e isso é a regra, não descuido', async () => {
    // Ranking de campeonato encerrado é o dado mais público que existe: é o
    // resultado oficial. Esconder ao fechar seria apagar a história.
    await comoAtor(admin, tx => tx.rankingSeason.update({
      where: { id: seasonA }, data: { status: 'CLOSED' }
    }));

    const r = await api().get('/api/v1/ranking').query({ seasonId: seasonA });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  });

  it('organização DESATIVADA some da superfície pública', async () => {
    // É o único controle de publicação que a política de fato exerce, e ele
    // existe: `mci_ranking_publicado` exige `Organization.active`.
    const antes = await api().get('/api/v1/ranking').query({ seasonId: seasonA });
    expect(antes.body.items.length).toBeGreaterThan(0);

    await comoAtor(admin, tx => tx.organization.update({
      where: { id: orgA.id }, data: { active: false }
    }));

    const depois = await api().get('/api/v1/ranking').query({ seasonId: seasonA });
    expect(depois.status).toBe(200);
    expect(depois.body.items, 'federação desativada não publica ranking').toHaveLength(0);
  });

  it('o OPERADOR continua enxergando o ranking da própria federação desativada', async () => {
    // Desativar tira do público, não apaga para quem administra.
    await comoAtor(admin, tx => tx.organization.update({
      where: { id: orgA.id }, data: { active: false }
    }));

    const visto = await comoAtor(gerenteA, tx => tx.ranking.count({ where: { seasonId: seasonA } }));
    expect(visto).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------- §9
describe('§9 a superfície pública não depende de privilégio', () => {
  // A PRIMEIRA VERSÃO DESTE TESTE PROCURAVA NOMES, E A CI A REPROVOU.
  //
  // Ela pedia `rolname IN ('mci_app', 'mci_owner', 'mci')` e exigia lista
  // vazia. Passava aqui e falhava na CI — porque 'mci' é o papel comum da
  // aplicação NESTE ambiente e é o SUPERUSUÁRIO DE BOOTSTRAP do contêiner
  // `postgres:16` na CI (`POSTGRES_USER: mci`), e superusuário carrega
  // `rolbypassrls`. A asserção acusava o arreio da CI e chamava de defeito do
  // produto.
  //
  // O erro não foi a lista estar incompleta: foi perguntar por NOME. Nome não
  // identifica papel — dois ambientes dão o mesmo nome a coisas diferentes, e
  // é exatamente o que aconteceu. A pergunta certa é sobre a CONEXÃO: o papel
  // por onde a aplicação está falando agora contorna RLS?
  //
  // Existe UM papel com BYPASSRLS neste sistema, de propósito: `mci_backup`.
  // Sob FORCE ROW LEVEL SECURITY nem o dono do schema consegue rodar
  // `pg_dump`, então o papel de backup precisa do atributo. Ele é
  // somente-leitura e não pertence ao caminho da aplicação — e é por isso que
  // uma varredura global de `pg_roles` seria a medição errada: ela reprovaria
  // um provisionamento correto.
  it('o papel por onde a aplicação fala NÃO contorna RLS', async () => {
    const [conexao] = await prisma.$queryRaw`
      SELECT current_user::text                     AS papel,
             current_setting('is_superuser') = 'on' AS superusuario,
             EXISTS (
               SELECT 1 FROM pg_roles r
               WHERE r.rolbypassrls
                 AND pg_has_role(current_user, r.oid, 'MEMBER')
             )                                      AS "contornaRls"`;

    expect(conexao.superusuario,
      `a conexão fala pelo papel '${conexao.papel}', que é SUPERUSUÁRIO`).toBe(false);

    // 'MEMBER' e não 'USAGE': BYPASSRLS é ATRIBUTO, e atributo não se herda
    // por pertencimento — mas pertencer dá direito a `SET ROLE`, que alcança
    // o privilégio sem trocar de conexão. É esse alcance que precisa ser zero.
    expect(conexao.contornaRls,
      `a conexão fala pelo papel '${conexao.papel}', que alcança BYPASSRLS`).toBe(false);
  });

  it('a barreira de partida RECUSA uma conexão com BYPASSRLS', async () => {
    // Este ambiente não tem CREATEROLE, então não dá para criar um papel com
    // BYPASSRLS e medir o desvio de verdade. O que SE MEDE aqui é a decisão da
    // barreira diante desse estado — que é o que separa "a aplicação sobe e
    // serve tudo em silêncio" de "a aplicação não sobe".
    //
    // O cliente falso devolve exatamente as duas consultas que `inspecionar`
    // faz, na ordem em que as faz.
    const { inspecionar, assertRlsEfetivo } = await import('../src/config/rlsGuard.js');

    let chamada = 0;
    const comBypass = {
      $queryRaw: async () => (chamada += 1) === 1
        ? [{ superusuario: false, contornaRls: true, papel: 'papel_com_bypass' }]
        : []
    };

    const estado = await inspecionar(comBypass);
    expect(estado.ok, 'BYPASSRLS tem de reprovar a barreira').toBe(false);
    expect(estado.problemas.join(' ')).toContain('BYPASSRLS');
    expect(estado.problemas.join(' ')).toContain('papel_com_bypass');

    chamada = 0;
    await expect(assertRlsEfetivo(comBypass)).rejects.toThrow(/BYPASSRLS/);

    // E o caso limpo continua passando — uma barreira que reprova sempre não
    // protege nada, só impede de trabalhar.
    let limpa = 0;
    const semBypass = {
      $queryRaw: async () => (limpa += 1) === 1
        ? [{ superusuario: false, contornaRls: false, papel: 'papel_comum' }]
        : []
    };
    expect((await inspecionar(semBypass)).ok).toBe(true);
  });

  it('nenhuma função SECURITY DEFINER foi criada para contornar política', async () => {
    const definers = await prisma.$queryRaw`
      SELECT p.proname::text AS nome FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND p.proname LIKE 'mci\\_%'`;
    expect(definers, 'SECURITY DEFINER como atalho para o RLS').toEqual([]);
  });

  it('NENHUMA das cinco tabelas desta fase usa cláusula incondicional', async () => {
    const abertas = await prisma.$queryRaw`
      SELECT tablename::text AS tabela, policyname::text AS politica
      FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('ExternalAthlete','ExternalResult','RankingPoint','Ranking','PublicRankingEntry')
        AND (qual = 'true' OR with_check = 'true')`;
    expect(abertas, 'política aberta a todo mundo nas tabelas desta fase').toEqual([]);
  });

  it('as cláusulas incondicionais que EXISTEM são as de sempre, e não crescem', async () => {
    // ACHADO REGISTRADO, NÃO ESCONDIDO.
    //
    // Nove políticas do resto da plataforma têm cláusula incondicional. Elas
    // são ANTERIORES a esta fase e não foram auditadas aqui — auditar o
    // catálogo de classes ou a trilha de auditoria é outro trabalho, com
    // outras perguntas.
    //
    // O que esta asserção faz é impedir que a lista CRESÇA em silêncio: uma
    // décima política incondicional passa a exigir decisão consciente, em vez
    // de entrar junto com outra mudança qualquer.
    //
    // As quatro de `qual=true` são tabelas de referência lidas pela
    // superfície pública (catálogo de classes, empresas, vínculos de equipe,
    // títulos Overall). As cinco de `check=true` restringem a LEITURA por
    // `USING` e deixam a escrita para o serviço decidir.
    const abertas = await prisma.$queryRaw`
      SELECT tablename::text AS tabela, policyname::text AS politica
      FROM pg_policies
      WHERE schemaname='public' AND (qual = 'true' OR with_check = 'true')
      ORDER BY tablename, policyname`;

    expect(abertas.map(l => `${l.tabela}.${l.politica}`)).toEqual([
      'AthleteTeamMembership.vinculo_leitura',
      'AuditLog.auditoria_restrita',
      'ClassCatalog.catalogo_leitura',
      'Comment.comentario_alteracao',
      'Company.empresa_leitura',
      'Conversation.conversa_atualizacao',
      'ConversationMember.membro_participante',
      'EventOverallTitle.overall_leitura',
      'Notification.notificacao_do_dono'
    ]);
  });

  it('as cinco tabelas da fase mantêm FORCE', async () => {
    const semForce = await prisma.$queryRaw`
      SELECT c.relname::text AS tabela FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relrowsecurity AND NOT c.relforcerowsecurity`;
    expect(semForce).toEqual([]);
  });
});

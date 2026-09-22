import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, comoAtor
} from './helpers.mjs';
import { withUserContext, currentContext } from '../src/config/rlsSession.js';
import { contextoAtual } from '../src/config/rlsContext.js';
import { inspecionar, assertRlsEfetivo } from '../src/config/rlsGuard.js';

// ============================================================================
// RLS no CAMINHO REAL da aplicação.
//
// O arquivo tests/rls.test.mjs prova que as POLÍTICAS funcionam: conecta como
// `mci_app` e consulta o banco direto. Este arquivo prova a outra metade, que
// é onde estava o furo — que a proteção vale para a requisição de verdade:
//
//   HTTP → autenticação → asyncHandler → contexto → Prisma → PostgreSQL
//
// Aqui o helper real é IMPORTADO, não reimplementado. Se `withUserContext`
// regredir, estes testes caem — que é exatamente o que não acontecia antes,
// quando o helper existia sem uma única chamada no repositório.
// ============================================================================

let admin;
let diretorA;
let orgA;
let diretorB;
let orgB;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

  diretorA = await criarUsuario({ name: 'Diretor A' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

  diretorB = await criarUsuario({ name: 'Diretor B' });
  orgB = await criarOrganizacao(admin, { name: 'Federação B' });
  await vincular(orgB.id, diretorB, 'EVENT_DIRECTOR');
});

describe('FORCE ROW LEVEL SECURITY — o dono da tabela também é filtrado', () => {
  it('as 30 tabelas protegidas estão com FORCE ligado', async () => {
    const linhas = await prisma.$queryRaw`
      SELECT c.relname::text AS tabela, c.relforcerowsecurity AS forcado
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity
    `;

    // O número é conferido de propósito: tabela protegida nova precisa ser
    // decisão consciente, e tabela que sai da lista, idem.
    //
    // Passou de 21 para 22 com `AthleteProfileRequest`, a fila de perfil de
    // atleta. Ela guarda CPF entre o pedido e a análise, então nasceu com RLS
    // FORÇADA e política estreita: enxergam a linha apenas o dono do pedido e
    // os operadores da organização.
    //
    // E de 22 para 27 com o LEDGER E SUA PROJEÇÃO: `ExternalAthlete`,
    // `ExternalResult`, `RankingPoint`, `Ranking` e `PublicRankingEntry`.
    //
    // Essas cinco não estavam desprotegidas antes — estavam protegidas por
    // DEDUÇÃO: `athleteId` era NOT NULL, toda linha pertencia a um atleta, e
    // todo atleta a uma organização. O isolamento era consequência de uma
    // coluna obrigatória, não de uma regra escrita.
    //
    // O histórico oficial carregado ANTES do cadastro desfaz essa dedução:
    // `athleteId` passou a ser nulável, e uma linha sem atleta não teria
    // caminho nenhum até um tenant. Por isso as três ganharam
    // `organizationId` próprio e as cinco ganharam política — a proteção
    // deixou de ser deduzida e passou a ser declarada.
    //
    // E de 27 para 28 com `RankingPointAdjustment`, o histórico dos ajustes
    // administrativos de pontuação. Ela diz QUEM alterou a pontuação de quem,
    // quando e por quê — informação de operação, não de torcida —, e nasceu
    // com a mesma política do lançamento que ela ajusta: só operador da
    // organização enxerga, e não há política de DELETE nenhuma, porque ajuste
    // se invalida e não se apaga.
    //
    // E de 28 para 30 com a MENSAGEM DE ABERTURA: `AthleteNotice` e
    // `AthleteNoticeRead`.
    //
    // O recado é interno da federação aos SEUS atletas, e não vitrine: a
    // política de leitura não tem o ramo anônimo que as tabelas públicas têm.
    // Ela precisou de um predicado que o conjunto não tinha —
    // `mci_atleta_da_organizacao` —, porque atleta não é MEMBRO da
    // organização: ele tem CADASTRO nela, que é outra relação, e
    // `mci_member_of` responderia não a todos eles.
    //
    // `AthleteNoticeRead` é a mais estreita das duas: a política de INSERT
    // exige que o usuário da linha seja o da sessão, e não há política de
    // UPDATE nem de DELETE. Numa federação, "eu não fui avisado" é disputa
    // real — fabricar a prova de que alguém foi comunicado, ou apagá-la, não
    // pode ser possível nem para quem opera.
    expect(linhas.length).toBe(30);
    const semForce = linhas.filter(linha => !linha.forcado).map(linha => linha.tabela);
    expect(semForce, 'tabela com RLS mas sem FORCE volta a isentar o dono').toEqual([]);
  });

  it('a conexão da aplicação NÃO é superusuário — senão o FORCE não vale nada', async () => {
    // Superusuário do PostgreSQL ignora RLS incondicionalmente: nem política,
    // nem FORCE, nem contexto valem para ele. Um banco provisionado com o papel
    // da aplicação como superusuário deixa toda esta fase sem efeito, em
    // silêncio e sem erro nenhum.
    //
    // Foi exatamente o que aconteceu: a suíte passava na máquina local, onde o
    // papel é comum, e falhava na CI, onde POSTGRES_USER nasce superusuário.
    const [{ superusuario }] = await prisma.$queryRaw`
      SELECT current_setting('is_superuser') = 'on' AS superusuario
    `;

    expect(
      superusuario,
      'a aplicação está conectada como superusuário: o RLS não protege nada nesta configuração'
    ).toBe(false);
  });

  it('a aplicação conecta como DONO das tabelas — e ainda assim é barrada', async () => {
    // Este é o teste que reproduz o achado da auditoria. Antes do FORCE, a
    // política negava e o dono lia assim mesmo, porque o PostgreSQL isenta o
    // dono por padrão. Se alguém remover o FORCE, este teste cai.
    const [{ usuario }] = await prisma.$queryRaw`SELECT current_user::text AS usuario`;
    const [{ dono }] = await prisma.$queryRaw`
      SELECT pg_get_userbyid(c.relowner)::text AS dono
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'AuditLog'
    `;
    expect(usuario, 'a suíte precisa conectar como dono para o teste ter valor').toBe(dono);

    // Gera trilha de auditoria real, por uma requisição real.
    const cpf = gerarCpf(919191919);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Auditada', cpf });
    await api().post('/api/v1/athletes/lookup').set(diretorA.auth()).send({ organizationId: orgA.id, cpf });

    const comPermissao = await comoAtor(admin, tx => tx.auditLog.count());
    expect(comPermissao, 'a trilha precisa existir para o teste provar algo').toBeGreaterThanOrEqual(1);

    // Mesma conexão, mesmo dono, sem ator: a política nega e o dono obedece.
    const semContexto = await prisma.auditLog.count();
    expect(semContexto, 'o dono voltou a enxergar dado restrito sem contexto').toBe(0);
  });
});

describe('a plataforma se recusa a operar sem RLS efetivo', () => {
  it('inspecionar aprova a configuração corrente e diz sob qual papel', async () => {
    const estado = await inspecionar();

    expect(estado.ok, `RLS sem efeito: ${estado.problemas.join(' | ')}`).toBe(true);
    expect(estado.superusuario).toBe(false);
    expect(estado.tabelasSemForce).toEqual([]);
    expect(estado.papel).toBeTruthy();
  });

  it('assertRlsEfetivo não lança quando a configuração está correta', async () => {
    await expect(assertRlsEfetivo()).resolves.toMatchObject({ ok: true });
  });

  it('detecta tabela com RLS habilitado mas sem FORCE', async () => {
    // A garantia precisa valer tabela a tabela: uma única esquecida devolve ao
    // dono a isenção sobre ela, e é o suficiente para vazar o que ela guarda.
    await prisma.$executeRawUnsafe('ALTER TABLE "Notification" NO FORCE ROW LEVEL SECURITY');

    try {
      const estado = await inspecionar();

      expect(estado.ok).toBe(false);
      expect(estado.tabelasSemForce).toContain('Notification');
      expect(estado.problemas.join(' ')).toMatch(/sem FORCE/);
      await expect(assertRlsEfetivo()).rejects.toThrow(/RLS não tem efeito/);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY');
    }

    // E volta a aprovar assim que a tabela é corrigida.
    expect((await inspecionar()).ok).toBe(true);
  });

  it('a sonda de prontidão reprova quando o RLS perde efeito', async () => {
    expect((await api().get('/ready')).body.checks.rls).toBe(true);

    await prisma.$executeRawUnsafe('ALTER TABLE "Notification" NO FORCE ROW LEVEL SECURITY');

    try {
      const resposta = await api().get('/ready');

      // 503 e não 200: uma instância que deixou de aplicar o RLS não deve
      // receber tráfego, ainda que o banco e o disco estejam de pé.
      expect(resposta.status).toBe(503);
      expect(resposta.body.checks.rls).toBe(false);
      expect(resposta.body.checks.database).toBe(true);
      expect(JSON.stringify(resposta.body.rls)).toMatch(/Notification/);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY');
    }

    expect((await api().get('/ready')).body.checks.rls).toBe(true);
  });
});

describe('withUserContext — o helper real', () => {
  it('define o ator para a transação e o devolve em currentContext', async () => {
    const dentro = await withUserContext(diretorA.id, () => currentContext());
    expect(dentro).toBe(diretorA.id);
  });

  it('atores diferentes enxergam coisas diferentes na mesma suíte', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Da Federação A', cpf: gerarCpf(121212121) });

    const paraA = await withUserContext(diretorA.id, tx => tx.athlete.count());
    const paraB = await withUserContext(diretorB.id, tx => tx.athlete.count());

    expect(paraA).toBe(1);
    expect(paraB, 'diretor da federação B não pode contar atleta da federação A').toBe(0);
  });

  it('sem ator, o contexto é vazio e a política nega — falha fechado', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Restrita', cpf: gerarCpf(131313131) });

    // Ator nulo é diferente de ator ausente: aqui há transação, com a variável
    // definida como string vazia. As políticas tratam ambos como anônimo.
    const semAtor = await withUserContext(null, tx => tx.auditLog.count());
    expect(semAtor).toBe(0);
  });

  it('não deixa contexto residual: depois do bloco, a conexão volta a ser anônima', async () => {
    await withUserContext(admin.id, tx => tx.auditLog.count());

    // SET LOCAL morre no fim da transação. Se alguém trocar para set_config
    // com escopo de sessão, o ator vazaria para a próxima requisição que
    // pegasse a mesma conexão do pool — e este teste cai.
    expect(await currentContext()).toBeNull();
    expect(contextoAtual()).toBeNull();
  });

  it('erro dentro do bloco desfaz a transação inteira', async () => {
    const antes = await comoAtor(diretorA, tx => tx.athlete.count());

    await expect(withUserContext(diretorA.id, async tx => {
      await tx.athlete.create({
        data: {
          organizationId: orgA.id, fullName: 'Não deve sobrar',
          sex: 'FEMALE', birthDate: new Date('1995-01-01'),
          identity: { create: { organizationId: orgA.id, cpf: gerarCpf(141414141) } }
        }
      });
      throw new Error('falha proposital depois da escrita');
    })).rejects.toThrow('falha proposital');

    const depois = await comoAtor(diretorA, tx => tx.athlete.count());
    expect(depois, 'a escrita anterior ao erro precisava ter sido desfeita').toBe(antes);
  });

  it('chamada aninhada com outro ator restaura o ator anterior ao sair', async () => {
    const observado = await withUserContext(diretorA.id, async () => {
      const interno = await withUserContext(diretorB.id, () => currentContext());
      const depoisDoInterno = await currentContext();
      return { interno, depoisDoInterno };
    });

    expect(observado.interno).toBe(diretorB.id);
    expect(observado.depoisDoInterno, 'o ator externo foi sobrescrito pelo aninhado').toBe(diretorA.id);
  });
});

describe('concorrência — o contexto não vaza entre requisições simultâneas', () => {
  it('atores concorrentes mantêm cada um o seu contexto', async () => {
    // O pool entrega conexões diferentes a cada transação. Se o contexto fosse
    // definido fora da transação, ou guardado em variável de módulo, este
    // teste pegaria a troca.
    const umAtor = (usuario, marca) => withUserContext(usuario.id, async () => {
      const antes = await currentContext();
      await new Promise(resolve => setTimeout(resolve, 10 * marca));
      const depois = await currentContext();
      return { antes, depois, esperado: usuario.id };
    });

    const resultados = await Promise.all([
      umAtor(diretorA, 3), umAtor(diretorB, 1), umAtor(admin, 2),
      umAtor(diretorB, 4), umAtor(diretorA, 0)
    ]);

    for (const item of resultados) {
      expect(item.antes).toBe(item.esperado);
      expect(item.depois, 'o contexto mudou no meio da operação').toBe(item.esperado);
    }
  });

  it('requisições HTTP simultâneas de organizações diferentes não se misturam', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Só da A', cpf: gerarCpf(151515152) });
    await criarAtleta(diretorB, orgB.id, { fullName: 'Só da B', cpf: gerarCpf(161616162) });

    const [respostaA, respostaB, respostaA2] = await Promise.all([
      api().get('/api/v1/athletes').set(diretorA.auth()).query({ organizationId: orgA.id }),
      api().get('/api/v1/athletes').set(diretorB.auth()).query({ organizationId: orgB.id }),
      api().get('/api/v1/athletes').set(diretorA.auth()).query({ organizationId: orgA.id })
    ]);

    const nomes = resposta => (resposta.body.items || []).map(item => item.fullName);
    expect(nomes(respostaA)).toEqual(['Só da A']);
    expect(nomes(respostaA2)).toEqual(['Só da A']);
    expect(nomes(respostaB)).toEqual(['Só da B']);
  });
});

describe('a requisição real carrega o contexto até o PostgreSQL', () => {
  it('o asyncHandler estabelece o ator a partir de req.user, não do corpo', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Da Federação A', cpf: gerarCpf(171717172) });

    // Diretor B tenta se passar por diretor A pelo corpo da requisição. O ator
    // vem do token; o corpo é ignorado para efeito de RLS.
    const tentativa = await api().get('/api/v1/athletes').set(diretorB.auth())
      .query({ organizationId: orgA.id })
      .send({ userId: diretorA.id, actorId: diretorA.id });

    expect([403, 404]).toContain(tentativa.status);
  });

  it('visitante anônimo lê a superfície pública e nada além dela', async () => {
    const cpf = gerarCpf(181818182);
    const atleta = await criarAtleta(diretorA, orgA.id, { fullName: 'Pública', cpf });

    const publica = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(publica.status).toBe(200);
    expect(JSON.stringify(publica.body)).not.toContain(cpf);

    // Sem token, a auditoria não existe para o visitante.
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe('auditoria de bypass', () => {
  // UM ARQUIVO PRECISA PODER DIZER "BYPASSRLS", E É O QUE PROCURA POR ELE.
  //
  // `src/config/rlsGuard.js` existe para RECUSAR a partida quando a conexão
  // contorna o RLS. Para isso ele consulta `pg_roles.rolbypassrls` e escreve
  // o diagnóstico com essa palavra. A varredura literal acusava esse arquivo —
  // e estava lendo a barreira como se fosse o buraco.
  //
  // A exceção é a MENOR possível, e vem com uma asserção a mais em troca:
  //
  //   · o termo liberado é UM, `BYPASSRLS`, e só nesse UM arquivo;
  //   · `SET ROLE`, `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL` e
  //     `row_security = off` continuam proibidos em TODO `src/`, o arquivo da
  //     barreira incluído;
  //   · e a barreira passa a ter de provar que não EXECUTA nada: nenhum
  //     `$executeRaw`, nenhuma instrução que não seja SELECT. Ela lê catálogo
  //     e decide; não altera estado.
  const DESLIGAR_RLS = 'DISABLE ROW LEVEL SECURITY|SET ROLE|NO FORCE ROW LEVEL|row_security *= *off';
  const BARREIRA = 'src/config/rlsGuard.js';

  it('nenhum código de aplicação desliga, força papel ou contorna o RLS', async () => {
    const { execSync } = await import('node:child_process');
    const padrao = `${DESLIGAR_RLS}|BYPASSRLS`;

    const encontrado = execSync(
      `grep -rnE '${padrao}' src/ --exclude=${BARREIRA.split('/').pop()} || true`,
      { encoding: 'utf8', cwd: process.cwd() }
    ).trim();

    expect(encontrado, `bypass de RLS encontrado em src/:\n${encontrado}`).toBe('');
  });

  it('a própria barreira não desliga RLS nem troca de papel', async () => {
    const { execSync } = await import('node:child_process');

    const proibido = execSync(
      `grep -nE '${DESLIGAR_RLS}' ${BARREIRA} || true`,
      { encoding: 'utf8', cwd: process.cwd() }
    ).trim();

    expect(proibido, `a barreira contém instrução de bypass:\n${proibido}`).toBe('');
  });

  it('a barreira apenas LÊ: nenhum comando que altere estado', async () => {
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync(BARREIRA, 'utf8');

    // `$executeRaw` é o único caminho do Prisma para SQL que não é consulta.
    // Sem ele, a barreira não tem como alterar nada — e é essa impossibilidade,
    // e não a boa intenção do arquivo, que justifica a exceção acima.
    expect(fonte, 'a barreira não pode executar SQL que altere estado')
      .not.toContain('$executeRaw');

    // E o SQL que ela roda é SELECT. Qualquer verbo de escrita aqui seria uma
    // mudança de natureza do arquivo, e a exceção deixaria de valer.
    for (const verbo of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'GRANT ', 'CREATE ']) {
      expect(fonte.toUpperCase(), `a barreira usa ${verbo.trim()}`).not.toContain(verbo);
    }
  });

  it('o ator do RLS é definido em um único lugar do código', async () => {
    const { execSync } = await import('node:child_process');
    const arquivos = execSync(
      `grep -rl "set_config('mci.user_id'" src/ || true`,
      { encoding: 'utf8', cwd: process.cwd() }
    ).trim().split('\n').filter(Boolean);

    // Um único ponto de definição é o que torna a garantia auditável: para
    // saber em nome de quem o banco trata a requisição, basta ler um arquivo.
    expect(arquivos).toEqual(['src/config/rlsSession.js']);
  });
});

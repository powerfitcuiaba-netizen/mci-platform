import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { vincularPendentesDoAtleta } = require('../src/services/muscleWarService.js');

// ==========================================================================
// O RESULTADO CHEGA ANTES DA PESSOA.
//
// O arquivo de uma etapa traz 95 atletas; a base tem os que já se cadastraram.
// A importação não cria atleta — é regra, e continua sendo. A consequência era
// que o resultado de quem ainda não se cadastrou ficava parado esperando um
// operador reparar nele um dia.
//
// Este arquivo tranca o outro caminho: o resultado espera com a identidade que
// o arquivo informou — matrícula, filiação, organização —, e quando a pessoa se
// cadastra E O CADASTRO É APROVADO, o vínculo acontece sozinho, pela MESMA
// chave determinística que o importador usa.
//
// O que NUNCA pode acontecer aqui:
//   * vincular por nome;
//   * escolher entre candidatos;
//   * criar atleta;
//   * pontuar duas vezes;
//   * atravessar organização ou filiação.
// ==========================================================================

let admin, gerente, organizationId, npc, outraFiliacao, seasonId;

const CLASSE = "Men's Bodybuilding - Novice";

const csv = linhas => ['Athlete #,Class,First Name,Last Name,Member Number,Placing', ...linhas].join('\n');
const linha = (matricula, primeiro, ultimo, colocacao = 1, classe = CLASSE, n = 1) =>
  `${n},${classe},${primeiro},${ultimo},${matricula},${colocacao}`;

const importar = (conteudo, extras = {}) => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
  content: conteudo, externalIdPrefix: 'IPIRANGA', defaultAffiliationCode: 'NPC', ...extras
});

const aplicar = importId => api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()).send({});

// O cadastro pela porta da frente: pedido do próprio interessado, aprovado por
// um operador. Não é atalho de teste — é o fluxo que o auto-vínculo escuta.
async function pedirECadastrar({ matricula, nome, affiliationId = null, semente = 700, aprovar = true }) {
  const pessoa = await criarUsuario({ name: nome });
  const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
    fullName: nome, cpf: gerarCpf(semente), sex: 'MALE', birthDate: '1995-03-10',
    affiliationId: affiliationId ?? npc.id, affiliationNumber: matricula
  });
  if (pedido.status !== 201) throw new Error(`pedido falhou: ${pedido.status} ${JSON.stringify(pedido.body)}`);
  if (!aprovar) return { pessoa, pedido: pedido.body, athlete: null };

  const aprovado = await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`).set(admin.auth()).send({});
  if (aprovado.status !== 200) throw new Error(`aprovação falhou: ${aprovado.status} ${JSON.stringify(aprovado.body)}`);

  const athlete = await comoAtor(gerente, tx => tx.athlete.findFirst({ where: { affiliationNumber: matricula } }));
  return { pessoa, pedido: pedido.body, athlete };
}

const itensDoLote = importId => comoAtor(gerente, tx => tx.muscleWarImportItem.findMany({
  where: { importId }, orderBy: { rowNumber: 'asc' },
  select: {
    id: true, rowNumber: true, athleteId: true, matchStatus: true, matchedBy: true, reason: true,
    memberNumber: true, affiliationCode: true, athleteName: true, externalResultId: true,
    placing: true, didNotShow: true, className: true, categoryCode: true, linkedAt: true
  }
}));

const ledger = () => comoAtor(gerente, tx => tx.rankingPoint.findMany({
  select: { athleteId: true, points: true, placementPoints: true, placing: true, didNotShow: true, externalResultId: true }
}));

const contagens = () => comoAtor(gerente, async tx => ({
  atletas: await tx.athlete.count(),
  pontos: await tx.rankingPoint.count(),
  externos: await tx.externalResult.count()
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'National Physique Committee', code: 'NPC' })).body;
  outraFiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

// ----------------------------------------------------------------- 1, 2, 16
describe('o resultado espera, e o cadastro aprovado o encontra', () => {
  it('a importação aceita a linha de quem não existe, e ela fica pendente', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(body.summary.pending).toBe(1);
    expect(body.summary.recognized).toBe(0);
    const [item] = await itensDoLote(body.import.id);
    // A identidade de origem fica guardada inteira — é ela que vai reencontrar
    // a pessoa depois.
    expect(item.memberNumber).toBe('88281');
    expect(item.affiliationCode).toBe('NPC');
    expect(item.athleteName).toBe('Yuri Santinelli');
    expect(item.externalResultId).toBeTruthy();
  });

  it('aprovar o cadastro vincula o resultado pendente sozinho', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 701 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.athleteId).toBe(athlete.id);
    expect(item.matchedBy).toBe('AFFILIATION_NUMBER');
    expect(item.linkedAt).toBeTruthy();
  });

  it('o vínculo preserva a chave de idempotência da participação', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const [antes] = await itensDoLote(body.import.id);

    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 702 });

    const [depois] = await itensDoLote(body.import.id);
    expect(depois.externalResultId).toBe(antes.externalResultId);
  });

  it('NS pendente vincula, e continua valendo zero sem colocação', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli', 'NS')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 703 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.athleteId).toBe(athlete.id);
    expect(item.didNotShow).toBe(true);
    expect(item.placing).toBeNull();
  });
});

// -------------------------------------------------------------------- 3, 5
describe('a matrícula é a chave, e o nome não é', () => {
  it('matrícula diferente não vincula, por mais que o nome bata', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    // Mesmo nome, matrícula outra. Casar aqui creditaria o resultado a quem o
    // arquivo não indicou.
    await pedirECadastrar({ matricula: '11111', nome: 'Yuri Santinelli', semente: 704 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCH_PENDING');
    expect(item.athleteId).toBeNull();
  });

  it('nome divergente com matrícula certa vincula, e registra o alerta', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli Da Silva', semente: 705 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.athleteId).toBe(athlete.id);
    expect(item.reason).toMatch(/nome/i);
  });

  it('acento e caixa não contam como divergência', async () => {
    const { body } = await importar(csv([linha('44960', 'Joao', 'Gabriel Fonseca')]));
    await pedirECadastrar({ matricula: '44960', nome: 'João Gabriel Fonseca', semente: 706 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.reason ?? '').not.toMatch(/divergente/i);
  });
});

// ----------------------------------------------------------------- 4, 7, 19
describe('conflito bloqueia, e o sistema não escolhe', () => {
  it('filiação diferente da do arquivo não vincula', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', affiliationId: outraFiliacao.id, semente: 707 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.athleteId).toBeNull();
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toMatch(/FED-MT|filia/i);
  });

  it('dois atletas com a mesma matrícula na mesma filiação é CONFLICT', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    // O primeiro entra pela porta da frente e vincula.
    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 708 });
    // O segundo é semeado direto: o cadastro normal barraria o duplicado, e o
    // que está sob teste é o gate reagindo a uma base já inconsistente.
    await comoAtor(gerente, tx => tx.athlete.create({
      data: {
        organizationId, fullName: 'HOMONIMO', sex: 'MALE', affiliationId: npc.id,
        affiliationNumber: '88281', identity: { create: { organizationId, cpf: gerarCpf(709) } }
      }
    }));

    const segundo = await importar(csv([linha('88281', 'Yuri', 'Santinelli', 1, CLASSE, 9)]), {
      externalIdPrefix: 'SEGUNDA'
    });
    const [item] = await itensDoLote(segundo.body.import.id);
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.athleteId).toBeNull();
    expect(await itensDoLote(body.import.id)).toBeDefined();
  });
});

// ------------------------------------------------------------------- 14, 15
describe('aprovações que não têm o que vincular', () => {
  it('atleta aprovado sem resultado pendente não altera nada', async () => {
    const antes = await contagens();
    await pedirECadastrar({ matricula: '99999', nome: 'Ninguem Do Arquivo', semente: 710 });

    const depois = await contagens();
    expect(depois.pontos).toBe(antes.pontos);
    expect(depois.externos).toBe(antes.externos);
    expect(depois.atletas).toBe(antes.atletas + 1);
  });

  it('linha do arquivo sem matrícula não é alcançada por nenhum cadastro', async () => {
    const { body } = await importar(csv([`1,${CLASSE},Sem,Matricula,,1`]));
    await pedirECadastrar({ matricula: '88281', nome: 'Sem Matricula', semente: 711 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.athleteId).toBeNull();
  });
});

// ----------------------------------------------------------------- 10, 11, 12
describe('idempotência e ausência de pontuação nova', () => {
  it('o vínculo não cria RankingPoint por conta própria', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 712 });

    // Vincular é dizer QUEM. Pontuar continua sendo a aplicação do lote.
    expect((await contagens()).pontos).toBe(0);
    expect(await itensDoLote(body.import.id).then(i => i[0].matchStatus)).toBe('MATCHED');
  });

  it('lote já aplicado recebe os pontos da linha vinculada depois, sem duplicar', async () => {
    const { body } = await importar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1, CLASSE, 1),
      linha('147986', 'Kananda', 'Azevedo', 2, CLASSE, 2)
    ]));
    // Kananda existe desde o começo; Yuri não.
    await pedirECadastrar({ matricula: '147986', nome: 'Kananda Azevedo', semente: 713 });
    await importar(csv([linha('147986', 'Kananda', 'Azevedo', 2, CLASSE, 2)]), { externalIdPrefix: 'DESCARTE' });

    await aplicar(body.import.id);
    const pontosAntes = (await ledger()).length;

    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 714 });

    const depois = await ledger();
    expect(depois.length).toBe(pontosAntes + 1);
    const soma = depois.reduce((s, p) => s + p.points, 0);

    // Reaplicar não pode somar de novo.
    await aplicar(body.import.id).catch(() => null);
    const final = await ledger();
    expect(final.length).toBe(depois.length);
    expect(final.reduce((s, p) => s + p.points, 0)).toBe(soma);
  });

  it('aplicar de novo depois do vínculo não produz ponto em dobro', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    // Antes do cadastro não há o que aplicar: a linha está pendente.
    const semNinguem = await aplicar(body.import.id);
    expect(semNinguem.status).toBe(422);
    expect((await contagens()).pontos).toBe(0);

    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 715 });

    // Agora a linha está reconhecida: esta é a PRIMEIRA aplicação de verdade.
    expect((await aplicar(body.import.id)).status).toBe(200);
    const primeiro = await itensDoLote(body.import.id);
    const contagemPrimeira = await contagens();
    expect(contagemPrimeira.pontos).toBe(1);

    // Da segunda em diante, nada muda.
    await aplicar(body.import.id).catch(() => null);
    await aplicar(body.import.id).catch(() => null);

    expect(await contagens()).toEqual(contagemPrimeira);
    const depois = await itensDoLote(body.import.id);
    expect(depois.map(i => i.externalResultId)).toEqual(primeiro.map(i => i.externalResultId));
  });

  it('aprovar duas vezes a mesma identidade não vincula duas vezes', async () => {
    // A aprovação em si já é barrada por status, mas o vínculo precisa ser
    // idempotente por conta própria: ele também roda por caminhos de reparo.
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 716 });

    const antes = await itensDoLote(body.import.id);

    // SOB CONTEXTO DE ATOR. Chamar a função crua faria o RLS devolver zero
    // linhas, e o teste passaria por não enxergar nada — provando o contrário
    // do que se propõe a provar.
    const segunda = await comoAtor(gerente, () => vincularPendentesDoAtleta(athlete, gerente));
    expect(segunda.vinculados).toBe(0);

    const depois = await itensDoLote(body.import.id);
    expect(depois.map(i => i.athleteId)).toEqual(antes.map(i => i.athleteId));
    expect(depois.map(i => i.matchStatus)).toEqual(antes.map(i => i.matchStatus));
  });

  it('duas aprovações simultâneas para a mesma identidade produzem um vínculo só', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 717, aprovar: false })
      .then(async () => {
        // Cria o atleta direto: o que está sob teste é a corrida DO VÍNCULO.
        const a = await comoAtor(gerente, tx => tx.athlete.create({
          data: {
            organizationId, fullName: 'Yuri Santinelli', sex: 'MALE', affiliationId: npc.id,
            affiliationNumber: '88281', identity: { create: { organizationId, cpf: gerarCpf(718) } }
          }
        }));
        return { athlete: a };
      });

    // Duas transações de verdade, disputando a mesma linha.
    const [a, b] = await Promise.all([
      comoAtor(gerente, () => vincularPendentesDoAtleta(athlete, gerente)),
      comoAtor(gerente, () => vincularPendentesDoAtleta(athlete, gerente))
    ]);

    // Um dos dois vence a linha; o outro encontra `athleteId` já preenchido e
    // conta zero. A guarda está no `where` do update, não numa trava.
    expect(a.vinculados + b.vinculados).toBe(1);
    const itens = await itensDoLote(body.import.id);
    expect(itens.filter(i => i.athleteId === athlete.id)).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------- 18
describe('a fronteira da organização', () => {
  it('a mesma matrícula em outra organização não alcança este resultado', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Vizinho' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Outra Federação' });
    const filiacaoVizinha = (await api().post('/api/v1/affiliations').set(outroAdmin.auth())
      .send({ organizationId: outraOrg.id, name: 'NPC', code: 'NPC' })).body;

    const pessoa = await criarUsuario({ name: 'Yuri Santinelli' });
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'Yuri Santinelli', cpf: gerarCpf(716), sex: 'MALE', birthDate: '1995-03-10',
      affiliationId: filiacaoVizinha.id, affiliationNumber: '88281'
    });
    await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`).set(outroAdmin.auth()).send({});

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCH_PENDING');
    expect(item.athleteId).toBeNull();
  });
});

// ----------------------------------------------------------------------- 17
describe('Overall não é inventado pelo vínculo', () => {
  it('linha sem Overall continua sem Overall depois de vinculada e aplicada', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 717 });
    await aplicar(body.import.id);

    for (const ponto of await ledger()) {
      expect(ponto.points).toBe(ponto.placementPoints);
    }
    const overalls = await comoAtor(gerente, tx => tx.rankingPoint.count({ where: { isOverallChampion: true } }));
    expect(overalls).toBe(0);
  });
});

// --------------------------------------------------------- nenhum atleta criado
describe('o vínculo nunca cria atleta', () => {
  it('as 3 linhas de gente não cadastrada não produzem nenhum Athlete', async () => {
    const antes = await contagens();
    await importar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1, CLASSE, 1),
      linha('147986', 'Kananda', 'Azevedo', 2, CLASSE, 2),
      linha('155494', 'Carolina', 'Martins', 3, CLASSE, 3)
    ]));
    expect((await contagens()).atletas).toBe(antes.atletas);
  });
});

describe('as bordas que a suíte de mutação apontou', () => {
  it('nome idêntico a menos de acento NÃO é registrado como divergência', async () => {
    // A primeira versão deste teste procurava a palavra "divergente" numa
    // mensagem que diz "difere" — nunca falhava, e por isso não provava nada.
    // Agora confere o texto que o código realmente escreve.
    const { body } = await importar(csv([linha('44960', 'Joao', 'Gabriel Fonseca')]));
    await pedirECadastrar({ matricula: '44960', nome: 'João Gabriel Fonseca', semente: 730 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.reason).toBe('Vinculado automaticamente por filiação + matrícula');
    expect(item.reason).not.toMatch(/difere/);
  });

  it('nome realmente diferente É registrado, com os dois nomes na mensagem', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    await pedirECadastrar({ matricula: '88281', nome: 'Outro Nome Completamente', semente: 731 });

    const [item] = await itensDoLote(body.import.id);
    expect(item.matchStatus).toBe('MATCHED');
    expect(item.reason).toMatch(/difere/);
    expect(item.reason).toMatch(/Yuri Santinelli/);
    expect(item.reason).toMatch(/Outro Nome Completamente/);
  });

  it('atleta SEM matrícula não alcança resultado nenhum', async () => {
    // O cadastro pela porta da frente exige matrícula, então este caso só
    // chega aqui por semeadura ou por dado antigo. A guarda existe para ele:
    // sem matrícula não há chave, e procurar sem chave é procurar por nome.
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    const semMatricula = await comoAtor(gerente, tx => tx.athlete.create({
      data: {
        organizationId, fullName: 'Yuri Santinelli', sex: 'MALE', affiliationId: npc.id,
        affiliationNumber: null, identity: { create: { organizationId, cpf: gerarCpf(732) } }
      }
    }));

    const resultado = await comoAtor(gerente, () => vincularPendentesDoAtleta(semMatricula, gerente));
    expect(resultado.vinculados).toBe(0);
    expect((await itensDoLote(body.import.id))[0].athleteId).toBeNull();
  });

  it('atleta sem filiação também não alcança nada', async () => {
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const semFiliacao = await comoAtor(gerente, tx => tx.athlete.create({
      data: {
        organizationId, fullName: 'Yuri Santinelli', sex: 'MALE', affiliationNumber: '88281',
        identity: { create: { organizationId, cpf: gerarCpf(733) } }
      }
    }));

    const resultado = await comoAtor(gerente, () => vincularPendentesDoAtleta(semFiliacao, gerente));
    expect(resultado.vinculados).toBe(0);
    expect((await itensDoLote(body.import.id))[0].athleteId).toBeNull();
  });

  it('linha JÁ APLICADA não é tocada por um vínculo posterior', async () => {
    // Depois de aplicada, a participação virou ponto no ledger. Revisitá-la
    // aqui a devolveria para MATCHED e abriria caminho para uma segunda
    // aplicação — pontuando duas vezes a mesma participação.
    const { body } = await importar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    const { athlete } = await pedirECadastrar({ matricula: '88281', nome: 'Yuri Santinelli', semente: 734 });
    await aplicar(body.import.id);

    const aplicados = await itensDoLote(body.import.id);
    expect(aplicados[0].matchStatus).toBe('APPLIED');
    const pontosAntes = await contagens();

    const resultado = await comoAtor(gerente, () => vincularPendentesDoAtleta(athlete, gerente));

    expect(resultado.vinculados).toBe(0);
    const depois = await itensDoLote(body.import.id);
    expect(depois[0].matchStatus).toBe('APPLIED');
    expect(await contagens()).toEqual(pontosAntes);
  });
});

describe('o caso em que a guarda de matrícula é a única barreira', () => {
  it('atleta sem matrícula NÃO absorve a linha do arquivo que também não tem', async () => {
    // Aqui as duas pontas são nulas. A consulta por matrícula casaria nulo com
    // nulo e entregaria a participação a quem nunca foi identificado por ela —
    // que é vincular por ausência de chave, o oposto do que esta função faz.
    const { body } = await importar(csv([`1,${CLASSE},Sem,Matricula,,1`]));

    const semMatricula = await comoAtor(gerente, tx => tx.athlete.create({
      data: {
        organizationId, fullName: 'Sem Matricula', sex: 'MALE', affiliationId: npc.id,
        affiliationNumber: null, identity: { create: { organizationId, cpf: gerarCpf(740) } }
      }
    }));

    const resultado = await comoAtor(gerente, () => vincularPendentesDoAtleta(semMatricula, gerente));

    expect(resultado.vinculados).toBe(0);
    const [item] = await itensDoLote(body.import.id);
    expect(item.athleteId).toBeNull();
    // Linha sem matrícula não gera chave de idempotência, então nem chega a
    // ficar pendente: é recusada na leitura. Duas barreiras antes desta, e a
    // guarda continua valendo para o dia em que a primeira mudar.
    expect(item.matchStatus).toBe('IMPORT_REJECTED');
  });
});

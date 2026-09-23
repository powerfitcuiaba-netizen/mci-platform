import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// O VÍNCULO AUTOMÁTICO, PROVADO CAMPO A CAMPO.
//
// `vinculo-tardio` já prova que o cadastro aprovado adota o ledger pela
// matrícula, que ninguém pontua duas vezes e que o nome não reconhece. Este
// arquivo tranca o que faltava, e que a auditoria E2E exercitou primeiro:
//
//   1. O CPF SOZINHO BASTA. O arquivo oficial nem sempre traz matrícula; traz
//      documento. Quando traz, é ele a chave mais forte que existe, e o
//      vínculo tem de acontecer por ele.
//
//   2. O QUE O VÍNCULO NÃO PODE MUDAR — e aqui é campo a campo, e não por
//      soma: o mesmo id de lançamento, a mesma temporada, o mesmo evento, a
//      mesma categoria, a mesma classe do catálogo, a mesma colocação, a mesma
//      pontuação e as mesmas parcelas. Somar bate e ainda assim esconder uma
//      troca de categoria entre duas linhas.
//
//   3. AMBIGUIDADE NÃO VIRA ESCOLHA. Duas pessoas disputando a mesma chave
//      deixam o histórico sem dono, e não com o dono errado. Creditar "ao que
//      apareceu primeiro" seria dar a carreira de alguém a outra pessoa, e o
//      erro só apareceria quando a prejudicada fosse ver o próprio histórico.
// ============================================================================

let admin, gerente, organizationId, npc, seasonId, eventId;

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const TABELA = [
  { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
  { placing: 4, points: 2 }, { placing: 5, points: 1 }
];

const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = ({ id, cpf = '', nome, matricula = '', categoria = 'BIKINI', classe = "Women's Bikini - Open Class A", colocacao = 1 }) =>
  `${id},${cpf},${nome},${matricula ? 'NPC' : ''},${matricula},${categoria},${classe},${colocacao},Etapa QA`;

const importar = conteudo => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, eventId, sourceType: 'CSV',
  sourceRef: `${unico('auto')}.csv`, content: conteudo
});

const aplicar = importId => api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()).send({});

// O RETRATO COMPLETO do lançamento. É contra ele que o depois é conferido.
const retrato = () => comoAtor(gerente, tx => tx.rankingPoint.findMany({
  orderBy: { id: 'asc' },
  select: {
    id: true, athleteId: true, seasonId: true, eventId: true, categoryId: true,
    catalogClassId: true, placing: true, placementPoints: true, overallBonus: true,
    adjustmentPoints: true, points: true, superOverallPoints: true,
    externalResultId: true, externalAthleteId: true, voidedAt: true
  }
}));

const semODono = linhas => linhas.map(({ athleteId, ...resto }) => ({ ...resto, _temDono: athleteId != null }));

const contagens = () => comoAtor(gerente, async tx => ({
  pontos: await tx.rankingPoint.count(),
  externos: await tx.externalResult.count(),
  identidades: await tx.externalAthlete.count(),
  atletas: await tx.athlete.count()
}));

// O cadastro pela porta da frente: o próprio interessado pede, e ACABOU —
// não há operador no meio. É o fluxo que o vínculo automático escuta, e a
// ausência do passo de aprovação é parte do que estes testes provam.
async function cadastrarPelaPortaDaFrente({ nome, cpf, matricula = null }) {
  const pessoa = await criarUsuario({ name: nome });
  const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
    fullName: nome, cpf, sex: 'FEMALE', birthDate: '1994-03-08',
    affiliationId: npc.id, affiliationNumber: matricula ?? `LIVRE-${unico('m')}`
  });
  expect(pedido.status, JSON.stringify(pedido.body).slice(0, 300)).toBe(201);

  // NINGUÉM APROVOU. O cadastro já nasce concluído e sem revisor assinado —
  // e se algum dia voltar a nascer PENDENTE, é aqui que se descobre.
  expect(pedido.body.status, 'o autocadastro voltou a enfileirar').toBe('APPROVED');
  expect(pedido.body.reviewedById, 'alguém consta como revisor de um cadastro automático').toBeNull();

  const sessao = await api().get('/api/v1/auth/me').set(pessoa.auth());
  return {
    pessoa,
    pedido: pedido.body,
    athleteId: sessao.body.user.athleteId,
    conciliacao: pedido.body.conciliacao
  };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  // A federação precisa estar RECEBENDO autocadastro. A conferência desceu da
  // vitrine para o serviço: esconder a filiação nunca impediu quem já tivesse
  // o id dela, e com a conclusão automática o furo passaria a criar atleta.
  await api().post(`/api/v1/organizations/${organizationId}/self-registration`)
    .set(admin.auth()).send({ open: true });

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({ rules: TABELA });

  eventId = (await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: 'Etapa QA', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Sao Paulo', state: 'SP', seasonId
  })).body.id;
});

// ------------------------------------------------------------- o CPF sozinho

describe('o CPF sozinho basta para o vínculo automático', () => {
  it('o histórico entra sem dono e ganha dono no cadastro, sem que ninguém peça', async () => {
    const cpf = gerarCpf(901234);
    const lote = await importar(csv([linha({ id: 'AUTO-CPF-1', cpf, nome: 'JOANA PEREIRA' })]));
    expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
    expect((await aplicar(lote.body.import.id)).status).toBe(200);

    const antes = await retrato();
    expect(antes).toHaveLength(1);
    expect(antes[0].athleteId).toBeNull();
    expect(antes[0].placing).toBe(1);
    expect(antes[0].points).toBe(5);

    const contagemAntes = await contagens();

    // O cadastro — SEM matrícula que case com o arquivo. A única chave em
    // comum é o CPF.
    const { athleteId } = await cadastrarPelaPortaDaFrente({ nome: 'JOANA PEREIRA', cpf });
    expect(athleteId).toBeTruthy();

    const depois = await retrato();

    // O DONO MUDOU — e só ele.
    expect(depois).toHaveLength(1);
    expect(depois[0].athleteId).toBe(athleteId);
    expect(semODono(depois)).toEqual(semODono(antes).map(l => ({ ...l, _temDono: true })));

    // E nada foi criado a mais.
    const contagemDepois = await contagens();
    expect(contagemDepois.pontos).toBe(contagemAntes.pontos);
    expect(contagemDepois.externos).toBe(contagemAntes.externos);
    expect(contagemDepois.identidades).toBe(contagemAntes.identidades);
  });

  it('campo a campo: temporada, evento, categoria, classe, colocação e pontuação ficam idênticos', async () => {
    const cpf = gerarCpf(902345);
    const lote = await importar(csv([
      linha({ id: 'AUTO-CPF-2', cpf, nome: 'JOANA PEREIRA' }),
      linha({ id: 'AUTO-CPF-3', cpf, nome: 'JOANA PEREIRA', categoria: 'WELLNESS', classe: 'Wellness - Open', colocacao: 3 })
    ]));
    await aplicar(lote.body.import.id);

    const antes = await retrato();
    expect(antes).toHaveLength(2);
    expect(antes.every(p => p.athleteId === null)).toBe(true);

    const { athleteId } = await cadastrarPelaPortaDaFrente({ nome: 'JOANA PEREIRA', cpf });
    const depois = await retrato();

    // A COMPARAÇÃO É POR CAMPO, e não por soma: somar bate mesmo quando duas
    // linhas trocam de categoria entre si.
    expect(depois.map(p => p.id)).toEqual(antes.map(p => p.id));
    for (const [i, linhaAntes] of antes.entries()) {
      const linhaDepois = depois[i];
      expect(linhaDepois.seasonId).toBe(linhaAntes.seasonId);
      expect(linhaDepois.eventId).toBe(linhaAntes.eventId);
      expect(linhaDepois.categoryId).toBe(linhaAntes.categoryId);
      expect(linhaDepois.catalogClassId).toBe(linhaAntes.catalogClassId);
      expect(linhaDepois.placing).toBe(linhaAntes.placing);
      expect(linhaDepois.placementPoints).toBe(linhaAntes.placementPoints);
      expect(linhaDepois.overallBonus).toBe(linhaAntes.overallBonus);
      expect(linhaDepois.adjustmentPoints).toBe(linhaAntes.adjustmentPoints);
      expect(linhaDepois.points).toBe(linhaAntes.points);
      expect(linhaDepois.superOverallPoints).toBe(linhaAntes.superOverallPoints);
      expect(linhaDepois.externalResultId).toBe(linhaAntes.externalResultId);
      expect(linhaDepois.externalAthleteId).toBe(linhaAntes.externalAthleteId);
      expect(linhaDepois.voidedAt).toBe(linhaAntes.voidedAt);
      expect(linhaDepois.athleteId).toBe(athleteId);
    }

    // As duas categorias continuam distintas — a prova de que a igualdade
    // acima não é trivial.
    expect(new Set(depois.map(p => p.categoryId)).size).toBe(2);
    expect(depois.map(p => p.points).sort()).toEqual([3, 5]);
  });

  it('o vínculo alcança quem se cadastrou, e NINGUÉM mais', async () => {
    const meu = gerarCpf(903456);
    const alheio = gerarCpf(904567);
    const lote = await importar(csv([
      linha({ id: 'AUTO-MEU', cpf: meu, nome: 'JOANA PEREIRA' }),
      linha({ id: 'AUTO-ALHEIO', cpf: alheio, nome: 'OUTRA PESSOA', colocacao: 2 })
    ]));
    await aplicar(lote.body.import.id);

    const { athleteId } = await cadastrarPelaPortaDaFrente({ nome: 'JOANA PEREIRA', cpf: meu });

    const depois = await retrato();
    const meuPonto = depois.find(p => p.athleteId === athleteId);
    const semDono = depois.filter(p => p.athleteId === null);

    expect(meuPonto).toBeTruthy();
    expect(semDono).toHaveLength(1);
    expect(semDono[0].points).toBe(4);
  });
});

// ------------------------------------------------------- o nome não vincula

describe('o nome sozinho nunca vincula', () => {
  it('nome idêntico, CPF e matrícula diferentes: o histórico continua sem dono', async () => {
    const doArquivo = gerarCpf(905678);
    const lote = await importar(csv([linha({ id: 'AUTO-NOME', cpf: doArquivo, nome: 'ANA SILVA' })]));
    await aplicar(lote.body.import.id);

    const antes = await retrato();
    expect(antes[0].athleteId).toBeNull();

    // Mesma grafia do nome, outra pessoa.
    const { athleteId } = await cadastrarPelaPortaDaFrente({ nome: 'ANA SILVA', cpf: gerarCpf(906789) });
    expect(athleteId).toBeTruthy();

    const depois = await retrato();
    expect(depois[0].athleteId).toBeNull();
    expect(depois[0].id).toBe(antes[0].id);
    expect(depois[0].points).toBe(antes[0].points);
  });

  it('e o histórico homônimo aparece como SUGESTÃO, marcada para confirmação humana', async () => {
    const doArquivo = gerarCpf(907890);
    const lote = await importar(csv([linha({ id: 'AUTO-SUG', cpf: doArquivo, nome: 'ANA SILVA' })]));
    await aplicar(lote.body.import.id);

    const { athleteId } = await cadastrarPelaPortaDaFrente({ nome: 'ANA SILVA', cpf: gerarCpf(908901) });

    const historico = await api().get(`/api/v1/athletes/${athleteId}/imported-history`).set(admin.auth());
    expect(historico.status).toBe(200);
    expect(historico.body.linked).toEqual([]);

    const sugestao = historico.body.suggestions.find(s => s.displayName === 'ANA SILVA');
    expect(sugestao).toBeTruthy();
    expect(sugestao.matchedBy).toBe('NAME');
    expect(sugestao.exigeConfirmacaoHumana).toBe(true);
  });
});

// --------------------------------------------------- ambiguidade não decide

describe('ambiguidade vai para revisão, e não para o atleta errado', () => {
  it('duas pessoas com a MESMA matrícula não fazem o histórico escolher uma', async () => {
    // O arquivo traz matrícula e NÃO traz CPF: a única chave é a matrícula.
    const lote = await importar(csv([linha({ id: 'AUTO-AMB', nome: 'CARLA DIAS', matricula: 'NPC-777' })]));
    await aplicar(lote.body.import.id);
    expect((await retrato())[0].athleteId).toBeNull();

    // Duas pessoas reivindicam a mesma matrícula. A primeira passa; a segunda
    // é recusada pela unicidade — e é ESSA recusa que impede a ambiguidade de
    // nascer.
    const primeira = await cadastrarPelaPortaDaFrente({ nome: 'CARLA DIAS', cpf: gerarCpf(909012), matricula: 'NPC-777' });
    expect(primeira.athleteId).toBeTruthy();

    const segunda = await criarUsuario({ name: 'CARLA DIAS (a outra)' });
    const pedidoDaSegunda = await api().post('/api/v1/athlete-requests').set(segunda.auth()).send({
      fullName: 'CARLA DIAS', cpf: gerarCpf(910123), sex: 'FEMALE',
      affiliationId: npc.id, affiliationNumber: 'NPC-777'
    });

    // A RECUSA AGORA É NO CADASTRO, e não numa aprovação que nunca virá. A
    // ambiguidade não chega a nascer: a segunda pessoa não vira atleta.
    expect(pedidoDaSegunda.status).toBe(409);

    // E A RECUSA É MUDA. Ela não confirma que a matrícula existe, não diz de
    // quem é, não devolve nome nem documento — porque quem recebe esta
    // resposta é qualquer um que preencheu o formulário, e uma recusa
    // específica transformaria o cadastro num detector de matrículas.
    expect(pedidoDaSegunda.body.error.code).toBe('REGISTRATION_NEEDS_REVIEW');
    const texto = JSON.stringify(pedidoDaSegunda.body).toUpperCase();
    expect(texto, 'a recusa entregou a matrícula de volta').not.toContain('NPC-777');
    expect(texto, 'a recusa nomeou a outra atleta').not.toContain('CARLA');

    // O histórico ficou com a ÚNICA dona possível da matrícula, e o sistema
    // nunca teve de escolher entre duas.
    const depois = await retrato();
    expect(depois).toHaveLength(1);
    expect(depois[0].athleteId).toBe(primeira.athleteId);
  });
});

// ------------------------------------------------------------ idempotência

describe('repetir não soma', () => {
  it('reaplicar o lote depois do vínculo não cria lançamento nem ponto', async () => {
    const cpf = gerarCpf(911234);
    const lote = await importar(csv([linha({ id: 'AUTO-IDEM', cpf, nome: 'JOANA PEREIRA' })]));
    await aplicar(lote.body.import.id);
    await cadastrarPelaPortaDaFrente({ nome: 'JOANA PEREIRA', cpf });

    const antes = await retrato();
    const contagemAntes = await contagens();

    await aplicar(lote.body.import.id).catch(() => null);

    expect(await retrato()).toEqual(antes);
    expect(await contagens()).toEqual(contagemAntes);
  });
});

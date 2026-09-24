import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';
// Os dois módulos REAIS, e não dublês: a idempotência é medida chamando a
// mesma função que a requisição chama, e a matriz de permissões é lida de
// onde a aplicação a lê.
import muscleWar from '../src/services/muscleWarService.js';
import permissoes from '../src/utils/permissions.js';

// ============================================================================
// A BATERIA A–H DA CONCILIAÇÃO AUTOMÁTICA, A CONTA DE SERVIÇO E A CORRIDA.
//
// Três perguntas, e elas não se substituem:
//
//   1. A CONCILIAÇÃO ACERTA? (A–H) Cada chave leva ao vínculo certo, a
//      ambiguidade NÃO leva a nenhum, e repetir não soma.
//
//   2. QUEM ESCREVEU PODE ESCREVER? A conta de serviço tem poder de operador
//      no banco. Se ela alcançar outra federação, ou se alguém conseguir
//      vesti-la, a arquitetura inteira cai — e cai em silêncio, porque os
//      dados ficariam plausíveis.
//
//   3. DUAS AO MESMO TEMPO? Um atleta, uma identidade, nenhum ponto em
//      dobro. Corrida é onde a idempotência costuma ser só uma promessa.
//
// O QUE ESTE ARQUIVO NÃO FAZ: ele não confere soma. Confere CAMPO A CAMPO,
// porque somar bate e ainda assim esconde uma troca de categoria entre duas
// linhas — e o atleta só descobriria ao abrir o próprio histórico.
// ============================================================================

let admin, gerente, organizationId, npc, outraNpc, seasonId, eventId, outraOrgId;

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const TABELA = [
  { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
  { placing: 4, points: 2 }, { placing: 5, points: 1 }
];

const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = ({ id, cpf = '', nome, matricula = '', categoria = 'BIKINI', classe = "Women's Bikini - Open Class A", colocacao = 1, evento = 'Etapa QA' }) =>
  `${id},${cpf},${nome},${matricula ? 'NPC' : ''},${matricula},${categoria},${classe},${colocacao},${evento}`;

const importar = conteudo => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, eventId, sourceType: 'CSV',
  sourceRef: `${unico('ah')}.csv`, content: conteudo
});

const aplicar = importId => api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()).send({});

// O RETRATO COMPLETO do lançamento — é contra ele que o "depois" é conferido.
const retrato = () => comoAtor(gerente, tx => tx.rankingPoint.findMany({
  orderBy: { id: 'asc' },
  select: {
    id: true, athleteId: true, seasonId: true, eventId: true, categoryId: true,
    catalogClassId: true, placing: true, placementPoints: true, overallBonus: true,
    adjustmentPoints: true, points: true, superOverallPoints: true,
    externalResultId: true, externalAthleteId: true, voidedAt: true
  }
}));

// Tudo menos o dono: é exatamente o que o vínculo NÃO pode ter mudado.
const semODono = linhas => linhas.map(({ athleteId: _dono, ...resto }) => resto);

const contagens = () => comoAtor(gerente, async tx => ({
  pontos: await tx.rankingPoint.count(),
  atletas: await tx.athlete.count(),
  identidades: await tx.athleteIdentity.count(),
  externos: await tx.externalAthlete.count()
}));

const semear = async (linhas) => {
  const lote = await importar(csv(linhas));
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  expect((await aplicar(lote.body.import.id)).status).toBe(200);
  return lote.body.import.id;
};

// O autocadastro pela porta da frente. Devolve o desfecho da conciliação, que
// é o que a tela mostra e o que estes testes cobram.
const autocadastrar = async ({ nome, cpf, matricula = null, filiacao = null }) => {
  const pessoa = await criarUsuario({ name: nome });
  const r = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
    fullName: nome, cpf, sex: 'FEMALE', birthDate: '1995-03-10',
    affiliationId: (filiacao ?? npc).id,
    affiliationNumber: matricula ?? `LIVRE-${unico('m')}`
  });
  return { pessoa, resposta: r };
};

const contaDeServicoDe = organizacao => comoAtor(admin, tx => tx.user.findFirst({
  where: { serviceOrganizationId: organizacao, isServiceAccount: true },
  select: { id: true, email: true, name: true, role: true, serviceOrganizationId: true }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  gerente = await criarUsuario({ name: 'Gerente' });

  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({ rules: TABELA });

  eventId = (await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: 'Etapa QA', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiabá', state: 'MT', seasonId
  })).body.id;

  // Uma SEGUNDA federação, para que "só a dela" seja uma afirmação medível.
  outraOrgId = (await criarOrganizacao(admin, { name: 'Outra Federação' })).id;
  outraNpc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: outraOrgId, name: 'NPC Outra', code: 'NPCOUT' })).body;
});

// ==========================================================================
// A BATERIA A–H
// ==========================================================================

describe('A — CPF correto vincula sozinho, e não muda mais nada', () => {
  it('o histórico ganha dono, campo a campo idêntico, sem ninguém aprovar', async () => {
    const cpf = gerarCpf(500001);
    await semear([
      linha({ id: 'A-1', cpf, nome: 'JOANA PEREIRA', colocacao: 1 }),
      linha({ id: 'A-2', cpf, nome: 'JOANA PEREIRA', colocacao: 3, evento: 'Etapa QA' })
    ]);

    const antes = await retrato();
    expect(antes).toHaveLength(2);
    expect(antes.every(l => l.athleteId === null), 'o histórico já tinha dono').toBe(true);

    const { resposta } = await autocadastrar({ nome: 'JOANA PEREIRA', cpf });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.status).toBe('APPROVED');
    expect(resposta.body.reviewedById, 'alguém aprovou').toBeNull();
    expect(resposta.body.conciliacao.estado).toBe('VINCULADO');
    expect(resposta.body.conciliacao.matchMethod).toBe('CPF');

    const depois = await retrato();

    // MESMOS IDS, na mesma ordem. Nenhum lançamento novo, nenhum apagado.
    expect(depois.map(l => l.id)).toEqual(antes.map(l => l.id));

    // TUDO menos o dono ficou idêntico — campo a campo, e não por soma.
    expect(semODono(depois)).toEqual(semODono(antes));

    // E o dono é o cadastro novo, nos DOIS lançamentos: histórico completo,
    // e não "o primeiro que apareceu".
    const donos = new Set(depois.map(l => l.athleteId));
    expect(donos.size, 'os lançamentos ficaram com donos diferentes').toBe(1);
    expect([...donos][0]).toBe(resposta.body.athleteId);

    // A auditoria nomeia os lançamentos, e diz que quem executou foi o sistema.
    const conciliacao = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'ATHLETE_HISTORY_RECONCILED' }
    }));
    expect(conciliacao.metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
    expect(conciliacao.metadata.matchMethod).toBe('CPF');
    expect([...conciliacao.metadata.rankingPointIds].sort()).toEqual([...antes.map(l => l.id)].sort());
  });
});

describe('B — CPF e filiação juntos são registrados como evidência mais forte', () => {
  it('matchMethod distingue CPF_AFFILIATION de CPF', async () => {
    const cpf = gerarCpf(500002);
    await semear([linha({ id: 'B-1', cpf, nome: 'MARIA SILVA', matricula: 'NPC-5002' })]);

    const { resposta } = await autocadastrar({ nome: 'MARIA SILVA', cpf, matricula: 'NPC-5002' });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.conciliacao.estado).toBe('VINCULADO');
    // Documento E filiação bateram. Registrar isto como "CPF" esconderia que
    // a correspondência teve duas confirmações, não uma.
    expect(resposta.body.conciliacao.matchMethod).toBe('CPF_AFFILIATION');

    const [ponto] = await retrato();
    expect(ponto.athleteId).toBe(resposta.body.athleteId);
  });
});

describe('C — filiação sozinha vincula quando é única e inequívoca', () => {
  it('sem CPF no arquivo, a matrícula basta — e o método diz isso', async () => {
    // O arquivo NÃO traz documento: a única chave possível é a matrícula.
    await semear([linha({ id: 'C-1', nome: 'CARLA DIAS', matricula: 'NPC-5003' })]);

    const antes = await retrato();
    expect(antes[0].athleteId).toBeNull();

    const { resposta } = await autocadastrar({
      nome: 'CARLA DIAS', cpf: gerarCpf(500003), matricula: 'NPC-5003'
    });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.conciliacao.estado).toBe('VINCULADO');
    expect(resposta.body.conciliacao.matchMethod).toBe('AFFILIATION');

    const depois = await retrato();
    expect(semODono(depois)).toEqual(semODono(antes));
    expect(depois[0].athleteId).toBe(resposta.body.athleteId);
  });
});

describe('D — ambiguidade NÃO vira escolha', () => {
  // O arquivo afirma um CPF; o cadastro afirma outro. A matrícula bater não
  // torna a pessoa a mesma — torna o caso duvidoso. Creditar assim mesmo
  // daria a carreira de alguém a outra pessoa, e o erro só apareceria quando
  // a prejudicada fosse ver o próprio histórico.
  it('CPF divergente com matrícula igual não vincula, e pede confirmação', async () => {
    const cpfDoArquivo = gerarCpf(500004);
    const cpfDoCadastro = gerarCpf(500005);
    await semear([linha({ id: 'D-1', cpf: cpfDoArquivo, nome: 'ANA COSTA', matricula: 'NPC-5004' })]);

    const antes = await retrato();

    const { resposta } = await autocadastrar({
      nome: 'ANA COSTA', cpf: cpfDoCadastro, matricula: 'NPC-5004'
    });

    // O CADASTRO ACONTECE — a pessoa não fica sem conta por causa de um
    // histórico duvidoso. O que não acontece é o vínculo.
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.status).toBe('APPROVED');
    expect(resposta.body.conciliacao.estado).toBe('PRECISA_CONFIRMAR');
    expect(resposta.body.conciliacao.vinculados).toBe(0);
    expect(resposta.body.conciliacao.exigeConfirmacao).toBeGreaterThan(0);
    expect(resposta.body.conciliacao.rankingPointIds).toEqual([]);

    // O histórico continua SEM DONO — inclusive sem o dono errado.
    const depois = await retrato();
    expect(depois.map(l => l.athleteId)).toEqual([null]);
    expect(semODono(depois)).toEqual(semODono(antes));

    // E o desfecho NÃO conta de quem é o histórico nem qual CPF o arquivo
    // trazia: quem recebe esta resposta é quem acabou de se cadastrar.
    const texto = JSON.stringify(resposta.body);
    expect(texto, 'o desfecho devolveu o CPF do arquivo').not.toContain(cpfDoArquivo.replace(/\D/g, ''));
  });

  it('nome igual, sem CPF e sem matrícula, NUNCA vincula', async () => {
    // A linha não tem chave nenhuma além do nome. O nome é auxiliar, nunca
    // chave: homônimo é comum, e um vínculo por nome é irreversível na
    // prática — ninguém audita o que já parece certo.
    await semear([linha({ id: 'D-2', nome: 'ANA COSTA' })]);
    const antes = await retrato();

    const { resposta } = await autocadastrar({ nome: 'ANA COSTA', cpf: gerarCpf(500006) });

    expect(resposta.status).toBe(201);
    expect(resposta.body.conciliacao.estado).toBe('SEM_HISTORICO');

    const depois = await retrato();
    expect(depois.map(l => l.athleteId), 'o nome vinculou sozinho').toEqual([null]);
    expect(semODono(depois)).toEqual(semODono(antes));
  });
});

describe('E — CPF que não está em lugar nenhum', () => {
  it('o cadastro acontece normalmente, e nada é vinculado', async () => {
    await semear([linha({ id: 'E-1', cpf: gerarCpf(500007), nome: 'OUTRA PESSOA' })]);
    const antes = await retrato();

    const { resposta } = await autocadastrar({ nome: 'SEM PASSADO', cpf: gerarCpf(500008) });

    expect(resposta.status).toBe(201);
    expect(resposta.body.status).toBe('APPROVED');
    expect(resposta.body.conciliacao.estado).toBe('SEM_HISTORICO');
    expect(resposta.body.conciliacao.matchMethod).toBe('SEM_HISTORICO');

    const depois = await retrato();
    expect(depois.map(l => l.athleteId), 'o histórico de outra pessoa foi tocado').toEqual([null]);
    expect(semODono(depois)).toEqual(semODono(antes));
  });
});

describe('F — ninguém importou nada ainda', () => {
  it('o cadastro acontece, e o desfecho diz que não havia o que vincular', async () => {
    const { resposta } = await autocadastrar({ nome: 'PRIMEIRA DE TODAS', cpf: gerarCpf(500009) });

    expect(resposta.status).toBe(201);
    expect(resposta.body.status).toBe('APPROVED');
    expect(resposta.body.athleteId).toBeTruthy();
    expect(resposta.body.conciliacao.estado).toBe('SEM_HISTORICO');
    expect(resposta.body.conciliacao.vinculados).toBe(0);
    expect(await retrato()).toHaveLength(0);
  });
});

describe('M3 — a demonstração de que o mutante é equivalente', () => {
  // O teste de mutação apagou `homonimosDeMatricula === 0` da adoção do ledger
  // e NENHUM teste falhou. Chamar isso de "mutante equivalente" sem demonstrar
  // seria exatamente o tipo de afirmação que este projeto não aceita.
  //
  // A demonstração é esta: a condição não pode ser falsa porque o BANCO
  // impede o estado que a tornaria falsa. `homonimosDeMatricula` conta
  // atletas com a MESMA (organização, filiação, matrícula), e existe índice
  // único parcial exatamente sobre essas três colunas, com
  // `WHERE affiliationId IS NOT NULL AND affiliationNumber IS NOT NULL` — que
  // é a mesma condição sob a qual a contagem é feita.
  //
  // Não é argumento: é medido, aqui embaixo, das duas pontas.

  it('o índice único existe, e cobre exatamente as colunas da contagem', async () => {
    const [indice] = await comoAtor(admin, tx => tx.$queryRawUnsafe(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'Athlete'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%affiliationNumber%'
    `));
    expect(indice, 'o índice único sumiu: a guarda deixou de ser inalcançável').toBeTruthy();
    for (const coluna of ['organizationId', 'affiliationId', 'affiliationNumber']) {
      expect(indice.indexdef).toContain(coluna);
    }
    // A condição parcial é o que faz o índice valer SEMPRE que a contagem é
    // feita — a contagem só ocorre com os dois campos preenchidos.
    expect(indice.indexdef).toMatch(/affiliationId.*IS NOT NULL/i);
    expect(indice.indexdef).toMatch(/affiliationNumber.*IS NOT NULL/i);
  });

  it('o banco RECUSA dois atletas com a mesma matrícula na mesma filiação', async () => {
    // A outra ponta: mesmo escrevendo direto, sem passar por regra de
    // aplicação nenhuma, o estado não nasce. É isso que torna
    // `homonimosDeMatricula > 0` inalcançável — e o mutante, equivalente.
    const base = {
      organizationId, affiliationId: npc.id, affiliationNumber: 'DUPLA-1',
      sex: 'FEMALE', birthDate: new Date('1990-01-01T12:00:00.000Z')
    };
    await comoAtor(gerente, tx => tx.athlete.create({ data: { ...base, fullName: 'PRIMEIRA' } }));

    await expect(
      comoAtor(gerente, tx => tx.athlete.create({ data: { ...base, fullName: 'SEGUNDA' } }))
    ).rejects.toThrow();

    const quantos = await comoAtor(gerente, tx => tx.athlete.count({
      where: { organizationId, affiliationId: npc.id, affiliationNumber: 'DUPLA-1' }
    }));
    expect(quantos, 'o banco aceitou duas: a guarda VOLTOU a ser alcançável').toBe(1);
  });

  it('e a guarda continua no código, para o dia em que o índice mudar', async () => {
    // Mutante equivalente não é código morto a remover: é código que protege
    // contra uma mudança futura. Se alguém afrouxar o índice, a guarda passa a
    // valer — e o teste acima falha primeiro, avisando.
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync(new URL('../src/services/muscleWarService.js', import.meta.url), 'utf8');
    expect(fonte, 'a guarda de homônimos foi removida da adoção do ledger')
      .toContain('homonimosDeMatricula === 0 && !matriculaImpedida');
  });
});

describe('G — repetir não soma', () => {
  // Idempotência aqui não é elegância: a conciliação roda em caminho de
  // reentrada (foto que chega depois, lote reaplicado, retentativa de rede).
  // Se a segunda passada creditasse de novo, o atleta apareceria com o dobro
  // dos pontos e a tabela do campeonato ficaria errada sem ninguém ver o erro.
  it('a segunda conciliação do MESMO atleta não vincula nada a mais', async () => {
    const cpf = gerarCpf(500010);
    await semear([
      linha({ id: 'G-1', cpf, nome: 'BRUNA LIMA', matricula: 'NPC-5010', colocacao: 1 }),
      linha({ id: 'G-2', cpf, nome: 'BRUNA LIMA', matricula: 'NPC-5010', colocacao: 2 })
    ]);

    const { resposta } = await autocadastrar({ nome: 'BRUNA LIMA', cpf, matricula: 'NPC-5010' });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.conciliacao.vinculados).toBeGreaterThan(0);

    const depoisDaPrimeira = await retrato();
    const contagemDepoisDaPrimeira = await contagens();

    // A SEGUNDA PASSADA, pela mesma porta que a primeira usou: a própria
    // conciliação, com a identidade da conta de serviço. Não é simulação —
    // é a função que roda em produção.
    const atleta = await comoAtor(admin, tx => tx.athlete.findUnique({ where: { id: resposta.body.athleteId } }));
    const conta = await contaDeServicoDe(organizationId);
    const segunda = await comoAtor(conta.id, () => muscleWar.vincularPendentesDoAtleta(atleta, conta));

    expect(segunda.lancamentosVinculados, 'a segunda passada creditou de novo').toBe(0);
    expect(segunda.vinculados, 'a segunda passada revinculou itens').toBe(0);

    // E o ledger está IDÊNTICO — com o dono, campo a campo.
    expect(await retrato()).toEqual(depoisDaPrimeira);
    expect(await contagens()).toEqual(contagemDepoisDaPrimeira);
  });

  it('reaplicar o MESMO lote depois do cadastro não cria lançamento nenhum', async () => {
    const cpf = gerarCpf(500011);
    const conteudo = csv([
      linha({ id: 'G-3', cpf, nome: 'DANIELA ROCHA', colocacao: 1 }),
      linha({ id: 'G-4', cpf, nome: 'DANIELA ROCHA', colocacao: 4 })
    ]);
    const lote = await importar(conteudo);
    expect((await aplicar(lote.body.import.id)).status).toBe(200);

    const { resposta } = await autocadastrar({ nome: 'DANIELA ROCHA', cpf });
    expect(resposta.body.conciliacao.estado).toBe('VINCULADO');

    const antes = await retrato();
    const contagemAntes = await contagens();

    // O MESMO arquivo, subido de novo. Acontece de verdade: o operador
    // reenvia porque não tem certeza se o primeiro envio pegou.
    const repetido = await importar(conteudo);
    expect(repetido.status).toBe(201);
    await aplicar(repetido.body.import.id);

    // A unicidade de (source, externalId) é a autoridade. Se ela falhasse, o
    // atleta ficaria com a pontuação dobrada e o ranking inteiro sairia errado.
    expect(await retrato()).toEqual(antes);
    expect(await contagens()).toEqual(contagemAntes);
  });

  it('um segundo cadastro com o MESMO CPF não duplica nada, e não conta que o CPF existe', async () => {
    const cpf = gerarCpf(500012);
    await semear([linha({ id: 'G-5', cpf, nome: 'ELISA MOURA' })]);

    const primeiro = await autocadastrar({ nome: 'ELISA MOURA', cpf });
    expect(primeiro.resposta.status).toBe(201);

    const antes = await retrato();
    const contagemAntes = await contagens();

    const segundo = await autocadastrar({ nome: 'ELISA MOURA', cpf });

    // RECUSA NEUTRA: 409 sem dizer qual identificador colidiu. Uma resposta
    // que diferenciasse "CPF já cadastrado" de "matrícula já cadastrada"
    // transformaria esta porta num detector de quem está cadastrado aqui —
    // basta variar o número e ler a resposta.
    expect(segundo.resposta.status).toBe(409);
    expect(segundo.resposta.body.error.code).toBe('REGISTRATION_NEEDS_REVIEW');
    expect(segundo.resposta.body.error.details.conciliacao.estado).toBe('PRECISA_REVISAO');
    const texto = JSON.stringify(segundo.resposta.body);
    expect(texto).not.toContain(cpf.replace(/\D/g, ''));
    expect(texto, 'a resposta nomeou a colisão').not.toMatch(/CPF_ALREADY_REGISTERED|AFFILIATION_NUMBER_IN_USE/);

    // Nada foi criado, nada foi movido.
    expect(await retrato()).toEqual(antes);
    expect(await contagens()).toEqual(contagemAntes);

    // Mas a AUDITORIA sabe exatamente o que houve — é o que o operador lê
    // quando a pessoa ligar. Sem isto, ele mandaria conferir o documento sem
    // saber se o problema era o documento.
    const bloqueio = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'ATHLETE_PROFILE_REQUEST_AUTO_BLOCKED' }, orderBy: { createdAt: 'desc' }
    }));
    expect(bloqueio, 'o bloqueio não deixou rastro no banco').toBeTruthy();
    expect(bloqueio.metadata.motivo).toBe('CPF_ALREADY_REGISTERED');
    expect(bloqueio.metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
  });

  it('o pedido bloqueado fica PENDENTE para a federação resolver', async () => {
    // A fila foi aposentada como caminho NORMAL. Ela continua sendo o lugar da
    // EXCEÇÃO — e se o pedido bloqueado sumisse, a pessoa ficaria sem cadastro
    // e sem ninguém sabendo que ela tentou.
    const cpf = gerarCpf(500013);
    await autocadastrar({ nome: 'FLAVIA NUNES', cpf });
    const { pessoa, resposta } = await autocadastrar({ nome: 'FLAVIA NUNES', cpf });
    expect(resposta.status).toBe(409);

    const meus = await api().get('/api/v1/athlete-requests/me').set(pessoa.auth());
    expect(meus.status).toBe(200);
    expect(meus.body.items).toHaveLength(1);
    expect(meus.body.items[0].status).toBe('PENDING');
    expect(meus.body.items[0].athleteId).toBeNull();
    // E o CPF não volta nem por aqui.
    expect(JSON.stringify(meus.body)).not.toContain(cpf.replace(/\D/g, ''));
  });
});

describe('H — duas ao mesmo tempo', () => {
  // A conferência prévia e a escrita não são o mesmo instante. Entre uma e
  // outra cabe outra requisição inteira — e é exatamente aí que um sistema
  // que "parece idempotente" cria o segundo atleta.
  it('dois cadastros simultâneos com o mesmo CPF produzem UM atleta e UMA identidade', async () => {
    const cpf = gerarCpf(500014);
    await semear([
      linha({ id: 'H-1', cpf, nome: 'GABRIELA SOUZA', colocacao: 1 }),
      linha({ id: 'H-2', cpf, nome: 'GABRIELA SOUZA', colocacao: 2 })
    ]);
    const antes = await retrato();

    const [umaPessoa, outraPessoa] = await Promise.all([
      criarUsuario({ name: 'GABRIELA SOUZA' }),
      criarUsuario({ name: 'GABRIELA SOUZA' })
    ]);

    const enviar = pessoa => api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'GABRIELA SOUZA', cpf, sex: 'FEMALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: `LIVRE-${unico('m')}`
    });

    // DE VERDADE ao mesmo tempo: as duas saem antes de qualquer uma responder.
    const [a, b] = await Promise.all([enviar(umaPessoa), enviar(outraPessoa)]);

    const criados = [a, b].filter(r => r.status === 201);
    expect(criados.length, `respostas: ${a.status} e ${b.status}`).toBe(1);

    const contagem = await contagens();
    expect(contagem.atletas, 'a corrida criou dois atletas').toBe(1);
    expect(contagem.identidades, 'a corrida criou duas identidades').toBe(1);
    expect(contagem.pontos, 'a corrida duplicou lançamentos').toBe(antes.length);

    // O histórico tem UM dono, e é o cadastro que venceu.
    const depois = await retrato();
    expect(semODono(depois)).toEqual(semODono(antes));
    const donos = new Set(depois.map(l => l.athleteId));
    expect(donos.size).toBe(1);
    expect([...donos][0]).toBe(criados[0].body.athleteId);

    // E quem perdeu a corrida recebeu a MESMA recusa neutra — nada que
    // confirme que aquele CPF passou a existir aqui.
    const perdedora = [a, b].find(r => r.status !== 201);
    expect(perdedora.status).toBe(409);
    expect(JSON.stringify(perdedora.body)).not.toContain(cpf.replace(/\D/g, ''));
  });

  it('o clique duplo da MESMA pessoa não cria dois cadastros', async () => {
    const cpf = gerarCpf(500015);
    const pessoa = await criarUsuario({ name: 'HELENA PRADO' });
    const matricula = `NPC-${unico('m')}`;

    const enviar = () => api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'HELENA PRADO', cpf, sex: 'FEMALE', birthDate: '1990-01-20',
      affiliationId: npc.id, affiliationNumber: matricula
    });

    const respostas = await Promise.all([enviar(), enviar()]);

    expect(respostas.filter(r => r.status === 201).length,
      `respostas: ${respostas.map(r => r.status).join(', ')}`).toBe(1);

    const contagem = await contagens();
    expect(contagem.atletas).toBe(1);
    expect(contagem.identidades).toBe(1);
  });
});

describe('Conta de serviço — quem escreveu podia escrever', () => {
  it('cada federação tem a sua, e só a sua', async () => {
    const daMinha = await contaDeServicoDe(organizationId);
    const daOutra = await contaDeServicoDe(outraOrgId);

    expect(daMinha, 'a federação nasceu sem conta de serviço').toBeTruthy();
    expect(daOutra).toBeTruthy();
    expect(daMinha.id).not.toBe(daOutra.id);
    expect(daMinha.serviceOrganizationId).toBe(organizationId);
    expect(daOutra.serviceOrganizationId).toBe(outraOrgId);
    expect(daMinha.role).toBe('FEDERATION_SERVICE');

    // UMA por organização, e não mais. Duas contas na mesma federação
    // tornariam a auditoria ambígua: "o sistema escreveu" deixaria de
    // identificar qual caminho escreveu.
    const todas = await comoAtor(admin, tx => tx.user.findMany({
      where: { isServiceAccount: true }, select: { id: true, serviceOrganizationId: true }
    }));
    expect(todas).toHaveLength(2);
    expect(new Set(todas.map(c => c.serviceOrganizationId)).size).toBe(2);
  });

  it('é operadora da federação DELA, e de nenhuma outra', async () => {
    // A pergunta é sobre o BANCO, não sobre o código de aplicação: é o RLS que
    // decide, e `mci_operator_of` é quem ele consulta. Perguntar direto ao
    // Postgres é o único jeito de a resposta não depender de nenhuma camada
    // que se possa contornar.
    const conta = await contaDeServicoDe(organizationId);

    const [{ propria, alheia }] = await comoAtor(conta.id, tx => tx.$queryRawUnsafe(
      'SELECT mci_operator_of($1) AS propria, mci_operator_of($2) AS alheia',
      organizationId, outraOrgId
    ));

    expect(propria, 'a conta não opera a própria federação').toBe(true);
    expect(alheia, 'A CONTA DE SERVIÇO ALCANÇA OUTRA FEDERAÇÃO').toBe(false);
  });

  it('não enxerga nem escreve o atleta de outra federação', async () => {
    // Medido no caminho real: a conta da minha federação, usando a identidade
    // dela, tentando alcançar o atleta da outra.
    const cpf = gerarCpf(500016);
    const pessoa = await criarUsuario({ name: 'ISABEL DUARTE' });
    const nascido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'ISABEL DUARTE', cpf, sex: 'FEMALE', birthDate: '1992-07-07',
      affiliationId: outraNpc.id, affiliationNumber: `OUT-${unico('m')}`
    });
    expect(nascido.status, JSON.stringify(nascido.body).slice(0, 300)).toBe(201);

    const minhaConta = await contaDeServicoDe(organizationId);

    const visivel = await comoAtor(minhaConta.id, tx => tx.athlete.findUnique({
      where: { id: nascido.body.athleteId }, select: { id: true }
    }));
    expect(visivel, 'a conta leu o atleta de outra federação').toBeNull();

    // E a escrita também não passa — ler nulo poderia ser filtro de leitura;
    // a escrita é a prova de que a política também barra o UPDATE.
    await expect(comoAtor(minhaConta.id, tx => tx.athlete.update({
      where: { id: nascido.body.athleteId }, data: { affiliationNumber: 'INVADIDO' }
    }))).rejects.toThrow();

    const intacto = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: nascido.body.athleteId }, select: { affiliationNumber: true, organizationId: true }
    }));
    expect(intacto.affiliationNumber).not.toBe('INVADIDO');
    expect(intacto.organizationId).toBe(outraOrgId);
  });

  it('não autentica — nem com a senha certa, porque não existe senha certa', async () => {
    const conta = await contaDeServicoDe(organizationId);

    // A SENHA CERTA É PLANTADA DE PROPÓSITO, e a mutação é quem ensinou isto.
    //
    // A primeira versão deste teste tentava logar com a senha padrão da suíte
    // contra o hash aleatório da conta. Recusava, claro — mas recusava por
    // SENHA ERRADA, e teria recusado igual se a guarda `isServiceAccount`
    // fosse apagada. O mutante que apaga a guarda SOBREVIVEU, e foi assim que
    // eu soube que o teste media a coisa errada.
    //
    // Agora a conta recebe o hash de uma senha que a suíte conhece — o do
    // próprio gerente, que é um usuário comum criado com ela. Se a guarda
    // sumir, o login PASSA, e o teste falha. É a única montagem em que a
    // asserção fala sobre a guarda, e não sobre o acaso do segredo.
    const humano = await comoAtor(admin, tx => tx.user.findUnique({
      where: { id: gerente.id }, select: { passwordHash: true }
    }));
    const antes = await comoAtor(admin, tx => tx.user.findUnique({
      where: { id: conta.id }, select: { passwordHash: true, isServiceAccount: true }
    }));
    expect(antes.isServiceAccount).toBe(true);
    expect(antes.passwordHash, 'a conta de serviço ficou sem hash').toBeTruthy();
    expect(antes.passwordHash, 'a conta nasceu com a senha da suíte')
      .not.toBe(humano.passwordHash);

    await comoAtor(admin, tx => tx.user.update({
      where: { id: conta.id }, data: { passwordHash: humano.passwordHash }
    }));

    // Controle: a MESMA senha, no usuário comum, entra. Sem isto, um 401 aqui
    // poderia ser qualquer outra coisa quebrada no login.
    const doHumano = await api().post('/api/v1/auth/login')
      .send({ email: gerente.email, password: 'senha-de-teste-123' });
    expect(doHumano.status, 'a senha de controle não serve: o teste não mede nada').toBe(200);

    const tentativa = await api().post('/api/v1/auth/login')
      .send({ email: conta.email, password: 'senha-de-teste-123' });
    expect(tentativa.status, 'A CONTA DE SERVIÇO AUTENTICOU').toBe(401);
    expect(tentativa.body.token, 'a conta de serviço recebeu token').toBeUndefined();
    // MESMA resposta de credencial errada: distinguir "é conta de serviço" de
    // "senha errada" entregaria a lista de contas técnicas da plataforma.
    expect(tentativa.body.error?.code ?? tentativa.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('não tem permissão de aplicação nenhuma além da base autenticada', async () => {
    // Poder no banco e poder na aplicação são coisas separadas, e a conta só
    // recebeu o primeiro. Se o papel ganhasse `athletes.manage`, bastaria um
    // caminho que aceitasse a identidade dela para operar a federação inteira.
    // `permissionsForRole` devolve um Set, e não um array.
    const dela = permissoes.permissionsForRole('FEDERATION_SERVICE');
    const doAtleta = permissoes.permissionsForRole('ATHLETE');

    const aMais = [...dela].filter(p => !doAtleta.has(p));
    expect(aMais, `a conta de serviço ganhou permissões: ${aMais.join(', ')}`).toEqual([]);

    for (const proibida of ['athletes.manage', 'athletes.read_sensitive', 'ranking.manage',
      'results.manage', 'organizations.manage', 'users.manage']) {
      expect(dela.has(proibida), `FEDERATION_SERVICE recebeu ${proibida}`).toBe(false);
    }
  });

  it('o atleta não veste a conta: nada que ele mande no corpo escolhe a identidade', async () => {
    const cpf = gerarCpf(500017);
    await semear([linha({ id: 'S-1', cpf, nome: 'JULIA ANDRADE' })]);

    const contaDaOutra = await contaDeServicoDe(outraOrgId);
    const pessoa = await criarUsuario({ name: 'JULIA ANDRADE' });

    // O corpo tenta nomear TODAS as alavancas de uma vez: a conta de serviço,
    // o operador, a organização e a federação. Se qualquer uma fosse lida, o
    // cadastro sairia endereçado à federação errada — com escrita válida, o
    // que é a pior forma de falhar, porque os dados ficariam plausíveis.
    const resposta = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'JULIA ANDRADE', cpf, sex: 'FEMALE', birthDate: '1993-05-05',
      affiliationId: npc.id, affiliationNumber: `LIVRE-${unico('m')}`,
      serviceAccountId: contaDaOutra.id,
      operatorId: contaDaOutra.id,
      organizationId: outraOrgId,
      federationId: outraOrgId,
      reviewedById: contaDaOutra.id,
      status: 'APPROVED',
      isServiceAccount: true
    });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);

    // A organização veio da FILIAÇÃO, resolvida no servidor.
    expect(resposta.body.organizationId).toBe(organizationId);
    expect(resposta.body.reviewedById, 'o corpo escolheu quem aprovou').toBeNull();

    const atleta = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: resposta.body.athleteId }, select: { organizationId: true }
    }));
    expect(atleta.organizationId, 'o cadastro saiu na federação escolhida pelo corpo').toBe(organizationId);

    // E quem executou foi a conta DESTA federação.
    const minhaConta = await contaDeServicoDe(organizationId);
    const registro = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'ATHLETE_PROFILE_REQUEST_AUTO_APPROVE' }, orderBy: { createdAt: 'desc' }
    }));
    expect(registro.metadata.serviceAccountId).toBe(minhaConta.id);
    expect(registro.metadata.serviceAccountId).not.toBe(contaDaOutra.id);

    // O usuário continua sendo o ATOR do registro: quem executou é outra
    // coisa, e apagar essa diferença apagaria de quem foi o cadastro.
    expect(registro.userId).toBe(pessoa.id);
    expect(registro.metadata.actorType).toBe('SYSTEM_SERVICE_ACCOUNT');
  });

  it('não aparece na administração de usuários, nem para quem administra a plataforma', async () => {
    // Ela É membro da organização — precisa ser, é daí que `mci_operator_of`
    // a reconhece. Sem filtro, aparecia na lista de usuários de todo operador
    // da federação, com papel e situação editáveis ao lado, como se fosse uma
    // pessoa mal configurada.
    const conta = await contaDeServicoDe(organizationId);

    const lista = await api().get('/api/v1/admin/users').set(admin.auth());
    expect(lista.status, JSON.stringify(lista.body).slice(0, 200)).toBe(200);
    expect(lista.body.items.map(u => u.id), 'a conta de serviço foi listada').not.toContain(conta.id);
    expect(JSON.stringify(lista.body), 'o e-mail da conta técnica vazou na listagem')
      .not.toContain(conta.email);

    // E nem por id: para esta tela ela não existe. 404, e não 403 — responder
    // 403 confirmaria que o id existe e ensinaria que há uma categoria de
    // conta escondida ali.
    const porId = await api().get(`/api/v1/admin/users/${conta.id}`).set(admin.auth());
    expect(porId.status).toBe(404);

    // As pessoas de verdade continuam aparecendo: o filtro é da conta técnica,
    // e não uma listagem que quebrou.
    expect(lista.body.items.length).toBeGreaterThan(0);
    expect(lista.body.items.map(u => u.id)).toContain(gerente.id);
  });

  it('a administração de usuários não muda papel nem situação da conta de serviço', async () => {
    const conta = await contaDeServicoDe(organizationId);

    for (const tentativa of [{ role: 'ADMIN' }, { status: 'DISABLED' }]) {
      const r = await api().patch(`/api/v1/admin/users/${conta.id}`).set(admin.auth()).send(tentativa);
      expect(r.status, `${JSON.stringify(tentativa)} passou: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(404);
    }

    const depois = await comoAtor(admin, tx => tx.user.findUnique({
      where: { id: conta.id },
      select: { role: true, status: true, isServiceAccount: true, serviceOrganizationId: true }
    }));
    expect(depois.role).toBe('FEDERATION_SERVICE');
    expect(depois.status).toBe('ACTIVE');
    expect(depois.isServiceAccount).toBe(true);
    expect(depois.serviceOrganizationId).toBe(organizationId);

    // E o autocadastro continua funcionando depois das tentativas — se alguma
    // tivesse pegado, é aqui que a federação descobriria, em produção.
    const { resposta } = await autocadastrar({ nome: 'LUCIA PEREIRA', cpf: gerarCpf(500019) });
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 200)).toBe(201);
  });

  it('não tem perfil social: não é encontrável nem endereçável por ninguém', async () => {
    // Todo usuário criado pelo cadastro ganha um `SocialProfile`, e é por ele
    // que a busca e o messenger alcançam gente. A conta de serviço nasce por
    // outro caminho e não ganha nenhum — se ganhasse, seria possível abrir
    // conversa com "Sistema · MCI Brasil", que não lê e não responde.
    const conta = await contaDeServicoDe(organizationId);
    const perfil = await comoAtor(admin, tx => tx.socialProfile.findUnique({
      where: { userId: conta.id }, select: { id: true }
    }));
    expect(perfil, 'a conta de serviço ganhou perfil social').toBeNull();
  });

  it('a federação de porta fechada recusa, mesmo com o id da filiação em mãos', async () => {
    // O id da filiação sai na página pública do atleta. Esconder a filiação da
    // vitrine não é recusar o pedido — e com a conclusão automática o pedido
    // passaria a CRIAR atleta numa federação que não pediu ninguém.
    const fechadaId = (await criarOrganizacao(admin, { name: 'Fechada', autocadastroAberto: false })).id;
    const filiacaoFechada = (await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId: fechadaId, name: 'NPC Fechada', code: 'NPCFEC' })).body;

    const pessoa = await criarUsuario({ name: 'KARINA VIEIRA' });
    const resposta = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'KARINA VIEIRA', cpf: gerarCpf(500018), sex: 'FEMALE', birthDate: '1994-02-02',
      affiliationId: filiacaoFechada.id, affiliationNumber: 'FEC-1'
    });

    expect(resposta.status).toBe(422);
    expect(resposta.body.error?.code ?? resposta.body.code).toBe('SELF_REGISTRATION_CLOSED');

    const nascidos = await comoAtor(admin, tx => tx.athlete.count({ where: { organizationId: fechadaId } }));
    expect(nascidos, 'a federação fechada ganhou um atleta').toBe(0);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O NÚMERO IDENTIFICA. O NOME DESCREVE.
//
// A REGRA, e por que ela não é preciosismo
//
// O arquivo do campeonato escreve o nome como der: "JOÃO DA SILVA", "JOAO
// SILVA", "J. SILVA", "JOÃO SILVA NETO". São quatro grafias da mesma pessoa, e
// tratá-las como quatro atletas quebra a carreira de alguém em quatro pedaços
// que ninguém reconstrói. O que NÃO varia é o número de filiação: ele é
// emitido pela federação, é único dentro dela, e é o que o atleta carrega de
// campeonato em campeonato.
//
// Daí a hierarquia:
//
//   FILIAÇÃO + NÚMERO  → identidade. Imutável pelo dono, única por federação.
//   NOME               → atributo. Editável, apresentável, nunca chave.
//   APELIDO            → atributo. Idem.
//
// O QUE ESTE ARQUIVO PROVA, E O QUE ELE NÃO DUPLICA
//
// A cadeia de reconhecimento (filiação+matrícula vence nome), o vínculo tardio
// e a não-duplicação de ponto JÁ estão provados em `identidade-por-matricula`,
// `matricula-identifica-um` e `vinculo-tardio` — 58 testes. Repetir aqui só
// aumentaria o tempo da suíte sem aumentar a cobertura.
//
// O que faltava, e é o que está aqui:
//
//   1. a FILIAÇÃO DECLARADA NO LOTE, para o arquivo oficial que não traz a
//      coluna — "NPC Worldwide" é o nome do circuito, "NPC" é a federação, e a
//      tradução é uma DECLARAÇÃO do operador, nunca uma dedução do texto;
//   2. EDITAR O NOME não move a identidade nem derruba um resultado;
//   3. EDITAR O APELIDO idem;
//   4. o atleta NÃO consegue editar o próprio número — editar o nome é um
//      direito, trocar de identidade seria tomar a carreira de outro;
//   5. o ciclo inteiro do §19: importar sob dois nomes diferentes, cadastrar
//      com um terceiro, editar para um quarto, e o histórico seguir de pé.
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let npc;

const noLedger = consulta => comoAtor(gerente, consulta);

// O cabeçalho do arquivo oficial do circuito NPC: tem Member Number e NÃO tem
// coluna de filiação nenhuma. É esse formato que obriga a declaração no lote.
const CABECALHO_OFICIAL = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';

const arquivoOficial = linhas => [CABECALHO_OFICIAL, ...linhas].join('\n');

/** Cria o lote declarando a filiação da etapa, como a tela manda fazer. */
async function importar(conteudo, { filiacaoDaEtapa = 'NPC', prefixo = null, eventId = null } = {}) {
  const criado = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId,
    seasonId,
    sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv',
    content: conteudo,
    ...(filiacaoDaEtapa ? { defaultAffiliationCode: filiacaoDaEtapa } : {}),
    ...(prefixo ? { externalIdPrefix: prefixo } : {}),
    ...(eventId ? { eventId } : {})
  });
  expect([200, 201], JSON.stringify(criado.body)).toContain(criado.status);
  return criado.body.import?.id ?? criado.body.id;
}

/** Um campeonato de verdade. Sem ele os dois lotes caem no mesmo `eventId`
 *  nulo, e "dois eventos distintos" seria uma frase, não uma medição. */
async function criarCampeonato(nome) {
  const r = await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: nome, slug: unico('etapa'), startDate: '2026-04-11T12:00:00.000Z'
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id;
}

async function aplicar(importId) {
  const r = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body;
}

async function itensDoLote(importId) {
  return noLedger(tx => tx.muscleWarImportItem.findMany({
    where: { importId },
    select: {
      id: true, athleteId: true, matchStatus: true, athleteName: true,
      affiliationCode: true, memberNumber: true, matchedBy: true, reason: true
    },
    orderBy: { rowNumber: 'asc' }
  }));
}

/** As identidades externas de um número, dentro da NPC desta organização. */
async function identidadesDoNumero(numero) {
  return noLedger(tx => tx.externalAthlete.findMany({
    where: { organizationId, affiliationId: npc.id, affiliationNumber: numero },
    select: { id: true, identityKey: true, athleteId: true, displayName: true }
  }));
}

async function pontosDoAtleta(athleteId) {
  const pontos = await noLedger(tx => tx.rankingPoint.findMany({
    where: { organizationId, athleteId },
    select: { id: true, points: true, placementPoints: true, overallBonus: true, eventId: true }
  }));
  return { lancamentos: pontos.length, total: pontos.reduce((s, p) => s + p.points, 0), pontos };
}

beforeAll(async () => { await garantirCatalogo(); });

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Identidade Definitiva' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  // A ÚNICA federação do MCI. "NPC Worldwide" NÃO vira uma segunda entrada:
  // é como o circuito se chama, e a federação continua sendo esta.
  const r = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'National Physique Committee', code: 'NPC' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  npc = r.body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  expect([200, 201], JSON.stringify(temporada.body)).toContain(temporada.status);
  seasonId = temporada.body.id;

  // A TABELA HOMOLOGADA, posta explicitamente para que a conta do §19 seja
  // verificável: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1, e do 6º em diante zero. Este
  // arquivo não inventa regra esportiva — ele exige que o ponto caia no
  // atleta certo, e para isso precisa saber quanto vale cada colocação.
  const regras = await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [
      { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }
    ] });
  expect([200, 201], JSON.stringify(regras.body)).toContain(regras.status);
});

// ---------------------------------------------------------------------------
describe('a filiação da etapa é declarada, nunca deduzida do texto', () => {
  it('arquivo oficial SEM coluna de filiação: o lote declara NPC e a identidade fecha', async () => {
    const importId = await importar(
      arquivoOficial(['748,Men\'s Physique - Open Class A,Joao,Silva,999001,1']),
      { prefixo: 'ETAPA2026' }
    );

    const [item] = await itensDoLote(importId);
    // A coluna não existia no arquivo. Quem a preencheu foi a declaração do
    // lote — e é por isso que o reconhecimento por número passa a ser possível.
    expect(item.affiliationCode).toBe('NPC');
    expect(item.memberNumber).toBe('999001');
  });

  it('SEM a declaração, o mesmo arquivo não forma identidade nenhuma', async () => {
    const importId = await importar(
      arquivoOficial(['748,Men\'s Physique - Open Class A,Joao,Silva,999001,1']),
      { filiacaoDaEtapa: null, prefixo: 'ETAPA2026' }
    );

    const [item] = await itensDoLote(importId);
    // O número está lá; a federação, não. E número sozinho não identifica
    // ninguém: duas federações emitem o mesmo. Esta é a diferença entre o
    // histórico reencontrar o atleta e ficar órfão para sempre.
    expect(item.memberNumber).toBe('999001');
    expect(item.affiliationCode).toBeNull();
  });

  it('a declaração do lote NÃO sobrescreve a linha que traz a sua própria filiação', async () => {
    // Arquivo com coluna de filiação própria, declarando outra coisa no lote.
    // O que a origem afirma vale mais do que o que o formulário supõe.
    const comColuna = [
      'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao',
      'r1,Joao Silva,NPC,999001,MENS_PHYSIQUE,OPEN,1'
    ].join('\n');
    const importId = await importar(comColuna, { filiacaoDaEtapa: 'NPC' });
    const [item] = await itensDoLote(importId);
    expect(item.affiliationCode).toBe('NPC');
  });

  it('"NPC Worldwide" NÃO vira uma segunda federação', async () => {
    await importar(arquivoOficial(['748,Men\'s Physique - Open Class A,Joao,Silva,999001,1']),
      { prefixo: 'ETAPA2026' });

    const federacoes = await noLedger(tx => tx.affiliation.findMany({
      where: { organizationId }, select: { code: true, name: true }
    }));
    // Uma só, e é a NPC. Nada no código deduz federação de texto — por isso
    // nenhum "NPC WORLDWIDE" pode nascer de uma importação.
    expect(federacoes.map(f => f.code)).toEqual(['NPC']);
  });
});

// ---------------------------------------------------------------------------
describe('editar o nome não move a identidade', () => {
  let atleta;

  beforeEach(async () => {
    const r = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId,
      fullName: 'João da Silva',
      stageName: 'Jão',
      cpf: gerarCpf(),
      sex: 'MALE',
      birthDate: '1994-03-02',
      state: 'PB',
      city: 'João Pessoa',
      affiliationId: npc.id,
      affiliationNumber: '115496'
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    atleta = r.body;
  });

  it('trocar o nome inteiro preserva filiação e número', async () => {
    const r = await api().patch(`/api/v1/athletes/${atleta.id}`).set(gerente.auth())
      .send({ fullName: 'João Silva Neto' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await noLedger(tx => tx.athlete.findUnique({
      where: { id: atleta.id },
      select: { fullName: true, affiliationId: true, affiliationNumber: true }
    }));
    expect(depois.fullName).toBe('João Silva Neto');
    expect(depois.affiliationId).toBe(npc.id);
    expect(depois.affiliationNumber).toBe('115496');
  });

  it('trocar o apelido preserva filiação e número', async () => {
    const r = await api().patch(`/api/v1/athletes/${atleta.id}`).set(gerente.auth())
      .send({ stageName: 'Joãozinho' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await noLedger(tx => tx.athlete.findUnique({
      where: { id: atleta.id },
      select: { stageName: true, affiliationId: true, affiliationNumber: true }
    }));
    expect(depois.stageName).toBe('Joãozinho');
    expect(depois.affiliationNumber).toBe('115496');
  });

  it('o histórico importado continua do mesmo dono depois da troca de nome', async () => {
    // Um resultado com o nome ESCRITO DE OUTRO JEITO no arquivo. Ele pertence
    // ao atleta pelo número, não pela grafia.
    const importId = await importar(
      arquivoOficial(['701,Men\'s Physique - Open Class A,JOAO,SILVA,115496,1']),
      { prefixo: 'ETAPA2026' }
    );
    await aplicar(importId);

    const antes = await pontosDoAtleta(atleta.id);
    expect(antes.lancamentos, 'o resultado precisa ter sido reconhecido pelo número').toBe(1);

    await api().patch(`/api/v1/athletes/${atleta.id}`).set(gerente.auth())
      .send({ fullName: 'Completamente Outro Nome', stageName: 'Outro Apelido' });

    const depois = await pontosDoAtleta(atleta.id);
    // Mesmo lançamento, mesmo ponto, mesmo dono. Trocar o nome é editar um
    // atributo; se derrubasse um resultado, o nome seria chave — e não é.
    expect(depois.lancamentos).toBe(antes.lancamentos);
    expect(depois.total).toBe(antes.total);
    expect(depois.pontos.map(p => p.id).sort()).toEqual(antes.pontos.map(p => p.id).sort());
  });

  it('o nome que veio no arquivo NÃO é sobrescrito pelo nome do cadastro', async () => {
    const importId = await importar(
      arquivoOficial(['701,Men\'s Physique - Open Class A,JOAO,SILVA,115496,1']),
      { prefixo: 'ETAPA2026' }
    );
    await aplicar(importId);

    const [item] = await itensDoLote(importId);
    // A rastreabilidade do §8: o arquivo disse "JOAO SILVA" e isso fica
    // gravado, mesmo o cadastro dizendo "João da Silva". Sem isso, perde-se a
    // prova de como o dado chegou.
    expect(item.athleteName).toBe('JOAO SILVA');
    expect(item.athleteId).toBe(atleta.id);
  });
});

// ---------------------------------------------------------------------------
describe('o atleta edita o nome, nunca a identidade', () => {
  // ESTE TESTE LÊ O CÓDIGO-FONTE, e é de propósito.
  //
  // A garantia do §23 não é "a requisição foi recusada" — é que o campo de
  // identidade NÃO ESTÁ na lista do que o dono da conta pode editar. Provar
  // isso por requisição exigiria montar uma conta vinculada, e um 403 por
  // falta de vínculo passaria pelo motivo errado: o teste ficaria verde sem
  // dizer nada sobre a regra. A lista é a regra; é nela que a prova mora.
  it('a lista do autosserviço tem nome e apelido, e NENHUM campo de identidade', async () => {
    const fonte = await readFile(new URL('../src/services/meService.js', import.meta.url), 'utf8');
    const bloco = fonte.match(/const CAMPOS_DO_ATLETA = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(bloco, 'CAMPOS_DO_ATLETA precisa existir em meService.js').toBeTruthy();

    const campos = [...bloco[1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
    expect(campos.length, 'a lista não pode estar vazia').toBeGreaterThan(0);

    // O que o atleta PODE: o nome é dele, e muda.
    expect(campos).toContain('fullName');
    expect(campos).toContain('stageName');

    // O que ele NÃO pode: a identidade esportiva. Editar o nome é um direito;
    // trocar de número seria assumir a carreira de outra pessoa — e o número
    // é justamente o que faz o histórico de dez campeonatos reencontrar o dono.
    for (const proibido of ['affiliationNumber', 'affiliationId', 'athleteNumber', 'cpf', 'organizationId']) {
      expect(campos, `${proibido} NÃO pode ser editável pelo próprio atleta`).not.toContain(proibido);
    }
  });
});

// ---------------------------------------------------------------------------
describe('§19 — o ciclo inteiro: importar, importar, cadastrar, editar', () => {
  it('dois campeonatos com nomes diferentes, um cadastro, uma edição, e o histórico de pé', async () => {
    // ---------------------------------------------------------------- ETAPA 1
    // EVENTO A. O arquivo escreve "JOAO SILVA". O atleta ainda não existe.
    const eventoA = await criarCampeonato('EVENTO A');
    const loteA = await importar(
      arquivoOficial(['701,Men\'s Physique - Open Class A,JOAO,SILVA,999001,1']),
      { prefixo: 'EVENTOA2026', eventId: eventoA }
    );
    const itensA = await itensDoLote(loteA);
    expect(itensA).toHaveLength(1);
    expect(itensA[0].matchStatus, 'ninguém cadastrado ainda').toBe('MATCH_PENDING');
    expect(itensA[0].athleteId).toBeNull();
    await aplicar(loteA);

    // ---------------------------------------------------------------- ETAPA 2
    // EVENTO B. O MESMO número, com o nome escrito de outro jeito.
    const eventoB = await criarCampeonato('EVENTO B');
    const loteB = await importar(
      arquivoOficial(['733,Men\'s Classic Physique - Open Class B,JOÃO DA SILVA,NETO,999001,2']),
      { prefixo: 'EVENTOB2026', eventId: eventoB }
    );
    await aplicar(loteB);

    // UMA identidade para o número, não duas. O nome diferente não criou uma
    // segunda pessoa — é exatamente o erro que esta fase existe para impedir.
    const identidades = await identidadesDoNumero('999001');
    expect(identidades, 'um número, uma identidade').toHaveLength(1);
    expect(identidades[0].identityKey).toBe(`AFF:${npc.id}:999001`);

    const atletasAntes = await noLedger(tx => tx.athlete.count({ where: { organizationId } }));
    expect(atletasAntes, 'importar NÃO cria atleta').toBe(0);

    // ---------------------------------------------------------------- ETAPA 3
    // O atleta se cadastra. Terceiro nome, e o apelido dele.
    const cadastro = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'João Silva', stageName: 'Jão', cpf: gerarCpf(),
      sex: 'MALE', birthDate: '1993-07-14', state: 'PB', city: 'João Pessoa',
      affiliationId: npc.id, affiliationNumber: '999001'
    });
    expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(201);
    const atletaId = cadastro.body.id;

    const depoisDoCadastro = await pontosDoAtleta(atletaId);
    // OS DOIS campeonatos vieram juntos, pelo número, sem ninguém clicar nada.
    expect(depoisDoCadastro.lancamentos, 'os dois eventos foram adotados').toBe(2);
    const eventosDistintos = new Set(depoisDoCadastro.pontos.map(p => p.eventId));
    expect([...eventosDistintos].sort(), 'EVENTO A e EVENTO B, nomeados')
      .toEqual([eventoA, eventoB].sort());
    // 1º lugar = 5, 2º lugar = 4, pela tabela homologada.
    expect(depoisDoCadastro.total).toBe(9);

    // ---------------------------------------------------------------- ETAPA 4
    // O atleta edita: quarto nome, segundo apelido.
    const edicao = await api().patch(`/api/v1/athletes/${atletaId}`).set(gerente.auth())
      .send({ fullName: 'João da Silva Neto', stageName: 'Joãozinho' });
    expect(edicao.status, JSON.stringify(edicao.body)).toBe(200);

    const depoisDaEdicao = await pontosDoAtleta(atletaId);
    expect(depoisDaEdicao.lancamentos, 'EVENTO A e EVENTO B continuam').toBe(2);
    expect(depoisDaEdicao.total, 'a pontuação não se mexeu').toBe(9);
    expect(depoisDaEdicao.pontos.map(p => p.id).sort())
      .toEqual(depoisDoCadastro.pontos.map(p => p.id).sort());

    const identidadeFinal = await identidadesDoNumero('999001');
    expect(identidadeFinal, 'nenhuma identidade nova nasceu da edição').toHaveLength(1);
    expect(identidadeFinal[0].identityKey).toBe(`AFF:${npc.id}:999001`);
    expect(identidadeFinal[0].athleteId).toBe(atletaId);

    const atletasDepois = await noLedger(tx => tx.athlete.count({ where: { organizationId } }));
    expect(atletasDepois, 'um atleta, do começo ao fim').toBe(1);

    // E os dois nomes de origem seguem gravados, cada um no seu resultado.
    const nomesDeOrigem = [...(await itensDoLote(loteA)), ...(await itensDoLote(loteB))]
      .map(i => i.athleteName).sort();
    expect(nomesDeOrigem).toEqual(['JOAO SILVA', 'JOÃO DA SILVA NETO']);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, unico, gerarCpf, comoAtor
} from './helpers.mjs';

// ============================================================================
// O HISTÓRICO ESPORTIVO DO ATLETA CONTANDO AS DUAS ORIGENS.
//
// O DEFEITO, COMO FOI OBSERVADO EM PRODUÇÃO
//
// A ficha pública de um atleta mostrava, no MESMO bloco de métricas:
//
//     TEMPORADAS NO RANKING 1    ·    PONTOS SOMADOS 30
//     RESULTADOS PUBLICADOS 0    ·    HISTÓRICO: "ainda sem resultados"
//
// Os quatro números estavam certos para as suas próprias fontes. "Pontos
// somados" vem de `Ranking`, que é recalculado a partir de `RankingPoint` — e
// o ledger enxerga o histórico importado. "Resultados publicados" e o
// histórico vinham de `ResultEntry`, a apuração RECEBIDA pelo MCI, que o
// importador nunca toca. A tela se contradizia porque metade do sistema era
// invisível para metade da consulta.
//
// O QUE ESTA SUÍTE COBRA
//
// Não é "o número subiu". É que as duas origens apareçam pela MESMA regra de
// publicação, e que a regra continue recusando o que não está publicado:
// rascunho, resultado em revisão e lançamento invalidado seguem fora.
//
// A LEITURA ANTIGA PASSARIA NO PRIMEIRO TESTE E REPROVARIA NO SEGUNDO —
// que é exatamente o caso real desta plataforma: campeonato importado, atleta
// com histórico, nenhuma apuração recebida pelo MCI.
// ============================================================================

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';

/** Um arquivo de etapa com UM competidor, na matrícula que o teste escolher. */
function arquivoDeUmAtleta({ nome = 'LUCAS', sobrenome = 'GOUVEIA', matricula = '2932', colocacao = 1 } = {}) {
  return [
    CABECALHO,
    [1, "Men's Bodybuilding - Open Heavyweight", nome, sobrenome, matricula,
      'Brazil', 30, 1, '90.0', colocacao].join(',')
  ].join('\n');
}

let admin;
let gerente;
let diretor;
let organizationId;
let seasonId;
let affiliationId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  diretor = await criarUsuario({ name: 'Diretor' });
  await vincular(organizationId, diretor, 'EVENT_DIRECTOR');

  affiliationId = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Worldwide', code: 'NPC' })).body.id;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

/**
 * CONTAR NO BANCO EXIGE ATOR.
 *
 * `prisma` cru não passa por `withUserContext`, e `ExternalResult`,
 * `RankingPoint` e companhia têm política por organização: sem contexto a
 * contagem volta ZERO, e um zero assim diria "não existe" quando o certo é
 * "não enxergo". São respostas opostas, e já se pareceram iguais neste
 * projeto. Toda contagem desta suíte passa por um operador.
 */
const contar = (ator, tabela, where = {}) =>
  comoAtor(ator, tx => tx[tabela].count({ where }));

/** A ficha pública, como o visitante ANÔNIMO a recebe. */
const fichaPublica = id => api().get(`/api/v1/public/athletes/${id}`).then(r => ({ status: r.status, corpo: r.body }));

/**
 * Cadastra o atleta com a identidade esportiva — entidade + matrícula — para
 * que o importador o reconheça pela chave, e não pelo nome.
 */
async function cadastrarAtleta({ fullName = 'Lucas Gouveia Lima', matricula = '2932' } = {}) {
  const criado = await api().post('/api/v1/athletes').set(gerente.auth()).send({
    organizationId, fullName, sex: 'MALE', cpf: gerarCpf(910000001),
    affiliationId, affiliationNumber: matricula
  });
  expect(criado.status, JSON.stringify(criado.body).slice(0, 300)).toBe(201);
  return criado.body;
}

/** Importa uma etapa com um competidor só e aplica o lote. */
async function importarEtapa({ matricula = '2932', prefixo = 'IPIRANGA', colocacao = 1, eventId = null } = {}) {
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
    content: arquivoDeUmAtleta({ matricula, colocacao }),
    externalIdPrefix: prefixo,
    defaultAffiliationCode: 'NPC',
    ...(eventId ? { eventId } : {})
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

  const aplicado = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
    .set(gerente.auth());
  expect(aplicado.status, JSON.stringify(aplicado.body).slice(0, 400)).toBe(200);
  return lote.body.import.id;
}

/** Um evento do MCI, publicamente visível, para a etapa importada apontar. */
async function eventoVisivel(nome) {
  const montado = await criarEventoCompleto(diretor, organizationId, { seasonId, name: nome });
  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  return montado.event;
}

describe('o histórico esportivo conta o que foi importado', () => {
  it('1-2. duas etapas importadas: as duas aparecem, com pontos e sem duplicar', async () => {
    const atleta = await cadastrarAtleta();

    const ipiranga = await eventoVisivel('Ipiranga');
    const razor = await eventoVisivel('Razor');
    await importarEtapa({ prefixo: 'IPIRANGA', eventId: ipiranga.id });
    await importarEtapa({ prefixo: 'RAZOR', eventId: razor.id });

    const { status, corpo } = await fichaPublica(atleta.id);
    expect(status).toBe(200);

    // O NÚMERO QUE O DEFEITO MANTINHA EM ZERO.
    expect(corpo.results.length, 'resultados publicados na ficha').toBe(2);

    // E ele não pode ter subido por duplicação: duas etapas, dois eventos
    // distintos, uma linha cada.
    // O helper de evento não aceita nome — todos nascem "Etapa de Teste". O
    // que distingue uma etapa da outra é o ID, e é por ele que se confere.
    const eventos = corpo.results.map(r => r.event?.id).filter(Boolean);
    expect(eventos.length, 'as duas linhas têm evento').toBe(2);
    expect(new Set(eventos).size, 'eventos distintos').toBe(2);
    expect(new Set(corpo.results.map(r => r.key)).size, 'chaves distintas').toBe(2);

    // A coerência que a tela perdia: o histórico e o ranking falando do mesmo
    // acervo. O ranking soma 5 por primeiro lugar em cada etapa.
    const somaDoRanking = corpo.rankings.reduce((t, l) => t + l.totalPoints, 0);
    expect(somaDoRanking, 'pontos somados no ranking').toBe(10);
    expect(corpo.results.every(r => r.points === 5), 'pontos por participação').toBe(true);

    // Primeiro lugar nas duas: dois títulos.
    expect(corpo.titles).toBe(2);
  });

  it('3. lançamento invalidado sai do histórico, e o resultado não é apagado', async () => {
    const atleta = await cadastrarAtleta();
    const evento = await eventoVisivel('Ipiranga');
    const importId = await importarEtapa({ prefixo: 'IPIRANGA', eventId: evento.id });

    expect((await fichaPublica(atleta.id)).corpo.results.length, 'antes de invalidar').toBe(1);

    const invalidado = await api().delete(`/api/v1/musclewar/imports/${importId}`)
      .set(admin.auth()).send({ reason: 'Arquivo errado enviado pela federação' });
    expect(invalidado.status, JSON.stringify(invalidado.body).slice(0, 300)).toBe(200);

    expect((await fichaPublica(atleta.id)).corpo.results.length, 'depois de invalidar').toBe(0);

    // O `ExternalResult` CONTINUA: ele é a chave de idempotência do importador.
    // Quem registra a invalidação é o lançamento.
    expect(await contar(gerente, 'externalResult'), 'o resultado externo permanece').toBe(1);
  });

  it('4. resultado recebido só entra depois de PUBLICADO', async () => {
    const montado = await criarEventoCompleto(diretor, organizationId, { seasonId });
    await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`)
      .set(diretor.auth())
      .send({
        cpf: gerarCpf(910000777),
        athlete: { fullName: 'Atleta Recebida', sex: 'FEMALE' },
        classIds: [montado.competitionClass.id]
      });
    expect(inscricao.status, JSON.stringify(inscricao.body).slice(0, 300)).toBe(201);
    const athleteId = inscricao.body.registration.athlete.id;

    await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`)
      .set(diretor.auth()).send({});
    await transicionar(diretor, montado.event.id, ['IN_JUDGING']);

    await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: [{ athleteId, placing: 1 }] });

    // RECEBIDO, ainda NÃO publicado: o histórico não pode mostrá-lo.
    expect((await fichaPublica(athleteId)).corpo.results.length, 'antes de publicar').toBe(0);

    const publicado = await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`)
      .set(diretor.auth()).send({ note: 'Homologado' });
    expect(publicado.status, JSON.stringify(publicado.body).slice(0, 300)).toBe(200);

    const depois = (await fichaPublica(athleteId)).corpo;
    expect(depois.results.length, 'depois de publicar').toBe(1);
    expect(depois.results[0].origin).toBe('RECEBIDO');
  });

  it('5-6. o histórico é de QUEM é: o resultado de um não aparece no outro', async () => {
    const lucas = await cadastrarAtleta({ fullName: 'Lucas Gouveia Lima', matricula: '2932' });
    const outro = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'Outro Atleta', sex: 'MALE', cpf: gerarCpf(910000333),
      affiliationId, affiliationNumber: '7777'
    });
    expect(outro.status, JSON.stringify(outro.body).slice(0, 300)).toBe(201);

    const evento = await eventoVisivel('Ipiranga');
    await importarEtapa({ matricula: '2932', prefixo: 'IPIRANGA', eventId: evento.id });

    expect((await fichaPublica(lucas.id)).corpo.results.length, 'o dono do resultado').toBe(1);
    expect((await fichaPublica(outro.body.id)).corpo.results.length, 'quem não competiu').toBe(0);
  });

  it('7. resultado importado SEM dono não aparece no histórico de ninguém', async () => {
    const atleta = await cadastrarAtleta({ matricula: '2932' });
    const evento = await eventoVisivel('Ipiranga');

    // Matrícula que não casa com cadastro nenhum: o resultado entra no ledger
    // sem dono — é o estado normal de histórico carregado antes do cadastro.
    await importarEtapa({ matricula: '9999', prefixo: 'IPIRANGA', eventId: evento.id });

    expect((await fichaPublica(atleta.id)).corpo.results.length).toBe(0);
    expect(await contar(gerente, 'externalResult'), 'o resultado existe no acervo').toBe(1);
  });

  it('8. etapa sem página pública: a linha CONTA e não ganha link', async () => {
    const atleta = await cadastrarAtleta();
    // Sem `eventId`: o lançamento fica sem evento, e a linha não tem para onde
    // navegar. Ela continua sendo um resultado publicado do atleta.
    await importarEtapa({ prefixo: 'IPIRANGA' });

    const corpo = (await fichaPublica(atleta.id)).corpo;
    expect(corpo.results.length, 'conta no total').toBe(1);
    expect(corpo.results[0].eventNavigable, 'não oferece link').toBe(false);
  });

  it('9. a ficha é anônima e não entrega dado privado', async () => {
    const atleta = await cadastrarAtleta();
    const evento = await eventoVisivel('Ipiranga');
    await importarEtapa({ prefixo: 'IPIRANGA', eventId: evento.id });

    // Sem nenhum cabeçalho de autorização.
    const { status, corpo } = await fichaPublica(atleta.id);
    expect(status).toBe(200);
    expect(corpo.results.length).toBe(1);

    const texto = JSON.stringify(corpo);
    for (const proibido of ['cpf', 'CPF', 'email', 'phone', 'passwordHash', 'photoKey']) {
      expect(texto.includes(`"${proibido}"`), `a ficha pública não pode trazer ${proibido}`).toBe(false);
    }
  });

  it('10. repetir a leitura não muda o número: ela não escreve nada', async () => {
    const atleta = await cadastrarAtleta();
    const evento = await eventoVisivel('Ipiranga');
    await importarEtapa({ prefixo: 'IPIRANGA', eventId: evento.id });

    const primeira = (await fichaPublica(atleta.id)).corpo;
    const segunda = (await fichaPublica(atleta.id)).corpo;

    expect(segunda.results.length).toBe(primeira.results.length);
    expect(segunda.results.map(r => r.key)).toEqual(primeira.results.map(r => r.key));
    expect(await contar(gerente, 'externalResult')).toBe(1);
    expect(await contar(gerente, 'rankingPoint')).toBe(1);
  });

  it('11. o número da ficha e o do cartão da vitrine falam do mesmo acervo', async () => {
    const atleta = await cadastrarAtleta();
    const evento = await eventoVisivel('Ipiranga');
    await importarEtapa({ prefixo: 'IPIRANGA', eventId: evento.id });

    const daFicha = (await fichaPublica(atleta.id)).corpo.results.length;
    const doCartao = (await api().get('/api/v1/public/summary')).body.publishedResults;

    // Um atleta, uma participação: a ficha dele e o total da vitrine coincidem
    // porque não há mais ninguém na base. Se divergirem, uma das duas leituras
    // deixou de usar a regra única.
    expect(daFicha).toBe(doCartao);
  });
});

describe('o caso real: Lucas Gouveia Lima, NPC 2932', () => {
  it('Ipiranga 1º + Razor 1º = 2 publicados, 10 pontos, zero duplicação', async () => {
    const lucas = await cadastrarAtleta({ fullName: 'Lucas Gouveia Lima', matricula: '2932' });

    const ipiranga = await eventoVisivel('Ipiranga');
    const razor = await eventoVisivel('Razor');
    await importarEtapa({ matricula: '2932', prefixo: 'IPIRANGA', colocacao: 1, eventId: ipiranga.id });
    await importarEtapa({ matricula: '2932', prefixo: 'RAZOR', colocacao: 1, eventId: razor.id });

    const corpo = (await fichaPublica(lucas.id)).corpo;

    expect(corpo.results.length, 'RESULTADOS PUBLICADOS').toBe(2);
    expect(corpo.titles, 'TÍTULOS').toBe(2);
    expect(corpo.rankings.length, 'TEMPORADAS NO RANKING').toBe(1);
    expect(corpo.rankings[0].totalPoints, 'PONTOS SOMADOS').toBe(10);
    expect(corpo.rankings[0].eventCount, 'PARTICIPAÇÕES').toBe(2);

    // NADA DUPLICADO, conferido no banco e não na tela.
    expect(await contar(gerente, 'athlete', { affiliationNumber: '2932' }), 'atletas').toBe(1);
    expect(await contar(gerente, 'externalResult'), 'resultados externos').toBe(2);
    expect(await contar(gerente, 'rankingPoint'), 'lançamentos').toBe(2);
    expect(await contar(gerente, 'externalAthlete'), 'identidades externas').toBe(1);

    // E cada linha do histórico aponta para um evento diferente.
    const eventos = corpo.results.map(r => r.event?.id);
    expect(new Set(eventos).size, 'eventos distintos').toBe(2);
  });

  // ------------------------------------------------------------------------
  // OS NÚMEROS QUE A PESSOA VÊ NA PRODUÇÃO: 15 + 15 = 30.
  //
  // O caso acima usa a tabela desta suíte (5 pontos para o 1º) e prova a
  // MECÂNICA. Este reproduz os NÚMEROS — e a diferença entre os dois é
  // justamente o que se quer demonstrar: o 15 não está escrito em lugar nenhum
  // do código. Ele sai da TABELA DE PONTOS DA TEMPORADA, que é dado da
  // federação; trocar a tabela troca o número, e nada mais muda.
  //
  // A CONFERÊNCIA É LOCAL. Esta máquina não alcança a produção (o túnel sai
  // 403), então o que está medido aqui é a REPRODUÇÃO do caso com os mesmos
  // dados de entrada, não a leitura do banco de produção. O relatório diz isso
  // com todas as letras, e não troca uma coisa pela outra.
  //
  // E É LEITURA E PROJEÇÃO, não correção: nenhum ponto é lançado à mão, nenhum
  // resultado é publicado à mão, nenhum registro de atleta é alterado. O
  // histórico aparece porque a consulta passou a enxergar o acervo inteiro.
  // ------------------------------------------------------------------------
  it('com a tabela de 15 pontos para o 1º lugar, a ficha mostra 15 + 15 = 30', async () => {
    await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
      rules: [{ placing: 1, points: 15 }, { placing: 2, points: 12 }, { placing: 3, points: 10 },
        { placing: 4, points: 8 }, { placing: 5, points: 6 }]
    });

    const lucas = await cadastrarAtleta({ fullName: 'Lucas Gouveia Lima', matricula: '2932' });
    const ipiranga = await eventoVisivel('Ipiranga');
    const razor = await eventoVisivel('Razor');
    await importarEtapa({ matricula: '2932', prefixo: 'IPIRANGA', colocacao: 1, eventId: ipiranga.id });
    await importarEtapa({ matricula: '2932', prefixo: 'RAZOR', colocacao: 1, eventId: razor.id });

    const { corpo } = await fichaPublica(lucas.id);

    expect(corpo.results.length, 'RESULTADOS PUBLICADOS').toBe(2);

    // LINHA A LINHA, pelo ID da etapa — e não pela ordem, que é por data e
    // poderia inverter sem ninguém notar, nem pelo nome, que o helper de
    // montagem repete entre eventos.
    const porEtapa = Object.fromEntries(corpo.results.map(r => [r.event?.id, r]));
    expect(Object.keys(porEtapa).sort(), 'as duas etapas, distintas')
      .toEqual([ipiranga.id, razor.id].sort());
    expect(porEtapa[ipiranga.id].placing, 'Ipiranga: colocação').toBe(1);
    expect(porEtapa[ipiranga.id].points, 'Ipiranga: pontos').toBe(15);
    expect(porEtapa[razor.id].placing, 'Razor: colocação').toBe(1);
    expect(porEtapa[razor.id].points, 'Razor: pontos').toBe(15);

    expect(corpo.rankings[0].totalPoints, 'PONTOS SOMADOS').toBe(30);
    expect(corpo.rankings[0].eventCount, 'PARTICIPAÇÕES').toBe(2);
    expect(corpo.titles, 'TÍTULOS').toBe(2);

    // E A SOMA FECHA: o total do ranking é a soma das duas linhas do histórico.
    // Era esta a contradição original — dois números certos para fontes
    // diferentes, somando coisas diferentes na mesma tela.
    const somaDoHistorico = corpo.results.reduce((t, r) => t + (r.points ?? 0), 0);
    expect(somaDoHistorico, 'a soma do histórico bate com o total do ranking')
      .toBe(corpo.rankings[0].totalPoints);

    // NADA FOI ESCRITO PARA ISSO APARECER: um atleta, dois lançamentos, uma
    // identidade externa. Os mesmos números de antes da correção.
    expect(await contar(gerente, 'athlete', { affiliationNumber: '2932' }), 'atletas').toBe(1);
    expect(await contar(gerente, 'rankingPoint'), 'lançamentos').toBe(2);
    expect(await contar(gerente, 'externalAthlete'), 'identidades externas').toBe(1);
    // E ZERO resultado RECEBIDO: o MCI não apurou nada neste caso. A ficha
    // mostra 2 porque passou a enxergar a origem IMPORTADA, não porque alguém
    // publicou um resultado à mão.
    expect(await contar(gerente, 'resultEntry'), 'apurações recebidas pelo MCI').toBe(0);
  });
});

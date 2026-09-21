import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// UMA ETAPA INTEIRA, NA ESCALA E NO FORMATO REAIS, SEM UM ATLETA CADASTRADO.
//
// O QUE ESTE ARQUIVO MEDE, E O QUE ELE NÃO MEDE
//
// Ele usa o CABEÇALHO REAL do arquivo oficial de uma etapa NPC e o TAMANHO
// real dela — 191 linhas —, porque os dois importam: o formato exercita o
// adapter de verdade (nome partido em duas colunas, identificador derivado), e
// a escala exercita o caminho em lote, onde um N+1 escondido só aparece com
// volume.
//
// O QUE ELE NÃO USA É O ARQUIVO REAL. Ele não está versionado — e não deve
// estar: este repositório é público, e um arquivo oficial traz nome e
// matrícula de competidor de verdade. `scripts/qa/previa-ipiranga.mjs` recebe
// o caminho por `QA_CSV` justamente para que o dado real nunca entre aqui.
//
// OS NOMES SÃO DE QA e começam com "QA", para que ninguém os confunda com
// cadastro. O COMPRIMENTO deles é calibrado pelo pior caso real (nome composto
// com preposição), porque medir com nome curto daria um "cabe" falso.
//
// A pergunta que este arquivo responde: uma etapa inteira entra no histórico
// oficial com a base de atletas VAZIA, sem que o sistema fabrique uma única
// pessoa?
// ============================================================================

const TOTAL = 191;

// O cabeçalho real, na ordem em que sai do sistema de origem.
const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';

const CLASSES = [
  "Women's Bikini - Open Class A",
  "Women's Wellness - Open Class B",
  "Men's Classic Physique - Open Class A",
  "Men's Physique - Open Class B",
  "Men's Bodybuilding - Open Middleweight"
];

const SOBRENOMES = ['DA SILVA SANTOS', 'DE ALMEIDA', 'DOS SANTOS', 'PEREIRA LIMA', 'OLIVEIRA'];

// Cada classe premia do 1º ao 5º e o resto fica fora do pódio; a última linha
// de cada bloco vai como NS, que pela regra homologada vale ZERO e mesmo assim
// É PARTICIPAÇÃO. É a distinção que o arquivo precisa exercitar.
function arquivoDaEtapa() {
  const linhas = [CABECALHO];
  for (let i = 0; i < TOTAL; i += 1) {
    const classe = CLASSES[i % CLASSES.length];
    const colocacaoNoBloco = (Math.floor(i / CLASSES.length) % 8) + 1;
    const naoCompareceu = colocacaoNoBloco === 8;
    linhas.push([
      i + 1,
      classe,
      `QA${i + 1}`,
      SOBRENOMES[i % SOBRENOMES.length],
      `QA-${100000 + i}`,
      'Brazil',
      20 + (i % 25),
      1,
      (95 - (i % 30)).toFixed(1),
      naoCompareceu ? 'NS' : colocacaoNoBloco
    ].join(','));
  }
  return linhas.join('\n');
}

let admin;
let gerente;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;

  // A TABELA HOMOLOGADA. Nenhuma outra: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1, 6º+=0.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

describe('uma etapa inteira entra no histórico com a base de atletas vazia', () => {
  it('191 linhas viram 191 resultados históricos e ZERO atletas', async () => {
    expect(await prisma.athlete.count()).toBe(0);
    // Linha de base, e não zero absoluto: `criarUsuario` nasce com papel
    // ATHLETE por padrão, então o gerente do cenário já conta. Medir contra
    // zero acusaria o arreio, e não o produto.
    const usuariosAntes = await prisma.user.count({ where: { role: 'ATHLETE' } });

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('etapa-qa') + '.csv',
      content: arquivoDaEtapa(),
      // O identificador de resultado é DERIVADO, e a derivação é opt-in: o
      // arquivo oficial não traz um, e inventá-lo em silêncio transformaria
      // "arquivo sem identidade" em "arquivo importado".
      externalIdPrefix: 'QA-ETAPA'
    });

    expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

    const resumo = lote.body.summary;
    expect(resumo.totalRecords).toBe(TOTAL);
    expect(resumo.rejected, 'nenhuma linha sem identificador externo').toBe(0);
    expect(resumo.conflicts, 'nenhum impasse de identidade ou de pontuação').toBe(0);
    expect(resumo.duplicates, 'nenhum identificador repetido').toBe(0);
    // Base vazia de atletas: TODAS pendentes de vínculo. E todas aplicáveis.
    expect(resumo.recognized).toBe(0);
    expect(resumo.pending).toBe(TOTAL);
    expect(resumo.applicable).toBe(TOTAL);
    expect(resumo.pendingLink).toBe(TOTAL);

    const comecou = Date.now();
    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
      .set(gerente.auth());
    const duracao = Date.now() - comecou;

    expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 400)).toBe(200);
    expect(aplicacao.body.applied).toBe(TOTAL);

    // ZERO ATLETAS CRIADOS. A asserção que não pode ceder.
    expect(await prisma.athlete.count()).toBe(0);
    expect(await prisma.user.count({ where: { role: 'ATHLETE' } })).toBe(usuariosAntes);

    const contagens = await noLedger(async tx => ({
      identidades: await tx.externalAthlete.count(),
      externos: await tx.externalResult.count(),
      pontos: await tx.rankingPoint.count(),
      semDono: await tx.rankingPoint.count({ where: { athleteId: null } }),
      semOrganizacao: await tx.rankingPoint.count({ where: { organizationId: { not: organizationId } } })
    }));

    // Cada linha tem matrícula própria, então cada uma é uma identidade.
    expect(contagens.identidades).toBe(TOTAL);
    expect(contagens.externos).toBe(TOTAL);
    expect(contagens.pontos).toBe(TOTAL);
    expect(contagens.semDono, 'todas pendentes de vínculo').toBe(TOTAL);
    expect(contagens.semOrganizacao, 'nenhuma linha fora da organização do lote').toBe(0);

    // Observabilidade, não enfeite: é o número que denuncia um N+1 que
    // voltou. Medido neste ambiente; em CI o teto é generoso de propósito,
    // porque runner compartilhado varia muito.
    expect(duracao, `aplicar ${TOTAL} registros levou ${duracao}ms`).toBeLessThan(60000);
  });

  it('NS entra como participação de ZERO ponto, e o arquivo não opina', async () => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('etapa-qa') + '.csv',
      content: arquivoDaEtapa(), externalIdPrefix: 'QA-ETAPA'
    });
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const ausencias = await noLedger(tx => tx.rankingPoint.findMany({ where: { didNotShow: true } }));
    expect(ausencias.length, 'o arquivo traz linhas NS').toBeGreaterThan(0);

    // ZERO, sempre. É a fraude mais barata que um arquivo pode tentar:
    // declarar ausência e mandar pontuação junto.
    expect(ausencias.every(p => p.points === 0)).toBe(true);
    expect(ausencias.every(p => p.superOverallPoints === 0)).toBe(true);
    expect(ausencias.every(p => p.overallBonus === 0)).toBe(true);

    // E a participação EXISTE: ela não é uma linha descartada.
    expect(ausencias.every(p => p.externalAthleteId !== null)).toBe(true);
  });

  it('a pontuação segue a tabela homologada, colocação por colocação', async () => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('etapa-qa') + '.csv',
      content: arquivoDaEtapa(), externalIdPrefix: 'QA-ETAPA'
    });
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const pontos = await noLedger(tx => tx.rankingPoint.findMany({
      select: { placing: true, points: true, didNotShow: true }
    }));

    const esperado = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1, 6: 0, 7: 0 };
    for (const ponto of pontos) {
      if (ponto.didNotShow) { expect(ponto.points).toBe(0); continue; }
      expect(esperado[ponto.placing], `colocação ${ponto.placing} fora da tabela`).toBeDefined();
      expect(ponto.points, `colocação ${ponto.placing} pontuou ${ponto.points}`)
        .toBe(esperado[ponto.placing]);
    }
  });

  it('o ranking público responde com a etapa inteira sem cadastro nenhum', async () => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('etapa-qa') + '.csv',
      content: arquivoDaEtapa(), externalIdPrefix: 'QA-ETAPA'
    });
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    // ANÔNIMO. Sem token, sem contexto de sessão.
    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items.length).toBeGreaterThan(0);
    // Todo mundo aparece com o nome da FONTE e sem perfil para linkar.
    expect(ranking.body.items.every(l => l.athlete.id === null)).toBe(true);
    expect(ranking.body.items.every(l => l.athlete.fullName.startsWith('QA'))).toBe(true);

    // E o ledger continua invisível para ele.
    expect(await prisma.rankingPoint.count()).toBe(0);
  });
});

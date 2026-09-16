#!/usr/bin/env node
/**
 * GATE DE IDENTIDADE — confere, ANTES de qualquer gravação, se a base tem os
 * atletas que um arquivo de importação vai precisar.
 *
 * POR QUE ISTO EXISTE
 *
 * A importação não cria atleta, e isso é regra, não limitação: um arquivo
 * externo não pode fabricar identidade dentro do MCI. A consequência prática é
 * que aplicar um lote numa base que não tem os atletas cadastrados não produz
 * erro — produz um lote inteiro em MATCH_PENDING e a impressão de que "não
 * funcionou". Este gate responde a pergunta antes: quantos dos atletas do
 * arquivo a base reconhece, e por quê os outros não.
 *
 * O QUE ELE NÃO FAZ
 *
 * Não escreve. Nenhuma linha, em nenhuma tabela. Não cria atleta, não cria
 * ponto, não corrige divergência, não resolve conflito. É leitura e relatório.
 *
 * COMO ELE DECIDE
 *
 * A chave é filiação + matrícula, as duas juntas — a mesma prioridade
 * homologada que o importador usa. Nome NÃO é chave: entra apenas como
 * evidência de conferência, e uma divergência de nome não derruba um vínculo
 * que a matrícula identificou sem ambiguidade. O contrário também vale:
 * ambiguidade de matrícula bloqueia, mesmo com o nome batendo.
 *
 *   MATCHED        um atleta, na filiação certa, com aquela matrícula
 *   CONFLICT       mais de um atleta com a mesma matrícula na filiação, OU
 *                  a matrícula existe na organização sob outra filiação
 *   MATCH_PENDING  a matrícula não existe na organização
 *   UNKNOWN        a linha do arquivo não tem matrícula para procurar
 *
 * USO
 *
 *   node scripts/gate-de-identidade.js \
 *     --csv caminho/arquivo.csv \
 *     --organizacao <organizationId> \
 *     --filiacao NPC \
 *     --ator <userId> [--json]
 *
 * `--ator` é OBRIGATÓRIO, e a razão é medida, não estilística. A conexão de
 * manutenção é dona do schema e o RLS não se aplica a ela: a mesma consulta,
 * pelas mesmas matrículas, devolveu 0 atletas sob contexto de ator e 1 atleta
 * DE OUTRA ORGANIZAÇÃO sem contexto. Rodar sem ator não é "rodar sem filtro
 * extra" — é ler o banco inteiro com privilégio de dono, com uma cláusula de
 * aplicação como única barreira. O projeto trata RLS como a barreira, não
 * como reforço, e este script não abre exceção.
 */
const { readFileSync } = require('node:fs');
const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');
const adapter = require('../src/utils/musclewar/adapter');

const STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  PENDING: 'MATCH_PENDING',
  CONFLICT: 'CONFLICT',
  UNKNOWN: 'UNKNOWN'
});

function lerArgumentos(argv) {
  const opcoes = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const atual = argv[i];
    if (atual === '--json') { opcoes.json = true; continue; }
    const nome = atual.startsWith('--') ? atual.slice(2) : null;
    if (nome) { opcoes[nome] = argv[i + 1]; i += 1; }
  }
  return opcoes;
}

// Acento, caixa e espaço repetido não separam o mesmo nome. A comparação é
// deliberadamente frouxa porque ela NÃO decide nada: só marca o que um humano
// deve olhar.
const normalizarNome = nome => String(nome || '')
  .trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/**
 * O gate propriamente dito. Recebe um cliente já sob contexto de RLS para que
 * a suíte possa exercitá-lo sem subir processo.
 */
async function conferirIdentidades(tx, { registros, organizationId, affiliationCode }) {
  const filiacao = await tx.affiliation.findFirst({
    where: { organizationId, code: affiliationCode.toUpperCase() },
    select: { id: true, code: true, name: true }
  });

  // Matrículas distintas do arquivo, com o nome que a origem informou para
  // cada uma. Duas grafias para a mesma matrícula são um fato do ARQUIVO e
  // aparecem no relatório — não são resolvidas aqui.
  const doArquivo = new Map();
  for (const registro of registros) {
    const matricula = registro.memberNumber;
    if (!doArquivo.has(matricula ?? '')) {
      doArquivo.set(matricula ?? '', { memberNumber: matricula, nomes: new Set(), linhas: 0 });
    }
    const entrada = doArquivo.get(matricula ?? '');
    entrada.linhas += 1;
    if (registro.athleteName) entrada.nomes.add(registro.athleteName);
  }

  const matriculas = [...doArquivo.values()].map(e => e.memberNumber).filter(Boolean);

  // Uma consulta para todas as matrículas, na ORGANIZAÇÃO inteira — não só na
  // filiação. Procurar apenas dentro da NPC devolveria "não existe" para uma
  // matrícula cadastrada sob outra filiação, e isso é conflito, não ausência:
  // são situações diferentes e exigem correções diferentes.
  //
  // `organizationId` fica aqui como SEGUNDA barreira, e a suíte de mutação
  // mostrou que ela é a única no dia em que a primeira falhar: removê-la não
  // quebra nenhum teste, porque o RLS já barra o outro tenant sob contexto de
  // ator. É reforço deliberado, não redundância esquecida.
  const candidatos = matriculas.length
    ? await tx.athlete.findMany({
      where: { organizationId, affiliationNumber: { in: matriculas } },
      select: {
        id: true, fullName: true, affiliationNumber: true, organizationId: true,
        affiliation: { select: { id: true, code: true, name: true } }
      }
    })
    : [];

  const porMatricula = new Map();
  for (const atleta of candidatos) {
    if (!porMatricula.has(atleta.affiliationNumber)) porMatricula.set(atleta.affiliationNumber, []);
    porMatricula.get(atleta.affiliationNumber).push(atleta);
  }

  const linhas = [...doArquivo.values()]
    .sort((a, b) => String(a.memberNumber).localeCompare(String(b.memberNumber)))
    .map(entrada => {
      const nomeNoArquivo = [...entrada.nomes].join(' / ') || null;
      const base = {
        memberNumber: entrada.memberNumber,
        nomeNoArquivo,
        linhasNoArquivo: entrada.linhas,
        athleteId: null,
        nomeCadastrado: null,
        affiliation: null,
        nomeDiverge: false,
        motivo: null
      };

      if (!entrada.memberNumber) {
        return { ...base, status: STATUS.UNKNOWN, motivo: 'Linha do arquivo sem matrícula' };
      }

      const encontrados = porMatricula.get(entrada.memberNumber) ?? [];
      if (!encontrados.length) {
        return { ...base, status: STATUS.PENDING, motivo: 'Matrícula não cadastrada nesta organização' };
      }

      // Ambiguidade bloqueia, e nome nenhum desempata: escolher "o que parece
      // certo" creditaria o resultado ao atleta errado em silêncio.
      if (encontrados.length > 1) {
        return {
          ...base,
          status: STATUS.CONFLICT,
          motivo: `Matrícula duplicada na organização: ${encontrados.map(a => a.fullName).join(' | ')}`
        };
      }

      const [atleta] = encontrados;
      const comum = {
        ...base,
        athleteId: atleta.id,
        nomeCadastrado: atleta.fullName,
        affiliation: atleta.affiliation?.code ?? null,
        nomeDiverge: Boolean(nomeNoArquivo)
          && normalizarNome(nomeNoArquivo) !== normalizarNome(atleta.fullName)
      };

      if (!filiacao) {
        return { ...comum, status: STATUS.CONFLICT, motivo: `Filiação ${affiliationCode} não existe nesta organização` };
      }
      if (atleta.affiliation?.id !== filiacao.id) {
        return {
          ...comum,
          status: STATUS.CONFLICT,
          motivo: `Matrícula cadastrada sob ${atleta.affiliation?.code ?? 'nenhuma filiação'}, e o lote é ${filiacao.code}`
        };
      }

      // Nome divergente com matrícula e filiação inequívocas NÃO é conflito.
      // É conferência para um humano, e o vínculo está identificado.
      return { ...comum, status: STATUS.MATCHED };
    });

  const contar = status => linhas.filter(l => l.status === status).length;

  return {
    filiacao,
    linhas,
    resumo: {
      atletasDistintos: linhas.length,
      MATCHED: contar(STATUS.MATCHED),
      MATCH_PENDING: contar(STATUS.PENDING),
      CONFLICT: contar(STATUS.CONFLICT),
      UNKNOWN: contar(STATUS.UNKNOWN),
      matriculasDuplicadas: linhas.filter(l => /duplicada/.test(l.motivo ?? '')).length,
      filiacoesDiferentes: linhas.filter(l => /cadastrada sob/.test(l.motivo ?? '')).length,
      divergenciasDeNome: linhas.filter(l => l.nomeDiverge).length
    }
  };
}

/**
 * O veredito.
 *
 * Os quatro status PARTICIONAM o conjunto: todo caminho de saída do
 * classificador atribui exatamente um, então
 * MATCHED + MATCH_PENDING + CONFLICT + UNKNOWN === atletasDistintos sempre.
 * Por isso a igualdade abaixo já significa, sozinha, zero pendente, zero
 * conflito e zero desconhecido — repetir as três comparações aqui seria
 * condição morta, que a suíte de mutação acusou como intestável. Quem tranca a
 * partição é o teste "os quatro status somam o total"; é ele que autoriza esta
 * linha a ser curta.
 *
 * `atletasDistintos > 0` existe porque arquivo vazio não é base pronta: sem
 * ele, nenhum atleta a conferir passaria por conferência bem-sucedida.
 */
const aprovado = resumo => resumo.atletasDistintos > 0
  && resumo.MATCHED === resumo.atletasDistintos;

function imprimir({ filiacao, linhas, resumo }, { organizationId, affiliationCode }) {
  const corta = (texto, n) => String(texto ?? '—').slice(0, n).padEnd(n);

  console.log('');
  console.log('GATE DE IDENTIDADE');
  console.log(`  organização : ${organizationId}`);
  console.log(`  filiação    : ${affiliationCode}${filiacao ? ` (${filiacao.name})` : ' — NÃO ENCONTRADA'}`);
  console.log('');
  console.log(`${'#'.padStart(3)} | ${corta('Member Number', 13)} | ${corta('Nome no arquivo', 30)} | ${corta('Athlete ID', 26)} | ${corta('Nome cadastrado', 30)} | ${corta('Afil', 6)} | Status`);
  console.log('-'.repeat(135));
  linhas.forEach((l, i) => {
    console.log(
      `${String(i + 1).padStart(3)} | ${corta(l.memberNumber, 13)} | ${corta(l.nomeNoArquivo, 30)} | `
      + `${corta(l.athleteId, 26)} | ${corta(l.nomeCadastrado, 30)} | ${corta(l.affiliation, 6)} | `
      + `${l.status}${l.nomeDiverge ? ' (nome diverge)' : ''}${l.motivo ? ` — ${l.motivo}` : ''}`
    );
  });

  console.log('');
  console.log('RESUMO');
  console.log(`  atletas distintos       : ${resumo.atletasDistintos}`);
  console.log(`  MATCHED                 : ${resumo.MATCHED}`);
  console.log(`  MATCH_PENDING           : ${resumo.MATCH_PENDING}`);
  console.log(`  CONFLICT                : ${resumo.CONFLICT}`);
  console.log(`  UNKNOWN                 : ${resumo.UNKNOWN}`);
  console.log(`  matrículas duplicadas   : ${resumo.matriculasDuplicadas}`);
  console.log(`  filiações fora do lote  : ${resumo.filiacoesDiferentes}`);
  console.log(`  divergências de nome    : ${resumo.divergenciasDeNome}`);
  console.log('');
  console.log(aprovado(resumo)
    ? `IDENTIDADE HOMOLOGADA — ${resumo.MATCHED}/${resumo.atletasDistintos} MATCHED — IMPORTAÇÃO AINDA NÃO APLICADA.`
    : 'IDENTIDADE NÃO HOMOLOGADA — a importação NÃO deve ser aplicada.');
  console.log('');
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2));
  const faltando = ['csv', 'organizacao', 'filiacao', 'ator'].filter(nome => !opcoes[nome]);
  if (faltando.length) {
    console.error(`Faltam argumentos: ${faltando.map(f => `--${f}`).join(', ')}`);
    console.error('Uso: node scripts/gate-de-identidade.js --csv <arquivo> --organizacao <id> --filiacao NPC --ator <userId>');
    if (!opcoes.ator) {
      console.error('');
      console.error('--ator é obrigatório: sem contexto de RLS a leitura corre com privilégio de');
      console.error('dono do schema e enxerga atletas de OUTRAS organizações.');
    }
    process.exit(2);
  }

  const registros = adapter.parse('CSV', readFileSync(opcoes.csv, 'utf8'), {
    defaultAffiliationCode: opcoes.filiacao
  });

  const executar = tx => conferirIdentidades(tx, {
    registros, organizationId: opcoes.organizacao, affiliationCode: opcoes.filiacao
  });

  const resultado = await withUserContext(opcoes.ator, executar);

  if (opcoes.json) console.log(JSON.stringify(resultado, null, 2));
  else imprimir(resultado, { organizationId: opcoes.organizacao, affiliationCode: opcoes.filiacao });

  await prisma.$disconnect();
  // Sai diferente de zero quando o gate reprova: assim ele serve de porta num
  // roteiro de operação, e não só de relatório para ler.
  process.exit(aprovado(resultado.resumo) ? 0 : 1);
}

if (require.main === module) {
  principal().catch(async erro => {
    console.error(`Falha no gate: ${erro.message}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(2);
  });
}

module.exports = { conferirIdentidades, aprovado, STATUS };

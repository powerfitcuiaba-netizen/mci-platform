import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 13.6 — O IMPORTADOR SOB CARGA.
//
// A planilha de uma temporada não tem doze linhas. A medição da FASE 13
// encontrou o limite: com 1.000 linhas, a criação da importação devolvia 500.
// Causa medida no log do servidor — P2028, prazo da transação esgotado:
//
//   * a requisição inteira roda numa transação (é assim que o ator de RLS é
//     definido), com prazo PADRÃO de 5 segundos;
//   * a análise consultava o banco POR LINHA — identificador já aplicado,
//     filiação, atleta por matrícula, identidade por CPF, categoria e tabela
//     da temporada, uma ida e volta cada;
//   * e a linha não reconhecida carregava o CADASTRO INTEIRO de atletas da
//     organização, por linha, para procurar homônimo.
//
// Não é lentidão: é recusa. O operador subia o arquivo do campeonato e recebia
// "erro interno", sem nada importado e sem saber por quê.
//
// Este arquivo é a trava. O volume é o que a fase pede, não um número
// simbólico — se a análise voltar a consultar por linha, ele reprova.
// ============================================================================

let admin, gerente, organizationId, seasonId, filiacao;

const ATLETAS = 60;
const cpfDoAtleta = i => gerarCpf(880000000 + i * 37);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  organizationId = org.id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Mato Grosso', code: 'NPC-MT' })).body;

  const temporada = await api().post('/api/v1/seasons').set(gerente.auth())
    .send({ organizationId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;

  // Cadastro semeado direto: o que está sob medição é o custo por LINHA DO
  // ARQUIVO, e criar 60 atletas pela porta da frente mediria o helper.
  await comoAtor(gerente, async tx => {
    for (let i = 0; i < ATLETAS; i += 1) {
      await tx.athlete.create({
        data: {
          id: `carga-atl-${String(i).padStart(4, '0')}`,
          organizationId,
          fullName: `ATLETA DE CARGA ${String(i).padStart(4, '0')}`,
          sex: i % 2 ? 'MALE' : 'FEMALE',
          affiliationId: filiacao.id,
          affiliationNumber: `MT-${i}`,
          identity: { create: { organizationId, cpf: cpfDoAtleta(i) } }
        }
      });
    }
  });
});

// Um arquivo realista: parte reconhecida por CPF, parte pelo par
// filiação + matrícula, e uma fatia que não casa com ninguém — que é
// justamente a que disparava a varredura do cadastro inteiro.
function csvDeCarga(linhas, codigoDaCategoria) {
  const partes = ['external_result_id,cpf,athlete_name,affiliation_code,member_number,category_code,division,class,placing,points\n'];
  for (let i = 0; i < linhas; i += 1) {
    const atleta = i % ATLETAS;
    const colocacao = (i % 5) + 1;
    const pontos = [5, 4, 3, 2, 1][colocacao - 1];
    const modo = i % 10;

    const cpf = modo < 5 ? cpfDoAtleta(atleta) : '';
    const codigo = modo >= 5 && modo < 9 ? 'NPC-MT' : '';
    const matricula = modo >= 5 && modo < 9 ? `MT-${atleta}` : '';
    const nome = modo === 9 ? `DESCONHECIDA ${i}` : `ATLETA DE CARGA ${String(atleta).padStart(4, '0')}`;

    partes.push(`CARGA-${i},${cpf},${nome},${codigo},${matricula},${codigoDaCategoria},Absoluta,Open,${colocacao},${pontos}\n`);
  }
  return partes.join('');
}

const importar = (linhas, categoria) => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId,
  sourceType: 'CSV',
  sourceRef: `carga ${linhas} linhas`,
  content: csvDeCarga(linhas, categoria)
});

describe('a importação aguenta o arquivo de uma temporada', () => {
  it('1.000 linhas entram, e entram com os totais certos', async () => {
    const categoria = await comoAtor(gerente, tx => tx.category.findFirst({ select: { code: true } }));

    const resposta = await importar(1000, categoria.code);

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(201);

    const totais = resposta.body.totals ?? resposta.body.import;
    expect(resposta.body.import.totalRecords, 'todas as linhas viraram item').toBe(1000);

    const itens = await comoAtor(gerente, tx => tx.muscleWarImportItem.count({
      where: { importId: resposta.body.import.id }
    }));
    expect(itens, 'nenhuma linha se perdeu no caminho').toBe(1000);

    // 90% das linhas trazem uma chave que reconhece; 10% não trazem nenhuma.
    expect(resposta.body.import.matchedCount, JSON.stringify(totais)).toBe(900);
    expect(resposta.body.import.pendingCount, 'as sem chave esperam revisão').toBe(100);
  }, 120000);

  it('reconhecimento e conflito continuam valendo no volume', async () => {
    const categoria = await comoAtor(gerente, tx => tx.category.findFirst({ select: { code: true } }));
    const resposta = await importar(200, categoria.code);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(201);

    const itens = await comoAtor(gerente, tx => tx.muscleWarImportItem.findMany({
      where: { importId: resposta.body.import.id },
      orderBy: { rowNumber: 'asc' },
      select: { rowNumber: true, matchStatus: true, matchedBy: true, athleteId: true, suggestedAthleteId: true }
    }));

    // Linha 1 (índice 0): CPF. Linha 6 (índice 5): filiação + matrícula.
    // Linha 10 (índice 9): nenhuma chave — e o nome não existe no cadastro.
    const porLinha = new Map(itens.map(i => [i.rowNumber, i]));
    expect(porLinha.get(1).matchedBy, 'reconhecida pelo CPF').toBe('CPF');
    expect(porLinha.get(6).matchedBy, 'reconhecida pelo par filiação + matrícula').toBe('AFFILIATION_NUMBER');
    expect(porLinha.get(10).matchStatus, 'sem chave: espera gente').toBe('MATCH_PENDING');
    expect(porLinha.get(10).suggestedAthleteId, 'nome inexistente não sugere ninguém').toBeNull();
  }, 120000);
});

// ============================================================================
// A REVISÃO É UMA PÁGINA — E OS TOTAIS SÃO DO LOTE INTEIRO.
//
// Medido na FASE 13.6: uma importação de 10.000 linhas devolvia 12,2 MB, três
// vezes (criar, revisar e aplicar terminam todos na pré-visualização), e a
// memória da API ia de 121 MB a 718 MB no mesmo ciclo.
//
// Cortar a lista só é seguro porque os totais NÃO vêm dela: eles saem de uma
// contagem agrupada no banco. Se um dia voltarem a ser somados sobre a página,
// a tela dirá "3 pendentes" onde há 300 — e o operador aplicará um lote
// achando que não há nada a revisar. É esse o erro que os testes abaixo
// impedem.
// ============================================================================
describe('a pré-visualização pagina sem mentir nos totais', () => {
  const totalDeLinhas = 450;
  let importId, categoria;

  beforeEach(async () => {
    categoria = await comoAtor(gerente, tx => tx.category.findFirst({ select: { code: true } }));
    const criacao = await importar(totalDeLinhas, categoria.code);
    expect(criacao.status, JSON.stringify(criacao.body).slice(0, 300)).toBe(201);
    importId = criacao.body.import.id;
  });

  const revisar = params => api().get(`/api/v1/musclewar/imports/${importId}`)
    .set(gerente.auth()).query(params ?? {});

  it('a página tem teto, e os totais continuam do lote', async () => {
    const resposta = await revisar();
    expect(resposta.status).toBe(200);

    expect(resposta.body.items.length, 'a lista vem cortada').toBeLessThan(totalDeLinhas);
    expect(resposta.body.page.total, 'o recorte sabe o tamanho real').toBe(totalDeLinhas);
    expect(resposta.body.page.hasMore, 'e diz que há mais').toBe(true);

    // O que o operador lê antes de decidir: os números do LOTE.
    expect(resposta.body.summary.totalRecords).toBe(totalDeLinhas);
    expect(resposta.body.summary.recognized + resposta.body.summary.pending
      + resposta.body.summary.conflicts + resposta.body.summary.duplicates
      + resposta.body.summary.rejected + resposta.body.summary.applied,
    'as situações somam o lote inteiro').toBe(totalDeLinhas);
    expect(resposta.body.summary.pending, 'as sem chave são 10% das linhas')
      .toBe(Math.floor(totalDeLinhas / 10));
  });

  it('percorrer as páginas devolve cada linha uma vez, e todas', async () => {
    const vistas = new Set();
    let offset = 0;
    for (let volta = 0; volta < 20; volta += 1) {
      const pagina = await revisar({ limit: 100, offset });
      expect(pagina.status).toBe(200);
      for (const item of pagina.body.items) vistas.add(item.rowNumber);
      offset += pagina.body.items.length;
      if (!pagina.body.page.hasMore) break;
    }
    expect(vistas.size, 'nenhuma linha repetida, nenhuma perdida').toBe(totalDeLinhas);
  });

  it('o filtro por situação leva direto ao que exige gente', async () => {
    const pendentes = await revisar({ matchStatus: 'MATCH_PENDING', limit: 1000 });
    expect(pendentes.status).toBe(200);
    expect(pendentes.body.items.length).toBe(Math.floor(totalDeLinhas / 10));
    expect(pendentes.body.items.every(i => i.matchStatus === 'MATCH_PENDING')).toBe(true);
    expect(pendentes.body.page.total, 'o total passa a ser o do recorte')
      .toBe(Math.floor(totalDeLinhas / 10));
    // E o resumo NÃO muda: ele descreve o lote, não o filtro.
    expect(pendentes.body.summary.totalRecords).toBe(totalDeLinhas);
  });

  it('recorte malformado é recusado na porta, não repassado ao banco', async () => {
    expect((await revisar({ limit: 'abc' })).status).toBe(400);
    expect((await revisar({ offset: -5 })).status).toBe(400);
    expect((await revisar({ matchStatus: 'INVENTADO' })).status).toBe(400);
    expect((await revisar({ limit: 999999 })).status, 'teto declarado no schema').toBe(400);
  });
});

// ============================================================================
// O ARQUIVO GRANDE DEMAIS É RECUSADO COM O MOTIVO NA MÃO.
//
// Medido na FASE 13.6: 100.000 linhas são 10,7 MB, e o servidor aceita 8 MB.
// A recusa está certa — o que estava errado era o que ela dizia. O
// `body-parser` responde 413 sem `code`, e a resposta saía como
// `{"code":"ERROR","message":"request entity too large"}`.
//
// Para quem subiu a planilha do campeonato, "ERROR" não diz o que houve nem o
// que fazer. O limite, sim: com ele o operador sabe em quantas partes dividir.
// ============================================================================
describe('o corpo acima do teto é recusado com mensagem útil', () => {
  it('413 com código próprio e o limite escrito', async () => {
    // 9 MB de conteúdo: acima do teto de 8 MB do servidor.
    const enorme = 'x'.repeat(9 * 1024 * 1024);

    const resposta = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: 'grande demais', content: enorme
    });

    expect(resposta.status).toBe(413);
    expect(resposta.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(resposta.body.error.message, 'o limite aparece na mensagem').toMatch(/8 MB/);
    expect(resposta.body.error.message, 'e diz o que fazer').toMatch(/partes menores/i);
  }, 60000);

  it('o teto aplicado e o teto anunciado são o MESMO número', async () => {
    // Dois lugares para o mesmo limite é uma divergência esperando acontecer,
    // e aqui ela faria a mensagem prometer um tamanho que o servidor recusa.
    const { createRequire } = await import('node:module');
    const requireCjs = createRequire(import.meta.url);
    const limites = requireCjs('../src/config/limites.js');

    const app = await import('node:fs').then(fs => fs.readFileSync('src/app.js', 'utf8'));
    expect(app, 'o express.json lê a constante, não um literal').toContain('CORPO_MAXIMO');
    expect(app).not.toMatch(/express\.json\(\{\s*limit:\s*'/);

    expect(limites.CORPO_MAXIMO).toBe('8mb');
    expect(limites.CORPO_MAXIMO_LEGIVEL).toBe('8 MB');
  });
});

// ============================================================================
// O TETO DE LINHAS EXISTE PORQUE A MEDIÇÃO O ENCONTROU.
//
// O limite de bytes do corpo deixa passar um arquivo que a aplicação não
// termina: 44.000 linhas levam 139s para aplicar, contra um prazo de
// transação de 180s — e não terminar significa perder as 139s inteiras,
// porque a transação desfaz tudo.
//
// Recusar na porta é melhor que aceitar e desfazer no fim. E a recusa precisa
// dizer o número: "grande demais" não permite decidir em quantas partes
// dividir.
// ============================================================================
describe('o teto de linhas por importação', () => {
  it('acima do teto: 422 com o número e o caminho de saída', async () => {
    const { default: muscleWar } = await import('../src/services/muscleWarService.js');
    const teto = muscleWar.MAXIMO_DE_LINHAS;

    const categoria = await comoAtor(gerente, tx => tx.category.findFirst({ select: { code: true } }));

    // Linhas curtas de propósito: o que precisa estourar aqui é a CONTAGEM,
    // não o tamanho do corpo — senão a medição seria do outro limite.
    const cabecalho = 'external_result_id,athlete_name,category_code,placing\n';
    const corpo = Array.from({ length: teto + 1 },
      (unused, i) => `T-${i},N ${i},${categoria.code},1\n`).join('');

    const resposta = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: 'acima do teto', content: cabecalho + corpo
    });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 200)).toBe(422);
    expect(resposta.body.error.code).toBe('IMPORT_TOO_LARGE');
    expect(resposta.body.error.message).toContain(String(teto));
    expect(resposta.body.error.message, 'e diz que dividir é seguro').toMatch(/não duplica/i);

    // Recusado na porta: nada foi gravado.
    const lotes = await comoAtor(gerente, tx => tx.muscleWarImport.count({ where: { organizationId } }));
    expect(lotes, 'nenhum lote meio-criado ficou para trás').toBe(0);
  }, 180000);
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ============================================================================
// O WORKFLOW DA SONDA NÃO PODE USAR VARIÁVEL QUE ELE NÃO DEFINE.
//
// O DEFEITO QUE ORIGINOU ESTE ARQUIVO
//
// Um passo novo foi inserido no meio de um passo existente. O YAML continuou
// VÁLIDO — a indentação do `- name:` novo encerrou o bloco `run: |` anterior — e
// o resto do passo antigo foi absorvido pelo `run:` do passo novo, onde as
// variáveis dele não existem. Com `set -u`, variável não definida derruba o
// passo, e a sonda reprovou por um erro de EDIÇÃO, não por um estado de
// produção.
//
// NENHUM LINT PEGA ISSO. O YAML estava sintaticamente correto, o `eslint` não
// olha workflow, e a única forma de descobrir foi rodar contra produção e ler o
// vermelho — depois de um deploy.
//
// Cada passo roda num SHELL PRÓPRIO: nada do passo anterior sobrevive. Então
// toda variável usada num `run:` precisa ser definida ali mesmo, ou vir do
// ambiente declarado.
//
// SEM DEPENDÊNCIA NOVA. O arquivo é lido por indentação, que é o suficiente
// para achar os blocos `run:` — trazer um parser de YAML para o `package.json`
// por causa de um teste seria peso sem contrapartida.
// ============================================================================

const ARQUIVO = '.github/workflows/sonda-producao.yml';
const texto = readFileSync(ARQUIVO, 'utf8');

/**
 * Os blocos `run:` do workflow, com o nome do passo a que pertencem.
 *
 * A leitura é por INDENTAÇÃO, que é como o YAML delimita um bloco literal: o
 * conteúdo de `run: |` é tudo que estiver mais indentado que a chave, e termina
 * na primeira linha que não estiver. É exatamente essa regra que o defeito
 * explorou, então é ela que o teste precisa imitar.
 */
function passosComRun() {
  const linhas = texto.split('\n');
  const passos = [];
  let nome = '(sem nome)';

  for (let i = 0; i < linhas.length; i += 1) {
    const nomeAqui = linhas[i].match(/^\s*- name:\s*(.+)$/);
    if (nomeAqui) { nome = nomeAqui[1].trim(); continue; }

    const run = linhas[i].match(/^(\s*)run:\s*\|/);
    if (!run) continue;

    const recuo = run[1].length;
    const corpo = [];
    for (let j = i + 1; j < linhas.length; j += 1) {
      const linha = linhas[j];
      if (linha.trim() === '') { corpo.push(''); continue; }
      const recuoDaLinha = linha.length - linha.trimStart().length;
      if (recuoDaLinha <= recuo) break;
      corpo.push(linha);
    }
    passos.push({ nome, run: corpo.join('\n') });
  }

  return passos;
}

// Vêm do ambiente e não do corpo do passo: as do próprio GitHub, o `env:` do
// job, e as que um passo exporta por `GITHUB_ENV` para os seguintes.
const DO_AMBIENTE = new Set([
  'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_WORKSPACE',
  'API', 'FALHAS', 'EVENTOS', 'TOTAL_EQ', 'TOTAL_AT', 'TERMOS', 'CORTE',
  'DEMO_PUBLIC_COUNT'
]);

const PASSOS = passosComRun();

describe('sonda de produção: coerência dos passos', () => {
  it('há passos com shell para conferir', () => {
    // Linha de base: um workflow que perdesse todos os `run:` passaria nas
    // asserções abaixo por vacuidade.
    expect(PASSOS.length, 'a leitura por indentação achou os blocos').toBeGreaterThan(10);
    expect(PASSOS.every(p => p.run.length > 0)).toBe(true);
  });

  it('nenhum passo usa variável de shell que ele não define', () => {
    const acusados = [];

    for (const passo of PASSOS) {
      const usadas = new Set(
        [...passo.run.matchAll(/\$\{?([A-Z_][A-Z0-9_]+)\}?/g)].map(m => m[1])
      );
      const definidas = new Set(
        [...passo.run.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]+)=/gm)].map(m => m[1])
      );
      for (const m of passo.run.matchAll(/^\s*for\s+([A-Z_][A-Z0-9_]*)\s+in\s/gm)) definidas.add(m[1]);

      const orfas = [...usadas].filter(v => !definidas.has(v) && !DO_AMBIENTE.has(v));
      if (orfas.length) acusados.push(`${passo.nome}: ${orfas.join(', ')}`);
    }

    // A mensagem diz QUAL passo e QUAL variável: sem isso a reprovação manda
    // procurar num arquivo de quinhentas linhas.
    expect(acusados, `variável usada sem definição em:\n  ${acusados.join('\n  ')}`).toEqual([]);
  });

  it('o job do cartão mede as DUAS coisas, e nomeia a entidade oficial', () => {
    const doCartao = PASSOS.filter(p =>
      /resumo público|entidade de filiação oficial/i.test(p.nome));
    expect(doCartao.length).toBe(2);

    const entidade = doCartao.find(p => /entidade de filiação oficial/i.test(p.nome));
    // O nome oficial, LITERAL, no lugar onde a sonda o compara. Se ele mudar no
    // produto e não aqui, a sonda passa a medir outra entidade em silêncio.
    expect(entidade.run).toContain('NPC - National Physique Committe');
  });

  it('a sonda continua SOMENTE LEITURA', () => {
    const tudo = PASSOS.map(p => p.run).join('\n');
    // O que reprova é o método de escrita no curl, e não a palavra num
    // comentário: a sonda existe para NÃO escrever em produção.
    expect(tudo).not.toMatch(/-X\s+(POST|PUT|PATCH|DELETE)/);
    expect(tudo).not.toMatch(/curl[^\n]*--data\b(?!-urlencode)/);
  });
});

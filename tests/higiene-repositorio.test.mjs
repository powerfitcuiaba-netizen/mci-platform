import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ==========================================================================
// Higiene do repositório, executável localmente.
//
// A CI tem um job "Higiene do repositório" que reprova o push por segredo
// versionado, `.env` rastreado, marcador de trabalho inacabado e módulo
// financeiro reintroduzido. Nada disso era verificável antes do push: a
// primeira notícia de reprovação vinha da CI, depois do commit.
//
// Foi assim que a CI ficou VERMELHA por três commits seguidos sem que ninguém
// percebesse — a suíte local passava, e a suíte local não conhecia estas
// regras. Este arquivo traz o mesmo critério para dentro de `npm test`.
//
// Os padrões abaixo são cópia dos de .github/workflows/ci.yml; se um dos dois
// mudar, o outro precisa mudar junto, e o teste de coerência no fim desta
// suíte reprova se eles se separarem.
// ==========================================================================

const versionados = () => execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const PADRAO_SEGREDO = /sk_live_[A-Za-z0-9]{20,}|pk_live_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{20,}/;

const IGNORADOS = /package-lock|^design\/|^\.github\//;

describe('higiene do repositório', () => {
  it('nenhum arquivo versionado contém algo com forma de credencial real', () => {
    const acusados = [];

    for (const caminho of versionados()) {
      if (IGNORADOS.test(caminho)) continue;
      let conteudo;
      try {
        conteudo = readFileSync(caminho, 'utf8');
      } catch {
        continue; // binário ou ilegível: o padrão é textual
      }
      const achado = conteudo.split('\n').findIndex(linha => PADRAO_SEGREDO.test(linha));
      if (achado >= 0) acusados.push(`${caminho}:${achado + 1}`);
    }

    // A mensagem precisa dizer ONDE, senão a reprovação manda procurar.
    expect(acusados, `forma de credencial encontrada em: ${acusados.join(', ')}`).toEqual([]);
  });

  it('o .env não é rastreado', () => {
    expect(versionados().filter(c => /(^|\/)\.env$/.test(c))).toEqual([]);
  });

  it('não há marcador de trabalho inacabado no código', () => {
    const saida = execFileSync('git', ['ls-files', 'src', 'frontend/src', 'tests'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const acusados = [];
    for (const caminho of saida) {
      const conteudo = readFileSync(caminho, 'utf8');
      // TODO o padrão é montado em pedaços, senão ESTE arquivo se acusaria:
      // o passo da CI varre `tests/` com um grep literal, e um marcador
      // escrito por inteiro aqui reprovaria o repositório inteiro por causa do
      // teste que existe para conferi-lo. Acabou de acontecer, antes do push.
      const marcadores = ['console' + '.log(', 'debug' + 'ger;', 'TO' + 'DO:', 'FIX' + 'ME:'];
      if (marcadores.some(m => conteudo.includes(m))) acusados.push(caminho);
    }
    expect(acusados, `marcador encontrado em: ${acusados.join(', ')}`).toEqual([]);
  });

  it('nenhum arquivo de módulo financeiro foi reintroduzido', () => {
    const fontes = execFileSync('git', ['ls-files', 'src', 'frontend/src'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const financeiros = fontes.filter(c => /(payment|checkout|coupon|refund|invoice|billing|wallet)/i.test(c));
    expect(financeiros).toEqual([]);
  });

  // ==========================================================================
  // NENHUM RESÍDUO DE RODADA DE MUTAÇÃO ENTRA NO REPOSITÓRIO.
  //
  // ACONTECEU, E O CUSTO FOI ALTO. `scripts/qa/mutantes-*.mjs` grava
  // `<arquivo>.mutante-bak`, aplica o mutante, roda a suíte e restaura. Um
  // `git add -A` dado com a rodada EM CURSO capturou as duas coisas: o backup e
  // o arquivo MUTADO. O mutante TE-F1 — que apaga `status: 'APPROVED'` da lista
  // de autorização da federação, fazendo cadastro NÃO aprovado aparecer para
  // autorização e violando R-03 — foi commitado e empurrado para a branch.
  //
  // O `.gitignore` impede versionar o BACKUP. Este teste é a outra metade: ele
  // acusa o resíduo rastreado, e a ausência dele é o que diz que nenhuma rodada
  // ficou pela metade dentro do repositório.
  //
  // Repare no que ele NÃO consegue provar: que o arquivo de origem não está
  // mutado. Isso não é verificável por padrão de texto — as suítes do módulo são
  // que provam, e é por isso que commit com rodada em curso é proibido por
  // procedimento, não só por teste.
  // ==========================================================================
  it('nenhum backup de mutação está rastreado pelo git', () => {
    const rastreados = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const residuos = rastreados.filter(caminho => caminho.endsWith('.mutante-bak'));

    expect(residuos, `resíduo de mutação rastreado: ${residuos.join(', ')}. `
      + 'O arquivo de origem correspondente pode estar MUTADO — confira antes de qualquer coisa.')
      .toEqual([]);
  });

  // ==========================================================================
  // NENHUM OBJETO DE EXECUÇÃO ENTRA NO REPOSITÓRIO.
  //
  // ACONTECEU TAMBÉM, pelo mesmo mecanismo: `STORAGE_DIR=./uploads-preview` é o
  // armazenamento que o workflow do preview e a réplica local usam, e a decisão
  // da foto obrigatória passou a gravar ali a foto de cada treinador de QA. Um
  // `git add -A` capturou quatro `.webp` sintéticos e os empurrou para a branch.
  //
  // Nenhum deles tinha dado pessoal — são imagens 8×8 geradas pelo arreio —, e é
  // justamente por isso que o teste existe: da próxima vez pode não ser. Foto de
  // atleta ou de treinador REAL num repositório PÚBLICO é irreversível, porque o
  // histórico do git preserva o arquivo mesmo depois da remoção.
  //
  // A lista é dos diretórios que a aplicação escreve em execução, e cresce junto
  // com `.gitignore`.
  // ==========================================================================
  it('nenhum diretório de armazenamento em execução está rastreado', () => {
    const DE_EXECUCAO = [
      'uploads/', 'uploads-test/', 'uploads-preview/', 'uploads-gate/',
      'uploads-homolog/', 'uploads-recuperado/', 'uploads-desastre/'
    ];
    const rastreados = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const dentro = rastreados.filter(caminho => DE_EXECUCAO.some(dir => caminho.startsWith(dir)));

    expect(dentro, `objeto de execução rastreado: ${dentro.slice(0, 5).join(', ')}. `
      + 'Remova com `git rm -r --cached <dir>` e confira se algum arquivo tem dado real — '
      + 'o histórico do git preserva o que foi empurrado.')
      .toEqual([]);
  });

  it('o `.gitignore` recusa o armazenamento do preview', () => {
    const ignorados = readFileSync('.gitignore', 'utf8');
    expect(ignorados).toContain('uploads-preview/');
  });

  it('o `.gitignore` recusa backup de mutação', () => {
    // Sem a regra, o próximo `git add -A` durante uma rodada repete o acidente.
    const ignorados = readFileSync('.gitignore', 'utf8');
    expect(ignorados).toContain('*.mutante-bak');
  });

  it('o padrão daqui e o da CI continuam sendo o mesmo', () => {
    // Se alguém afrouxar um dos dois, o outro precisa acusar. Sem esta
    // conferência, a suíte local passaria a mentir sobre o que a CI exige.
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const linha = ci.split('\n').find(l => l.includes("PADRAO='"));
    expect(linha, 'o passo de segredo sumiu da CI').toBeTruthy();
    const daCi = linha.slice(linha.indexOf("'") + 1, linha.lastIndexOf("'"));
    expect(daCi).toBe(PADRAO_SEGREDO.source);
  });
});

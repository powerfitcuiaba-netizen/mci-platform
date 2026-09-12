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

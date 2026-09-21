import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve, relative } from 'node:path';

// ============================================================================
// QUANTO DA INTERFACE AINDA NÃO PASSA PELO DICIONÁRIO.
//
// POR QUE ESTE ARQUIVO EXISTE
//
// A camada de idioma está de pé e a navegação, a barra de topo e todos os
// rótulos de enum passam por ela. O CORPO das telas — 15 páginas, cerca de
// onze mil linhas de JSX — ainda tem texto em português escrito direto no
// componente. Dizer "a interface está traduzida" seria falso; dizer "falta um
// pouco" seria vago.
//
// Este teste transforma a pergunta num NÚMERO, e o número numa trava: ele
// conta as strings visíveis que ainda não passam por `t()`, e reprova se a
// conta CRESCER. Traduzir mais faz o número cair e o teto ser apertado;
// escrever texto novo em português direto na tela faz o teste reprovar antes
// de o texto chegar ao ar.
//
// É o oposto de uma meta: é um limite que só anda para baixo.
// ============================================================================

const RAIZ = resolve(import.meta.dirname, '..');

// Onde o texto visível mora. Testes e o laboratório de experiência ficam fora:
// o primeiro não é interface, o segundo é ferramenta interna de QA.
const ARQUIVOS = globSync('**/*.{jsx,js}', { cwd: RAIZ })
  .filter(caminho => !caminho.includes('.test.'))
  .filter(caminho => !caminho.endsWith('experienceLab.jsx'))
  .filter(caminho => !caminho.endsWith('lib/idioma.jsx'))
  .map(caminho => resolve(RAIZ, caminho));

// Texto entre tags e os atributos que o usuário lê. Começar com maiúscula
// acentuada é o filtro barato que separa frase de identificador: `className`,
// `onClick` e `data-testid` não entram.
const PADROES = [
  />\s*([A-ZÁÂÃÉÊÍÓÔÕÚÇ][^<>{}\n]{2,80})\s*</g,
  /(?:aria-label|title|placeholder)="([^"]{3,80})"/g
];

function visiveisSemTraducao(fonte) {
  const achados = [];
  for (const padrao of PADROES) {
    for (const casamento of fonte.matchAll(padrao)) {
      const texto = casamento[1].trim();
      // Já traduzido, ou não é texto de interface.
      if (!texto || texto.startsWith('{') || /^[A-Z_]+$/.test(texto)) continue;
      achados.push(texto);
    }
  }
  return achados;
}

describe('cobertura de tradução da interface', () => {
  // O TETO É O ESTADO MEDIDO, e não uma meta. Baixá-lo é o trabalho; subi-lo
  // exige explicar por quê, num commit, para quem revisa.
  //
  // MEDIDO HOJE: 626 strings visíveis ainda fora do dicionário, sendo 152 em
  // `adminPlatform.jsx`, 105 em `adminEvent.jsx`, 58 em `socialPages.jsx` e
  // 57 em `publicPages.jsx` — as quatro telas mais densas. O teto fica a
  // poucas unidades acima desses números de propósito: folga grande não trava
  // nada.
  const TETO_POR_ARQUIVO = 155;
  const TETO_TOTAL = 630;

  it('nenhum arquivo passa do teto de texto ainda não traduzido', () => {
    const acima = [];
    for (const caminho of ARQUIVOS) {
      const quantos = visiveisSemTraducao(readFileSync(caminho, 'utf8')).length;
      if (quantos > TETO_POR_ARQUIVO) acima.push(`${relative(RAIZ, caminho)}: ${quantos}`);
    }
    expect(acima, 'arquivos acima do teto de strings sem tradução').toEqual([]);
  });

  it('o total não cresce', () => {
    const total = ARQUIVOS
      .reduce((soma, caminho) => soma + visiveisSemTraducao(readFileSync(caminho, 'utf8')).length, 0);

    // A mensagem carrega o número para que ele apareça no log da CI mesmo
    // quando o teste passa — é o relatório de cobertura, e não só um gate.
    expect(total, `strings visíveis ainda fora do dicionário: ${total} (teto ${TETO_TOTAL})`)
      .toBeLessThanOrEqual(TETO_TOTAL);
  });

  it('a navegação e a barra de topo JÁ passam pelo dicionário', () => {
    const app = readFileSync(resolve(RAIZ, 'App.jsx'), 'utf8');
    // O que foi traduzido nesta fase não pode voltar atrás sem o teste notar.
    for (const chave of ['navegacao.principal', 'topo.notificacoes', 'topo.sair',
      'grupo.plataforma', 'grupo.administracao']) {
      expect(app, `${chave} saiu do dicionário`).toContain(`t('${chave}')`);
    }
    expect(app).toContain('rotuloDoItem(item)');
    expect(app).toContain('<SeletorDeIdioma />');
  });
});

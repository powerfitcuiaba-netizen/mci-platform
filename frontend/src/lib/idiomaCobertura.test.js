import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve, relative } from 'node:path';

// ============================================================================
// QUANTO DA INTERFACE AINDA NÃO PASSA PELO DICIONÁRIO.
//
// POR QUE ESTE ARQUIVO EXISTE
//
// Quando este arquivo nasceu, a camada de idioma estava de pé e o CORPO das
// telas — 15 páginas, cerca de onze mil linhas de JSX — ainda tinha 626
// strings em português escritas direto no componente. Dizer "a interface está
// traduzida" seria falso; dizer "falta um pouco" seria vago. Então o teste
// transformou a pergunta num NÚMERO e o número numa trava que só andava para
// baixo.
//
// O número chegou a zero. A trava continua, e agora o que ela protege é o
// contrário: nenhum texto novo entra na tela sem passar pelo dicionário.
// Escrever `<h2>Relatório</h2>` reprova antes de chegar ao ar.
//
// O que NÃO passa pelo dicionário está em `EXCECOES_AUDITADAS`, uma a uma,
// com o motivo escrito.
// ============================================================================

const RAIZ = resolve(import.meta.dirname, '..');

// Onde o texto visível mora. Testes e o laboratório de experiência ficam fora:
// o primeiro não é interface, o segundo é ferramenta interna de QA.
const ARQUIVOS = globSync('**/*.{jsx,js}', { cwd: RAIZ })
  .filter(caminho => !caminho.includes('.test.'))
  .filter(caminho => !caminho.endsWith('experienceLab.jsx'))
  .filter(caminho => !caminho.endsWith('lib/idioma.jsx'))
  // Os dicionários SÃO a tradução. Contá-los seria cobrar que a tradução
  // passasse por si mesma — e o `<b>` de uma frase com destaque casa com o
  // padrão de texto entre tags.
  .filter(caminho => !caminho.includes('lib/idiomas/'))
  .map(caminho => resolve(RAIZ, caminho));

// ==========================================================================
// O QUE FICA EM PORTUGUÊS DE PROPÓSITO, E POR QUÊ.
//
// Esta lista é curta e cada linha dela foi decidida uma a uma. Ela não é
// válvula de escape: quem acrescentar uma entrada aqui precisa explicar, no
// commit, por que aquele texto não é texto de interface.
//
// NOME OFICIAL não se traduz. "Campeonato Brasileiro Muscle Contest" é o nome
// do campeonato, e "MCI Platform" é o nome do produto — em inglês e em
// espanhol continuam sendo os mesmos. Traduzi-los seria renomear o evento.
//
// MÁSCARA DE FORMATO não é frase. "000.000.000-00" é a FORMA do CPF,
// "(65) 99999-0000" a do telefone, "MCI-XXXXXXXXXXXX" a da credencial. Elas
// mostram onde vai cada dígito; não há o que traduzir.
//
// ATALHO DE TECLADO é o que está escrito na tecla.
// ==========================================================================
const EXCECOES_AUDITADAS = new Set([
  // Nome oficial do produto e do campeonato.
  'MCI Platform',
  'Muscle Contest',
  'Campeonato Brasileiro Muscle Contest',
  // Máscaras de formato.
  '000.000.000-00',
  '(65) 99999-0000',
  '78000-000',
  'MCI-XXXXXXXXXXXX',
  'ATE163',
  'FED-MT',
  // Atalho de teclado.
  'Ctrl K'
]);

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
      if (EXCECOES_AUDITADAS.has(texto)) continue;
      // Trecho de CÓDIGO que o padrão pega por acidente: `a > b && (` tem um
      // `>` seguido de maiúscula. Não é texto, e não há o que traduzir.
      if (/[&|]{2}|=>|\)\s*$|_[A-Z]/.test(texto)) continue;
      achados.push(texto);
    }
  }
  return achados;
}

describe('cobertura de tradução da interface', () => {
  // O TETO CHEGOU A ZERO, E É POR ISSO QUE ELE PASSA A SER UMA TRAVA DE
  // VERDADE.
  //
  // Começou em 626 — 152 em `adminPlatform.jsx`, 105 em `adminEvent.jsx`, 58
  // em `socialPages.jsx`, 57 em `publicPages.jsx` e o resto espalhado. Todas
  // foram para o dicionário, nos três idiomas.
  //
  // Com teto zero, qualquer texto novo escrito direto na tela reprova ANTES
  // de chegar ao ar. Não é meta cumprida: é a porta fechada. Quem precisar
  // abrir uma exceção passa por `EXCECOES_AUDITADAS`, que exige nome e
  // motivo — e não por um número que sobe em silêncio.
  const TETO_POR_ARQUIVO = 0;
  const TETO_TOTAL = 0;

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

  // SEM ESTE TESTE, O TETO ZERO PODERIA SER MENTIRA.
  //
  // Um detector que não detecta nada também devolve zero — e um zero desses
  // aprovaria a tela inteira em português. Aqui o detector é posto à prova
  // contra texto que ELE TEM de pegar, e contra o que ele tem de ignorar.
  it('o detector ainda detecta: texto novo em português seria pego', () => {
    const telaNova = `
      <h2>Relatório mensal</h2>
      <button type="button" aria-label="Exportar planilha">…</button>
      <p>{t('plataforma.exportar')}</p>
      <span>MCI Platform</span>
    `;

    const achados = visiveisSemTraducao(telaNova);
    expect(achados, 'o texto solto precisa ser pego').toContain('Relatório mensal');
    expect(achados, 'o atributo solto também').toContain('Exportar planilha');
    expect(achados, 'o que já passa por t() não entra na conta').not.toContain('plataforma.exportar');
    expect(achados, 'nome oficial é exceção auditada').not.toContain('MCI Platform');
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

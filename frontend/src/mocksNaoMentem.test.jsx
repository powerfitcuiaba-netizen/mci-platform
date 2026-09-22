import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ==========================================================================
// O MOCK NÃO PODE INVENTAR UMA API QUE NÃO EXISTE.
//
// POR QUE ISTO VIROU TESTE
//
// `adminMensagens.jsx` lia `const { usuario } = useAuth()`. O contexto expõe
// `user`. A tela recebia `undefined`, a organização saía nula e a publicação
// era recusada com 400 — em produção, na cara do operador.
//
// A suíte daquela tela estava VERDE, com quatorze casos passando, porque o
// mock devolvia exatamente o nome errado que a tela pedia. Os dois estavam
// errados juntos, e concordar entre si foi confundido com estar certo.
//
// Quem encontrou foi o gate em Chromium, contra a pilha real. Um gate de
// navegador é caro e lento; este teste é barato e rápido, e fecha a mesma
// porta: se um mock de `useAuth` declarar uma chave que o contexto de verdade
// não tem, a suíte reprova aqui, apontando o arquivo.
// ==========================================================================

// As chaves que `AuthContext` realmente expõe. Lidas do fonte, e não
// escritas à mão: uma lista copiada envelheceria sozinha.
function chavesDoContexto() {
  const fonte = readFileSync(path.resolve('src/AuthContext.jsx'), 'utf8');
  const linha = fonte.match(/const value = useMemo\(\(\) => \(\{([^}]*)\}\)/);
  if (!linha) throw new Error('não encontrei o objeto de valor de AuthContext');
  return new Set(
    linha[1].split(',')
      .map(pedaco => pedaco.split(':')[0].trim())
      .filter(Boolean)
  );
}

function arquivosDeTeste(diretorio) {
  const achados = [];
  for (const entrada of readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) achados.push(...arquivosDeTeste(caminho));
    else if (/\.test\.jsx?$/.test(entrada.name)) achados.push(caminho);
  }
  return achados;
}

describe('os mocks de AuthContext falam a língua do contexto', () => {
  it('nenhum teste declara uma chave que `useAuth` não devolve', () => {
    const permitidas = chavesDoContexto();
    expect(permitidas.has('user')).toBe(true);

    const invencoes = [];

    for (const arquivo of arquivosDeTeste(path.resolve('src'))) {
      const fonte = readFileSync(arquivo, 'utf8');
      // Casa `useAuth: () => ({ ... })` e olha só as chaves do primeiro nível.
      for (const casamento of fonte.matchAll(/useAuth:\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)/g)) {
        const corpo = casamento[1];
        // Chave de primeiro nível: um identificador seguido de `:`, ignorando
        // o que estiver dentro de objetos aninhados.
        let profundidade = 0;
        let atual = '';
        const pedacos = [];
        for (const caractere of corpo) {
          if (caractere === '{' || caractere === '[' || caractere === '(') profundidade += 1;
          if (caractere === '}' || caractere === ']' || caractere === ')') profundidade -= 1;
          if (caractere === ',' && profundidade === 0) { pedacos.push(atual); atual = ''; continue; }
          atual += caractere;
        }
        pedacos.push(atual);

        for (const pedaco of pedacos) {
          const chave = pedaco.split(':')[0].trim();
          if (!chave || !/^[A-Za-z_$][\w$]*$/.test(chave)) continue;
          if (!permitidas.has(chave)) {
            invencoes.push(`${path.relative(process.cwd(), arquivo)} → "${chave}"`);
          }
        }
      }
    }

    expect(
      invencoes,
      `mock declara chave que AuthContext não expõe (${[...permitidas].join(', ')}):\n  ${invencoes.join('\n  ')}`
    ).toEqual([]);
  });
});

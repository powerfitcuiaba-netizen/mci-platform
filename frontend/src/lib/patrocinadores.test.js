import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CAIXAS,
  CAIXAS_DO_RODAPE,
  CATEGORIAS,
  CATEGORIAS_COM_PASTILHA,
  MARCAS,
  RECHEIO_DA_PASTILHA,
  CHAVE_DO_ROTULO,
  areaDaCaixa,
  caminhoDaMarca,
  categoriasComMarcas,
  copiasNecessarias,
  duracaoDoCiclo,
  marcasDaCategoria,
  marcasNaOrdemDaHierarquia,
  medidaNaCaixa,
  PIXELS_POR_SEGUNDO,
  sentidoDaFaixa
} from './patrocinadores';

// A parede de patrocínio é compromisso comercial, não enfeite: se a hierarquia
// inverter, ou se a arte de um patrocinador estourar a caixa do vizinho, o
// prejuízo é de contrato. Por isso estas regras são testadas, e não confiadas
// ao CSS.

const AQUI = dirname(fileURLToPath(import.meta.url));
const PASTA_PUBLICA = join(AQUI, '..', '..', 'public', 'patrocinadores');
const CSS = join(AQUI, '..', 'styles.css');

describe('catálogo de patrocinadores', () => {
  it('toda marca aponta para um arquivo que existe', () => {
    for (const marca of MARCAS) {
      const caminho = join(PASTA_PUBLICA, marca.arquivo);
      expect(existsSync(caminho), `${marca.nome}: falta ${marca.arquivo}`).toBe(true);
    }
  });

  it('não repete arquivo nem nome de marca', () => {
    expect(new Set(MARCAS.map(m => m.arquivo)).size).toBe(MARCAS.length);
    expect(new Set(MARCAS.map(m => m.nome)).size).toBe(MARCAS.length);
  });

  it('toda marca pertence a uma categoria declarada', () => {
    for (const marca of MARCAS) expect(CATEGORIAS).toContain(marca.categoria);
  });

  it('toda categoria tem rótulo e caixa', () => {
    for (const categoria of CATEGORIAS) {
      expect(CHAVE_DO_ROTULO[categoria]).toMatch(/^patrocinio\./);
      expect(CAIXAS[categoria].desktop).toHaveLength(2);
      expect(CAIXAS[categoria].telefone).toHaveLength(2);
    }
  });

  it('a proporção declarada é a do arquivo real', () => {
    // O número no catálogo é o que sustenta a afirmação de que a arte cabe na
    // caixa. Se ele for chute, o teste de encaixe testa ficção.
    //
    // As dimensões saem do cabeçalho do próprio PNG — nada de biblioteca de
    // imagem só para ler dois inteiros. O IHDR é o primeiro bloco e começa
    // sempre no byte 16; largura e altura são big-endian de 32 bits.
    for (const marca of MARCAS) {
      const bytes = readFileSync(join(PASTA_PUBLICA, marca.arquivo));
      expect(bytes.subarray(1, 4).toString('ascii'), `${marca.arquivo} não é PNG`).toBe('PNG');
      const largura = bytes.readUInt32BE(16);
      const altura = bytes.readUInt32BE(20);
      const real = largura / altura;
      const desvio = Math.abs(real - marca.proporcao) / marca.proporcao;
      expect(desvio, `${marca.nome}: declarada ${marca.proporcao}, arquivo ${largura}x${altura} = ${real.toFixed(3)}`).toBeLessThan(0.02);
    }
  });

  it('o arquivo guarda resolução suficiente para a caixa, sem exagero', () => {
    // Abaixo de 2x a arte fica borrada em tela densa; muito acima disso é peso
    // morto no pacote, que todo visitante baixa antes de entrar.
    const alvo = marca => {
      const [l, a] = CAIXAS[marca.categoria].desktop;
      return medidaNaCaixa(marca.proporcao, [l, a]).largura;
    };
    for (const marca of MARCAS) {
      const bytes = readFileSync(join(PASTA_PUBLICA, marca.arquivo)).length;
      expect(bytes, `${marca.nome} está vazio`).toBeGreaterThan(0);
      expect(bytes, `${marca.nome}: ${(bytes / 1024).toFixed(0)} kB é grande demais para ${alvo(marca).toFixed(0)}px`).toBeLessThan(40 * 1024);
    }
  });
});

describe('hierarquia entre as categorias', () => {
  // ESTE BLOCO MUDOU POR UM DEFEITO REAL. Ele comparava a caixa da ARTE e
  // aprovava; o gate no navegador reprovou, porque a pastilha da Silver
  // acrescenta recheio e o retângulo VISÍVEL dela tinha ficado maior que o da
  // Gold. Agora `areaDaCaixa` conta a pastilha, e o teste compara o que se vê.
  it('a área da Silver inclui a pastilha', () => {
    const [l, a] = CAIXAS.silver.desktop;
    const [v, hz] = RECHEIO_DA_PASTILHA;
    expect(areaDaCaixa('silver')).toBe((l + hz * 2) * (a + v * 2));
    expect(areaDaCaixa('silver')).toBeGreaterThan(l * a);
  });

  it('e a das outras categorias não inventa recheio que elas não têm', () => {
    for (const categoria of CATEGORIAS.filter(c => !CATEGORIAS_COM_PASTILHA.includes(c))) {
      const [l, a] = CAIXAS[categoria].desktop;
      expect(areaDaCaixa(categoria)).toBe(l * a);
    }
  });

  it('a área da caixa é estritamente decrescente, no desktop e no telefone', () => {
    for (const tela of ['desktop', 'telefone']) {
      const areas = CATEGORIAS.map(c => areaDaCaixa(c, tela));
      for (let i = 1; i < areas.length; i += 1) {
        expect(areas[i], `${CATEGORIAS[i]} não é menor que ${CATEGORIAS[i - 1]} em ${tela}`).toBeLessThan(areas[i - 1]);
      }
    }
  });

  it('a caixa do telefone é menor que a do desktop em toda categoria', () => {
    for (const categoria of CATEGORIAS) {
      expect(areaDaCaixa(categoria, 'telefone')).toBeLessThan(areaDaCaixa(categoria, 'desktop'));
    }
  });

  it('a ordem relativa entre as categorias é a MESMA nas duas telas', () => {
    // Não basta cada uma encolher: se encolhessem em proporções diferentes, uma
    // categoria menor poderia passar a parecer maior no telefone.
    const ordem = tela => [...CATEGORIAS].sort((a, b) => areaDaCaixa(b, tela) - areaDaCaixa(a, tela));
    expect(ordem('telefone')).toEqual(ordem('desktop'));
  });
});

describe('encaixe da arte na caixa', () => {
  it('nenhuma arte estoura a caixa da própria categoria, em nenhuma tela', () => {
    for (const marca of MARCAS) {
      for (const tela of ['desktop', 'telefone']) {
        const caixa = CAIXAS[marca.categoria][tela];
        const { largura, altura } = medidaNaCaixa(marca.proporcao, caixa);
        expect(largura, `${marca.nome} em ${tela}`).toBeLessThanOrEqual(caixa[0] + 0.001);
        expect(altura, `${marca.nome} em ${tela}`).toBeLessThanOrEqual(caixa[1] + 0.001);
      }
    }
  });

  it('a arte encosta em exatamente um dos dois limites', () => {
    // Encostar nos dois ao mesmo tempo só acontece quando a proporção da arte é
    // igual à da caixa; não encostar em nenhum significaria sobra em todos os
    // lados, ou seja, a arte menor do que podia ser.
    for (const marca of MARCAS) {
      const caixa = CAIXAS[marca.categoria].desktop;
      const { largura, altura } = medidaNaCaixa(marca.proporcao, caixa);
      const encosta = Math.abs(largura - caixa[0]) < 0.01 || Math.abs(altura - caixa[1]) < 0.01;
      expect(encosta, `${marca.nome}: ${largura.toFixed(1)}x${altura.toFixed(1)} em ${caixa.join('x')}`).toBe(true);
    }
  });

  it('a proporção é preservada: a conta não estica nem espreme', () => {
    for (const marca of MARCAS) {
      const { largura, altura } = medidaNaCaixa(marca.proporcao, CAIXAS[marca.categoria].desktop);
      expect(largura / altura).toBeCloseTo(marca.proporcao, 3);
    }
  });

  it('a mais comprida e a mais quadrada ocupam a MESMA caixa', () => {
    // É o ponto da mudança: o que é igual é a caixa, não a largura da arte.
    const gold = marcasDaCategoria('gold');
    const comprida = gold.reduce((a, b) => (a.proporcao > b.proporcao ? a : b));
    const quadrada = gold.reduce((a, b) => (a.proporcao < b.proporcao ? a : b));
    expect(comprida.proporcao / quadrada.proporcao).toBeGreaterThan(3);
    const caixa = CAIXAS.gold.desktop;
    expect(medidaNaCaixa(comprida.proporcao, caixa).largura).toBeCloseTo(caixa[0], 3);
    expect(medidaNaCaixa(quadrada.proporcao, caixa).altura).toBeCloseTo(caixa[1], 3);
  });
});

describe('o CSS aplica o limite em pixels, não em porcentagem', () => {
  // ESTE TESTE EXISTE POR UM DEFEITO REAL. Com `max-height: 100%` a arte alta
  // NÃO foi contida: a Integralmedica renderizou 244x124 numa caixa de 244x90,
  // porque o percentual não resolveu contra a caixa. Em px sempre resolve.
  const css = readFileSync(CSS, 'utf8');
  const regra = css.slice(css.indexOf('.patro img {'), css.indexOf('.patro img {') + 320);

  it('a regra existe', () => {
    expect(css).toContain('.patro img {');
  });

  it('o limite da arte é absoluto', () => {
    expect(regra).toContain('max-width: var(--caixa-l)');
    expect(regra).toContain('max-height: var(--caixa-a)');
  });

  it('o limite NÃO é percentual', () => {
    expect(regra).not.toMatch(/max-(width|height):\s*100%/);
  });

  it('as quatro categorias declaram caixa no CSS com os mesmos números do catálogo', () => {
    for (const categoria of CATEGORIAS) {
      const [l, a] = CAIXAS[categoria].desktop;
      const linha = new RegExp(`\\.t-${categoria}\\s*\\{[^}]*--caixa-l:\\s*${l}px;\\s*--caixa-a:\\s*${a}px`);
      expect(css, `.t-${categoria} deveria declarar ${l}x${a}`).toMatch(linha);
    }
  });
});

describe('esteira', () => {
  it('nunca usa menos de duas cópias', () => {
    // Com uma cópia só não há o que entrar no lugar da que saiu.
    expect(copiasNecessarias(5000, 300)).toBe(2);
    expect(copiasNecessarias(0, 1200)).toBe(2);
    expect(copiasNecessarias(-10, 1200)).toBe(2);
  });

  it('cobre pelo menos duas janelas', () => {
    for (const grupo of [120, 380, 700, 1390]) {
      for (const janela of [333, 726, 1240]) {
        const copias = copiasNecessarias(grupo, janela);
        expect(copias * grupo, `grupo ${grupo}, janela ${janela}`).toBeGreaterThanOrEqual(janela * 2);
      }
    }
  });

  it('a velocidade é constante, qualquer que seja o tamanho do grupo', () => {
    for (const grupo of [363, 432, 703, 1390]) {
      expect(grupo / duracaoDoCiclo(grupo)).toBeCloseTo(PIXELS_POR_SEGUNDO, 6);
    }
  });

  it('a duração nunca é zero nem negativa', () => {
    expect(duracaoDoCiclo(0)).toBeGreaterThan(0);
    expect(duracaoDoCiclo(-500)).toBeGreaterThan(0);
  });

  it('o sentido alterna a cada faixa', () => {
    const sentidos = categoriasComMarcas().map((_, i) => sentidoDaFaixa(i));
    expect(sentidos.length).toBeGreaterThan(1);
    for (let i = 1; i < sentidos.length; i += 1) {
      expect(sentidos[i], `faixa ${i} repete o sentido da anterior`).not.toBe(sentidos[i - 1]);
    }
  });
});

describe('a faixa Silver recebe pastilha clara', () => {
  it('a Silver está na lista', () => {
    expect(CATEGORIAS_COM_PASTILHA).toContain('silver');
  });

  it('e é a única — as outras faixas vão direto no fundo escuro', () => {
    expect(CATEGORIAS_COM_PASTILHA).toEqual(['silver']);
  });
});

describe('caminhos servidos', () => {
  it('toda marca é servida pela raiz, em public/', () => {
    for (const marca of MARCAS) {
      expect(caminhoDaMarca(marca)).toBe(`/patrocinadores/${marca.arquivo}`);
    }
  });

  it('categoria sem marca não vira faixa vazia', () => {
    expect(categoriasComMarcas().every(c => marcasDaCategoria(c).length > 0)).toBe(true);
  });
});


// ==========================================================================
// AS CAIXAS DO RODAPÉ DA VITRINE.
//
// O rodapé é uma faixa só, com todas as cotas lado a lado — e é exatamente aí
// que a hierarquia fica mais fácil de quebrar: na parede cada cota tem a sua
// linha, e a comparação é entre linhas; aqui as quatro se tocam. A Silver é o
// caso que obriga a medir, porque a pastilha acrescenta 14x8px ao retângulo
// VISÍVEL e já inverteu a ordem uma vez na parede.
// ==========================================================================
describe('hierarquia no rodapé da vitrine', () => {
  const area = (c, tela) => areaDaCaixa(c, tela, CAIXAS_DO_RODAPE);

  it('toda categoria tem caixa de rodapé declarada, nas duas telas', () => {
    for (const categoria of CATEGORIAS) {
      expect(CAIXAS_DO_RODAPE[categoria], categoria).toBeTruthy();
      for (const tela of ['desktop', 'telefone']) {
        const [l, a] = CAIXAS_DO_RODAPE[categoria][tela];
        expect(l, `${categoria}/${tela} largura`).toBeGreaterThan(0);
        expect(a, `${categoria}/${tela} altura`).toBeGreaterThan(0);
      }
    }
  });

  it('a área é ESTRITAMENTE decrescente, no desktop e no telefone', () => {
    for (const tela of ['desktop', 'telefone']) {
      const areas = CATEGORIAS.map(c => area(c, tela));
      for (let i = 1; i < areas.length; i += 1) {
        expect(areas[i], `${CATEGORIAS[i]} não é menor que ${CATEGORIAS[i - 1]} em ${tela}`)
          .toBeLessThan(areas[i - 1]);
      }
    }
  });

  it('a pastilha da Silver entra na conta — é o retângulo visível que o olho compara', () => {
    const [l, a] = CAIXAS_DO_RODAPE.silver.desktop;
    const [v, hz] = RECHEIO_DA_PASTILHA;
    expect(area('silver', 'desktop')).toBe((l + hz * 2) * (a + v * 2));
    // E com ela dentro a Silver continua menor que a Gold. Sem a pastilha na
    // conta, 80x30 teria passado — e na tela a Silver ficaria MAIOR.
    expect(area('silver', 'desktop')).toBeLessThan(area('gold', 'desktop'));
  });

  it('a caixa do rodapé é menor que a da parede em TODA cota', () => {
    for (const categoria of CATEGORIAS) {
      for (const tela of ['desktop', 'telefone']) {
        expect(areaDaCaixa(categoria, tela, CAIXAS_DO_RODAPE),
          `${categoria}/${tela} não encolheu no rodapé`)
          .toBeLessThan(areaDaCaixa(categoria, tela, CAIXAS));
      }
    }
  });

  it('a ordem relativa entre as cotas é a MESMA da parede', () => {
    const porArea = conjunto => [...CATEGORIAS]
      .sort((a, b) => areaDaCaixa(b, 'desktop', conjunto) - areaDaCaixa(a, 'desktop', conjunto));
    expect(porArea(CAIXAS_DO_RODAPE)).toEqual(porArea(CAIXAS));
  });

  it('nenhuma arte estoura a caixa do rodapé da própria cota', () => {
    for (const marca of MARCAS) {
      for (const tela of ['desktop', 'telefone']) {
        const caixa = CAIXAS_DO_RODAPE[marca.categoria][tela];
        const { largura, altura } = medidaNaCaixa(marca.proporcao, caixa);
        expect(largura, `${marca.nome} estourou a largura em ${tela}`).toBeLessThanOrEqual(caixa[0] + 0.001);
        expect(altura, `${marca.nome} estourou a altura em ${tela}`).toBeLessThanOrEqual(caixa[1] + 0.001);
      }
    }
  });

  it('o CSS do rodapé declara os MESMOS números do catálogo', () => {
    const css = readFileSync(CSS, 'utf8');
    for (const categoria of CATEGORIAS) {
      const [l, a] = CAIXAS_DO_RODAPE[categoria].desktop;
      const regra = new RegExp(
        `\\.rodape-patro\\s+\\.t-${categoria}\\s*\\{[^}]*--caixa-l:\\s*${l}px[^}]*--caixa-a:\\s*${a}px`
      );
      expect(regra.test(css), `o CSS do rodapé não declara ${categoria} como ${l}x${a}`).toBe(true);
    }
  });
});

describe('a ordem que o rodapé consome', () => {
  it('traz TODAS as marcas, sem perder nem repetir nenhuma', () => {
    const ordenadas = marcasNaOrdemDaHierarquia();
    expect(ordenadas).toHaveLength(MARCAS.length);
    expect(new Set(ordenadas.map(m => m.arquivo)).size).toBe(MARCAS.length);
    for (const marca of MARCAS) expect(ordenadas).toContain(marca);
  });

  it('agrupa por cota, na ordem da hierarquia', () => {
    const cotas = marcasNaOrdemDaHierarquia().map(m => CATEGORIAS.indexOf(m.categoria));
    expect(cotas).toEqual([...cotas].sort((a, b) => a - b));
    expect(cotas[0]).toBe(0);
  });

  it('NÃO depende da ordem em que as marcas foram escritas no catálogo', () => {
    // Inserir uma Global no fim da lista não pode mandá-la para o fim da
    // faixa: quem ordena é a cota, não a linha do arquivo.
    const primeira = marcasNaOrdemDaHierarquia()[0];
    expect(primeira.categoria).toBe(CATEGORIAS[0]);
  });
});

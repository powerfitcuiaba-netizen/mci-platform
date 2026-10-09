// A APRESENTAÇÃO da parede de patrocínio — e, desde a migração para o banco,
// SÓ a apresentação.
//
// O QUE MUDOU, E O QUE FICOU
//
// `MARCAS`, abaixo, FOI a única lista de patrocinadores do produto. Hoje a
// fonte é o catálogo `OfficialSponsor`, servido por `/public/sponsors`: a
// parede da entrada e a esteira do rodapé leem de lá, por
// `lib/catalogoDePatrocinio.js`. Trocar um patrocinador deixou de exigir
// deploy, que era o ponto.
//
// A LISTA CONTINUA AQUI POR UM MOTIVO SÓ: ela é a ORIGEM da migração. O script
// `scripts/provisionar-patrocinadores-oficiais.js` a importa para criar as 15
// linhas e subir as 15 artes de `public/patrocinadores/` no primeiro deploy
// desta versão. Nenhuma tela a consome — há teste que reprova se voltar a
// consumir —, e apagá-la agora tiraria a rede de segurança da migração antes
// de ela ter rodado em produção.
//
// O QUE ESTE ARQUIVO AINDA DECIDE é layout, não dado: o tamanho da caixa de
// cada nível, a pastilha da Silver, o rótulo, a velocidade da esteira. Isso
// NÃO vai para o banco — é desenho, muda com o CSS, e um campo de tamanho por
// linha deixaria a hierarquia comercial à mercê de um número digitado errado.
//
// A ordem das categorias aqui é a ordem na tela, e a hierarquia comercial é a
// razão entre as caixas — não um apelido, não uma classe de CSS solta.
//
// POR QUE CAIXA IGUAL, E NÃO LARGURA IGUAL NEM ALTURA IGUAL
//
// As proporções destas marcas vão de 1,00:1 (Instituto Lapidare) a 10,61:1
// (Cimerian) — dez vezes mais comprida. Não existe uma largura única, nem uma
// altura única, que sirva para as duas: largura igual faria a Cimerian virar um
// fio de 23px de altura ao lado de um quadrado de 146px; altura igual faria a
// Cimerian ocupar 573px de linha.
//
// Por isso o que é igual é a CAIXA: toda marca da mesma categoria recebe o
// mesmo retângulo, e a arte encaixa dentro dele na própria proporção. Quem é
// comprida encosta na largura e sobra ar em cima e embaixo; quem é quadrada
// encosta na altura e sobra ar dos lados. Mesmo espaço para todos, nenhuma arte
// esticada ou espremida.
//
// O limite é aplicado em PIXELS, não em porcentagem: `max-height: 100%` não
// contém a arte (a Integralmedica saiu 244x124 numa caixa de 244x90, porque o
// percentual não resolveu contra a caixa). Está em styles.css, com o motivo.
//
// NENHUMA ARTE FOI EDITADA. Os arquivos em public/patrocinadores/ são o recorte
// da margem vazia mais redimensionamento proporcional. Nada foi recolorido,
// cortado no desenho, espremido ou renomeado.

/** As categorias, da maior para a menor. A ordem É a hierarquia. */
export const CATEGORIAS = Object.freeze(['global', 'diamante', 'gold', 'silver']);

/**
 * As caixas, em pixels de CSS.
 *
 * `telefone` entra abaixo de 480px de largura de tela. A razão entre as
 * categorias é a mesma nos dois conjuntos, de propósito: a ordem de tamanho
 * entre as categorias NUNCA inverte, e há um teste que reprova se inverter.
 */
export const CAIXAS = Object.freeze({
  global: { desktop: [244, 90], telefone: [190, 70] },
  diamante: { desktop: [188, 69], telefone: [146, 54] },
  gold: { desktop: [146, 54], telefone: [114, 42] },
  silver: { desktop: [97, 36], telefone: [72, 27] }
});

/**
 * O RECHEIO DA PASTILHA, em pixels: [vertical, horizontal].
 *
 * Isto está no modelo, e não só no CSS, por causa de um defeito real. A
 * hierarquia era conferida sobre a caixa da ARTE, e a pastilha da Silver
 * acrescenta recheio em volta — o retângulo que aparece na tela ficou MAIOR
 * que o da Gold, invertendo a hierarquia, e o teste de unidade aprovou porque
 * media a caixa interna. Quem pegou foi o gate no navegador.
 *
 * Agora a conta de área usa o retângulo VISÍVEL, que é o que o olho compara.
 */
export const RECHEIO_DA_PASTILHA = Object.freeze([4, 7]);

/**
 * AS CAIXAS DO RODAPÉ — a mesma hierarquia, num terço do espaço.
 *
 * A parede da entrada tem a página inteira; o rodapé da vitrine divide a tela
 * com ranking, tabela e ficha de atleta. Reusar as caixas da parede ali faria
 * a faixa comer 90px de altura útil em toda tela pública.
 *
 * O QUE NÃO MUDA É A ORDEM. Os números são menores e mais próximos entre si —
 * numa faixa única, lado a lado, uma razão de 10:1 entre a primeira e a última
 * cota pareceria defeito —, mas a sequência continua ESTRITAMENTE decrescente,
 * com a pastilha da Silver dentro da conta. Há teste que reprova a inversão,
 * nas duas telas, exatamente como já havia para a parede.
 *
 * A Silver é o caso que obriga a medir em vez de chutar: com 80x30 o retângulo
 * VISÍVEL dela (94x38, com a pastilha) ficaria MAIOR que o da Gold (96x35).
 * Por isso ela é 72x26.
 */
export const CAIXAS_DO_RODAPE = Object.freeze({
  global: { desktop: [132, 48], telefone: [104, 38] },
  diamante: { desktop: [112, 41], telefone: [88, 32] },
  gold: { desktop: [96, 35], telefone: [76, 28] },
  silver: { desktop: [72, 26], telefone: [56, 20] }
});

/**
 * A CHAVE do rótulo de cada faixa, não o texto.
 *
 * O rótulo é texto de interface e passa pelo dicionário como qualquer outro.
 * O que NÃO se traduz é o nome da categoria — Global, Diamante, Gold e Silver
 * são os nomes das cotas no contrato (SITEGLOBAL, SITEDIAMANTE, SITEGOLD,
 * SITESILVER). Traduzir "Gold" para "Ouro" renomearia uma cota vendida.
 */
export const CHAVE_DO_ROTULO = Object.freeze({
  global: 'patrocinio.global',
  diamante: 'patrocinio.diamante',
  gold: 'patrocinio.gold',
  silver: 'patrocinio.silver'
});

// A SILVER VAI SOBRE PASTILHA CLARA, e isso não é enfeite: duas das três marcas
// têm tinta PRETA — o texto da Lipoxyderm e o contorno da Muscle Contest
// International. No fundo escuro do sistema elas desapareceriam. A pastilha
// devolve o fundo claro que a arte pressupõe SEM alterar um pixel do arquivo.
// A alternativa seria inverter o preto para branco, o que seria editar a logo.
export const CATEGORIAS_COM_PASTILHA = Object.freeze(['silver']);

/**
 * As marcas.
 *
 * `proporcao` é MEDIDO do arquivo, não declarado à mão: é a caixa da tinta
 * depois do recorte da margem vazia. Serve ao teste que confere se a arte cabe
 * na caixa da categoria, e é o que permite afirmar a medida final sem abrir o
 * navegador.
 */
export const MARCAS = Object.freeze([
  { categoria: 'global', nome: 'Adaptogen Science', arquivo: 'adaptogen-science.png', proporcao: 7.25 },
  { categoria: 'global', nome: 'Max Titanium', arquivo: 'max-titanium.png', proporcao: 3.479 },
  { categoria: 'global', nome: 'Integralmedica', arquivo: 'integralmedica.png', proporcao: 1.971 },
  { categoria: 'global', nome: 'Cimerian', arquivo: 'cimerian.png', proporcao: 10.606 },
  { categoria: 'global', nome: 'New Millen', arquivo: 'new-millen.png', proporcao: 3.657 },

  { categoria: 'diamante', nome: 'Soldiers Nutrition', arquivo: 'soldiers-nutrition.png', proporcao: 3.312 },
  { categoria: 'diamante', nome: 'Imperious Fitness', arquivo: 'imperious-fitness.png', proporcao: 2.894 },

  { categoria: 'gold', nome: 'Muscle World Gym', arquivo: 'muscle-world-gym.png', proporcao: 1.214 },
  { categoria: 'gold', nome: 'Black Skull', arquivo: 'black-skull.png', proporcao: 4.949 },
  { categoria: 'gold', nome: 'MuscleFit Academias', arquivo: 'musclefit-academias.png', proporcao: 4.252 },
  { categoria: 'gold', nome: 'Instituto Lapidare', arquivo: 'instituto-lapidare.png', proporcao: 1 },
  { categoria: 'gold', nome: 'oficial', arquivo: 'oficial.png', proporcao: 3.287 },

  { categoria: 'silver', nome: 'Muscle Contest International', arquivo: 'muscle-contest-international.png', proporcao: 3.556 },
  { categoria: 'silver', nome: 'Lipoxyderm', arquivo: 'lipoxyderm.png', proporcao: 4.149 },
  { categoria: 'silver', nome: 'Tan Masters', arquivo: 'tan-masters.png', proporcao: 1.783 }
]);

/** Onde os arquivos são servidos. Ficam em public/, pela raiz. */
export const PASTA_DAS_MARCAS = '/patrocinadores/';

export const caminhoDaMarca = marca => `${PASTA_DAS_MARCAS}${marca.arquivo}`;

/** As marcas de uma categoria, na ordem declarada. */
export const marcasDaCategoria = categoria => MARCAS.filter(m => m.categoria === categoria);

/** As categorias que têm ao menos uma marca. Faixa vazia não vira linha vazia. */
export const categoriasComMarcas = () => CATEGORIAS.filter(c => marcasDaCategoria(c).length > 0);

/**
 * Como a arte fica dentro da caixa: encosta na largura ou na altura, nunca
 * estoura, nunca distorce. É a mesma conta que o CSS faz com `max-width` e
 * `max-height` em pixels — escrita aqui para poder ser TESTADA sem navegador.
 */
export function medidaNaCaixa(proporcao, [largura, altura]) {
  const porLargura = { l: largura, a: largura / proporcao };
  if (porLargura.a <= altura) return { largura: porLargura.l, altura: porLargura.a };
  return { largura: altura * proporcao, altura };
}

/**
 * A área da caixa de cada categoria. Serve ao teste de hierarquia: a sequência
 * tem de ser ESTRITAMENTE decrescente, no desktop e no telefone.
 *
 * `conjunto` escolhe a parede (padrão) ou o rodapé. A conta é a MESMA para os
 * dois — inclusive a pastilha —, porque a regra de hierarquia é uma só.
 */
export const areaDaCaixa = (categoria, tela = 'desktop', conjunto = CAIXAS) => {
  const [l, a] = conjunto[categoria][tela];
  // A pastilha faz parte do que se vê: comparar sem ela compara a coisa errada.
  if (!CATEGORIAS_COM_PASTILHA.includes(categoria)) return l * a;
  const [v, hz] = RECHEIO_DA_PASTILHA;
  return (l + hz * 2) * (a + v * 2);
};

/**
 * TODAS as marcas, na ordem da hierarquia comercial.
 *
 * É o que o rodapé consome: uma esteira única, Global primeiro, Silver por
 * último. `MARCAS` já está declarado nessa ordem; esta função não confia nisso
 * — ela reordena por categoria, para que inserir uma marca fora de ordem na
 * lista não mude a ordem na tela.
 */
export const marcasNaOrdemDaHierarquia = () =>
  CATEGORIAS.flatMap(categoria => marcasDaCategoria(categoria));

/**
 * Quantas cópias do grupo a esteira precisa para cobrir a janela sem buraco.
 *
 * Duas é o mínimo: a animação desloca o trilho em -100%/cópias, e com uma só
 * cópia não há o que entrar no lugar da que saiu. Daí em diante é cobertura:
 * o trilho precisa valer pelo menos duas janelas, senão aparece vão.
 */
export const copiasNecessarias = (larguraDoGrupo, larguraDaJanela) => {
  if (!(larguraDoGrupo > 0)) return 2;
  return Math.max(2, Math.ceil((larguraDaJanela * 2) / larguraDoGrupo));
};

/** Velocidade da esteira, constante em pixels por segundo em qualquer tela. */
export const PIXELS_POR_SEGUNDO = 42;

/** A duração de um ciclo, para que a velocidade NÃO dependa do tamanho do grupo. */
export const duracaoDoCiclo = larguraDoGrupo =>
  Math.max(1, larguraDoGrupo / PIXELS_POR_SEGUNDO);

/**
 * O sentido alterna a cada faixa: a primeira para a esquerda, a seguinte para a
 * direita, e assim por diante. Alternar não é enfeite — duas faixas vizinhas no
 * mesmo sentido leem como um bloco só deslizando, e a separação entre as
 * categorias se perde.
 */
export const sentidoDaFaixa = indice => (indice % 2 === 0 ? 'esquerda' : 'direita');

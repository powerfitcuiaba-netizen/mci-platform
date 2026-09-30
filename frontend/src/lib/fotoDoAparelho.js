// ============================================================================
// A FOTO DE QUALQUER APARELHO.
//
// O PROBLEMA MEDIDO
//
// O servidor aceita PNG, JPEG e WebP, e recusa o resto com 415. O padrão de
// câmera do iPhone é HEIC, então a foto tirada na hora, num iPhone em
// configuração de fábrica, era recusada.
//
// POR QUE A CORREÇÃO NÃO É NO SERVIDOR
//
// Foi a primeira tentativa, e a MEDIÇÃO a descartou: o processador de imagem
// desta instalação tem contêiner HEIF com codec AV1, mas NÃO tem HEVC — e o
// HEIC do iPhone é HEVC. Aceitar `image/heic` na lista do servidor seria
// prometer uma decodificação que não existe aqui, e que eu não tenho como
// provar que existe no ambiente de produção. A recusa sairia como erro 500 em
// vez de 415: pior para quem está do outro lado.
//
// O aparelho que tirou a foto, em contrapartida, sabe lê-la — o codec é do
// sistema operacional. Converter ANTES do envio resolve no lugar onde há
// capacidade comprovada, e mantém a lista do servidor estrita e provada.
//
// TRÊS COISAS QUE ESTE MÓDULO NÃO FAZ, e cada ausência é deliberada
//
//   * NÃO converte foto que o servidor já aceita e que cabe no teto. JPEG com
//     EXIF preservado é melhor do que JPEG reencodado: o servidor aplica a
//     rotação da etiqueta EXIF, e reencodar aqui APAGARIA a etiqueta. Uma foto
//     de retrato chegaria deitada, e o defeito seria meu. Só converte quem
//     precisa;
//   * NÃO usa `<img>` para decodificar. `<img>` desenhado em canvas não garante
//     a aplicação da orientação EXIF, e como a conversão apaga a etiqueta, o
//     erro seria irreversível. `createImageBitmap` com
//     `imageOrientation: 'from-image'` ASSA a orientação nos pixels — é o único
//     caminho em que a conversão é segura;
//   * NÃO adivinha quando falha. Se o aparelho não souber decodificar, este
//     módulo levanta um erro com a frase que diz o que fazer, em vez de enviar
//     bytes que o servidor vai recusar com uma mensagem técnica.
// ============================================================================

// O que o servidor aceita hoje. Mantido em sincronia com `ALLOWED_AVATAR` de
// `storageService.js` — o teste `fotoDoAparelho.test.js` falha se divergirem.
export const ACEITOS_PELO_SERVIDOR = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

// Teto do servidor para foto de perfil (`AVATAR_MAX_BYTES`, 5 MB).
export const TETO_DE_BYTES = 5 * 1024 * 1024;

// A saída da conversão. JPEG e não WebP porque JPEG é o formato que TODO
// `canvas.toBlob` sabe produzir; o suporte a WebP em `toBlob` varia, e uma
// falha silenciosa ali devolveria PNG gigante sem ninguém perceber.
export const FORMATO_DE_SAIDA = 'image/jpeg';

// 1280 é folga deliberada. O servidor recorta o avatar em 512x512, então
// mandar mais do que isso é desperdício — mas mandar EXATAMENTE 512 tiraria
// qualquer margem se o recorte mudar, e a mesma função serve foto de perfil e
// foto de publicação. 1280 pesa poucas centenas de kB e cobre os dois.
export const LADO_MAXIMO = 1280;
export const QUALIDADE = 0.9;

export const MENSAGEM_SEM_SUPORTE = 'Não foi possível ler esta foto neste aparelho. '
  + 'Tente escolher uma foto em JPEG ou PNG, ou tire a foto novamente.';

export const MENSAGEM_NAO_E_IMAGEM = 'O arquivo escolhido não é uma imagem.';

export const MENSAGEM_TIPO_RECUSADO = 'A foto precisa ser JPG, PNG ou WebP.';

// AS DUAS RECUSAS TÊM CÓDIGO, e não só frase, porque a interface é trilíngue.
// A frase acima é o padrão de quem chamar este módulo fora de uma tela (e o
// que os testes leem); a tela traduz pelo código. Sem isto, a pessoa que usa a
// aplicação em inglês levaria a recusa em português.
export const CODIGO_SEM_SUPORTE = 'FOTO_SEM_SUPORTE';
export const CODIGO_NAO_E_IMAGEM = 'FOTO_NAO_E_IMAGEM';
export const CODIGO_TIPO_RECUSADO = 'FOTO_TIPO_RECUSADO';

// O QUE ESTE MÓDULO RECUSA MESMO PODENDO CONVERTER.
//
// SVG é imagem e o navegador sabe rasterizá-lo — e é justamente por isso que
// esta lista existe. O servidor exclui SVG DE PROPÓSITO, por segurança: SVG
// carrega script. Converter aqui entregaria um JPEG inofensivo ao servidor e,
// com isso, contornaria uma decisão de segurança tomada de caso pensado. Uma
// conversão que passa a aceitar o que foi deliberadamente recusado não é
// conveniência: é a barreira andando para trás sem ninguém decidir.
export const RECUSADOS_SEMPRE = Object.freeze(['image/svg+xml']);

// O mapa fica AQUI, com as chaves escritas por extenso, para que uma busca por
// `foto.semSuporte` no repositório encontre o uso. Chave montada por
// concatenação seria invisível para quem procura, e para o teste que confere
// que toda chave existe nos três dicionários.
export const CHAVE_DA_RECUSA = Object.freeze({
  [CODIGO_SEM_SUPORTE]: 'foto.semSuporte',
  [CODIGO_NAO_E_IMAGEM]: 'foto.naoEImagem',
  // A MESMA frase que a conferência da solicitação já usava: o formato recusado
  // é o mesmo assunto, e duas frases diferentes para ele confundiriam.
  [CODIGO_TIPO_RECUSADO]: 'foto.erro.tipo'
});

const recusa = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });

// O QUE O SELETOR DO SISTEMA OFERECE.
//
// Aqui está o motivo de o valor ser largo em vez de a lista dos três aceitos: o
// `accept` NÃO é validação — é o filtro do seletor de arquivos do sistema. Com
// `image/jpeg,image/png,image/webp`, o iPhone esconde da galeria a foto HEIC, que
// é o padrão de câmera dele: a pessoa abre o seletor e vê as próprias fotos
// apagadas, sem explicação. Com `image/*` ela escolhe qualquer foto do aparelho
// ou do computador, e a conversão acontece aqui, antes do envio.
//
// Quem valida tipo, tamanho e os BYTES continua sendo o servidor. Alargar o
// `accept` não alarga nada do lado de lá.
export const ACEITO_NO_SELETOR = 'image/*';

// MÍDIA DE PUBLICAÇÃO, STORY E MENSAGEM É OUTRA LISTA, e a diferença não é
// detalhe: `ALLOWED_MEDIA` no servidor aceita GIF e VÍDEO, que `ALLOWED_AVATAR`
// recusa de propósito. Usar a lista do avatar aqui converteria um GIF animado em
// JPEG estático — a animação morreria calada — e tentaria desenhar um vídeo num
// canvas.
export const ACEITOS_COMO_MIDIA = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const TETO_DE_MIDIA_EM_BYTES = 50 * 1024 * 1024;
export const ACEITO_NO_SELETOR_DE_MIDIA = 'image/*,video/*';

/**
 * Cabe no que o servidor aceita, do jeito que está?
 *
 * As duas condições são necessárias: tipo aceito E tamanho dentro do teto. Uma
 * foto JPEG de 9 MB é aceita no tipo e recusada no tamanho — e precisa de
 * conversão tanto quanto um HEIC.
 */
export function precisaConverter(arquivo, { aceitos = ACEITOS_PELO_SERVIDOR, teto = TETO_DE_BYTES } = {}) {
  if (!arquivo) return false;
  const tipo = String(arquivo.type || '').toLowerCase();
  if (!aceitos.includes(tipo)) return true;
  return Number(arquivo.size || 0) > teto;
}

/** O tipo declarado é de vídeo? Vídeo nunca entra em canvas. */
export function ehVideo(arquivo) {
  return String(arquivo?.type || '').toLowerCase().startsWith('video/');
}

/**
 * Dimensões de destino preservando a proporção, sem AMPLIAR.
 *
 * Ampliar uma foto pequena não acrescenta informação: só produz um arquivo
 * maior com os mesmos pixels interpolados. Foto de 300x200 sai 300x200.
 */
export function dimensoesDestino(largura, altura, lado = LADO_MAXIMO) {
  const l = Math.max(1, Math.round(Number(largura) || 1));
  const a = Math.max(1, Math.round(Number(altura) || 1));
  const maior = Math.max(l, a);
  if (maior <= lado) return { largura: l, altura: a };
  const fator = lado / maior;
  return {
    largura: Math.max(1, Math.round(l * fator)),
    altura: Math.max(1, Math.round(a * fator))
  };
}

/**
 * `foto.HEIC` → `foto.jpg`. Sem extensão reconhecida, acrescenta.
 *
 * O nome importa porque é o que a pessoa vê na tela de confirmação. Um arquivo
 * convertido que continua se chamando `.HEIC` parece que nada aconteceu.
 */
export function nomeConvertido(nome) {
  const base = String(nome || 'foto').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${base || 'foto'}.jpg`;
}

// As dependências do navegador ficam injetáveis para que o comportamento seja
// testável sem canvas: o jsdom não implementa `toBlob`, e testar só a
// aritmética deixaria a orquestração — a parte que de fato quebra — sem rede.
const dependenciasPadrao = () => ({
  decodificar: typeof createImageBitmap === 'function'
    // `from-image` é o ponto todo: assa a orientação EXIF nos pixels ANTES de a
    // conversão apagar a etiqueta.
    ? arquivo => createImageBitmap(arquivo, { imageOrientation: 'from-image' })
    : null,
  criarTela: (largura, altura) => {
    const tela = document.createElement('canvas');
    tela.width = largura;
    tela.height = altura;
    return tela;
  },
  paraBlob: (tela, tipo, qualidade) => new Promise((resolve, reject) => {
    if (typeof tela.toBlob !== 'function') { reject(new Error('sem toBlob')); return; }
    tela.toBlob(blob => (blob ? resolve(blob) : reject(new Error('toBlob devolveu vazio'))), tipo, qualidade);
  })
});

/**
 * Devolve um `File` que o servidor aceita, ou o próprio arquivo quando ele já
 * serve. Levanta `Error` com mensagem de tela quando o aparelho não consegue.
 */
export async function normalizarFotoDoAparelho(arquivo, opcoes = {}) {
  if (!arquivo) return arquivo;

  const tipo = String(arquivo.type || '').toLowerCase();
  // Tipo vazio acontece em alguns seletores de arquivo; não é motivo para
  // recusar, porque a decodificação adiante é o juiz de verdade. Mas um tipo
  // declarado que não é imagem é recusado aqui, antes de gastar memória.
  if (tipo && !tipo.startsWith('image/')) {
    throw recusa(CODIGO_NAO_E_IMAGEM, MENSAGEM_NAO_E_IMAGEM);
  }

  // Antes de tentar converter: o que é recusado por decisão, e não por
  // incapacidade, é recusado aqui.
  if (RECUSADOS_SEMPRE.includes(tipo)) {
    throw recusa(CODIGO_TIPO_RECUSADO, MENSAGEM_TIPO_RECUSADO);
  }

  const aceitos = opcoes.aceitos ?? ACEITOS_PELO_SERVIDOR;
  const teto = opcoes.teto ?? TETO_DE_BYTES;
  if (!precisaConverter(arquivo, { aceitos, teto })) return arquivo;

  const { decodificar, criarTela, paraBlob } = { ...dependenciasPadrao(), ...opcoes };
  const lado = opcoes.lado ?? LADO_MAXIMO;
  const qualidade = opcoes.qualidade ?? QUALIDADE;

  if (!decodificar) throw recusa(CODIGO_SEM_SUPORTE, MENSAGEM_SEM_SUPORTE);

  let bitmap;
  try {
    bitmap = await decodificar(arquivo);
  } catch {
    // O aparelho não tem o codec. É o caso do HEIC num navegador de desktop que
    // não seja Safari, e é exatamente o que a mensagem precisa explicar.
    throw recusa(CODIGO_SEM_SUPORTE, MENSAGEM_SEM_SUPORTE);
  }

  try {
    const { largura, altura } = dimensoesDestino(bitmap.width, bitmap.height, lado);
    const tela = criarTela(largura, altura);
    const pincel = tela.getContext('2d');
    if (!pincel) throw new Error('sem contexto 2d');
    pincel.drawImage(bitmap, 0, 0, largura, altura);

    const blob = await paraBlob(tela, FORMATO_DE_SAIDA, qualidade);
    return new File([blob], nomeConvertido(arquivo.name), {
      type: FORMATO_DE_SAIDA,
      lastModified: Date.now()
    });
  } catch {
    throw recusa(CODIGO_SEM_SUPORTE, MENSAGEM_SEM_SUPORTE);
  } finally {
    // `close` libera a memória do bitmap na hora em vez de esperar o coletor.
    // Numa foto de 12 MP isso é dezenas de megabytes por escolha de arquivo.
    if (typeof bitmap?.close === 'function') bitmap.close();
  }
}

/**
 * A MESMA IDEIA, PARA MÍDIA DE PUBLICAÇÃO, STORY E MENSAGEM.
 *
 * Duas diferenças em relação à foto de perfil, e as duas são para NÃO estragar o
 * que já funciona:
 *
 *   * vídeo passa intacto. Desenhar vídeo em canvas devolveria um quadro só, e a
 *     pessoa perderia o vídeo sem nem ver a perda;
 *   * GIF passa intacto quando cabe no teto, porque o servidor aceita GIF.
 *     Convertê-lo para JPEG apagaria a animação.
 *
 * Sobra o que de fato precisa: HEIC de iPhone, e imagem acima do teto de 50 MB.
 */
export async function normalizarMidiaDoAparelho(arquivo, opcoes = {}) {
  if (!arquivo) return arquivo;
  if (ehVideo(arquivo)) return arquivo;
  return normalizarFotoDoAparelho(arquivo, {
    aceitos: ACEITOS_COMO_MIDIA,
    teto: TETO_DE_MIDIA_EM_BYTES,
    ...opcoes
  });
}

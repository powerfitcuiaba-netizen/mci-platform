const sharp = require('sharp');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// ============================================================================
// Normalização de imagem — uma camada só, para os quatro pontos de entrada:
// foto de perfil, mídia de publicação, story e mensagem.
//
// O QUE ELA FAZ, E POR QUE CADA COISA
//
//   orientação EXIF aplicada  A foto do celular vem com os pixels em paisagem
//                             e uma etiqueta dizendo "gire 90°". Quem respeita
//                             a etiqueta mostra em pé; quem não respeita
//                             mostra deitada. O `.rotate()` sem argumento
//                             aplica a etiqueta aos pixels e a remove — depois
//                             disso não há mais dois jeitos de interpretar.
//
//   metadados removidos       Saída do sharp não carrega metadado por padrão,
//                             e isso é intencional aqui: foto de treino tirada
//                             na academia costuma trazer GPS. Publicar o
//                             endereço de casa de um atleta junto com a foto
//                             seria vazamento, não recurso.
//
//   teto de resolução         Uma foto de 8000x6000 do celular moderno pesa
//                             megabytes e é exibida num cartão de 400px. O
//                             teto corta o desperdício na entrada, uma vez,
//                             em vez de a cada leitura de cada visitante.
//
//   WebP                      Mesma imagem, arquivo menor. Suporte universal
//                             nos navegadores atuais.
//
//   dimensões devolvidas      Para a tela reservar o espaço antes de a imagem
//                             chegar. Sem isso o texto pula quando a foto
//                             carrega.
//
// O QUE ELA NÃO TOCA, DE PROPÓSITO
//
//   vídeo                     Transcodificar vídeo é outro problema, com outro
//                             custo e outra biblioteca. Passa intacto.
//
//   GIF                       Converter GIF animado para WebP estático mataria
//                             a animação, que é a única razão de alguém mandar
//                             um GIF. Passa intacto.
// ============================================================================

const PERFIS = Object.freeze({
  // Avatar é quadrado e pequeno: aparece dezenas de vezes por tela.
  avatar: { largura: 512, altura: 512, ajuste: 'cover', qualidade: 82 },
  // Mídia de publicação, story e mensagem: cabe em tela cheia de monitor
  // grande sem virar arquivo de megabytes.
  midia: { largura: 2048, altura: 2048, ajuste: 'inside', qualidade: 80 }
});

// Formatos que atravessam sem processamento.
const INTOCADOS = Object.freeze(['image/gif']);

const ehImagem = mimeType => String(mimeType || '').toLowerCase().startsWith('image/');

/**
 * Devolve `{ buffer, mimeType, width, height, processada }`.
 * Nunca lança por imagem "feia" — lança 415 quando o arquivo não é imagem
 * decodificável, que é informação útil para quem enviou.
 */
async function normalizar(arquivo, nomeDoPerfil = 'midia') {
  const perfil = PERFIS[nomeDoPerfil] || PERFIS.midia;
  const mimeType = String(arquivo.mimeType || '').toLowerCase();

  if (!ehImagem(mimeType) || INTOCADOS.includes(mimeType)) {
    return { buffer: arquivo.buffer, mimeType: arquivo.mimeType, width: null, height: null, processada: false };
  }

  try {
    const { data, info } = await sharp(arquivo.buffer)
      // Sem argumento: aplica a orientação do EXIF e depois a descarta.
      .rotate()
      .resize({
        width: perfil.largura,
        height: perfil.altura,
        fit: perfil.ajuste,
        // Imagem menor que o teto não é esticada: ampliar não cria detalhe,
        // só peso e borrão.
        withoutEnlargement: true
      })
      .webp({ quality: perfil.qualidade })
      .toBuffer({ resolveWithObject: true });

    return { buffer: data, mimeType: 'image/webp', width: info.width, height: info.height, processada: true };
  } catch (erro) {
    // O sharp recusa imagem corrompida e também imagem com número absurdo de
    // pixels (a "bomba de descompressão": poucos bytes que viram gigabytes na
    // memória ao decodificar). Os dois casos são recusa de entrada, não erro
    // de servidor.
    logger.warn('imagem recusada na normalização', { erro: erro.message, mimeType });
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Não foi possível processar esta imagem. Envie um JPG, PNG ou WebP válido.');
  }
}

module.exports = { normalizar, PERFIS };

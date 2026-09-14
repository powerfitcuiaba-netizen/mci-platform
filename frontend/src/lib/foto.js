// Escolha da foto de perfil, antes de ela existir no servidor.
//
// A foto é escolhida no formulário mas só sobe DEPOIS de a solicitação
// existir: a rota é `POST /athlete-requests/:id/photo`, e não há id antes do
// envio. Então o arquivo fica em memória aqui, com uma pré-visualização local,
// e é enviado logo em seguida — dois pedidos por trás de um botão só.
//
// Nada disto substitui a conferência do servidor. Lá o arquivo passa por três
// camadas (lista de tipos, assinatura dos bytes e decodificação pelo sharp).
// O que se faz aqui é avisar antes, para a pessoa não esperar um envio que já
// se sabe que vai falhar.

export const TIPOS_DE_FOTO = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;

const MB = bytes => `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;

// Devolve `{ erro }` ou `{ arquivo }`. Nunca lança: a tela mostra o texto.
export function conferirFoto(arquivo) {
  if (!arquivo) return { erro: 'Escolha uma imagem.' };

  // O tipo aqui é o que o NAVEGADOR deduziu, quase sempre pela extensão. Serve
  // para avisar cedo, não para decidir: quem decide é o servidor, olhando os
  // bytes.
  if (!TIPOS_DE_FOTO.includes(arquivo.type)) {
    return { erro: 'A foto precisa ser JPG, PNG ou WebP.' };
  }
  if (arquivo.size > MAX_FOTO_BYTES) {
    return { erro: `A foto tem ${MB(arquivo.size)} e o limite é ${MB(MAX_FOTO_BYTES)}.` };
  }
  if (arquivo.size === 0) return { erro: 'O arquivo está vazio.' };

  return { arquivo };
}

export const tamanhoLegivel = MB;

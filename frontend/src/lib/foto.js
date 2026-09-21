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

const MEGABYTES = bytes => bytes / (1024 * 1024);

// Devolve `{ erro, valores }` ou `{ arquivo }`. Nunca lança: a tela mostra o
// texto.
//
// `erro` é uma CHAVE de tradução, e `valores` o que ela interpola. Este módulo
// não é componente e não tem como saber o idioma em vigor — devolver a frase
// pronta daqui deixaria o aviso em português numa tela em espanhol. O TAMANHO
// vai como número, e não como texto já formatado: "5,0" e "5.0" são o mesmo
// número escrito por idiomas diferentes, e quem sabe qual usar é a tela.
export function conferirFoto(arquivo) {
  if (!arquivo) return { erro: 'foto.erro.semArquivo' };

  // O tipo aqui é o que o NAVEGADOR deduziu, quase sempre pela extensão. Serve
  // para avisar cedo, não para decidir: quem decide é o servidor, olhando os
  // bytes.
  if (!TIPOS_DE_FOTO.includes(arquivo.type)) {
    return { erro: 'foto.erro.tipo' };
  }
  if (arquivo.size > MAX_FOTO_BYTES) {
    return {
      erro: 'foto.erro.tamanho',
      valores: { tamanho: MEGABYTES(arquivo.size), limite: MEGABYTES(MAX_FOTO_BYTES) }
    };
  }
  if (arquivo.size === 0) return { erro: 'foto.erro.vazio' };

  return { arquivo };
}

export const emMegabytes = MEGABYTES;

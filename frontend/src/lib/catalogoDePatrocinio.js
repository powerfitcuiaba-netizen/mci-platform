import { api, urlDeMidiaPublica } from '../services/api';

// ============================================================================
// O CATÁLOGO DE PATROCINADORES, DO BANCO — e de nenhum outro lugar.
//
// Até aqui as marcas eram uma lista versionada em `lib/patrocinadores.js`, e
// trocar um patrocinador exigia deploy. Agora elas vêm de `/public/sponsors`,
// que devolve só quem está ATIVO, já na ordem da hierarquia comercial.
//
// UMA CONSULTA PARA O APLICATIVO INTEIRO
//
// A parede da tela de entrada e a esteira do rodapé mostram as mesmas marcas,
// e a esteira aparece em quatro telas públicas. Sem cache seriam cinco
// requisições iguais, e uma a cada navegação. O cache é a PROMESSA, não o
// resultado: duas telas que montam no mesmo quadro compartilham a requisição
// em voo em vez de disparar duas.
//
// Não há polling e não há recarga por tempo: patrocinador não muda sozinho.
// Quem muda é o administrador, e a tela dele chama `invalidar()` depois de
// salvar — é por isso que a função existe.
// ============================================================================

let emVoo = null;

/**
 * As marcas ativas, na ordem da vitrine.
 *
 * NUNCA REJEITA. Uma falha de rede não pode derrubar a tela de entrada nem a
 * vitrine: sem catálogo a faixa simplesmente não aparece, que é degradação
 * aceitável para uma parede de patrocínio. O erro vai para o console, não para
 * a cara de quem está tentando entrar no sistema.
 */
export function carregarPatrocinadores() {
  if (!emVoo) {
    // `Promise.resolve().then(...)` e não a chamada direta: se `sponsors`
    // deixar de existir — renomeado, duplo de teste incompleto, pacote meio
    // carregado — a chamada lança SÍNCRONA, antes de haver promessa, e o
    // `.catch` abaixo não a pega. O erro subiria pelo `useEffect` e levaria o
    // casco inteiro junto, por causa de uma faixa de patrocínio.
    emVoo = Promise.resolve()
      .then(() => api.publicApi.sponsors())
      .then(resposta => resposta?.items ?? [])
      .catch(erro => {
        // A próxima tela tenta de novo: um erro não pode ficar grudado no
        // cache para sempre.
        emVoo = null;
        // eslint-disable-next-line no-console
        console.error('catálogo de patrocinadores indisponível', erro);
        return [];
      });
  }
  return emVoo;
}

/** Descarta o cache. A tela de administração chama depois de cada alteração. */
export function invalidar() {
  emVoo = null;
}

/**
 * Onde a arte de um patrocinador é servida.
 *
 * Caminho por ID, nunca chave de armazenamento: o servidor resolve o objeto, e
 * trocar o id na URL só alcança a logo que aquele id autoriza. A chave sequer
 * sai da API — o que vem no corpo é o booleano `hasLogo`.
 */
export const urlDaLogo = patrocinador => urlDeMidiaPublica(`/media/sponsors/${patrocinador.id}/logo`);

/** O nível em caixa baixa, que é como as classes de CSS o nomeiam (`t-global`). */
export const nivelEmClasse = patrocinador => String(patrocinador.level || '').toLowerCase();

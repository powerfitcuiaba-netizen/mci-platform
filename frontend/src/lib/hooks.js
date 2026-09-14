import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Busca de dados com estado de carga, erro e recarga. Escuta o evento
// 'mci-data-changed' para que uma escrita bem-sucedida em qualquer tela
// revalide o que está montado, sem cada tela adivinhar quando recarregar.
export function useFetch(carregar, dependencias = [], { ativo = true, recarregarACada = 0 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(ativo);
  const [error, setError] = useState(null);
  // Quando a resposta chegou. A tela usa isto para dizer há quanto tempo o
  // número à vista foi conferido — um painel que não diz a idade do dado
  // parece atual mesmo quando está velho.
  const [atualizadoEm, setAtualizadoEm] = useState(null);
  const montado = useRef(true);
  // Uma busca em voo por vez. Sem isto, uma rede lenta com recarga periódica
  // empilha requisições: a cada intervalo sai mais uma, nenhuma volta, e a
  // fila cresce sozinha.
  const emVoo = useRef(false);
  // Ordem de emissão das buscas. A rede NÃO devolve na ordem em que foi
  // perguntada: o operador troca o filtro de evento duas vezes, a primeira
  // consulta é a lenta, e ela chega depois da segunda. Sem este contador, a
  // resposta abandonada reescrevia a tela com o dado do filtro anterior — e
  // nada na interface indicava que o que está à vista não corresponde ao que
  // está selecionado. Só a busca mais recente tem permissão de escrever.
  const geracao = useRef(0);

  // `silencioso` é o que torna a recarga periódica suportável: ela NÃO acende
  // o esqueleto de carregamento nem apaga o que está na tela. Sem isso o
  // painel pisca a cada intervalo e fica pior do que se não atualizasse.
  const executar = useCallback(async (silencioso = false) => {
    if (!ativo) {
      setLoading(false);
      return;
    }
    if (silencioso && emVoo.current) return;

    geracao.current += 1;
    const minha = geracao.current;
    const aindaVale = () => montado.current && geracao.current === minha;

    emVoo.current = true;
    if (!silencioso) setLoading(true);
    if (!silencioso) setError(null);
    try {
      const resposta = await carregar();
      if (aindaVale()) {
        setData(resposta);
        setAtualizadoEm(Date.now());
        // Uma recarga silenciosa bem-sucedida limpa o erro anterior: a tela
        // não pode continuar acusando falha depois de voltar a funcionar.
        setError(null);
      }
    } catch (erro) {
      // Falha de recarga periódica NÃO derruba o que já está à vista. O
      // operador continua vendo o último número bom; trocar por uma tela de
      // erro porque um tique falhou é perder informação boa.
      if (aindaVale() && !silencioso) setError(erro.message || 'Falha ao carregar.');
    } finally {
      emVoo.current = false;
      // Encerrar a carga também é privilégio da busca atual: uma resposta
      // obsoleta apagava o indicador de carregamento da busca que ainda
      // estava em curso.
      if (aindaVale()) setLoading(false);
    }
    // `carregar` costuma ser uma arrow recriada a cada render: as dependências
    // declaradas pela tela é que definem quando refazer a busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, ...dependencias]);

  useEffect(() => {
    montado.current = true;
    executar();
    return () => { montado.current = false; };
  }, [executar]);

  useEffect(() => {
    const aoMudar = () => executar();
    window.addEventListener('mci-data-changed', aoMudar);
    return () => window.removeEventListener('mci-data-changed', aoMudar);
  }, [executar]);

  // Recarga periódica. Só existe quando a tela pede um intervalo.
  //
  // Aba escondida NÃO consulta: um painel deixado aberto a noite inteira numa
  // aba de fundo geraria milhares de requisições sem ninguém olhando. Ao
  // voltar para a frente, atualiza na hora — que é justamente quando o
  // operador quer ver o número certo.
  useEffect(() => {
    if (!ativo || !recarregarACada) return undefined;

    const escondida = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tique = () => { if (!escondida()) executar(true); };

    const intervalo = setInterval(tique, recarregarACada);
    const aoVoltar = () => { if (!escondida()) executar(true); };
    document.addEventListener('visibilitychange', aoVoltar);

    return () => {
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [ativo, recarregarACada, executar]);

  return { data, loading, error, reload: executar, setData, atualizadoEm };
}

// ============================================================================
// LISTA PAGINADA POR CURSOR.
//
// Existe UM lugar no produto que sabe emendar páginas. Antes cada tela
// guardava seu próprio `{ items, nextCursor }` e escrevia seu próprio
// "carregar mais" — e é aí que moram os três defeitos que ninguém vê em
// desenvolvimento, porque em desenvolvimento a lista cabe numa página:
//
//   1. TROCAR O FILTRO SEM ZERAR. A página 1 do filtro B era anexada ao que
//      sobrou do filtro A. A tela mostrava atletas que não correspondem à
//      busca, e o operador não tem como saber disso olhando.
//
//   2. RESPOSTA ATRASADA DE UM FILTRO ABANDONADO. O operador troca o filtro
//      duas vezes; a primeira consulta é a lenta e chega por último, emendando
//      o resultado errado no fim da lista certa.
//
//   3. RECARGA QUE PERDE O LUGAR. Um check-in bem-sucedido dispara recarga; se
//      a recarga voltasse só à página 1, o operador que já tinha aberto três
//      páginas era jogado de volta ao começo no meio da fila. Aqui a recarga
//      refaz AS MESMAS páginas que estavam abertas.
//
// `buscar(cursor)` devolve o que a API devolve: `{ items, nextCursor }`, e
// qualquer campo extra (como o `summary` do check-in) é preservado em `extra`.
// ============================================================================
export function useListaPaginada(buscar, dependencias = [], { ativo = true, recarregarACada = 0 } = {}) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [extra, setExtra] = useState(null);
  const [loading, setLoading] = useState(ativo);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [error, setError] = useState(null);

  const montado = useRef(true);
  // Só a busca mais recente escreve na tela. Sem isto, resposta abandonada
  // reescreve a lista do filtro atual — o defeito nº 2 acima.
  const geracao = useRef(0);
  // Os cursores das páginas já abertas, em ordem. É o que permite à recarga
  // devolver o operador ao mesmo lugar em vez de ao começo.
  const cursores = useRef([null]);
  const emVoo = useRef(false);

  // `buscar` é recriada a cada render pela tela; guardá-la numa ref evita que
  // isso sozinho dispare uma nova carga. Quem define quando refazer é a lista
  // de dependências declarada pela tela.
  const buscarRef = useRef(buscar);
  buscarRef.current = buscar;

  const executar = useCallback(async (silencioso = false) => {
    if (!ativo) { setLoading(false); return; }
    if (emVoo.current && silencioso) return;

    geracao.current += 1;
    const minha = geracao.current;
    const aindaVale = () => montado.current && geracao.current === minha;

    emVoo.current = true;
    if (!silencioso) { setLoading(true); setError(null); }
    try {
      // Refaz exatamente as páginas que estavam abertas, na ordem.
      const abertas = cursores.current;
      const acumulado = [];
      let ultima = null;
      for (const cursor of abertas) {
        const resposta = await buscarRef.current(cursor);
        if (!aindaVale()) return;
        acumulado.push(...(resposta?.items || []));
        ultima = resposta;
        // Uma página que voltou sem continuação encerra a recarga: insistir
        // nos cursores seguintes pediria páginas que não existem mais.
        if (!resposta?.nextCursor) break;
      }
      if (aindaVale()) {
        setItems(acumulado);
        setNextCursor(ultima?.nextCursor ?? null);
        setExtra(ultima || null);
        setError(null);
      }
    } catch (erro) {
      if (aindaVale() && !silencioso) setError(erro.message || 'Falha ao carregar.');
    } finally {
      emVoo.current = false;
      if (aindaVale()) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, ...dependencias]);

  // Trocar de filtro ZERA a lista e a memória de páginas. É o defeito nº 1, e
  // ele tem de morrer antes da primeira requisição do filtro novo — não depois
  // que ela volta.
  useEffect(() => {
    montado.current = true;
    cursores.current = [null];
    setItems([]);
    setNextCursor(null);
    setExtra(null);
    executar();
    return () => { montado.current = false; };
  }, [executar]);

  useEffect(() => {
    const aoMudar = () => executar(true);
    window.addEventListener('mci-data-changed', aoMudar);
    return () => window.removeEventListener('mci-data-changed', aoMudar);
  }, [executar]);

  useEffect(() => {
    if (!ativo || !recarregarACada) return undefined;
    const escondida = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const tique = () => { if (!escondida()) executar(true); };
    const intervalo = setInterval(tique, recarregarACada);
    document.addEventListener('visibilitychange', tique);
    return () => {
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', tique);
    };
  }, [ativo, recarregarACada, executar]);

  const carregarMais = useCallback(async () => {
    if (!nextCursor || carregandoMais || emVoo.current) return;
    const minha = geracao.current;
    setCarregandoMais(true);
    emVoo.current = true;
    try {
      const resposta = await buscarRef.current(nextCursor);
      // Se o filtro mudou enquanto esta página vinha, ela é jogada fora.
      if (!montado.current || geracao.current !== minha) return;
      cursores.current = [...cursores.current, nextCursor];
      setItems(atual => [...atual, ...(resposta?.items || [])]);
      setNextCursor(resposta?.nextCursor ?? null);
      setExtra(resposta || null);
    } catch (erro) {
      if (montado.current && geracao.current === minha) setError(erro.message || 'Falha ao carregar mais.');
    } finally {
      emVoo.current = false;
      if (montado.current) setCarregandoMais(false);
    }
  }, [nextCursor, carregandoMais]);

  // `data` existe para que a tela continue usando `AsyncSection` sem adaptador:
  // é `null` enquanto nada chegou (esqueleto) e, depois, a resposta da última
  // página com a lista inteira já emendada por cima. Nenhuma tela precisa
  // aprender uma segunda forma de ler estado.
  const data = useMemo(
    () => (extra ? { ...extra, items, nextCursor } : null),
    [extra, items, nextCursor]
  );

  return { data, items, nextCursor, extra, loading, error, carregandoMais, carregarMais, reload: executar };
}

// Rota por hash. Sem dependência de roteador: a navegação é hierárquica e
// curta, e o hash sobrevive a recarga sem exigir configuração de servidor.
export function useHashRoute() {
  const ler = () => window.location.hash.replace(/^#\/?/, '') || 'inicio';
  const [rota, setRota] = useState(ler);

  useEffect(() => {
    const aoMudar = () => setRota(ler());
    window.addEventListener('hashchange', aoMudar);
    return () => window.removeEventListener('hashchange', aoMudar);
  }, []);

  const navegar = useCallback(destino => {
    window.location.hash = `#/${String(destino).replace(/^#?\/?/, '')}`;
  }, []);

  const partes = useMemo(() => rota.split('/').filter(Boolean), [rota]);

  return { rota, partes, navegar };
}

// Atraso na digitação: evita disparar busca a cada tecla.
export function useDebounce(valor, atraso = 350) {
  const [debounced, setDebounced] = useState(valor);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(valor), atraso);
    return () => clearTimeout(id);
  }, [valor, atraso]);
  return debounced;
}

// Pilha de avisos. Um aviso some sozinho; erro fica mais tempo, porque é o que
// o usuário precisa ler.
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  // O aviso mais longo dura 7 s. Sair da tela antes disso deixava o
  // temporizador correndo sozinho, agendado sobre um componente que não existe
  // mais — lixo que só some quando a aba fecha.
  const temporizadores = useRef(new Set());

  const remover = useCallback(id => setToasts(atual => atual.filter(item => item.id !== id)), []);

  const notificar = useCallback((mensagem, tipo = 'ok') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(atual => [...atual, { id, mensagem, tipo }]);
    const temporizador = setTimeout(() => {
      temporizadores.current.delete(temporizador);
      remover(id);
    }, tipo === 'erro' ? 7000 : 4000);
    temporizadores.current.add(temporizador);
  }, [remover]);

  useEffect(() => {
    const pendentes = temporizadores.current;
    return () => {
      for (const temporizador of pendentes) clearTimeout(temporizador);
      pendentes.clear();
    };
  }, []);

  return { toasts, notificar, remover };
}

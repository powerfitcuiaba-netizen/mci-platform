import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Busca de dados com estado de carga, erro e recarga. Escuta o evento
// 'mci-data-changed' para que uma escrita bem-sucedida em qualquer tela
// revalide o que está montado, sem cada tela adivinhar quando recarregar.
export function useFetch(carregar, dependencias = [], { ativo = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(ativo);
  const [error, setError] = useState(null);
  const montado = useRef(true);
  // Ordem de emissão das buscas. A rede NÃO devolve na ordem em que foi
  // perguntada: o operador troca o filtro de evento duas vezes, a primeira
  // consulta é a lenta, e ela chega depois da segunda. Sem este contador, a
  // resposta abandonada reescrevia a tela com o dado do filtro anterior — e
  // nada na interface indicava que o que está à vista não corresponde ao que
  // está selecionado. Só a busca mais recente tem permissão de escrever.
  const geracao = useRef(0);

  const executar = useCallback(async () => {
    if (!ativo) {
      setLoading(false);
      return;
    }
    geracao.current += 1;
    const minha = geracao.current;
    const aindaVale = () => montado.current && geracao.current === minha;

    setLoading(true);
    setError(null);
    try {
      const resposta = await carregar();
      if (aindaVale()) setData(resposta);
    } catch (erro) {
      if (aindaVale()) setError(erro.message || 'Falha ao carregar.');
    } finally {
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

  return { data, loading, error, reload: executar, setData };
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

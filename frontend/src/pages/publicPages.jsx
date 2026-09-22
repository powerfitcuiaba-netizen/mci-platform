import { useState } from 'react';
import { CalendarDays, ChevronRight, MapPin, Search, Trophy, Users } from 'lucide-react';
import api from '../services/api';
import { useDebounce, useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Metric, PageHead, Paginacao } from '../components/ui';
import { formatarData, formatarDataHora, seloDoEvento, estadoDaBateria, estadoPro } from '../lib/format';
import { PulsoAoVivo, Revelacao } from '../components/experiencia';
import { useIdioma, TextoRico } from '../lib/idioma';

// Vitrine pública. Tudo aqui sai da API real; nenhuma métrica é estimada e
// nenhuma lista é fixa no código.

export function Inicio({ navegar }) {
  const resumo = useFetch(() => api.publicApi.summary(), []);
  const { t } = useIdioma();
  const ranking = useFetch(() => api.ranking.list({ limit: 10 }), []);

  return (
    <div className="page">
      <Revelacao as="section" className="hero" indice={0}>
        <span className="eyebrow">Muscle Contest</span>
        <h1>Campeonato Brasileiro Muscle Contest</h1>
        <p>{t('publico.subtitulo')}</p>
        <div className="hero-meta">
          <span><Trophy size={14} /> {t('publico.onzeCategorias')}</span>
          <span><Users size={14} /> {t('publico.quemParticipa')}</span>
          <span><CalendarDays size={14} /> {t('publico.temporadasERanking')}</span>
        </div>
      </Revelacao>

      <div className="grid grid-4" style={{ marginTop: 18 }}>
        <AsyncSection state={resumo} linhas={1}>
          {dados => (
            <>
              {/* Cada número leva ao módulo que o produz. `Metric` já vira
                  botão acessível quando recebe `onClick` — o que faltava era
                  ligar o número ao seu destino. A entrada é em sequência, com
                  atraso calculado pelo motor (teto de 360ms). */}
              <Revelacao indice={0}>
                <Metric
                  label={t('publico.campeonatos')} value={dados.events}
                  onClick={() => navegar('campeonatos')} destino={t('publico.destinoCampeonatos')}
                />
              </Revelacao>
              <Revelacao indice={1}>
                <Metric
                  label={t('publico.atletas')} value={dados.athletes}
                  onClick={() => navegar('atletas')} destino={t('publico.destinoAtletas')}
                />
              </Revelacao>
              <Revelacao indice={2}>
                <Metric
                  label={t('publico.atletasPro')} value={dados.proAthletes} destaque
                  onClick={() => navegar('atletas')} destino={t('publico.destinoAtletas')}
                />
              </Revelacao>
              <Revelacao indice={3}>
                <Metric
                  label={t('publico.resultadosPublicados')} value={dados.publishedResults}
                  onClick={() => navegar('ranking')} destino={t('publico.destinoRanking')}
                />
              </Revelacao>
            </>
          )}
        </AsyncSection>
      </div>

      <div className="grid grid-main" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>{t('publico.proximosCampeonatos')}</h2>
            <button type="button" className="button button-ghost button-sm" onClick={() => navegar('campeonatos')}>
              {t('publico.verTodos')} <ChevronRight size={14} />
            </button>
          </div>
          <AsyncSection state={resumo} linhas={3}>
            {dados => (dados.upcoming.length
              ? dados.upcoming.map(evento => (
                <button
                  key={evento.id}
                  type="button"
                  className="list-row"
                  style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left' }}
                  onClick={() => navegar(`campeonatos/${evento.slug}`)}
                >
                  <span className="avatar"><Trophy size={16} /></span>
                  <span className="info">
                    <strong>{evento.name}</strong>
                    <small>{formatarData(evento.startDate)} · {evento.city || t('publico.localADefinir')}{evento.state ? `/${evento.state}` : ''}</small>
                  </span>
                  <ChevronRight size={16} color="var(--cinza-fraco)" />
                </button>
              ))
              : <EmptyState title={t('publico.nenhumAgendado')} description={t('publico.nenhumAgendadoDescricao')} />
            )}
          </AsyncSection>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{t('overall.ranking')}</h2>
            <button type="button" className="button button-ghost button-sm" onClick={() => navegar('ranking')}>
              {t('publico.completo')} <ChevronRight size={14} />
            </button>
          </div>
          <AsyncSection state={ranking} linhas={3}>
            {dados => (dados.items.length
              ? dados.items.slice(0, 8).map(linha => (
                <div className="list-row" key={linha.id}>
                  <span className={`placing placing-${linha.position}`}>{linha.position}</span>
                  <span className="info">
                    <strong>{linha.athlete.stageName || linha.athlete.fullName}</strong>
                    <small>{linha.category?.name || t('publico.geral')} · {linha.athlete.state || '—'}</small>
                  </span>
                  <strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong>
                </div>
              ))
              : <EmptyState title={t('publico.rankingEmConstrucao')} description={t('publico.rankingEmConstrucaoDescricao')} />
            )}
          </AsyncSection>
        </section>
      </div>
    </div>
  );
}

export function Campeonatos({ navegar }) {
  const { t } = useIdioma();
  const [busca, setBusca] = useState('');
  const termo = useDebounce(busca);
  const [pagina, setPagina] = useState({ items: [], nextCursor: null });
  const [carregandoMais, setCarregandoMais] = useState(false);

  // A busca vai para o SERVIDOR. Filtrar no cliente só o que já carregou faz a
  // tela dizer "nenhum campeonato encontrado" para uma etapa que existe — foi
  // o que acontecia com as 47 etapas da temporada, das quais 24 chegavam aqui.
  const estado = useFetch(async () => {
    const resposta = await api.publicApi.events({ limit: 24, search: termo || undefined });
    setPagina(resposta);
    return resposta;
  }, [termo]);

  const carregarMais = async () => {
    setCarregandoMais(true);
    try {
      const resposta = await api.publicApi.events({ limit: 24, cursor: pagina.nextCursor, search: termo || undefined });
      setPagina(atual => ({ items: [...atual.items, ...resposta.items], nextCursor: resposta.nextCursor }));
    } finally {
      setCarregandoMais(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('publico.competicoes')}
        title={t('publico.campeonatos')}
        description={t('publico.etapasDoCampeonato')}
      />

      <div className="toolbar">
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('publico.buscarCampeonato')} aria-label={t('publico.buscarCampeonatoRotulo')} />
        </label>
      </div>

      <AsyncSection state={estado} linhas={4}>
        {() => {
          if (!pagina.items.length) {
            return <EmptyState title={t('publico.nenhumEncontrado')} description={t('publico.nenhumEncontradoDescricao')} />;
          }

          const agora = Date.now();
          const proximaEtapaId = (pagina.items.find(item => new Date(item.startDate).getTime() >= agora) || {}).id;

          return (
            <>
            <div className="grid grid-3">
              {pagina.items.map((evento, indice) => {
                const estadoEvento = seloDoEvento(evento);
                // "Próxima" é a PRIMEIRA etapa futura da lista carregada, e a
                // lista já vem ordenada pelo servidor. Não é palpite da
                // interface: é o primeiro item que ainda não aconteceu.
                const proxima = evento.id === proximaEtapaId;
                return (
                  <Revelacao
                    as="button"
                    key={evento.id}
                    indice={indice % 24}
                    type="button"
                    className={`panel cartao-clicavel${proxima ? ' etapa-proxima' : ''}`}
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => navegar(`campeonatos/${evento.slug}`)}
                  >
                    {proxima && <span className="eyebrow" style={{ display: 'block', marginBottom: 8 }}>{t('publico.proximaEtapa')}</span>}
                    {/* Ao vivo de VERDADE: `seloDoEvento` só devolve `aoVivo`
                        quando a etapa acontece hoje E está em estado de piso. */}
                    {estadoEvento.aoVivo
                      ? <PulsoAoVivo rotulo={estadoEvento.rotulo} />
                      : <Badge tom={estadoEvento.tom}>{estadoEvento.rotulo}</Badge>}
                    <h3 className="display" style={{ fontSize: 22, margin: '14px 0 6px' }}>{evento.name}</h3>
                    <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: 0, minHeight: 34 }}>
                      {evento.description || t('publico.descricaoPadraoDaEtapa')}
                    </p>
                    <div style={{ display: 'flex', gap: 14, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--linha)', fontSize: 11.5, color: 'var(--cinza-fraco)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} /> {formatarData(evento.startDate)}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><Users size={13} /> {evento._count.registrations}</span>
                    </div>
                  </Revelacao>
                );
              })}
            </div>
            <Paginacao nextCursor={pagina.nextCursor} onMore={carregarMais} loading={carregandoMais} />
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function CampeonatoDetalhe({ slug, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.publicApi.event(slug), [slug]);
  const [aba, setAba] = useState('resultados');

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('campeonatos')} style={{ marginBottom: 14 }}>
        {t('publico.voltarParaCampeonatos')}
      </button>

      <AsyncSection state={estado} linhas={5}>
        {dados => {
          const { event, categories, schedule, athletes, results, sponsors } = dados;
          const estadoEvento = seloDoEvento(event);

          return (
            <>
              <section className="hero">
                <Badge tom={estadoEvento.tom} aoVivo={estadoEvento.aoVivo}>{estadoEvento.rotulo}</Badge>
                <h1 style={{ marginTop: 12 }}>{event.name}</h1>
                {event.description && <p>{event.description}</p>}
                <div className="hero-meta">
                  <span><CalendarDays size={14} /> {formatarData(event.startDate, event.timezone)}{event.endDate ? ` — ${formatarData(event.endDate, event.timezone)}` : ''}</span>
                  {event.venue && <span><MapPin size={14} /> {event.venue}</span>}
                  {event.city && <span><MapPin size={14} /> {event.city}{event.state ? `/${event.state}` : ''}</span>}
                  <span><Users size={14} /> {t('publico.atletasContagem', { n: athletes.length })}</span>
                </div>
              </section>

              <div className="chips" style={{ margin: '18px 0' }}>
                {[
                  ['resultados', 'publico.abaResultados'],
                  ['categorias', 'publico.abaCategorias'],
                  ['agenda', 'publico.abaAgenda'],
                  ['atletas', 'publico.atletas'],
                  ['patrocinadores', 'publico.abaPatrocinadores']
                ].map(([chave, rotulo]) => (
                  <button
                    key={chave} type="button"
                    className={`chip${aba === chave ? ' is-on' : ''}`} onClick={() => setAba(chave)}
                  >
                    {t(rotulo)}
                  </button>
                ))}
              </div>

              {aba === 'resultados' && (
                results.length
                  ? results.map(resultado => (
                    <section className="panel" key={resultado.id} style={{ marginBottom: 14 }}>
                      <div className="panel-head">
                        <h2>
                          {resultado.competitionClass.division.eventCategory.category.name} · {resultado.competitionClass.division.name} · {resultado.competitionClass.name}
                        </h2>
                        <Badge tom="ok">{t('publico.publicado')}</Badge>
                      </div>
                      {resultado.entries.map(entrada => (
                        <div className="list-row" key={entrada.id}>
                          <span className={`placing placing-${entrada.placing}`}>{entrada.placing ?? '—'}</span>
                          <Avatar name={entrada.athlete.fullName} />
                          <span className="info">
                            <strong>{entrada.athlete.stageName || entrada.athlete.fullName}</strong>
                            <small>
                              {entrada.athlete.team?.name || t('publico.semEquipe')} · {entrada.athlete.city || '—'}
                              {entrada.athlete.state ? `/${entrada.athlete.state}` : ''}
                            </small>
                          </span>
                        </div>
                      ))}
                    </section>
                  ))
                  : <EmptyState title={t('publico.semResultados')} description={t('publico.semResultadosDescricao')} />
              )}

              {aba === 'categorias' && (
                <div className="grid grid-2">
                  {categories.length
                    ? categories.map(item => (
                      <section className="panel" key={item.id}>
                        <div className="panel-head"><h2>{item.category.name}</h2></div>
                        {item.divisions.map(divisao => (
                          <div key={divisao.id} style={{ marginBottom: 12 }}>
                            <strong style={{ fontSize: 12.5 }}>{divisao.name}</strong>
                            <div className="chips" style={{ marginTop: 6 }}>
                              {divisao.classes.map(classe => <span className="chip" key={classe.id}>{classe.name}</span>)}
                              {!divisao.classes.length && <span className="chip">{t('publico.semClasses')}</span>}
                            </div>
                          </div>
                        ))}
                        {!item.divisions.length && <p style={{ color: 'var(--cinza-fraco)', fontSize: 12 }}>{t('publico.semDivisoes')}</p>}
                      </section>
                    ))
                    : <EmptyState title={t('publico.semCategorias')} description={t('publico.semCategoriasDescricao')} />}
                </div>
              )}

              {aba === 'agenda' && (
                <section className="panel">
                  <div className="panel-head"><h2>{t('publico.chamadasEBaterias')}</h2></div>
                  {schedule.length
                    ? schedule.map(bateria => (
                      <div className="list-row" key={bateria.id}>
                        <span className="avatar avatar-sm">{bateria.sortOrder || '·'}</span>
                        <span className="info">
                          <strong>{bateria.name} — {bateria.competitionClass.name}</strong>
                          <small>{bateria.scheduledAt ? formatarDataHora(bateria.scheduledAt, event.timezone) : t('publico.horarioADefinir')}</small>
                        </span>
                        <Badge tom={estadoDaBateria(bateria.status).tom} aoVivo={bateria.status === 'ON_STAGE'}>
                          {estadoDaBateria(bateria.status).rotulo}
                        </Badge>
                      </div>
                    ))
                    : <EmptyState title={t('publico.semAgenda')} description={t('publico.semAgendaDescricao')} />}
                </section>
              )}

              {aba === 'atletas' && (
                <section className="panel">
                  <div className="panel-head"><h2>{t('publico.atletasInscritos')}</h2></div>
                  {athletes.length
                    ? athletes.map(atleta => (
                      <button
                        key={atleta.id}
                        type="button"
                        className="list-row"
                        style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left' }}
                        onClick={() => navegar(`atletas/${atleta.id}`)}
                      >
                        <Avatar name={atleta.fullName} />
                        <span className="info">
                          <strong>{atleta.stageName || atleta.fullName}</strong>
                          <small>
                            {atleta.team?.name || t('publico.semEquipe')} · {atleta.city || '—'}
                            {atleta.state ? `/${atleta.state}` : ''}
                          </small>
                        </span>
                        {atleta.proStatus === 'ACTIVE' && <Badge tom="ok">PRO</Badge>}
                      </button>
                    ))
                    : <EmptyState title={t('publico.semInscritos')} />}
                </section>
              )}

              {aba === 'patrocinadores' && (
                <section className="panel">
                  <div className="panel-head"><h2>{t('publico.patrocinadoresEMarcas')}</h2></div>
                  {sponsors.length
                    ? (
                      <div className="chips">
                        {sponsors.map(patrocinador => (
                          <span className="chip" key={patrocinador.id}>{patrocinador.brand?.name || patrocinador.name}</span>
                        ))}
                      </div>
                    )
                    : <EmptyState title={t('publico.semPatrocinadores')} description={t('publico.semPatrocinadoresDescricao')} />}
                </section>
              )}
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function Atletas({ navegar }) {
  const { t } = useIdioma();
  const [busca, setBusca] = useState('');
  const termo = useDebounce(busca);
  const [pagina, setPagina] = useState({ items: [], nextCursor: null });
  const [carregandoMais, setCarregandoMais] = useState(false);

  const estado = useFetch(async () => {
    const resposta = await api.publicApi.athletes({ limit: 24, search: termo || undefined });
    setPagina(resposta);
    return resposta;
  }, [termo]);

  const carregarMais = async () => {
    setCarregandoMais(true);
    try {
      const resposta = await api.publicApi.athletes({ limit: 24, cursor: pagina.nextCursor, search: termo || undefined });
      setPagina(atual => ({ items: [...atual.items, ...resposta.items], nextCursor: resposta.nextCursor }));
    } finally {
      setCarregandoMais(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('publico.comunidade')}
        title={t('publico.atletas')}
        description={t('publico.perfisPublicos')}
      />

      <div className="toolbar">
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('publico.buscarAtleta')} aria-label={t('publico.buscarAtletaRotulo')} />
        </label>
      </div>

      <AsyncSection state={estado} linhas={5}>
        {() => (pagina.items.length
          ? (
            <>
              {/* `Revelacao` em vez da classe escrita à mão: fixar "revela" no
                  className passava POR CIMA do teto do motor, e o cartão
                  animava mesmo com movimento reduzido. O componente existe
                  justamente para essa decisão não ser repetida — e repetida
                  errado — em cada tela.

                  O `% 24` mantém o teto de 360ms valendo por página: sem ele,
                  três páginas acumuladas fariam o último cartão entrar
                  segundos depois do primeiro. */}
              <div className="grid grid-3">
                {pagina.items.map((atleta, indice) => (
                  <Revelacao
                    as="button"
                    key={atleta.id}
                    indice={indice % 24}
                    type="button"
                    className="panel cartao-clicavel"
                    style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => navegar(`atletas/${atleta.id}`)}
                  >
                    <Avatar name={atleta.fullName} size="avatar-lg" />
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block', fontSize: 14 }}>{atleta.stageName || atleta.fullName}</strong>
                      <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontSize: 11.5, marginTop: 3 }}>
                        {atleta.city || '—'}{atleta.state ? `/${atleta.state}` : ''} · {atleta.team?.name || t('publico.semEquipe')}
                      </small>
                      {atleta.proStatus !== 'NONE' && (
                        <span style={{ display: 'inline-block', marginTop: 8 }}>
                          <Badge tom={estadoPro(atleta.proStatus).tom}>{estadoPro(atleta.proStatus).rotulo}</Badge>
                        </span>
                      )}
                    </span>
                  </Revelacao>
                ))}
              </div>
              <Paginacao nextCursor={pagina.nextCursor} onMore={carregarMais} loading={carregandoMais} />
            </>
          )
          : <EmptyState title={t('publico.nenhumAtleta')} description={t('publico.nenhumAtletaDescricao')} />
        )}
      </AsyncSection>
    </div>
  );
}

export function AtletaDetalhe({ id, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.publicApi.athlete(id), [id]);

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('atletas')} style={{ marginBottom: 14 }}>{t('publico.voltarParaAtletas')}</button>

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          const { athlete, results, titles, rankings } = dados;
          return (
            <>
              <Revelacao as="section" indice={0} className="hero" style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                <Avatar name={athlete.fullName} size="avatar-lg" />
                <div>
                  <span className="eyebrow">{athlete.affiliation?.name || t('publico.semFiliacao')}</span>
                  <h1 style={{ marginTop: 6 }}>{athlete.stageName || athlete.fullName}</h1>
                  <div className="hero-meta" style={{ marginTop: 10 }}>
                    <span>{athlete.city || '—'}{athlete.state ? `/${athlete.state}` : ''}</span>
                    <span>{athlete.team?.name || t('publico.semEquipe')}</span>
                    <span>
                      {athlete.coach?.name
                        ? t('publico.comCoach', { nome: athlete.coach.name })
                        : t('publico.semCoach')}
                    </span>
                    <Badge tom={estadoPro(athlete.proStatus).tom}>{estadoPro(athlete.proStatus).rotulo}</Badge>
                  </div>
                </div>
              </Revelacao>

              {/* A ordem da revelação É a hierarquia: primeiro quem é a
                  pessoa, depois o que ela conquistou, depois o detalhe. */}
              <Revelacao as="div" indice={1} className="grid grid-4" style={{ marginTop: 18 }}>
                <Metric label={t('publico.titulos')} value={titles} destaque />
                <Metric label={t('publico.resultadosPublicados')} value={results.length} />
                <Metric label={t('publico.temporadasNoRanking')} value={rankings.length} />
                <Metric
                  label={t('publico.pontosSomados')}
                  value={rankings.reduce((total, linha) => total + linha.totalPoints, 0)}
                />
              </Revelacao>

              <Revelacao as="div" indice={2} className="grid grid-main" style={{ marginTop: 18 }}>
                <section className="panel">
                  <div className="panel-head"><h2>{t('publico.historicoEsportivo')}</h2></div>
                  {results.length
                    ? results.map((entrada, indice) => (
                      <div className="list-row" key={`${entrada.event.id}-${indice}`}>
                        <span className={`placing placing-${entrada.placing}`}>{entrada.placing ?? '—'}</span>
                        <span className="info">
                          <strong>{entrada.event.name}</strong>
                          <small>
                            {entrada.competitionClass.division.eventCategory.category.name} · {entrada.competitionClass.name} · {formatarData(entrada.publishedAt)}
                          </small>
                        </span>
                        <button type="button" className="button button-ghost button-sm" onClick={() => navegar(`campeonatos/${entrada.event.slug}`)}>{t('publico.verEtapa')}</button>
                      </div>
                    ))
                    : <EmptyState title={t('publico.semResultadosDoAtleta')} />}
                </section>

                <section className="panel">
                  <div className="panel-head"><h2>{t('overall.ranking')}</h2></div>
                  {rankings.length
                    ? rankings.map(linha => (
                      <div className="list-row" key={linha.id}>
                        <span className={`placing placing-${linha.position}`}>{linha.position ?? '—'}</span>
                        <span className="info">
                          <strong>{linha.category?.name || t('publico.geral')}</strong>
                          <small>{linha.season.name} · {t('publico.participacoes', { n: linha.eventCount })}</small>
                        </span>
                        <strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong>
                      </div>
                    ))
                    : <EmptyState title={t('publico.semPontuacao')} />}
                </section>
              </Revelacao>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

// Os QUATRO rankings da temporada. São recortes diferentes do mesmo motor —
// mesma tabela de pontos, mesmo desempate —, e o que muda entre eles é o
// conjunto de lançamentos considerado e a métrica somada:
//
//   Campeonato · Equipes · Empresas  →  pontos do campeonato (toda classe)
//   Super Overall anual              →  pontos elegíveis (só a classe OPEN)
//
// Ficam em abas separadas de propósito: o número do anual não é o do
// campeonato, e apresentá-los na mesma coluna convidaria a somar um com o
// outro.
const ABAS = [
  { chave: 'atletas', rotulo: 'publico.abaCampeonato' },
  { chave: 'superOverall', rotulo: 'publico.abaSuperOverall' },
  { chave: 'equipes', rotulo: 'publico.abaEquipes' },
  { chave: 'empresas', rotulo: 'publico.abaEmpresas' }
];

export function Ranking() {
  const { t } = useIdioma();
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  const [seasonId, setSeasonId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [catalogClassId, setCatalogClassId] = useState('');
  const [aba, setAba] = useState('atletas');
  const categorias = useFetch(() => api.categories.list(), []);

  // AS CLASSES VÊM DO SERVIDOR, RECORTADAS PELA CATEGORIA ESCOLHIDA.
  //
  // Nada de lista escrita aqui: classe nova entra pela importação de um
  // campeonato, e uma lista no código só saberia das que existiam no dia em
  // que alguém a digitou. O endpoint devolve as classes DAQUELA categoria
  // mais as genéricas, que valem em todas.
  const classes = useFetch(
    () => (aba === 'atletas' && categoryId
      ? api.ranking.classes({ seasonId: seasonId || undefined, categoryId })
      : Promise.resolve({ items: [] })),
    [seasonId, categoryId, aba]
  );

  // Trocar de categoria zera a classe. Sem isto a tela ficaria pedindo o
  // cruzamento de uma classe de Women's Physique com Figure — que o servidor
  // recusa, e com razão, mas o operador veria um erro que ele não causou.
  const escolherCategoria = valor => { setCategoryId(valor); setCatalogClassId(''); };

  const estado = useFetch(() => api.ranking.list({
    seasonId: seasonId || undefined,
    categoryId: categoryId || undefined,
    catalogClassId: catalogClassId || undefined,
    limit: 50
  }), [seasonId, categoryId, catalogClassId]);

  const filtros = { seasonId: seasonId || undefined, categoryId: categoryId || undefined };
  // Mesmo teto do ranking do campeonato, logo acima: a lista cresce com a
  // temporada, e medimos 818 KB com 3 mil atletas. O recorte é aplicado depois
  // da classificação, então as posições exibidas são as do ranking inteiro.
  const superOverall = useFetch(() => api.ranking.superOverall({ ...filtros, limit: 50 }), [seasonId, categoryId]);
  const equipes = useFetch(() => api.ranking.teams(filtros), [seasonId, categoryId]);
  const empresas = useFetch(() => api.ranking.companies(filtros), [seasonId, categoryId]);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('publico.temporada')}
        title={t('overall.ranking')}
        description={t('publico.rankingDescricao')}
      />

      <div className="chips" style={{ marginBottom: 14 }}>
        {ABAS.map(item => (
          <button
            key={item.chave}
            type="button"
            className={`chip${aba === item.chave ? ' is-on' : ''}`}
            onClick={() => setAba(item.chave)}
          >
            {t(item.rotulo)}
          </button>
        ))}
      </div>

      {aba === 'superOverall' && (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          <div>
            <strong>{t('publico.classificatorioAnual')}</strong>
            <p><TextoRico chave="publico.classificatorioTexto" /></p>
          </div>
        </div>
      )}

      <div className="toolbar">
        <select className="select-control" value={seasonId} onChange={evento => setSeasonId(evento.target.value)} aria-label={t('publico.temporada')}>
          <option value="">{t('publico.temporadaMaisRecente')}</option>
          {(temporadas.data?.items || []).map(temporada => (
            <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>
          ))}
        </select>
        <select className="select-control" value={categoryId} onChange={evento => escolherCategoria(evento.target.value)} aria-label={t('overall.categoria')}>
          <option value="">{t('publico.todasAsCategorias')}</option>
          {(categorias.data?.items || []).map(categoria => (
            <option key={categoria.id} value={categoria.id}>{categoria.name}</option>
          ))}
        </select>
        {/* SÓ NA ABA DO CAMPEONATO.
            O recorte por classe é do ranking do campeonato, que é derivado
            lançamento a lançamento. Super Overall, equipes e empresas agregam
            por outro caminho e não aceitam esse recorte — deixar o seletor à
            vista neles seria oferecer um filtro que não filtra.

            A CLASSE SÓ EXISTE DENTRO DE UMA CATEGORIA.
            Com "Todas as categorias" o seletor fica desabilitado em vez de
            sumir: escondê-lo faria a terceira etapa do filtro aparecer e
            desaparecer conforme a segunda, e quem não viu o seletor não
            descobre que ele existe. Desabilitado ele continua dizendo
            "aqui dá para recortar por classe — escolha uma categoria". */}
        {aba === 'atletas' && (
          <select
            className="select-control"
            value={catalogClassId}
            disabled={!categoryId}
            onChange={evento => setCatalogClassId(evento.target.value)}
            aria-label={t('publico.classe')}
          >
            <option value="">{t('publico.todasAsClasses')}</option>
            {(classes.data?.items || []).map(classe => (
              /* `displayName` é o que se lê — "Masters 35+". O código
                 (MASTERS_35) é identidade técnica e não aparece na tela. */
              <option key={classe.id} value={classe.id}>{classe.displayName || classe.name}</option>
            ))}
          </select>
        )}
      </div>

      {aba !== 'atletas' && (
        <TabelaDeRanking
          estado={aba === 'superOverall' ? superOverall : aba === 'equipes' ? equipes : empresas}
          modo={aba}
        />
      )}

      {aba === 'atletas' && (
      <AsyncSection state={estado} linhas={6}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>#</th>
                    <th>{t('overall.atleta')}</th>
                    <th>{t('overall.categoria')}</th>
                    <th>{t('publico.uf')}</th>
                    <th className="num">{t('publico.etapas')}</th>
                    {/* A COLUNA QUE FALTAVA.
                        Um teste humano leu "Etapas: 2 · Pontos: 30" e não teve
                        como explicar o 30 — porque a tela não dizia que ali
                        havia DOIS títulos de Overall, cada um valendo +10 no
                        seu próprio campeonato. O número estava certo e mesmo
                        assim parecia defeito.
                        Total que não se explica pela própria tela é total em
                        que ninguém confia. A tabela do Super Overall já trazia
                        esta coluna; a do campeonato, não. */}
                    <th className="num">{t('carreira.colunaOverall')}</th>
                    <th className="num">{t('publico.pontos')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.items.map(linha => (
                    <tr key={linha.id}>
                      <td data-rotulo="#"><span className={`placing placing-${linha.position}`}>{linha.position}</span></td>
                      <td data-rotulo={t('overall.atleta')}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <Avatar name={linha.athlete.fullName} size="avatar-sm" />
                          <div>
                            <strong style={{ display: 'block', fontSize: 13 }}>{linha.athlete.stageName || linha.athlete.fullName}</strong>
                            <small style={{ color: 'var(--cinza-fraco)', fontSize: 11 }}>
                              {linha.athlete.team?.name || t('publico.semEquipe')}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td data-rotulo={t('overall.categoria')}>{linha.category?.name || t('publico.geral')}</td>
                      <td data-rotulo={t('publico.uf')}>{linha.state || '—'}</td>
                      <td className="num" data-rotulo={t('publico.etapas')}>{linha.eventCount}</td>
                      <td className="num" data-rotulo={t('carreira.colunaOverall')}>
                        {linha.overallWins
                          ? <Badge tom="ok">{linha.overallWins}</Badge>
                          : <span style={{ color: 'var(--cinza-fraco)' }}>—</span>}
                      </td>
                      <td className="num" data-rotulo={t('publico.pontos')}><strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* A conta, por extenso, embaixo da tabela: sem isso a coluna
                  nova é só mais um número. */}
              <p className="ranking-legenda"><TextoRico chave="publico.legendaDoRanking" /></p>
            </div>
          )
          : <EmptyState title={t('publico.rankingVazio')} description={t('publico.rankingVazioDescricao')} />
        )}
      </AsyncSection>
      )}
    </div>
  );
}

// Super Overall, equipes e empresas: os três respondem em ARRAY, não no
// envelope paginado do ranking de atletas, e trazem os contadores do
// desempate. Uma tabela só para os três porque a regra é a mesma — dar a cada
// um a sua tabela seria convidar as três a divergirem com o tempo.
function TabelaDeRanking({ estado, modo }) {
  const { t } = useIdioma();

  const titulo = t({
    superOverall: 'publico.semElegiveis',
    equipes: 'publico.semEquipes',
    empresas: 'publico.semEmpresas'
  }[modo]);

  const descricao = t({
    superOverall: 'publico.semElegiveisDescricao',
    equipes: 'publico.semEquipesDescricao',
    empresas: 'publico.semEmpresasDescricao'
  }[modo]);

  return (
    <AsyncSection state={estado} linhas={6}>
      {linhas => (linhas.length
        ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>
                    {t(modo === 'equipes'
                      ? 'publico.equipe'
                      : modo === 'empresas' ? 'publico.empresa' : 'overall.atleta')}
                  </th>
                  {modo === 'empresas' && <th className="num">{t('publico.abaEquipes')}</th>}
                  {modo !== 'superOverall' && <th className="num">{t('publico.atletas')}</th>}
                  <th className="num">{t('publico.etapas')}</th>
                  <th className="num" title={t('publico.primeiroCriterio')}>{t('carreira.colunaOverall')}</th>
                  <th className="num">1º</th>
                  <th className="num">2º</th>
                  <th className="num">3º</th>
                  <th className="num">{t('publico.pontos')}</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((linha, indice) => {
                  const nome = linha.team?.name || linha.company?.name
                    || linha.athlete?.stageName || linha.athlete?.fullName || '—';
                  return (
                    <tr key={linha.team?.id || linha.company?.id || linha.athlete?.id || indice}>
                      <td>
                        {linha.position
                          ? <span className={`placing placing-${linha.position}`}>{linha.position}</span>
                          // Empate que a hierarquia oficial não resolveu: ninguém
                          // recebe a colocação, e a tela diz isso em vez de
                          // inventar uma ordem.
                          : <Badge tom="alerta">{t('publico.empate')}</Badge>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <Avatar name={nome} size="avatar-sm" />
                          <strong style={{ fontSize: 13 }}>{nome}</strong>
                        </div>
                      </td>
                      {modo === 'empresas' && <td className="num">{linha.teamCount ?? '—'}</td>}
                      {modo !== 'superOverall' && <td className="num">{linha.athleteCount ?? '—'}</td>}
                      <td className="num">{linha.eventCount}</td>
                      <td className="num">{linha.overallWins ?? 0}</td>
                      <td className="num">{linha.firstPlaceCount ?? 0}</td>
                      <td className="num">{linha.secondPlaceCount ?? 0}</td>
                      <td className="num">{linha.thirdPlaceCount ?? 0}</td>
                      <td className="num"><strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
        : <EmptyState title={titulo} description={descricao} />
      )}
    </AsyncSection>
  );
}

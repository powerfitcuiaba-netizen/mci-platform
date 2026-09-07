import { useState } from 'react';
import { CalendarDays, ChevronRight, MapPin, Search, Trophy, Users } from 'lucide-react';
import api from '../services/api';
import { useDebounce, useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Metric, PageHead, Paginacao } from '../components/ui';
import { ESTADO_EVENTO, ESTADO_PRO, formatarData, formatarDataHora } from '../lib/format';

// Vitrine pública. Tudo aqui sai da API real; nenhuma métrica é estimada e
// nenhuma lista é fixa no código.

export function Inicio({ navegar }) {
  const resumo = useFetch(() => api.publicApi.summary(), []);
  const ranking = useFetch(() => api.ranking.list({ limit: 10 }), []);

  return (
    <div className="page">
      <section className="hero">
        <span className="eyebrow">Muscle Contest</span>
        <h1>Campeonato Brasileiro Muscle Contest</h1>
        <p>
          Gestão de competição, resultados, ranking e a comunidade do
          fisiculturismo brasileiro em uma única plataforma.
        </p>
        <div className="hero-meta">
          <span><Trophy size={14} /> Onze categorias oficiais</span>
          <span><Users size={14} /> Atletas, coaches, equipes e academias</span>
          <span><CalendarDays size={14} /> Temporadas e ranking nacional</span>
        </div>
      </section>

      <div className="grid grid-4" style={{ marginTop: 18 }}>
        <AsyncSection state={resumo} linhas={1}>
          {dados => (
            <>
              <Metric label="Campeonatos" value={dados.events} />
              <Metric label="Atletas" value={dados.athletes} />
              <Metric label="Atletas PRO" value={dados.proAthletes} destaque />
              <Metric label="Resultados publicados" value={dados.publishedResults} />
            </>
          )}
        </AsyncSection>
      </div>

      <div className="grid grid-main" style={{ marginTop: 18 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Próximos campeonatos</h2>
            <button type="button" className="button button-ghost button-sm" onClick={() => navegar('campeonatos')}>
              Ver todos <ChevronRight size={14} />
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
                    <small>{formatarData(evento.startDate)} · {evento.city || 'Local a definir'}{evento.state ? `/${evento.state}` : ''}</small>
                  </span>
                  <ChevronRight size={16} color="var(--cinza-fraco)" />
                </button>
              ))
              : <EmptyState title="Nenhum campeonato agendado" description="Assim que uma etapa for planejada, ela aparece aqui." />
            )}
          </AsyncSection>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Ranking</h2>
            <button type="button" className="button button-ghost button-sm" onClick={() => navegar('ranking')}>
              Completo <ChevronRight size={14} />
            </button>
          </div>
          <AsyncSection state={ranking} linhas={3}>
            {dados => (dados.items.length
              ? dados.items.slice(0, 8).map(linha => (
                <div className="list-row" key={linha.id}>
                  <span className={`placing placing-${linha.position}`}>{linha.position}</span>
                  <span className="info">
                    <strong>{linha.athlete.stageName || linha.athlete.fullName}</strong>
                    <small>{linha.category?.name || 'Geral'} · {linha.athlete.state || '—'}</small>
                  </span>
                  <strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong>
                </div>
              ))
              : <EmptyState title="Ranking em construção" description="A pontuação aparece após a publicação dos primeiros resultados." />
            )}
          </AsyncSection>
        </section>
      </div>
    </div>
  );
}

export function Campeonatos({ navegar }) {
  const [busca, setBusca] = useState('');
  const termo = useDebounce(busca);
  const estado = useFetch(() => api.publicApi.events({ limit: 24 }), []);

  return (
    <div className="page">
      <PageHead eyebrow="Competições" title="Campeonatos" description="Etapas do Campeonato Brasileiro Muscle Contest." />

      <div className="toolbar">
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Buscar campeonato…" aria-label="Buscar campeonato" />
        </label>
      </div>

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          const lista = dados.items.filter(item => item.name.toLowerCase().includes(termo.toLowerCase()));
          if (!lista.length) return <EmptyState title="Nenhum campeonato encontrado" description="Ajuste a busca para ver outras etapas." />;

          return (
            <div className="grid grid-3">
              {lista.map(evento => {
                const estadoEvento = ESTADO_EVENTO[evento.status] || { rotulo: evento.status, tom: 'neutro' };
                return (
                  <button
                    key={evento.id}
                    type="button"
                    className="panel"
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => navegar(`campeonatos/${evento.slug}`)}
                  >
                    <Badge tom={estadoEvento.tom}>{estadoEvento.rotulo}</Badge>
                    <h3 className="display" style={{ fontSize: 22, margin: '14px 0 6px' }}>{evento.name}</h3>
                    <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: 0, minHeight: 34 }}>
                      {evento.description || 'Etapa do Campeonato Brasileiro Muscle Contest.'}
                    </p>
                    <div style={{ display: 'flex', gap: 14, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--linha)', fontSize: 11.5, color: 'var(--cinza-fraco)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} /> {formatarData(evento.startDate)}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><Users size={13} /> {evento._count.registrations}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function CampeonatoDetalhe({ slug, navegar }) {
  const estado = useFetch(() => api.publicApi.event(slug), [slug]);
  const [aba, setAba] = useState('resultados');

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('campeonatos')} style={{ marginBottom: 14 }}>
        ← Campeonatos
      </button>

      <AsyncSection state={estado} linhas={5}>
        {dados => {
          const { event, categories, schedule, athletes, results, sponsors } = dados;
          const estadoEvento = ESTADO_EVENTO[event.status] || { rotulo: event.status, tom: 'neutro' };

          return (
            <>
              <section className="hero">
                <Badge tom={estadoEvento.tom}>{estadoEvento.rotulo}</Badge>
                <h1 style={{ marginTop: 12 }}>{event.name}</h1>
                {event.description && <p>{event.description}</p>}
                <div className="hero-meta">
                  <span><CalendarDays size={14} /> {formatarData(event.startDate, event.timezone)}{event.endDate ? ` — ${formatarData(event.endDate, event.timezone)}` : ''}</span>
                  {event.venue && <span><MapPin size={14} /> {event.venue}</span>}
                  {event.city && <span><MapPin size={14} /> {event.city}{event.state ? `/${event.state}` : ''}</span>}
                  <span><Users size={14} /> {athletes.length} atletas</span>
                </div>
              </section>

              <div className="chips" style={{ margin: '18px 0' }}>
                {[['resultados', 'Resultados'], ['categorias', 'Categorias'], ['agenda', 'Agenda'], ['atletas', 'Atletas'], ['patrocinadores', 'Patrocinadores']].map(([chave, rotulo]) => (
                  <button key={chave} type="button" className={`chip${aba === chave ? ' is-on' : ''}`} onClick={() => setAba(chave)}>{rotulo}</button>
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
                        <Badge tom="ok">Publicado</Badge>
                      </div>
                      {resultado.entries.map(entrada => (
                        <div className="list-row" key={entrada.id}>
                          <span className={`placing placing-${entrada.placing}`}>{entrada.placing ?? '—'}</span>
                          <Avatar name={entrada.athlete.fullName} />
                          <span className="info">
                            <strong>{entrada.athlete.stageName || entrada.athlete.fullName}</strong>
                            <small>{entrada.athlete.team?.name || 'Sem equipe'} · {entrada.athlete.city || '—'}{entrada.athlete.state ? `/${entrada.athlete.state}` : ''}</small>
                          </span>
                        </div>
                      ))}
                    </section>
                  ))
                  : <EmptyState title="Resultados ainda não publicados" description="A classificação aparece aqui quando a organização publicar a apuração." />
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
                              {!divisao.classes.length && <span className="chip">Sem classes cadastradas</span>}
                            </div>
                          </div>
                        ))}
                        {!item.divisions.length && <p style={{ color: 'var(--cinza-fraco)', fontSize: 12 }}>Divisões ainda não cadastradas.</p>}
                      </section>
                    ))
                    : <EmptyState title="Categorias não definidas" description="A organização ainda não montou o quadro de categorias." />}
                </div>
              )}

              {aba === 'agenda' && (
                <section className="panel">
                  <div className="panel-head"><h2>Chamadas e baterias</h2></div>
                  {schedule.length
                    ? schedule.map(bateria => (
                      <div className="list-row" key={bateria.id}>
                        <span className="avatar avatar-sm">{bateria.sortOrder || '·'}</span>
                        <span className="info">
                          <strong>{bateria.name} — {bateria.competitionClass.name}</strong>
                          <small>{bateria.scheduledAt ? formatarDataHora(bateria.scheduledAt, event.timezone) : 'Horário a definir'}</small>
                        </span>
                        <Badge tom={bateria.status === 'DONE' ? 'neutro' : bateria.status === 'ON_STAGE' ? 'perigo' : bateria.status === 'CALLED' ? 'alerta' : 'info'}>
                          {bateria.status}
                        </Badge>
                      </div>
                    ))
                    : <EmptyState title="Agenda não publicada" description="As baterias aparecem quando a ordem de palco for montada." />}
                </section>
              )}

              {aba === 'atletas' && (
                <section className="panel">
                  <div className="panel-head"><h2>Atletas inscritos</h2></div>
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
                          <small>{atleta.team?.name || 'Sem equipe'} · {atleta.city || '—'}{atleta.state ? `/${atleta.state}` : ''}</small>
                        </span>
                        {atleta.proStatus === 'ACTIVE' && <Badge tom="ok">PRO</Badge>}
                      </button>
                    ))
                    : <EmptyState title="Sem inscritos confirmados" />}
                </section>
              )}

              {aba === 'patrocinadores' && (
                <section className="panel">
                  <div className="panel-head"><h2>Patrocinadores e marcas</h2></div>
                  {sponsors.length
                    ? (
                      <div className="chips">
                        {sponsors.map(patrocinador => (
                          <span className="chip" key={patrocinador.id}>{patrocinador.brand?.name || patrocinador.name}</span>
                        ))}
                      </div>
                    )
                    : <EmptyState title="Sem patrocinadores registrados" description="O apoio institucional do evento aparece aqui." />}
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
      <PageHead eyebrow="Comunidade" title="Atletas" description="Perfis públicos dos atletas da plataforma." />

      <div className="toolbar">
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Buscar por nome ou nome esportivo…" aria-label="Buscar atleta" />
        </label>
      </div>

      <AsyncSection state={estado} linhas={5}>
        {() => (pagina.items.length
          ? (
            <>
              <div className="grid grid-3">
                {pagina.items.map(atleta => (
                  <button
                    key={atleta.id}
                    type="button"
                    className="panel"
                    style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', cursor: 'pointer' }}
                    onClick={() => navegar(`atletas/${atleta.id}`)}
                  >
                    <Avatar name={atleta.fullName} size="avatar-lg" />
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block', fontSize: 14 }}>{atleta.stageName || atleta.fullName}</strong>
                      <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontSize: 11.5, marginTop: 3 }}>
                        {atleta.city || '—'}{atleta.state ? `/${atleta.state}` : ''} · {atleta.team?.name || 'Sem equipe'}
                      </small>
                      {atleta.proStatus !== 'NONE' && (
                        <span style={{ display: 'inline-block', marginTop: 8 }}>
                          <Badge tom={ESTADO_PRO[atleta.proStatus].tom}>{ESTADO_PRO[atleta.proStatus].rotulo}</Badge>
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <Paginacao nextCursor={pagina.nextCursor} onMore={carregarMais} loading={carregandoMais} />
            </>
          )
          : <EmptyState title="Nenhum atleta encontrado" description="Ajuste a busca ou aguarde novos cadastros." />
        )}
      </AsyncSection>
    </div>
  );
}

export function AtletaDetalhe({ id, navegar }) {
  const estado = useFetch(() => api.publicApi.athlete(id), [id]);

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('atletas')} style={{ marginBottom: 14 }}>← Atletas</button>

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          const { athlete, results, titles, rankings } = dados;
          return (
            <>
              <section className="hero" style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                <Avatar name={athlete.fullName} size="avatar-lg" />
                <div>
                  <span className="eyebrow">{athlete.affiliation?.name || 'Sem filiação'}</span>
                  <h1 style={{ marginTop: 6 }}>{athlete.stageName || athlete.fullName}</h1>
                  <div className="hero-meta" style={{ marginTop: 10 }}>
                    <span>{athlete.city || '—'}{athlete.state ? `/${athlete.state}` : ''}</span>
                    <span>{athlete.team?.name || 'Sem equipe'}</span>
                    <span>{athlete.coach?.name ? `Coach ${athlete.coach.name}` : 'Sem coach'}</span>
                    <Badge tom={ESTADO_PRO[athlete.proStatus].tom}>{ESTADO_PRO[athlete.proStatus].rotulo}</Badge>
                  </div>
                </div>
              </section>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <Metric label="Títulos" value={titles} destaque />
                <Metric label="Resultados publicados" value={results.length} />
                <Metric label="Temporadas no ranking" value={rankings.length} />
                <Metric label="Pontos somados" value={rankings.reduce((total, linha) => total + linha.totalPoints, 0)} />
              </div>

              <div className="grid grid-main" style={{ marginTop: 18 }}>
                <section className="panel">
                  <div className="panel-head"><h2>Histórico esportivo</h2></div>
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
                        <button type="button" className="button button-ghost button-sm" onClick={() => navegar(`campeonatos/${entrada.event.slug}`)}>Ver etapa</button>
                      </div>
                    ))
                    : <EmptyState title="Ainda sem resultados publicados" />}
                </section>

                <section className="panel">
                  <div className="panel-head"><h2>Ranking</h2></div>
                  {rankings.length
                    ? rankings.map(linha => (
                      <div className="list-row" key={linha.id}>
                        <span className={`placing placing-${linha.position}`}>{linha.position ?? '—'}</span>
                        <span className="info">
                          <strong>{linha.category?.name || 'Geral'}</strong>
                          <small>{linha.season.name} · {linha.eventCount} participação(ões)</small>
                        </span>
                        <strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong>
                      </div>
                    ))
                    : <EmptyState title="Sem pontuação de ranking" />}
                </section>
              </div>
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
  { chave: 'atletas', rotulo: 'Campeonato' },
  { chave: 'superOverall', rotulo: 'Super Overall' },
  { chave: 'equipes', rotulo: 'Equipes' },
  { chave: 'empresas', rotulo: 'Empresas' }
];

export function Ranking() {
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  const [seasonId, setSeasonId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [aba, setAba] = useState('atletas');
  const categorias = useFetch(() => api.categories.list(), []);
  const estado = useFetch(() => api.ranking.list({ seasonId: seasonId || undefined, categoryId: categoryId || undefined, limit: 50 }), [seasonId, categoryId]);

  const filtros = { seasonId: seasonId || undefined, categoryId: categoryId || undefined };
  const superOverall = useFetch(() => api.ranking.superOverall(filtros), [seasonId, categoryId]);
  const equipes = useFetch(() => api.ranking.teams(filtros), [seasonId, categoryId]);
  const empresas = useFetch(() => api.ranking.companies(filtros), [seasonId, categoryId]);

  return (
    <div className="page">
      <PageHead eyebrow="Temporada" title="Ranking" description="Pontuação por atleta, equipe, empresa e temporada. Cada ponto é rastreável até a sua origem." />

      <div className="chips" style={{ marginBottom: 14 }}>
        {ABAS.map(item => (
          <button
            key={item.chave}
            type="button"
            className={`chip${aba === item.chave ? ' is-on' : ''}`}
            onClick={() => setAba(item.chave)}
          >
            {item.rotulo}
          </button>
        ))}
      </div>

      {aba === 'superOverall' && (
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          <div>
            <strong>Classificatório anual</strong>
            <p>
              Todas as classes pontuam no campeonato, mas somente a <strong>Open</strong>
              {' '}alimenta o Super Overall. Os números desta aba não se somam aos das outras.
            </p>
          </div>
        </div>
      )}

      <div className="toolbar">
        <select className="select-control" value={seasonId} onChange={evento => setSeasonId(evento.target.value)} aria-label="Temporada">
          <option value="">Temporada aberta mais recente</option>
          {(temporadas.data?.items || []).map(temporada => (
            <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>
          ))}
        </select>
        <select className="select-control" value={categoryId} onChange={evento => setCategoryId(evento.target.value)} aria-label="Categoria">
          <option value="">Todas as categorias</option>
          {(categorias.data?.items || []).map(categoria => (
            <option key={categoria.id} value={categoria.id}>{categoria.name}</option>
          ))}
        </select>
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
                    <th>Atleta</th>
                    <th>Categoria</th>
                    <th>UF</th>
                    <th className="num">Etapas</th>
                    <th className="num">Pontos</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.items.map(linha => (
                    <tr key={linha.id}>
                      <td><span className={`placing placing-${linha.position}`}>{linha.position}</span></td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <Avatar name={linha.athlete.fullName} size="avatar-sm" />
                          <div>
                            <strong style={{ display: 'block', fontSize: 13 }}>{linha.athlete.stageName || linha.athlete.fullName}</strong>
                            <small style={{ color: 'var(--cinza-fraco)', fontSize: 11 }}>{linha.athlete.team?.name || 'Sem equipe'}</small>
                          </div>
                        </div>
                      </td>
                      <td>{linha.category?.name || 'Geral'}</td>
                      <td>{linha.state || '—'}</td>
                      <td className="num">{linha.eventCount}</td>
                      <td className="num"><strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title="Ranking vazio" description="A pontuação aparece quando resultados forem publicados ou importados." />
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
  const titulo = {
    superOverall: 'Nenhum resultado elegível',
    equipes: 'Nenhuma equipe pontuou',
    empresas: 'Nenhuma empresa pontuou'
  }[modo];

  const descricao = {
    superOverall: 'Só resultados da classe Open publicados alimentam o classificatório anual.',
    equipes: 'A equipe pontua pelo que os seus atletas conquistam.',
    empresas: 'A empresa pontua pelo que as suas equipes conquistam.'
  }[modo];

  return (
    <AsyncSection state={estado} linhas={6}>
      {linhas => (linhas.length
        ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>#</th>
                  <th>{modo === 'equipes' ? 'Equipe' : modo === 'empresas' ? 'Empresa' : 'Atleta'}</th>
                  {modo === 'empresas' && <th className="num">Equipes</th>}
                  {modo !== 'superOverall' && <th className="num">Atletas</th>}
                  <th className="num">Etapas</th>
                  <th className="num" title="Primeiro critério de desempate">Overall</th>
                  <th className="num">1º</th>
                  <th className="num">2º</th>
                  <th className="num">3º</th>
                  <th className="num">Pontos</th>
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
                          : <Badge tom="alerta">empate</Badge>}
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

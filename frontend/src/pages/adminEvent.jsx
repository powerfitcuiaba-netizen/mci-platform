import { useState } from 'react';
import { CalendarDays, ClipboardCheck, Pencil, Plus, QrCode, Scale, Search } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch, useListaPaginada } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, CodigoQr, ConfirmDialog, EmptyState, Field, Metric, Modal, ModalActions, PageHead, Paginacao } from '../components/ui';
import { anunciar, MCIEvento } from '../lib/experiencia';
import { useIdioma } from '../lib/idioma';

// O tamanho da PÁGINA, não o teto da lista. Enquanto era teto, a operação
// enxergava 100 de 280 inscritos; agora é de quanto em quanto a tela pede.
// O valor é o máximo que a API aceita (`src/utils/schemas.js`): menos páginas
// para o operador percorrer no dia da competição.
export const POR_PAGINA = 100;
import { ContadorVivo, PulsoAoVivo, Revelacao, useRecemAfetado } from '../components/experiencia';
import { estiloDaSequencia } from '../lib/experiencia';
import {
  ESTADO_EVENTO, TRANSICOES_EVENTO, formatarData, formatarDataHora, mascararCpf, pesoEmKg, seloDoEvento, somenteDigitos, estadoDaBateria, estadoDaInscricao, tipoDeCredencial } from '../lib/format';

// Área administrativa do evento. Cada tela opera contra a API real e reflete a
// máquina de estados do servidor: o que a API recusaria, a interface não
// oferece.

// Seletor de evento compartilhado pelas telas operacionais: inscrições,
// check-in, pesagem, credenciamento, palco e resultados. É a porta de todas
// elas.
//
// A falha PRECISA aparecer aqui. Sem isso, busca que falhou e campeonato sem
// evento ficavam idênticos — uma caixa escrita "Selecione o evento…" e mais
// nada. No dia da competição esse é o pior desfecho: o operador conclui que o
// evento sumiu do sistema quando o que caiu foi a rede, e vai procurar o
// problema no lugar errado enquanto a fila cresce.
export function SeletorDeEvento({ eventId, onChange, filtroStatus }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.events.list({ limit: 50 }), []);
  // `Array.isArray` e não `|| []`: um `items` que veio como texto passa pelo
  // `||` e quebra no `.filter`. A normalização no cliente da API já defende o
  // caso, e esta linha é a segunda camada — a lista aqui também vem de
  // `estado.data`, que um teste pode montar à mão.
  const lista = (Array.isArray(estado.data?.items) ? estado.data.items : [])
    .filter(evento => (filtroStatus ? filtroStatus.includes(evento.status) : true));
  const falhou = Boolean(estado.error);

  return (
    // `minWidth: 0` e `maxWidth: '100%'` no INVÓLUCRO, e não só no `select`:
    // um item de flex tem `min-width: auto` por padrão e se recusa a encolher
    // abaixo do próprio conteúdo. Com nomes longos de campeonato o bloco ficava
    // com 342px dentro de uma viewport de 320 e empurrava a página inteira para
    // fora. `max-width: 100%` no filho não resolvia: 100% de 342 é 342.
    //
    // Medido pelo gate visual, que devolveu a geometria com nome e número.
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
      <select
        className="select-control"
        value={eventId || ''}
        onChange={evento => onChange(evento.target.value)}
        aria-label={t('evento.selecionarEvento')}
        // Escolher numa lista que não carregou não significaria nada.
        disabled={falhou}
      >
        <option value="">{falhou ? t('evento.listaIndisponivel') : t('evento.selecioneOEvento')}</option>
        {lista.map(evento => (
          <option key={evento.id} value={evento.id}>
            {evento.name} — {(ESTADO_EVENTO[evento.status] || {}).rotulo || evento.status}
          </option>
        ))}
      </select>

      {falhou && (
        <span className="alert alert-erro" role="alert" style={{ padding: '6px 10px', margin: 0, fontSize: 12 }}>
          <span style={{ flex: 1 }}>{t('evento.falhaAoCarregarEventos')} {estado.error}</span>
          <button type="button" className="button button-secondary button-sm" onClick={estado.reload}>
            {t('ui.tentarDeNovo')}
          </button>
        </span>
      )}
    </div>
  );
}

export function AdminEventos({ notificar, navegar }) {
  const { t } = useIdioma();
  const [criando, setCriando] = useState(false);
  const [status, setStatus] = useState('');
  const estado = useFetch(() => api.events.list({ limit: 50, status: status || undefined }), [status]);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('evento.administracao')}
        title={t('evento.eventos')}
        description={t('evento.eventosDescricao')}
        actions={<button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} />{t('evento.novoEvento')}</button>}
      />

      <div className="toolbar">
        <select className="select-control" value={status} onChange={evento => setStatus(evento.target.value)} aria-label={t('evento.filtrarPorEstado')}>
          <option value="">{t('evento.todosOsEstados')}</option>
          {Object.entries(ESTADO_EVENTO).map(([chave, valor]) => <option key={chave} value={chave}>{valor.rotulo}</option>)}
        </select>
      </div>

      <AsyncSection state={estado} linhas={4}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>{t('evento.colunaEvento')}</th><th>{t('evento.colunaEstado')}</th><th>{t('evento.colunaData')}</th><th>{t('evento.local')}</th><th className="num">{t('evento.inscritos')}</th><th /></tr>
                </thead>
                <tbody>
                  {dados.items.map(evento => {
                    const info = seloDoEvento(evento);
                    return (
                      <tr key={evento.id}>
                        <td><strong>{evento.name}</strong></td>
                        <td><Badge tom={info.tom}>{info.rotulo}</Badge></td>
                        <td>{formatarData(evento.startDate, evento.timezone)}</td>
                        <td>{evento.city || '—'}{evento.state ? `/${evento.state}` : ''}</td>
                        <td className="num">{evento._count.registrations}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button type="button" className="button button-secondary button-sm" onClick={() => navegar(`admin/eventos/${evento.id}`)}>{t('evento.abrir')}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title={t('evento.nenhumEvento')} description={t('evento.nenhumEventoDescricao')} action={<button type="button" className="button button-primary" onClick={() => setCriando(true)}>{t('evento.novoEvento')}</button>} />
        )}
      </AsyncSection>

      {criando && <NovoEvento notificar={notificar} onClose={() => setCriando(false)} onCriado={() => { setCriando(false); estado.reload(); }} />}
    </div>
  );
}

function NovoEvento({ notificar, onClose, onCriado }) {
  const { t } = useIdioma();
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  const [form, setForm] = useState({ organizationId: '', name: '', slug: '', description: '', startDate: '', endDate: '', venue: '', city: '', state: '', seasonId: '' });
  const [salvando, setSalvando] = useState(false);

  const definirNome = valor => {
    setForm(atual => ({
      ...atual,
      name: valor,
      // O slug acompanha o nome enquanto não for editado à mão.
      slug: atual.slugEditado ? atual.slug : valor.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    }));
  };

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.create({
        organizationId: form.organizationId,
        name: form.name,
        slug: form.slug,
        description: form.description || null,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        venue: form.venue || null,
        city: form.city || null,
        state: form.state || null,
        seasonId: form.seasonId || null
      });
      notificar(t('evento.criadoRascunho'));
      refreshData();
      onCriado();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.novoEvento')} description={t('evento.novoEventoDescricao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.organizacao')} required>
          <select value={form.organizationId} onChange={evento => setForm({ ...form, organizationId: evento.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label={t('evento.nome')} required>
          <input value={form.name} onChange={evento => definirNome(evento.target.value)} required minLength={3} maxLength={160} placeholder={t('evento.exemploNome')} />
        </Field>
        <Field label={t('evento.identificadorNaUrl')} required hint={t('evento.identificadorHint')}>
          <input value={form.slug} onChange={evento => setForm({ ...form, slug: evento.target.value.toLowerCase(), slugEditado: true })} required pattern="[a-z0-9\-]{3,80}" />
        </Field>
        <Field label={t('evento.descricao')}>
          <textarea value={form.description} onChange={evento => setForm({ ...form, description: evento.target.value })} maxLength={4000} />
        </Field>
        <div className="field-row">
          <Field label={t('evento.inicio')}><input type="date" value={form.startDate} onChange={evento => setForm({ ...form, startDate: evento.target.value })} /></Field>
          <Field label={t('evento.termino')}><input type="date" value={form.endDate} onChange={evento => setForm({ ...form, endDate: evento.target.value })} /></Field>
        </div>
        <div className="field-row">
          <Field label={t('evento.cidade')}><input value={form.city} onChange={evento => setForm({ ...form, city: evento.target.value })} maxLength={90} /></Field>
          <Field label="UF"><input value={form.state} onChange={evento => setForm({ ...form, state: evento.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
        </div>
        <Field label={t('evento.local')}><input value={form.venue} onChange={evento => setForm({ ...form, venue: evento.target.value })} maxLength={160} /></Field>
        <Field label={t('evento.temporada')} hint={t('evento.temporadaHint')}>
          <select value={form.seasonId} onChange={evento => setForm({ ...form, seasonId: evento.target.value })}>
            <option value="">{t('evento.semTemporada')}</option>
            {(temporadas.data?.items || []).map(temporada => <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>)}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.criarEvento')} />
      </form>
    </Modal>
  );
}

// Edição de evento.
//
// O backend sempre teve PATCH /events/:id — com autorização, validação e
// auditoria — e o cliente da API sempre teve `events.update`. O que faltava
// era tela: nenhum componente chamava. Um administrador conseguia CRIAR um
// campeonato e mover o estado dele, mas não corrigir o nome, a data ou o
// local depois. Só existia o caminho de apagar, e apagar é recusado assim que
// houver inscrição.
//
// Três campos NÃO entram aqui de propósito, e cada um por um motivo distinto:
//
//   slug ............. é o endereço público do evento; mudar quebra link já
//                      divulgado. O contrato de `eventUpdate` também não o
//                      aceita.
//   organizationId ... trocar de federação não é edição, é outra coisa. O
//                      schema não aceita, e é assim que deve ser.
//   status ........... existe rota própria, auditada, com máquina de estados.
//                      Trazer o estado para cá o transformaria num campo
//                      comum e contornaria a transição.
// Exportado para o teste montar o editor isolado, sem precisar navegar a tela
// inteira do evento só para chegar ao formulário.
export function EditarEvento({ evento, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  // `<input type="date">` fala YYYY-MM-DD; o que vem da API é ISO completo.
  const soData = valor => (valor ? String(valor).slice(0, 10) : '');
  const [form, setForm] = useState({
    name: evento.name || '',
    description: evento.description || '',
    startDate: soData(evento.startDate),
    endDate: soData(evento.endDate),
    venue: evento.venue || '',
    city: evento.city || '',
    state: evento.state || '',
    seasonId: evento.season?.id || evento.seasonId || ''
  });
  const [salvando, setSalvando] = useState(false);

  const salvar = async submissao => {
    submissao.preventDefault();
    if (salvando) return;            // trava o duplo envio
    setSalvando(true);
    try {
      await api.events.update(evento.id, {
        name: form.name,
        description: form.description || null,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        venue: form.venue || null,
        city: form.city || null,
        state: form.state || null,
        seasonId: form.seasonId || null
      });
      notificar(t('evento.atualizado'));
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={t('evento.editarEvento')}
      description={t('evento.editarDescricao')}
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        <Field label={t('evento.nome')} required>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required minLength={3} maxLength={160} />
        </Field>
        <Field label={t('evento.descricao')}>
          <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} maxLength={4000} />
        </Field>
        <div className="field-row">
          <Field label={t('evento.inicio')}><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
          <Field label={t('evento.termino')}><input type="date" value={form.endDate} min={form.startDate || undefined} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field>
        </div>
        <div className="field-row">
          <Field label={t('evento.cidade')}><input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} maxLength={90} /></Field>
          <Field label="UF"><input value={form.state} onChange={e => setForm({ ...form, state: e.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
        </div>
        <Field label={t('evento.local')}><input value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} maxLength={160} /></Field>
        <Field label={t('evento.temporada')} hint={t('evento.temporadaHint')}>
          <select value={form.seasonId} onChange={e => setForm({ ...form, seasonId: e.target.value })}>
            <option value="">{t('evento.semTemporada')}</option>
            {(temporadas.data?.items || []).map(t => <option key={t.id} value={t.id}>{t.name} ({t.year})</option>)}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.salvarAlteracoes')} />
      </form>
    </Modal>
  );
}

export function AdminEventoDetalhe({ eventId, notificar, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.events.findOne(eventId), [eventId]);
  const operacao = useFetch(() => api.events.operations(eventId), [eventId]);
  const [modal, setModal] = useState(null);
  const [transicao, setTransicao] = useState(null);
  const [editando, setEditando] = useState(false);

  const aplicarTransicao = async status => {
    try {
      await api.events.transition(eventId, { status });
      notificar(`Evento movido para ${(ESTADO_EVENTO[status] || {}).rotulo || status}.`);
      estado.reload();
      operacao.reload();
      refreshData();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('admin/eventos')} style={{ marginBottom: 14 }}>← Eventos</button>

      <AsyncSection state={estado} linhas={4}>
        {evento => {
          const info = seloDoEvento(evento);
          const proximos = TRANSICOES_EVENTO[evento.status] || [];

          return (
            <>
              <section className="hero">
                <Badge tom={info.tom}>{info.rotulo}</Badge>
                <h1 style={{ marginTop: 12 }}>{evento.name}</h1>
                <div className="hero-meta">
                  <span><CalendarDays size={14} /> {formatarData(evento.startDate, evento.timezone)}</span>
                  <span>{evento.city || '—'}{evento.state ? `/${evento.state}` : ''}</span>
                  <span>Fuso {evento.timezone}</span>
                  <span>{evento.organization.name}</span>
                  <span>{evento.season ? t('evento.temporadaDe', { nome: evento.season.name }) : t('evento.semTemporada')}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                  {/* Evento encerrado ou cancelado não se edita: o registro
                      histórico é o que dá valor ao resultado publicado. O
                      backend recusa com EVENT_IMMUTABLE; a tela não oferece o
                      botão, para a pessoa não descobrir isso por erro. */}
                  {!['CLOSED', 'CANCELLED'].includes(evento.status) && (
                    <button type="button" className="button button-sm button-primary" onClick={() => setEditando(true)}>
                      <Pencil size={14} />{t('evento.editar')}</button>
                  )}
                  {proximos.length
                    ? proximos.map(status => (
                      <button
                        key={status}
                        type="button"
                        className={`button button-sm ${status === 'CANCELLED' ? 'button-danger' : 'button-secondary'}`}
                        onClick={() => setTransicao(status)}
                      >
                        {(ESTADO_EVENTO[status] || {}).rotulo || status}
                      </button>
                    ))
                    : <span style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('evento.estadoFinal')}</span>}
                </div>
              </section>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <AsyncSection state={operacao} linhas={1}>
                  {dados => (
                    <>
                      <Metric label={t('evento.inscritos')} value={dados.registrations} />
                      <Metric label={t('evento.checkInFeito')} value={dados.checkedIn} hint={`${dados.pendingCheckIn} pendente(s)`} />
                      <Metric label={t('evento.pesagens')} value={dados.weighedIn} />
                      <Metric label={t('evento.credenciaisAtivas')} value={dados.credentials} />
                    </>
                  )}
                </AsyncSection>
              </div>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-head">
                  <h2>{t('evento.quadroDeCategorias')}</h2>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setModal({ tipo: 'categoria' })}>
                    <Plus size={13} />{t('evento.categoria')}</button>
                </div>

                {evento.eventCategories.length
                  ? evento.eventCategories.map(eventCategory => (
                    <div key={eventCategory.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <strong style={{ fontSize: 13.5 }}>{eventCategory.category.name}</strong>
                        <Badge tom="info">{eventCategory.category.sex === 'MALE' ? t('evento.masculina') : t('evento.feminina')}</Badge>
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => setModal({ tipo: 'divisao', eventCategoryId: eventCategory.id })}
                        >
                          + Divisão
                        </button>
                      </div>

                      {eventCategory.divisions.map(divisao => (
                        <div key={divisao.id} style={{ marginTop: 10, paddingLeft: 14, borderLeft: '2px solid var(--linha)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12.5 }}>{divisao.name} <small style={{ color: 'var(--cinza-fraco)' }}>({divisao.code})</small></span>
                            <button
                              type="button"
                              className="button button-ghost button-sm"
                              style={{ marginLeft: 'auto' }}
                              onClick={() => setModal({ tipo: 'classe', divisionId: divisao.id })}
                            >
                              + Classe
                            </button>
                          </div>
                          <div className="chips" style={{ marginTop: 6 }}>
                            {divisao.classes.map(classe => <span className="chip" key={classe.id}>{classe.name}</span>)}
                            {!divisao.classes.length && <span style={{ fontSize: 11.5, color: 'var(--cinza-fraco)' }}>{t('evento.nenhumaClasse')}</span>}
                          </div>
                        </div>
                      ))}
                      {!eventCategory.divisions.length && <p style={{ fontSize: 12, color: 'var(--cinza-fraco)', marginTop: 8 }}>{t('evento.semDivisoes')}</p>}
                    </div>
                  ))
                  : <EmptyState title={t('evento.semCategorias')} description={t('evento.semCategoriasDescricao')} />}
              </section>
            </>
          );
        }}
      </AsyncSection>

      {modal?.tipo === 'categoria' && (
        <AdicionarCategoria eventId={eventId} notificar={notificar} onClose={() => setModal(null)} onSalvo={() => { setModal(null); estado.reload(); }} />
      )}
      {modal?.tipo === 'divisao' && (
        <AdicionarDivisao eventCategoryId={modal.eventCategoryId} notificar={notificar} onClose={() => setModal(null)} onSalvo={() => { setModal(null); estado.reload(); }} />
      )}
      {modal?.tipo === 'classe' && (
        <AdicionarClasse divisionId={modal.divisionId} notificar={notificar} onClose={() => setModal(null)} onSalvo={() => { setModal(null); estado.reload(); }} />
      )}
      {editando && estado.data && (
        <EditarEvento
          evento={estado.data}
          notificar={notificar}
          onClose={() => setEditando(false)}
          onSalvo={() => { setEditando(false); estado.reload(); }}
        />
      )}
      {transicao && (
        <ConfirmDialog
          title={t('evento.mudarEstado')}
          message={`${t('evento.moverPara', { estado: (ESTADO_EVENTO[transicao] || {}).rotulo || transicao })} ${transicao === 'RESULTS_PUBLISHED' ? t('evento.resultadosVisiveis') : ''}`}
          confirmLabel="Confirmar"
          onConfirm={() => aplicarTransicao(transicao)}
          onClose={() => setTransicao(null)}
        />
      )}
    </div>
  );
}

function AdicionarCategoria({ eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const catalogo = useFetch(() => api.categories.list(), []);
  const [categoryId, setCategoryId] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.addCategory(eventId, { categoryId });
      notificar(t('evento.categoriaAdicionada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.adicionarCategoria')} description={t('evento.catalogoOficial')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.categoria')} required>
          <select value={categoryId} onChange={evento => setCategoryId(evento.target.value)} required>
            <option value="">{t('evento.selecione')}</option>
            {(catalogo.data?.items || []).map(categoria => (
              <option key={categoria.id} value={categoria.id}>{categoria.name} ({categoria.sex === 'MALE' ? 'M' : 'F'})</option>
            ))}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.adicionar')} />
      </form>
    </Modal>
  );
}

function AdicionarDivisao({ eventCategoryId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ name: '', code: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.addDivision(eventCategoryId, form);
      notificar(t('evento.divisaoCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.novaDivisao')} description={t('evento.novaDivisaoDescricao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.nome')} required><input value={form.name} onChange={evento => setForm({ ...form, name: evento.target.value })} required maxLength={90} placeholder={t('evento.exemploDivisao')} /></Field>
        <Field label={t('evento.codigo')} required><input value={form.code} onChange={evento => setForm({ ...form, code: evento.target.value.toUpperCase() })} required pattern="[A-Z0-9_\-]{1,40}" placeholder="ATE163" /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.criarDivisao')} />
      </form>
    </Modal>
  );
}

function AdicionarClasse({ divisionId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ name: 'Open', code: 'OPEN', minAge: '', maxAge: '', minWeightGrams: '', maxWeightGrams: '' });
  const [salvando, setSalvando] = useState(false);

  const numero = valor => (valor === '' ? null : Number(valor));

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.addClass(divisionId, {
        name: form.name,
        code: form.code,
        minAge: numero(form.minAge),
        maxAge: numero(form.maxAge),
        // O peso é digitado em quilos e gravado em gramas: inteiro não acumula
        // erro de arredondamento na conferência da pesagem.
        minWeightGrams: form.minWeightGrams === '' ? null : Math.round(Number(form.minWeightGrams) * 1000),
        maxWeightGrams: form.maxWeightGrams === '' ? null : Math.round(Number(form.maxWeightGrams) * 1000)
      });
      notificar(t('evento.classeCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.novaClasse')} description={t('evento.novaClasseDescricao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <div className="field-row">
          <Field label={t('evento.nome')} required><input value={form.name} onChange={evento => setForm({ ...form, name: evento.target.value })} required maxLength={90} /></Field>
          <Field label={t('evento.codigo')} required><input value={form.code} onChange={evento => setForm({ ...form, code: evento.target.value.toUpperCase() })} required pattern="[A-Z0-9_\-]{1,40}" /></Field>
        </div>
        <div className="field-row">
          <Field label={t('evento.idadeMinima')}><input type="number" min="0" max="120" value={form.minAge} onChange={evento => setForm({ ...form, minAge: evento.target.value })} /></Field>
          <Field label={t('evento.idadeMaxima')}><input type="number" min="0" max="120" value={form.maxAge} onChange={evento => setForm({ ...form, maxAge: evento.target.value })} /></Field>
        </div>
        <div className="field-row">
          <Field label={t('evento.pesoMinimo')}><input type="number" step="0.1" min="0" value={form.minWeightGrams} onChange={evento => setForm({ ...form, minWeightGrams: evento.target.value })} /></Field>
          <Field label={t('evento.pesoMaximo')}><input type="number" step="0.1" min="0" value={form.maxWeightGrams} onChange={evento => setForm({ ...form, maxWeightGrams: evento.target.value })} /></Field>
        </div>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.criarClasse')} />
      </form>
    </Modal>
  );
}

// ============================================================== INSCRIÇÕES
export function AdminInscricoes({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');
  const [inscrevendo, setInscrevendo] = useState(false);
  const [cancelando, setCancelando] = useState(null);
  const recem = useRecemAfetado();

  const estado = useListaPaginada(
    cursor => api.registrations.listByEvent(eventId, { limit: POR_PAGINA, search: busca || undefined, cursor: cursor || undefined }),
    [eventId, busca],
    { ativo: Boolean(eventId) }
  );

  return (
    <div className="page">
      <PageHead
        eyebrow={t('evento.operacao')}
        title={t('evento.inscricoes')}
        description="Reconhecimento por CPF, confirmação de filiação e escolha de categoria, divisão e classe. Não existe pagamento neste fluxo."
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setInscrevendo(true)}><Plus size={15} />{t('evento.novaInscricao')}</button>}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('evento.buscarAtleta')} aria-label={t('evento.buscarInscrito')} />
        </label>
      </div>

      {!eventId
        ? <EmptyState title={t('evento.selecioneUmEvento')} description={t('evento.inscricoesPorEvento')} />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (dados.items.length
              ? (
                <>
                  {/* Filtro ativo declarado: sem isto, uma busca esquecida faz
                      a lista parecer curta e o operador procura o problema no
                      lugar errado. */}
                  {busca && (
                    <div className="filtro-ativo">
                      <span className="chip">
                        Filtrando por “{busca}”
                        <button type="button" onClick={() => setBusca('')} aria-label={t('evento.limparFiltro')}>×</button>
                      </span>
                      <small>{dados.items.length} resultado(s)</small>
                    </div>
                  )}

                  {/* `nextCursor` é o único sinal HONESTO de que há mais:
                      esta resposta não traz total. Mas agora o aviso não é um
                      beco: há para onde ir no fim da lista. */}
                  {dados.nextCursor && (
                    <div className="alert alert-info" style={{ marginBottom: 16 }}>
                      <div>
                        <strong>Mostrando as primeiras {dados.items.length} inscrições</strong>
                        <p>{t('evento.maisRegistros')}</p>
                      </div>
                    </div>
                  )}

                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>{t('evento.atleta')}</th><th>{t('evento.filiacao')}</th><th>{t('evento.classes')}</th><th>{t('evento.situacao')}</th><th>{t('evento.checkIn')}</th><th /></tr></thead>
                    <tbody>
                      {dados.items.map((inscricao, indice) => (
                        <tr key={inscricao.id} className={`revela ${recem.classeDeLinhaDeTabela(inscricao.id)}`.trim()} style={estiloDaSequencia(indice)}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <Avatar name={inscricao.athlete.fullName} size="avatar-sm" />
                              <div>
                                <strong style={{ display: 'block' }}>{inscricao.athlete.fullName}</strong>
                                <small style={{ color: 'var(--cinza-fraco)' }}>{inscricao.athlete.cpf || inscricao.athlete.cpfMasked || '—'}</small>
                              </div>
                            </div>
                          </td>
                          <td>{inscricao.affiliation?.code || inscricao.athlete.affiliation?.code || '—'}</td>
                          <td>
                            <div className="chips">
                              {inscricao.items.map(item => <span className="chip" key={item.id}>{item.competitionClass.division.category.name} · {item.competitionClass.name}</span>)}
                            </div>
                          </td>
                          <td>
                            <Badge tom={estadoDaInscricao(inscricao.status).tom}>{estadoDaInscricao(inscricao.status).rotulo}</Badge>
                          </td>
                          <td>{inscricao.checkIn?.status === 'CHECKED_IN' ? <Badge tom="ok">{t('evento.feito')}</Badge> : <Badge tom="neutro">{t('evento.pendente')}</Badge>}</td>
                          <td style={{ textAlign: 'right' }}>
                            {inscricao.status !== 'CANCELLED' && (
                              <button type="button" className="button button-danger button-sm" onClick={() => setCancelando(inscricao)}>{t('evento.cancelar')}</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Paginacao nextCursor={dados.nextCursor} onMore={estado.carregarMais} loading={estado.carregandoMais} />
                </>
              )
              : busca
                ? <EmptyState title={t('evento.nadaEncontrado')} description={`Nenhuma inscrição corresponde a “${busca}”. Verifique o nome ou limpe o filtro.`} />
                : <EmptyState title={t('evento.nenhumaInscricao')} description={t('evento.nenhumaInscricaoDescricao')} />
            )}
          </AsyncSection>
        )}

      {inscrevendo && (
        <NovaInscricao eventId={eventId} notificar={notificar} onClose={() => setInscrevendo(false)}
          onSalvo={inscricaoId => { recem.marcar(inscricaoId); setInscrevendo(false); estado.reload(); }} />
      )}
      {cancelando && (
        <CancelarInscricao inscricao={cancelando} notificar={notificar} onClose={() => setCancelando(null)}
          onSalvo={() => { recem.marcar(cancelando.id); setCancelando(null); estado.reload(); }} />
      )}
    </div>
  );
}

function NovaInscricao({ eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const evento = useFetch(() => api.events.findOne(eventId), [eventId]);
  const filiacoes = useFetch(
    () => (evento.data?.organizationId ? api.affiliations.list({ organizationId: evento.data.organizationId }) : Promise.resolve({ items: [] })),
    [evento.data?.organizationId],
    { ativo: Boolean(evento.data?.organizationId) }
  );

  const [cpf, setCpf] = useState('');
  const [reconhecido, setReconhecido] = useState(null);
  const [consultando, setConsultando] = useState(false);
  const [novoAtleta, setNovoAtleta] = useState({ fullName: '', stageName: '', sex: 'FEMALE', birthDate: '', state: '', city: '', phone: '', email: '' });
  const [affiliationId, setAffiliationId] = useState('');
  const [classIds, setClassIds] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const [erros, setErros] = useState([]);

  const classes = (evento.data?.eventCategories || []).flatMap(eventCategory =>
    eventCategory.divisions.flatMap(divisao =>
      divisao.classes.map(classe => ({
        id: classe.id,
        rotulo: `${eventCategory.category.name} · ${divisao.name} · ${classe.name}`,
        sexo: eventCategory.category.sex
      }))
    )
  );

  // Passo 1 do fluxo: o CPF decide se o atleta é reconhecido ou criado.
  const consultar = async () => {
    const digitos = somenteDigitos(cpf);
    if (digitos.length !== 11) return;

    setConsultando(true);
    setErros([]);
    try {
      const resposta = await api.athletes.lookup({ organizationId: evento.data.organizationId, cpf: digitos });
      setReconhecido(resposta);
      if (resposta.found) setAffiliationId(resposta.athlete.affiliation?.id || '');
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setConsultando(false);
    }
  };

  const salvar = async submit => {
    submit.preventDefault();
    setSalvando(true);
    setErros([]);
    try {
      const resposta = await api.registrations.create(eventId, {
        cpf: somenteDigitos(cpf),
        athlete: reconhecido?.found ? undefined : { ...novoAtleta, birthDate: novoAtleta.birthDate || null, stageName: novoAtleta.stageName || null, phone: novoAtleta.phone || null, email: novoAtleta.email || null, state: novoAtleta.state || null, city: novoAtleta.city || null },
        affiliationId: affiliationId || null,
        classIds
      });
      notificar(resposta.athleteRecognized ? t('evento.atletaReconhecido') : t('evento.perfilCriado'));
      // Inscrever é nível EVENTO: confirma na linha, sem tomar o centro da
      // tela — numa abertura de inscrições isto se repete o dia inteiro.
      anunciar(MCIEvento.SUCESSO, {
        titulo: t('evento.inscricaoRealizada'),
        descricao: resposta.athleteRecognized ? t('evento.reconhecidoPeloCpf') : t('evento.perfilCriado')
      });
      refreshData();
      onSalvo(resposta.id);
    } catch (erro) {
      setErros(erro.details?.map(item => item.message) || [erro.message]);
      setSalvando(false);
    }
  };

  const sexoDoAtleta = reconhecido?.found ? reconhecido.athlete.sex : novoAtleta.sex;

  return (
    <Modal title={t('evento.novaInscricao')} description={t('evento.novaInscricaoDescricao')} wide onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.cpfDoAtleta')} required hint={t('evento.cpfHint')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={cpf} onChange={evt => { setCpf(mascararCpf(evt.target.value)); setReconhecido(null); }} required inputMode="numeric" placeholder="000.000.000-00" />
            <button type="button" className="button button-secondary" onClick={consultar} disabled={consultando || somenteDigitos(cpf).length !== 11}>
              {consultando ? t('evento.consultando') : t('evento.consultar')}
            </button>
          </div>
        </Field>

        {reconhecido?.found && (
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            <div>
              <strong>{t('evento.atletaReconhecidoTitulo')}</strong>
              <p>{reconhecido.athlete.fullName} · {reconhecido.athlete.city || '—'}{reconhecido.athlete.state ? `/${reconhecido.athlete.state}` : ''} · {reconhecido.athlete.sex === 'MALE' ? 'Masculino' : 'Feminino'}</p>
            </div>
          </div>
        )}

        {reconhecido && !reconhecido.found && (
          <>
            <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
              <div><strong>{t('evento.cpfNaoCadastrado')}</strong><p>{t('evento.informeOsDados')}</p></div>
            </div>
            <div className="field-row">
              <Field label={t('evento.nomeCompleto')} required><input value={novoAtleta.fullName} onChange={evt => setNovoAtleta({ ...novoAtleta, fullName: evt.target.value })} required minLength={2} maxLength={160} /></Field>
              <Field label={t('evento.nomeEsportivo')}><input value={novoAtleta.stageName} onChange={evt => setNovoAtleta({ ...novoAtleta, stageName: evt.target.value })} maxLength={80} /></Field>
            </div>
            <div className="field-row">
              <Field label={t('evento.sexo')} required>
                <select value={novoAtleta.sex} onChange={evt => setNovoAtleta({ ...novoAtleta, sex: evt.target.value })} required>
                  <option value="FEMALE">{t('evento.feminino')}</option>
                  <option value="MALE">{t('evento.masculino')}</option>
                </select>
              </Field>
              <Field label={t('evento.nascimento')} hint={t('evento.nascimentoHint')}><input type="date" value={novoAtleta.birthDate} onChange={evt => setNovoAtleta({ ...novoAtleta, birthDate: evt.target.value })} /></Field>
            </div>
            <div className="field-row">
              <Field label={t('evento.cidade')}><input value={novoAtleta.city} onChange={evt => setNovoAtleta({ ...novoAtleta, city: evt.target.value })} maxLength={90} /></Field>
              <Field label="UF"><input value={novoAtleta.state} onChange={evt => setNovoAtleta({ ...novoAtleta, state: evt.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
            </div>
          </>
        )}

        {reconhecido && (
          <>
            <Field label={t('evento.filiacao')} hint={t('evento.filiacaoHint')}>
              <select value={affiliationId} onChange={evt => setAffiliationId(evt.target.value)}>
                <option value="">{t('evento.semFiliacao')}</option>
                {(filiacoes.data?.items || []).map(filiacao => <option key={filiacao.id} value={filiacao.id}>{filiacao.name} ({filiacao.code})</option>)}
              </select>
            </Field>

            <Field label={t('evento.categoriasDivisoesClasses')} required>
              <div style={{ display: 'grid', gap: 6, maxHeight: 210, overflowY: 'auto', border: '1px solid var(--linha)', borderRadius: 4, padding: 10 }}>
                {classes.length
                  ? classes.map(classe => {
                    const incompativel = sexoDoAtleta && classe.sexo !== sexoDoAtleta;
                    return (
                      <label key={classe.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, opacity: incompativel ? .45 : 1 }}>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          disabled={incompativel}
                          checked={classIds.includes(classe.id)}
                          onChange={evt => setClassIds(atual => (evt.target.checked ? [...atual, classe.id] : atual.filter(item => item !== classe.id)))}
                        />
                        {classe.rotulo}
                        {incompativel && <span style={{ color: 'var(--cinza-fraco)' }}>(categoria de outro sexo)</span>}
                      </label>
                    );
                  })
                  : <span style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('evento.semClassesCadastradas')}</span>}
              </div>
            </Field>
          </>
        )}

        {erros.length > 0 && (
          <div className="alert alert-erro" style={{ marginBottom: 12 }}>
            <div>
              <strong>{t('evento.inscricaoRecusada')}</strong>
              <ul>{erros.map((mensagem, indice) => <li key={indice}>{mensagem}</li>)}</ul>
            </div>
          </div>
        )}

        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.registrarInscricao')} disabled={!reconhecido || !classIds.length} />
      </form>
    </Modal>
  );
}

function CancelarInscricao({ inscricao, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.registrations.cancel(inscricao.id, { reason });
      notificar(t('evento.inscricaoCancelada'));
      // Cancelar NÃO é conquista. O operador acabou de tirar um atleta da
      // competição — o gesto certo aqui é confirmar e sair do caminho.
      anunciar(MCIEvento.AVISO, { titulo: t('evento.inscricaoCanceladaTitulo'), descricao: inscricao.athlete.fullName });
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.cancelarInscricao')} description={inscricao.athlete.fullName} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.motivo')} required hint={t('evento.motivoHint')}>
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} required minLength={3} maxLength={300} />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.cancelarInscricao')} />
      </form>
    </Modal>
  );
}

// ============================================================ CHECK-IN
export function AdminCheckin({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');
  const recem = useRecemAfetado();

  // Recarga periódica só com evento escolhido — o mesmo padrão já usado em
  // "minha solicitação". É isto que torna o contador REALMENTE ao vivo e, por
  // consequência, torna honesto o indicador de ao vivo ao lado dele. Sem dado
  // que muda sozinho, um pulso de "ao vivo" seria mentira com animação.
  const estado = useListaPaginada(
    cursor => api.operations.listCheckIns(eventId, { limit: POR_PAGINA, search: busca || undefined, cursor: cursor || undefined }),
    [eventId, busca],
    { ativo: Boolean(eventId), recarregarACada: eventId ? 20000 : 0 }
  );

  // Uma inscrição por vez. O backend recusa o segundo check-in com 409
  // ALREADY_CHECKED_IN, então o duplo clique na portaria mostrava um erro
  // vermelho logo depois do sucesso — o operador via "falhou" numa operação
  // que tinha dado certo. A trava fecha a janela entre o envio e a resposta.
  const [emOperacao, setEmOperacao] = useState(null);

  const operar = async (inscricao, cancelar) => {
    if (emOperacao) return;
    setEmOperacao(inscricao.id);
    try {
      if (cancelar) await api.operations.cancelCheckIn(inscricao.id);
      else await api.operations.checkIn(inscricao.id, { device: navigator.userAgent.slice(0, 100) });
      notificar(cancelar ? t('evento.checkInCancelado') : t('evento.checkInConfirmado'));
      recem.marcar(inscricao.id);
      // Desfazer é correção, não conquista: confirma sem celebrar.
      if (!cancelar) {
        anunciar(MCIEvento.CHECKIN, {
          titulo: t('evento.checkInConfirmadoTitulo'),
          descricao: inscricao.athlete.stageName || inscricao.athlete.fullName
        });
      }
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEmOperacao(null);
    }
  };

  return (
    <div className="page">
      <PageHead eyebrow={t('evento.operacao')} title={t('evento.checkIn')} description={t('evento.checkInDescricao')} />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} filtroStatus={['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('evento.nomeOuNumero')} aria-label={t('publico.buscarAtletaRotulo')} />
        </label>
      </div>

      {!eventId
        ? <EmptyState title={t('evento.selecioneEventoEmOperacao')} description={t('evento.janelaOperacional')} />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (
              <>
                {dados.summary && (
                  <>
                    <div className="toolbar-ao-vivo">
                      <PulsoAoVivo rotulo={t('evento.atualizandoAoVivo')} />
                    </div>
                    <div className="grid grid-3" style={{ marginBottom: 16 }}>
                      <Metric label={t('evento.inscritos')} value={dados.summary.total} />
                      <ContadorVivo label={t('evento.checkInFeito')} value={dados.summary.checkedIn} destaque />
                      <ContadorVivo label={t('evento.pendentes')} value={dados.summary.pending} />
                    </div>

                    {/* Agora a lista não para: diz onde está e continua. O
                        aviso vira posição ("100 de 280"), e quem falta está a
                        um clique, não atrás de uma busca obrigatória. */}
                    {dados.items.length < dados.summary.total && (
                      <div className="alert alert-info" style={{ marginBottom: 16 }}>
                        <div>
                          <strong>Mostrando {dados.items.length} de {dados.summary.total} inscritos</strong>
                          <p>{t('evento.maisRegistrosCheckIn')}</p>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <section className="panel">
                  {dados.items.length
                    ? dados.items.map((inscricao, indice) => {
                      const feito = inscricao.checkIn?.status === 'CHECKED_IN';
                      const ocupada = emOperacao === inscricao.id;
                      return (
                        <Revelacao as="div" indice={indice} key={inscricao.id} className={`list-row${recem.classeDe(inscricao.id)}`}>
                          <Avatar name={inscricao.athlete.fullName} />
                          <span className="info">
                            <strong>{inscricao.athlete.stageName || inscricao.athlete.fullName}</strong>
                            <small>
                              {inscricao.athlete.athleteNumber ? `Nº ${inscricao.athlete.athleteNumber} · ` : ''}
                              {inscricao.items.map(item => item.competitionClass.name).join(', ') || t('evento.semClasse')}
                              {inscricao.weighIns[0] ? ` · ${pesoEmKg(inscricao.weighIns[0].weightGrams)}` : ''}
                            </small>
                          </span>
                          {feito
                            ? (
                              <>
                                <Badge tom="ok"><ClipboardCheck size={12} /> {formatarDataHora(inscricao.checkIn.checkedInAt)}</Badge>
                                <button type="button" className="button button-secondary button-sm" disabled={ocupada} onClick={() => operar(inscricao, true)}>
                                  {ocupada ? t('evento.desfazendo') : t('evento.desfazer')}
                                </button>
                              </>
                            )
                            : (
                              <button type="button" className="button button-primary button-sm" disabled={ocupada} onClick={() => operar(inscricao, false)}>
                                {ocupada ? t('evento.confirmando') : t('evento.fazerCheckIn')}
                              </button>
                            )}
                        </Revelacao>
                      );
                    })
                    : <EmptyState title={t('evento.nenhumConfirmado')} />}
                </section>
                <Paginacao nextCursor={estado.nextCursor} onMore={estado.carregarMais} loading={estado.carregandoMais} />
              </>
            )}
          </AsyncSection>
        )}
    </div>
  );
}

// ============================================================== PESAGEM
export function AdminPesagem({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');
  const [pesando, setPesando] = useState(null);
  const recem = useRecemAfetado();

  const estado = useListaPaginada(
    cursor => api.operations.listCheckIns(eventId, { limit: POR_PAGINA, search: busca || undefined, cursor: cursor || undefined }),
    [eventId, busca],
    { ativo: Boolean(eventId) }
  );

  return (
    <div className="page">
      <PageHead eyebrow={t('evento.operacao')} title={t('evento.pesagem')} description={t('evento.pesagemDescricao')} />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} filtroStatus={['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('evento.nomeOuNumero')} aria-label={t('publico.buscarAtletaRotulo')} />
        </label>
      </div>

      {!eventId
        ? <EmptyState title={t('evento.selecioneEventoEmOperacao')} />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (
              <section className="panel">
                {dados.items.length
                  ? dados.items.map((inscricao, indice) => (
                    <Revelacao as="div" indice={indice} key={inscricao.id} className={`list-row${recem.classeDe(inscricao.id)}`}>
                      <Avatar name={inscricao.athlete.fullName} />
                      <span className="info">
                        <strong>{inscricao.athlete.stageName || inscricao.athlete.fullName}</strong>
                        <small>
                          {inscricao.weighIns[0]
                            ? `Última pesagem: ${pesoEmKg(inscricao.weighIns[0].weightGrams)} em ${formatarDataHora(inscricao.weighIns[0].measuredAt)}`
                            : t('evento.semPesagem')}
                        </small>
                      </span>
                      <button type="button" className="button button-primary button-sm" onClick={() => setPesando(inscricao)}>
                        <Scale size={13} />{t('evento.registrar')}</button>
                    </Revelacao>
                  ))
                  : <EmptyState title={t('evento.nenhumConfirmado')} />}
                <Paginacao nextCursor={estado.nextCursor} onMore={estado.carregarMais} loading={estado.carregandoMais} />
              </section>
            )}
          </AsyncSection>
        )}

      {pesando && (
        <RegistrarPesagem inscricao={pesando} notificar={notificar} onClose={() => setPesando(null)}
          onSalvo={() => { recem.marcar(pesando.id); setPesando(null); estado.reload(); }} />
      )}
    </div>
  );
}

function RegistrarPesagem({ inscricao, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ peso: '', altura: '', notes: '' });
  const [salvando, setSalvando] = useState(false);
  const [foraDeFaixa, setForaDeFaixa] = useState(null);
  const [falha, setFalha] = useState(null);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const resposta = await api.operations.weighIn(inscricao.id, {
        weightGrams: Math.round(Number(form.peso) * 1000),
        heightCm: form.altura ? Number(form.altura) : null,
        notes: form.notes || null,
        device: navigator.userAgent.slice(0, 100)
      });

      // A conferência de faixa é informativa: quem reclassifica é a
      // organização, com base no regulamento.
      if (resposta.outOfRange?.length) {
        setForaDeFaixa(resposta.outOfRange);
        notificar(t('evento.pesagemForaDaFaixa'), 'info');
        // O peso ENTROU, mas há classe fora da faixa e a reclassificação é
        // decisão da organização. Confirmar com ar de "deu tudo certo" aqui
        // faria o operador passar batido pelo caso que precisa de decisão.
        anunciar(MCIEvento.AVISO, {
          titulo: t('evento.pesoForaDaFaixa'),
          descricao: t('evento.reclassificacaoEDaOrganizacao')
        });
      } else {
        notificar(t('evento.pesagemRegistrada'));
        anunciar(MCIEvento.PESAGEM, { titulo: t('evento.pesagemRegistradaTitulo'), descricao: inscricao.athlete.fullName });
        onSalvo();
      }
    } catch (erro) {
      // Erro de pesagem NÃO vai para o palco da experiência, e isto é
      // decisão, não esquecimento: a pessoa está com o diálogo aberto, lendo
      // o motivo e corrigindo o campo. Uma caixa centralizada piscando por
      // cima do formulário que ela precisa ler é exatamente a "animação
      // dramática" que atrapalha. O motivo fica À VISTA no diálogo, ao lado
      // do campo, e o toast continua.
      //
      // A recusa de credencial é o caso oposto — lá o operador está em pé na
      // portaria, olhando o leitor e não a tela —, e por isso lá o anúncio
      // existe.
      setFalha(erro.message);
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.registrarPesagem')} description={inscricao.athlete.fullName} onClose={onClose}>
      {foraDeFaixa
        ? (
          <>
            <div className="alert alert-alerta">
              <div>
                <strong>{t('evento.pesoForaDaFaixa')}</strong>
                <p>{t('evento.pesoForaDaFaixaTexto')}</p>
                <ul>{foraDeFaixa.map(item => <li key={item.classId}>{item.className}</li>)}</ul>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="button button-primary" onClick={onSalvo}>{t('evento.entendi')}</button>
            </div>
          </>
        )
        : (
          <form onSubmit={salvar}>
            {/* O motivo fica À VISTA no diálogo, e não só num toast que some:
                quem errou o peso precisa do motivo enquanto corrige o campo. */}
            {falha && (
              <div className="alert alert-erro" style={{ marginBottom: 14 }}>
                <div>
                  <strong>{t('evento.pesagemNaoRegistrada')}</strong>
                  <p>{falha}</p>
                  <p>{t('evento.confiraOValor')}</p>
                </div>
              </div>
            )}
            <div className="field-row">
              <Field label={t('evento.pesoKg')} required>
                <input type="number" step="0.01" min="20" max="400" value={form.peso} onChange={evento => setForm({ ...form, peso: evento.target.value })} required autoFocus />
              </Field>
              <Field label={t('evento.alturaCm')}>
                <input type="number" min="100" max="260" value={form.altura} onChange={evento => setForm({ ...form, altura: evento.target.value })} />
              </Field>
            </div>
            <Field label={t('evento.observacao')}><textarea value={form.notes} onChange={evento => setForm({ ...form, notes: evento.target.value })} maxLength={300} /></Field>
            <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.registrar')} />
          </form>
        )}
    </Modal>
  );
}

// ======================================================== CREDENCIAMENTO
export function AdminCredenciamento({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [emitindo, setEmitindo] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [leitura, setLeitura] = useState(null);
  const [lendo, setLendo] = useState(false);
  const recem = useRecemAfetado();

  const estado = useListaPaginada(
    cursor => api.operations.credentials(eventId, { limit: POR_PAGINA, cursor: cursor || undefined }),
    [eventId],
    { ativo: Boolean(eventId) }
  );

  // Cada leitura grava uma linha de auditoria. O código só é limpo DEPOIS da
  // resposta, então o operador apressado que aperta Enter duas vezes na
  // portaria registrava duas leituras da mesma credencial. A trava fecha a
  // janela entre o envio e a resposta.
  const ler = async evento => {
    evento.preventDefault();
    if (!codigo.trim() || lendo) return;
    setLendo(true);
    try {
      const resposta = await api.operations.scanCredential(eventId, { code: codigo.trim(), // 'Portaria' AQUI É DADO, e não rótulo: vai gravado no registro de
        // leitura da credencial, e é por ele que se sabe depois por qual
        // portão a pessoa entrou. Traduzir criaria três valores diferentes
        // para o mesmo portão, conforme o idioma de quem estava no posto.
        gate: 'Portaria' });
      setLeitura(resposta);
      setCodigo('');
      recem.marcar(resposta.credential?.id ?? null);
      // Recusa NÃO comemora. Uma credencial revogada chegando na portaria é
      // justamente o momento em que o operador precisa parar e olhar — dar a
      // ela o mesmo gesto verde de um acesso liberado treinaria o contrário.
      anunciar(
        resposta.accepted ? MCIEvento.CREDENCIADO : MCIEvento.ERRO,
        resposta.accepted
          ? { titulo: t('evento.acessoLiberado'), descricao: `${resposta.credential.holderName} · ${tipoDeCredencial(resposta.credential.type).rotulo}` }
          : { titulo: t('evento.acessoRecusado'), descricao: resposta.reason || resposta.credential?.holderName || t('evento.credencialNaoAceita') }
      );
      estado.reload();
    } catch (erro) {
      setLeitura(null);
      notificar(erro.message, 'erro');
    } finally {
      setLendo(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('evento.operacao')}
        title={t('evento.credenciamento')}
        description={t('evento.credenciamentoDescricao')}
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setEmitindo(true)}><Plus size={15} />{t('evento.emitirCredencial')}</button>}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? <EmptyState title={t('evento.selecioneUmEvento')} />
        : (
          <div className="grid grid-main">
            <section className="panel">
              <div className="panel-head"><h2>{t('evento.credenciaisEmitidas')}</h2></div>
              <AsyncSection state={estado} linhas={4}>
                {dados => (dados.items.length
                  ? dados.items.map((credencial, indice) => (
                    <Revelacao as="div" indice={indice} key={credencial.id} className={`list-row${recem.classeDe(credencial.id)}`}>
                      {/* O QR desenha o código que a credencial já carrega — o
                          mesmo que a portaria lê. Só faz sentido para credencial
                          ativa: revogada não deve ser apresentável no portão. */}
                      {credencial.status === 'ACTIVE'
                        ? <CodigoQr valor={credencial.code} tamanho={64} />
                        : <span className="avatar"><QrCode size={16} /></span>}
                      <span className="info">
                        <strong>{credencial.holderName}</strong>
                        <small>{tipoDeCredencial(credencial.type).rotulo} · {credencial.code} · {credencial._count.scans} leitura(s)</small>
                      </span>
                      <Badge tom={credencial.status === 'ACTIVE' ? 'ok' : 'perigo'}>{credencial.status === 'ACTIVE' ? t('evento.ativa') : t('evento.revogada')}</Badge>
                      {credencial.status === 'ACTIVE' && (
                        <button
                          type="button"
                          className="button button-danger button-sm"
                          onClick={async () => {
                            try {
                              await api.operations.revokeCredential(credencial.id);
                              notificar(t('evento.credencialRevogada'));
                              estado.reload();
                            } catch (erro) { notificar(erro.message, 'erro'); }
                          }}
                        >{t('evento.revogar')}</button>
                      )}
                    </Revelacao>
                  ))
                  : <EmptyState title={t('evento.nenhumaCredencial')} />
                )}
              </AsyncSection>
              <Paginacao nextCursor={estado.nextCursor} onMore={estado.carregarMais} loading={estado.carregandoMais} />
            </section>

            <section className="panel">
              <div className="panel-head"><h2>{t('evento.leitura')}</h2></div>
              <form onSubmit={ler}>
                <Field label={t('evento.codigoDaCredencial')} hint={t('evento.conteudoDoQr')}>
                  <input value={codigo} onChange={evento => setCodigo(evento.target.value.toUpperCase())} placeholder="MCI-XXXXXXXXXXXX" />
                </Field>
                <button type="submit" className="button button-primary" style={{ width: '100%' }} disabled={lendo || !codigo.trim()}>
                  {lendo ? t('evento.validando') : t('evento.validar')}
                </button>
              </form>

              {leitura && (
                /* Aceito era pintado de "info" — a mesma cor de um aviso
                   qualquer. Na portaria, liberado e recusado precisam ser
                   distinguíveis de relance, sem ler. */
                <div className={`alert ${leitura.accepted ? 'alert-ok' : 'alert-erro'} varredura`} style={{ marginTop: 14 }}>
                  <div>
                    <strong>{leitura.accepted ? t('evento.acessoLiberado') : t('evento.acessoRecusado')}</strong>
                    <p>{leitura.credential.holderName} · {tipoDeCredencial(leitura.credential.type).rotulo}</p>
                    {leitura.reason && <p>{leitura.reason}</p>}
                    {leitura.credential.athlete && (
                      <p>{leitura.credential.checkedIn ? t('evento.checkInConfirmado') : t('evento.semCheckIn')}</p>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

      {emitindo && (
        <EmitirCredencial eventId={eventId} notificar={notificar} onClose={() => setEmitindo(false)} onSalvo={() => { setEmitindo(false); estado.reload(); }} />
      )}
    </div>
  );
}

function EmitirCredencial({ eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  // Dentro de um <select> não cabe "carregar mais". O botão fica logo abaixo
  // do campo: sem ele, o atleta nº 101 simplesmente não existia para quem
  // emite credencial, e a tela não dava sinal nenhum disso.
  const inscritos = useListaPaginada(
    cursor => api.registrations.listByEvent(eventId, { limit: POR_PAGINA, status: 'CONFIRMED', cursor: cursor || undefined }),
    [eventId]
  );
  const [form, setForm] = useState({ type: 'ATHLETE', holderName: '', registrationId: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const credencial = await api.operations.issueCredential(eventId, {
        type: form.type,
        holderName: form.holderName,
        registrationId: form.registrationId || null
      });
      notificar(`Credencial ${credencial.code} emitida.`);
      anunciar(MCIEvento.SUCESSO, { titulo: t('evento.credencialEmitida'), descricao: form.holderName });
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.emitirCredencial')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.tipo')} required>
          <select value={form.type} onChange={evento => setForm({ ...form, type: evento.target.value })} required>
            {['ATHLETE', 'COACH', 'STAFF', 'JUDGE', 'MEDIA', 'PHOTOGRAPHER', 'SPONSOR', 'GUEST'].map(tipo => <option key={tipo} value={tipo}>{tipoDeCredencial(tipo).rotulo}</option>)}
          </select>
        </Field>
        <Field label={t('evento.nomeDoPortador')} required>
          <input value={form.holderName} onChange={evento => setForm({ ...form, holderName: evento.target.value })} required minLength={2} maxLength={140} />
        </Field>
        {form.type === 'ATHLETE' && (
          <Field label={t('evento.inscricaoVinculada')} hint={t('evento.inscricaoVinculadaHint')}>
            <select
              value={form.registrationId}
              onChange={evento => {
                const inscricao = inscritos.items.find(item => item.id === evento.target.value);
                setForm({ ...form, registrationId: evento.target.value, holderName: inscricao?.athlete.fullName || form.holderName });
              }}
            >
              <option value="">{t('evento.semVinculo')}</option>
              {inscritos.items.map(inscricao => <option key={inscricao.id} value={inscricao.id}>{inscricao.athlete.fullName}</option>)}
            </select>
          </Field>
        )}
        {form.type === 'ATHLETE' && (
          <Paginacao nextCursor={inscritos.nextCursor} onMore={inscritos.carregarMais} loading={inscritos.carregandoMais} />
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.emitir')} />
      </form>
    </Modal>
  );
}

// ================================================================ PALCO
export function AdminPalco({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [criando, setCriando] = useState(false);
  const [ordenando, setOrdenando] = useState(null);
  const recem = useRecemAfetado();
  // Uma bateria por vez: dois cliques em "Chamar" mandariam duas transições
  // de estado para a mesma bateria.
  const [mudando, setMudando] = useState(null);

  const estado = useFetch(
    () => (eventId ? api.operations.batches(eventId) : Promise.resolve({ items: [] })),
    [eventId],
    { ativo: Boolean(eventId) }
  );

  const mudarStatus = async (bateria, status) => {
    if (mudando) return;
    setMudando(bateria.id);
    try {
      await api.operations.setBatchStatus(bateria.id, { status });
      notificar(status === 'CALLED' ? t('evento.bateriaChamada') : t('evento.bateriaAtualizada'));
      recem.marcar(bateria.id);

      // Só DUAS transições ganham gesto, porque só duas mudam o mundo do
      // atleta: ser chamado (saia de onde estiver e venha) e entrar no palco.
      // "Encerrar" é fim de expediente da bateria — confirma e segue.
      if (status === 'CALLED') {
        anunciar(MCIEvento.NOVIDADE, {
          titulo: t('evento.bateriaChamadaTitulo'),
          descricao: `${bateria.name} · ${bateria._count.orders} atleta(s) notificado(s)`
        });
      } else if (status === 'ON_STAGE') {
        anunciar(MCIEvento.AO_VIVO, { titulo: t('evento.noPalco'), descricao: bateria.name });
      }
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setMudando(null);
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('evento.operacao')}
        title={t('evento.ordemDePalco')}
        description={t('evento.ordemDePalcoDescricao')}
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} />{t('evento.novaBateria')}</button>}
      />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title={t('evento.selecioneUmEvento')} />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (dados.items.length
              ? dados.items.map((bateria, indice) => (
                <Revelacao
                  as="section"
                  indice={indice}
                  key={bateria.id}
                  className={`panel painel-bateria${bateria.status === 'ON_STAGE' ? ' esta-no-palco' : ''}${recem.classeDe(bateria.id)}`}
                >
                  <div className="panel-head">
                    <div>
                      <h2>{bateria.name}</h2>
                      <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                        {bateria.competitionClass.division.eventCategory.category.name} · {bateria.competitionClass.division.name} · {bateria.competitionClass.name}
                        {bateria.scheduledAt ? ` · ${formatarDataHora(bateria.scheduledAt)}` : ''}
                        {` · ${bateria._count.orders} atleta(s)`}
                      </small>
                    </div>
                    <div className="actions">
                      {/* ON_STAGE é estado REAL da operação — esta bateria
                          está no palco agora. Por isso o pulso aqui é honesto:
                          não é enfeite fingindo tempo real. */}
                      {bateria.status === 'ON_STAGE'
                        ? <PulsoAoVivo rotulo={t('evento.noPalco')} />
                        : <Badge tom={estadoDaBateria(bateria.status).tom}>{estadoDaBateria(bateria.status).rotulo}</Badge>}
                      <button type="button" className="button button-secondary button-sm" onClick={() => setOrdenando(bateria)}>{t('evento.ordem')}</button>
                      {bateria.status === 'SCHEDULED' && (
                        <button type="button" className="button button-primary button-sm" disabled={mudando === bateria.id} onClick={() => mudarStatus(bateria, 'CALLED')}>
                          {mudando === bateria.id ? t('evento.chamando') : t('evento.chamar')}
                        </button>
                      )}
                      {bateria.status === 'CALLED' && (
                        <button type="button" className="button button-primary button-sm" disabled={mudando === bateria.id} onClick={() => mudarStatus(bateria, 'ON_STAGE')}>
                          {mudando === bateria.id ? t('evento.entrando') : t('evento.noPalco')}
                        </button>
                      )}
                      {bateria.status === 'ON_STAGE' && (
                        <button type="button" className="button button-secondary button-sm" disabled={mudando === bateria.id} onClick={() => mudarStatus(bateria, 'DONE')}>
                          {mudando === bateria.id ? t('evento.encerrando') : t('evento.encerrar')}
                        </button>
                      )}
                    </div>
                  </div>
                </Revelacao>
              ))
              : <EmptyState title={t('evento.nenhumaBateria')} description={t('evento.nenhumaBateriaDescricao')} />
            )}
          </AsyncSection>
        )}

      {criando && <NovaBateria eventId={eventId} notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
      {ordenando && <OrdemDePalco bateria={ordenando} notificar={notificar} onClose={() => setOrdenando(null)} onSalvo={() => { setOrdenando(null); estado.reload(); }} />}
    </div>
  );
}

function NovaBateria({ eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const evento = useFetch(() => api.events.findOne(eventId), [eventId]);
  const [form, setForm] = useState({ classId: '', name: '', scheduledAt: '' });
  const [salvando, setSalvando] = useState(false);

  const classes = (evento.data?.eventCategories || []).flatMap(eventCategory =>
    eventCategory.divisions.flatMap(divisao =>
      divisao.classes.map(classe => ({ id: classe.id, rotulo: `${eventCategory.category.name} · ${divisao.name} · ${classe.name}` }))
    )
  );

  const salvar = async evento_ => {
    evento_.preventDefault();
    setSalvando(true);
    try {
      await api.operations.createBatch(eventId, {
        classId: form.classId,
        name: form.name,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null
      });
      notificar(t('evento.bateriaCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('evento.novaBateria')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.classe')} required>
          <select value={form.classId} onChange={evt => setForm({ ...form, classId: evt.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {classes.map(classe => <option key={classe.id} value={classe.id}>{classe.rotulo}</option>)}
          </select>
        </Field>
        <Field label={t('evento.nome')} required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} placeholder={t('evento.exemploBateria')} /></Field>
        <Field label={t('evento.horario')}><input type="datetime-local" value={form.scheduledAt} onChange={evt => setForm({ ...form, scheduledAt: evt.target.value })} /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('evento.criarBateria')} />
      </form>
    </Modal>
  );
}

function OrdemDePalco({ bateria, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const ordem = useFetch(() => api.operations.stageOrder(bateria.id), [bateria.id]);
  const inscritos = useListaPaginada(
    cursor => api.registrations.listByEvent(bateria.eventId, { limit: POR_PAGINA, status: 'CONFIRMED', classId: bateria.classId, cursor: cursor || undefined }),
    [bateria.eventId, bateria.classId]
  );
  const [itens, setItens] = useState(null);
  const [salvando, setSalvando] = useState(false);

  const listaAtual = itens ?? (ordem.data?.orders || []).map(item => ({
    registrationItemId: item.registrationItemId,
    nome: item.registrationItem.registration.athlete.fullName
  }));

  const disponiveis = inscritos.items
    .flatMap(inscricao => inscricao.items
      .filter(item => item.competitionClass.id === bateria.classId)
      .map(item => ({ registrationItemId: item.id, nome: inscricao.athlete.fullName })))
    .filter(candidato => !listaAtual.some(item => item.registrationItemId === candidato.registrationItemId));

  const mover = (indice, direcao) => {
    const nova = [...listaAtual];
    const destino = indice + direcao;
    if (destino < 0 || destino >= nova.length) return;
    [nova[indice], nova[destino]] = [nova[destino], nova[indice]];
    setItens(nova);
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      await api.operations.setStageOrder(bateria.id, {
        items: listaAtual.map((item, indice) => ({ registrationItemId: item.registrationItemId, position: indice + 1 }))
      });
      notificar(t('evento.ordemSalva'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Ordem — ${bateria.name}`} description={t('evento.posicaoDeEntrada')} wide onClose={onClose}>
      <div className="grid grid-2">
        <section>
          <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', marginBottom: 10 }}>{t('evento.ordemDefinida')}</h3>
          {listaAtual.length
            ? listaAtual.map((item, indice) => (
              <div className="judge-row" key={item.registrationItemId} style={{ marginBottom: 6 }}>
                <span className="placing">{indice + 1}</span>
                <span className="info"><strong>{item.nome}</strong></span>
                <button type="button" className="button button-secondary button-sm" onClick={() => mover(indice, -1)} aria-label={t('evento.subir')}>↑</button>
                <button type="button" className="button button-secondary button-sm" onClick={() => mover(indice, 1)} aria-label={t('evento.descer')}>↓</button>
                <button type="button" className="button button-danger button-sm" onClick={() => setItens(listaAtual.filter((_, posicao) => posicao !== indice))}>×</button>
              </div>
            ))
            : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('evento.nenhumAtletaNaOrdem')}</p>}
        </section>

        <section>
          <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', marginBottom: 10 }}>{t('evento.disponiveis')}</h3>
          {disponiveis.length
            ? disponiveis.map(candidato => (
              <div className="judge-row" key={candidato.registrationItemId} style={{ marginBottom: 6 }}>
                <span className="info"><strong>{candidato.nome}</strong></span>
                <button type="button" className="button button-secondary button-sm" onClick={() => setItens([...listaAtual, candidato])}>{t('evento.adicionar')}</button>
              </div>
            ))
            : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('evento.todosNaOrdem')}</p>}
          {/* "Todos os inscritos já estão na ordem" é uma frase perigosa quando
              a lista parou na página 1: ela afirma uma coisa que o sistema não
              sabe. Enquanto houver página seguinte, há para onde ir. */}
          <Paginacao nextCursor={inscritos.nextCursor} onMore={inscritos.carregarMais} loading={inscritos.carregandoMais} />
        </section>
      </div>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('evento.fechar')}</button>
        <button type="button" className="button button-primary" onClick={salvar} disabled={salvando || !listaAtual.length}>{t('evento.salvarOrdem')}</button>
      </div>
    </Modal>
  );
}

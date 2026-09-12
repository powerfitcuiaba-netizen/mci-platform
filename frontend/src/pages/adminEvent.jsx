import { useState } from 'react';
import { CalendarDays, ClipboardCheck, Plus, QrCode, Scale, Search } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, CodigoQr, ConfirmDialog, EmptyState, Field, Metric, Modal, ModalActions, PageHead } from '../components/ui';
import {
  ESTADO_EVENTO, TRANSICOES_EVENTO, formatarData, formatarDataHora, mascararCpf, pesoEmKg, somenteDigitos
} from '../lib/format';

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
  const estado = useFetch(() => api.events.list({ limit: 50 }), []);
  const lista = (estado.data?.items || []).filter(evento => (filtroStatus ? filtroStatus.includes(evento.status) : true));
  const falhou = Boolean(estado.error);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <select
        className="select-control"
        value={eventId || ''}
        onChange={evento => onChange(evento.target.value)}
        aria-label="Selecionar evento"
        // Escolher numa lista que não carregou não significaria nada.
        disabled={falhou}
      >
        <option value="">{falhou ? 'Lista indisponível' : 'Selecione o evento…'}</option>
        {lista.map(evento => (
          <option key={evento.id} value={evento.id}>
            {evento.name} — {(ESTADO_EVENTO[evento.status] || {}).rotulo || evento.status}
          </option>
        ))}
      </select>

      {falhou && (
        <span className="alert alert-erro" role="alert" style={{ padding: '6px 10px', margin: 0, fontSize: 12 }}>
          <span style={{ flex: 1 }}>Não foi possível carregar os eventos. {estado.error}</span>
          <button type="button" className="button button-secondary button-sm" onClick={estado.reload}>
            Tentar de novo
          </button>
        </span>
      )}
    </div>
  );
}

export function AdminEventos({ notificar, navegar }) {
  const [criando, setCriando] = useState(false);
  const [status, setStatus] = useState('');
  const estado = useFetch(() => api.events.list({ limit: 50, status: status || undefined }), [status]);

  return (
    <div className="page">
      <PageHead
        eyebrow="Administração"
        title="Eventos"
        description="Etapas, quadro de categorias e estados da competição."
        actions={<button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} /> Novo evento</button>}
      />

      <div className="toolbar">
        <select className="select-control" value={status} onChange={evento => setStatus(evento.target.value)} aria-label="Filtrar por estado">
          <option value="">Todos os estados</option>
          {Object.entries(ESTADO_EVENTO).map(([chave, valor]) => <option key={chave} value={chave}>{valor.rotulo}</option>)}
        </select>
      </div>

      <AsyncSection state={estado} linhas={4}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Evento</th><th>Estado</th><th>Data</th><th>Local</th><th className="num">Inscritos</th><th /></tr>
                </thead>
                <tbody>
                  {dados.items.map(evento => {
                    const info = ESTADO_EVENTO[evento.status] || { rotulo: evento.status, tom: 'neutro' };
                    return (
                      <tr key={evento.id}>
                        <td><strong>{evento.name}</strong></td>
                        <td><Badge tom={info.tom}>{info.rotulo}</Badge></td>
                        <td>{formatarData(evento.startDate, evento.timezone)}</td>
                        <td>{evento.city || '—'}{evento.state ? `/${evento.state}` : ''}</td>
                        <td className="num">{evento._count.registrations}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button type="button" className="button button-secondary button-sm" onClick={() => navegar(`admin/eventos/${evento.id}`)}>Abrir</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title="Nenhum evento" description="Crie a primeira etapa para começar." action={<button type="button" className="button button-primary" onClick={() => setCriando(true)}>Novo evento</button>} />
        )}
      </AsyncSection>

      {criando && <NovoEvento notificar={notificar} onClose={() => setCriando(false)} onCriado={() => { setCriando(false); estado.reload(); }} />}
    </div>
  );
}

function NovoEvento({ notificar, onClose, onCriado }) {
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
      notificar('Evento criado como rascunho.');
      refreshData();
      onCriado();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Novo evento" description="O evento nasce em rascunho e só aceita inscrição depois de aberto." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Organização" required>
          <select value={form.organizationId} onChange={evento => setForm({ ...form, organizationId: evento.target.value })} required>
            <option value="">Selecione…</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required>
          <input value={form.name} onChange={evento => definirNome(evento.target.value)} required minLength={3} maxLength={160} placeholder="Ex: Etapa Cuiabá 2026" />
        </Field>
        <Field label="Identificador na URL" required hint="Minúsculas, números e hífen.">
          <input value={form.slug} onChange={evento => setForm({ ...form, slug: evento.target.value.toLowerCase(), slugEditado: true })} required pattern="[a-z0-9-]{3,80}" />
        </Field>
        <Field label="Descrição">
          <textarea value={form.description} onChange={evento => setForm({ ...form, description: evento.target.value })} maxLength={4000} />
        </Field>
        <div className="field-row">
          <Field label="Início"><input type="date" value={form.startDate} onChange={evento => setForm({ ...form, startDate: evento.target.value })} /></Field>
          <Field label="Término"><input type="date" value={form.endDate} onChange={evento => setForm({ ...form, endDate: evento.target.value })} /></Field>
        </div>
        <div className="field-row">
          <Field label="Cidade"><input value={form.city} onChange={evento => setForm({ ...form, city: evento.target.value })} maxLength={90} /></Field>
          <Field label="UF"><input value={form.state} onChange={evento => setForm({ ...form, state: evento.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
        </div>
        <Field label="Local"><input value={form.venue} onChange={evento => setForm({ ...form, venue: evento.target.value })} maxLength={160} /></Field>
        <Field label="Temporada" hint="Vincular a uma temporada é o que faz o resultado pontuar no ranking.">
          <select value={form.seasonId} onChange={evento => setForm({ ...form, seasonId: evento.target.value })}>
            <option value="">Sem temporada</option>
            {(temporadas.data?.items || []).map(temporada => <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>)}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar evento" />
      </form>
    </Modal>
  );
}

export function AdminEventoDetalhe({ eventId, notificar, navegar }) {
  const estado = useFetch(() => api.events.findOne(eventId), [eventId]);
  const operacao = useFetch(() => api.events.operations(eventId), [eventId]);
  const [modal, setModal] = useState(null);
  const [transicao, setTransicao] = useState(null);

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
          const info = ESTADO_EVENTO[evento.status] || { rotulo: evento.status, tom: 'neutro' };
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
                  <span>{evento.season ? `Temporada ${evento.season.name}` : 'Sem temporada'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
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
                    : <span style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Estado final: não há transição disponível.</span>}
                </div>
              </section>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <AsyncSection state={operacao} linhas={1}>
                  {dados => (
                    <>
                      <Metric label="Inscritos" value={dados.registrations} />
                      <Metric label="Check-in feito" value={dados.checkedIn} hint={`${dados.pendingCheckIn} pendente(s)`} />
                      <Metric label="Pesagens" value={dados.weighedIn} />
                      <Metric label="Credenciais ativas" value={dados.credentials} />
                    </>
                  )}
                </AsyncSection>
              </div>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-head">
                  <h2>Quadro de categorias</h2>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setModal({ tipo: 'categoria' })}>
                    <Plus size={13} /> Categoria
                  </button>
                </div>

                {evento.eventCategories.length
                  ? evento.eventCategories.map(eventCategory => (
                    <div key={eventCategory.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <strong style={{ fontSize: 13.5 }}>{eventCategory.category.name}</strong>
                        <Badge tom="info">{eventCategory.category.sex === 'MALE' ? 'Masculina' : 'Feminina'}</Badge>
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
                            {!divisao.classes.length && <span style={{ fontSize: 11.5, color: 'var(--cinza-fraco)' }}>Nenhuma classe.</span>}
                          </div>
                        </div>
                      ))}
                      {!eventCategory.divisions.length && <p style={{ fontSize: 12, color: 'var(--cinza-fraco)', marginTop: 8 }}>Sem divisões.</p>}
                    </div>
                  ))
                  : <EmptyState title="Sem categorias" description="Adicione as categorias oficiais que este evento vai disputar." />}
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
      {transicao && (
        <ConfirmDialog
          title="Mudar o estado do evento"
          message={`Mover o evento para "${(ESTADO_EVENTO[transicao] || {}).rotulo || transicao}"? ${transicao === 'RESULTS_PUBLISHED' ? 'Resultados publicados ficam visíveis ao público.' : ''}`}
          confirmLabel="Confirmar"
          onConfirm={() => aplicarTransicao(transicao)}
          onClose={() => setTransicao(null)}
        />
      )}
    </div>
  );
}

function AdicionarCategoria({ eventId, notificar, onClose, onSalvo }) {
  const catalogo = useFetch(() => api.categories.list(), []);
  const [categoryId, setCategoryId] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.addCategory(eventId, { categoryId });
      notificar('Categoria adicionada ao evento.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Adicionar categoria" description="Catálogo oficial do Campeonato Brasileiro Muscle Contest." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Categoria" required>
          <select value={categoryId} onChange={evento => setCategoryId(evento.target.value)} required>
            <option value="">Selecione…</option>
            {(catalogo.data?.items || []).map(categoria => (
              <option key={categoria.id} value={categoria.id}>{categoria.name} ({categoria.sex === 'MALE' ? 'M' : 'F'})</option>
            ))}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Adicionar" />
      </form>
    </Modal>
  );
}

function AdicionarDivisao({ eventCategoryId, notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ name: '', code: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.events.addDivision(eventCategoryId, form);
      notificar('Divisão criada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova divisão" description="Ex.: faixa de altura, faixa de peso ou recorte definido pelo regulamento." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Nome" required><input value={form.name} onChange={evento => setForm({ ...form, name: evento.target.value })} required maxLength={90} placeholder="Ex: Até 163 cm" /></Field>
        <Field label="Código" required><input value={form.code} onChange={evento => setForm({ ...form, code: evento.target.value.toUpperCase() })} required pattern="[A-Z0-9_-]{1,40}" placeholder="ATE163" /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar divisão" />
      </form>
    </Modal>
  );
}

function AdicionarClasse({ divisionId, notificar, onClose, onSalvo }) {
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
      notificar('Classe criada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova classe" description="Classes iniciais: Junior, Novice, Open e Master. A estrutura aceita outras." onClose={onClose}>
      <form onSubmit={salvar}>
        <div className="field-row">
          <Field label="Nome" required><input value={form.name} onChange={evento => setForm({ ...form, name: evento.target.value })} required maxLength={90} /></Field>
          <Field label="Código" required><input value={form.code} onChange={evento => setForm({ ...form, code: evento.target.value.toUpperCase() })} required pattern="[A-Z0-9_-]{1,40}" /></Field>
        </div>
        <div className="field-row">
          <Field label="Idade mínima"><input type="number" min="0" max="120" value={form.minAge} onChange={evento => setForm({ ...form, minAge: evento.target.value })} /></Field>
          <Field label="Idade máxima"><input type="number" min="0" max="120" value={form.maxAge} onChange={evento => setForm({ ...form, maxAge: evento.target.value })} /></Field>
        </div>
        <div className="field-row">
          <Field label="Peso mínimo (kg)"><input type="number" step="0.1" min="0" value={form.minWeightGrams} onChange={evento => setForm({ ...form, minWeightGrams: evento.target.value })} /></Field>
          <Field label="Peso máximo (kg)"><input type="number" step="0.1" min="0" value={form.maxWeightGrams} onChange={evento => setForm({ ...form, maxWeightGrams: evento.target.value })} /></Field>
        </div>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar classe" />
      </form>
    </Modal>
  );
}

// ============================================================== INSCRIÇÕES
export function AdminInscricoes({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');
  const [inscrevendo, setInscrevendo] = useState(false);
  const [cancelando, setCancelando] = useState(null);

  const estado = useFetch(
    () => (eventId ? api.registrations.listByEvent(eventId, { limit: 100, search: busca || undefined }) : Promise.resolve({ items: [] })),
    [eventId, busca],
    { ativo: Boolean(eventId) }
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="Operação"
        title="Inscrições"
        description="Reconhecimento por CPF, confirmação de filiação e escolha de categoria, divisão e classe. Não existe pagamento neste fluxo."
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setInscrevendo(true)}><Plus size={15} /> Nova inscrição</button>}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Buscar atleta…" aria-label="Buscar inscrito" />
        </label>
      </div>

      {!eventId
        ? <EmptyState title="Selecione um evento" description="As inscrições são sempre de um evento específico." />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (dados.items.length
              ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Atleta</th><th>Filiação</th><th>Classes</th><th>Situação</th><th>Check-in</th><th /></tr></thead>
                    <tbody>
                      {dados.items.map(inscricao => (
                        <tr key={inscricao.id}>
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
                            <Badge tom={inscricao.status === 'CONFIRMED' ? 'ok' : inscricao.status === 'CANCELLED' ? 'perigo' : 'alerta'}>{inscricao.status}</Badge>
                          </td>
                          <td>{inscricao.checkIn?.status === 'CHECKED_IN' ? <Badge tom="ok">Feito</Badge> : <Badge tom="neutro">Pendente</Badge>}</td>
                          <td style={{ textAlign: 'right' }}>
                            {inscricao.status !== 'CANCELLED' && (
                              <button type="button" className="button button-danger button-sm" onClick={() => setCancelando(inscricao)}>Cancelar</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
              : <EmptyState title="Nenhuma inscrição" description="Use “Nova inscrição” para registrar o primeiro atleta." />
            )}
          </AsyncSection>
        )}

      {inscrevendo && (
        <NovaInscricao eventId={eventId} notificar={notificar} onClose={() => setInscrevendo(false)} onSalvo={() => { setInscrevendo(false); estado.reload(); }} />
      )}
      {cancelando && (
        <CancelarInscricao inscricao={cancelando} notificar={notificar} onClose={() => setCancelando(null)} onSalvo={() => { setCancelando(null); estado.reload(); }} />
      )}
    </div>
  );
}

function NovaInscricao({ eventId, notificar, onClose, onSalvo }) {
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
      notificar(resposta.athleteRecognized ? 'Atleta reconhecido e inscrito.' : 'Perfil criado e atleta inscrito.');
      refreshData();
      onSalvo();
    } catch (erro) {
      setErros(erro.details?.map(item => item.message) || [erro.message]);
      setSalvando(false);
    }
  };

  const sexoDoAtleta = reconhecido?.found ? reconhecido.athlete.sex : novoAtleta.sex;

  return (
    <Modal title="Nova inscrição" description="CPF → perfil → filiação → categoria, divisão e classe." wide onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="CPF do atleta" required hint="A plataforma reconhece o atleta pelo CPF antes de criar qualquer perfil.">
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={cpf} onChange={evt => { setCpf(mascararCpf(evt.target.value)); setReconhecido(null); }} required inputMode="numeric" placeholder="000.000.000-00" />
            <button type="button" className="button button-secondary" onClick={consultar} disabled={consultando || somenteDigitos(cpf).length !== 11}>
              {consultando ? 'Consultando…' : 'Consultar'}
            </button>
          </div>
        </Field>

        {reconhecido?.found && (
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            <div>
              <strong>Atleta reconhecido</strong>
              <p>{reconhecido.athlete.fullName} · {reconhecido.athlete.city || '—'}{reconhecido.athlete.state ? `/${reconhecido.athlete.state}` : ''} · {reconhecido.athlete.sex === 'MALE' ? 'Masculino' : 'Feminino'}</p>
            </div>
          </div>
        )}

        {reconhecido && !reconhecido.found && (
          <>
            <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
              <div><strong>CPF não cadastrado</strong><p>Informe os dados para criar o perfil do atleta.</p></div>
            </div>
            <div className="field-row">
              <Field label="Nome completo" required><input value={novoAtleta.fullName} onChange={evt => setNovoAtleta({ ...novoAtleta, fullName: evt.target.value })} required minLength={2} maxLength={160} /></Field>
              <Field label="Nome esportivo"><input value={novoAtleta.stageName} onChange={evt => setNovoAtleta({ ...novoAtleta, stageName: evt.target.value })} maxLength={80} /></Field>
            </div>
            <div className="field-row">
              <Field label="Sexo" required>
                <select value={novoAtleta.sex} onChange={evt => setNovoAtleta({ ...novoAtleta, sex: evt.target.value })} required>
                  <option value="FEMALE">Feminino</option>
                  <option value="MALE">Masculino</option>
                </select>
              </Field>
              <Field label="Nascimento" hint="Necessário para classes com faixa etária."><input type="date" value={novoAtleta.birthDate} onChange={evt => setNovoAtleta({ ...novoAtleta, birthDate: evt.target.value })} /></Field>
            </div>
            <div className="field-row">
              <Field label="Cidade"><input value={novoAtleta.city} onChange={evt => setNovoAtleta({ ...novoAtleta, city: evt.target.value })} maxLength={90} /></Field>
              <Field label="UF"><input value={novoAtleta.state} onChange={evt => setNovoAtleta({ ...novoAtleta, state: evt.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
            </div>
          </>
        )}

        {reconhecido && (
          <>
            <Field label="Filiação" hint="Vínculo esportivo do atleta. Também é chave de conferência na importação MuscleWar.">
              <select value={affiliationId} onChange={evt => setAffiliationId(evt.target.value)}>
                <option value="">Sem filiação</option>
                {(filiacoes.data?.items || []).map(filiacao => <option key={filiacao.id} value={filiacao.id}>{filiacao.name} ({filiacao.code})</option>)}
              </select>
            </Field>

            <Field label="Categorias, divisões e classes" required>
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
                  : <span style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Este evento ainda não tem classes cadastradas.</span>}
              </div>
            </Field>
          </>
        )}

        {erros.length > 0 && (
          <div className="alert alert-erro" style={{ marginBottom: 12 }}>
            <div>
              <strong>Inscrição recusada</strong>
              <ul>{erros.map((mensagem, indice) => <li key={indice}>{mensagem}</li>)}</ul>
            </div>
          </div>
        )}

        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Registrar inscrição" disabled={!reconhecido || !classIds.length} />
      </form>
    </Modal>
  );
}

function CancelarInscricao({ inscricao, notificar, onClose, onSalvo }) {
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.registrations.cancel(inscricao.id, { reason });
      notificar('Inscrição cancelada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Cancelar inscrição" description={inscricao.athlete.fullName} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Motivo" required hint="Fica registrado na auditoria.">
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} required minLength={3} maxLength={300} />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Cancelar inscrição" />
      </form>
    </Modal>
  );
}

// ============================================================ CHECK-IN
export function AdminCheckin({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');

  const estado = useFetch(
    () => (eventId ? api.operations.listCheckIns(eventId, { limit: 200, search: busca || undefined }) : Promise.resolve({ items: [], summary: null })),
    [eventId, busca],
    { ativo: Boolean(eventId) }
  );

  const operar = async (inscricao, cancelar) => {
    try {
      if (cancelar) await api.operations.cancelCheckIn(inscricao.id);
      else await api.operations.checkIn(inscricao.id, { device: navigator.userAgent.slice(0, 100) });
      notificar(cancelar ? 'Check-in cancelado.' : 'Check-in confirmado.');
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead eyebrow="Operação" title="Check-in" description="Conferência de atleta, inscrição e elegibilidade no dia do evento." />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} filtroStatus={['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Nome ou número do atleta…" aria-label="Buscar atleta" />
        </label>
      </div>

      {!eventId
        ? <EmptyState title="Selecione um evento em operação" description="O check-in só acontece com o evento em janela operacional." />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (
              <>
                {dados.summary && (
                  <div className="grid grid-3" style={{ marginBottom: 16 }}>
                    <Metric label="Inscritos" value={dados.summary.total} />
                    <Metric label="Check-in feito" value={dados.summary.checkedIn} destaque />
                    <Metric label="Pendentes" value={dados.summary.pending} />
                  </div>
                )}

                <section className="panel">
                  {dados.items.length
                    ? dados.items.map(inscricao => {
                      const feito = inscricao.checkIn?.status === 'CHECKED_IN';
                      return (
                        <div className="list-row" key={inscricao.id}>
                          <Avatar name={inscricao.athlete.fullName} />
                          <span className="info">
                            <strong>{inscricao.athlete.stageName || inscricao.athlete.fullName}</strong>
                            <small>
                              {inscricao.athlete.athleteNumber ? `Nº ${inscricao.athlete.athleteNumber} · ` : ''}
                              {inscricao.items.map(item => item.competitionClass.name).join(', ') || 'Sem classe'}
                              {inscricao.weighIns[0] ? ` · ${pesoEmKg(inscricao.weighIns[0].weightGrams)}` : ''}
                            </small>
                          </span>
                          {feito
                            ? (
                              <>
                                <Badge tom="ok"><ClipboardCheck size={12} /> {formatarDataHora(inscricao.checkIn.checkedInAt)}</Badge>
                                <button type="button" className="button button-secondary button-sm" onClick={() => operar(inscricao, true)}>Desfazer</button>
                              </>
                            )
                            : <button type="button" className="button button-primary button-sm" onClick={() => operar(inscricao, false)}>Fazer check-in</button>}
                        </div>
                      );
                    })
                    : <EmptyState title="Nenhum inscrito confirmado" />}
                </section>
              </>
            )}
          </AsyncSection>
        )}
    </div>
  );
}

// ============================================================== PESAGEM
export function AdminPesagem({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [busca, setBusca] = useState('');
  const [pesando, setPesando] = useState(null);

  const estado = useFetch(
    () => (eventId ? api.operations.listCheckIns(eventId, { limit: 200, search: busca || undefined }) : Promise.resolve({ items: [] })),
    [eventId, busca],
    { ativo: Boolean(eventId) }
  );

  return (
    <div className="page">
      <PageHead eyebrow="Operação" title="Pesagem" description="Registro auditável de peso e altura, com operador, momento e observação." />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} filtroStatus={['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']} />
        <label className="search-box">
          <Search size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Nome ou número do atleta…" aria-label="Buscar atleta" />
        </label>
      </div>

      {!eventId
        ? <EmptyState title="Selecione um evento em operação" />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (
              <section className="panel">
                {dados.items.length
                  ? dados.items.map(inscricao => (
                    <div className="list-row" key={inscricao.id}>
                      <Avatar name={inscricao.athlete.fullName} />
                      <span className="info">
                        <strong>{inscricao.athlete.stageName || inscricao.athlete.fullName}</strong>
                        <small>
                          {inscricao.weighIns[0]
                            ? `Última pesagem: ${pesoEmKg(inscricao.weighIns[0].weightGrams)} em ${formatarDataHora(inscricao.weighIns[0].measuredAt)}`
                            : 'Sem pesagem registrada'}
                        </small>
                      </span>
                      <button type="button" className="button button-primary button-sm" onClick={() => setPesando(inscricao)}>
                        <Scale size={13} /> Registrar
                      </button>
                    </div>
                  ))
                  : <EmptyState title="Nenhum inscrito confirmado" />}
              </section>
            )}
          </AsyncSection>
        )}

      {pesando && (
        <RegistrarPesagem inscricao={pesando} notificar={notificar} onClose={() => setPesando(null)} onSalvo={() => { setPesando(null); estado.reload(); }} />
      )}
    </div>
  );
}

function RegistrarPesagem({ inscricao, notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ peso: '', altura: '', notes: '' });
  const [salvando, setSalvando] = useState(false);
  const [foraDeFaixa, setForaDeFaixa] = useState(null);

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
        notificar('Pesagem registrada. Há classe fora da faixa de peso.', 'info');
      } else {
        notificar('Pesagem registrada.');
        onSalvo();
      }
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal title="Registrar pesagem" description={inscricao.athlete.fullName} onClose={onClose}>
      {foraDeFaixa
        ? (
          <>
            <div className="alert alert-alerta">
              <div>
                <strong>Peso fora da faixa</strong>
                <p>A pesagem foi gravada. As classes abaixo estão fora da faixa cadastrada — a reclassificação é decisão da organização.</p>
                <ul>{foraDeFaixa.map(item => <li key={item.classId}>{item.className}</li>)}</ul>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="button button-primary" onClick={onSalvo}>Entendi</button>
            </div>
          </>
        )
        : (
          <form onSubmit={salvar}>
            <div className="field-row">
              <Field label="Peso (kg)" required>
                <input type="number" step="0.01" min="20" max="400" value={form.peso} onChange={evento => setForm({ ...form, peso: evento.target.value })} required autoFocus />
              </Field>
              <Field label="Altura (cm)">
                <input type="number" min="100" max="260" value={form.altura} onChange={evento => setForm({ ...form, altura: evento.target.value })} />
              </Field>
            </div>
            <Field label="Observação"><textarea value={form.notes} onChange={evento => setForm({ ...form, notes: evento.target.value })} maxLength={300} /></Field>
            <ModalActions onClose={onClose} saving={salvando} confirmLabel="Registrar" />
          </form>
        )}
    </Modal>
  );
}

// ======================================================== CREDENCIAMENTO
export function AdminCredenciamento({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [emitindo, setEmitindo] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [leitura, setLeitura] = useState(null);
  const [lendo, setLendo] = useState(false);

  const estado = useFetch(
    () => (eventId ? api.operations.credentials(eventId) : Promise.resolve({ items: [] })),
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
      const resposta = await api.operations.scanCredential(eventId, { code: codigo.trim(), gate: 'Portaria' });
      setLeitura(resposta);
      setCodigo('');
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
        eyebrow="Operação"
        title="Credenciamento"
        description="Emissão e leitura de credenciais de atleta, coach, staff, juiz, imprensa, fotógrafo, patrocinador e convidado."
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setEmitindo(true)}><Plus size={15} /> Emitir credencial</button>}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? <EmptyState title="Selecione um evento" />
        : (
          <div className="grid grid-main">
            <section className="panel">
              <div className="panel-head"><h2>Credenciais emitidas</h2></div>
              <AsyncSection state={estado} linhas={4}>
                {dados => (dados.items.length
                  ? dados.items.map(credencial => (
                    <div className="list-row" key={credencial.id}>
                      {/* O QR desenha o código que a credencial já carrega — o
                          mesmo que a portaria lê. Só faz sentido para credencial
                          ativa: revogada não deve ser apresentável no portão. */}
                      {credencial.status === 'ACTIVE'
                        ? <CodigoQr valor={credencial.code} tamanho={64} />
                        : <span className="avatar"><QrCode size={16} /></span>}
                      <span className="info">
                        <strong>{credencial.holderName}</strong>
                        <small>{credencial.type} · {credencial.code} · {credencial._count.scans} leitura(s)</small>
                      </span>
                      <Badge tom={credencial.status === 'ACTIVE' ? 'ok' : 'perigo'}>{credencial.status === 'ACTIVE' ? 'Ativa' : 'Revogada'}</Badge>
                      {credencial.status === 'ACTIVE' && (
                        <button
                          type="button"
                          className="button button-danger button-sm"
                          onClick={async () => {
                            try {
                              await api.operations.revokeCredential(credencial.id);
                              notificar('Credencial revogada.');
                              estado.reload();
                            } catch (erro) { notificar(erro.message, 'erro'); }
                          }}
                        >
                          Revogar
                        </button>
                      )}
                    </div>
                  ))
                  : <EmptyState title="Nenhuma credencial emitida" />
                )}
              </AsyncSection>
            </section>

            <section className="panel">
              <div className="panel-head"><h2>Leitura</h2></div>
              <form onSubmit={ler}>
                <Field label="Código da credencial" hint="Conteúdo do QR Code impresso.">
                  <input value={codigo} onChange={evento => setCodigo(evento.target.value.toUpperCase())} placeholder="MCI-XXXXXXXXXXXX" />
                </Field>
                <button type="submit" className="button button-primary" style={{ width: '100%' }} disabled={lendo || !codigo.trim()}>
                  {lendo ? 'Validando…' : 'Validar'}
                </button>
              </form>

              {leitura && (
                <div className={`alert ${leitura.accepted ? 'alert-info' : 'alert-erro'}`} style={{ marginTop: 14 }}>
                  <div>
                    <strong>{leitura.accepted ? 'Acesso liberado' : 'Acesso recusado'}</strong>
                    <p>{leitura.credential.holderName} · {leitura.credential.type}</p>
                    {leitura.reason && <p>{leitura.reason}</p>}
                    {leitura.credential.athlete && (
                      <p>{leitura.credential.checkedIn ? 'Check-in confirmado.' : 'Atleta ainda sem check-in.'}</p>
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
  const inscritos = useFetch(() => api.registrations.listByEvent(eventId, { limit: 200, status: 'CONFIRMED' }), [eventId]);
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
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Emitir credencial" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Tipo" required>
          <select value={form.type} onChange={evento => setForm({ ...form, type: evento.target.value })} required>
            {['ATHLETE', 'COACH', 'STAFF', 'JUDGE', 'MEDIA', 'PHOTOGRAPHER', 'SPONSOR', 'GUEST'].map(tipo => <option key={tipo} value={tipo}>{tipo}</option>)}
          </select>
        </Field>
        <Field label="Nome do portador" required>
          <input value={form.holderName} onChange={evento => setForm({ ...form, holderName: evento.target.value })} required minLength={2} maxLength={140} />
        </Field>
        {form.type === 'ATHLETE' && (
          <Field label="Inscrição vinculada" hint="Vincular permite conferir o check-in na leitura.">
            <select
              value={form.registrationId}
              onChange={evento => {
                const inscricao = (inscritos.data?.items || []).find(item => item.id === evento.target.value);
                setForm({ ...form, registrationId: evento.target.value, holderName: inscricao?.athlete.fullName || form.holderName });
              }}
            >
              <option value="">Sem vínculo</option>
              {(inscritos.data?.items || []).map(inscricao => <option key={inscricao.id} value={inscricao.id}>{inscricao.athlete.fullName}</option>)}
            </select>
          </Field>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Emitir" />
      </form>
    </Modal>
  );
}

// ================================================================ PALCO
export function AdminPalco({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [criando, setCriando] = useState(false);
  const [ordenando, setOrdenando] = useState(null);

  const estado = useFetch(
    () => (eventId ? api.operations.batches(eventId) : Promise.resolve({ items: [] })),
    [eventId],
    { ativo: Boolean(eventId) }
  );

  const mudarStatus = async (bateria, status) => {
    try {
      await api.operations.setBatchStatus(bateria.id, { status });
      notificar(status === 'CALLED' ? 'Bateria chamada. Os atletas foram notificados.' : 'Bateria atualizada.');
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="Operação"
        title="Ordem de palco"
        description="Baterias, chamadas e ordem de entrada por classe."
        actions={eventId && <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} /> Nova bateria</button>}
      />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title="Selecione um evento" />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => (dados.items.length
              ? dados.items.map(bateria => (
                <section className="panel" key={bateria.id} style={{ marginBottom: 12 }}>
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
                      <Badge tom={bateria.status === 'DONE' ? 'neutro' : bateria.status === 'ON_STAGE' ? 'perigo' : bateria.status === 'CALLED' ? 'alerta' : 'info'} aoVivo={bateria.status === 'ON_STAGE'}>{bateria.status}</Badge>
                      <button type="button" className="button button-secondary button-sm" onClick={() => setOrdenando(bateria)}>Ordem</button>
                      {bateria.status === 'SCHEDULED' && <button type="button" className="button button-primary button-sm" onClick={() => mudarStatus(bateria, 'CALLED')}>Chamar</button>}
                      {bateria.status === 'CALLED' && <button type="button" className="button button-primary button-sm" onClick={() => mudarStatus(bateria, 'ON_STAGE')}>No palco</button>}
                      {bateria.status === 'ON_STAGE' && <button type="button" className="button button-secondary button-sm" onClick={() => mudarStatus(bateria, 'DONE')}>Encerrar</button>}
                    </div>
                  </div>
                </section>
              ))
              : <EmptyState title="Nenhuma bateria" description="Crie a primeira bateria para montar a ordem de palco." />
            )}
          </AsyncSection>
        )}

      {criando && <NovaBateria eventId={eventId} notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
      {ordenando && <OrdemDePalco bateria={ordenando} notificar={notificar} onClose={() => setOrdenando(null)} onSalvo={() => { setOrdenando(null); estado.reload(); }} />}
    </div>
  );
}

function NovaBateria({ eventId, notificar, onClose, onSalvo }) {
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
      notificar('Bateria criada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova bateria" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Classe" required>
          <select value={form.classId} onChange={evt => setForm({ ...form, classId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {classes.map(classe => <option key={classe.id} value={classe.id}>{classe.rotulo}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} placeholder="Ex: Bateria 1" /></Field>
        <Field label="Horário"><input type="datetime-local" value={form.scheduledAt} onChange={evt => setForm({ ...form, scheduledAt: evt.target.value })} /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar bateria" />
      </form>
    </Modal>
  );
}

function OrdemDePalco({ bateria, notificar, onClose, onSalvo }) {
  const ordem = useFetch(() => api.operations.stageOrder(bateria.id), [bateria.id]);
  const inscritos = useFetch(() => api.registrations.listByEvent(bateria.eventId, { limit: 200, status: 'CONFIRMED', classId: bateria.classId }), [bateria.eventId, bateria.classId]);
  const [itens, setItens] = useState(null);
  const [salvando, setSalvando] = useState(false);

  const listaAtual = itens ?? (ordem.data?.orders || []).map(item => ({
    registrationItemId: item.registrationItemId,
    nome: item.registrationItem.registration.athlete.fullName
  }));

  const disponiveis = (inscritos.data?.items || [])
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
      notificar('Ordem de palco salva.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Ordem — ${bateria.name}`} description="Posição de entrada dos atletas nesta bateria." wide onClose={onClose}>
      <div className="grid grid-2">
        <section>
          <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', marginBottom: 10 }}>Ordem definida</h3>
          {listaAtual.length
            ? listaAtual.map((item, indice) => (
              <div className="judge-row" key={item.registrationItemId} style={{ marginBottom: 6 }}>
                <span className="placing">{indice + 1}</span>
                <span className="info"><strong>{item.nome}</strong></span>
                <button type="button" className="button button-secondary button-sm" onClick={() => mover(indice, -1)} aria-label="Subir">↑</button>
                <button type="button" className="button button-secondary button-sm" onClick={() => mover(indice, 1)} aria-label="Descer">↓</button>
                <button type="button" className="button button-danger button-sm" onClick={() => setItens(listaAtual.filter((_, posicao) => posicao !== indice))}>×</button>
              </div>
            ))
            : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Nenhum atleta na ordem.</p>}
        </section>

        <section>
          <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', marginBottom: 10 }}>Disponíveis</h3>
          {disponiveis.length
            ? disponiveis.map(candidato => (
              <div className="judge-row" key={candidato.registrationItemId} style={{ marginBottom: 6 }}>
                <span className="info"><strong>{candidato.nome}</strong></span>
                <button type="button" className="button button-secondary button-sm" onClick={() => setItens([...listaAtual, candidato])}>Adicionar</button>
              </div>
            ))
            : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Todos os inscritos já estão na ordem.</p>}
        </section>
      </div>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>Fechar</button>
        <button type="button" className="button button-primary" onClick={salvar} disabled={salvando || !listaAtual.length}>Salvar ordem</button>
      </div>
    </Modal>
  );
}

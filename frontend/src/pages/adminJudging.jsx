import { useEffect, useState } from 'react';
import { Gavel, Plus, ShieldCheck } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, ConfirmDialog, EmptyState, Field, Modal, ModalActions, PageHead } from '../components/ui';
import { formatarDataHora } from '../lib/format';
import { SeletorDeEvento } from './adminEvent';

// Julgamento e apuração. O juiz preenche a ficha; encerrar, apurar e publicar
// são permissões distintas — a interface reflete isso e a API confirma.

export function AdminJulgamento({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [criandoPainel, setCriandoPainel] = useState(false);
  const [abrindoSessao, setAbrindoSessao] = useState(false);
  const [ficha, setFicha] = useState(null);
  const [fechando, setFechando] = useState(null);
  const [painelAlvo, setPainelAlvo] = useState(null);

  const paineis = useFetch(() => (eventId ? api.judging.panels(eventId) : Promise.resolve({ items: [] })), [eventId], { ativo: Boolean(eventId) });
  const sessoes = useFetch(() => (eventId ? api.judging.sessions(eventId) : Promise.resolve({ items: [] })), [eventId], { ativo: Boolean(eventId) });

  const encerrar = async sessao => {
    try {
      await api.judging.close(sessao.id);
      notificar('Sessão encerrada. A classe pode ser apurada.');
      sessoes.reload();
    } catch (erro) {
      const detalhes = erro.details?.map(item => item.message).join(' · ');
      notificar(detalhes ? `${erro.message}: ${detalhes}` : erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="Competição"
        title="Julgamento"
        description="Painéis, escalação de juízes, sessões e coleta de colocações."
        actions={eventId && (
          <>
            <button type="button" className="button button-secondary" onClick={() => setCriandoPainel(true)}><Plus size={15} /> Painel</button>
            <button type="button" className="button button-primary" onClick={() => setAbrindoSessao(true)}><Gavel size={15} /> Abrir sessão</button>
          </>
        )}
      />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title="Selecione um evento" description="A sessão de julgamento exige o evento no estado “Em julgamento”." />
        : (
          <div className="grid grid-main">
            <section className="panel">
              <div className="panel-head"><h2>Sessões</h2></div>
              <AsyncSection state={sessoes} linhas={3}>
                {dados => (dados.items.length
                  ? dados.items.map(sessao => (
                    <div className="list-row" key={sessao.id}>
                      <span className="avatar"><Gavel size={15} /></span>
                      <span className="info">
                        <strong>
                          {sessao.competitionClass.division.eventCategory.category.name} · {sessao.competitionClass.division.name} · {sessao.competitionClass.name}
                        </strong>
                        <small>{sessao.round} · painel {sessao.panel.name} · {sessao._count.scores} voto(s)</small>
                      </span>
                      <Badge tom={sessao.status === 'CLOSED' ? 'neutro' : sessao.status === 'SCORING' ? 'alerta' : 'info'}>{sessao.status}</Badge>
                      <button type="button" className="button button-secondary button-sm" onClick={() => setFicha(sessao)}>Ficha</button>
                      {sessao.status !== 'CLOSED' && (
                        <button type="button" className="button button-primary button-sm" onClick={() => setFechando(sessao)}>Encerrar</button>
                      )}
                    </div>
                  ))
                  : <EmptyState title="Nenhuma sessão" description="Abra uma sessão para a classe que vai ser julgada." />
                )}
              </AsyncSection>
            </section>

            <section className="panel">
              <div className="panel-head"><h2>Painéis</h2></div>
              <AsyncSection state={paineis} linhas={3}>
                {dados => (dados.items.length
                  ? dados.items.map(painel => (
                    <div key={painel.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <strong style={{ fontSize: 13 }}>{painel.name}</strong>
                        <button type="button" className="button button-ghost button-sm" style={{ marginLeft: 'auto' }} onClick={() => setPainelAlvo(painel)}>
                          + Juiz
                        </button>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        {painel.judges.length
                          ? painel.judges.map(assento => (
                            <div className="list-row" key={assento.id} style={{ padding: '7px 0' }}>
                              <span className="placing" style={{ width: 26, height: 26, fontSize: 14 }}>{assento.seat}</span>
                              <span className="info">
                                <strong>{assento.judge.name}</strong>
                                <small>{assento.judge.email}</small>
                              </span>
                              {assento.role === 'HEAD' && <Badge tom="info"><ShieldCheck size={11} /> Chefe</Badge>}
                            </div>
                          ))
                          : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Sem juízes escalados.</p>}
                      </div>
                    </div>
                  ))
                  : <EmptyState title="Nenhum painel" description="Crie um painel e escale os juízes." />
                )}
              </AsyncSection>
            </section>
          </div>
        )}

      {criandoPainel && <NovoPainel eventId={eventId} notificar={notificar} onClose={() => setCriandoPainel(false)} onSalvo={() => { setCriandoPainel(false); paineis.reload(); }} />}
      {painelAlvo && <EscalarJuiz painel={painelAlvo} notificar={notificar} onClose={() => setPainelAlvo(null)} onSalvo={() => { setPainelAlvo(null); paineis.reload(); }} />}
      {abrindoSessao && <AbrirSessao eventId={eventId} paineis={paineis.data?.items || []} notificar={notificar} onClose={() => setAbrindoSessao(false)} onSalvo={() => { setAbrindoSessao(false); sessoes.reload(); }} />}
      {ficha && <FichaDoJuiz sessao={ficha} notificar={notificar} onClose={() => setFicha(null)} onSalvo={() => { setFicha(null); sessoes.reload(); }} />}
      {fechando && (
        <ConfirmDialog
          title="Encerrar sessão"
          message="Depois de encerrada, as fichas ficam congeladas e a classe pode ser apurada. A sessão só fecha com todos os juízes tendo pontuado todos os atletas."
          confirmLabel="Encerrar"
          onConfirm={() => encerrar(fechando)}
          onClose={() => setFechando(null)}
        />
      )}
    </div>
  );
}

function NovoPainel({ eventId, notificar, onClose, onSalvo }) {
  const [name, setName] = useState('');
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.judging.createPanel(eventId, { name });
      notificar('Painel criado.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Novo painel" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Nome" required><input value={name} onChange={evento => setName(evento.target.value)} required maxLength={90} placeholder="Ex: Painel A" /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar painel" />
      </form>
    </Modal>
  );
}

function EscalarJuiz({ painel, notificar, onClose, onSalvo }) {
  const usuarios = useFetch(() => api.admin.users({ limit: 100 }), []);
  const [form, setForm] = useState({ judgeId: '', seat: painel.judges.length + 1, role: painel.judges.some(item => item.role === 'HEAD') ? 'JUDGE' : 'HEAD' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.judging.addJudge(painel.id, { judgeId: form.judgeId, seat: Number(form.seat), role: form.role });
      notificar('Juiz escalado.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Escalar juiz — ${painel.name}`} description="Só entra no painel quem tem permissão de pontuar nesta organização." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Juiz" required>
          <select value={form.judgeId} onChange={evento => setForm({ ...form, judgeId: evento.target.value })} required>
            <option value="">Selecione…</option>
            {(usuarios.data?.items || []).map(usuario => (
              <option key={usuario.id} value={usuario.id}>{usuario.name} — {usuario.email} ({usuario.role})</option>
            ))}
          </select>
        </Field>
        <div className="field-row">
          <Field label="Assento" required>
            <input type="number" min="1" max="20" value={form.seat} onChange={evento => setForm({ ...form, seat: evento.target.value })} required />
          </Field>
          <Field label="Função" hint="O painel tem no máximo um juiz-chefe.">
            <select value={form.role} onChange={evento => setForm({ ...form, role: evento.target.value })}>
              <option value="JUDGE">Juiz</option>
              <option value="HEAD">Juiz-chefe</option>
            </select>
          </Field>
        </div>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Escalar" />
      </form>
    </Modal>
  );
}

function AbrirSessao({ eventId, paineis, notificar, onClose, onSalvo }) {
  const evento = useFetch(() => api.events.findOne(eventId), [eventId]);
  const [form, setForm] = useState({ classId: '', panelId: '', round: 'FINALS' });
  const [salvando, setSalvando] = useState(false);

  const classes = (evento.data?.eventCategories || []).flatMap(eventCategory =>
    eventCategory.divisions.flatMap(divisao =>
      divisao.classes.map(classe => ({ id: classe.id, rotulo: `${eventCategory.category.name} · ${divisao.name} · ${classe.name}` }))
    )
  );

  const salvar = async submit => {
    submit.preventDefault();
    setSalvando(true);
    try {
      await api.judging.openSession(form);
      notificar('Sessão aberta.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Abrir sessão de julgamento" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Classe" required>
          <select value={form.classId} onChange={evt => setForm({ ...form, classId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {classes.map(classe => <option key={classe.id} value={classe.id}>{classe.rotulo}</option>)}
          </select>
        </Field>
        <Field label="Painel" required>
          <select value={form.panelId} onChange={evt => setForm({ ...form, panelId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {paineis.map(painel => <option key={painel.id} value={painel.id}>{painel.name} ({painel.judges.length} juízes)</option>)}
          </select>
        </Field>
        <Field label="Rodada" hint="A apuração usa a final quando ela existe; senão, a pré-julgamento.">
          <select value={form.round} onChange={evt => setForm({ ...form, round: evt.target.value })}>
            <option value="PREJUDGING">Pré-julgamento</option>
            <option value="COMPARISON">Comparação</option>
            <option value="FINALS">Final</option>
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Abrir sessão" />
      </form>
    </Modal>
  );
}

function FichaDoJuiz({ sessao, notificar, onClose, onSalvo }) {
  const estado = useFetch(() => api.judging.sheet(sessao.id), [sessao.id]);
  const [colocacoes, setColocacoes] = useState({});
  const [salvando, setSalvando] = useState(false);

  // A ficha já enviada volta preenchida: corrigir é reenviar, e o envio é
  // substitutivo — nunca soma uma segunda ficha do mesmo juiz.
  useEffect(() => {
    if (!estado.data) return;
    const inicial = {};
    for (const voto of estado.data.myScores) inicial[voto.registrationItemId] = String(voto.placing);
    setColocacoes(inicial);
  }, [estado.data]);

  const competidores = estado.data?.competitors || [];
  const usadas = Object.values(colocacoes).filter(Boolean);
  const repetida = usadas.length !== new Set(usadas).size;
  const completa = competidores.length > 0 && usadas.length === competidores.length;

  const enviar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.judging.submit(sessao.id, {
        placings: competidores
          .filter(competidor => colocacoes[competidor.registrationItemId])
          .map(competidor => ({ registrationItemId: competidor.registrationItemId, placing: Number(colocacoes[competidor.registrationItemId]) }))
      });
      notificar('Ficha enviada.');
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title="Ficha de julgamento"
      description={estado.data ? `${estado.data.session.competitionClass.name} · ${estado.data.session.round} · painel ${estado.data.session.panel.name}` : ''}
      wide
      onClose={onClose}
    >
      <AsyncSection state={estado} linhas={4}>
        {dados => (
          <form onSubmit={enviar}>
            <div className="alert alert-info" style={{ marginBottom: 14 }}>
              <div>
                <strong>Uma colocação por atleta, sem repetir</strong>
                <p>Reenviar substitui a sua ficha inteira. A ficha de outro juiz não é afetada.</p>
              </div>
            </div>

            <div className="judge-sheet">
              {dados.competitors.map(competidor => (
                <div className="judge-row" key={competidor.registrationItemId}>
                  {competidor.position && <span className="placing">{competidor.position}</span>}
                  <Avatar name={competidor.athlete.fullName} size="avatar-sm" />
                  <span className="info">
                    <strong>{competidor.athlete.stageName || competidor.athlete.fullName}</strong>
                    <small>{competidor.bibNumber ? `Nº ${competidor.bibNumber}` : competidor.athlete.athleteNumber ? `Nº ${competidor.athlete.athleteNumber}` : '—'}</small>
                  </span>
                  <select
                    value={colocacoes[competidor.registrationItemId] || ''}
                    onChange={evt => setColocacoes({ ...colocacoes, [competidor.registrationItemId]: evt.target.value })}
                    aria-label={`Colocação de ${competidor.athlete.fullName}`}
                  >
                    <option value="">—</option>
                    {dados.competitors.map((_, indice) => <option key={indice} value={indice + 1}>{indice + 1}º</option>)}
                  </select>
                </div>
              ))}
              {!dados.competitors.length && <EmptyState title="Sem atletas nesta sessão" description="Só entra na ficha quem está inscrito na classe e fez check-in." />}
            </div>

            {repetida && (
              <div className="alert alert-erro" style={{ marginTop: 14 }}>
                <div><strong>Colocação repetida</strong><p>O mesmo juiz não pode dar a mesma colocação a dois atletas.</p></div>
              </div>
            )}

            <section style={{ marginTop: 18 }}>
              <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', marginBottom: 10 }}>Progresso do painel</h3>
              {dados.progress.map(juiz => (
                <div key={juiz.judgeId} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                    <span>Assento {juiz.seat}{juiz.role === 'HEAD' ? ' (chefe)' : ''}</span>
                    <span>{juiz.scored}/{juiz.total}</span>
                  </div>
                  <div className="progress-bar"><i style={{ width: `${juiz.total ? (juiz.scored / juiz.total) * 100 : 0}%` }} /></div>
                </div>
              ))}
            </section>

            <ModalActions onClose={onClose} saving={salvando} confirmLabel="Enviar ficha" disabled={!completa || repetida} />
          </form>
        )}
      </AsyncSection>
    </Modal>
  );
}

// ============================================================= RESULTADOS
export function AdminResultados({ notificar }) {
  const [eventId, setEventId] = useState('');
  const [corrigindo, setCorrigindo] = useState(null);
  const [versoes, setVersoes] = useState(null);
  const [publicando, setPublicando] = useState(null);

  const evento = useFetch(() => (eventId ? api.events.findOne(eventId) : Promise.resolve(null)), [eventId], { ativo: Boolean(eventId) });
  const resultados = useFetch(() => (eventId ? api.results.listByEvent(eventId) : Promise.resolve({ items: [] })), [eventId], { ativo: Boolean(eventId) });

  const classes = (evento.data?.eventCategories || []).flatMap(eventCategory =>
    eventCategory.divisions.flatMap(divisao =>
      divisao.classes.map(classe => ({ id: classe.id, rotulo: `${eventCategory.category.name} · ${divisao.name} · ${classe.name}` }))
    )
  );

  const apurar = async classId => {
    try {
      const resultado = await api.results.calculate(classId);
      notificar(resultado.hasUnresolvedTie ? 'Apuração concluída com empate não resolvido.' : 'Apuração concluída.', resultado.hasUnresolvedTie ? 'info' : 'ok');
      resultados.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead eyebrow="Competição" title="Resultados" description="Apuração determinística, publicação protegida e correção versionada." />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title="Selecione um evento" />
        : (
          <>
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><h2>Apurar classe</h2></div>
              {classes.length
                ? classes.map(classe => {
                  const existente = (resultados.data?.items || []).find(item => item.classId === classe.id);
                  return (
                    <div className="list-row" key={classe.id}>
                      <span className="info">
                        <strong>{classe.rotulo}</strong>
                        <small>
                          {existente
                            ? `${existente.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'} · versão ${existente.version} · checksum ${existente.checksum.slice(0, 10)}…`
                            : 'Ainda não apurado'}
                        </small>
                      </span>
                      {existente?.hasUnresolvedTie && <Badge tom="perigo">Empate não resolvido</Badge>}
                      <button type="button" className="button button-secondary button-sm" onClick={() => apurar(classe.id)}>
                        {existente ? 'Reapurar' : 'Apurar'}
                      </button>
                      {existente && existente.status !== 'PUBLISHED' && (
                        <button type="button" className="button button-primary button-sm" onClick={() => setPublicando(existente)}>Publicar</button>
                      )}
                      {existente && (
                        <>
                          <button type="button" className="button button-secondary button-sm" onClick={() => setCorrigindo(existente)}>Corrigir</button>
                          <button type="button" className="button button-ghost button-sm" onClick={() => setVersoes(existente)}>Versões</button>
                        </>
                      )}
                    </div>
                  );
                })
                : <EmptyState title="Sem classes cadastradas" />}
            </section>

            <AsyncSection state={resultados} linhas={3}>
              {dados => dados.items.map(resultado => (
                <section className="panel" key={resultado.id} style={{ marginBottom: 12 }}>
                  <div className="panel-head">
                    <div>
                      <h2>{resultado.competitionClass.division.eventCategory.category.name} · {resultado.competitionClass.name}</h2>
                      <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                        Versão {resultado.version} · apurado em {formatarDataHora(resultado.computedAt)}
                      </small>
                    </div>
                    <Badge tom={resultado.status === 'PUBLISHED' ? 'ok' : 'alerta'}>{resultado.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'}</Badge>
                  </div>

                  {resultado.entries.map(entrada => (
                    <div className="list-row" key={entrada.id}>
                      <span className={entrada.status === 'TIE_UNRESOLVED' ? 'placing placing-tie' : `placing placing-${entrada.placing}`}>
                        {entrada.status === 'TIE_UNRESOLVED' ? 'EMP' : entrada.placing ?? '—'}
                      </span>
                      <span className="info">
                        <strong>{entrada.athlete.stageName || entrada.athlete.fullName}</strong>
                        <small>soma {entrada.score} · bruta {entrada.rawScore} · {entrada.breakdown?.judgeVotes ?? 0} voto(s)</small>
                      </span>
                      {entrada.status !== 'RANKED' && <Badge tom="perigo">{entrada.status}</Badge>}
                    </div>
                  ))}
                </section>
              ))}
            </AsyncSection>
          </>
        )}

      {publicando && (
        <PublicarResultado resultado={publicando} notificar={notificar} onClose={() => setPublicando(null)} onSalvo={() => { setPublicando(null); resultados.reload(); }} />
      )}
      {corrigindo && (
        <CorrigirResultado resultado={corrigindo} notificar={notificar} onClose={() => setCorrigindo(null)} onSalvo={() => { setCorrigindo(null); resultados.reload(); }} />
      )}
      {versoes && <HistoricoDeVersoes resultado={versoes} onClose={() => setVersoes(null)} />}
    </div>
  );
}

function PublicarResultado({ resultado, notificar, onClose, onSalvo }) {
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);

  const publicar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const resposta = await api.results.publish(resultado.classId, { reason: reason || null });
      notificar(`Resultado publicado. ${resposta.ranking?.awarded ? `${resposta.ranking.awarded} atleta(s) pontuaram no ranking.` : 'Sem pontuação de ranking (evento sem temporada).'}`);
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Publicar resultado" description="Publicar torna a classificação pública e dispara a pontuação de ranking." onClose={onClose}>
      <form onSubmit={publicar}>
        <Field label="Motivo / observação" hint="Fica registrado na versão publicada.">
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} maxLength={300} placeholder="Ex: Apuração conferida pela comissão técnica" />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Publicar" />
      </form>
    </Modal>
  );
}

function CorrigirResultado({ resultado, notificar, onClose, onSalvo }) {
  const [reason, setReason] = useState('');
  const [entradas, setEntradas] = useState(
    resultado.entries.map(entrada => ({
      registrationItemId: entrada.registrationItemId,
      nome: entrada.athlete.stageName || entrada.athlete.fullName,
      placing: entrada.placing ?? '',
      status: entrada.status
    }))
  );
  const [salvando, setSalvando] = useState(false);

  const colocacoes = entradas.map(item => item.placing).filter(valor => valor !== '');
  const repetida = colocacoes.length !== new Set(colocacoes).size;

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.results.override(resultado.classId, {
        reason,
        entries: entradas.map(item => ({
          registrationItemId: item.registrationItemId,
          placing: item.placing === '' ? null : Number(item.placing),
          status: item.status
        }))
      });
      notificar('Correção registrada como nova versão.');
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Corrigir resultado" description="A correção não sobrescreve: cria a versão seguinte, preserva a anterior e exige motivo." wide onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Motivo da correção" required>
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} required minLength={5} maxLength={400} placeholder="Ex: Desempate decidido em reunião da comissão técnica" />
        </Field>

        <div className="judge-sheet">
          {entradas.map((entrada, indice) => (
            <div className="judge-row" key={entrada.registrationItemId}>
              <span className="info"><strong>{entrada.nome}</strong></span>
              <select
                value={entrada.status}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, status: evt.target.value } : item)))}
                style={{ width: 150 }}
                aria-label={`Situação de ${entrada.nome}`}
              >
                <option value="RANKED">Classificado</option>
                <option value="TIE_UNRESOLVED">Empate não resolvido</option>
                <option value="DISQUALIFIED">Desclassificado</option>
                <option value="ABSENT">Ausente</option>
              </select>
              <input
                type="number"
                min="1"
                max="200"
                value={entrada.placing}
                disabled={entrada.status !== 'RANKED'}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, placing: evt.target.value } : item)))}
                style={{ width: 80, background: 'var(--preto)', border: '1px solid var(--linha-forte)', borderRadius: 4, padding: 8, textAlign: 'center' }}
                aria-label={`Colocação de ${entrada.nome}`}
              />
            </div>
          ))}
        </div>

        {repetida && (
          <div className="alert alert-erro" style={{ marginTop: 14 }}>
            <div><strong>Colocação repetida</strong><p>Duas colocações iguais não formam uma classificação válida.</p></div>
          </div>
        )}

        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Registrar correção" disabled={repetida} />
      </form>
    </Modal>
  );
}

function HistoricoDeVersoes({ resultado, onClose }) {
  const estado = useFetch(() => api.results.versions(resultado.classId), [resultado.classId]);

  return (
    <Modal title="Histórico de versões" description="Cada mudança de estado do resultado gera uma versão preservada." wide onClose={onClose}>
      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? dados.items.map(versao => (
            <div key={versao.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="placing">{versao.version}</span>
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', fontSize: 13 }}>{versao.reason}</strong>
                  <small style={{ color: 'var(--cinza-fraco)' }}>
                    {versao.createdBy?.name || 'sistema'} · {formatarDataHora(versao.createdAt)} · {versao.snapshot.status}
                  </small>
                </div>
              </div>
              <div className="chips" style={{ marginTop: 8 }}>
                {(versao.snapshot.entries || []).map(entrada => (
                  <span className="chip" key={entrada.registrationItemId}>
                    {entrada.placing ?? '—'}º · {entrada.status}
                  </span>
                ))}
              </div>
            </div>
          ))
          : <EmptyState title="Sem versões registradas" />
        )}
      </AsyncSection>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

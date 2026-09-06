import { useState } from 'react';
import { AlertTriangle, Building2, Plus, Upload, Users } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, ConfirmDialog, EmptyState, Field, Metric, Modal, ModalActions, PageHead } from '../components/ui';
import { ESTADO_MATCH, formatarDataHora } from '../lib/format';

// Painel administrativo, ranking, importação MuscleWar, auditoria e
// configurações da plataforma.

export function AdminPainel({ navegar }) {
  const estado = useFetch(() => api.dashboard.admin(), []);

  return (
    <div className="page">
      <PageHead eyebrow="Administração" title="Painel" description="Números reais da operação. Nenhuma métrica desta tela é estimada." />

      <AsyncSection state={estado} linhas={4}>
        {dados => (
          <>
            {dados.alerts.length > 0 && (
              <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
                {dados.alerts.map(alerta => (
                  <div key={alerta.code} className={`alert ${alerta.level === 'HIGH' ? 'alert-erro' : 'alert-alerta'}`}>
                    <AlertTriangle size={16} />
                    <div><strong>{alerta.message}</strong></div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-4">
              <Metric label="Eventos ativos" value={dados.events.active} hint={`${dados.events.total} no total`} destaque />
              <Metric label="Atletas" value={dados.athletes.total} hint={`${dados.athletes.pro} PRO`} />
              <Metric label="Inscrições" value={dados.registrations} />
              <Metric label="Check-ins" value={dados.checkIns} />
              <Metric label="Pesagens" value={dados.weighIns} />
              <Metric label="Baterias" value={dados.batches} />
              <Metric label="Sessões abertas" value={dados.openJudgingSessions} />
              <Metric label="Resultados publicados" value={dados.publishedResults} />
            </div>

            <div className="grid grid-3" style={{ marginTop: 18 }}>
              <button type="button" className="panel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/eventos')}>
                <h2 className="display" style={{ fontSize: 20 }}>Eventos</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>Criar etapas, montar o quadro de categorias e mover estados.</p>
              </button>
              <button type="button" className="panel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/musclewar')}>
                <h2 className="display" style={{ fontSize: 20 }}>MuscleWar</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>
                  {dados.muscleWarImports} importação(ões) registrada(s).
                </p>
              </button>
              <button type="button" className="panel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/auditoria')}>
                <h2 className="display" style={{ fontSize: 20 }}>Auditoria</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>Trilha das ações críticas da plataforma.</p>
              </button>
            </div>
          </>
        )}
      </AsyncSection>
    </div>
  );
}

// ================================================================ RANKING
export function AdminRanking({ notificar }) {
  const [criando, setCriando] = useState(false);
  const [pontuando, setPontuando] = useState(null);
  const estado = useFetch(() => api.ranking.seasons(), []);

  const recalcular = async temporada => {
    try {
      const resposta = await api.ranking.recompute(temporada.id);
      notificar(`Ranking recalculado: ${resposta.rows} linha(s).`);
      refreshData();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="Administração"
        title="Ranking e temporadas"
        description="A tabela de pontos por colocação é dado do regulamento, não constante do sistema."
        actions={<button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} /> Nova temporada</button>}
      />

      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? dados.items.map(temporada => (
            <section className="panel" key={temporada.id} style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <div>
                  <h2>{temporada.name}</h2>
                  <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                    {temporada.year} · {temporada._count.events} evento(s) · {temporada._count.points} pontuação(ões) · {temporada._count.pointsRules} regra(s) de pontos
                  </small>
                </div>
                <div className="actions">
                  <Badge tom={temporada.status === 'OPEN' ? 'ok' : 'neutro'}>{temporada.status === 'OPEN' ? 'Aberta' : 'Encerrada'}</Badge>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setPontuando(temporada)}>Tabela de pontos</button>
                  <button type="button" className="button button-secondary button-sm" onClick={() => recalcular(temporada)}>Recalcular</button>
                </div>
              </div>
              {temporada._count.pointsRules === 0 && (
                <div className="alert alert-alerta">
                  <AlertTriangle size={15} />
                  <div><strong>Sem tabela de pontos</strong><p>Nenhum resultado desta temporada vai pontuar até que a tabela seja cadastrada.</p></div>
                </div>
              )}
            </section>
          ))
          : <EmptyState title="Nenhuma temporada" description="Crie a temporada para que os resultados publicados pontuem no ranking." />
        )}
      </AsyncSection>

      {criando && <NovaTemporada notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
      {pontuando && <TabelaDePontos temporada={pontuando} notificar={notificar} onClose={() => setPontuando(null)} onSalvo={() => { setPontuando(null); estado.reload(); }} />}
    </div>
  );
}

function NovaTemporada({ notificar, onClose, onSalvo }) {
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [form, setForm] = useState({ organizationId: '', name: '', year: new Date().getFullYear() });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.ranking.createSeason({ organizationId: form.organizationId, name: form.name, year: Number(form.year) });
      notificar('Temporada criada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova temporada" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Organização" required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} placeholder="Ex: Temporada 2026" /></Field>
        <Field label="Ano" required><input type="number" min="2000" max="2100" value={form.year} onChange={evt => setForm({ ...form, year: evt.target.value })} required /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar temporada" />
      </form>
    </Modal>
  );
}

function TabelaDePontos({ temporada, notificar, onClose, onSalvo }) {
  const [regras, setRegras] = useState([
    { placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 },
    { placing: 4, points: 50 }, { placing: 5, points: 40 }, { placing: 6, points: 30 }
  ]);
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.ranking.setPointsRules(temporada.id, { rules: regras.map(regra => ({ placing: Number(regra.placing), points: Number(regra.points) })) });
      notificar('Tabela de pontos salva.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Tabela de pontos — ${temporada.name}`} description="Quantos pontos cada colocação vale nesta temporada. O sistema não presume nenhuma pontuação." onClose={onClose}>
      <form onSubmit={salvar}>
        {regras.map((regra, indice) => (
          <div className="field-row" key={indice}>
            <Field label="Colocação">
              <input type="number" min="1" max="200" value={regra.placing} onChange={evt => setRegras(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, placing: evt.target.value } : item)))} />
            </Field>
            <Field label="Pontos">
              <input type="number" min="0" max="100000" value={regra.points} onChange={evt => setRegras(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, points: evt.target.value } : item)))} />
            </Field>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="button button-secondary button-sm" onClick={() => setRegras([...regras, { placing: regras.length + 1, points: 0 }])}>+ Colocação</button>
          {regras.length > 1 && <button type="button" className="button button-secondary button-sm" onClick={() => setRegras(regras.slice(0, -1))}>− Última</button>}
        </div>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Salvar tabela" />
      </form>
    </Modal>
  );
}

// ============================================================== MUSCLEWAR
export function AdminMuscleWar({ notificar }) {
  const [importando, setImportando] = useState(false);
  const [detalhe, setDetalhe] = useState(null);
  const estado = useFetch(() => api.muscleWar.list({ limit: 50 }), []);

  return (
    <div className="page">
      <PageHead
        eyebrow="Integração"
        title="MuscleWar"
        description="Importação de resultados externos com reconhecimento por CPF, confirmação por filiação e idempotência."
        actions={<button type="button" className="button button-primary" onClick={() => setImportando(true)}><Upload size={15} /> Importar resultados MuscleWar</button>}
      />

      <AsyncSection state={estado} linhas={4}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Origem</th><th>Situação</th><th className="num">Registros</th><th className="num">Reconhecidos</th><th className="num">Pendentes</th><th className="num">Conflitos</th><th>Quando</th><th /></tr>
                </thead>
                <tbody>
                  {dados.items.map(lote => (
                    <tr key={lote.id}>
                      <td>
                        <strong>{lote.sourceRef}</strong>
                        <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
                          {lote.sourceType} · {lote.season?.name || 'sem temporada'} · v{lote.version}
                        </small>
                      </td>
                      <td>
                        <Badge tom={lote.status === 'APPLIED' ? 'ok' : lote.status === 'REJECTED' ? 'perigo' : 'alerta'}>{lote.status}</Badge>
                      </td>
                      <td className="num">{lote.totalRecords}</td>
                      <td className="num">{lote.matchedCount}</td>
                      <td className="num">{lote.pendingCount}</td>
                      <td className="num">{lote.conflictCount}</td>
                      <td>
                        {formatarDataHora(lote.createdAt)}
                        <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{lote.createdBy?.name}</small>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="button button-secondary button-sm" onClick={() => setDetalhe(lote.id)}>Revisar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title="Nenhuma importação" description="Envie um arquivo do MuscleWar para começar." />
        )}
      </AsyncSection>

      {importando && <NovaImportacao notificar={notificar} onClose={() => setImportando(false)} onCriada={id => { setImportando(false); estado.reload(); setDetalhe(id); }} />}
      {detalhe && <RevisarImportacao importId={detalhe} notificar={notificar} onClose={() => setDetalhe(null)} onMudou={() => estado.reload()} />}
    </div>
  );
}

function NovaImportacao({ notificar, onClose, onCriada }) {
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  const [form, setForm] = useState({ organizationId: '', seasonId: '', sourceType: 'CSV', sourceRef: '', content: '' });
  const [salvando, setSalvando] = useState(false);

  const lerArquivo = async evento => {
    const arquivo = evento.target.files?.[0];
    if (!arquivo) return;
    const texto = await arquivo.text();
    setForm(atual => ({
      ...atual,
      content: texto,
      sourceRef: arquivo.name,
      sourceType: arquivo.name.toLowerCase().endsWith('.json') ? 'JSON' : 'CSV'
    }));
  };

  const enviar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const previa = await api.muscleWar.create({
        organizationId: form.organizationId,
        seasonId: form.seasonId || null,
        sourceType: form.sourceType,
        sourceRef: form.sourceRef,
        content: form.content
      });
      notificar('Pré-visualização gerada. Nada foi aplicado ainda.');
      onCriada(previa.import.id);
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Importar resultados MuscleWar" description="O arquivo é lido e conferido; nada é aplicado antes da sua confirmação." onClose={onClose}>
      <form onSubmit={enviar}>
        <Field label="Organização" required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Temporada" hint="Sem temporada, o resultado entra no histórico mas não pontua no ranking.">
          <select value={form.seasonId} onChange={evt => setForm({ ...form, seasonId: evt.target.value })}>
            <option value="">Sem temporada</option>
            {(temporadas.data?.items || []).map(temporada => <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>)}
          </select>
        </Field>
        <Field label="Arquivo" required hint="CSV ou JSON. Colunas reconhecidas: id, cpf, atleta, filiação, categoria, classe, colocação, pontos, evento, data.">
          <input type="file" accept=".csv,.json,text/csv,application/json" onChange={lerArquivo} required />
        </Field>
        {form.content && (
          <div className="alert alert-info" style={{ marginBottom: 12 }}>
            <div><strong>{form.sourceRef}</strong><p>{form.sourceType} · {form.content.length.toLocaleString('pt-BR')} caracteres lidos.</p></div>
          </div>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Pré-visualizar" disabled={!form.content} />
      </form>
    </Modal>
  );
}

function RevisarImportacao({ importId, notificar, onClose, onMudou }) {
  const estado = useFetch(() => api.muscleWar.preview(importId), [importId]);
  const [vinculando, setVinculando] = useState(null);
  const [aplicando, setAplicando] = useState(false);

  const aplicar = async () => {
    try {
      const resposta = await api.muscleWar.apply(importId);
      notificar(`Importação aplicada: ${resposta.applied} resultado(s). ${resposta.skippedAsDuplicate ? `${resposta.skippedAsDuplicate} ignorado(s) por duplicidade.` : ''}`);
      refreshData();
      estado.reload();
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <Modal title="Revisar importação" description="Confira os totais antes de aplicar. Linhas pendentes podem ser vinculadas manualmente." wide onClose={onClose}>
      <AsyncSection state={estado} linhas={4}>
        {dados => (
          <>
            <div className="import-summary">
              <Metric label="Registros" value={dados.summary.totalRecords} />
              <Metric label="Reconhecidos" value={dados.summary.recognized} destaque />
              <Metric label="Pendentes" value={dados.summary.pending} />
              <Metric label="Conflitos" value={dados.summary.conflicts} />
              <Metric label="Duplicados" value={dados.summary.duplicates} />
              <Metric label="Rejeitados" value={dados.summary.rejected} />
              <Metric label="Aplicados" value={dados.summary.applied} />
            </div>

            {(dados.summary.pending > 0 || dados.summary.conflicts > 0) && (
              <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
                <AlertTriangle size={16} />
                <div>
                  <strong>Há registros que exigem revisão</strong>
                  <p>Aplicar agora vai trazer apenas os {dados.summary.valid} reconhecidos. Nenhum atleta é criado automaticamente.</p>
                </div>
              </div>
            )}

            <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th>#</th><th>CPF</th><th>Atleta</th><th>Filiação</th><th>Categoria</th><th className="num">Col.</th><th className="num">Pts</th><th>Situação</th><th /></tr></thead>
                <tbody>
                  {dados.items.map(item => {
                    const info = ESTADO_MATCH[item.matchStatus] || { rotulo: item.matchStatus, tom: 'neutro' };
                    return (
                      <tr key={item.id}>
                        <td className="num">{item.rowNumber}</td>
                        <td className="num">{item.cpf || '—'}</td>
                        <td>{item.athlete?.fullName || item.athleteName || '—'}</td>
                        <td>{item.affiliationCode || '—'}</td>
                        <td>{item.categoryCode || '—'}</td>
                        <td className="num">{item.placing ?? '—'}</td>
                        <td className="num">{item.points ?? '—'}</td>
                        <td>
                          <Badge tom={info.tom}>{info.rotulo}</Badge>
                          {item.reason && <small style={{ display: 'block', color: 'var(--cinza-fraco)', marginTop: 3 }}>{item.reason}</small>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {['MATCH_PENDING', 'CONFLICT'].includes(item.matchStatus) && dados.import.status !== 'APPLIED' && (
                            <button type="button" className="button button-secondary button-sm" onClick={() => setVinculando(item)}>Vincular</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={onClose}>Fechar</button>
              {dados.import.status !== 'REJECTED' && (
                <button type="button" className="button button-primary" onClick={() => setAplicando(true)} disabled={!dados.summary.valid}>
                  Aplicar {dados.summary.valid} resultado(s)
                </button>
              )}
            </div>

            {aplicando && (
              <ConfirmDialog
                title="Aplicar importação"
                message={`Serão aplicados ${dados.summary.valid} resultado(s) reconhecido(s). Resultados já importados não pontuam de novo.`}
                confirmLabel="Aplicar"
                onConfirm={aplicar}
                onClose={() => setAplicando(false)}
              />
            )}

            {vinculando && (
              <VincularAtleta
                item={vinculando}
                organizationId={dados.import.organizationId}
                notificar={notificar}
                onClose={() => setVinculando(null)}
                onSalvo={() => { setVinculando(null); estado.reload(); onMudou(); }}
              />
            )}
          </>
        )}
      </AsyncSection>
    </Modal>
  );
}

function VincularAtleta({ item, organizationId, notificar, onClose, onSalvo }) {
  const [busca, setBusca] = useState(item.athleteName || '');
  const [athleteId, setAthleteId] = useState('');
  const [salvando, setSalvando] = useState(false);
  const resultados = useFetch(() => api.athletes.list({ organizationId, search: busca || undefined, limit: 20 }), [busca, organizationId]);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.muscleWar.link(item.id, { athleteId });
      notificar('Registro vinculado ao atleta.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title="Vincular ao atleta"
      description={`Linha ${item.rowNumber} · CPF da origem: ${item.cpf || 'não informado'} · ${item.reason || ''}`}
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        <Field label="Buscar atleta">
          <input value={busca} onChange={evt => setBusca(evt.target.value)} placeholder="Nome ou nome esportivo…" />
        </Field>

        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--linha)', borderRadius: 4 }}>
          {(resultados.data?.items || []).map(atleta => (
            <label key={atleta.id} className="list-row" style={{ padding: '10px 12px', margin: 0, cursor: 'pointer' }}>
              <input type="radio" name="atleta" value={atleta.id} checked={athleteId === atleta.id} onChange={() => setAthleteId(atleta.id)} style={{ width: 'auto' }} />
              <Avatar name={atleta.fullName} size="avatar-sm" />
              <span className="info">
                <strong>{atleta.fullName}</strong>
                <small>{atleta.cpfMasked || '—'} · {atleta.affiliation?.code || 'sem filiação'}</small>
              </span>
            </label>
          ))}
          {!(resultados.data?.items || []).length && <p style={{ padding: 14, fontSize: 12, color: 'var(--cinza-fraco)' }}>Nenhum atleta encontrado.</p>}
        </div>

        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Vincular" disabled={!athleteId} />
      </form>
    </Modal>
  );
}

// ============================================================== AUDITORIA
export function AdminAuditoria() {
  const [filtros, setFiltros] = useState({ entity: '', action: '' });
  const estado = useFetch(() => api.audit({ entity: filtros.entity || undefined, action: filtros.action || undefined, limit: 200 }), [filtros.entity, filtros.action]);

  return (
    <div className="page">
      <PageHead eyebrow="Segurança" title="Auditoria" description="Trilha das ações críticas: quem fez, o quê, quando e sobre qual registro." />

      <div className="toolbar">
        <input
          className="select-control"
          value={filtros.entity}
          onChange={evento => setFiltros({ ...filtros, entity: evento.target.value })}
          placeholder="Entidade (ex: Result)"
          aria-label="Filtrar por entidade"
        />
        <input
          className="select-control"
          value={filtros.action}
          onChange={evento => setFiltros({ ...filtros, action: evento.target.value })}
          placeholder="Ação (ex: RESULT_PUBLICATION)"
          aria-label="Filtrar por ação"
        />
      </div>

      <AsyncSection state={estado} linhas={6}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Quando</th><th>Ator</th><th>Ação</th><th>Entidade</th><th>Detalhe</th></tr></thead>
                <tbody>
                  {dados.items.map(linha => (
                    <tr key={linha.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatarDataHora(linha.createdAt)}</td>
                      <td>
                        {linha.user?.name || linha.userEmail || 'sistema'}
                        {linha.user?.role && <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{linha.user.role}</small>}
                      </td>
                      <td><Badge tom="info">{linha.action}</Badge></td>
                      <td>{linha.entity}{linha.entityId ? <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{linha.entityId.slice(0, 12)}…</small> : null}</td>
                      <td style={{ maxWidth: 320 }}>
                        <code style={{ fontSize: 11, color: 'var(--cinza)', wordBreak: 'break-all' }}>
                          {linha.metadata ? JSON.stringify(linha.metadata).slice(0, 200) : '—'}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title="Sem registros" description="Nenhuma ação corresponde ao filtro." />
        )}
      </AsyncSection>
    </div>
  );
}

// =========================================================== CONFIGURAÇÕES
export function AdminConfiguracoes({ notificar }) {
  const [aba, setAba] = useState('organizacoes');

  return (
    <div className="page">
      <PageHead eyebrow="Administração" title="Configurações" description="Organizações, filiações, catálogo de categorias, parceiros e usuários." />

      <div className="chips" style={{ marginBottom: 18 }}>
        {[['organizacoes', 'Organizações'], ['filiacoes', 'Filiações'], ['categorias', 'Categorias'], ['parceiros', 'Parceiros'], ['usuarios', 'Usuários']].map(([chave, rotulo]) => (
          <button key={chave} type="button" className={`chip${aba === chave ? ' is-on' : ''}`} onClick={() => setAba(chave)}>{rotulo}</button>
        ))}
      </div>

      {aba === 'organizacoes' && <Organizacoes notificar={notificar} />}
      {aba === 'filiacoes' && <Filiacoes notificar={notificar} />}
      {aba === 'categorias' && <Categorias notificar={notificar} />}
      {aba === 'parceiros' && <Parceiros notificar={notificar} />}
      {aba === 'usuarios' && <Usuarios notificar={notificar} />}
    </div>
  );
}

function Organizacoes({ notificar }) {
  const estado = useFetch(() => api.organizations.list(), []);
  const [criando, setCriando] = useState(false);
  const [gerindo, setGerindo] = useState(null);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Organizações</h2>
          <button type="button" className="button button-primary button-sm" onClick={() => setCriando(true)}><Plus size={13} /> Nova</button>
        </div>
        <AsyncSection state={estado} linhas={3}>
          {dados => (dados.items.length
            ? dados.items.map(organizacao => (
              <div className="list-row" key={organizacao.id}>
                <span className="avatar"><Building2 size={15} /></span>
                <span className="info">
                  <strong>{organizacao.name}</strong>
                  <small>{organizacao.slug} · {organizacao._count.members} membro(s) · {organizacao._count.athletes} atleta(s) · {organizacao._count.events} evento(s)</small>
                </span>
                <button type="button" className="button button-secondary button-sm" onClick={() => setGerindo(organizacao)}>Membros</button>
              </div>
            ))
            : <EmptyState title="Nenhuma organização" description="Crie a organização que vai operar os campeonatos." />
          )}
        </AsyncSection>
      </section>

      {criando && <NovaOrganizacao notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
      {gerindo && <MembrosDaOrganizacao organizacao={gerindo} notificar={notificar} onClose={() => setGerindo(null)} />}
    </>
  );
}

function NovaOrganizacao({ notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ name: '', slug: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.organizations.create(form);
      notificar('Organização criada. Você entrou como administrador dela.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova organização" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={140} /></Field>
        <Field label="Identificador" required><input value={form.slug} onChange={evt => setForm({ ...form, slug: evt.target.value.toLowerCase() })} required pattern="[a-z0-9-]{2,60}" /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar" />
      </form>
    </Modal>
  );
}

const PAPEIS = [
  'ADMIN', 'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'JUDGE_COORDINATOR', 'JUDGE', 'STAFF',
  'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR', 'RESULTS_OPERATOR',
  'RANKING_MANAGER', 'SOCIAL_ADMIN', 'MODERATOR', 'ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'MEDIA'
];

function MembrosDaOrganizacao({ organizacao, notificar, onClose }) {
  const estado = useFetch(() => api.organizations.findById(organizacao.id), [organizacao.id]);
  const usuarios = useFetch(() => api.admin.users({ limit: 100 }), []);
  const [form, setForm] = useState({ userId: '', role: 'EVENT_DIRECTOR' });
  const [salvando, setSalvando] = useState(false);

  const adicionar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.organizations.addMember(organizacao.id, form);
      notificar('Papel concedido nesta organização.');
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  const remover = async membership => {
    try {
      await api.organizations.removeMember(organizacao.id, membership.id);
      notificar('Vínculo removido.');
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <Modal title={`Membros — ${organizacao.name}`} description="O papel vale apenas dentro desta organização." wide onClose={onClose}>
      <form onSubmit={adicionar} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 8, alignItems: 'end', marginBottom: 16 }}>
        <Field label="Usuário" required>
          <select value={form.userId} onChange={evt => setForm({ ...form, userId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {(usuarios.data?.items || []).map(usuario => <option key={usuario.id} value={usuario.id}>{usuario.name} — {usuario.email}</option>)}
          </select>
        </Field>
        <Field label="Papel" required>
          <select value={form.role} onChange={evt => setForm({ ...form, role: evt.target.value })} required>
            {PAPEIS.map(papel => <option key={papel} value={papel}>{papel}</option>)}
          </select>
        </Field>
        <button type="submit" className="button button-primary" disabled={salvando} style={{ marginBottom: 13 }}>Conceder</button>
      </form>

      <AsyncSection state={estado} linhas={3}>
        {dados => dados.members.map(membro => (
          <div className="list-row" key={membro.id}>
            <Avatar name={membro.user.name} size="avatar-sm" />
            <span className="info">
              <strong>{membro.user.name}</strong>
              <small>{membro.user.email}</small>
            </span>
            <Badge tom="info">{membro.role}</Badge>
            <button type="button" className="button button-danger button-sm" onClick={() => remover(membro)}>Remover</button>
          </div>
        ))}
      </AsyncSection>

      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}

function Filiacoes({ notificar }) {
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [organizationId, setOrganizationId] = useState('');
  const estado = useFetch(() => api.affiliations.list({ organizationId: organizationId || undefined }), [organizationId]);
  const [criando, setCriando] = useState(false);

  return (
    <>
      <div className="toolbar">
        <select className="select-control" value={organizationId} onChange={evento => setOrganizationId(evento.target.value)} aria-label="Organização">
          <option value="">Todas as organizações</option>
          {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
        </select>
        <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={14} /> Nova filiação</button>
      </div>

      <section className="panel">
        <AsyncSection state={estado} linhas={3}>
          {dados => (dados.items.length
            ? dados.items.map(filiacao => (
              <div className="list-row" key={filiacao.id}>
                <span className="info">
                  <strong>{filiacao.name}</strong>
                  <small>{filiacao.code} · {filiacao.kind} · {filiacao._count.athletes} atleta(s)</small>
                </span>
                <Badge tom={filiacao.active ? 'ok' : 'neutro'}>{filiacao.active ? 'Ativa' : 'Inativa'}</Badge>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={async () => {
                    try {
                      if (filiacao.active) await api.affiliations.deactivate(filiacao.id);
                      else await api.affiliations.activate(filiacao.id);
                      estado.reload();
                    } catch (erro) { notificar(erro.message, 'erro'); }
                  }}
                >
                  {filiacao.active ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            ))
            : <EmptyState title="Nenhuma filiação" description="A filiação é o vínculo esportivo do atleta e chave de conferência na importação MuscleWar." />
          )}
        </AsyncSection>
      </section>

      {criando && <NovaFiliacao organizacoes={organizacoes.data?.items || []} notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
    </>
  );
}

function NovaFiliacao({ organizacoes, notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ organizationId: '', name: '', code: '', kind: 'FEDERATION', state: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.affiliations.create({ ...form, state: form.state || null });
      notificar('Filiação criada.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova filiação" description="Federação, entidade, associação ou vínculo esportivo responsável pelo atleta." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Organização" required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {organizacoes.map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={140} /></Field>
        <div className="field-row">
          <Field label="Código" required hint="Usado no matching MuscleWar."><input value={form.code} onChange={evt => setForm({ ...form, code: evt.target.value.toUpperCase() })} required pattern="[A-Z0-9-]{2,30}" placeholder="FED-MT" /></Field>
          <Field label="UF"><input value={form.state} onChange={evt => setForm({ ...form, state: evt.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
        </div>
        <Field label="Tipo">
          <select value={form.kind} onChange={evt => setForm({ ...form, kind: evt.target.value })}>
            {['FEDERATION', 'ENTITY', 'ASSOCIATION', 'TEAM', 'OTHER'].map(tipo => <option key={tipo} value={tipo}>{tipo}</option>)}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar filiação" />
      </form>
    </Modal>
  );
}

function Categorias({ notificar }) {
  const estado = useFetch(() => api.categories.list(), []);
  const [criando, setCriando] = useState(false);

  return (
    <>
      <div className="toolbar">
        <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={14} /> Nova categoria</button>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Catálogo oficial</h2></div>
        <AsyncSection state={estado} linhas={4}>
          {dados => dados.items.map(categoria => (
            <div className="list-row" key={categoria.id}>
              <span className="info">
                <strong>{categoria.name}</strong>
                <small>{categoria.code}</small>
              </span>
              <Badge tom={categoria.sex === 'MALE' ? 'info' : 'perigo'}>{categoria.sex === 'MALE' ? 'Masculina' : 'Feminina'}</Badge>
            </div>
          ))}
        </AsyncSection>
      </section>

      {criando && <NovaCategoria notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
    </>
  );
}

function NovaCategoria({ notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ code: '', name: '', sex: 'FEMALE' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.categories.create(form);
      notificar('Categoria adicionada ao catálogo.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Nova categoria" description="O catálogo é extensível: categorias novas entram por aqui, sem alteração de código." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Código" required><input value={form.code} onChange={evt => setForm({ ...form, code: evt.target.value.toUpperCase() })} required pattern="[A-Z0-9_]{2,40}" /></Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} /></Field>
        <Field label="Sexo" required>
          <select value={form.sex} onChange={evt => setForm({ ...form, sex: evt.target.value })} required>
            <option value="FEMALE">Feminino</option>
            <option value="MALE">Masculino</option>
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Adicionar" />
      </form>
    </Modal>
  );
}

function Parceiros({ notificar }) {
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [organizationId, setOrganizationId] = useState('');
  const equipes = useFetch(() => api.partners.teams({ organizationId: organizationId || undefined }), [organizationId]);
  const academias = useFetch(() => api.partners.gyms({ organizationId: organizationId || undefined }), [organizationId]);
  const marcas = useFetch(() => api.partners.brands({ organizationId: organizationId || undefined }), [organizationId]);
  const patrocinadores = useFetch(() => api.partners.sponsors({ organizationId: organizationId || undefined }), [organizationId]);
  const [criando, setCriando] = useState(null);

  const secoes = [
    { chave: 'team', titulo: 'Equipes', estado: equipes },
    { chave: 'gym', titulo: 'Academias', estado: academias },
    { chave: 'brand', titulo: 'Marcas', estado: marcas },
    { chave: 'sponsor', titulo: 'Patrocinadores', estado: patrocinadores }
  ];

  return (
    <>
      <div className="toolbar">
        <select className="select-control" value={organizationId} onChange={evento => setOrganizationId(evento.target.value)} aria-label="Organização">
          <option value="">Todas as organizações</option>
          {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
        </select>
      </div>

      <div className="grid grid-2">
        {secoes.map(secao => (
          <section className="panel" key={secao.chave}>
            <div className="panel-head">
              <h2>{secao.titulo}</h2>
              <button type="button" className="button button-secondary button-sm" onClick={() => setCriando(secao.chave)}><Plus size={13} /></button>
            </div>
            <AsyncSection state={secao.estado} linhas={2}>
              {dados => (dados.items.length
                ? dados.items.map(item => (
                  <div className="list-row" key={item.id}>
                    <span className="info">
                      <strong>{item.name}</strong>
                      <small>{item.city ? `${item.city}${item.state ? `/${item.state}` : ''}` : item.slug || item.brand?.name || '—'}</small>
                    </span>
                  </div>
                ))
                : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Nenhum registro.</p>
              )}
            </AsyncSection>
          </section>
        ))}
      </div>

      {criando && (
        <NovoParceiro
          tipo={criando}
          organizacoes={organizacoes.data?.items || []}
          notificar={notificar}
          onClose={() => setCriando(null)}
          onSalvo={() => {
            setCriando(null);
            equipes.reload(); academias.reload(); marcas.reload(); patrocinadores.reload();
          }}
        />
      )}
    </>
  );
}

function NovoParceiro({ tipo, organizacoes, notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ organizationId: '', name: '', slug: '', city: '', state: '' });
  const [salvando, setSalvando] = useState(false);

  const titulos = { team: 'Nova equipe', gym: 'Nova academia', brand: 'Nova marca', sponsor: 'Novo patrocinador' };

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const base = { organizationId: form.organizationId, name: form.name };
      if (tipo === 'team') await api.partners.createTeam({ ...base, city: form.city || null, state: form.state || null });
      if (tipo === 'gym') await api.partners.createGym({ ...base, city: form.city || null, state: form.state || null });
      if (tipo === 'brand') await api.partners.createBrand({ ...base, slug: form.slug });
      if (tipo === 'sponsor') await api.partners.createSponsor(base);
      notificar('Registro criado.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={titulos[tipo]} description={tipo === 'sponsor' || tipo === 'brand' ? 'Relação esportiva e institucional. Nenhum valor financeiro é armazenado.' : undefined} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Organização" required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">Selecione…</option>
            {organizacoes.map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={120} /></Field>
        {tipo === 'brand' && (
          <Field label="Identificador" required hint="Também vira o identificador do perfil social da marca.">
            <input value={form.slug} onChange={evt => setForm({ ...form, slug: evt.target.value.toLowerCase() })} required pattern="[a-z0-9-]{2,60}" />
          </Field>
        )}
        {(tipo === 'team' || tipo === 'gym') && (
          <div className="field-row">
            <Field label="Cidade"><input value={form.city} onChange={evt => setForm({ ...form, city: evt.target.value })} maxLength={90} /></Field>
            <Field label="UF"><input value={form.state} onChange={evt => setForm({ ...form, state: evt.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
          </div>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Criar" />
      </form>
    </Modal>
  );
}

function Usuarios({ notificar }) {
  const [busca, setBusca] = useState('');
  const estado = useFetch(() => api.admin.users({ limit: 60, search: busca || undefined }), [busca]);
  const [editando, setEditando] = useState(null);

  return (
    <>
      <div className="toolbar">
        <label className="search-box">
          <Users size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Buscar por nome ou email…" aria-label="Buscar usuário" />
        </label>
      </div>

      <section className="panel">
        <AsyncSection state={estado} linhas={4}>
          {dados => dados.items.map(usuario => (
            <div className="list-row" key={usuario.id}>
              <Avatar name={usuario.name} size="avatar-sm" />
              <span className="info">
                <strong>{usuario.name}</strong>
                <small>{usuario.email} · {usuario.organizations.length} vínculo(s)</small>
              </span>
              <Badge tom="info">{usuario.role}</Badge>
              <Badge tom={usuario.status === 'ACTIVE' ? 'ok' : 'perigo'}>{usuario.status}</Badge>
              <button type="button" className="button button-secondary button-sm" onClick={() => setEditando(usuario)}>Editar</button>
            </div>
          ))}
        </AsyncSection>
      </section>

      {editando && <EditarUsuario usuario={editando} notificar={notificar} onClose={() => setEditando(null)} onSalvo={() => { setEditando(null); estado.reload(); }} />}
    </>
  );
}

function EditarUsuario({ usuario, notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ role: usuario.role, status: usuario.status });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.admin.updateUser(usuario.id, form);
      notificar('Usuário atualizado.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={usuario.name} description="Papel global e situação da conta. Papéis por organização ficam em Organizações → Membros." onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Papel global" hint="Papel privilegiado só é concedido por SUPER_ADMIN.">
          <select value={form.role} onChange={evt => setForm({ ...form, role: evt.target.value })}>
            {PAPEIS.map(papel => <option key={papel} value={papel}>{papel}</option>)}
          </select>
        </Field>
        <Field label="Situação">
          <select value={form.status} onChange={evt => setForm({ ...form, status: evt.target.value })}>
            <option value="ACTIVE">Ativa</option>
            <option value="SUSPENDED">Suspensa</option>
            <option value="DISABLED">Desativada</option>
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} />
      </form>
    </Modal>
  );
}

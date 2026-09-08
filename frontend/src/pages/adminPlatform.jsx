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
              <Metric label="Resultados publicados" value={dados.publishedResults} />
              <Metric label="Importações MuscleWar" value={dados.muscleWarImports} />
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
  const [conferindo, setConferindo] = useState(null);
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
                  <button type="button" className="button button-secondary button-sm" onClick={() => setConferindo(temporada)}>Conferir pontuação</button>
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
      {conferindo && <ConferirPontuacao temporada={conferindo} onClose={() => setConferindo(null)} />}
    </div>
  );
}

// ================================================= CONFERÊNCIA DA PONTUAÇÃO
// Os dois números que a regra manda NÃO confundir, lado a lado e nomeados:
//
//   Pontos do Campeonato            → toda classe pontua
//   Pontos elegíveis ao Super Overall → só as classes elegíveis (a OPEN)
//
// Mostrá-los na mesma tela, em colunas separadas, é o que impede o operador de
// ler um número achando que é o outro — e deixa visível quem pontuou no
// campeonato sem alimentar o anual.
function ConferirPontuacao({ temporada, onClose }) {
  const campeonato = useFetch(() => api.ranking.list({ seasonId: temporada.id }), [temporada.id]);
  const anual = useFetch(() => api.ranking.superOverall({ seasonId: temporada.id }), [temporada.id]);
  const [detalhando, setDetalhando] = useState(null);

  const doAnual = new Map((anual.data || []).map(linha => [linha.athlete?.id, linha.totalPoints]));

  return (
    <Modal
      title="Conferir pontuação"
      description={`${temporada.name} · o ranking do campeonato e o classificatório do Super Overall são métricas diferentes.`}
      wide
      onClose={onClose}
    >
      <AsyncSection state={campeonato} linhas={4}>
        {dados => (dados.items.length
          ? (
            <>
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                <div>
                  <strong>Duas métricas, não uma</strong>
                  <p>
                    Todas as classes pontuam no campeonato. Somente as classes elegíveis —
                    pela regra homologada, a OPEN — alimentam o Super Overall anual.
                  </p>
                </div>
              </div>

              <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Atleta</th>
                      <th className="num">Pontos do Campeonato</th>
                      <th className="num">Elegíveis ao Super Overall</th>
                      <th className="num">Overall</th>
                      <th className="num">1º</th>
                      <th className="num">2º</th>
                      <th className="num">3º</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.items.map(linha => {
                      const elegiveis = doAnual.get(linha.athlete?.id) ?? 0;
                      return (
                        <tr key={linha.athlete?.id || linha.position}>
                          <td className="num">{linha.position ?? '—'}</td>
                          <td>
                            {/* "Por que este atleta tem 15 pontos?" — a resposta
                                está a um clique, e não só na API. */}
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setDetalhando(linha.athlete)}
                              title="Ver a origem de cada ponto"
                            >
                              {linha.athlete?.fullName || '—'}
                            </button>
                            {linha.tieUnresolved && <Badge tom="alerta">empate não resolvido</Badge>}
                          </td>
                          <td className="num"><strong>{linha.totalPoints}</strong></td>
                          <td className="num">
                            {elegiveis > 0
                              ? <strong>{elegiveis}</strong>
                              : <span style={{ color: 'var(--cinza-fraco)' }}>0</span>}
                          </td>
                          <td className="num">{linha.overallWins ?? 0}</td>
                          <td className="num">{linha.firstPlaceCount ?? 0}</td>
                          <td className="num">{linha.secondPlaceCount ?? 0}</td>
                          <td className="num">{linha.thirdPlaceCount ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p style={{ fontSize: 11, color: 'var(--cinza-fraco)', marginTop: 10 }}>
                Desempate oficial, nesta ordem: Overall → 1º → 2º → 3º. Persistindo o empate,
                ninguém recebe a colocação — 4º e 5º pontuam, mas não desempatam.
                Clique no nome para ver de onde veio cada ponto.
              </p>
            </>
          )
          : <EmptyState title="Nenhuma pontuação" description="Publique resultados para que a temporada pontue." />
        )}
      </AsyncSection>

      {detalhando && (
        <OrigemDosPontos atleta={detalhando} temporada={temporada} onClose={() => setDetalhando(null)} />
      )}
    </Modal>
  );
}

// ===================================================== ORIGEM DE CADA PONTO
// A pergunta que a auditoria precisa responder: "por que este atleta tem 15
// pontos?". A resposta é a linha inteira — evento, classe, colocação, e as
// PARCELAS separadas, porque o total tem de ser reconstituível a partir delas
// e não apenas conferido no agregado.
function OrigemDosPontos({ atleta, temporada, onClose }) {
  const estado = useFetch(
    () => api.ranking.athletePoints(atleta.id, { seasonId: temporada.id }),
    [atleta.id, temporada.id]
  );

  return (
    <Modal
      title={`Origem dos pontos — ${atleta.fullName}`}
      description={`${temporada.name} · cada linha aponta para o resultado ou a importação que a gerou.`}
      wide
      onClose={onClose}
    >
      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? (
            <>
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Evento</th>
                      <th>Categoria</th>
                      <th>Classe</th>
                      <th className="num">Col.</th>
                      <th className="num">Pts colocação</th>
                      <th className="num">Bônus Overall</th>
                      <th className="num">Campeonato</th>
                      <th className="num">Super Overall</th>
                      <th>Origem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.items.map(ponto => (
                      <tr key={ponto.id}>
                        <td>{ponto.event?.name || ponto.externalResult?.eventName || '—'}</td>
                        <td>{ponto.category?.name || '—'}</td>
                        <td>
                          {ponto.competitionClass?.code || ponto.competitionClass?.name || '—'}
                          {!ponto.superOverallEligible && (
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontSize: 10 }}>
                              não elegível
                            </small>
                          )}
                        </td>
                        <td className="num">{ponto.placing ?? '—'}</td>
                        <td className="num">{ponto.placementPoints}</td>
                        <td className="num">
                          {ponto.overallBonus > 0
                            ? <strong>+{ponto.overallBonus}</strong>
                            : <span style={{ color: 'var(--cinza-fraco)' }}>0</span>}
                        </td>
                        <td className="num"><strong>{ponto.points}</strong></td>
                        <td className="num">
                          {ponto.superOverallPoints > 0
                            ? <strong>{ponto.superOverallPoints}</strong>
                            : <span style={{ color: 'var(--cinza-fraco)' }}>0</span>}
                        </td>
                        <td>
                          <Badge tom={ponto.source === 'EVENT' ? 'ok' : 'info'}>
                            {ponto.source === 'EVENT' ? 'evento' : 'importação'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'right' }}><strong>Totais</strong></td>
                      <td className="num">
                        <strong>{dados.items.reduce((soma, p) => soma + p.points, 0)}</strong>
                      </td>
                      <td className="num">
                        <strong>{dados.items.reduce((soma, p) => soma + p.superOverallPoints, 0)}</strong>
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <p style={{ fontSize: 11, color: 'var(--cinza-fraco)', marginTop: 10 }}>
                Pontos da colocação + bônus Overall = pontos do campeonato. Os pontos elegíveis
                ao Super Overall só existem onde a classe é elegível — o bônus segue a
                elegibilidade da participação que o originou.
              </p>
            </>
          )
          : <EmptyState title="Sem pontos nesta temporada" description="Nenhum resultado publicado ou importado gerou pontuação." />
        )}
      </AsyncSection>
    </Modal>
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
  // A tabela vigente da temporada, e NUNCA valores sugeridos aqui. O formulário
  // trazia 100/80/60/50/40/30 pré-preenchidos — números que não são de
  // regulamento nenhum: bastava abrir e salvar para substituir a tabela
  // homologada (5/4/3/2/1) por eles. Pontuação é dado do regulamento, e o
  // frontend não é lugar de guardá-la.
  const [regras, setRegras] = useState(
    (temporada.pointsRules || []).map(regra => ({ placing: regra.placing, points: regra.points }))
  );
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
        {!regras.length && (
          <div className="alert alert-alerta" style={{ marginBottom: 12 }}>
            <AlertTriangle size={15} />
            <div>
              <strong>Esta temporada não tem tabela de pontos</strong>
              <p>Nada pontua até que ela seja cadastrada. Informe a tabela do regulamento.</p>
            </div>
          </div>
        )}
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
                <thead>
                  <tr>
                    <th>#</th><th>CPF</th><th>Atleta</th><th>Filiação</th><th>Categoria</th>
                    {/* A classe é o que decide se o resultado alimenta o Super
                        Overall — sem ela na tela o operador não consegue
                        conferir a elegibilidade. */}
                    <th>Classe</th>
                    <th className="num">Col.</th>
                    <th className="num">Pts arquivo</th>
                    <th>Situação</th><th />
                  </tr>
                </thead>
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
                        <td>
                          {item.className || '—'}
                          {item.isOverallChampion && <Badge tom="ok">Overall</Badge>}
                        </td>
                        <td className="num">{item.placing ?? '—'}</td>
                        <td className="num">{item.points ?? '—'}</td>
                        <td>
                          <Badge tom={info.tom}>{info.rotulo}</Badge>
                          {item.reason && <small style={{ display: 'block', color: 'var(--cinza-fraco)', marginTop: 3 }}>{item.reason}</small>}
                          {/* Divergência de pontuação: os três números lado a
                              lado, para o operador decidir o que corrigir — o
                              arquivo ou a tabela da temporada. */}
                          {item.pointsMismatch && (
                            <small style={{ display: 'block', marginTop: 4 }}>
                              <span>arquivo <strong>{item.pointsMismatch.importedPoints}</strong></span>
                              {' · '}
                              <span>regra oficial <strong>{item.pointsMismatch.calculatedPoints}</strong></span>
                              {' · '}
                              <span>diferença <strong>
                                {item.pointsMismatch.difference > 0 ? '+' : ''}{item.pointsMismatch.difference}
                              </strong></span>
                            </small>
                          )}
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
        {[['organizacoes', 'Organizações'], ['filiacoes', 'Filiações'], ['categorias', 'Categorias'], ['parceiros', 'Parceiros'], ['vinculos', 'Vínculo de equipe'], ['usuarios', 'Usuários']].map(([chave, rotulo]) => (
          <button key={chave} type="button" className={`chip${aba === chave ? ' is-on' : ''}`} onClick={() => setAba(chave)}>{rotulo}</button>
        ))}
      </div>

      {aba === 'organizacoes' && <Organizacoes notificar={notificar} />}
      {aba === 'filiacoes' && <Filiacoes notificar={notificar} />}
      {aba === 'categorias' && <Categorias notificar={notificar} />}
      {aba === 'parceiros' && <Parceiros notificar={notificar} />}
      {aba === 'vinculos' && <VinculoDeEquipe notificar={notificar} />}
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
  const empresas = useFetch(() => api.partners.companies({ organizationId: organizationId || undefined }), [organizationId]);
  const equipes = useFetch(() => api.partners.teams({ organizationId: organizationId || undefined }), [organizationId]);
  const academias = useFetch(() => api.partners.gyms({ organizationId: organizationId || undefined }), [organizationId]);
  const marcas = useFetch(() => api.partners.brands({ organizationId: organizationId || undefined }), [organizationId]);
  const patrocinadores = useFetch(() => api.partners.sponsors({ organizationId: organizationId || undefined }), [organizationId]);
  const [criando, setCriando] = useState(null);

  const secoes = [
    // Empresa vem antes da equipe porque é o que ela é no domínio: a empresa
    // se cadastra e entra na competição COM as suas equipes.
    { chave: 'company', titulo: 'Empresas', estado: empresas },
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
          empresas={empresas.data?.items || []}
          notificar={notificar}
          onClose={() => setCriando(null)}
          onSalvo={() => {
            setCriando(null);
            empresas.reload(); equipes.reload(); academias.reload(); marcas.reload(); patrocinadores.reload();
          }}
        />
      )}
    </>
  );
}

function NovoParceiro({ tipo, organizacoes, empresas = [], notificar, onClose, onSalvo }) {
  const [form, setForm] = useState({ organizationId: '', name: '', slug: '', city: '', state: '', companyId: '' });
  const [salvando, setSalvando] = useState(false);

  const titulos = {
    company: 'Nova empresa', team: 'Nova equipe', gym: 'Nova academia',
    brand: 'Nova marca', sponsor: 'Novo patrocinador'
  };

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const base = { organizationId: form.organizationId, name: form.name };
      if (tipo === 'company') await api.partners.createCompany({ ...base, city: form.city || null, state: form.state || null });
      if (tipo === 'team') await api.partners.createTeam({ ...base, city: form.city || null, state: form.state || null, companyId: form.companyId || null });
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
    <Modal
      title={titulos[tipo]}
      description={
        tipo === 'sponsor' || tipo === 'brand'
          ? 'Relação COMERCIAL: não vincula atleta e não pontua. Nenhum valor financeiro é armazenado.'
          : tipo === 'company'
            ? 'Empresa competidora: entra no campeonato com as suas equipes e pontua pela mesma tabela.'
            : undefined
      }
      onClose={onClose}
    >
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
        {tipo === 'team' && (
          <Field label="Empresa" hint="Opcional. A equipe pode competir sozinha; vinculada, os pontos dos seus atletas também contam para a empresa.">
            <select value={form.companyId} onChange={evt => setForm({ ...form, companyId: evt.target.value })}>
              <option value="">Sem empresa</option>
              {empresas.map(empresa => <option key={empresa.id} value={empresa.id}>{empresa.name}</option>)}
            </select>
          </Field>
        )}
        {(tipo === 'company' || tipo === 'team' || tipo === 'gym') && (
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

// ==================================================== VÍNCULO DE EQUIPE
// A ponta de tela da trava antifraude. Ela NÃO é a trava: a recusa vem do
// backend e, no limite, do índice único do banco. O que a tela faz é mostrar o
// vínculo atual antes de qualquer ação e repetir, sem reescrever, a mensagem
// que o servidor devolveu — inclusive o nome da equipe atual.
function VinculoDeEquipe({ notificar }) {
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [organizationId, setOrganizationId] = useState('');
  const [busca, setBusca] = useState('');
  const [atleta, setAtleta] = useState(null);
  const [acao, setAcao] = useState(null);

  const resultados = useFetch(
    () => (organizationId ? api.athletes.list({ organizationId, search: busca || undefined, limit: 20 }) : Promise.resolve({ items: [] })),
    [busca, organizationId]
  );
  const historico = useFetch(
    () => (atleta ? api.athletes.teamHistory(atleta.id) : Promise.resolve({ items: [] })),
    [atleta?.id]
  );

  const linhas = historico.data?.items || [];
  const ativo = linhas.find(linha => !linha.endedAt) || null;

  return (
    <>
      <div className="toolbar">
        <select className="select-control" value={organizationId} onChange={evento => { setOrganizationId(evento.target.value); setAtleta(null); }} aria-label="Organização">
          <option value="">Selecione a organização…</option>
          {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
        </select>
        <input className="select-control" style={{ flex: "1 1 240px" }} value={busca} onChange={evento => setBusca(evento.target.value)} placeholder="Buscar atleta…" disabled={!organizationId} />
      </div>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head"><h2>Atletas</h2></div>
          {!organizationId
            ? <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Selecione a organização para buscar.</p>
            : (
              <AsyncSection state={resultados} linhas={3}>
                {dados => (dados.items.length
                  ? dados.items.map(item => (
                    <button
                      type="button" key={item.id} className="list-row"
                      style={{ width: '100%', textAlign: 'left', background: atleta?.id === item.id ? 'var(--linha)' : 'transparent', border: 0, cursor: 'pointer' }}
                      onClick={() => setAtleta(item)}
                    >
                      <Avatar name={item.fullName} size="avatar-sm" />
                      <span className="info">
                        <strong>{item.fullName}</strong>
                        <small>{item.team?.name || 'Sem equipe'}</small>
                      </span>
                    </button>
                  ))
                  : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Nenhum atleta encontrado.</p>
                )}
              </AsyncSection>
            )}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Vínculo</h2></div>
          {!atleta
            ? <EmptyState title="Nenhum atleta selecionado" description="Escolha um atleta para ver o vínculo atual e o histórico." />
            : (
              <>
                <div className="metric" style={{ marginBottom: 14 }}>
                  <span>Equipe atual</span>
                  <strong style={{ fontSize: 16 }}>{ativo?.team?.name || 'Sem equipe'}</strong>
                  {ativo?.team?.company?.name && <small>Empresa: {ativo.team.company.name}</small>}
                </div>

                <div className="chips" style={{ marginBottom: 16 }}>
                  {!ativo && <button type="button" className="button button-sm" onClick={() => setAcao('link')}>Vincular</button>}
                  {ativo && <button type="button" className="button button-sm" onClick={() => setAcao('transfer')}>Transferir</button>}
                  {ativo && <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('unlink')}>Encerrar vínculo</button>}
                </div>

                <p style={{ fontSize: 11, color: 'var(--cinza-fraco)', marginBottom: 12 }}>
                  Transferir e encerrar são atos do operador da Muscle Contest, exigem motivo e ficam na auditoria.
                  O vínculo anterior não é apagado.
                </p>

                <AsyncSection state={historico} linhas={2}>
                  {() => (linhas.length
                    ? linhas.map(linha => (
                      <div className="list-row" key={linha.id}>
                        <span className="info">
                          <strong>{linha.team?.name || '—'}</strong>
                          <small>
                            {formatarDataHora(linha.startedAt)} → {linha.endedAt ? formatarDataHora(linha.endedAt) : 'ativo'}
                            {linha.reason ? ` · ${linha.reason}` : ''}
                          </small>
                        </span>
                        {!linha.endedAt && <Badge tom="ok">ativo</Badge>}
                      </div>
                    ))
                    : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>Sem histórico de vínculo.</p>
                  )}
                </AsyncSection>
              </>
            )}
        </section>
      </div>

      {acao && atleta && (
        <AcaoDeVinculo
          acao={acao} atleta={atleta} organizationId={organizationId} atual={ativo}
          notificar={notificar}
          onClose={() => setAcao(null)}
          onSalvo={() => { setAcao(null); historico.reload(); resultados.reload(); }}
        />
      )}
    </>
  );
}

function AcaoDeVinculo({ acao, atleta, organizationId, atual, notificar, onClose, onSalvo }) {
  const [teamId, setTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);
  const equipes = useFetch(() => api.partners.teams({ organizationId }), [organizationId]);

  const titulos = { link: 'Vincular à equipe', transfer: 'Transferir de equipe', unlink: 'Encerrar vínculo' };
  const precisaEquipe = acao !== 'unlink';
  const precisaMotivo = acao !== 'link';

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      if (acao === 'link') await api.athletes.linkTeam(atleta.id, { teamId, reason: reason || null });
      if (acao === 'transfer') await api.athletes.transferTeam(atleta.id, { teamId, reason });
      if (acao === 'unlink') await api.athletes.unlinkTeam(atleta.id, { reason });
      notificar('Vínculo atualizado.');
      onSalvo();
    } catch (erro) {
      // A mensagem do servidor já nomeia a equipe atual e a quem recorrer.
      // Reescrevê-la aqui só apagaria a informação que o treinador precisa.
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={titulos[acao]}
      description={`${atleta.fullName}${atual?.team?.name ? ` · atualmente em ${atual.team.name}` : ' · sem equipe'}`}
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        {precisaEquipe && (
          <Field label="Equipe" required>
            <select value={teamId} onChange={evt => setTeamId(evt.target.value)} required>
              <option value="">Selecione…</option>
              {(equipes.data?.items || [])
                .filter(equipe => equipe.id !== atual?.teamId)
                .map(equipe => <option key={equipe.id} value={equipe.id}>{equipe.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Motivo" required={precisaMotivo} hint={precisaMotivo ? 'Fica registrado na auditoria junto com quem autorizou.' : undefined}>
          <input value={reason} onChange={evt => setReason(evt.target.value)} required={precisaMotivo} minLength={precisaMotivo ? 3 : 0} maxLength={200} />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Confirmar" disabled={precisaEquipe && !teamId} />
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

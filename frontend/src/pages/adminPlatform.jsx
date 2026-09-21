import { useState } from 'react';
import { AlertTriangle, Building2, CalendarDays, Download, Link2, Plus, Search, Trash2, Upload, Users } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useDebounce, useFetch, useListaPaginada } from '../lib/hooks';
import { useAuth } from '../AuthContext';
import { permissoesDe, podeCom } from '../lib/permissoes';
import { AsyncSection, AtualizadoEm, Avatar, Badge, ConfirmDialog, EmptyState, Field, Metric, Modal, ModalActions, PageHead, Paginacao } from '../components/ui';
// Só a classe de cartão clicável é usada aqui — é CSS, não precisa do motor
// em JS. Importar o que não se usa é ruído que o lint acusa e o leitor não.
import { criterioDeMatch, estadoDeMatch, formatarDataHora, ocultarCpf, papel, estadoDoUsuario, tipoDeFiliacao, estadoDaImportacao } from '../lib/format';
import { useIdioma } from '../lib/idioma';

// Painel administrativo, ranking, importação MuscleWar, auditoria e
// configurações da plataforma.

export function AdminPainel({ navegar }) {
  const { t } = useIdioma();
  // 30s: o painel é tela de acompanhamento, não de operação crítica. A
  // recarga é silenciosa, não consulta com a aba escondida e atualiza na hora
  // em que a aba volta para a frente. Escrita feita aqui dentro já atualiza na
  // hora pelo evento `mci-data-changed`; o intervalo existe para refletir o
  // que OUTRO operador mudou.
  const estado = useFetch(() => api.dashboard.admin(), [], { recarregarACada: 30000 });

  return (
    <div className="page">
      <PageHead eyebrow="Administração" title={t('plataforma.painel')} description={t('plataforma.painelDescricao')} />

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
              <Metric label={t('plataforma.eventosAtivos')} value={dados.events.active} hint={`${dados.events.total} no total`} destaque
                onClick={() => navegar('admin/eventos')} destino="Eventos" />
              <Metric label={t('publico.atletas')} value={dados.athletes.total} hint={`${dados.athletes.pro} PRO`}
                onClick={() => navegar('atletas')} destino="Atletas" />
              <Metric label="Inscrições" value={dados.registrations}
                onClick={() => navegar('admin/inscricoes')} destino="Inscrições" />
              <Metric label={t('plataforma.checkIns')} value={dados.checkIns}
                onClick={() => navegar('admin/checkin')} destino="Check-in" />
              <Metric label="Pesagens" value={dados.weighIns}
                onClick={() => navegar('admin/pesagem')} destino="Pesagem" />
              <Metric label={t('plataforma.baterias')} value={dados.batches}
                onClick={() => navegar('admin/palco')} destino="Palco" />
              <Metric label="Resultados publicados" value={dados.publishedResults}
                onClick={() => navegar('admin/resultados')} destino="Resultados" />
              <Metric label={t('plataforma.importacoes')} value={dados.muscleWarImports}
                onClick={() => navegar('admin/musclewar')} destino="MuscleWare" />
            </div>

            <AtualizadoEm quando={estado.atualizadoEm} />

            <div className="grid grid-3" style={{ marginTop: 18 }}>
              <button type="button" className="panel cartao-clicavel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/eventos')}>
                <h2 className="display" style={{ fontSize: 20 }}>{t('evento.eventos')}</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>{t('plataforma.criarEtapas')}</p>
              </button>
              <button type="button" className="panel cartao-clicavel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/musclewar')}>
                <h2 className="display" style={{ fontSize: 20 }}>{t('plataforma.muscleWare')}</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>
                  {dados.muscleWarImports} importação(ões) registrada(s).
                </p>
              </button>
              <button type="button" className="panel cartao-clicavel" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navegar('admin/auditoria')}>
                <h2 className="display" style={{ fontSize: 20 }}>{t('plataforma.auditoria')}</h2>
                <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '6px 0 0' }}>{t('plataforma.trilhaDasAcoes')}</p>
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
  const { t } = useIdioma();
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
        title={t('plataforma.rankingETemporadas')}
        description={t('plataforma.tabelaEDoRegulamento')}
        actions={<button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={15} />{t('plataforma.novaTemporada')}</button>}
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
                  <Badge tom={temporada.status === 'OPEN' ? 'ok' : 'neutro'}>{temporada.status === 'OPEN' ? t('plataforma.aberta') : t('plataforma.encerrada')}</Badge>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setPontuando(temporada)}>{t('plataforma.tabelaDePontos')}</button>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setConferindo(temporada)}>{t('plataforma.conferirPontuacao')}</button>
                  <button type="button" className="button button-secondary button-sm" onClick={() => recalcular(temporada)}>{t('plataforma.recalcular')}</button>
                </div>
              </div>
              {temporada._count.pointsRules === 0 && (
                <div className="alert alert-alerta">
                  <AlertTriangle size={15} />
                  <div><strong>{t('plataforma.semTabela')}</strong><p>{t('plataforma.semTabelaTexto')}</p></div>
                </div>
              )}
            </section>
          ))
          : <EmptyState title={t('plataforma.nenhumaTemporada')} description={t('plataforma.nenhumaTemporadaDescricao')} />
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
  const { t } = useIdioma();
  const campeonato = useFetch(() => api.ranking.list({ seasonId: temporada.id }), [temporada.id]);
  const anual = useFetch(() => api.ranking.superOverall({ seasonId: temporada.id }), [temporada.id]);
  const [detalhando, setDetalhando] = useState(null);

  const doAnual = new Map((anual.data || []).map(linha => [linha.athlete?.id, linha.totalPoints]));

  return (
    <Modal
      title={t('plataforma.conferirPontuacao')}
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
                  <strong>{t('plataforma.duasMetricas')}</strong>
                  <p>
                    Todas as classes pontuam no campeonato. Somente as classes elegíveis —
                    pela regra homologada, a OPEN — alimentam o Super Overall anual.
                  </p>
                </div>
              </div>

              <div className="table-wrap tabela-em-modal">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>{t('overall.atleta')}</th>
                      <th className="num">{t('plataforma.pontosDoCampeonato')}</th>
                      <th className="num">{t('plataforma.elegiveisAoSuperOverall')}</th>
                      <th className="num">{t('carreira.colunaOverall')}</th>
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
                              title={t('plataforma.verOrigem')}
                            >
                              {linha.athlete?.fullName || '—'}
                            </button>
                            {linha.tieUnresolved && <Badge tom="alerta">{t('plataforma.empateNaoResolvido')}</Badge>}
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
          : <EmptyState title={t('plataforma.nenhumaPontuacao')} description={t('plataforma.nenhumaPontuacaoDescricao')} />
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
// Exportado sob nome interno para que o teste renderize o modal diretamente,
// sem ter de atravessar a tela de ranking inteira para chegar até ele.
export function OrigemDosPontos({ atleta, temporada, onClose }) {
  const { t } = useIdioma();
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
              <div className="table-wrap tabela-em-modal">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('evento.colunaEvento')}</th>
                      <th>{t('evento.filiacao')}</th>
                      <th>{t('evento.categoria')}</th>
                      <th>{t('evento.classe')}</th>
                      <th className="num">{t('overall.colocacaoCurta')}</th>
                      <th className="num">{t('plataforma.ptsColocacao')}</th>
                      <th className="num">{t('overall.bonusOverall')}</th>
                      <th className="num">{t('publico.abaCampeonato')}</th>
                      <th className="num">{t('publico.abaSuperOverall')}</th>
                      <th>{t('plataforma.origem')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.items.map(ponto => (
                      <tr key={ponto.id}>
                        <td>{ponto.event?.name || ponto.externalResult?.eventName || '—'}</td>
                        {/* A filiação DA ÉPOCA — a que veio gravada no ponto, e
                            não a do cadastro de hoje. Um atleta que trocou de
                            federação tem, nesta mesma tabela, linhas de duas
                            entidades diferentes; é isso que precisa aparecer. */}
                        <td>
                          {ponto.affiliation?.name || '—'}
                          {ponto.affiliationNumber && (
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontSize: 10 }}>
                              nº {ponto.affiliationNumber}
                            </small>
                          )}
                        </td>
                        <td>{ponto.category?.name || '—'}</td>
                        <td>
                          {ponto.competitionClass?.code || ponto.competitionClass?.name || '—'}
                          {!ponto.superOverallEligible && (
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontSize: 10 }}>{t('plataforma.naoElegivel')}</small>
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
                      <td colSpan={7} style={{ textAlign: 'right' }}><strong>{t('plataforma.totais')}</strong></td>
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
          : <EmptyState title={t('plataforma.semPontosNaTemporada')} description={t('plataforma.semPontosDescricao')} />
        )}
      </AsyncSection>
    </Modal>
  );
}

function NovaTemporada({ notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [form, setForm] = useState({ organizationId: '', name: '', year: new Date().getFullYear() });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.ranking.createSeason({ organizationId: form.organizationId, name: form.name, year: Number(form.year) });
      notificar(t('plataforma.temporadaCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('plataforma.novaTemporada')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.organizacao')} required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} placeholder={t('plataforma.exemploTemporada')} /></Field>
        <Field label={t('plataforma.ano')} required><input type="number" min="2000" max="2100" value={form.year} onChange={evt => setForm({ ...form, year: evt.target.value })} required /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.criarTemporada')} />
      </form>
    </Modal>
  );
}

function TabelaDePontos({ temporada, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
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
      notificar(t('plataforma.tabelaSalva'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Tabela de pontos — ${temporada.name}`} description={t('plataforma.quantosPontos')} onClose={onClose}>
      <form onSubmit={salvar}>
        {!regras.length && (
          <div className="alert alert-alerta" style={{ marginBottom: 12 }}>
            <AlertTriangle size={15} />
            <div>
              <strong>{t('plataforma.semTabelaTitulo')}</strong>
              <p>{t('plataforma.informeATabela')}</p>
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
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.salvarTabela')} />
      </form>
    </Modal>
  );
}

// ============================================================== MUSCLEWAR
// ==========================================================================
// EXCLUIR E INVALIDAR SÃO A MESMA PORTA E OPERAÇÕES DIFERENTES.
//
// O servidor decide qual das duas acontece — pelo que o lote publicou, não
// pelo rótulo do status. A tela precisa DIZER qual vai acontecer ANTES do
// clique, senão o operador aperta "Excluir" num lote publicado imaginando que
// está limpando rascunho, e o que ele faz é desfazer resultado no ranking.
// ==========================================================================

/** Um lote que publicou alguma coisa não se exclui: se invalida. */
const loteFoiPublicado = lote => lote.status === 'APPLIED' || (lote.appliedCount ?? 0) > 0;

// CHAVES, e não rótulos: esta função é de módulo e não conhece o idioma em
// vigor. Quem desenha o botão traduz.
const acaoDoLote = lote => (loteFoiPublicado(lote)
  ? { rotulo: 'acao.invalidar', titulo: 'plataforma.invalidarImportacaoPublicada' }
  : { rotulo: 'acao.excluir', titulo: 'plataforma.excluirImportacao' });

export function ExcluirImportacao({ lote, notificar, onClose, onConcluido }) {
  const { t } = useIdioma();
  const publicado = loteFoiPublicado(lote);
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);

  // O motivo é exigido pelo servidor quando há resultado publicado. A tela
  // exige junto para não gastar uma ida ao servidor só para receber o 422.
  const faltaMotivo = publicado && motivo.trim().length < 3;

  const confirmar = async () => {
    setEnviando(true);
    setErro(null);
    try {
      const { operation } = await api.muscleWar.remove(lote.id, motivo.trim() ? { reason: motivo.trim() } : {});
      notificar(operation === 'INVALIDATED'
        ? t('plataforma.importacaoInvalidada')
        : t('plataforma.importacaoExcluida'), 'ok');
      onConcluido();
    } catch (falha) {
      // Mensagem do domínio, nunca o erro técnico cru.
      setErro(falha.message || t('plataforma.falhaNaOperacao'));
      setEnviando(false);
    }
  };

  return (
    <Modal title={publicado ? t('plataforma.invalidarImportacaoPergunta') : t('plataforma.excluirImportacaoPergunta')} onClose={onClose}>
      <p style={{ color: 'var(--cinza)', fontSize: 13, marginTop: 0 }}>
        Você está prestes a {publicado ? 'invalidar' : 'excluir'} esta importação.
      </p>

      {/* O QUE, EXATAMENTE. Confirmar uma exclusão sem ver o arquivo, o evento
          e o tamanho do lote é confirmar no escuro. */}
      <dl className="resumo-da-exclusao">
        <div><dt>{t('plataforma.arquivo')}</dt><dd>{lote.sourceRef}</dd></div>
        <div><dt>{t('evento.colunaEvento')}</dt><dd>{lote.event?.name || 'sem evento'}</dd></div>
        <div><dt>{t('evento.temporada')}</dt><dd>{lote.season?.name || 'sem temporada'}</dd></div>
        <div><dt>{t('plataforma.registros')}</dt><dd>{lote.totalRecords}</dd></div>
        <div><dt>{t('plataforma.aplicados')}</dt><dd>{lote.appliedCount ?? 0}</dd></div>
        <div><dt>{t('evento.situacao')}</dt><dd>{estadoDaImportacao(lote.status).rotulo}</dd></div>
        <div><dt>{t('plataforma.enviadaEm')}</dt><dd>{formatarDataHora(lote.createdAt)}</dd></div>
      </dl>

      <div className={`alert ${publicado ? 'alert-alerta' : 'alert-info'}`} style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          {publicado
            ? (
              <p style={{ margin: 0 }}>
                Esta importação possui resultados vinculados ao ranking. A exclusão será
                tratada como <strong>{t('plataforma.invalidacao')}</strong> e ficará registrada na auditoria:
                os lançamentos continuam no histórico, marcados e valendo zero.
              </p>
            )
            : <p style={{ margin: 0 }}>{t('plataforma.semResultadosPublicados')}</p>}
        </div>
      </div>

      <Field label={publicado ? t('plataforma.motivoDaInvalidacao') : t('plataforma.motivoOpcional')}>
        <input
          type="text"
          value={motivo}
          maxLength={300}
          onChange={evento => setMotivo(evento.target.value)}
          placeholder={t('plataforma.exemploMotivo')}
        />
      </Field>

      {erro && <div className="alert alert-perigo" style={{ marginBottom: 12 }}><div><p style={{ margin: 0 }}>{erro}</p></div></div>}

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button button-danger" onClick={confirmar} disabled={enviando || faltaMotivo}>
          <Trash2 size={15} /> {publicado ? t('plataforma.invalidarImportacao') : t('plataforma.excluirImportacao')}
        </button>
      </div>
    </Modal>
  );
}

export function AdminMuscleWar({ notificar }) {
  const { t } = useIdioma();
  const [importando, setImportando] = useState(false);
  const [detalhe, setDetalhe] = useState(null);
  const [paraExcluir, setParaExcluir] = useState(null);
  const estado = useFetch(() => api.muscleWar.list({ limit: 50 }), []);

  // Esconder a ação de quem não pode executá-la não é o controle de acesso —
  // esse é do servidor, que responde 403. É para não oferecer um botão que só
  // falharia depois do clique.
  const { user } = useAuth();
  const podeExcluir = podeCom(permissoesDe(user))('musclewar.apply');

  return (
    <div className="page">
      <PageHead
        eyebrow={t('plataforma.integracao')}
        title={t('plataforma.muscleWare')}
        description={t('plataforma.muscleWareDescricao')}
        actions={<button type="button" className="button button-primary" onClick={() => setImportando(true)}><Upload size={15} />{t('plataforma.importarResultados')}</button>}
      />

      <AsyncSection state={estado} linhas={4}>
        {dados => (dados.items.length
          ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>{t('plataforma.origem')}</th><th>{t('evento.situacao')}</th><th className="num">{t('plataforma.registros')}</th><th className="num">{t('plataforma.reconhecidos')}</th><th className="num">{t('plataforma.pendentes')}</th><th className="num">{t('plataforma.conflitos')}</th><th>{t('plataforma.quando')}</th><th /></tr>
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
                        <Badge tom={estadoDaImportacao(lote.status).tom}>{estadoDaImportacao(lote.status).rotulo}</Badge>
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
                        <div className="acoes-da-linha">
                          <button type="button" className="button button-secondary button-sm" onClick={() => setDetalhe(lote.id)}>{t('plataforma.revisar')}</button>
                          {/* A AÇÃO DESTRUTIVA MUDA DE NOME CONFORME O ESTADO,
                              porque ela muda de natureza. Rascunho se EXCLUI;
                              lote publicado se INVALIDA, e chamar as duas de
                              "excluir" é o que faz alguém apagar resultado
                              achando que está limpando rascunho.
                              Um lote já invalidado não oferece ação nenhuma:
                              não há o que desfazer duas vezes. */}
                          {podeExcluir && lote.status !== 'INVALIDATED' && (
                            <button
                              type="button"
                              className="button button-danger button-sm"
                              title={t(acaoDoLote(lote).titulo)}
                              onClick={() => setParaExcluir(lote)}
                            >
                              <Trash2 size={14} /> {t(acaoDoLote(lote).rotulo)}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState title={t('plataforma.nenhumaImportacao')} description={t('plataforma.nenhumaImportacaoDescricao')} />
        )}
      </AsyncSection>

      {importando && <NovaImportacao notificar={notificar} onClose={() => setImportando(false)} onCriada={id => { setImportando(false); estado.reload(); setDetalhe(id); }} />}
      {detalhe && <RevisarImportacao importId={detalhe} notificar={notificar} onClose={() => setDetalhe(null)} onMudou={() => estado.reload()} />}
      {paraExcluir && (
        <ExcluirImportacao
          lote={paraExcluir}
          notificar={notificar}
          onClose={() => setParaExcluir(null)}
          onConcluido={() => { setParaExcluir(null); estado.reload(); }}
        />
      )}
    </div>
  );
}

// Exportado pelo mesmo motivo que a revisão: o teste precisa montar o
// formulário direto, sem atravessar a listagem de lotes para chegar nele.
// Data e local de um evento em uma linha. Separado de `descreverEvento`
// porque a revisão já mostra o nome em destaque e repeti-lo na mesma frase
// seria ruído.
function detalheDoEvento(evento) {
  const partes = [];
  if (evento.startDate) partes.push(new Date(evento.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }));
  if (evento.city) partes.push(evento.state ? `${evento.city}/${evento.state}` : evento.city);
  return partes.join(' · ') || 'sem data e local informados';
}

// O EVENTO PRECISA SER RECONHECÍVEL NA LISTA, NÃO SÓ IDENTIFICÁVEL.
//
// Duas etapas da mesma federação podem ter nomes muito parecidos — e o
// operador está publicando resultado de campeonato nacional. Nome sozinho não
// desambigua; data e cidade desambiguam.
function descreverEvento(evento) {
  const partes = [evento.name];
  if (evento.startDate) partes.push(new Date(evento.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }));
  if (evento.city) partes.push(evento.state ? `${evento.city}/${evento.state}` : evento.city);
  return partes.join(' · ');
}

export function NovaImportacao({ notificar, onClose, onCriada }) {
  const { t } = useIdioma();
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const temporadas = useFetch(() => api.ranking.seasons(), []);
  const [form, setForm] = useState({
    organizationId: '', seasonId: '', eventId: '', sourceType: 'CSV', sourceRef: '', content: '',
    externalIdPrefix: '', defaultAffiliationCode: ''
  });
  const [salvando, setSalvando] = useState(false);

  // OS EVENTOS SÃO PEDIDOS PARA A ORGANIZAÇÃO ESCOLHIDA, E SÓ DEPOIS DELA.
  //
  // Sem organização não há lista a pedir — `ativo: false` evita a busca sem
  // escopo, que voltaria com o calendário de todo mundo. O servidor recorta de
  // novo por conta própria (`organizationFilter`) e recusa evento de outra
  // organização na criação do lote: este filtro é conveniência de tela, nunca
  // a barreira.
  const eventos = useFetch(
    () => api.events.list({ organizationId: form.organizationId, limit: 100 }),
    [form.organizationId],
    { ativo: Boolean(form.organizationId) }
  );

  // TROCAR DE ORGANIZAÇÃO APAGA O EVENTO ESCOLHIDO.
  //
  // Sem isto o `eventId` da organização anterior continuaria no estado e
  // viajaria no corpo — o servidor recusaria com EVENT_INVALID, mas o operador
  // levaria um erro sem entender de onde veio. Pior: se as duas organizações
  // fossem acessíveis ao mesmo usuário, a publicação iria para o evento
  // errado sem erro nenhum.
  const escolherOrganizacao = valor =>
    setForm(atual => ({ ...atual, organizationId: valor, eventId: '' }));

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
        // Mesmo critério dos outros campos opcionais: ausência não é string
        // vazia. Sem evento escolhido, a chave não viaja, e o lote nasce sem
        // evento — que é um caso legítimo e declarado.
        ...(form.eventId ? { eventId: form.eventId } : {}),
        sourceRef: form.sourceRef,
        content: form.content,
        // Campos vazios NÃO viajam: o servidor trata ausência como "não
        // declarado" e string vazia como valor, e mandar '' ligaria a
        // derivação de identificador sem que ninguém tivesse pedido.
        ...(form.externalIdPrefix.trim() ? { externalIdPrefix: form.externalIdPrefix.trim() } : {}),
        ...(form.defaultAffiliationCode.trim() ? { defaultAffiliationCode: form.defaultAffiliationCode.trim() } : {})
      });
      notificar(t('plataforma.previaGerada'));
      onCriada(previa.import.id);
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={t('plataforma.importarResultados')}
      description={t('plataforma.arquivoEConferido')}
      variante="modal-formulario"
      onClose={onClose}
    >
      <form onSubmit={enviar}>
        <Field label={t('evento.organizacao')} required>
          <select value={form.organizationId} onChange={evt => escolherOrganizacao(evt.target.value)} required>
            <option value="">{t('evento.selecione')}</option>
            {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field
          label={t('evento.colunaEvento')}
          hint="É o evento onde os resultados serão publicados. Escolher aqui é o que permite responder depois de qual etapa veio cada ponto do ranking. Sem evento, o resultado entra no histórico sem etapa."
        >
          <select
            value={form.eventId}
            disabled={!form.organizationId}
            onChange={evt => setForm({ ...form, eventId: evt.target.value })}
          >
            <option value="">{form.organizationId ? t('plataforma.semEvento') : t('plataforma.escolhaOrganizacao')}</option>
            {(eventos.data?.items || []).map(evento => (
              <option key={evento.id} value={evento.id}>{descreverEvento(evento)}</option>
            ))}
          </select>
        </Field>
        <Field label={t('evento.temporada')} hint={t('plataforma.semTemporadaHint')}>
          <select value={form.seasonId} onChange={evt => setForm({ ...form, seasonId: evt.target.value })}>
            <option value="">{t('evento.semTemporada')}</option>
            {(temporadas.data?.items || []).map(temporada => <option key={temporada.id} value={temporada.id}>{temporada.name} ({temporada.year})</option>)}
          </select>
        </Field>
        <Field label={t('plataforma.arquivo')} required hint="CSV ou JSON. Reconhece nome inteiro ou First Name + Last Name, e Member Number como matrícula. Total Score não é lido como pontuação: a colocação é que pontua.">
          <input type="file" accept=".csv,.json,text/csv,application/json" onChange={lerArquivo} required />
        </Field>
        <Field
          label={t('plataforma.filiacaoDaEtapa')}
          hint="Para arquivos sem coluna de filiação. O reconhecimento por matrícula exige as duas juntas — matrícula sozinha não identifica ninguém. Linha que já traz a sua própria filiação não é sobrescrita."
        >
          <input
            type="text" value={form.defaultAffiliationCode} maxLength={40} placeholder={t('plataforma.exemploNpc')}
            onChange={evt => setForm({ ...form, defaultAffiliationCode: evt.target.value })}
          />
        </Field>
        <Field
          label={t('plataforma.prefixoDoIdentificador')}
          hint="Só para arquivos que não trazem identificador de resultado. A chave fica prefixo + matrícula + classe, e é ela que impede que importar duas vezes some os pontos duas vezes. Em branco, um arquivo sem identificador é recusado em vez de importado."
        >
          <input
            type="text" value={form.externalIdPrefix} maxLength={40} placeholder={t('plataforma.exemploIpiranga')}
            onChange={evt => setForm({ ...form, externalIdPrefix: evt.target.value })}
          />
        </Field>
        {form.content && (
          <div className="alert alert-info" style={{ marginBottom: 12 }}>
            <div><strong>{form.sourceRef}</strong><p>{form.sourceType} · {form.content.length.toLocaleString('pt-BR')} caracteres lidos.</p></div>
          </div>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.previsualizar')} disabled={!form.content} />
      </form>
    </Modal>
  );
}

// Exportado para que o teste renderize a revisão direto, sem atravessar a
// listagem de lotes para chegar até ela.
// SITUAÇÕES QUE O OPERADOR FILTRA.
//
// Com dez mil linhas, achar as cem pendentes rolando a tabela não é difícil:
// é inviável. O filtro vai ao servidor — filtrar no navegador exigiria ter
// baixado as dez mil, que é justamente o que a paginação deixou de fazer.
// A lista guarda CÓDIGO e CHAVE — não o rótulo. Ela mora fora de componente,
// onde não existe idioma em vigor; quem traduz é quem desenha o filtro.
const FILTROS_DA_REVISAO = [
  ['', 'plataforma.todas'],
  ['MATCH_PENDING', 'plataforma.pendentes'],
  ['CONFLICT', 'plataforma.conflitos'],
  ['MATCHED', 'plataforma.reconhecidas'],
  ['DUPLICATE', 'plataforma.duplicadas'],
  ['IMPORT_REJECTED', 'plataforma.rejeitadas'],
  ['APPLIED', 'plataforma.aplicadas']
];

// 50 POR PÁGINA, E NÃO 200.
//
// Duzentas linhas não cabem na altura de um diálogo — e o preço não é só
// visual: são duzentas linhas montadas no DOM para o operador ler cinco. Com
// 50 e páginas de verdade, a altura vira constante e o recorte é do servidor,
// que é quem sabe o total.
const POR_PAGINA_NA_REVISAO = 50;

// ==========================================================================
// EXPORTAR O QUE A REVISÃO TEM EM MÃOS.
//
// O recorte é o da tela: a página atual, com os filtros que o operador
// aplicou. Não é "baixar a importação inteira" — isso seria outra coisa, com
// outro custo e outra pergunta de autorização, e o servidor não tem porta para
// isso. Exportar o que está à vista não abre frente nenhuma: o dado já está no
// navegador porque a tela o desenhou.
//
// O CPF SAI MASCARADO, e é a única coisa que o arquivo mostra diferente da
// tela. A razão é a assimetria: a tela exige sessão autenticada com permissão
// de revisão; a planilha, depois de baixada, viaja por e-mail e mensagem sem
// controle nenhum. A máscara preserva o que o CPF serve para fazer aqui —
// conferir de quem é a linha — sem levar o documento inteiro junto.
// ==========================================================================
// O CABEÇALHO DA PLANILHA ACOMPANHA O IDIOMA DA TELA, e por isso a lista
// guarda a CHAVE: quem exporta lê a planilha na língua em que estava
// operando. As colunas em si — ordem e conteúdo — não mudam, então um arquivo
// exportado em espanhol e outro em português continuam tendo as mesmas
// colunas na mesma ordem.
const COLUNAS_DA_EXPORTACAO = [
  ['plataforma.colunaNumero', item => item.rowNumber],
  ['plataforma.colunaCpf', item => (item.cpf ? ocultarCpf(item.cpf) : '')],
  ['plataforma.colunaAtleta', item => item.athlete?.fullName || item.athleteName || ''],
  ['plataforma.colunaFiliacao', item => item.affiliationCode || ''],
  ['plataforma.matricula', item => item.memberNumber || ''],
  ['plataforma.colunaCategoria', item => item.categoryCode || ''],
  ['plataforma.colunaClasse', item => item.className || ''],
  ['plataforma.colunaColocacao', item => (item.placing ?? '')],
  ['plataforma.pontosDoArquivo', item => (item.points ?? '')],
  ['plataforma.colunaSituacao', item => estadoDeMatch(item.matchStatus).rotulo],
  ['plataforma.colunaMotivo', item => item.reason || '']
];

// Aspas duplicadas e campo entre aspas: é o mínimo para que um nome com
// vírgula não vire duas colunas na planilha de quem abrir.
const campoCsv = valor => `"${String(valor ?? '').replace(/"/g, '""')}"`;

function exportarRevisao(dados, sufixo, t) {
  const linhas = [
    COLUNAS_DA_EXPORTACAO.map(([chave]) => campoCsv(t(chave))).join(','),
    ...dados.items.map(item => COLUNAS_DA_EXPORTACAO.map(([, ler]) => campoCsv(ler(item))).join(','))
  ];

  // BOM na frente: sem ele o Excel em português abre "Físico" como "FÃ­sico".
  const conteudo = new Blob(['\uFEFF' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const endereco = URL.createObjectURL(conteudo);
  const ancora = document.createElement('a');
  ancora.href = endereco;
  ancora.download = `revisao-${(dados.import.sourceRef || 'importacao').replace(/\.[^.]+$/, '')}${sufixo}.csv`;
  document.body.appendChild(ancora);
  ancora.click();
  document.body.removeChild(ancora);
  URL.revokeObjectURL(endereco);
}

export function RevisarImportacao({ importId, notificar, onClose, onMudou }) {
  const { t } = useIdioma();
  const [situacao, setSituacao] = useState('');
  const [categoria, setCategoria] = useState('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(0);

  // A BUSCA VAI AO SERVIDOR, com atraso. Filtrar a página já baixada acharia
  // só dentro das 50 visíveis e diria "nada encontrado" com o atleta na página
  // 3 — pior do que não ter busca. O atraso existe para não disparar uma
  // consulta por tecla digitada.
  const termo = useDebounce(busca, 350);

  // O lote inteiro não vem de uma vez: a resposta de uma importação de 10.000
  // linhas passava de 12 MB. O recorte é do servidor, e trocar de página não
  // acumula nada no navegador.
  const estado = useFetch(
    () => api.muscleWar.preview(importId, {
      limit: POR_PAGINA_NA_REVISAO,
      offset: pagina * POR_PAGINA_NA_REVISAO,
      ...(situacao ? { matchStatus: situacao } : {}),
      ...(categoria ? { categoryCode: categoria } : {}),
      ...(termo.trim() ? { q: termo.trim() } : {})
    }),
    [importId, situacao, categoria, termo, pagina]
  );
  const [vinculando, setVinculando] = useState(null);
  const [aplicando, setAplicando] = useState(false);

  // Qualquer mudança de recorte volta para a primeira página: manter a página
  // 4 depois de filtrar mostraria uma tela vazia de um resultado que existe.
  const trocarFiltro = valor => { setSituacao(valor); setPagina(0); };
  const trocarCategoria = valor => { setCategoria(valor); setPagina(0); };
  const trocarBusca = valor => { setBusca(valor); setPagina(0); };

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
    <Modal title={t('plataforma.revisarImportacao')} description={t('plataforma.revisarDescricao')} wide onClose={onClose}>
      <AsyncSection state={estado} linhas={4}>
        {dados => (
          <>
            {/* O DESTINO ANTES DOS NÚMEROS.
                Os totais respondem "o que vai entrar"; o evento responde
                "onde". Sem ele a revisão inteira descreve uma publicação sem
                dizer para onde ela vai. */}
            <div className={`alert ${dados.import.event ? 'alert-info' : 'alert-alerta'}`} style={{ marginBottom: 14 }}>
              <CalendarDays size={16} />
              <div>
                <strong>{dados.import.event ? dados.import.event.name : t('plataforma.semEvento')}</strong>
                <p>{dados.import.event
                  ? detalheDoEvento(dados.import.event)
                  : t('plataforma.semEtapaAviso')}</p>
              </div>
            </div>

            <div className="import-summary">
              <Metric label={t('plataforma.registros')} value={dados.summary.totalRecords} />
              <Metric label={t('plataforma.reconhecidos')} value={dados.summary.recognized} destaque />
              <Metric label={t('plataforma.pendentes')} value={dados.summary.pending} />
              <Metric label={t('plataforma.conflitos')} value={dados.summary.conflicts} />
              <Metric label={t('plataforma.duplicados')} value={dados.summary.duplicates} />
              <Metric label={t('plataforma.rejeitados')} value={dados.summary.rejected} />
              <Metric label={t('plataforma.aplicados')} value={dados.summary.applied} />
            </div>

            {/* O QUE VAI ACONTECER, DITO ANTES DO CLIQUE.
                O MCI carrega o histórico oficial dos campeonatos antigos ANTES
                de os atletas se cadastrarem — então o normal, e não a exceção,
                é a maior parte do arquivo entrar sem dono. Chamar isso de
                "registro que exige revisão" assustaria o operador com o caso
                comum; não dizer nada o faria descobrir depois. */}
            {dados.summary.pendingLink > 0 && (
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                <AlertTriangle size={16} />
                <div>
                  <strong>{dados.summary.pendingLink} resultado(s) ficarão pendentes de vínculo</strong>
                  <p>
                    {dados.summary.applicable} resultado(s) entram no histórico e no ranking agora.
                    Os atletas ainda não cadastrados permanecerão pendentes de vínculo, e o
                    histórico será ligado ao perfil deles quando se cadastrarem.
                    <strong>{t('plataforma.nenhumCriadoAutomaticamente')}</strong>
                  </p>
                </div>
              </div>
            )}

            {/* CONFLITO E REJEIÇÃO SÃO OUTRA COISA, e continuam sendo aviso de
                verdade: estes NÃO entram, e é por decisão da análise. */}
            {(dados.summary.conflicts > 0 || dados.summary.rejected > 0) && (
              <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
                <AlertTriangle size={16} />
                <div>
                  <strong>{t('plataforma.registrosQueNaoEntram')}</strong>
                  <p>
                    {dados.summary.conflicts} em conflito e {dados.summary.rejected} rejeitado(s)
                    ficam de fora e precisam de revisão. Isso não impede aplicar o resto.
                  </p>
                </div>
              </div>
            )}

            <div className="import-filtros">
              {/* A BUSCA NÃO ACEITA CPF, e isso é decisão, não esquecimento:
                  procurar por CPF mandaria o documento inteiro na query
                  string, que é onde log de servidor e histórico de navegador
                  guardam o que passa. Nome, matrícula e classe resolvem a
                  mesma necessidade sem esse custo. */}
              <div className="import-busca">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t('plataforma.buscarNaImportacao')}
                  placeholder={t('plataforma.buscarNaImportacaoPlaceholder')}
                  value={busca}
                  onChange={evento => trocarBusca(evento.target.value)}
                />
              </div>

              <label htmlFor="filtro-situacao">{t('evento.situacao')}</label>
              <select id="filtro-situacao" value={situacao} onChange={evento => trocarFiltro(evento.target.value)}>
                {FILTROS_DA_REVISAO.map(([valor, chave]) => (
                  <option key={valor || 'todas'} value={valor}>{t(chave)}</option>
                ))}
              </select>

              {/* As categorias são as DESTE lote. Oferecer o catálogo inteiro
                  seria oferecer filtros que só devolvem vazio. */}
              {(dados.categories || []).length > 0 && (
                <>
                  <label htmlFor="filtro-categoria">{t('evento.categoria')}</label>
                  <select id="filtro-categoria" value={categoria} onChange={evento => trocarCategoria(evento.target.value)}>
                    <option value="">{t('plataforma.todas')}</option>
                    {dados.categories.map(item => (
                      <option key={item.code} value={item.code}>{item.code} ({item.count})</option>
                    ))}
                  </select>
                </>
              )}
              {/* "Mostrando X de Y" não é enfeite: uma lista cortada em
                  silêncio parece completa, e o operador conclui que não há
                  mais nada a revisar. */}
              <button
                type="button"
                className="button button-secondary button-sm"
                title={t('plataforma.exportarDica')}
                onClick={() => exportarRevisao(dados, situacao || categoria || termo.trim() ? '-filtrado' : '', t)}
                disabled={!dados.items.length}
              >
                <Download size={14} />{t('plataforma.exportar')}</button>

              <span className="import-contagem">
                {dados.page?.total
                  ? `Mostrando ${(dados.page.offset ?? 0) + 1}–${(dados.page.offset ?? 0) + dados.items.length} de ${dados.page.total}`
                  : t('plataforma.nenhumRegistroNoFiltro')}
                {(situacao || categoria || termo.trim()) ? ' no filtro' : ' registros'}
              </span>
            </div>

            <div className="table-wrap tabela-em-modal">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th><th>CPF</th><th>{t('overall.atleta')}</th><th>{t('evento.filiacao')}</th>
                    {/* A matrícula de FILIAÇÃO — o "Member Number" dos arquivos
                        oficiais. Não é `athleteNumber`, que é outra coisa no
                        modelo; confundir os dois faria o operador conferir o
                        campo errado. */}
                    <th>{t('plataforma.matricula')}</th>
                    <th>{t('evento.categoria')}</th>
                    {/* A classe é o que decide se o resultado alimenta o Super
                        Overall — sem ela na tela o operador não consegue
                        conferir a elegibilidade. */}
                    <th>{t('evento.classe')}</th>
                    <th className="num">{t('overall.colocacaoCurta')}</th>
                    <th className="num">{t('plataforma.ptsArquivo')}</th>
                    <th>{t('evento.situacao')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {dados.items.map(item => {
                    const info = estadoDeMatch(item.matchStatus);
                    return (
                      <tr key={item.id}>
                        <td className="num">{item.rowNumber}</td>
                        <td className="num">{item.cpf || '—'}</td>
                        <td>{item.athlete?.fullName || item.athleteName || '—'}</td>
                        <td>{item.affiliationCode || '—'}</td>
                        <td className="num">{item.memberNumber || '—'}</td>
                        <td>{item.categoryCode || '—'}</td>
                        <td>
                          {item.className || '—'}
                          {item.isOverallChampion && <Badge tom="ok">{t('carreira.colunaOverall')}</Badge>}
                        </td>
                        <td className="num">{item.placing ?? '—'}</td>
                        <td className="num">{item.points ?? '—'}</td>
                        <td>
                          <Badge tom={info.tom}>{info.rotulo}</Badge>

                          {/* POR QUE casou, e não só QUE casou. Quem revisa sem
                              saber a chave não tem como conferir se casou
                              certo. */}
                          {item.matchedBy && (
                            <small style={{ display: 'block', marginTop: 3 }}>
                              por <strong>{criterioDeMatch(item.matchedBy)}</strong>
                            </small>
                          )}

                          {item.reason && <small style={{ display: 'block', color: 'var(--cinza-fraco)', marginTop: 3 }}>{item.reason}</small>}

                          {/* A SUGESTÃO, com o que a sustenta. Fica visualmente
                              separada do vínculo: sugestão por nome não
                              reconhece ninguém, e a tela não pode dar a
                              entender que reconheceu. */}
                          {item.suggestedAthlete && (
                            <small style={{ display: 'block', marginTop: 4 }}>
                              <span className="chip">{t('plataforma.sugerido')}</span>{' '}
                              <strong>{item.suggestedAthlete.fullName}</strong>
                              {item.suggestedAthlete.affiliation && ` · ${item.suggestedAthlete.affiliation.code}`}
                              {item.suggestedAthlete.affiliationNumber && ` · nº ${item.suggestedAthlete.affiliationNumber}`}
                            </small>
                          )}

                          {/* CONFLITO DE IDENTIDADE: os candidatos em disputa, e
                              o que cada chave afirma. Sem isto o operador
                              aperta "vincular" no escuro. */}
                          {Array.isArray(item.matchCandidates) && item.matchCandidates.length > 0 && (
                            <small style={{ display: 'block', marginTop: 4 }}>
                              <strong>{t('plataforma.conflitoDeIdentidade')}</strong>
                              {item.matchCandidates.map(candidato => (
                                <span key={`${candidato.matchedBy}-${candidato.athleteId}`} style={{ display: 'block' }}>
                                  {criterioDeMatch(candidato.matchedBy)}:{' '}
                                  {candidato.fullName}
                                  {candidato.affiliation && ` · ${candidato.affiliation.code}`}
                                  {candidato.affiliationNumber && ` · nº ${candidato.affiliationNumber}`}
                                </span>
                              ))}
                            </small>
                          )}
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
                        <td>
                          {/* AÇÃO EM ÍCONE, e não em palavra: com onze colunas
                              disputando a largura, "Vincular" escrito custava
                              97px que saíam do nome do atleta e da classe — as
                              duas colunas que o operador realmente lê para
                              decidir. O ícone custa 32.

                              `title` para quem usa mouse e `aria-label` para
                              quem usa leitor de tela: um ícone sozinho não diz
                              o que faz para nenhum dos dois. */}
                          {['MATCH_PENDING', 'CONFLICT'].includes(item.matchStatus) && dados.import.status !== 'APPLIED' && (
                            <div className="acoes-da-linha">
                              <button
                                type="button"
                                className="icon-button icon-button-sm"
                                title={t('plataforma.vincularAoAtleta')}
                                aria-label={`Vincular ao atleta a linha ${item.rowNumber}`}
                                onClick={() => setVinculando(item)}
                              >
                                <Link2 size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* PÁGINAS, e não "carregar mais". Acumular recorte dentro de um
                diálogo devolve o problema que a paginação resolveu: a altura
                cresce de novo e o rodapé volta a fugir da tela. */}
            {(dados.page?.total ?? 0) > POR_PAGINA_NA_REVISAO && (
              <div className="import-paginacao">
                <button
                  type="button" className="button button-secondary button-sm"
                  onClick={() => setPagina(atual => Math.max(0, atual - 1))}
                  disabled={pagina === 0}
                >{t('plataforma.anterior')}</button>
                <span>
                  Página {pagina + 1} de {Math.max(1, Math.ceil((dados.page.total ?? 0) / POR_PAGINA_NA_REVISAO))}
                </span>
                <button
                  type="button" className="button button-secondary button-sm"
                  onClick={() => setPagina(atual => atual + 1)}
                  disabled={!dados.page?.hasMore}
                >{t('plataforma.proxima')}</button>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.fechar')}</button>
              {dados.import.status !== 'REJECTED' && (
                <button type="button" className="button button-primary" onClick={() => setAplicando(true)} disabled={!dados.summary.applicable}>
                  Aplicar {dados.summary.applicable} resultado(s)
                </button>
              )}
            </div>

            {aplicando && (
              <ConfirmDialog
                title={t('plataforma.aplicarImportacao')}
                // O DESTINO NO INSTANTE DA DECISÃO, e não só na tela anterior.
                // Este é o último ponto em que dá para voltar atrás.
                message={`Publicar ${dados.summary.applicable} resultado(s)`
                  + `${dados.summary.pendingLink ? ` — ${dados.summary.pendingLink} sem atleta cadastrado, que ficarão pendentes de vínculo` : ''}`
                  + ` em: ${dados.import.event
                  ? `${dados.import.event.name} — ${detalheDoEvento(dados.import.event)}`
                  : t('plataforma.semEventoMaiusculo')}. Resultados já importados não pontuam de novo.`}
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
  const { t } = useIdioma();
  const [busca, setBusca] = useState(item.athleteName || '');
  const [athleteId, setAthleteId] = useState('');
  const [salvando, setSalvando] = useState(false);
  const resultados = useFetch(() => api.athletes.list({ organizationId, search: busca || undefined, limit: 20 }), [busca, organizationId]);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.muscleWar.link(item.id, { athleteId });
      notificar(t('plataforma.registroVinculado'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={t('plataforma.vincularAoAtleta')}
      description={`Linha ${item.rowNumber} · CPF da origem: ${item.cpf || 'não informado'} · ${item.reason || ''}`}
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        <Field label="Buscar atleta">
          <input value={busca} onChange={evt => setBusca(evt.target.value)} placeholder={t('plataforma.nomeOuNomeEsportivo')} />
        </Field>

        <div className="lista-em-modal">
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
          {!(resultados.data?.items || []).length && <p style={{ padding: 14, fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('plataforma.nenhumAtletaEncontrado')}</p>}
        </div>

        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.vincular')} disabled={!athleteId} />
      </form>
    </Modal>
  );
}

// ============================================================== AUDITORIA
export function AdminAuditoria() {
  const { t } = useIdioma();
  const [filtros, setFiltros] = useState({ entity: '', action: '' });
  // 200 é o teto da própria rota de auditoria, e aqui ele é PÁGINA, não fim da
  // trilha: auditoria se lê em varredura, então vale trazer bastante de uma
  // vez — e continuar depois, em vez de parar.
  const estado = useListaPaginada(
    cursor => api.audit({
      entity: filtros.entity || undefined,
      action: filtros.action || undefined,
      limit: 200,
      cursor: cursor || undefined
    }),
    [filtros.entity, filtros.action]
  );

  return (
    <div className="page">
      <PageHead eyebrow={t('plataforma.seguranca')} title={t('plataforma.auditoria')} description={t('plataforma.auditoriaDescricao')} />

      <div className="toolbar">
        <input
          className="select-control"
          value={filtros.entity}
          onChange={evento => setFiltros({ ...filtros, entity: evento.target.value })}
          placeholder={t('plataforma.entidadeExemplo')}
          aria-label={t('plataforma.filtrarPorEntidade')}
        />
        <input
          className="select-control"
          value={filtros.action}
          onChange={evento => setFiltros({ ...filtros, action: evento.target.value })}
          placeholder={t('plataforma.acaoExemplo')}
          aria-label={t('plataforma.filtrarPorAcao')}
        />
      </div>

      <AsyncSection state={estado} linhas={6}>
        {dados => (dados.items.length
          ? (
            <>
              {/* O total agora é o da TRILHA, não o da página. Enquanto era o
                  tamanho da página, esse número respondia sempre a mesma coisa
                  — e auditoria existe justamente para responder "quantas
                  vezes isto aconteceu?". */}
              <p className="muted" style={{ marginBottom: 12 }}>
                Mostrando {dados.items.length} de {dados.total} registro(s).
              </p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('plataforma.quando')}</th><th>{t('plataforma.ator')}</th><th>{t('plataforma.acao')}</th><th>{t('plataforma.entidade')}</th><th>{t('plataforma.detalhe')}</th></tr></thead>
                <tbody>
                  {dados.items.map(linha => (
                    <tr key={linha.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatarDataHora(linha.createdAt)}</td>
                      <td>
                        {linha.user?.name || linha.userEmail || 'sistema'}
                        {linha.user?.role && <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{papel(linha.user.role).rotulo}</small>}
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
            <Paginacao nextCursor={estado.nextCursor} onMore={estado.carregarMais} loading={estado.carregandoMais} />
            </>
          )
          : <EmptyState title={t('plataforma.semRegistros')} description={t('plataforma.semRegistrosDescricao')} />
        )}
      </AsyncSection>
    </div>
  );
}

// =========================================================== CONFIGURAÇÕES
export function AdminConfiguracoes({ notificar }) {
  const { t } = useIdioma();
  const [aba, setAba] = useState('organizacoes');

  return (
    <div className="page">
      <PageHead eyebrow="Administração" title={t('plataforma.configuracoes')} description={t('plataforma.configuracoesDescricao')} />

      <div className="chips" style={{ marginBottom: 18 }}>
        {[['organizacoes', t('plataforma.organizacoes')], ['filiacoes', t('plataforma.filiacoes')], ['categorias', t('plataforma.categorias')], ['parceiros', t('plataforma.parceiros')], ['vinculos', t('plataforma.vinculoDeEquipe')], ['usuarios', t('plataforma.usuarios')]].map(([chave, rotulo]) => (
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
  const { t } = useIdioma();
  const estado = useFetch(() => api.organizations.list(), []);
  const [criando, setCriando] = useState(false);
  const [gerindo, setGerindo] = useState(null);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{t('plataforma.organizacoes')}</h2>
          <button type="button" className="button button-primary button-sm" onClick={() => setCriando(true)}><Plus size={13} />{t('plataforma.nova')}</button>
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
                <button type="button" className="button button-secondary button-sm" onClick={() => setGerindo(organizacao)}>{t('plataforma.membros')}</button>
              </div>
            ))
            : <EmptyState title={t('plataforma.nenhumaOrganizacao')} description={t('plataforma.nenhumaOrganizacaoDescricao')} />
          )}
        </AsyncSection>
      </section>

      {criando && <NovaOrganizacao notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
      {gerindo && <MembrosDaOrganizacao organizacao={gerindo} notificar={notificar} onClose={() => setGerindo(null)} />}
    </>
  );
}

function NovaOrganizacao({ notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ name: '', slug: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.organizations.create(form);
      notificar(t('plataforma.organizacaoCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('plataforma.novaOrganizacao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={140} /></Field>
        <Field label={t('plataforma.identificador')} required><input value={form.slug} onChange={evt => setForm({ ...form, slug: evt.target.value.toLowerCase() })} required pattern="[a-z0-9\-]{2,60}" /></Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.criar')} />
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
  const { t } = useIdioma();
  const estado = useFetch(() => api.organizations.findById(organizacao.id), [organizacao.id]);
  const usuarios = useFetch(() => api.admin.users({ limit: 100 }), []);
  const [form, setForm] = useState({ userId: '', role: 'EVENT_DIRECTOR' });
  const [salvando, setSalvando] = useState(false);

  const adicionar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.organizations.addMember(organizacao.id, form);
      notificar(t('plataforma.papelConcedido'));
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
      notificar(t('plataforma.vinculoRemovido'));
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <Modal title={`Membros — ${organizacao.name}`} description={t('plataforma.papelValeNaOrganizacao')} wide onClose={onClose}>
      <form onSubmit={adicionar} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 8, alignItems: 'end', marginBottom: 16 }}>
        <Field label={t('plataforma.usuario')} required>
          <select value={form.userId} onChange={evt => setForm({ ...form, userId: evt.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {(usuarios.data?.items || []).map(usuario => <option key={usuario.id} value={usuario.id}>{usuario.name} — {usuario.email}</option>)}
          </select>
        </Field>
        <Field label={t('plataforma.papel')} required>
          <select value={form.role} onChange={evt => setForm({ ...form, role: evt.target.value })} required>
            {/* `codigo` e não `papel`: o parâmetro sombrearia a função de rótulo
                importada e o select voltaria a mostrar o enum cru. */}
            {PAPEIS.map(codigo => <option key={codigo} value={codigo}>{papel(codigo).rotulo}</option>)}
          </select>
        </Field>
        <button type="submit" className="button button-primary" disabled={salvando} style={{ marginBottom: 13 }}>{t('plataforma.conceder')}</button>
      </form>

      <AsyncSection state={estado} linhas={3}>
        {dados => dados.members.map(membro => (
          <div className="list-row" key={membro.id}>
            <Avatar name={membro.user.name} size="avatar-sm" />
            <span className="info">
              <strong>{membro.user.name}</strong>
              <small>{membro.user.email}</small>
            </span>
            <Badge tom={papel(membro.role).tom}>{papel(membro.role).rotulo}</Badge>
            <button type="button" className="button button-danger button-sm" onClick={() => remover(membro)}>{t('plataforma.remover')}</button>
          </div>
        ))}
      </AsyncSection>

      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>{t('acao.fechar')}</button></div>
    </Modal>
  );
}

function Filiacoes({ notificar }) {
  const { t } = useIdioma();
  const organizacoes = useFetch(() => api.organizations.list(), []);
  const [organizationId, setOrganizationId] = useState('');
  const estado = useFetch(() => api.affiliations.list({ organizationId: organizationId || undefined }), [organizationId]);
  const [criando, setCriando] = useState(false);

  return (
    <>
      <div className="toolbar">
        <select className="select-control" value={organizationId} onChange={evento => setOrganizationId(evento.target.value)} aria-label={t('evento.organizacao')}>
          <option value="">{t('plataforma.todasAsOrganizacoes')}</option>
          {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
        </select>
        <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={14} />{t('plataforma.novaFiliacao')}</button>
      </div>

      <section className="panel">
        <AsyncSection state={estado} linhas={3}>
          {dados => (dados.items.length
            ? dados.items.map(filiacao => (
              <div className="list-row" key={filiacao.id}>
                <span className="info">
                  <strong>{filiacao.name}</strong>
                  <small>{filiacao.code} · {tipoDeFiliacao(filiacao.kind).rotulo} · {filiacao._count.athletes} atleta(s)</small>
                </span>
                <Badge tom={filiacao.active ? 'ok' : 'neutro'}>{filiacao.active ? t('plataforma.ativa') : t('plataforma.inativa')}</Badge>
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
                  {filiacao.active ? t('plataforma.desativar') : t('plataforma.ativar')}
                </button>
              </div>
            ))
            : <EmptyState title={t('plataforma.nenhumaFiliacao')} description={t('plataforma.filiacaoDescricao')} />
          )}
        </AsyncSection>
      </section>

      {criando && <NovaFiliacao organizacoes={organizacoes.data?.items || []} notificar={notificar} onClose={() => setCriando(false)} onSalvo={() => { setCriando(false); estado.reload(); }} />}
    </>
  );
}

function NovaFiliacao({ organizacoes, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ organizationId: '', name: '', code: '', kind: 'FEDERATION', state: '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.affiliations.create({ ...form, state: form.state || null });
      notificar(t('plataforma.filiacaoCriada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('plataforma.novaFiliacao')} description={t('plataforma.novaFiliacaoDescricao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('evento.organizacao')} required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {organizacoes.map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={140} /></Field>
        <div className="field-row">
          <Field label="Código" required hint={t('plataforma.usadoNoMatching')}><input value={form.code} onChange={evt => setForm({ ...form, code: evt.target.value.toUpperCase() })} required pattern="[A-Z0-9\-]{2,30}" placeholder="FED-MT" /></Field>
          <Field label="UF"><input value={form.state} onChange={evt => setForm({ ...form, state: evt.target.value.toUpperCase().slice(0, 2) })} maxLength={2} /></Field>
        </div>
        <Field label="Tipo">
          <select value={form.kind} onChange={evt => setForm({ ...form, kind: evt.target.value })}>
            {['FEDERATION', 'ENTITY', 'ASSOCIATION', 'TEAM', 'OTHER'].map(codigo => <option key={codigo} value={codigo}>{tipoDeFiliacao(codigo).rotulo}</option>)}
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.criarFiliacao')} />
      </form>
    </Modal>
  );
}

function Categorias({ notificar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.categories.list(), []);
  const [criando, setCriando] = useState(false);

  return (
    <>
      <div className="toolbar">
        <button type="button" className="button button-primary" onClick={() => setCriando(true)}><Plus size={14} />{t('plataforma.novaCategoria')}</button>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>{t('plataforma.catalogoOficial')}</h2></div>
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
  const { t } = useIdioma();
  const [form, setForm] = useState({ code: '', name: '', sex: 'FEMALE' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.categories.create(form);
      notificar(t('plataforma.categoriaAdicionada'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('plataforma.novaCategoria')} description={t('plataforma.catalogoExtensivel')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Código" required><input value={form.code} onChange={evt => setForm({ ...form, code: evt.target.value.toUpperCase() })} required pattern="[A-Z0-9_]{2,40}" /></Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={90} /></Field>
        <Field label="Sexo" required>
          <select value={form.sex} onChange={evt => setForm({ ...form, sex: evt.target.value })} required>
            <option value="FEMALE">{t('evento.feminino')}</option>
            <option value="MALE">{t('evento.masculino')}</option>
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Adicionar" />
      </form>
    </Modal>
  );
}

function Parceiros({ notificar }) {
  const { t } = useIdioma();
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
    { chave: 'company', titulo: t('plataforma.empresas'), estado: empresas },
    { chave: 'team', titulo: t('plataforma.equipes'), estado: equipes },
    { chave: 'gym', titulo: t('plataforma.academias'), estado: academias },
    { chave: 'brand', titulo: t('plataforma.marcas'), estado: marcas },
    { chave: 'sponsor', titulo: t('plataforma.patrocinadores'), estado: patrocinadores }
  ];

  return (
    <>
      <div className="toolbar">
        <select className="select-control" value={organizationId} onChange={evento => setOrganizationId(evento.target.value)} aria-label={t('evento.organizacao')}>
          <option value="">{t('plataforma.todasAsOrganizacoes')}</option>
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
                : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('plataforma.nenhumRegistro')}</p>
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
  const { t } = useIdioma();
  const [form, setForm] = useState({ organizationId: '', name: '', slug: '', city: '', state: '', companyId: '' });
  const [salvando, setSalvando] = useState(false);

  const titulos = {
    company: t('plataforma.novaEmpresa'), team: t('plataforma.novaEquipe'), gym: t('plataforma.novaAcademia'),
    brand: t('plataforma.novaMarca'), sponsor: t('plataforma.novoPatrocinador')
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
      notificar(t('plataforma.registroCriado'));
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
          ? t('plataforma.relacaoComercial')
          : tipo === 'company'
            ? t('plataforma.empresaCompetidora')
            : undefined
      }
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        <Field label={t('evento.organizacao')} required>
          <select value={form.organizationId} onChange={evt => setForm({ ...form, organizationId: evt.target.value })} required>
            <option value="">{t('evento.selecione')}</option>
            {organizacoes.map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
          </select>
        </Field>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required maxLength={120} /></Field>
        {tipo === 'brand' && (
          <Field label={t('plataforma.identificador')} required hint={t('plataforma.identificadorSocial')}>
            <input value={form.slug} onChange={evt => setForm({ ...form, slug: evt.target.value.toLowerCase() })} required pattern="[a-z0-9\-]{2,60}" />
          </Field>
        )}
        {tipo === 'team' && (
          <Field label={t('plataforma.empresa')} hint={t('plataforma.empresaHint')}>
            <select value={form.companyId} onChange={evt => setForm({ ...form, companyId: evt.target.value })}>
              <option value="">{t('plataforma.semEmpresa')}</option>
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
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('plataforma.criar')} />
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
  const { t } = useIdioma();
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
        <select className="select-control" value={organizationId} onChange={evento => { setOrganizationId(evento.target.value); setAtleta(null); }} aria-label={t('evento.organizacao')}>
          <option value="">{t('plataforma.selecioneOrganizacao')}</option>
          {(organizacoes.data?.items || []).map(organizacao => <option key={organizacao.id} value={organizacao.id}>{organizacao.name}</option>)}
        </select>
        <input className="select-control" style={{ flex: "1 1 240px" }} value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('evento.buscarAtleta')} disabled={!organizationId} />
      </div>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head"><h2>{t('publico.atletas')}</h2></div>
          {!organizationId
            ? <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('plataforma.selecioneParaBuscar')}</p>
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
                        <small>{item.team?.name || t('plataforma.semEquipe')}</small>
                      </span>
                    </button>
                  ))
                  : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('plataforma.nenhumAtletaEncontrado')}</p>
                )}
              </AsyncSection>
            )}
        </section>

        <section className="panel">
          <div className="panel-head"><h2>{t('plataforma.vinculo')}</h2></div>
          {!atleta
            ? <EmptyState title={t('plataforma.nenhumAtletaSelecionado')} description={t('plataforma.escolhaUmAtleta')} />
            : (
              <>
                <div className="metric" style={{ marginBottom: 14 }}>
                  <span>{t('plataforma.equipeAtual')}</span>
                  <strong style={{ fontSize: 16 }}>{ativo?.team?.name || t('plataforma.semEquipe')}</strong>
                  {ativo?.team?.company?.name && <small>Empresa: {ativo.team.company.name}</small>}
                </div>

                <div className="chips" style={{ marginBottom: 16 }}>
                  {!ativo && <button type="button" className="button button-sm" onClick={() => setAcao('link')}>{t('plataforma.vincular')}</button>}
                  {ativo && <button type="button" className="button button-sm" onClick={() => setAcao('transfer')}>{t('plataforma.transferir')}</button>}
                  {ativo && <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('unlink')}>{t('plataforma.encerrarVinculo')}</button>}
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
                            {formatarDataHora(linha.startedAt)} → {linha.endedAt ? formatarDataHora(linha.endedAt) : t('plataforma.ativo')}
                            {linha.reason ? ` · ${linha.reason}` : ''}
                          </small>
                        </span>
                        {!linha.endedAt && <Badge tom="ok">{t('plataforma.ativo')}</Badge>}
                      </div>
                    ))
                    : <p style={{ fontSize: 12, color: 'var(--cinza-fraco)' }}>{t('plataforma.semHistoricoDeVinculo')}</p>
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
  const { t } = useIdioma();
  const [teamId, setTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);
  const equipes = useFetch(() => api.partners.teams({ organizationId }), [organizationId]);

  const titulos = { link: t('plataforma.vincularAEquipe'), transfer: t('plataforma.transferirDeEquipe'), unlink: t('plataforma.encerrarVinculo') };
  const precisaEquipe = acao !== 'unlink';
  const precisaMotivo = acao !== 'link';

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      if (acao === 'link') await api.athletes.linkTeam(atleta.id, { teamId, reason: reason || null });
      if (acao === 'transfer') await api.athletes.transferTeam(atleta.id, { teamId, reason });
      if (acao === 'unlink') await api.athletes.unlinkTeam(atleta.id, { reason });
      notificar(t('plataforma.vinculoAtualizado'));
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
          <Field label={t('plataforma.equipe')} required>
            <select value={teamId} onChange={evt => setTeamId(evt.target.value)} required>
              <option value="">{t('evento.selecione')}</option>
              {(equipes.data?.items || [])
                .filter(equipe => equipe.id !== atual?.teamId)
                .map(equipe => <option key={equipe.id} value={equipe.id}>{equipe.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Motivo" required={precisaMotivo} hint={precisaMotivo ? t('plataforma.motivoNaAuditoria') : undefined}>
          <input value={reason} onChange={evt => setReason(evt.target.value)} required={precisaMotivo} minLength={precisaMotivo ? 3 : 0} maxLength={200} />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Confirmar" disabled={precisaEquipe && !teamId} />
      </form>
    </Modal>
  );
}

function Usuarios({ notificar }) {
  const { t } = useIdioma();
  const [busca, setBusca] = useState('');
  const estado = useFetch(() => api.admin.users({ limit: 60, search: busca || undefined }), [busca]);
  const [editando, setEditando] = useState(null);

  return (
    <>
      <div className="toolbar">
        <label className="search-box">
          <Users size={16} />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t('plataforma.buscarPorNomeOuEmail')} aria-label={t('plataforma.buscarUsuario')} />
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
              <Badge tom={papel(usuario.role).tom}>{papel(usuario.role).rotulo}</Badge>
              <Badge tom={estadoDoUsuario(usuario.status).tom}>{estadoDoUsuario(usuario.status).rotulo}</Badge>
              <button type="button" className="button button-secondary button-sm" onClick={() => setEditando(usuario)}>{t('evento.editar')}</button>
            </div>
          ))}
        </AsyncSection>
      </section>

      {editando && <EditarUsuario usuario={editando} notificar={notificar} onClose={() => setEditando(null)} onSalvo={() => { setEditando(null); estado.reload(); }} />}
    </>
  );
}

function EditarUsuario({ usuario, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ role: usuario.role, status: usuario.status });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.admin.updateUser(usuario.id, form);
      notificar(t('plataforma.usuarioAtualizado'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={usuario.name} description={t('plataforma.papelGlobalDescricao')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('plataforma.papelGlobal')} hint={t('plataforma.papelPrivilegiado')}>
          <select value={form.role} onChange={evt => setForm({ ...form, role: evt.target.value })}>
            {/* `codigo` e não `papel`: o parâmetro sombrearia a função de rótulo
                importada e o select voltaria a mostrar o enum cru. */}
            {PAPEIS.map(codigo => <option key={codigo} value={codigo}>{papel(codigo).rotulo}</option>)}
          </select>
        </Field>
        <Field label={t('evento.situacao')}>
          <select value={form.status} onChange={evt => setForm({ ...form, status: evt.target.value })}>
            <option value="ACTIVE">{t('plataforma.ativa')}</option>
            <option value="SUSPENDED">{t('plataforma.suspensa')}</option>
            <option value="DISABLED">{t('plataforma.desativada')}</option>
          </select>
        </Field>
        <ModalActions onClose={onClose} saving={salvando} />
      </form>
    </Modal>
  );
}

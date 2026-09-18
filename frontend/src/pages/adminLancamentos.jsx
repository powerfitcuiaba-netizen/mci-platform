import { useState } from 'react';
import { AlertTriangle, History, PencilLine, RotateCcw, Ban } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { SeletorDeEvento } from './adminEvent';
import { AsyncSection, Badge, EmptyState, Field, Modal, PageHead } from '../components/ui';
import { formatarData } from '../lib/format';

// ==========================================================================
// CORREÇÃO ADMINISTRATIVA DO RANKING PUBLICADO.
//
// A tela existe porque o caminho importado não tinha correção. Depois do
// `/apply`, um 3º que era 2º ficava errado para sempre: reimportar o arquivo
// corrigido esbarra na idempotência, que marca tudo como DUPLICATE.
//
// Três decisões de projeto, e cada uma tem teste:
//
//   * a tela NUNCA digita pontuação. O operador informa a COLOCAÇÃO ou o não
//     comparecimento, e o servidor recalcula pelo motor. Aceitar pontos
//     digitados abriria a porta que a importação fechou ao recusar a coluna de
//     pontos do arquivo;
//   * corrigir e invalidar exigem DOIS passos: a prévia mostra a conta aberta
//     — antes, depois e diferença —, e só a confirmação grava;
//   * INVALIDAR NÃO APAGA. A participação continua na lista, marcada, com o
//     motivo à vista. Sumir com a linha faria a etapa desaparecer do histórico
//     do atleta, e "não subiu no palco" viraria "não participou".
// ==========================================================================

const MOTIVO_MINIMO = 5;

const rotuloDaColocacao = ponto => {
  if (ponto.didNotShow) return 'NS';
  return ponto.placing != null ? `${ponto.placing}º` : '—';
};

export function AdminLancamentos({ notificar }) {
  const [eventId, setEventId] = useState(null);
  const [corrigindo, setCorrigindo] = useState(null);
  const [invalidando, setInvalidando] = useState(null);
  const [restaurando, setRestaurando] = useState(null);
  const [recarga, setRecarga] = useState(0);

  const estado = useFetch(
    () => (eventId ? api.ranking.eventPoints(eventId) : Promise.resolve(null)),
    [eventId, recarga]
  );

  const recarregar = () => setRecarga(n => n + 1);
  const concluir = fechar => { fechar(null); recarregar(); };

  return (
    <div className="page">
      <PageHead
        eyebrow="Ranking"
        title="Lançamentos do campeonato"
        description="Correção e invalidação de resultado já publicado. Toda alteração exige motivo e fica na auditoria."
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? (
          <EmptyState
            title="Escolha um campeonato"
            description="A correção é feita com a súmula do campeonato na mão, lançamento por lançamento."
          />
        )
        : (
          <AsyncSection state={estado} linhas={5}>
            {dados => {
              if (!dados) return null;
              return (
                <>
                  <section className="panel">
                    <div className="panel-head"><h2>{dados.event.name}</h2></div>
                    <div className="hero-meta" style={{ padding: '0 0 10px' }}>
                      <span>{formatarData(dados.event.startDate)}</span>
                      <span>{dados.items.length} lançamento(s)</span>
                      <span>{dados.items.filter(p => p.voidedAt).length} invalidado(s)</span>
                    </div>
                  </section>

                  {!dados.items.length
                    ? (
                      <EmptyState
                        title="Nenhum lançamento neste campeonato"
                        description="Os lançamentos aparecem depois que uma importação é aplicada ou um resultado é publicado."
                      />
                    )
                    : (
                      <section className="panel" style={{ marginTop: 18 }}>
                        <div className="table-wrap">
                          <table className="table lancamentos-tabela">
                            <thead>
                              <tr>
                                <th>Atleta</th>
                                <th>Categoria</th>
                                <th>Classe</th>
                                <th className="num">Col.</th>
                                <th className="num">Colocação</th>
                                <th className="num">Overall</th>
                                <th className="num">Pontos</th>
                                <th>Situação</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {dados.items.map(ponto => (
                                <LinhaDeLancamento
                                  key={ponto.id}
                                  ponto={ponto}
                                  onCorrigir={() => setCorrigindo(ponto)}
                                  onInvalidar={() => setInvalidando(ponto)}
                                  onRestaurar={() => setRestaurando(ponto)}
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                </>
              );
            }}
          </AsyncSection>
        )}

      {corrigindo && (
        <DialogoDeCorrecao
          ponto={corrigindo}
          notificar={notificar}
          onClose={() => setCorrigindo(null)}
          onPronto={() => concluir(setCorrigindo)}
        />
      )}

      {invalidando && (
        <DialogoDeInvalidacao
          ponto={invalidando}
          notificar={notificar}
          onClose={() => setInvalidando(null)}
          onPronto={() => concluir(setInvalidando)}
        />
      )}

      {restaurando && (
        <DialogoDeRestauracao
          ponto={restaurando}
          notificar={notificar}
          onClose={() => setRestaurando(null)}
          onPronto={() => concluir(setRestaurando)}
        />
      )}
    </div>
  );
}

function LinhaDeLancamento({ ponto, onCorrigir, onInvalidar, onRestaurar }) {
  const invalidado = Boolean(ponto.voidedAt);

  return (
    <tr className={invalidado ? 'linha-invalidada' : undefined}>
      <td data-rotulo="Atleta">
        {ponto.athlete?.fullName || '—'}
        {ponto.athlete?.affiliationNumber && (
          <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
            Matrícula {ponto.athlete.affiliationNumber}
          </small>
        )}
      </td>
      <td data-rotulo="Categoria">{ponto.category?.name || '—'}</td>
      <td data-rotulo="Classe">{ponto.competitionClass?.name || '—'}</td>
      <td className="num" data-rotulo="Colocação">{rotuloDaColocacao(ponto)}</td>
      <td className="num" data-rotulo="Pontos da colocação">{ponto.placementPoints}</td>
      <td className="num" data-rotulo="Bônus Overall">{ponto.overallBonus ? `+${ponto.overallBonus}` : '—'}</td>
      <td className="num" data-rotulo="Total"><strong>{ponto.points}</strong></td>
      <td data-rotulo="Situação">
        {invalidado
          ? (
            <>
              <Badge tom="perigo">Invalidado</Badge>
              {/* O motivo fica À VISTA, e não escondido atrás de um clique: é
                  ele que distingue correção de adulteração seis meses depois. */}
              <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{ponto.voidReason}</small>
            </>
          )
          : <Badge tom="ok">Válido</Badge>}
      </td>
      <td className="acoes-da-linha">
        {invalidado
          ? (
            <button type="button" className="button button-secondary button-sm" onClick={onRestaurar}>
              <RotateCcw size={14} /> Restaurar
            </button>
          )
          : (
            <>
              <button type="button" className="button button-secondary button-sm" onClick={onCorrigir}>
                <PencilLine size={14} /> Corrigir
              </button>
              <button type="button" className="button button-secondary button-sm" onClick={onInvalidar}>
                <Ban size={14} /> Invalidar
              </button>
            </>
          )}
      </td>
    </tr>
  );
}

// A PRÉVIA vem do servidor. A tela não recalcula nada por conta própria: se
// calculasse, passaria a existir uma segunda implementação da regra de
// pontuação, e as duas divergiriam no dia em que a tabela da temporada mudasse.
function DialogoDeCorrecao({ ponto, notificar, onClose, onPronto }) {
  const [naoCompareceu, setNaoCompareceu] = useState(Boolean(ponto.didNotShow));
  const [colocacao, setColocacao] = useState(ponto.placing != null ? String(ponto.placing) : '');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const colocacaoValida = naoCompareceu || /^\d+$/.test(colocacao.trim());
  const params = naoCompareceu ? { didNotShow: true } : { placing: Number(colocacao) };

  const previa = useFetch(
    () => (colocacaoValida ? api.ranking.previewPoint(ponto.id, params) : Promise.resolve(null)),
    [ponto.id, naoCompareceu, colocacao]
  );

  const confirmar = async () => {
    setEnviando(true);
    try {
      await api.ranking.editPoint(ponto.id, { ...params, reason: motivo.trim() });
      notificar?.('Lançamento corrigido.');
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || 'Não foi possível corrigir.', 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Corrigir lançamento"
      description={`${ponto.athlete?.fullName || 'Atleta'} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <Field label="Não compareceu (NS)">
        <label className="escolha">
          <input
            type="checkbox"
            checked={naoCompareceu}
            onChange={evento => setNaoCompareceu(evento.target.checked)}
          />
          <span>O atleta não subiu ao palco nesta classe</span>
        </label>
      </Field>

      {!naoCompareceu && (
        <Field label="Colocação" required hint="A pontuação é calculada pelo servidor. Do 6º em diante vale zero.">
          <input
            type="number"
            min="1"
            value={colocacao}
            onChange={evento => setColocacao(evento.target.value)}
          />
        </Field>
      )}

      {colocacaoValida && (
        <AsyncSection state={previa} linhas={2}>
          {dados => (dados ? <TabelaDoImpacto previa={dados} /> : null)}
        </AsyncSection>
      )}

      <Field label="Motivo da correção" required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder="Ex.: súmula oficial da organização corrigida"
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={confirmar}
          disabled={enviando || !colocacaoValida || motivo.trim().length < MOTIVO_MINIMO}
        >
          {enviando ? 'Corrigindo…' : 'Confirmar correção'}
        </button>
      </div>
    </Modal>
  );
}

function TabelaDoImpacto({ previa }) {
  return (
    <dl className="definicoes">
      <div><dt>Colocação antes</dt><dd>{rotuloDaColocacao(previa.atual)}</dd></div>
      <div><dt>Colocação depois</dt><dd>{rotuloDaColocacao(previa.novo)}</dd></div>
      <div><dt>Pontos antes</dt><dd>{previa.atual.points}</dd></div>
      <div><dt>Pontos depois</dt><dd><strong>{previa.novo.points}</strong></dd></div>
      <div>
        <dt>Diferença</dt>
        <dd><strong>{previa.diferenca > 0 ? `+${previa.diferenca}` : previa.diferenca}</strong></dd>
      </div>
    </dl>
  );
}

// INVALIDAR. O texto do diálogo diz o que a operação faz E o que ela não faz:
// sem isso o operador supõe que está apagando, e escolhe errado.
function DialogoDeInvalidacao({ ponto, notificar, onClose, onPronto }) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const invalidar = async () => {
    setEnviando(true);
    try {
      await api.ranking.voidPoint(ponto.id, { reason: motivo.trim() });
      notificar?.('Lançamento invalidado.');
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || 'Não foi possível invalidar.', 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Invalidar lançamento"
      description={`${ponto.athlete?.fullName || 'Atleta'} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>A participação NÃO é apagada.</strong>
          <p>
            Ela continua no histórico do atleta valendo zero, marcada como invalidada e com este
            motivo à vista. Perde os {ponto.points} ponto(s) e o bônus de Overall, se houver.
          </p>
        </div>
      </div>

      <Field label="Motivo da invalidação" required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder="Ex.: atleta desclassificado pela comissão técnica"
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={invalidar}
          disabled={enviando || motivo.trim().length < MOTIVO_MINIMO}
        >
          {enviando ? 'Invalidando…' : 'Invalidar lançamento'}
        </button>
      </div>
    </Modal>
  );
}

function DialogoDeRestauracao({ ponto, notificar, onClose, onPronto }) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const restaurar = async () => {
    setEnviando(true);
    try {
      await api.ranking.restorePoint(ponto.id, { reason: motivo.trim() });
      notificar?.('Lançamento restaurado.');
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || 'Não foi possível restaurar.', 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Restaurar lançamento"
      description={`${ponto.athlete?.fullName || 'Atleta'} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <div className="alert alert-ok" style={{ marginBottom: 14 }}>
        <History size={16} />
        <div>
          <strong>Volta ao estado de antes da invalidação.</strong>
          <p>
            A colocação {rotuloDaColocacao(ponto)} volta a pontuar pela tabela vigente da temporada,
            e não por um total congelado no momento da invalidação.
          </p>
        </div>
      </div>

      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>Invalidado por: {ponto.voidReason}</strong>
        </div>
      </div>

      <Field label="Motivo da restauração" required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder="Ex.: desclassificação revertida pela comissão"
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={restaurar}
          disabled={enviando || motivo.trim().length < MOTIVO_MINIMO}
        >
          {enviando ? 'Restaurando…' : 'Restaurar lançamento'}
        </button>
      </div>
    </Modal>
  );
}

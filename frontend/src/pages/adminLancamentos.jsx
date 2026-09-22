import { useState } from 'react';
import { AlertTriangle, Coins, History, PencilLine, RotateCcw, Ban } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { SeletorDeEvento } from './adminEvent';
import { AsyncSection, Badge, EmptyState, Field, Modal, PageHead } from '../components/ui';
import { formatarData } from '../lib/format';
import { useIdioma } from '../lib/idioma';

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
  const { t } = useIdioma();
  const [eventId, setEventId] = useState(null);
  const [corrigindo, setCorrigindo] = useState(null);
  const [ajustando, setAjustando] = useState(null);
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
        eyebrow={t('overall.ranking')}
        title={t('lancamento.titulo')}
        description={t('lancamento.descricao')}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? (
          <EmptyState
            title={t('overall.escolhaCampeonato')}
            description={t('lancamento.escolhaCampeonato')}
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
                      <span>{t('lancamento.contagem', { n: dados.items.length })}</span>
                      <span>{t('lancamento.invalidados', { n: dados.items.filter(p => p.voidedAt).length })}</span>
                    </div>
                  </section>

                  {!dados.items.length
                    ? (
                      <EmptyState
                        title={t('lancamento.nenhum')}
                        description={t('lancamento.nenhumDescricao')}
                      />
                    )
                    : (
                      <section className="panel" style={{ marginTop: 18 }}>
                        <div className="table-wrap">
                          <table className="table lancamentos-tabela">
                            <thead>
                              <tr>
                                <th>{t('overall.atleta')}</th>
                                <th>{t('overall.categoria')}</th>
                                <th>{t('lancamento.classe')}</th>
                                <th className="num">{t('overall.colocacaoCurta')}</th>
                                <th className="num">{t('overall.colocacao')}</th>
                                <th className="num">{t('overall.bonusOverall')}</th>
                                <th className="num">{t('lancamento.pontos')}</th>
                                <th>{t('conta.situacao')}</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {dados.items.map(ponto => (
                                <LinhaDeLancamento
                                  key={ponto.id}
                                  ponto={ponto}
                                  onCorrigir={() => setCorrigindo(ponto)}
                                  onAjustar={() => setAjustando(ponto)}
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

      {ajustando && (
        <DialogoDeAjuste
          ponto={ajustando}
          evento={estado.data?.event ?? null}
          notificar={notificar}
          onClose={() => setAjustando(null)}
          onPronto={() => concluir(setAjustando)}
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

// O NOME DO COMPETIDOR, TENHA ELE CADASTRO OU NÃO.
//
// Resultado histórico importado antes do cadastro não tem `athlete` — e é a
// maior parte do que o operador vem conferir. Mostrar "—" ali deixava a tela
// inutilizável justamente no caso que ela existe para atender.
const nomeDoCompetidor = ponto => ponto.athlete?.fullName
  || ponto.externalAthlete?.displayName
  || '—';

// A classe do evento quando há evento do MCI; a do catálogo no histórico
// importado, onde `competitionClass` é sempre nula.
const nomeDaClasse = ponto => ponto.competitionClass?.name
  || ponto.catalogClass?.displayName
  || ponto.catalogClass?.name
  || '—';

function LinhaDeLancamento({ ponto, onCorrigir, onAjustar, onInvalidar, onRestaurar }) {
  const { t } = useIdioma();
  const invalidado = Boolean(ponto.voidedAt);

  return (
    <tr className={invalidado ? 'linha-invalidada' : undefined}>
      <td data-rotulo={t('overall.atleta')}>
        {nomeDoCompetidor(ponto)}
        {ponto.athlete?.affiliationNumber && (
          <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
            {t('lancamento.matricula', { numero: ponto.athlete.affiliationNumber })}
          </small>
        )}
      </td>
      <td data-rotulo={t('overall.categoria')}>{ponto.category?.name || '—'}</td>
      <td data-rotulo={t('lancamento.classe')}>{nomeDaClasse(ponto)}</td>
      <td className="num" data-rotulo={t('overall.colocacao')}>{rotuloDaColocacao(ponto)}</td>
      <td className="num" data-rotulo={t('overall.pontosDaColocacao')}>{ponto.placementPoints}</td>
      <td className="num" data-rotulo={t('overall.bonusOverall')}>{ponto.overallBonus ? `+${ponto.overallBonus}` : '—'}</td>
      <td className="num" data-rotulo={t('carreira.colunaTotal')}><strong>{ponto.points}</strong></td>
      <td data-rotulo={t('conta.situacao')}>
        {invalidado
          ? (
            <>
              <Badge tom="perigo">{t('lancamento.invalidado')}</Badge>
              {/* O motivo fica À VISTA, e não escondido atrás de um clique: é
                  ele que distingue correção de adulteração seis meses depois. */}
              <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>{ponto.voidReason}</small>
            </>
          )
          : <Badge tom="ok">{t('lancamento.valido')}</Badge>}
      </td>
      <td className="acoes-da-linha">
        {invalidado
          ? (
            <button type="button" className="button button-secondary button-sm" onClick={onRestaurar}>
              <RotateCcw size={14} /> {t('lancamento.restaurar')}
            </button>
          )
          : (
            <>
              <button type="button" className="button button-secondary button-sm" onClick={onCorrigir}>
                <PencilLine size={14} /> {t('lancamento.corrigir')}
              </button>
              {/* CORRIGIR e AJUSTAR são coisas diferentes, e é por isso que
                  são dois botões. Corrigir conserta a COLOCAÇÃO e deixa o
                  motor recalcular; ajustar muda a PONTUAÇÃO por decisão de
                  homologação, com a colocação intacta. Um botão só obrigaria
                  o operador a escolher no escuro. */}
              <button type="button" className="button button-secondary button-sm" onClick={onAjustar}>
                <Coins size={14} /> {t('ajuste.acao')}
              </button>
              <button type="button" className="button button-secondary button-sm" onClick={onInvalidar}>
                <Ban size={14} /> {t('acao.invalidar')}
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
  const { t } = useIdioma();
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
      notificar?.(t('lancamento.corrigidoAviso'));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || t('lancamento.falhaAoCorrigir'), 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t('lancamento.corrigirLancamento')}
      description={`${ponto.athlete?.fullName || t('overall.atleta')} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <Field label={t('lancamento.naoCompareceu')}>
        <label className="escolha">
          <input
            type="checkbox"
            checked={naoCompareceu}
            onChange={evento => setNaoCompareceu(evento.target.checked)}
          />
          <span>{t('lancamento.naoSubiuAoPalco')}</span>
        </label>
      </Field>

      {!naoCompareceu && (
        <Field label={t('overall.colocacao')} required hint={t('lancamento.colocacaoHint')}>
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

      <Field label={t('lancamento.motivoDaCorrecao')} required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder={t('lancamento.exemploCorrecao')}
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          {t('acao.cancelar')}
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={confirmar}
          disabled={enviando || !colocacaoValida || motivo.trim().length < MOTIVO_MINIMO}
        >
          {t(enviando ? 'lancamento.corrigindo' : 'lancamento.confirmarCorrecao')}
        </button>
      </div>
    </Modal>
  );
}

function TabelaDoImpacto({ previa }) {
  const { t } = useIdioma();

  return (
    <dl className="definicoes">
      <div><dt>{t('lancamento.colocacaoAntes')}</dt><dd>{rotuloDaColocacao(previa.atual)}</dd></div>
      <div><dt>{t('lancamento.colocacaoDepois')}</dt><dd>{rotuloDaColocacao(previa.novo)}</dd></div>
      <div><dt>{t('lancamento.pontosAntes')}</dt><dd>{previa.atual.points}</dd></div>
      <div><dt>{t('lancamento.pontosDepois')}</dt><dd><strong>{previa.novo.points}</strong></dd></div>
      <div>
        <dt>{t('lancamento.diferenca')}</dt>
        <dd><strong>{previa.diferenca > 0 ? `+${previa.diferenca}` : previa.diferenca}</strong></dd>
      </div>
    </dl>
  );
}

// INVALIDAR. O texto do diálogo diz o que a operação faz E o que ela não faz:
// sem isso o operador supõe que está apagando, e escolhe errado.
// ============================================================================
// AJUSTE ADMINISTRATIVO DA PONTUAÇÃO.
//
// O modal mostra o CONTEXTO INTEIRO antes do campo editável — atleta,
// categoria, classe, campeonato, temporada e colocação. Não é enfeite: quem
// vai mudar um número de pontuação precisa ver em qual participação está
// mexendo, e a linha da tabela some atrás do modal.
//
// A confirmação é explícita — "5 → 4", com a diferença — porque o erro que
// este modal precisa impedir é o de digitar no campo errado, e um número
// sozinho não denuncia isso.
//
// `expectedPoints` viaja com o envio: é o valor que estava na tela quando o
// operador decidiu. Se outro operador tiver alterado nesse meio-tempo, o
// servidor recusa e a tela pede atualização, em vez de gravar por cima de uma
// decisão que ninguém viu.
// ============================================================================
function DialogoDeAjuste({ ponto, evento, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [valor, setValor] = useState(String(ponto.points));
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const novo = Number.parseInt(valor, 10);
  const valorValido = Number.isInteger(novo) && novo >= 0;
  const diferenca = valorValido ? novo - ponto.points : 0;
  const motivoValido = motivo.trim().length >= 5;
  // Mudar para o mesmo valor não é ajuste: é um registro de auditoria sem
  // fato por trás.
  const podeEnviar = valorValido && motivoValido && diferenca !== 0 && !enviando;

  const enviar = async () => {
    if (!podeEnviar) return;
    setEnviando(true);
    try {
      await api.ranking.adjustPoint(ponto.id, {
        points: novo,
        expectedPoints: ponto.points,
        reason: motivo.trim()
      });
      notificar?.({ tom: 'ok', texto: t('ajuste.registrado') });
      onPronto();
    } catch (erro) {
      notificar?.({ tom: 'perigo', texto: erro?.message || t('ajuste.falhou') });
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('ajuste.titulo')} description={t('ajuste.descricao')} onClose={onClose}>
      <dl className="lista-revisao">
        <div><dt>{t('overall.atleta')}</dt><dd>{nomeDoCompetidor(ponto)}</dd></div>
        <div><dt>{t('overall.categoria')}</dt><dd>{ponto.category?.name || '—'}</dd></div>
        <div><dt>{t('lancamento.classe')}</dt><dd>{nomeDaClasse(ponto)}</dd></div>
        <div><dt>{t('publico.campeonato')}</dt><dd>{evento?.name || '—'}</dd></div>
        <div>
          <dt>{t('publico.temporada')}</dt>
          <dd>{evento?.season ? `${evento.season.name} (${evento.season.year})` : '—'}</dd>
        </div>
        <div><dt>{t('overall.colocacao')}</dt><dd>{rotuloDaColocacao(ponto)}</dd></div>
        <div><dt>{t('ajuste.pontosAtuais')}</dt><dd><strong>{ponto.points}</strong></dd></div>
      </dl>

      <Field label={t('ajuste.novoValor')} required>
        <input
          className="input-control"
          type="number"
          min="0"
          value={valor}
          onChange={evt => setValor(evt.target.value)}
        />
      </Field>

      <Field label={t('ajuste.motivo')} required hint={t('ajuste.motivoAjuda')}>
        <textarea
          className="input-control"
          rows={3}
          value={motivo}
          onChange={evt => setMotivo(evt.target.value)}
        />
      </Field>

      {valorValido && diferenca !== 0 && (
        <div className="alert alert-info" role="status">
          <div>
            <strong>{ponto.points} → {novo}</strong>
            <p>{t('ajuste.diferenca')}: {diferenca > 0 ? `+${diferenca}` : diferenca}</p>
          </div>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button" disabled={!podeEnviar} onClick={enviar}>
          {enviando ? t('ajuste.enviando') : t('ajuste.confirmar')}
        </button>
      </div>
    </Modal>
  );
}

function DialogoDeInvalidacao({ ponto, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const invalidar = async () => {
    setEnviando(true);
    try {
      await api.ranking.voidPoint(ponto.id, { reason: motivo.trim() });
      notificar?.(t('lancamento.invalidadoAviso'));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || t('lancamento.falhaAoInvalidar'), 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t('lancamento.invalidarLancamento')}
      description={`${ponto.athlete?.fullName || t('overall.atleta')} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>{t('lancamento.naoEApagada')}</strong>
          <p>{t('lancamento.naoEApagadaTexto', { pontos: ponto.points })}</p>
        </div>
      </div>

      <Field label={t('lancamento.motivoDaInvalidacao')} required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder={t('lancamento.exemploInvalidacao')}
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          {t('acao.cancelar')}
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={invalidar}
          disabled={enviando || motivo.trim().length < MOTIVO_MINIMO}
        >
          {t(enviando ? 'lancamento.invalidando' : 'lancamento.invalidarLancamento')}
        </button>
      </div>
    </Modal>
  );
}

function DialogoDeRestauracao({ ponto, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const restaurar = async () => {
    setEnviando(true);
    try {
      await api.ranking.restorePoint(ponto.id, { reason: motivo.trim() });
      notificar?.(t('lancamento.restauradoAviso'));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || t('lancamento.falhaAoRestaurar'), 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t('lancamento.restaurarLancamento')}
      description={`${ponto.athlete?.fullName || t('overall.atleta')} · ${ponto.competitionClass?.name || ''}`}
      onClose={onClose}
    >
      <div className="alert alert-ok" style={{ marginBottom: 14 }}>
        <History size={16} />
        <div>
          <strong>{t('lancamento.voltaAoEstado')}</strong>
          <p>{t('lancamento.voltaAoEstadoTexto', { colocacao: rotuloDaColocacao(ponto) })}</p>
        </div>
      </div>

      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>{t('lancamento.invalidadoPor', { motivo: ponto.voidReason })}</strong>
        </div>
      </div>

      <Field label={t('lancamento.motivoDaRestauracao')} required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder={t('lancamento.exemploRestauracao')}
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          {t('acao.cancelar')}
        </button>
        <button
          type="button"
          className="button button-primary"
          onClick={restaurar}
          disabled={enviando || motivo.trim().length < MOTIVO_MINIMO}
        >
          {t(enviando ? 'lancamento.restaurando' : 'lancamento.restaurarLancamento')}
        </button>
      </div>
    </Modal>
  );
}

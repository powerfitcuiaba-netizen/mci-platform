import { useState } from 'react';
import { AlertTriangle, ShieldCheck, Trophy } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { SeletorDeEvento } from './adminEvent';
import { AsyncSection, Badge, EmptyState, Field, Modal, PageHead } from '../components/ui';
import { formatarData, formatarDataHora } from '../lib/format';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// HOMOLOGAÇÃO DO OVERALL.
//
// Esta tela REGISTRA uma decisão. Ela não a toma, não a sugere e não a
// insinua. Três consequências de projeto, e cada uma tem teste:
//
//   * só classes ABSOLUTAS aparecem — a API já as filtra, e a tela não
//     acrescenta nenhuma por conta própria;
//   * o 1º lugar NÃO é destacado como campeão Overall. A colocação aparece
//     porque é fato do resultado publicado; todos os candidatos têm o mesmo
//     botão, e nenhum vem pré-selecionado;
//   * declarar exige DOIS passos: o clique abre a prévia com a conta aberta, e
//     só a confirmação explícita grava.
//
// Corrigir é operação própria: revogar, com motivo obrigatório, e declarar de
// novo. Substituir em silêncio era o comportamento antigo, e foi classificado
// como defeito na auditoria da FASE 10.
// ==========================================================================

export function AdminOverall({ notificar }) {
  const [eventId, setEventId] = useState(null);
  const [declarando, setDeclarando] = useState(null);
  const [revogando, setRevogando] = useState(null);
  const [recarga, setRecarga] = useState(0);

  const estado = useFetch(
    () => (eventId ? api.ranking.overallCandidates(eventId) : Promise.resolve(null)),
    [eventId, recarga]
  );

  const { t } = useIdioma();
  const recarregar = () => setRecarga(n => n + 1);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('overall.ranking')}
        title={t('overall.titulo')}
        description={t('overall.descricao')}
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? <EmptyState title={t('overall.escolhaCampeonato')} description={t('overall.escolhaCampeonatoDescricao')} />
        : (
          <AsyncSection state={estado} linhas={4}>
            {dados => {
              if (!dados) return null;

              return (
                <>
                  <section className="panel">
                    <div className="panel-head"><h2>{dados.event.name}</h2></div>
                    <div className="hero-meta" style={{ padding: '0 0 10px' }}>
                      <span>{formatarData(dados.event.startDate)}</span>
                      <span>{dados.event.season?.name || t('overall.semTemporada')}</span>
                      <span>{dados.event.organization?.name}</span>
                    </div>
                  </section>

                  {!dados.items.length
                    ? (
                      <EmptyState
                        title={t('overall.semClasseAbsoluta')}
                        description={t('overall.semClasseAbsolutaDescricao')}
                      />
                    )
                    : dados.items.map(grupo => (
                      <GrupoAbsoluto
                        key={grupo.competitionClass.id}
                        grupo={grupo}
                        onDeclarar={candidato => setDeclarando({ grupo, candidato })}
                        onRevogar={() => setRevogando(grupo)}
                      />
                    ))}
                </>
              );
            }}
          </AsyncSection>
        )}

      {declarando && (
        <DialogoDeHomologacao
          eventId={eventId}
          grupo={declarando.grupo}
          candidato={declarando.candidato}
          notificar={notificar}
          onClose={() => setDeclarando(null)}
          onPronto={() => { setDeclarando(null); recarregar(); }}
        />
      )}

      {revogando && (
        <DialogoDeRevogacao
          eventId={eventId}
          grupo={revogando}
          notificar={notificar}
          onClose={() => setRevogando(null)}
          onPronto={() => { setRevogando(null); recarregar(); }}
        />
      )}
    </div>
  );
}

function GrupoAbsoluto({ grupo, onDeclarar, onRevogar }) {
  const { t } = useIdioma();
  const homologado = Boolean(grupo.declaredTitle);
  const campeao = homologado
    ? grupo.candidates.find(c => c.athlete.id === grupo.declaredTitle.athleteId)
    : null;

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head">
        <h2>
          {grupo.category?.name || '—'} · {grupo.competitionClass.name}
          <small style={{ display: 'block', color: 'var(--cinza-fraco)', fontWeight: 400 }}>
            {grupo.division?.name}
          </small>
        </h2>
        {homologado
          ? <Badge tom="ok">{t('overall.homologado')}</Badge>
          : <Badge tom="neutro">{t('overall.semHomologacao')}</Badge>}
      </div>

      {homologado && (
        <div className="alert alert-ok" style={{ marginBottom: 14 }}>
          <Trophy size={16} />
          <div>
            <strong>{t('overall.declaradoOficialmente')}</strong>
            <p>
              {campeao?.athlete.fullName || t('overall.atletaHomologado')}
              {' · '}{t('overall.homologadoEm', { data: formatarDataHora(grupo.declaredTitle.declaredAt) })}
            </p>
          </div>
          <button type="button" className="button button-secondary button-sm" onClick={onRevogar}>
            {t('overall.revogar')}
          </button>
        </div>
      )}

      {!grupo.candidates.length
        ? <EmptyState title={t('overall.semResultadoPublicado')} description={t('overall.semResultadoDescricao')} />
        : (
          <div className="table-wrap">
            <table className="table homologacao-tabela">
              <thead>
                <tr>
                  <th className="num">{t('overall.colocacaoCurta')}</th>
                  <th>{t('overall.atleta')}</th>
                  <th className="num">{t('overall.matricula')}</th>
                  <th>{t('overall.filiacao')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grupo.candidates.map(candidato => (
                  <tr key={candidato.athlete.id}>
                    {/* A colocação é FATO do resultado publicado. Não é
                        destaque, não é sugestão e não muda de cor no 1º
                        lugar — quem escolhe o Overall é o operador. */}
                    <td className="num" data-rotulo={t('overall.colocacao')}>{candidato.placing ?? '—'}º</td>
                    <td data-rotulo={t('overall.atleta')}>{candidato.athlete.fullName}</td>
                    <td className="num" data-rotulo={t('overall.matricula')}>{candidato.affiliationNumber || '—'}</td>
                    <td data-rotulo={t('overall.filiacao')}>{candidato.affiliation?.name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!homologado && (
                        <button
                          type="button"
                          className="button button-secondary button-sm"
                          onClick={() => onDeclarar(candidato)}
                        >
                          {t('overall.declararOverall')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

// A PRÉVIA. Busca do servidor o impacto exato e mostra a conta aberta antes de
// qualquer escrita — e o servidor, por sua vez, não grava nada para respondê-la.
function DialogoDeHomologacao({ eventId, grupo, candidato, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);
  const previa = useFetch(
    () => api.ranking.overallPreview(eventId, { athleteId: candidato.athlete.id, categoryId: grupo.category?.id }),
    [eventId, candidato.athlete.id]
  );

  const confirmar = async () => {
    setEnviando(true);
    try {
      await api.ranking.declararOverall(eventId, {
        athleteId: candidato.athlete.id,
        ...(grupo.category?.id ? { categoryId: grupo.category.id } : {})
      });
      notificar?.(t('overall.homologadoAviso'));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || t('overall.falhaAoHomologar'), 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t('overall.titulo')}
      description={t('overall.confiraOImpacto')}
      onClose={onClose}
    >
      <AsyncSection state={previa} linhas={3}>
        {dados => (
          <>
            <dl className="definicoes">
              <div><dt>{t('overall.campeonato')}</dt><dd>{dados.event.name}</dd></div>
              <div><dt>{t('overall.categoria')}</dt><dd>{dados.category?.name || '—'} · {dados.competitionClass?.name}</dd></div>
              <div><dt>{t('overall.atleta')}</dt><dd>{dados.athlete.fullName}</dd></div>
              <div><dt>{t('overall.matricula')}</dt><dd>{dados.athlete.affiliationNumber || '—'}</dd></div>
              <div><dt>{t('overall.filiacao')}</dt><dd>{dados.athlete.affiliation?.name || '—'}</dd></div>
              <div><dt>{t('overall.colocacao')}</dt><dd>{dados.participation.placing}º</dd></div>
              <div><dt>{t('overall.pontosDaColocacao')}</dt><dd>{dados.participation.placementPoints}</dd></div>
              <div><dt>{t('overall.bonusOverall')}</dt><dd><strong>+{dados.overallBonus}</strong></dd></div>
              <div><dt>{t('overall.totalDaParticipacao')}</dt><dd><strong>{dados.participation.pointsAfter}</strong></dd></div>
              <div><dt>{t('overall.impactoNoAcumulado')}</dt><dd>+{dados.seasonImpact}</dd></div>
            </dl>

            <div className="alert alert-alerta" style={{ marginTop: 14 }}>
              <ShieldCheck size={16} />
              <div>
                <strong>{t('overall.declaracaoOficial')}</strong>
                <p>{t('overall.naoCalculamos')}</p>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
                {t('acao.cancelar')}
              </button>
              <button type="button" className="button button-primary" onClick={confirmar} disabled={enviando}>
                {t(enviando ? 'overall.homologando' : 'overall.confirmarHomologacao')}
              </button>
            </div>
          </>
        )}
      </AsyncSection>
    </Modal>
  );
}

// REVOGAÇÃO. Motivo obrigatório: revogar título homologado sem dizer por quê
// deixa o próximo operador sem saber o que já foi analisado.
function DialogoDeRevogacao({ eventId, grupo, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const revogar = async () => {
    setEnviando(true);
    try {
      await api.ranking.revokeOverall(eventId, grupo.declaredTitle.id, { reason: motivo.trim() });
      notificar?.(t('overall.revogadaAviso'));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || t('overall.falhaAoRevogar'), 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t('overall.revogarHomologacao')}
      description={t('overall.revogarDescricao')}
      onClose={onClose}
    >
      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>{t('overall.corrigeDecisao')}</strong>
          <p>{t('overall.motivoNaAuditoria')}</p>
        </div>
      </div>

      <Field label={t('overall.motivoDaRevogacao')} required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder={t('overall.exemploDeMotivo')}
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          {t('acao.cancelar')}
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={revogar}
          disabled={enviando || motivo.trim().length < 3}
        >
          {t(enviando ? 'overall.revogando' : 'overall.revogarHomologacao')}
        </button>
      </div>
    </Modal>
  );
}

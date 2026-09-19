import { useState } from 'react';
import { AlertTriangle, ShieldCheck, Trophy } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { SeletorDeEvento } from './adminEvent';
import { AsyncSection, Badge, EmptyState, Field, Modal, PageHead } from '../components/ui';
import { formatarData, formatarDataHora } from '../lib/format';

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

  const recarregar = () => setRecarga(n => n + 1);

  return (
    <div className="page">
      <PageHead
        eyebrow="Ranking"
        title="Homologação do Overall"
        description="Registro da decisão oficial da organização. A plataforma não calcula nem escolhe o campeão Overall."
      />

      <div className="toolbar">
        <SeletorDeEvento eventId={eventId} onChange={setEventId} />
      </div>

      {!eventId
        ? <EmptyState title="Escolha um campeonato" description="A homologação é por campeonato e por classe absoluta." />
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
                      <span>{dados.event.season?.name || 'Sem temporada'}</span>
                      <span>{dados.event.organization?.name}</span>
                    </div>
                  </section>

                  {!dados.items.length
                    ? (
                      <EmptyState
                        title="Nenhuma classe absoluta neste campeonato"
                        description="O título Overall é da classe absoluta. Sem uma classe marcada como absoluta, não há o que homologar."
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
          ? <Badge tom="ok">Homologado</Badge>
          : <Badge tom="neutro">Sem homologação</Badge>}
      </div>

      {homologado && (
        <div className="alert alert-ok" style={{ marginBottom: 14 }}>
          <Trophy size={16} />
          <div>
            <strong>Overall declarado oficialmente</strong>
            <p>
              {campeao?.athlete.fullName || 'Atleta homologado'}
              {' · '}homologado em {formatarDataHora(grupo.declaredTitle.declaredAt)}
            </p>
          </div>
          <button type="button" className="button button-secondary button-sm" onClick={onRevogar}>
            Revogar
          </button>
        </div>
      )}

      {!grupo.candidates.length
        ? <EmptyState title="Sem resultado publicado" description="Os candidatos aparecem quando o resultado desta classe é publicado." />
        : (
          <div className="table-wrap">
            <table className="table homologacao-tabela">
              <thead>
                <tr>
                  <th className="num">Col.</th>
                  <th>Atleta</th>
                  <th className="num">Matrícula</th>
                  <th>Filiação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grupo.candidates.map(candidato => (
                  <tr key={candidato.athlete.id}>
                    {/* A colocação é FATO do resultado publicado. Não é
                        destaque, não é sugestão e não muda de cor no 1º
                        lugar — quem escolhe o Overall é o operador. */}
                    <td className="num" data-rotulo="Colocação">{candidato.placing ?? '—'}º</td>
                    <td data-rotulo="Atleta">{candidato.athlete.fullName}</td>
                    <td className="num" data-rotulo="Matrícula">{candidato.affiliationNumber || '—'}</td>
                    <td data-rotulo="Filiação">{candidato.affiliation?.name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!homologado && (
                        <button
                          type="button"
                          className="button button-secondary button-sm"
                          onClick={() => onDeclarar(candidato)}
                        >
                          Declarar Overall
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
      notificar?.('Overall homologado.');
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || 'Não foi possível homologar.', 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Homologação do Overall"
      description="Confira o impacto antes de confirmar."
      onClose={onClose}
    >
      <AsyncSection state={previa} linhas={3}>
        {dados => (
          <>
            <dl className="definicoes">
              <div><dt>Campeonato</dt><dd>{dados.event.name}</dd></div>
              <div><dt>Categoria</dt><dd>{dados.category?.name || '—'} · {dados.competitionClass?.name}</dd></div>
              <div><dt>Atleta</dt><dd>{dados.athlete.fullName}</dd></div>
              <div><dt>Matrícula</dt><dd>{dados.athlete.affiliationNumber || '—'}</dd></div>
              <div><dt>Filiação</dt><dd>{dados.athlete.affiliation?.name || '—'}</dd></div>
              <div><dt>Colocação</dt><dd>{dados.participation.placing}º</dd></div>
              <div><dt>Pontos da colocação</dt><dd>{dados.participation.placementPoints}</dd></div>
              <div><dt>Bônus Overall</dt><dd><strong>+{dados.overallBonus}</strong></dd></div>
              <div><dt>Total da participação</dt><dd><strong>{dados.participation.pointsAfter}</strong></dd></div>
              <div><dt>Impacto no acumulado</dt><dd>+{dados.seasonImpact}</dd></div>
            </dl>

            <div className="alert alert-alerta" style={{ marginTop: 14 }}>
              <ShieldCheck size={16} />
              <div>
                <strong>Esta ação registra uma declaração oficial de Overall.</strong>
                <p>A plataforma não calcula e não decide o campeão.</p>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
                Cancelar
              </button>
              <button type="button" className="button button-primary" onClick={confirmar} disabled={enviando}>
                {enviando ? 'Homologando…' : 'Confirmar homologação'}
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
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const revogar = async () => {
    setEnviando(true);
    try {
      await api.ranking.revokeOverall(eventId, grupo.declaredTitle.id, { reason: motivo.trim() });
      notificar?.('Homologação revogada.');
      onPronto();
    } catch (erro) {
      notificar?.(erro.message || 'Não foi possível revogar.', 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Revogar homologação"
      description="A revogação retira o bônus de +10. A colocação não é alterada."
      onClose={onClose}
    >
      <div className="alert alert-alerta" style={{ marginBottom: 14 }}>
        <AlertTriangle size={16} />
        <div>
          <strong>Isto corrige uma decisão oficial já registrada.</strong>
          <p>O motivo fica na auditoria, junto de quem revogou e de quando.</p>
        </div>
      </div>

      <Field label="Motivo da revogação" required>
        <textarea
          value={motivo}
          onChange={evento => setMotivo(evento.target.value)}
          rows={3}
          placeholder="Ex.: ata oficial corrigida pela organização"
        />
      </Field>

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={enviando}>
          Cancelar
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={revogar}
          disabled={enviando || motivo.trim().length < 3}
        >
          {enviando ? 'Revogando…' : 'Revogar homologação'}
        </button>
      </div>
    </Modal>
  );
}

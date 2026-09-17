import { BadgeCheck, IdCard, Trophy } from 'lucide-react';
import api from '../services/api';
import { useFetch, useListaPaginada } from '../lib/hooks';
import { AsyncSection, Badge, EmptyState, Metric, PageHead } from '../components/ui';
import { formatarData } from '../lib/format';

// ==========================================================================
// MINHA FILIAÇÃO E MEU HISTÓRICO.
//
// As duas telas do atleta sobre a própria carreira. Ambas leem rotas que NÃO
// aceitam identificador de pessoa (`/me/affiliation`, `/me/history`): o
// backend deriva o atleta do token. Não há id para esta tela passar, e por
// isso não há id para ela passar errado.
//
// A regra que governa a apresentação é a mesma do motor: colocação e bônus são
// PARCELAS, exibidas separadas. "15 pontos" numa coluna só esconderia que 5
// vieram do pódio e 10 do título — e é justamente essa confusão que a regra
// vigente do Overall existe para impedir.
// ==========================================================================

export function MinhaFiliacao() {
  const estado = useFetch(() => api.me.affiliation(), []);

  return (
    <div className="page">
      <PageHead
        eyebrow="Meu espaço"
        title="Minha filiação"
        description="A entidade pela qual você compete e o seu número de registro nela."
      />

      <AsyncSection state={estado} linhas={3}>
        {dados => {
          if (!dados.athlete) {
            return (
              <EmptyState
                title="Você ainda não tem perfil de atleta"
                description="Competir exige filiação confirmada pela federação. Envie sua solicitação com CPF, entidade de filiação e número de registro — um operador analisa."
              />
            );
          }

          if (!dados.affiliation) {
            // Dizer "sem filiação" é diferente de mostrar um campo em branco: o
            // branco parece erro de carregamento, e a pessoa fica esperando.
            return (
              <EmptyState
                title="Sem filiação registrada"
                description={`Seu perfil existe em ${dados.organization?.name || 'sua organização'}, mas nenhuma entidade de filiação está vinculada a ele. A federação é quem registra o vínculo e o número.`}
              />
            );
          }

          return (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>{dados.affiliation.name}</h2>
                  <Badge tom={dados.affiliation.active ? 'ok' : 'neutro'}>
                    {dados.affiliation.active ? 'Ativa' : 'Inativa'}
                  </Badge>
                </div>

                <div className="grid grid-3" style={{ padding: '4px 0 12px' }}>
                  <Metric label="Código da entidade" value={dados.affiliation.code || '—'} />
                  {/* A MATRÍCULA. É o "Member Number" dos resultados oficiais —
                      a metade da filiação pela qual o resultado reconhece a
                      pessoa. Não confundir com o número de atleta. */}
                  <Metric label="Minha matrícula" value={dados.affiliationNumber || '—'} destaque />
                  <Metric label="UF" value={dados.affiliation.state || '—'} />
                </div>

                <p className="hint" style={{ margin: 0 }}>
                  <IdCard size={14} style={{ verticalAlign: '-2px' }} />{' '}
                  Organização: <strong>{dados.organization?.name || '—'}</strong>.
                  {' '}A entidade e o número são registrados pela federação — se algo estiver
                  errado, fale com um operador.
                </p>
              </section>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

const POR_PAGINA = 20;

export function MeuHistorico() {
  const lista = useListaPaginada(
    cursor => api.me.history({ limit: POR_PAGINA, cursor: cursor || undefined }),
    []
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="Meu espaço"
        title="Meu histórico"
        description="Cada participação que pontuou, com a conta aberta: colocação, bônus de Overall e total."
      />

      <AsyncSection state={lista} linhas={4}>
        {dados => {
          if (!dados.items.length) {
            return (
              <EmptyState
                title="Você ainda não pontuou"
                description="Assim que um resultado for publicado e a etapa estiver vinculada a uma temporada, sua participação aparece aqui."
              />
            );
          }

          const totais = dados.totals || {};

          return (
            <>
              <div className="grid grid-4">
                <Metric label="Participações" value={totais.participations ?? dados.total} />
                <Metric label="Pontos de colocação" value={totais.placementPoints ?? 0} />
                <Metric label="Bônus Overall" value={totais.overallBonus ?? 0} />
                <Metric label="Total" value={totais.points ?? 0} destaque />
              </div>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-head"><h2>Participações</h2></div>

                <div className="table-wrap">
                  <table className="table historico-tabela">
                    <thead>
                      <tr>
                        <th>Campeonato</th>
                        <th>Categoria · classe</th>
                        <th className="num">Col.</th>
                        <th className="num">Colocação</th>
                        <th className="num">Overall</th>
                        <th className="num">Total</th>
                        <th>Filiação na época</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.items.map(ponto => (
                        <tr key={ponto.id}>
                          <td>
                            {ponto.event?.name || ponto.externalResult?.eventName || '—'}
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
                              {formatarData(ponto.event?.startDate || ponto.externalResult?.eventDate) || ponto.season?.name || '—'}
                            </small>
                          </td>
                          <td data-rotulo="Categoria">
                            {ponto.category?.name || '—'}
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
                              {ponto.competitionClass?.name || ponto.competitionClass?.code || '—'}
                            </small>
                          </td>
                          <td className="num" data-rotulo="Colocação">{ponto.placing ?? '—'}</td>
                          <td className="num" data-rotulo="Pts colocação">{ponto.placementPoints}</td>
                          {/* O bônus é do CAMPEÃO DA ABSOLUTA e de mais ninguém.
                              Numa participação sem título a célula fica em
                              zero discreto — mostrar "+10" aqui seria afirmar
                              um título que não existe. */}
                          <td className="num" data-rotulo="Overall">
                            {ponto.overallBonus > 0
                              ? (
                                <span title="Campeão Overall">
                                  <strong>+{ponto.overallBonus}</strong>{' '}
                                  <Trophy size={13} style={{ verticalAlign: '-2px' }} aria-label="Campeão Overall" />
                                </span>
                              )
                              : <span style={{ color: 'var(--cinza-fraco)' }}>0</span>}
                          </td>
                          <td className="num" data-rotulo="Total"><strong>{ponto.points}</strong></td>
                          <td data-rotulo="Filiação">
                            {/* Filiação DA ÉPOCA, gravada no ponto. Nula quando
                                o lançamento é anterior ao registro do snapshot:
                                aí a tela diz que não há retrato, em vez de
                                mostrar a filiação de hoje ao lado de um
                                resultado de ontem. */}
                            {ponto.affiliation
                              ? (
                                <>
                                  {ponto.affiliation.name}
                                  {ponto.affiliationNumber && (
                                    <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
                                      nº {ponto.affiliationNumber}
                                    </small>
                                  )}
                                </>
                              )
                              : <span style={{ color: 'var(--cinza-fraco)' }}>não registrada</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {lista.nextCursor && (
                  <div className="panel-foot">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={lista.carregarMais}
                      disabled={lista.carregandoMais}
                    >
                      {lista.carregandoMais ? 'Carregando…' : 'Carregar mais'}
                    </button>
                  </div>
                )}

                <p className="hint" style={{ margin: '10px 0 0' }}>
                  <BadgeCheck size={14} style={{ verticalAlign: '-2px' }} />{' '}
                  Mostrando {dados.items.length} de {dados.total} participação(ões).
                  O bônus de Overall é da classe absoluta e vale uma vez por título.
                </p>
              </section>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

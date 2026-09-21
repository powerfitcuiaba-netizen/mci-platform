import { BadgeCheck, IdCard, Trophy } from 'lucide-react';
import api from '../services/api';
import { useFetch, useListaPaginada } from '../lib/hooks';
import { AsyncSection, Badge, EmptyState, Metric, PageHead } from '../components/ui';
import { formatarData } from '../lib/format';
import { useIdioma } from '../lib/idioma';

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
  const { t } = useIdioma();
  const estado = useFetch(() => api.me.affiliation(), []);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('carreira.meuEspaco')}
        title={t('carreira.minhaFiliacao')}
        description={t('carreira.minhaFiliacaoDescricao')}
      />

      <AsyncSection state={estado} linhas={3}>
        {dados => {
          if (!dados.athlete) {
            return (
              <EmptyState
                title={t('carreira.semPerfil')}
                description={t('carreira.semPerfilDescricao')}
              />
            );
          }

          if (!dados.affiliation) {
            // Dizer "sem filiação" é diferente de mostrar um campo em branco: o
            // branco parece erro de carregamento, e a pessoa fica esperando.
            return (
              <EmptyState
                title={t('carreira.semFiliacao')}
                description={t('carreira.semFiliacaoDescricao', {
                  organizacao: dados.organization?.name || t('carreira.suaOrganizacao')
                })}
              />
            );
          }

          return (
            <>
              <section className="panel">
                <div className="panel-head">
                  <h2>{dados.affiliation.name}</h2>
                  <Badge tom={dados.affiliation.active ? 'ok' : 'neutro'}>
                    {t(dados.affiliation.active ? 'carreira.ativa' : 'carreira.inativa')}
                  </Badge>
                </div>

                <div className="grid grid-3" style={{ padding: '4px 0 12px' }}>
                  <Metric label={t('carreira.codigoDaEntidade')} value={dados.affiliation.code || '—'} />
                  {/* A MATRÍCULA. É o "Member Number" dos resultados oficiais —
                      a metade da filiação pela qual o resultado reconhece a
                      pessoa. Não confundir com o número de atleta. */}
                  <Metric label={t('carreira.minhaMatricula')} value={dados.affiliationNumber || '—'} destaque />
                  <Metric label={t('carreira.uf')} value={dados.affiliation.state || '—'} />
                </div>

                <p className="hint" style={{ margin: 0 }}>
                  <IdCard size={14} style={{ verticalAlign: '-2px' }} />{' '}
                  {t('carreira.organizacao')}: <strong>{dados.organization?.name || '—'}</strong>.
                  {' '}{t('carreira.organizacaoNota')}
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
  const { t } = useIdioma();
  const lista = useListaPaginada(
    cursor => api.me.history({ limit: POR_PAGINA, cursor: cursor || undefined }),
    []
  );

  return (
    <div className="page">
      <PageHead
        eyebrow={t('carreira.meuEspaco')}
        title={t('carreira.meuHistorico')}
        description={t('carreira.meuHistoricoDescricao')}
      />

      <AsyncSection state={lista} linhas={4}>
        {dados => {
          if (!dados.items.length) {
            return (
              <EmptyState
                title={t('carreira.semPontos')}
                description={t('carreira.semPontosDescricao')}
              />
            );
          }

          const totais = dados.totals || {};
          const porCategoria = dados.byCategory || [];

          return (
            <>
              {/* DESEMPENHO POR CATEGORIA — vem ANTES do consolidado, e é
                  deliberado.

                  Quem compete em Classic Physique, Bodybuilding e Men's
                  Physique tem TRÊS carreiras, e o número consolidado não é
                  nenhuma delas: é a soma de coisas que não competem entre si.
                  Mostrar só o total é como a confusão começa — alguém lê "25
                  pontos" e usa esse número como se fosse o desempenho numa
                  categoria, que é justamente o que o ranking nunca faz.

                  Cada cartão abaixo corresponde a UM ranking de verdade. */}
              {porCategoria.length > 0 && (
                <section className="panel">
                  <div className="panel-head">
                    <h2>{t('carreira.porCategoria')}</h2>
                    <span className="muted">{t('carreira.porCategoriaNota')}</span>
                  </div>
                  <div className="grid grid-3" style={{ padding: 'var(--e3)' }}>
                    {porCategoria.map(linha => (
                      <Metric
                        key={linha.category?.id ?? 'sem-categoria'}
                        label={linha.category?.name || linha.category?.code || t('carreira.semCategoria')}
                        value={linha.points}
                        hint={t(linha.participations === 1
                          ? 'carreira.participacaoContagem'
                          : 'carreira.participacoesContagem', { n: linha.participations })}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* O CONSOLIDADO, com o nome do que ele é. Ele não alimenta
                  ranking nenhum: nenhuma categoria recebe este número. */}
              <div className="grid grid-4" style={{ marginTop: porCategoria.length ? 18 : 0 }}>
                <Metric label={t('carreira.participacoes')} value={totais.participations ?? dados.total} />
                <Metric label={t('carreira.pontosDeColocacao')} value={totais.placementPoints ?? 0} />
                <Metric label={t('carreira.bonusOverall')} value={totais.overallBonus ?? 0} />
                <Metric label={t('carreira.totalGeral')} value={totais.points ?? 0} destaque
                  hint={t('carreira.totalGeralNota')} />
              </div>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-head"><h2>{t('carreira.participacoes')}</h2></div>

                <div className="table-wrap">
                  <table className="table historico-tabela">
                    <thead>
                      <tr>
                        <th>{t('carreira.colunaCampeonato')}</th>
                        <th>{t('carreira.colunaCategoriaClasse')}</th>
                        <th className="num">{t('carreira.colunaColocacaoCurta')}</th>
                        <th className="num">{t('carreira.colunaColocacao')}</th>
                        <th className="num">{t('carreira.colunaOverall')}</th>
                        <th className="num">{t('carreira.colunaTotal')}</th>
                        <th>{t('carreira.colunaFiliacaoNaEpoca')}</th>
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
                          <td data-rotulo={t('carreira.colunaCategoria')}>
                            {ponto.category?.name || '—'}
                            <small style={{ display: 'block', color: 'var(--cinza-fraco)' }}>
                              {ponto.competitionClass?.name || ponto.competitionClass?.code || '—'}
                            </small>
                          </td>
                          <td className="num" data-rotulo={t('carreira.colunaColocacao')}>{ponto.placing ?? '—'}</td>
                          <td className="num" data-rotulo={t('carreira.colunaPtsColocacao')}>{ponto.placementPoints}</td>
                          {/* O bônus é do CAMPEÃO DA ABSOLUTA e de mais ninguém.
                              Numa participação sem título a célula fica em
                              zero discreto — mostrar "+10" aqui seria afirmar
                              um título que não existe. */}
                          <td className="num" data-rotulo={t('carreira.colunaOverall')}>
                            {ponto.overallBonus > 0
                              ? (
                                <span title={t('carreira.campeaoOverall')}>
                                  <strong>+{ponto.overallBonus}</strong>{' '}
                                  <Trophy size={13} style={{ verticalAlign: '-2px' }} aria-label={t('carreira.campeaoOverall')} />
                                </span>
                              )
                              : <span style={{ color: 'var(--cinza-fraco)' }}>0</span>}
                          </td>
                          <td className="num" data-rotulo={t('carreira.colunaTotal')}><strong>{ponto.points}</strong></td>
                          <td data-rotulo={t('carreira.colunaFiliacao')}>
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
                                      {t('carreira.numeroAbreviado', { numero: ponto.affiliationNumber })}
                                    </small>
                                  )}
                                </>
                              )
                              : <span style={{ color: 'var(--cinza-fraco)' }}>{t('carreira.filiacaoNaoRegistrada')}</span>}
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
                      {t(lista.carregandoMais ? 'estado.carregando' : 'ui.carregarMais')}
                    </button>
                  </div>
                )}

                <p className="hint" style={{ margin: '10px 0 0' }}>
                  <BadgeCheck size={14} style={{ verticalAlign: '-2px' }} />{' '}
                  {t('carreira.rodapeContagem', { mostrando: dados.items.length, total: dados.total })}
                  {' '}{t('carreira.rodapeOverall')}
                </p>
              </section>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

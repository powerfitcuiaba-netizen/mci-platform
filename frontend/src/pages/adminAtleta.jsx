import { useState } from 'react';
import { AlertTriangle, Archive, Eye, Link2, Pause, Play, PencilLine, ShieldCheck, Trash2 } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Field, Modal, ModalActions, PageHead } from '../components/ui';
import { formatarData, formatarDataHora } from '../lib/format';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// O PERFIL ADMINISTRATIVO DO ATLETA.
//
// Três decisões de projeto, e cada uma tem teste:
//
//   * O CPF aparece MASCARADO, sempre. Quem decide se o número inteiro sai é
//     o backend, pela permissão `search.sensitive` — a tela mostra o que
//     recebeu e nunca desmascara por conta própria. Se o servidor mandou
//     mascarado, mascarado fica.
//
//   * O BOTÃO QUE NÃO CABE NO ESTADO NÃO APARECE. Atleta ativo não tem
//     "Reativar"; atleta arquivado não tem "Arquivar". Oferecer a ação
//     impossível e recusá-la depois é fazer o operador descobrir a regra
//     errando.
//
//   * A EXCLUSÃO É OFERECIDA, MAS QUEM DECIDE É O SERVIDOR. A tela não tenta
//     adivinhar se há histórico: ela chama, e mostra a recusa como ela vem —
//     com o que impede, quanto, e o caminho do arquivamento.
// ==========================================================================

const ESTADOS = Object.freeze({
  ACTIVE: { rotulo: 'atleta.estadoAtivo', tom: 'ok' },
  SUSPENDED: { rotulo: 'atleta.estadoSuspenso', tom: 'alerta' },
  ARCHIVED: { rotulo: 'atleta.estadoArquivado', tom: 'neutro' }
});

export function AdminAtleta({ id, navegar, notificar }) {
  const { t } = useIdioma();
  const [aba, setAba] = useState('resumo');
  const [acao, setAcao] = useState(null);
  const [recarga, setRecarga] = useState(0);

  const estado = useFetch(() => api.athletes.findById(id), [id, recarga]);
  const recarregar = () => setRecarga(n => n + 1);

  return (
    <div className="page">
      <AsyncSection state={estado} linhas={5}>
        {dados => {
          const atleta = dados.athlete;
          const situacao = ESTADOS[atleta.status] || ESTADOS.ACTIVE;

          return (
            <>
              <PageHead
                eyebrow={t('atleta.administracao')}
                title={atleta.fullName}
                description={atleta.stageName || ''}
                actions={
                  <div className="actions">
                    <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('editar')}>
                      <PencilLine size={14} />{t('atleta.editar')}
                    </button>
                    {/* Só a ação que cabe no estado atual. */}
                    {atleta.status === 'ACTIVE' && (
                      <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('suspender')}>
                        <Pause size={14} />{t('atleta.suspender')}
                      </button>
                    )}
                    {atleta.status !== 'ACTIVE' && (
                      <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('reativar')}>
                        <Play size={14} />{t('atleta.reativar')}
                      </button>
                    )}
                    {atleta.status !== 'ARCHIVED' && (
                      <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('arquivar')}>
                        <Archive size={14} />{t('atleta.arquivar')}
                      </button>
                    )}
                    <button type="button" className="button button-secondary button-sm" onClick={() => setAcao('excluir')}>
                      <Trash2 size={14} />{t('atleta.excluir')}
                    </button>
                  </div>
                }
              />

              <section className="panel">
                <div className="panel-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Avatar name={atleta.fullName} mediaPath={atleta.hasPhoto ? `/media/athletes/${atleta.id}/photo` : null} />
                    <div>
                      <h2 style={{ margin: 0 }}>{atleta.fullName}</h2>
                      <small style={{ color: 'var(--cinza-fraco)' }}>
                        {/* O CPF vem do servidor já mascarado. A tela não
                            reconstrói nem revela nada. */}
                        {atleta.cpfMasked || atleta.cpf || t('atleta.semCpf')}
                        {' · '}{atleta.affiliation?.name || t('atleta.semFiliacao')}
                        {atleta.affiliationNumber ? ` · ${t('atleta.matricula')} ${atleta.affiliationNumber}` : ''}
                      </small>
                    </div>
                  </div>
                  <Badge tom={situacao.tom}>{t(situacao.rotulo)}</Badge>
                </div>

                {atleta.status !== 'ACTIVE' && atleta.statusReason && (
                  <div className="alert alert-alerta">
                    <AlertTriangle size={16} />
                    <div>
                      <strong>{t(situacao.rotulo)}</strong>
                      <p>{atleta.statusReason}</p>
                      {atleta.statusChangedAt && <p><small>{formatarDataHora(atleta.statusChangedAt)}</small></p>}
                    </div>
                  </div>
                )}
              </section>

              <div className="chips" style={{ margin: '18px 0' }}>
                {[['resumo', t('atleta.abaResumo')], ['cadastro', t('atleta.abaCadastro')], ['historico', t('atleta.abaHistorico')], ['importado', t('atleta.abaImportado')], ['pontuacao', t('atleta.abaPontuacao')]].map(([chave, rotulo]) => (
                  <button key={chave} type="button" className={`chip${aba === chave ? ' is-on' : ''}`} onClick={() => setAba(chave)}>{rotulo}</button>
                ))}
              </div>

              {aba === 'resumo' && <Resumo atleta={atleta} dados={dados} />}
              {aba === 'cadastro' && <Cadastro atleta={atleta} />}
              {aba === 'historico' && <HistoricoEsportivo dados={dados} />}
              {aba === 'importado' && <HistoricoImportado atleta={atleta} notificar={notificar} aoVincular={recarregar} />}
              {aba === 'pontuacao' && <Pontuacao dados={dados} />}

              {acao === 'editar' && (
                <DialogoDeEdicao
                  atleta={atleta}
                  notificar={notificar}
                  onClose={() => setAcao(null)}
                  onPronto={() => { setAcao(null); recarregar(); }}
                />
              )}

              {acao && acao !== 'excluir' && acao !== 'editar' && (
                <DialogoDeEstado
                  acao={acao}
                  atleta={atleta}
                  notificar={notificar}
                  onClose={() => setAcao(null)}
                  onPronto={() => { setAcao(null); recarregar(); }}
                />
              )}

              {acao === 'excluir' && (
                <DialogoDeExclusao
                  atleta={atleta}
                  notificar={notificar}
                  navegar={navegar}
                  onClose={() => setAcao(null)}
                />
              )}
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

function Linha({ rotulo, valor }) {
  return (
    <div><dt>{rotulo}</dt><dd>{valor || '—'}</dd></div>
  );
}

function Resumo({ atleta, dados }) {
  const { t } = useIdioma();
  const totalPontos = (dados.rankings || []).reduce((soma, linha) => soma + (linha.totalPoints || 0), 0);

  return (
    <section className="panel">
      <div className="panel-head"><h2>{t('atleta.abaResumo')}</h2></div>
      <dl className="definicoes">
        <Linha rotulo={t('atleta.filiacao')} valor={atleta.affiliation?.name} />
        <Linha rotulo={t('atleta.matricula')} valor={atleta.affiliationNumber} />
        <Linha rotulo={t('atleta.equipe')} valor={atleta.team?.name} />
        <Linha rotulo={t('atleta.treinador')} valor={atleta.coach?.name} />
        <Linha rotulo={t('atleta.campeonatos')} valor={String((dados.registrations || []).length)} />
        <Linha rotulo={t('atleta.pontosAcumulados')} valor={String(totalPontos)} />
      </dl>
    </section>
  );
}

// O CPF MASCARADO, E UM BOTÃO QUE PEDE O INTEIRO AO SERVIDOR.
//
// A tela nunca desmascara nada: o que ela mostra é o que recebeu. Revelar é
// uma CHAMADA — `POST /athletes/:id/cpf` —, que o servidor só atende a quem
// tem `search.sensitive` na organização DO ATLETA e que grava
// `ATHLETE_CPF_VIEW` na auditoria antes de responder.
//
// Recusa aparece como ela vem, e o campo volta ao mascarado. Esconder o botão
// por palpite do frontend daria a ilusão de que ele é a trava; ele não é.
function CpfRevelavel({ atleta }) {
  const { t } = useIdioma();
  const mascarado = atleta.cpfMasked || atleta.cpf || null;
  const [revelado, setRevelado] = useState(null);
  const [pedindo, setPedindo] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const pedir = async () => {
    setPedindo(true);
    setRecusa(null);
    try {
      const resposta = await api.athletes.revealCpf(atleta.id);
      setRevelado(resposta.cpf);
    } catch (erro) {
      setRecusa(erro.message);
    } finally {
      setPedindo(false);
    }
  };

  return (
    <div>
      <dt>{t('atleta.cpf')}</dt>
      <dd>
        <span>{revelado || mascarado || '—'}</span>
        {mascarado && !revelado && (
          <button
            type="button"
            className="button button-ghost button-sm"
            style={{ marginLeft: 8 }}
            onClick={pedir}
            disabled={pedindo}
          >
            <Eye size={13} />{t(pedindo ? 'atleta.revelando' : 'atleta.verCpf')}
          </button>
        )}
        {revelado && <div><small>{t('atleta.cpfRegistradoNaAuditoria')}</small></div>}
        {recusa && <div><small role="alert">{recusa}</small></div>}
      </dd>
    </div>
  );
}

function Cadastro({ atleta }) {
  const { t } = useIdioma();
  return (
    <>
      <section className="panel">
        <div className="panel-head"><h2>{t('atleta.identidade')}</h2></div>
        <dl className="definicoes">
          <Linha rotulo={t('atleta.nomeCompleto')} valor={atleta.fullName} />
          <Linha rotulo={t('atleta.nomeEsportivo')} valor={atleta.stageName} />
          {/* MASCARADO por padrão; o inteiro só vem se o servidor autorizar. */}
          <CpfRevelavel atleta={atleta} />
          <Linha rotulo={t('atleta.sexo')} valor={atleta.sex ? t(atleta.sex === 'FEMALE' ? 'atleta.sexoFeminino' : 'atleta.sexoMasculino') : null} />
          <Linha rotulo={t('atleta.nascimento')} valor={atleta.birthDate ? formatarData(atleta.birthDate) : null} />
        </dl>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head"><h2>{t('atleta.contato')}</h2></div>
        <dl className="definicoes">
          <Linha rotulo={t('atleta.telefone')} valor={atleta.phone} />
          <Linha rotulo={t('atleta.email')} valor={atleta.email} />
          <Linha rotulo={t('atleta.cidade')} valor={atleta.city} />
          <Linha rotulo={t('atleta.estadoUf')} valor={atleta.state} />
        </dl>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head"><h2>{t('atleta.filiacao')}</h2></div>
        <dl className="definicoes">
          <Linha rotulo={t('atleta.entidade')} valor={atleta.affiliation?.name} />
          <Linha rotulo={t('atleta.matricula')} valor={atleta.affiliationNumber} />
          <Linha rotulo={t('atleta.numeroDeAtleta')} valor={atleta.athleteNumber} />
        </dl>
      </section>
    </>
  );
}

function HistoricoEsportivo({ dados }) {
  const { t } = useIdioma();
  const resultados = dados.results || [];

  if (!resultados.length) {
    return <EmptyState title={t('atleta.semHistorico')} description={t('atleta.semHistoricoDescricao')} />;
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>{t('atleta.abaHistorico')}</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('atleta.campeonato')}</th>
              <th>{t('atleta.categoria')}</th>
              <th>{t('atleta.classe')}</th>
              <th className="num">{t('atleta.colocacao')}</th>
            </tr>
          </thead>
          <tbody>
            {resultados.map((linha, i) => (
              <tr key={`${linha.event?.id || 'ev'}-${i}`}>
                <td data-rotulo={t('atleta.campeonato')}>{linha.event?.name || '—'}</td>
                <td data-rotulo={t('atleta.categoria')}>{linha.competitionClass?.division?.eventCategory?.category?.name || '—'}</td>
                <td data-rotulo={t('atleta.classe')}>{linha.competitionClass?.name || '—'}</td>
                <td className="num" data-rotulo={t('atleta.colocacao')}>{linha.placing != null ? `${linha.placing}º` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ==========================================================================
// O HISTÓRICO IMPORTADO — E POR QUE ELE TEM ABA PRÓPRIA.
//
// O MCI carrega resultado oficial ANTES de a pessoa se cadastrar: foi assim
// com os 191 lançamentos do Ipiranga. Quando o atleta aparece, a plataforma
// precisa perguntar "este histórico é seu?" a alguém que possa responder.
//
// A TELA NÃO RESPONDE SOZINHA. Ela mostra, lado a lado, o cadastro e a
// carreira candidata — com evento, categoria, classe e colocação de cada
// resultado. Confirmar um NOME seria confirmar um homônimo; confirmar uma
// CARREIRA é uma decisão que o operador tem como tomar.
//
// A sugestão por nome vem do servidor marcada como `exigeConfirmacaoHumana`,
// e a tela não a trata diferente por conta própria: ela desenha o que
// recebeu, inclusive o aviso de homônimos.
// ==========================================================================
const FORCA_DA_PISTA = Object.freeze({
  AFFILIATION_NUMBER: { rotulo: 'atleta.pistaMatricula', tom: 'ok' },
  NAME: { rotulo: 'atleta.pistaNome', tom: 'alerta' }
});

function ResultadosImportados({ resultados }) {
  const { t } = useIdioma();
  if (!resultados.length) return <p><small>{t('atleta.identidadeSemResultados')}</small></p>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('atleta.campeonato')}</th>
            <th>{t('atleta.categoria')}</th>
            <th>{t('atleta.classe')}</th>
            <th className="num">{t('atleta.colocacao')}</th>
            <th className="num">{t('atleta.pontos')}</th>
          </tr>
        </thead>
        <tbody>
          {resultados.map(linha => (
            <tr key={linha.id}>
              <td data-rotulo={t('atleta.campeonato')}>{linha.eventName || '—'}</td>
              <td data-rotulo={t('atleta.categoria')}>{linha.categoryCode || '—'}</td>
              <td data-rotulo={t('atleta.classe')}>{linha.className || '—'}</td>
              <td className="num" data-rotulo={t('atleta.colocacao')}>{linha.placing != null ? `${linha.placing}º` : '—'}</td>
              <td className="num" data-rotulo={t('atleta.pontos')}>{linha.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IdentidadeImportada({ identidade, titulo, acao }) {
  const { t } = useIdioma();

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head">
        <div>
          <h2 style={{ margin: 0 }}>{identidade.displayName}</h2>
          <small style={{ color: 'var(--cinza-fraco)' }}>
            {identidade.affiliation?.name || t('atleta.semFiliacao')}
            {identidade.affiliationNumber ? ` · ${t('atleta.matricula')} ${identidade.affiliationNumber}` : ''}
            {' · '}{t('atleta.resultadosNoHistorico', { total: identidade.results.length })}
          </small>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {titulo}
          {acao}
        </div>
      </div>
      <ResultadosImportados resultados={identidade.results} />
    </section>
  );
}

function HistoricoImportado({ atleta, notificar, aoVincular }) {
  const { t } = useIdioma();
  const [recarga, setRecarga] = useState(0);
  const [confirmando, setConfirmando] = useState(null);

  const estado = useFetch(() => api.athletes.importedHistory(atleta.id), [atleta.id, recarga]);

  return (
    <AsyncSection state={estado} linhas={4}>
      {dados => (
        <>
          {dados.varreduraTruncada && (
            <div className="alert alert-info">
              <AlertTriangle size={16} />
              <div>
                <strong>{t('atleta.varreduraTruncada')}</strong>
                <p>{t('atleta.varreduraTruncadaDescricao', { teto: dados.tetoDaVarredura })}</p>
              </div>
            </div>
          )}

          <h3>{t('atleta.jaVinculado')}</h3>
          {dados.linked.length === 0
            ? <EmptyState title={t('atleta.semHistoricoImportado')} description={t('atleta.semHistoricoImportadoDescricao')} />
            : dados.linked.map(identidade => (
              <IdentidadeImportada
                key={identidade.id}
                identidade={identidade}
                titulo={<Badge tom="ok">{t('atleta.vinculado')}</Badge>}
              />
            ))}

          <h3 style={{ marginTop: 28 }}>{t('atleta.candidatos')}</h3>
          {dados.suggestions.length === 0
            ? <EmptyState title={t('atleta.semCandidatos')} description={t('atleta.semCandidatosDescricao')} />
            : dados.suggestions.map(identidade => {
              const pista = FORCA_DA_PISTA[identidade.matchedBy] || FORCA_DA_PISTA.NAME;
              return (
                <div key={identidade.id}>
                  <IdentidadeImportada
                    identidade={identidade}
                    titulo={
                      <>
                        <Badge tom={pista.tom}>{t(pista.rotulo)}</Badge>
                        {identidade.homonimos && <Badge tom="alerta">{t('atleta.homonimos')}</Badge>}
                      </>
                    }
                    acao={
                      <button type="button" className="button button-secondary button-sm" onClick={() => setConfirmando(identidade)}>
                        <Link2 size={14} />{t('atleta.vincular')}
                      </button>
                    }
                  />
                </div>
              );
            })}

          {confirmando && (
            <DialogoDeVinculo
              atleta={atleta}
              identidade={confirmando}
              notificar={notificar}
              onClose={() => setConfirmando(null)}
              onPronto={() => { setConfirmando(null); setRecarga(n => n + 1); aoVincular?.(); }}
            />
          )}
        </>
      )}
    </AsyncSection>
  );
}

// A CONFIRMAÇÃO É LADO A LADO, e não uma pergunta de sim ou não.
//
// "Vincular este histórico?" com um nome só é a pergunta que produz o erro:
// quem responde vê um nome que confere e clica. O que decide é a carreira —
// a entidade, a matrícula e os resultados —, e é ela que fica na tela até o
// operador confirmar.
function DialogoDeVinculo({ atleta, identidade, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const confirmar = async () => {
    setEnviando(true);
    setRecusa(null);
    try {
      const resposta = await api.athletes.linkImportedIdentity(atleta.id, identidade.id);
      notificar?.(resposta.alreadyLinked
        ? t('atleta.jaEstavaVinculado')
        : t('atleta.vinculadoAviso', { total: resposta.lancamentos }));
      onPronto();
    } catch (erro) {
      setRecusa(erro.message);
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('atleta.confirmarVinculo')} description={t('atleta.confirmarVinculoDescricao')} wide onClose={onClose}>
      {recusa && (
        <div className="alert alert-erro" role="alert">
          <ShieldCheck size={16} />
          <div><p>{recusa}</p></div>
        </div>
      )}

      {identidade.homonimos && (
        <div className="alert alert-alerta">
          <AlertTriangle size={16} />
          <div>
            <strong>{t('atleta.homonimos')}</strong>
            <p>{t('atleta.homonimosDescricao')}</p>
          </div>
        </div>
      )}

      <div className="comparacao">
        <div>
          <h4>{t('atleta.oCadastro')}</h4>
          <dl className="definicoes">
            <Linha rotulo={t('atleta.nomeCompleto')} valor={atleta.fullName} />
            <Linha rotulo={t('atleta.entidade')} valor={atleta.affiliation?.name} />
            <Linha rotulo={t('atleta.matricula')} valor={atleta.affiliationNumber} />
          </dl>
        </div>
        <div>
          <h4>{t('atleta.oHistorico')}</h4>
          <dl className="definicoes">
            <Linha rotulo={t('atleta.nomeNaFonte')} valor={identidade.displayName} />
            <Linha rotulo={t('atleta.entidade')} valor={identidade.affiliation?.name} />
            <Linha rotulo={t('atleta.matricula')} valor={identidade.affiliationNumber} />
          </dl>
        </div>
      </div>

      <ResultadosImportados resultados={identidade.results} />

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button button-primary" onClick={confirmar} disabled={enviando}>
          {t(enviando ? 'atleta.vinculando' : 'atleta.confirmarVinculo')}
        </button>
      </div>
    </Modal>
  );
}

function Pontuacao({ dados }) {
  const { t } = useIdioma();
  const linhas = dados.rankings || [];

  if (!linhas.length) {
    return <EmptyState title={t('atleta.semPontuacao')} description={t('atleta.semPontuacaoDescricao')} />;
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>{t('atleta.abaPontuacao')}</h2></div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('atleta.temporada')}</th>
              <th>{t('atleta.categoria')}</th>
              <th className="num">{t('atleta.pontos')}</th>
              <th className="num">{t('atleta.etapas')}</th>
              <th className="num">{t('atleta.overall')}</th>
              <th className="num">{t('atleta.posicao')}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(linha => (
              <tr key={linha.id}>
                <td data-rotulo={t('atleta.temporada')}>{linha.season?.name || '—'}</td>
                <td data-rotulo={t('atleta.categoria')}>{linha.category?.name || t('atleta.geral')}</td>
                <td className="num" data-rotulo={t('atleta.pontos')}>{linha.totalPoints}</td>
                <td className="num" data-rotulo={t('atleta.etapas')}>{linha.eventCount}</td>
                <td className="num" data-rotulo={t('atleta.overall')}>{linha.overallWins}</td>
                {/* Posição nula é EMPATE NÃO RESOLVIDO, e não falta de dado.
                    A tela diz isso em vez de mostrar um traço mudo. */}
                <td className="num" data-rotulo={t('atleta.posicao')}>
                  {linha.position != null ? linha.position : <small>{t('atleta.empateNaoResolvido')}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// EDIÇÃO DO CADASTRO.
//
// O que NÃO está aqui é tão deliberado quanto o que está:
//
//   * O CPF não se edita. Ele é a identidade pela qual o histórico oficial
//     reconhece a pessoa; trocá-lo por formulário seria trocar de pessoa.
//     `athleteUpdate` o omite no servidor, e o formulário não o oferece.
//
//   * A EQUIPE não se edita. O vínculo tem trava de unicidade e histórico
//     próprios, e sai por `POST /athletes/:id/team` ou pela transferência,
//     que exige outra permissão. O servidor recusa `teamId` com mensagem, em
//     vez de descartá-lo em silêncio — e por isso o campo não aparece.
//
// Só o que MUDOU é enviado, e campo esvaziado vai como `null`: o schema aceita
// nulo e recusa string vazia, então mandar `''` transformaria "apaguei o
// telefone" em erro de validação.
const CAMPOS_EDITAVEIS = Object.freeze([
  ['fullName', 'atleta.nomeCompleto', 'text'],
  ['stageName', 'atleta.nomeEsportivo', 'text'],
  ['birthDate', 'atleta.nascimento', 'date'],
  ['city', 'atleta.cidade', 'text'],
  ['state', 'atleta.estadoUf', 'text'],
  ['phone', 'atleta.telefone', 'text'],
  ['email', 'atleta.email', 'email'],
  ['affiliationNumber', 'atleta.matricula', 'text'],
  ['athleteNumber', 'atleta.numeroDeAtleta', 'text']
]);

const paraFormulario = atleta => {
  const inicial = {};
  for (const [campo] of CAMPOS_EDITAVEIS) {
    const valor = atleta[campo];
    inicial[campo] = campo === 'birthDate' && valor ? String(valor).slice(0, 10) : (valor ?? '');
  }
  inicial.sex = atleta.sex || 'MALE';
  inicial.affiliationId = atleta.affiliation?.id || '';
  return inicial;
};

function DialogoDeEdicao({ atleta, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [form, setForm] = useState(() => paraFormulario(atleta));
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const filiacoes = useFetch(() => api.affiliations.list({ limit: 100 }), []);
  const alterar = (campo, valor) => setForm(atual => ({ ...atual, [campo]: valor }));

  const enviar = async evento => {
    evento.preventDefault();
    setEnviando(true);
    setRecusa(null);

    const original = paraFormulario(atleta);
    const mudancas = {};
    for (const chave of Object.keys(form)) {
      if (form[chave] === original[chave]) continue;
      mudancas[chave] = form[chave] === '' ? null : form[chave];
    }

    if (!Object.keys(mudancas).length) { onClose(); return; }

    try {
      await api.athletes.update(atleta.id, mudancas);
      notificar?.(t('atleta.cadastroAtualizado'));
      onPronto();
    } catch (erro) {
      setRecusa(erro.message);
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('atleta.editar')} description={t('atleta.editarDescricao')} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        {CAMPOS_EDITAVEIS.map(([campo, rotulo, tipo]) => (
          <Field key={campo} label={t(rotulo)} required={campo === 'fullName'}>
            <input
              type={tipo}
              value={form[campo]}
              onChange={evento => alterar(campo, evento.target.value)}
              required={campo === 'fullName'}
              maxLength={campo === 'state' ? 2 : 180}
            />
          </Field>
        ))}

        <Field label={t('atleta.sexo')} required>
          <select value={form.sex} onChange={evento => alterar('sex', evento.target.value)}>
            <option value="MALE">{t('atleta.sexoMasculino')}</option>
            <option value="FEMALE">{t('atleta.sexoFeminino')}</option>
          </select>
        </Field>

        <Field label={t('atleta.entidade')} hint={t('atleta.entidadeDica')}>
          <select value={form.affiliationId} onChange={evento => alterar('affiliationId', evento.target.value)}>
            <option value="">{t('atleta.semFiliacao')}</option>
            {(filiacoes.data?.items || []).map(entidade => (
              <option key={entidade.id} value={entidade.id}>{entidade.name}</option>
            ))}
          </select>
        </Field>

        <ModalActions onClose={onClose} saving={enviando} confirmLabel={t('acao.salvar')} />
      </form>
    </Modal>
  );
}

const ACOES = Object.freeze({
  suspender: { titulo: 'atleta.suspender', exigeMotivo: true, chamar: (id, motivo) => api.athletes.suspend(id, motivo), aviso: 'atleta.suspensoAviso' },
  arquivar: { titulo: 'atleta.arquivar', exigeMotivo: true, chamar: (id, motivo) => api.athletes.archive(id, motivo), aviso: 'atleta.arquivadoAviso' },
  reativar: { titulo: 'atleta.reativar', exigeMotivo: false, chamar: (id, motivo) => api.athletes.reactivate(id, motivo || null), aviso: 'atleta.reativadoAviso' }
});

function DialogoDeEstado({ acao, atleta, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const config = ACOES[acao];
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const confirmar = async evento => {
    evento.preventDefault();
    setEnviando(true);
    try {
      await config.chamar(atleta.id, motivo.trim());
      notificar?.(t(config.aviso));
      onPronto();
    } catch (erro) {
      notificar?.(erro.message, 'erro');
      setEnviando(false);
    }
  };

  return (
    <Modal title={t(config.titulo)} description={t('atleta.nadaDeHistoricoMuda')} onClose={onClose}>
      <form onSubmit={confirmar}>
        <Field
          label={t('atleta.motivo')}
          required={config.exigeMotivo}
          hint={config.exigeMotivo ? t('atleta.motivoFicaNaAuditoria') : t('atleta.motivoOpcional')}
        >
          <textarea
            value={motivo}
            onChange={evt => setMotivo(evt.target.value)}
            required={config.exigeMotivo}
            minLength={config.exigeMotivo ? 3 : undefined}
            maxLength={500}
            rows={3}
          />
        </Field>
        <ModalActions onClose={onClose} saving={enviando} confirmLabel={t(config.titulo)} />
      </form>
    </Modal>
  );
}

// A EXCLUSÃO NÃO É ADIVINHADA PELA TELA.
//
// Quem sabe se há histórico esportivo é o servidor, que conta sete tabelas. A
// tela chama e mostra a recusa como ela vem — com o que impede, quanto, e o
// caminho do arquivamento. Tentar prever aqui criaria uma segunda regra, e
// duas regras divergem.
function DialogoDeExclusao({ atleta, notificar, navegar, onClose }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const confirmar = async () => {
    setEnviando(true);
    setRecusa(null);
    try {
      await api.athletes.remove(atleta.id);
      notificar?.(t('atleta.excluidoAviso'));
      navegar?.('admin/atletas');
    } catch (erro) {
      setRecusa(erro.message);
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('atleta.excluir')} onClose={onClose}>
      <p>{t('atleta.excluirDescricao')}</p>

      {recusa && (
        <div className="alert alert-erro" role="alert">
          <ShieldCheck size={16} />
          <div><p>{recusa}</p></div>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button button-danger" onClick={confirmar} disabled={enviando}>
          {t(enviando ? 'atleta.excluindo' : 'atleta.excluir')}
        </button>
      </div>
    </Modal>
  );
}


import { useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { PageHead, Badge, AsyncSection, Modal, Field, Paginacao, ProtectedMedia } from '../components/ui';
import { anunciar, MCIEvento } from '../lib/experiencia';
import { mascararCpf, formatarData, formatarDataHora } from '../lib/format';
import { useIdioma, TextoRico } from '../lib/idioma';

// ============================================================================
// FILA DE SOLICITAÇÕES DE PERFIL DE ATLETA — tela do operador da federação.
//
// Aqui é onde a separação entre PEDIR e CONCEDER se resolve: o operador lê o
// pedido e decide. Aprovar cria, numa transação no servidor, o atleta e o
// documento; recusar encerra o pedido com motivo. Nenhuma das duas coisas
// acontece nesta tela — ela só pede, e o servidor decide se pode.
//
// SOBRE O CPF: ele NÃO vem na listagem. A lista usa `CAMPOS_PUBLICOS`, que o
// exclui de propósito — uma fila com 200 documentos na tela é um vazamento
// esperando um print. O CPF só é buscado quando o operador abre UM pedido
// (`GET /athlete-requests/:id`), vem no CORPO da resposta, e o servidor
// reconfere `athletes.read_sensitive` contra a organização DO PEDIDO. Nunca
// entra em URL nem em parâmetro de consulta, onde ficaria no histórico do
// navegador, no Referer e no log de acesso do servidor.
// ============================================================================

const TOM = { PENDING: 'atencao', APPROVED: 'sucesso', REJECTED: 'perigo', CANCELLED: 'neutro' };
// O CÓDIGO do estado é da API; o mapa leva à CHAVE do rótulo.
const ROTULO = {
  PENDING: 'solicitacao.emAnalise',
  APPROVED: 'solicitacao.aprovada',
  REJECTED: 'solicitacao.recusada',
  CANCELLED: 'solicitacao.cancelada'
};

const FILTROS = [
  ['PENDING', 'solicitacao.emAnalise'],
  ['APPROVED', 'fila.aprovadas'],
  ['REJECTED', 'fila.recusadas'],
  ['CANCELLED', 'fila.canceladas'],
  ['', 'fila.todas']
];

export default function AdminSolicitacoes({ notificar }) {
  const { t } = useIdioma();
  const [status, setStatus] = useState('PENDING');
  const [cursor, setCursor] = useState(null);
  const [abrindo, setAbrindo] = useState(null);

  const fila = useFetch(
    () => api.athleteRequests.listar({ status: status || undefined, cursor: cursor || undefined, limit: 25 }),
    [status, cursor]
  );

  const trocarFiltro = valor => { setStatus(valor); setCursor(null); };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('fila.federacao')}
        title={t('fila.titulo')}
        description={t('fila.descricao')}
      />

      <div className="chips" role="group" aria-label={t('fila.filtrarPorSituacao')}>
        {FILTROS.map(([valor, chave]) => (
          <button
            key={chave}
            type="button"
            className={`chip${status === valor ? ' is-on' : ''}`}
            aria-pressed={status === valor}
            onClick={() => trocarFiltro(valor)}
          >
            {t(chave)}
          </button>
        ))}
      </div>

      <AsyncSection state={fila} empty={dados => !dados.items?.length}>
        {dados => (
          <>
            {/* Tabela no desktop, cartões no celular. Não é a mesma tabela
                encolhida: sete colunas em 360px viram uma linha ilegível. */}
            <div className="table-wrap so-desktop">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('fila.solicitante')}</th>
                    <th scope="col">{t('solicitacao.entidade')}</th>
                    <th scope="col">{t('fila.registro')}</th>
                    <th scope="col">{t('fila.enviadaEm')}</th>
                    <th scope="col">{t('conta.situacao')}</th>
                    <th scope="col"><span className="sr-only">{t('fila.acoes')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {dados.items.map(pedido => (
                    <tr key={pedido.id}>
                      <td>
                        <strong>{pedido.fullName}</strong>
                        <small className="muted bloco">{pedido.user?.email}</small>
                      </td>
                      <td>{pedido.affiliation?.name || '—'}</td>
                      <td className="num">{pedido.affiliationNumber}</td>
                      <td>{formatarData(pedido.createdAt)}</td>
                      <td><Badge tom={TOM[pedido.status]}>{t(ROTULO[pedido.status])}</Badge></td>
                      <td>
                        <button type="button" className="button button-secondary button-sm" onClick={() => setAbrindo(pedido)}>
                          {t('fila.ver')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="lista-cartoes so-mobile">
              {dados.items.map(pedido => (
                <li key={pedido.id} className="card cartao-pedido">
                  <div className="cartao-topo">
                    <strong>{pedido.fullName}</strong>
                    <Badge tom={TOM[pedido.status]}>{t(ROTULO[pedido.status])}</Badge>
                  </div>
                  <small className="muted">{pedido.user?.email}</small>
                  <dl className="linha-revisao-compacta">
                    <div><dt>{t('carreira.colunaFiliacao')}</dt><dd>{pedido.affiliation?.name || '—'}</dd></div>
                    <div><dt>{t('fila.registro')}</dt><dd>{pedido.affiliationNumber}</dd></div>
                    <div><dt>{t('fila.enviada')}</dt><dd>{formatarData(pedido.createdAt)}</dd></div>
                  </dl>
                  <button type="button" className="button button-secondary" onClick={() => setAbrindo(pedido)}>
                    {t('fila.verSolicitacao')}
                  </button>
                </li>
              ))}
            </ul>

            <Paginacao nextCursor={dados.nextCursor} onMore={() => setCursor(dados.nextCursor)} loading={fila.loading} />
          </>
        )}
      </AsyncSection>

      {abrindo && (
        <Analise
          id={abrindo.id}
          onClose={() => setAbrindo(null)}
          aoDecidir={() => { setAbrindo(null); fila.reload(); }}
          notificar={notificar}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Analise({ id, onClose, aoDecidir, notificar }) {
  const { t } = useIdioma();
  const { user } = useAuth();
  // O pedido é RECARREGADO por id em vez de reaproveitar a linha da lista: é
  // esta chamada que traz o CPF, e é nela que o servidor reconfere a permissão
  // contra a organização do pedido. Confiar na linha da lista seria deixar a
  // tela decidir o que ela pode ver.
  const pedido = useFetch(() => api.athleteRequests.analisar(id), [id]);
  const [motivo, setMotivo] = useState('');
  const [recusando, setRecusando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  const decidir = async acao => {
    if (salvando) return;
    setSalvando(true);
    setErro(null);
    try {
      if (acao === 'aprovar') {
        await api.athleteRequests.aprovar(id);
        notificar?.(t('fila.aprovadaAviso'));
        // Aprovar cria um atleta — é o momento em que alguém passa a existir na
        // plataforma. Nível EVENTO: confirma sem tomar o centro da tela, porque
        // uma fila de solicitações se analisa uma atrás da outra.
        anunciar(MCIEvento.SUCESSO, {
          titulo: t('fila.aprovadaTitulo'), descricao: t('fila.aprovadaDescricao')
        });
      } else {
        await api.athleteRequests.rejeitar(id, motivo.trim());
        notificar?.(t('fila.recusadaAviso'));
        // Recusar NÃO comemora: do outro lado há uma pessoa esperando.
        anunciar(MCIEvento.AVISO, {
          titulo: t('fila.recusadaTitulo'), descricao: t('fila.recusadaDescricao')
        });
      }
      aoDecidir();
    } catch (problema) {
      setErro(problema.message);
      setSalvando(false);
    }
  };

  const dados = pedido.data;
  // Ninguém analisa o próprio pedido. O servidor recusa com SELF_REVIEW_FORBIDDEN;
  // desabilitar aqui evita oferecer um botão que só existe para dar erro.
  const eProprio = dados && user?.id === dados.userId;
  const pendente = dados?.status === 'PENDING';

  return (
    <Modal title={t('fila.analisar')} description={t('fila.analisarDescricao')} wide onClose={onClose}>
      <AsyncSection state={pedido} linhas={5}>
        {pedidoCarregado => (
          <>
            {/* A foto é o que confirma a identidade contra o documento — vem
                antes dos campos de propósito. Buscada COM o token: a rota exige
                sessão e decide entre o dono e o operador da federação. */}
            <div className="foto-da-analise">
              <div className="foto-previa foto-previa-grande">
                {pedidoCarregado.hasPhoto
                  ? (
                    <ProtectedMedia
                      path={`/media/athlete-requests/${pedidoCarregado.id}/photo`}
                      alt={t('fila.fotoDe', { nome: pedidoCarregado.fullName })}
                    />
                  )
                  : <span className="foto-vazia">{t('solicitacao.semFoto')}</span>}
              </div>
              {!pedidoCarregado.hasPhoto && (
                <small className="muted">{t('fila.semFotoNota')}</small>
              )}
            </div>

            <dl className="lista-revisao">
              <Linha rotulo={t('fila.nomeInformado')} valor={pedidoCarregado.fullName} />
              <Linha rotulo={t('fila.contaDoSolicitante')} valor={pedidoCarregado.user?.email} />
              <Linha
                rotulo="CPF"
                valor={pedidoCarregado.cpf ? mascararCpf(pedidoCarregado.cpf) : t('fila.cpfApagado')}
                sensivel
              />
              <Linha
                rotulo={t('solicitacao.categoriaDeCompeticao')}
                valor={t(pedidoCarregado.sex === 'FEMALE' ? 'solicitacao.feminino' : 'solicitacao.masculino')}
              />
              <Linha rotulo={t('fila.nascimento')} valor={pedidoCarregado.birthDate ? formatarData(pedidoCarregado.birthDate) : '—'} />
              <Linha rotulo={t('solicitacao.entidade')} valor={pedidoCarregado.affiliation?.name} />
              <Linha rotulo={t('solicitacao.numeroDeRegistro')} valor={pedidoCarregado.affiliationNumber} />
              <Linha rotulo={t('fila.cidade')} valor={[pedidoCarregado.user?.city, pedidoCarregado.user?.state].filter(Boolean).join(' — ')} />
              <Linha rotulo={t('fila.enviadaEm')} valor={formatarDataHora(pedidoCarregado.createdAt)} />
              {pedidoCarregado.reviewedAt && (
                <Linha rotulo={t('fila.analisadaEm')} valor={formatarDataHora(pedidoCarregado.reviewedAt)} />
              )}
              {pedidoCarregado.rejectionReason && (
                <Linha rotulo={t('fila.motivoDaRecusa')} valor={pedidoCarregado.rejectionReason} />
              )}
            </dl>

            {/* O que a aprovação faz, dito antes de ela acontecer: não é um
                "ok", é a criação do atleta e do documento. */}
            {pendente && !eProprio && (
              <p className="muted">
                <TextoRico
                  chave="fila.oQueAprovarFaz"
                  valores={{ nome: pedidoCarregado.fullName, entidade: pedidoCarregado.affiliation?.name }}
                />
              </p>
            )}

            {eProprio && (
              <div className="alert alert-alerta" role="status">
                <div>
                  <strong>{t('fila.pedidoProprio')}</strong>
                  <p>{t('fila.pedidoProprioNota')}</p>
                </div>
              </div>
            )}

            {!pendente && (
              <div className="alert alert-info" role="status">
                <div>
                  <strong>
                    {t('fila.jaDecidida', { situacao: t(ROTULO[pedidoCarregado.status]).toLowerCase() })}
                  </strong>
                </div>
              </div>
            )}

            {recusando && (
              <Field label={t('fila.motivoDaRecusa')} required hint={t('fila.motivoHint')}>
                <textarea
                  value={motivo}
                  onChange={evento => setMotivo(evento.target.value)}
                  rows={3}
                  maxLength={300}
                  autoFocus
                />
              </Field>
            )}

            {erro && <div className="alert alert-erro" role="alert"><div><strong>{erro}</strong></div></div>}

            <div className="modal-actions">
              <button type="button" className="button button-ghost" onClick={onClose} disabled={salvando}>
                {t('acao.fechar')}
              </button>

              {pendente && !eProprio && (recusando ? (
                <>
                  <button type="button" className="button button-ghost" onClick={() => setRecusando(false)} disabled={salvando}>
                    {t('acao.voltar')}
                  </button>
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={() => decidir('rejeitar')}
                    disabled={salvando || motivo.trim().length < 3}
                  >
                    {t(salvando ? 'fila.recusando' : 'fila.confirmarRecusa')}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="button button-secondary" onClick={() => setRecusando(true)} disabled={salvando}>
                    {t('fila.recusar')}
                  </button>
                  <button type="button" className="button button-primary" onClick={() => decidir('aprovar')} disabled={salvando}>
                    {t(salvando ? 'fila.aprovando' : 'fila.aprovarECriar')}
                  </button>
                </>
              ))}
            </div>
          </>
        )}
      </AsyncSection>
    </Modal>
  );
}

function Linha({ rotulo, valor, sensivel = false }) {
  return (
    <div className="linha-revisao">
      <dt>{rotulo}</dt>
      <dd className={sensivel ? 'valor-sensivel' : undefined}>{valor || '—'}</dd>
    </div>
  );
}

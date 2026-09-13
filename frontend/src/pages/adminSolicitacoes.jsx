import { useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { PageHead, Badge, AsyncSection, Modal, Field, Paginacao, ProtectedMedia } from '../components/ui';
import { mascararCpf, formatarData, formatarDataHora } from '../lib/format';

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
const ROTULO = { PENDING: 'Em análise', APPROVED: 'Aprovada', REJECTED: 'Recusada', CANCELLED: 'Cancelada' };

const FILTROS = [
  ['PENDING', 'Em análise'],
  ['APPROVED', 'Aprovadas'],
  ['REJECTED', 'Recusadas'],
  ['CANCELLED', 'Canceladas'],
  ['', 'Todas']
];

export default function AdminSolicitacoes({ notificar }) {
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
        eyebrow="Federação"
        title="Solicitações de atletas"
        description="Pedidos de perfil de atleta aguardando a confirmação da filiação."
      />

      <div className="chips" role="group" aria-label="Filtrar por situação">
        {FILTROS.map(([valor, rotulo]) => (
          <button
            key={rotulo}
            type="button"
            className={`chip${status === valor ? ' is-on' : ''}`}
            aria-pressed={status === valor}
            onClick={() => trocarFiltro(valor)}
          >
            {rotulo}
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
                    <th scope="col">Solicitante</th>
                    <th scope="col">Entidade de filiação</th>
                    <th scope="col">Registro</th>
                    <th scope="col">Enviada em</th>
                    <th scope="col">Situação</th>
                    <th scope="col"><span className="sr-only">Ações</span></th>
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
                      <td><Badge tom={TOM[pedido.status]}>{ROTULO[pedido.status]}</Badge></td>
                      <td>
                        <button type="button" className="button button-secondary button-sm" onClick={() => setAbrindo(pedido)}>
                          Ver
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
                    <Badge tom={TOM[pedido.status]}>{ROTULO[pedido.status]}</Badge>
                  </div>
                  <small className="muted">{pedido.user?.email}</small>
                  <dl className="linha-revisao-compacta">
                    <div><dt>Filiação</dt><dd>{pedido.affiliation?.name || '—'}</dd></div>
                    <div><dt>Registro</dt><dd>{pedido.affiliationNumber}</dd></div>
                    <div><dt>Enviada</dt><dd>{formatarData(pedido.createdAt)}</dd></div>
                  </dl>
                  <button type="button" className="button button-secondary" onClick={() => setAbrindo(pedido)}>
                    Ver solicitação
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
        notificar?.('Solicitação aprovada. O atleta foi criado.');
      } else {
        await api.athleteRequests.rejeitar(id, motivo.trim());
        notificar?.('Solicitação recusada.');
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
    <Modal title="Analisar solicitação" description="Confirme a filiação antes de aprovar." wide onClose={onClose}>
      <AsyncSection state={pedido} linhas={5}>
        {pedidoCarregado => (
          <>
            {/* A foto é o que confirma a identidade contra o documento — vem
                antes dos campos de propósito. Buscada COM o token: a rota exige
                sessão e decide entre o dono e o operador da federação. */}
            <div className="foto-da-analise">
              <div className="foto-previa foto-previa-grande">
                {pedidoCarregado.photoKey
                  ? <ProtectedMedia path={`/media/athlete-requests/${pedidoCarregado.id}/photo`} alt={`Foto enviada por ${pedidoCarregado.fullName}`} />
                  : <span className="foto-vazia">Sem foto</span>}
              </div>
              {!pedidoCarregado.photoKey && (
                <small className="muted">
                  Este pedido veio sem foto. A foto é opcional — confira a identidade pelos
                  demais dados.
                </small>
              )}
            </div>

            <dl className="lista-revisao">
              <Linha rotulo="Nome informado" valor={pedidoCarregado.fullName} />
              <Linha rotulo="Conta" valor={pedidoCarregado.user?.email} />
              <Linha
                rotulo="CPF"
                valor={pedidoCarregado.cpf ? mascararCpf(pedidoCarregado.cpf) : 'Já não está guardado neste pedido'}
                sensivel
              />
              <Linha rotulo="Categoria de competição" valor={pedidoCarregado.sex === 'FEMALE' ? 'Feminino' : 'Masculino'} />
              <Linha rotulo="Nascimento" valor={pedidoCarregado.birthDate ? formatarData(pedidoCarregado.birthDate) : '—'} />
              <Linha rotulo="Entidade de filiação" valor={pedidoCarregado.affiliation?.name} />
              <Linha rotulo="Número de registro" valor={pedidoCarregado.affiliationNumber} />
              <Linha rotulo="Cidade" valor={[pedidoCarregado.user?.city, pedidoCarregado.user?.state].filter(Boolean).join(' — ')} />
              <Linha rotulo="Enviada em" valor={formatarDataHora(pedidoCarregado.createdAt)} />
              {pedidoCarregado.reviewedAt && (
                <Linha rotulo="Analisada em" valor={formatarDataHora(pedidoCarregado.reviewedAt)} />
              )}
              {pedidoCarregado.rejectionReason && (
                <Linha rotulo="Motivo da recusa" valor={pedidoCarregado.rejectionReason} />
              )}
            </dl>

            {/* O que a aprovação faz, dito antes de ela acontecer: não é um
                "ok", é a criação do atleta e do documento. */}
            {pendente && !eProprio && (
              <p className="muted">
                Aprovar cria o perfil de atleta de <strong>{pedidoCarregado.fullName}</strong> em{' '}
                <strong>{pedidoCarregado.affiliation?.name}</strong> e vincula o CPF à ficha. A ação
                fica registrada em auditoria com o seu nome.
              </p>
            )}

            {eProprio && (
              <div className="alert alert-alerta" role="status">
                <div>
                  <strong>Esta solicitação é sua.</strong>
                  <p>Quem pede não analisa. Peça a outro operador da federação.</p>
                </div>
              </div>
            )}

            {!pendente && (
              <div className="alert alert-info" role="status">
                <div><strong>Esta solicitação já foi {ROTULO[pedidoCarregado.status].toLowerCase()}.</strong></div>
              </div>
            )}

            {recusando && (
              <Field label="Motivo da recusa" required hint="O solicitante vê este texto. Diga o que ele precisa corrigir.">
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
                Fechar
              </button>

              {pendente && !eProprio && (recusando ? (
                <>
                  <button type="button" className="button button-ghost" onClick={() => setRecusando(false)} disabled={salvando}>
                    Voltar
                  </button>
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={() => decidir('rejeitar')}
                    disabled={salvando || motivo.trim().length < 3}
                  >
                    {salvando ? 'Recusando…' : 'Confirmar recusa'}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="button button-secondary" onClick={() => setRecusando(true)} disabled={salvando}>
                    Recusar
                  </button>
                  <button type="button" className="button button-primary" onClick={() => decidir('aprovar')} disabled={salvando}>
                    {salvando ? 'Aprovando…' : 'Aprovar e criar atleta'}
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

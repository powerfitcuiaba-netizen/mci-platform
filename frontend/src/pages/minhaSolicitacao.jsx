import { useState } from 'react';
import { api, refreshData } from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { PageHead, Field, Badge, AsyncSection, ConfirmDialog } from '../components/ui';
import {
  mascararCpfEntrada, cpfResumido, errosDaSolicitacao, corpoDaSolicitacao, cpfValido
} from '../lib/formulario';
import { formatarData } from '../lib/format';

// ============================================================================
// MINHA SOLICITAÇÃO DE PERFIL DE ATLETA.
//
// Esta tela existe porque PEDIR e CONCEDER são coisas diferentes. Quem acaba
// de criar conta não é operador de federação nenhuma, e por isso não pode
// criar a própria linha de atleta — a política RLS `atleta_criacao` exige
// `mci_operator_of`. Em vez de afrouxá-la, a pessoa registra um pedido e um
// operador da federação analisa.
//
// É AQUI que o CPF é digitado, e não no cadastro: só existe sessão a partir
// daqui, a lista de filiações (`GET /affiliations`) exige autenticação, e o
// documento vai direto para a API — sem passar por sessionStorage, sem
// aparecer em URL, sem ficar guardado neste navegador.
// ============================================================================

const TOM = { PENDING: 'atencao', APPROVED: 'sucesso', REJECTED: 'perigo', CANCELLED: 'neutro' };
const ROTULO = { PENDING: 'Em análise', APPROVED: 'Aprovada', REJECTED: 'Recusada', CANCELLED: 'Cancelada' };

export default function MinhaSolicitacao({ notificar }) {
  const { user, refreshSession } = useAuth();
  // `GET /athlete-requests/me` devolve `{ items: [...] }`, e não um array —
  // como toda listagem desta API. Tratar a resposta como array derrubava a
  // tela inteira no `.find`, e o limite de erro engolia a queda numa
  // mensagem genérica.
  const pedidos = useFetch(async () => (await api.athleteRequests.meus()).items ?? [], []);
  const [cancelando, setCancelando] = useState(null);

  const cancelar = async () => {
    try {
      await api.athleteRequests.cancelar(cancelando.id);
      setCancelando(null);
      pedidos.reload();
      notificar?.('Solicitação cancelada.');
    } catch (problema) {
      setCancelando(null);
      notificar?.(problema.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="Perfil de atleta"
        title="Minha solicitação"
        description="Competir exige filiação confirmada pela federação. Você envia os dados; um operador analisa."
      />

      <AsyncSection state={pedidos} linhas={3}>
        {lista => {
          const emAberto = lista.find(pedido => pedido.status === 'PENDING');
          const aprovado = lista.find(pedido => pedido.status === 'APPROVED');
          const historico = lista.filter(pedido => pedido !== emAberto);

          return (
            <div className="coluna-generosa">
              {/* `user.athleteId` é a verdade do servidor sobre já ser atleta.
                  Uma aprovação antiga sem `athleteId` não basta. */}
              {user?.athleteId ? (
                <section className="card">
                  <Badge tom="sucesso">Perfil de atleta ativo</Badge>
                  <h2>Você já compete pela MCI</h2>
                  <p className="muted">
                    Seu perfil de atleta está ativo. Para corrigir filiação, número de registro
                    ou qualquer dado da sua ficha, fale com a sua federação — esses campos são
                    mantidos por ela, não por esta tela.
                  </p>
                </section>
              ) : emAberto ? (
                <EmAnalise pedido={emAberto} aoCancelar={() => setCancelando(emAberto)} />
              ) : aprovado ? (
                <section className="card">
                  <Badge tom="sucesso">Aprovada</Badge>
                  <h2>Sua solicitação foi aprovada</h2>
                  <p className="muted">
                    A federação aprovou o seu perfil. Se ele ainda não aparece aqui, atualize a
                    sessão.
                  </p>
                  <button type="button" className="button button-ghost button-sm" onClick={() => refreshSession()}>
                    Atualizar minha sessão
                  </button>
                </section>
              ) : (
                <Formulario
                  nomeDaConta={user?.name || ''}
                  ultimaRecusa={lista.find(pedido => pedido.status === 'REJECTED')}
                  aoEnviar={() => { pedidos.reload(); refreshData(); }}
                  notificar={notificar}
                />
              )}

              {historico.length > 0 && <Historico pedidos={historico} />}
            </div>
          );
        }}
      </AsyncSection>

      {cancelando && (
        <ConfirmDialog
          title="Cancelar solicitação"
          message="A solicitação sai da fila da federação e o CPF enviado é apagado. Você pode enviar outra depois."
          confirmLabel="Cancelar solicitação"
          onConfirm={cancelar}
          onClose={() => setCancelando(null)}
        />
      )}
    </div>
  );
}

function EmAnalise({ pedido, aoCancelar }) {
  return (
    <section className="card">
      <Badge tom="atencao">Em análise</Badge>
      <h2>Sua solicitação está na fila da federação</h2>
      <p className="muted">
        Enviada em {formatarData(pedido.createdAt)}. Um operador de{' '}
        <strong>{pedido.affiliation?.name || 'sua federação'}</strong> vai analisar.
        Enquanto isso, você pode usar a plataforma normalmente.
      </p>

      <dl className="lista-revisao">
        <Linha rotulo="Nome" valor={pedido.fullName} />
        <Linha rotulo="Entidade de filiação" valor={pedido.affiliation?.name} />
        <Linha rotulo="Número de registro" valor={pedido.affiliationNumber} />
        {/* O CPF NÃO volta do servidor nesta rota, de propósito: você já sabe o
            seu documento, e devolvê-lo criaria mais uma superfície de vazamento. */}
        <Linha rotulo="CPF" valor="Guardado com a federação até a análise" />
      </dl>

      <button type="button" className="button button-ghost" onClick={aoCancelar}>
        Cancelar solicitação
      </button>
    </section>
  );
}

function Linha({ rotulo, valor }) {
  return (
    <div className="linha-revisao">
      <dt>{rotulo}</dt>
      <dd>{valor || '—'}</dd>
    </div>
  );
}

function Historico({ pedidos }) {
  return (
    <section className="card">
      <h2>Histórico</h2>
      <p className="muted">A fila guarda o que já aconteceu — inclusive o que foi recusado.</p>
      <ul className="lista-simples">
        {pedidos.map(pedido => (
          <li key={pedido.id}>
            <Badge tom={TOM[pedido.status]}>{ROTULO[pedido.status]}</Badge>
            <span>{pedido.affiliation?.name || '—'} · {formatarData(pedido.createdAt)}</span>
            {pedido.rejectionReason && <p className="muted">Motivo: {pedido.rejectionReason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

const VAZIO = { cpf: '', sex: '', affiliationId: '', affiliationNumber: '', birthDate: '' };

function Formulario({ nomeDaConta, ultimaRecusa, aoEnviar, notificar }) {
  // Só filiações ATIVAS entram no seletor: escolher uma inativa levaria a um
  // 422 do servidor depois de a pessoa já ter digitado o CPF.
  const filiacoes = useFetch(() => api.affiliations.list({ limit: 200 }), []);
  const [form, setForm] = useState({ ...VAZIO, name: nomeDaConta });
  const [erros, setErros] = useState({});
  const [erroGeral, setErroGeral] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const campo = (nome, valor) => {
    setForm(anterior => ({ ...anterior, [nome]: valor }));
    setErros(anteriores => (anteriores[nome] ? { ...anteriores, [nome]: undefined } : anteriores));
  };

  const enviar = async evento => {
    evento.preventDefault();
    if (enviando) return;

    const encontrados = errosDaSolicitacao(form);
    if (Object.keys(encontrados).length) {
      setErros(encontrados);
      return;
    }

    setEnviando(true);
    setErroGeral(null);
    try {
      await api.athleteRequests.criar(corpoDaSolicitacao(form));
      // O formulário é limpo NO SUCESSO: deixar o CPF na tela depois do envio
      // o mantém visível para quem passar pelo computador.
      setForm({ ...VAZIO, name: nomeDaConta });
      notificar?.('Solicitação enviada. A federação vai analisar.');
      aoEnviar();
    } catch (problema) {
      setErroGeral(problema.message);
    } finally {
      setEnviando(false);
    }
  };

  const ativas = (filiacoes.data?.items ?? []).filter(item => item.active !== false);

  return (
    <section className="card">
      <h2>Solicitar perfil de atleta</h2>
      <p className="muted">
        Estes dados vão direto para a federação que você escolher. Nada fica guardado neste
        navegador.
      </p>

      {ultimaRecusa?.rejectionReason && (
        <div className="alert alert-alerta" role="status">
          <div>
            <strong>Sua última solicitação foi recusada.</strong>
            <p>Motivo: {ultimaRecusa.rejectionReason}</p>
          </div>
        </div>
      )}

      <form onSubmit={enviar} noValidate>
        <Field label="Nome completo" required hint="Como consta no seu documento.">
          <input
            value={form.name} onChange={e => campo('name', e.target.value)} maxLength={160}
            aria-invalid={!!erros.name}
          />
        </Field>
        {erros.name && <small className="campo-erro" role="alert">{erros.name}</small>}

        <Field label="CPF" required hint="Usado para vincular seus resultados. Nunca aparece em busca pública.">
          <input
            inputMode="numeric"
            value={form.cpf}
            onChange={e => campo('cpf', mascararCpfEntrada(e.target.value))}
            placeholder="000.000.000-00"
            autoComplete="off"
            aria-invalid={!!erros.cpf}
            aria-describedby={erros.cpf ? 'erro-cpf' : undefined}
          />
        </Field>
        {erros.cpf && <small id="erro-cpf" className="campo-erro" role="alert">{erros.cpf}</small>}
        {cpfValido(form.cpf) && <small className="muted">Será enviado como {cpfResumido(form.cpf)}</small>}

        <Field label="Categoria de competição" required hint="Define em quais categorias você pode ser inscrito.">
          <select value={form.sex} onChange={e => campo('sex', e.target.value)} aria-invalid={!!erros.sex}>
            <option value="">—</option>
            <option value="FEMALE">Feminino</option>
            <option value="MALE">Masculino</option>
          </select>
        </Field>
        {erros.sex && <small className="campo-erro" role="alert">{erros.sex}</small>}

        <Field label="Data de nascimento" hint="Opcional. Usada para conferir sua faixa etária.">
          <input type="date" value={form.birthDate} onChange={e => campo('birthDate', e.target.value)} />
        </Field>
        {erros.birthDate && <small className="campo-erro" role="alert">{erros.birthDate}</small>}

        <Field label="Entidade de filiação" required hint="A federação que confirma o seu vínculo.">
          <select
            value={form.affiliationId}
            onChange={e => campo('affiliationId', e.target.value)}
            disabled={filiacoes.loading}
            aria-invalid={!!erros.affiliationId}
          >
            <option value="">{filiacoes.loading ? 'Carregando…' : '—'}</option>
            {ativas.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}{item.state ? ` — ${item.state}` : ''}
              </option>
            ))}
          </select>
        </Field>
        {erros.affiliationId && <small className="campo-erro" role="alert">{erros.affiliationId}</small>}
        {/* Lista vazia não é "escolha nenhuma": é um impedimento, e a pessoa
            precisa saber que não adianta insistir no formulário. */}
        {!filiacoes.loading && !filiacoes.error && ativas.length === 0 && (
          <small className="muted">
            Nenhuma entidade de filiação ativa está disponível para a sua conta. Fale com a
            organização do campeonato.
          </small>
        )}
        {filiacoes.error && (
          <small className="campo-erro" role="alert">
            Não conseguimos carregar as entidades de filiação. {filiacoes.error}
          </small>
        )}

        <Field label="Número de registro" required hint="O número que a federação lhe deu.">
          <input
            value={form.affiliationNumber}
            onChange={e => campo('affiliationNumber', e.target.value)}
            maxLength={40}
            aria-invalid={!!erros.affiliationNumber}
          />
        </Field>
        {erros.affiliationNumber && <small className="campo-erro" role="alert">{erros.affiliationNumber}</small>}

        {erroGeral && (
          <div className="alert alert-erro" role="alert"><div><strong>{erroGeral}</strong></div></div>
        )}

        <button type="submit" className="button button-primary" disabled={enviando}>
          {enviando ? 'Enviando…' : 'Enviar para análise'}
        </button>
      </form>
    </section>
  );
}

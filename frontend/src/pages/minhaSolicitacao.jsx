import { useEffect, useRef, useState } from 'react';
import { api, refreshData } from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { PageHead, Field, Badge, AsyncSection, ConfirmDialog, ProtectedMedia } from '../components/ui';
import {
  mascararCpfEntrada, cpfResumido, errosDaSolicitacao, corpoDaSolicitacao, cpfValido
} from '../lib/formulario';
import { formatarData } from '../lib/format';
import { conferirFoto, TIPOS_DE_FOTO } from '../lib/foto';

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
  // Recarrega enquanto houver pedido EM ANÁLISE.
  //
  // Sem isto, quem deixa a tela aberta esperando a federação continua vendo
  // "em análise" depois de já ter sido aprovado: a decisão é de outra pessoa,
  // noutra sessão, e nada avisa esta aba. Medido no navegador — o operador
  // aprovava e a tela do solicitante não mudava.
  //
  // O intervalo entra em `recarregarACada` só quando existe pedido aberto; o
  // efeito do hook rearma sozinho quando o valor muda, e volta a zero (sem
  // ciclo) assim que o pedido é decidido. `useFetch` já segura a recarga com a
  // aba em segundo plano e não empilha requisição em voo.
  const [pedidoEmAnalise, setPedidoEmAnalise] = useState(false);
  const pedidos = useFetch(
    async () => {
      const items = (await api.athleteRequests.meus()).items ?? [];
      setPedidoEmAnalise(items.some(pedido => pedido.status === 'PENDING'));
      return items;
    },
    [],
    { recarregarACada: pedidoEmAnalise ? 60000 : 0 }
  );
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
                <EmAnalise pedido={emAberto} aoCancelar={() => setCancelando(emAberto)} aoMudarFoto={() => pedidos.reload()} notificar={notificar} />
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

function EmAnalise({ pedido, aoCancelar, aoMudarFoto, notificar }) {
  const [enviando, setEnviando] = useState(false);

  // Enquanto o pedido está aberto a foto pode ser trocada: é o caminho de
  // volta para quem enviou a solicitação e viu a foto falhar, e evita que a
  // pessoa cancele o pedido inteiro só para corrigir a imagem.
  const trocar = async escolha => {
    setEnviando(true);
    try {
      if (escolha) await api.athleteRequests.enviarFoto(pedido.id, escolha.arquivo);
      else await api.athleteRequests.removerFoto(pedido.id);
      notificar?.(escolha ? 'Foto enviada.' : 'Foto removida.');
      aoMudarFoto();
    } catch (problema) {
      notificar?.(problema.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

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

      <div className="campo-da-foto">
        <span className="rotulo-da-foto">Foto enviada</span>
        <div className="foto-escolha">
          <div className="foto-previa">
            {/* A foto é buscada COM o token: a rota exige sessão e decide entre
                o dono e o operador. `<img src>` cru não manda cabeçalho. */}
            {pedido.hasPhoto
              ? <ProtectedMedia path={`/media/athlete-requests/${pedido.id}/photo`} alt="Foto enviada na solicitação" />
              : <span className="foto-vazia">Sem foto</span>}
          </div>
          <div className="foto-acoes">
            <EscolhaDaFoto
              foto={null}
              aoEscolher={escolha => escolha && trocar(escolha)}
              desabilitado={enviando}
            />
            {pedido.hasPhoto && (
              <button type="button" className="button button-ghost button-sm" onClick={() => trocar(null)} disabled={enviando}>
                Remover foto
              </button>
            )}
          </div>
        </div>
      </div>

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

// Escolha da foto, com pré-visualização local.
//
// A imagem NÃO sobe aqui: fica em memória até a solicitação existir. O
// `URL.createObjectURL` é revogado quando a escolha muda ou o componente sai —
// sem isso, cada troca de foto deixa um blob preso na memória da aba.
function EscolhaDaFoto({ foto, aoEscolher, desabilitado }) {
  const [erro, setErro] = useState(null);
  const entrada = useRef(null);
  const [previa, setPrevia] = useState(null);

  useEffect(() => {
    if (!foto?.arquivo) { setPrevia(null); return undefined; }
    const url = URL.createObjectURL(foto.arquivo);
    setPrevia(url);
    return () => URL.revokeObjectURL(url);
  }, [foto]);

  const escolher = evento => {
    const arquivo = evento.target.files?.[0];
    // Limpa o input para que escolher O MESMO arquivo de novo dispare `change`
    // — sem isso, corrigir um erro reenviando o mesmo arquivo não faz nada.
    evento.target.value = '';
    if (!arquivo) return;

    const resultado = conferirFoto(arquivo);
    if (resultado.erro) { setErro(resultado.erro); return; }
    setErro(null);
    aoEscolher({ arquivo, nome: arquivo.name });
  };

  return (
    <div className="campo-da-foto">
      <span className="rotulo-da-foto">Foto de perfil</span>
      <p className="muted">Opcional. A federação usa a foto para confirmar sua identidade.</p>

      <div className="foto-escolha">
        <div className="foto-previa" aria-hidden={!previa}>
          {previa
            ? <img src={previa} alt={`Pré-visualização da foto escolhida: ${foto?.nome || ''}`} />
            : <span className="foto-vazia">Sem foto</span>}
        </div>

        <div className="foto-acoes">
          <input
            ref={entrada}
            type="file"
            accept={TIPOS_DE_FOTO.join(',')}
            onChange={escolher}
            className="sr-only"
            id="entrada-da-foto"
            disabled={desabilitado}
          />
          <label htmlFor="entrada-da-foto" className={`button button-secondary${desabilitado ? ' is-disabled' : ''}`}>
            {foto ? 'Trocar foto' : 'Escolher foto'}
          </label>
          {foto && (
            <button type="button" className="button button-ghost button-sm" onClick={() => { aoEscolher(null); setErro(null); }} disabled={desabilitado}>
              Remover
            </button>
          )}
          <small className="muted">JPG, PNG ou WebP, até 5 MB.</small>
        </div>
      </div>

      {erro && <small className="campo-erro" role="alert">{erro}</small>}
    </div>
  );
}

const VAZIO = { cpf: '', sex: '', affiliationId: '', affiliationNumber: '', birthDate: '' };

function Formulario({ nomeDaConta, ultimaRecusa, aoEnviar, notificar }) {
  // A vitrine de autocadastro, e NÃO `GET /affiliations`: aquela é escopada ao
  // vínculo do ator, e quem acabou de criar conta não tem vínculo nenhum — a
  // lista voltava vazia e a solicitação era impossível. Medido na API.
  //
  // Só aparecem aqui filiações ativas de federações ativas que decidiram
  // receber pedido espontâneo. Quem decide é a federação, no servidor.
  // SEM `limit`: o schema das rotas públicas tem teto de 100, e mandar 200
  // devolvia 400 VALIDATION_ERROR — a lista ficava vazia e a tela parecia
  // dizer que não há federação nenhuma. Só o navegador pegou isto: o teste de
  // backend chamava a rota sem parâmetro e o de frontend usava dublê.
  const filiacoes = useFetch(() => api.publicApi.affiliations(), []);
  const [form, setForm] = useState({ ...VAZIO, name: nomeDaConta });
  const [erros, setErros] = useState({});
  const [erroGeral, setErroGeral] = useState(null);
  const [enviando, setEnviando] = useState(false);
  // A foto fica em memória até a solicitação existir: a rota é
  // `POST /athlete-requests/:id/photo`, e não há id antes do envio.
  const [foto, setFoto] = useState(null);

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
      // Dois pedidos por trás de um botão: a solicitação nasce e só então a
      // foto tem um id a que se ligar.
      const pedido = await api.athleteRequests.criar(corpoDaSolicitacao(form));

      if (foto) {
        try {
          await api.athleteRequests.enviarFoto(pedido.id, foto.arquivo);
        } catch (problemaDaFoto) {
          // A SOLICITAÇÃO JÁ EXISTE. Dizer "falhou" agora faria a pessoa tentar
          // de novo e bater em 409. O que ela precisa saber é que o pedido
          // entrou e que só a foto ficou faltando — e a tela de acompanhamento
          // deixa reenviá-la.
          notificar?.(`Solicitação enviada, mas a foto não subiu: ${problemaDaFoto.message} Você pode reenviá-la abaixo.`, 'erro');
          setForm({ ...VAZIO, name: nomeDaConta });
          setFoto(null);
          aoEnviar();
          return;
        }
      }

      // O formulário é limpo NO SUCESSO: deixar o CPF na tela depois do envio
      // o mantém visível para quem passar pelo computador.
      setForm({ ...VAZIO, name: nomeDaConta });
      setFoto(null);
      notificar?.('Solicitação enviada. A federação vai analisar.');
      aoEnviar();
    } catch (problema) {
      setErroGeral(problema.message);
    } finally {
      setEnviando(false);
    }
  };

  // A vitrine já devolve só o elegível: filtrar de novo aqui esconderia um
  // defeito do servidor em vez de mostrá-lo.
  const ativas = filiacoes.data?.items ?? [];

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

        <EscolhaDaFoto foto={foto} aoEscolher={setFoto} desabilitado={enviando} />

        {erroGeral && (
          <div className="alert alert-erro" role="alert"><div><strong>{erroGeral}</strong></div></div>
        )}

        <p className="muted aviso-de-envio">
          Seus dados serão enviados para validação da federação.
        </p>

        <button type="submit" className="button button-primary" disabled={enviando}>
          {enviando ? 'Enviando…' : 'Enviar para análise'}
        </button>
      </form>
    </section>
  );
}

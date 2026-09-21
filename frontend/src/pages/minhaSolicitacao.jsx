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
import { useIdioma } from '../lib/idioma';

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
// O CÓDIGO do estado é o que vem da API e não muda de idioma; o mapa leva à
// CHAVE do rótulo, e não ao rótulo.
const ROTULO = {
  PENDING: 'solicitacao.emAnalise',
  APPROVED: 'solicitacao.aprovada',
  REJECTED: 'solicitacao.recusada',
  CANCELLED: 'solicitacao.cancelada'
};

export default function MinhaSolicitacao({ notificar }) {
  const { t } = useIdioma();
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
      notificar?.(t('solicitacao.canceladaAviso'));
    } catch (problema) {
      setCancelando(null);
      notificar?.(problema.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('solicitacao.perfilDeAtleta')}
        title={t('solicitacao.minhaSolicitacao')}
        description={t('solicitacao.descricao')}
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
                  <Badge tom="sucesso">{t('solicitacao.perfilAtivo')}</Badge>
                  <h2>{t('solicitacao.jaCompete')}</h2>
                  <p className="muted">{t('solicitacao.jaCompeteTexto')}</p>
                </section>
              ) : emAberto ? (
                <EmAnalise pedido={emAberto} aoCancelar={() => setCancelando(emAberto)} aoMudarFoto={() => pedidos.reload()} notificar={notificar} />
              ) : aprovado ? (
                <section className="card">
                  <Badge tom="sucesso">{t('solicitacao.aprovada')}</Badge>
                  <h2>{t('solicitacao.foiAprovada')}</h2>
                  <p className="muted">{t('solicitacao.foiAprovadaTexto')}</p>
                  <button type="button" className="button button-ghost button-sm" onClick={() => refreshSession()}>
                    {t('solicitacao.atualizarSessao')}
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
          title={t('solicitacao.cancelarSolicitacao')}
          message={t('solicitacao.cancelarAviso')}
          confirmLabel={t('solicitacao.cancelarSolicitacao')}
          onConfirm={cancelar}
          onClose={() => setCancelando(null)}
        />
      )}
    </div>
  );
}

function EmAnalise({ pedido, aoCancelar, aoMudarFoto, notificar }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);

  // Enquanto o pedido está aberto a foto pode ser trocada: é o caminho de
  // volta para quem enviou a solicitação e viu a foto falhar, e evita que a
  // pessoa cancele o pedido inteiro só para corrigir a imagem.
  const trocar = async escolha => {
    setEnviando(true);
    try {
      if (escolha) await api.athleteRequests.enviarFoto(pedido.id, escolha.arquivo);
      else await api.athleteRequests.removerFoto(pedido.id);
      notificar?.(t(escolha ? 'solicitacao.fotoEnviadaAviso' : 'solicitacao.fotoRemovidaAviso'));
      aoMudarFoto();
    } catch (problema) {
      notificar?.(problema.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="card">
      <Badge tom="atencao">{t('solicitacao.emAnalise')}</Badge>
      <h2>{t('solicitacao.naFila')}</h2>
      <p className="muted">
        {t('solicitacao.enviadaEm', { data: formatarData(pedido.createdAt) })}{' '}
        <strong>{pedido.affiliation?.name || t('solicitacao.suaFederacao')}</strong>{' '}
        {t('solicitacao.vaiAnalisar')}
      </p>

      <dl className="lista-revisao">
        <Linha rotulo={t('solicitacao.nome')} valor={pedido.fullName} />
        <Linha rotulo={t('solicitacao.entidade')} valor={pedido.affiliation?.name} />
        <Linha rotulo={t('solicitacao.numeroDeRegistro')} valor={pedido.affiliationNumber} />
        {/* O CPF NÃO volta do servidor nesta rota, de propósito: você já sabe o
            seu documento, e devolvê-lo criaria mais uma superfície de vazamento. */}
        <Linha rotulo="CPF" valor={t('solicitacao.cpfGuardado')} />
      </dl>

      <div className="campo-da-foto">
        <span className="rotulo-da-foto">{t('solicitacao.fotoEnviada')}</span>
        <div className="foto-escolha">
          <div className="foto-previa">
            {/* A foto é buscada COM o token: a rota exige sessão e decide entre
                o dono e o operador. `<img src>` cru não manda cabeçalho. */}
            {pedido.hasPhoto
              ? <ProtectedMedia path={`/media/athlete-requests/${pedido.id}/photo`} alt={t('solicitacao.fotoEnviadaAlt')} />
              : <span className="foto-vazia">{t('solicitacao.semFoto')}</span>}
          </div>
          <div className="foto-acoes">
            <EscolhaDaFoto
              foto={null}
              aoEscolher={escolha => escolha && trocar(escolha)}
              desabilitado={enviando}
            />
            {pedido.hasPhoto && (
              <button type="button" className="button button-ghost button-sm" onClick={() => trocar(null)} disabled={enviando}>
                {t('solicitacao.removerFoto')}
              </button>
            )}
          </div>
        </div>
      </div>

      <button type="button" className="button button-ghost" onClick={aoCancelar}>
        {t('solicitacao.cancelarSolicitacao')}
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
  const { t } = useIdioma();

  return (
    <section className="card">
      <h2>{t('solicitacao.historico')}</h2>
      <p className="muted">{t('solicitacao.historicoTexto')}</p>
      <ul className="lista-simples">
        {pedidos.map(pedido => (
          <li key={pedido.id}>
            <Badge tom={TOM[pedido.status]}>{t(ROTULO[pedido.status])}</Badge>
            <span>{pedido.affiliation?.name || '—'} · {formatarData(pedido.createdAt)}</span>
            {pedido.rejectionReason && <p className="muted">{t('solicitacao.motivo')}: {pedido.rejectionReason}</p>}
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
  const { t, idioma } = useIdioma();
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
    // A conferência devolve chave e números crus; o tamanho é escrito aqui,
    // onde se sabe o idioma — "5,0" em português, "5.0" em inglês.
    if (resultado.erro) {
      // Uma casa decimal SEMPRE: "5 MB" e "5,0 MB" dizem o mesmo, mas o
      // segundo deixa claro que o limite é exato, e é como o aviso sempre foi.
      const numero = new Intl.NumberFormat(idioma, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const valores = resultado.valores
        ? { tamanho: numero.format(resultado.valores.tamanho), limite: numero.format(resultado.valores.limite) }
        : undefined;
      setErro(t(resultado.erro, valores));
      return;
    }
    setErro(null);
    aoEscolher({ arquivo, nome: arquivo.name });
  };

  return (
    <div className="campo-da-foto">
      <span className="rotulo-da-foto">{t('solicitacao.fotoDePerfil')}</span>
      <p className="muted">{t('solicitacao.fotoOpcional')}</p>

      <div className="foto-escolha">
        <div className="foto-previa" aria-hidden={!previa}>
          {previa
            ? <img src={previa} alt={t('solicitacao.previaDaFoto', { nome: foto?.nome || '' })} />
            : <span className="foto-vazia">{t('solicitacao.semFoto')}</span>}
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
            {t(foto ? 'solicitacao.trocarFoto' : 'solicitacao.escolherFoto')}
          </label>
          {foto && (
            <button type="button" className="button button-ghost button-sm" onClick={() => { aoEscolher(null); setErro(null); }} disabled={desabilitado}>
              {t('solicitacao.remover')}
            </button>
          )}
          <small className="muted">{t('solicitacao.formatosDaFoto')}</small>
        </div>
      </div>

      {erro && <small className="campo-erro" role="alert">{erro}</small>}
    </div>
  );
}

const VAZIO = { cpf: '', sex: '', affiliationId: '', affiliationNumber: '', birthDate: '' };

function Formulario({ nomeDaConta, ultimaRecusa, aoEnviar, notificar }) {
  const { t } = useIdioma();
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
          notificar?.(t('solicitacao.enviadaSemFoto', { erro: problemaDaFoto.message }), 'erro');
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
      notificar?.(t('solicitacao.enviada'));
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
      <h2>{t('solicitacao.solicitarPerfil')}</h2>
      <p className="muted">{t('solicitacao.solicitarTexto')}</p>

      {ultimaRecusa?.rejectionReason && (
        <div className="alert alert-alerta" role="status">
          <div>
            <strong>{t('solicitacao.ultimaRecusada')}</strong>
            <p>{t('solicitacao.motivo')}: {ultimaRecusa.rejectionReason}</p>
          </div>
        </div>
      )}

      <form onSubmit={enviar} noValidate>
        <Field label={t('cadastro.nomeCompleto')} required hint={t('solicitacao.nomeHint')}>
          <input
            value={form.name} onChange={e => campo('name', e.target.value)} maxLength={160}
            aria-invalid={!!erros.name}
          />
        </Field>
        {erros.name && <small className="campo-erro" role="alert">{t(erros.name)}</small>}

        <Field label="CPF" required hint={t('solicitacao.cpfHint')}>
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
        {erros.cpf && <small id="erro-cpf" className="campo-erro" role="alert">{t(erros.cpf)}</small>}
        {cpfValido(form.cpf) && (
          <small className="muted">{t('solicitacao.cpfSeraEnviado', { resumo: cpfResumido(form.cpf) })}</small>
        )}

        <Field label={t('solicitacao.categoriaDeCompeticao')} required hint={t('solicitacao.categoriaHint')}>
          <select value={form.sex} onChange={e => campo('sex', e.target.value)} aria-invalid={!!erros.sex}>
            <option value="">—</option>
            <option value="FEMALE">{t('solicitacao.feminino')}</option>
            <option value="MALE">{t('solicitacao.masculino')}</option>
          </select>
        </Field>
        {erros.sex && <small className="campo-erro" role="alert">{t(erros.sex)}</small>}

        <Field label={t('cadastro.dataDeNascimento')} hint={t('solicitacao.nascimentoHint')}>
          <input type="date" value={form.birthDate} onChange={e => campo('birthDate', e.target.value)} />
        </Field>
        {erros.birthDate && <small className="campo-erro" role="alert">{t(erros.birthDate)}</small>}

        <Field label={t('solicitacao.entidade')} required hint={t('solicitacao.entidadeHint')}>
          <select
            value={form.affiliationId}
            onChange={e => campo('affiliationId', e.target.value)}
            disabled={filiacoes.loading}
            aria-invalid={!!erros.affiliationId}
          >
            <option value="">{filiacoes.loading ? t('estado.carregando') : '—'}</option>
            {ativas.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}{item.state ? ` — ${item.state}` : ''}
              </option>
            ))}
          </select>
        </Field>
        {erros.affiliationId && <small className="campo-erro" role="alert">{t(erros.affiliationId)}</small>}
        {/* Lista vazia não é "escolha nenhuma": é um impedimento, e a pessoa
            precisa saber que não adianta insistir no formulário. */}
        {!filiacoes.loading && !filiacoes.error && ativas.length === 0 && (
          <small className="muted">{t('solicitacao.semEntidades')}</small>
        )}
        {filiacoes.error && (
          <small className="campo-erro" role="alert">
            {t('solicitacao.erroEntidades')} {filiacoes.error}
          </small>
        )}

        <Field label={t('solicitacao.numeroDeRegistro')} required hint={t('solicitacao.matriculaHint')}>
          <input
            value={form.affiliationNumber}
            onChange={e => campo('affiliationNumber', e.target.value)}
            maxLength={40}
            aria-invalid={!!erros.affiliationNumber}
          />
        </Field>
        {erros.affiliationNumber && <small className="campo-erro" role="alert">{t(erros.affiliationNumber)}</small>}

        <EscolhaDaFoto foto={foto} aoEscolher={setFoto} desabilitado={enviando} />

        {erroGeral && (
          <div className="alert alert-erro" role="alert"><div><strong>{erroGeral}</strong></div></div>
        )}

        <p className="muted aviso-de-envio">{t('solicitacao.avisoDeEnvio')}</p>

        <button type="submit" className="button button-primary" disabled={enviando}>
          {t(enviando ? 'cadastro.enviando' : 'solicitacao.enviarParaAnalise')}
        </button>
      </form>
    </section>
  );
}

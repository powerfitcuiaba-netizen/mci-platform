import { useEffect, useState } from 'react';
import { ClipboardCheck, IdCard, Search, ShieldCheck, UserPlus, Users2 } from 'lucide-react';
import { api, fetchMediaObjectUrl, refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { ACEITO_NO_SELETOR, CHAVE_DA_RECUSA, normalizarFotoDoAparelho } from '../lib/fotoDoAparelho';
import {
  AsyncSection, Badge, EmptyState, Field, Modal, ModalActions, PageHead, Skeleton
} from '../components/ui';
import { formatarData } from '../lib/format';
import { useIdioma } from '../lib/idioma';
import { useAuth } from '../AuthContext';
import { permissoesDe, podeCom } from '../lib/permissoes';

// ============================================================================
// TREINADORES & EQUIPES — as telas.
//
// TRÊS TELAS, TRÊS AUTORIDADES. A divisão não é de conveniência: é a mesma das
// decisões aprovadas, e é o que impede que um botão apareça para quem a API vai
// recusar.
//
//   PainelDoTreinador   o treinador e o que é dele: o próprio cadastro, as
//                       equipes, os atletas vinculados, os pedidos que ele fez.
//   MinhaEquipe         o ATLETA respondendo ao convite. É a confirmação dele
//                       que cria o vínculo — enviar pedido não vincula ninguém.
//   AdminTreinadores    a mesa central (R-03) e a autorização por federação
//                       (R-04), mais a delegação central (R-02).
//
// O QUE ESTAS TELAS NÃO MOSTRAM, e não é omissão: documento de análise, CPF e
// qualquer dado pessoal do atleta além de nome, nome de palco e matrícula. É a
// decisão R-05, e a API já não os entrega — a tela não teria como exibi-los nem
// se quisesse. Ver a projeção explícita em `coachService.SELECT_ATLETA_ESPORTIVO`.
//
// E O RANKING DE TREINADORES NÃO TEM CLASSIFICAÇÃO. A fórmula não está
// homologada; o cartão mostra "Ranking em homologação" e as equipes com os
// totais que o ranking de EQUIPES já publica. Nenhum número é inventado aqui.
// ============================================================================

const TOM_DO_CADASTRO = {
  PENDING: 'atencao', APPROVED: 'sucesso', REJECTED: 'perigo',
  SUSPENDED: 'perigo', CANCELLED: 'neutro'
};
const ROTULO_DO_CADASTRO = {
  PENDING: 'treinador.estadoPendente',
  APPROVED: 'treinador.estadoAprovado',
  REJECTED: 'treinador.estadoRejeitado',
  SUSPENDED: 'treinador.estadoSuspenso',
  CANCELLED: 'treinador.estadoEncerrado'
};
const TOM_DO_PEDIDO = {
  PENDING: 'atencao', CONFIRMED: 'sucesso', REJECTED: 'perigo', CANCELLED: 'neutro'
};
const ROTULO_DO_PEDIDO = {
  PENDING: 'pedidoEquipe.pendente',
  CONFIRMED: 'pedidoEquipe.confirmado',
  REJECTED: 'pedidoEquipe.recusado',
  CANCELLED: 'pedidoEquipe.cancelado'
};

// A mensagem que a API manda é a que a pessoa lê. A tela não reescreve recusa:
// o servidor sabe por que recusou, e traduzir isso em "erro ao salvar" apagaria
// justamente a instrução de como resolver.
const mensagemDaFalha = (erro, padrao) => erro?.message || padrao;

// ACHADO A-11: A TELA ADMINISTRATIVA NÃO PODE TRANSFORMAR RECUSA EM LISTA VAZIA.
//
// As duas listas da mesa central abriam com `.catch(() => ({ items: [] }))`. O
// efeito é o pior possível numa tela de decisão: um 403 (a conta não tem
// `coaches.approve` ou `central.grant`), um 500 e uma fila genuinamente vazia
// produziam A MESMA tela — "nada aqui". Quem analisa cadastro conclui que não há
// pendência quando o que houve foi recusa, e a pendência fica sem resposta.
//
// `relancar` preserva o erro para o `AsyncSection`, que já sabe mostrar estado de
// falha com botão de tentar de novo, e distingue a RECUSA DE PERMISSÃO das demais
// falhas — são ações diferentes: uma se resolve com quem concede acesso, a outra
// com tentar de novo.
const relancar = (erro, { negado, generico }) => {
  throw new Error(erro?.status === 403 ? negado : mensagemDaFalha(erro, generico));
};

// --------------------------------------------------------------- AUTOCADASTRO
function FormularioDeAutocadastro({ notificar, aoConcluir }) {
  const { t } = useIdioma();
  const [dados, setDados] = useState({ name: '', registration: '', phone: '', email: '', bio: '' });
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);
  // A FOTO E A SUA PRÉVIA. `previa` é um object URL, criado a cada escolha e
  // revogado junto com a anterior: sem revogar, cada troca deixa um blob preso
  // na memória do navegador até a aba fechar.
  const [foto, setFoto] = useState(null);
  const [previa, setPrevia] = useState(null);
  // Preparo da foto: estado separado de `enviando` porque acontece ANTES do
  // envio e pode falhar sem que nada tenha ido à rede.
  const [preparando, setPreparando] = useState(false);

  const campo = (chave, valor) => setDados(atual => ({ ...atual, [chave]: valor }));

  // A FOTO PASSA PELO NORMALIZADOR DO APARELHO ANTES DE VIRAR ESCOLHA.
  //
  // O servidor aceita PNG, JPEG e WebP. O padrão de câmera do iPhone é HEIC, e
  // sem esta passagem a pessoa escolhia a foto, via a prévia, clicava em enviar
  // e só então levava 415 — o pior momento possível para descobrir.
  //
  // `normalizarFotoDoAparelho` devolve o PRÓPRIO arquivo quando ele já serve, e
  // isso importa: reencodar um JPEG apagaria a etiqueta EXIF de orientação, que
  // é o que o servidor usa para endireitar foto de retrato.
  //
  // A recusa vai para `recusa`, o mesmo lugar onde a recusa do servidor
  // aparece — uma frase só, num lugar só, dita antes da ida à rede.
  const escolherFoto = async arquivo => {
    setRecusa(null);

    if (!arquivo) {
      setPrevia(anterior => { if (anterior) URL.revokeObjectURL(anterior); return null; });
      setFoto(null);
      return;
    }

    // O PREPARO TEM ESTADO PRÓPRIO porque tem DURAÇÃO própria: decodificar e
    // reduzir uma foto de 12 MP leva um instante visível num celular, e sem
    // dizer nada a tela fica parada depois do toque — quem usa toca de novo.
    setPreparando(true);
    let pronta;
    try {
      pronta = await normalizarFotoDoAparelho(arquivo);
    } catch (erro) {
      // A recusa vem com CÓDIGO: a frase é a do idioma em vigor, não a do
      // módulo. `erro.message` fica como reserva para o que não tiver código.
      setRecusa(erro.codigo ? t(CHAVE_DA_RECUSA[erro.codigo]) : erro.message);
      setPrevia(anterior => { if (anterior) URL.revokeObjectURL(anterior); return null; });
      setFoto(null);
      return;
    } finally {
      setPreparando(false);
    }

    setPrevia(anterior => {
      if (anterior) URL.revokeObjectURL(anterior);
      return URL.createObjectURL(pronta);
    });
    setFoto(pronta);
  };

  useEffect(() => () => { if (previa) URL.revokeObjectURL(previa); }, [previa]);

  const enviar = async evento => {
    evento.preventDefault();
    setRecusa(null);

    // O BLOQUEIO É AQUI E TAMBÉM NO SERVIDOR, e as duas frases são a MESMA.
    // A daqui poupa uma ida à rede; a de lá é a que vale, e é ela que impede
    // cadastro sem foto por chamada direta à API. Se as duas divergirem, quem
    // manda é o servidor — por isso a mensagem dele não é reescrita na tela.
    if (!foto) {
      setRecusa(t('treinador.fotoObrigatoria'));
      return;
    }

    setEnviando(true);
    try {
      // Só o que tem conteúdo viaja: campo opcional em branco enviado como
      // string vazia é reprovado pela validação, e a recusa pareceria um bug.
      const corpo = Object.fromEntries(
        Object.entries(dados).filter(([, valor]) => String(valor).trim() !== '')
      );
      await api.coaches.selfRegister(corpo, foto);
      refreshData();
      notificar?.(t('treinador.cadastroEnviado'), 'sucesso');
      aoConcluir?.();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="card" onSubmit={enviar}>
      <h3>{t('treinador.cadastroTitulo')}</h3>
      <p className="muted">{t('treinador.cadastroExplicacao')}</p>

      {recusa && (
        <div className="alert alert-erro" role="alert">
          <ShieldCheck size={16} />
          <div><p>{recusa}</p></div>
        </div>
      )}

      <div className="form-grid">
        <Field label={t('treinador.campoNome')} required>
          <input value={dados.name} onChange={evento => campo('name', evento.target.value)} required minLength={2} maxLength={120} />
        </Field>
        <Field label={t('treinador.campoRegistro')} hint={t('treinador.campoRegistroDica')}>
          <input value={dados.registration} onChange={evento => campo('registration', evento.target.value)} maxLength={60} />
        </Field>
        <Field label={t('treinador.campoTelefone')}>
          <input value={dados.phone} onChange={evento => campo('phone', evento.target.value)} maxLength={20} />
        </Field>
        <Field label={t('treinador.campoEmail')}>
          <input type="email" value={dados.email} onChange={evento => campo('email', evento.target.value)} maxLength={160} />
        </Field>
      </div>

      <Field label={t('treinador.campoApresentacao')} hint={t('treinador.campoApresentacaoDica')}>
        <textarea rows={4} value={dados.bio} onChange={evento => campo('bio', evento.target.value)} maxLength={1000} />
      </Field>

      {/* A FOTO, com prévia e troca ANTES de concluir. O `accept` limita o
          seletor do sistema; ele não é barreira — quem valida tipo, tamanho e
          os BYTES é o servidor. */}
      <Field label={t('treinador.campoFoto')} required hint={t('treinador.campoFotoDica')}>
        <input
          type="file"
          accept={ACEITO_NO_SELETOR}
          disabled={preparando}
          onChange={evento => escolherFoto(evento.target.files?.[0] ?? null)}
        />
      </Field>

      {/* `aria-live` porque quem usa leitor de tela também precisa saber que a
          foto está sendo preparada — o campo desabilitado, sozinho, é silêncio. */}
      {preparando && <p className="muted" aria-live="polite">{t('foto.preparando')}</p>}

      {previa && (
        <div className="foto-escolhida">
          <img src={previa} alt={t('treinador.fotoPreviaAlt')} width={96} height={96} />
          <button type="button" className="button button-ghost button-sm" onClick={() => escolherFoto(null)}>
            {t('treinador.removerEscolha')}
          </button>
        </div>
      )}

      <div className="acoes-do-cartao">
        <button type="submit" className="button button-primary" disabled={enviando || preparando || !foto}>
          {t('treinador.enviarCadastro')}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------- PEDIR VÍNCULO
//
// DUAS ETAPAS NUMA TELA, e a ordem importa: primeiro localizar, depois pedir.
// A busca é por MATRÍCULA COMPLETA — não há consulta por nome nem por prefixo,
// e é uma das três contenções de enumeração do módulo (as outras são o teto de
// requisições e a auditoria de cada consulta).
function DialogoDeConvite({ equipes, notificar, onClose }) {
  const { t } = useIdioma();
  // Derivada, e não congelada — a mesma razão explicada em
  // `PedidosDasMinhasEquipes`. Aqui a consequência seria pior: o pedido sairia
  // sem equipe e a API o recusaria, sem que a tela soubesse dizer por quê.
  const [teamId, setTeamId] = useState('');
  const [matricula, setMatricula] = useState('');
  const [achado, setAchado] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const escolhida = teamId || equipes[0]?.id || '';
  const equipe = equipes.find(item => item.id === escolhida) ?? null;

  const localizar = async evento => {
    evento.preventDefault();
    setRecusa(null);
    setAchado(null);
    if (!equipe) return;
    setBuscando(true);
    try {
      const resposta = await api.membershipRequests.lookupByAffiliation({
        organizationId: equipe.organizationId,
        affiliationNumber: matricula.trim()
      });
      setAchado(resposta);
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setBuscando(false);
    }
  };

  const pedir = async () => {
    if (!achado?.athlete || !equipe) return;
    setRecusa(null);
    setEnviando(true);
    try {
      await api.membershipRequests.create({ athleteId: achado.athlete.id, teamId: equipe.id });
      refreshData();
      notificar?.(t('pedidoEquipe.enviado'), 'sucesso');
      onClose();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('pedidoEquipe.convidarTitulo')} description={t('pedidoEquipe.convidarDescricao')} onClose={onClose}>
      <form onSubmit={localizar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('pedidoEquipe.campoEquipe')} required>
          <select value={escolhida} onChange={evento => { setTeamId(evento.target.value); setAchado(null); }}>
            {equipes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>

        <Field label={t('pedidoEquipe.campoMatricula')} required hint={t('pedidoEquipe.campoMatriculaDica')}>
          <input value={matricula} onChange={evento => setMatricula(evento.target.value)} required maxLength={40} />
        </Field>

        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
          <button type="submit" className="button button-primary" disabled={buscando || !matricula.trim()}>
            <Search size={14} /> {t('pedidoEquipe.localizar')}
          </button>
        </div>
      </form>

      {achado && !achado.found && (
        <div className="alert alert-atencao" role="status">
          <IdCard size={16} />
          <div><p>{t('pedidoEquipe.naoEncontrado')}</p></div>
        </div>
      )}

      {achado?.found && (
        <div className="card">
          <h4>{achado.athlete.fullName}</h4>
          <p className="muted">
            {t('pedidoEquipe.matricula')}: <strong>{achado.athlete.affiliationNumber}</strong>
            {achado.athlete.affiliation ? ` — ${achado.athlete.affiliation.name}` : ''}
          </p>

          {/* O VÍNCULO ATUAL É MOSTRADO ANTES DO PEDIDO, e não depois da
              recusa: sem isto o treinador envia um pedido que vai ser negado e
              não entende por quê. A informação já era revelada pela recusa 409
              desde antes deste módulo; aqui ela chega no lugar em que resolve. */}
          {achado.currentTeam && (
            <div className="alert alert-atencao" role="status">
              <Users2 size={16} />
              <div>
                <p>{t('pedidoEquipe.jaTemEquipe', { equipe: achado.currentTeam.name ?? '—' })}</p>
                <p className="muted">{t('pedidoEquipe.jaTemEquipeComoResolver')}</p>
              </div>
            </div>
          )}

          {!achado.currentTeam && achado.hasPendingRequest && (
            <div className="alert alert-atencao" role="status">
              <ClipboardCheck size={16} />
              <div><p>{t('pedidoEquipe.jaTemPedido')}</p></div>
            </div>
          )}

          <div className="acoes-do-cartao">
            <button
              type="button"
              className="button button-primary"
              onClick={pedir}
              disabled={enviando || Boolean(achado.currentTeam) || achado.hasPendingRequest}
            >
              <UserPlus size={14} /> {t('pedidoEquipe.enviarPedido')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------- O CARTÃO DO RANKING (§8.3)
//
// A ausência de classificação é o conteúdo deste cartão, e não uma pendência.
// Ele mostra o aviso de homologação e os totais que o ranking de EQUIPES já
// publica — nada é somado, ponderado ou ordenado aqui.
function CartaoDeRanking({ coachId }) {
  const { t } = useIdioma();
  // A TEMPORADA VEM ANTES DA PROJEÇÃO, E NÃO DEPOIS.
  //
  // `GET /coaches/:id/ranking/projection` recusa com 422 SEASON_REQUIRED quando
  // não há temporada na consulta, e é o comportamento certo: somar temporadas
  // diferentes não significa nada (a razão está em `rankingService.temporadaPadrao`).
  // A primeira versão desta tela chamava a projeção sem temporada e engolia a
  // recusa no `catch`, então o cartão nunca mostrava equipe alguma e o console
  // acumulava um 422 por carregamento — medido no gate visual em Chromium, nos
  // quatro perfis. A tela agora escolhe a temporada como a tela pública de
  // ranking escolhe, e só então pergunta.
  const temporadas = useFetch(() => api.ranking.seasons().catch(() => []), []);
  const listaDeTemporadas = Array.isArray(temporadas.data) ? temporadas.data : temporadas.data?.items ?? [];
  const [seasonId, setSeasonId] = useState('');
  // A lista chega ordenada por ano decrescente (`rankingService.listSeasons`):
  // a primeira é a mais recente, e é a escolha padrão.
  const escolhida = seasonId || listaDeTemporadas[0]?.id || '';

  const projecao = useFetch(
    () => (coachId && escolhida
      ? api.coaches.projection(coachId, { seasonId: escolhida }).catch(() => null)
      : Promise.resolve(null)),
    [coachId, escolhida],
    { ativo: Boolean(coachId && escolhida) }
  );

  const dados = projecao.data;

  return (
    <section className="card">
      <h3>{t('treinador.rankingTitulo')}</h3>
      <div className="alert alert-atencao" role="status">
        <ShieldCheck size={16} />
        <div>
          <p><strong>{t('treinador.rankingEmHomologacao')}</strong></p>
          <p className="muted">{t('treinador.rankingSemFormula')}</p>
        </div>
      </div>

      {listaDeTemporadas.length > 1 && (
        <div className="toolbar">
          <select
            className="select-control"
            value={escolhida}
            onChange={evento => setSeasonId(evento.target.value)}
            aria-label={t('publico.temporada')}
          >
            {listaDeTemporadas.map(temporada => (
              <option key={temporada.id} value={temporada.id}>{temporada.name || temporada.year}</option>
            ))}
          </select>
        </div>
      )}

      {dados?.teams?.length > 0 && (
        <div className="table-wrap"><table className="table">
          <thead>
            <tr>
              <th>{t('treinador.colunaEquipe')}</th>
              <th>{t('treinador.colunaPontosDaEquipe')}</th>
            </tr>
          </thead>
          <tbody>
            {dados.teams.map(linha => (
              <tr key={linha.teamId}>
                <td>{linha.team?.name ?? '—'}</td>
                <td>{linha.totalPoints ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

// ====================================================== FOTO NO PAINEL
//
// A FOTO ATUAL, o aviso de quem não tem, e a troca — tudo no mesmo cartão, porque
// é uma coisa só do ponto de vista de quem usa: "minha foto está aí? como troco?".
//
// A IMAGEM É BUSCADA COM TOKEN e exposta como object URL (`fetchMediaObjectUrl`),
// pelo mesmo motivo do avatar social: `<img src>` não manda cabeçalho, e token em
// query string acabaria em log de servidor, histórico e Referer.
function FotoDoTreinador({ coachId, temFoto, notificar, aoTrocar }) {
  const { t } = useIdioma();
  const [url, setUrl] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  useEffect(() => {
    if (!temFoto || !coachId) { setUrl(null); return undefined; }
    let vivo = true;
    let endereco = null;
    fetchMediaObjectUrl(`/media/coaches/${coachId}/photo`)
      .then(criado => {
        endereco = criado;
        if (vivo) setUrl(criado); else URL.revokeObjectURL(criado);
      })
      .catch(() => { if (vivo) setUrl(null); });
    return () => {
      vivo = false;
      if (endereco) URL.revokeObjectURL(endereco);
    };
  }, [coachId, temFoto]);

  // A TROCA PASSA PELO MESMO NORMALIZADOR DO CADASTRO, e por um motivo que não é
  // simetria: quem troca a foto depois costuma estar no celular, então é aqui que
  // o HEIC aparece MAIS, não menos. A conversão ficar só no cadastro deixaria o
  // 415 exatamente na tela de quem já é treinador.
  const enviar = async arquivo => {
    if (!arquivo) return;
    setRecusa(null);

    // `enviando` cobre o preparo TAMBÉM: para quem está olhando, escolher a foto
    // e a foto subir é um gesto só, e o campo precisa ficar indisponível do
    // começo ao fim dele.
    setEnviando(true);
    let pronta;
    try {
      pronta = await normalizarFotoDoAparelho(arquivo);
    } catch (problema) {
      setRecusa(problema.codigo ? t(CHAVE_DA_RECUSA[problema.codigo]) : problema.message);
      setEnviando(false);
      return;
    }

    try {
      await api.coaches.setMyPhoto(pronta);
      refreshData();
      notificar?.(t('treinador.fotoAtualizada'), 'sucesso');
      aoTrocar?.();
    } catch (problema) {
      setRecusa(mensagemDaFalha(problema, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('treinador.campoFoto')}</h3>
        <Badge tom={temFoto ? 'sucesso' : 'atencao'}>
          {t(temFoto ? 'treinador.noRanking' : 'treinador.foraDoRanking')}
        </Badge>
      </div>

      {recusa && (
        <div className="alert alert-erro" role="alert">
          <ShieldCheck size={16} />
          <div><p>{recusa}</p></div>
        </div>
      )}

      {/* O AVISO DE REGULARIZAÇÃO, para o cadastro anterior à decisão. Ele diz o
          que fazer E diz o que NÃO se perdeu — que é a parte que tira o susto. */}
      {!temFoto && (
        <EmptyState title={t('treinador.semFotoTitulo')} description={t('treinador.semFotoComoResolver')} />
      )}

      {temFoto && url && (
        <img className="foto-do-treinador" src={url} alt={t('treinador.fotoAtualAlt')} width={120} height={120} />
      )}

      <Field label={t(temFoto ? 'treinador.trocarFoto' : 'treinador.enviarFoto')} hint={t('treinador.campoFotoDica')}>
        <input
          type="file"
          accept={ACEITO_NO_SELETOR}
          disabled={enviando}
          onChange={evento => enviar(evento.target.files?.[0] ?? null)}
        />
      </Field>
    </section>
  );
}

// ============================================================ CRIAR EQUIPE
//
// O treinador criando a equipe DELE, na federação em que está autorizado a atuar.
// Entrou com a autorização automática na NPC: antes dela, a equipe vinha da
// federação, e o treinador esperava.
//
// A FEDERAÇÃO NÃO É DIGITADA. O `select` é montado das autorizações APROVADAS que
// a própria API devolveu — não há campo livre, então não há como pedir equipe numa
// federação que não autorizou. O servidor reconfere de todo jeito; esconder a
// opção é cortesia com quem usa, não barreira.
function DialogoDeCriarEquipe({ autorizacoes, notificar, onClose, aoCriar }) {
  const { t } = useIdioma();
  const [organizationId, setOrganizationId] = useState(autorizacoes[0]?.organizationId ?? '');
  const [nome, setNome] = useState('');
  const [cidade, setCidade] = useState('');
  const [uf, setUf] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const enviar = async evento => {
    evento.preventDefault();
    if (enviando) return;
    setEnviando(true);
    setRecusa(null);
    try {
      await api.coaches.createMyTeam({
        organizationId,
        name: nome.trim(),
        ...(cidade.trim() ? { city: cidade.trim() } : {}),
        ...(uf.trim() ? { state: uf.trim().toUpperCase() } : {})
      });
      refreshData();
      notificar?.(t('treinador.equipeCriada'), 'sucesso');
      aoCriar?.();
      onClose();
    } catch (problema) {
      setRecusa(problema.message);
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('treinador.criarEquipeTitulo')} description={t('treinador.criarEquipeDescricao')} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('treinador.campoEquipeFederacao')} required>
          <select value={organizationId} onChange={evento => setOrganizationId(evento.target.value)}>
            {autorizacoes.map(item => (
              <option key={item.organizationId} value={item.organizationId}>
                {item.organization?.name ?? item.organizationId}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('treinador.campoEquipeNome')} required>
          <input value={nome} onChange={evento => setNome(evento.target.value)} required minLength={2} maxLength={120} />
        </Field>

        <div className="grade-dupla">
          <Field label={t('treinador.campoEquipeCidade')}>
            <input value={cidade} onChange={evento => setCidade(evento.target.value)} maxLength={90} />
          </Field>
          <Field label={t('treinador.campoEquipeUf')}>
            <input value={uf} onChange={evento => setUf(evento.target.value)} maxLength={2} />
          </Field>
        </div>

        <ModalActions>
          <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
          <button type="submit" className="button button-primary" disabled={enviando || nome.trim().length < 2 || !organizationId}>
            <Users2 size={14} /> {t('treinador.criarEquipe')}
          </button>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ==================================================== PAINEL DO TREINADOR
export function PainelDoTreinador({ notificar }) {
  const { t } = useIdioma();
  const [convidando, setConvidando] = useState(false);
  const [criandoEquipe, setCriandoEquipe] = useState(false);

  // `catch(() => null)` porque 404 aqui NÃO é erro: é a conta que ainda não tem
  // cadastro de treinador, e o que ela precisa ver é o formulário.
  const cadastro = useFetch(() => api.coaches.me().catch(() => null), []);
  const equipes = useFetch(() => api.coaches.myTeams().catch(() => ({ items: [] })), []);
  const atletas = useFetch(() => api.coaches.myAthletes().catch(() => ({ items: [] })), []);

  if (cadastro.loading) return <Skeleton linhas={6} />;

  if (!cadastro.data) {
    return (
      <>
        <PageHead eyebrow={t('treinador.eyebrow')} title={t('treinador.tituloSemCadastro')} description={t('treinador.descricaoSemCadastro')} />
        <FormularioDeAutocadastro notificar={notificar} aoConcluir={() => cadastro.reload?.()} />
      </>
    );
  }

  const meu = cadastro.data;
  const listaDeEquipes = equipes.data?.items ?? [];
  const aprovado = meu.status === 'APPROVED';
  const autorizacoes = meu.organizations ?? [];
  const autorizadoEmAlguma = autorizacoes.some(item => item.status === 'APPROVED');

  return (
    <>
      <PageHead
        eyebrow={t('treinador.eyebrow')}
        title={meu.name}
        description={t('treinador.descricaoPainel')}
        // DUAS AÇÕES, E A ORDEM É A DO CAMINHO: primeiro criar a equipe, depois
        // convidar atleta para ela. Criar aparece para quem está autorizado a
        // atuar em alguma federação — que, desde a autorização automática, é todo
        // treinador com cadastro aprovado. Convidar continua exigindo equipe: sem
        // ela não há a que vincular ninguém, e o botão escondido é melhor que o
        // botão que dá erro.
        actions={aprovado && (
          <>
            {autorizadoEmAlguma && (
              <button type="button" className="button button-secondary" onClick={() => setCriandoEquipe(true)}>
                <Users2 size={14} /> {t('treinador.criarEquipe')}
              </button>
            )}
            {listaDeEquipes.length > 0 && (
              <button type="button" className="button button-primary" onClick={() => setConvidando(true)}>
                <UserPlus size={14} /> {t('pedidoEquipe.convidar')}
              </button>
            )}
          </>
        )}
      />

      <section className="card">
        <div className="card-head">
          <h3>{t('treinador.situacaoCadastral')}</h3>
          <Badge tom={TOM_DO_CADASTRO[meu.status] ?? 'neutro'}>{t(ROTULO_DO_CADASTRO[meu.status] ?? 'treinador.estadoPendente')}</Badge>
        </div>

        {meu.status === 'PENDING' && <p className="muted">{t('treinador.avisoPendente')}</p>}
        {meu.status === 'REJECTED' && (
          <div className="alert alert-erro" role="status">
            <ShieldCheck size={16} />
            <div>
              <p>{t('treinador.avisoRejeitado')}</p>
              {meu.rejectionReason && <p className="muted">{meu.rejectionReason}</p>}
            </div>
          </div>
        )}
        {meu.status === 'SUSPENDED' && (
          <div className="alert alert-erro" role="status">
            <ShieldCheck size={16} />
            <div>
              <p>{t('treinador.avisoSuspenso')}</p>
              {meu.suspendedReason && <p className="muted">{meu.suspendedReason}</p>}
            </div>
          </div>
        )}

        <dl className="detalhes">
          <div><dt>{t('treinador.campoRegistro')}</dt><dd>{meu.registration || '—'}</dd></div>
          <div><dt>{t('treinador.campoTelefone')}</dt><dd>{meu.phone || '—'}</dd></div>
          <div><dt>{t('treinador.campoEmail')}</dt><dd>{meu.email || '—'}</dd></div>
          <div><dt>{t('treinador.desde')}</dt><dd>{formatarData(meu.createdAt)}</dd></div>
        </dl>
      </section>

      <FotoDoTreinador
        coachId={meu.id}
        temFoto={Boolean(meu.hasPhoto)}
        notificar={notificar}
        aoTrocar={() => cadastro.reload?.()}
      />

      <section className="card">
        <h3>{t('treinador.federacoes')}</h3>
        <p className="muted">{t('treinador.federacoesExplicacao')}</p>
        {!autorizacoes.length && <EmptyState title={t('treinador.semAutorizacao')} description={t('treinador.semAutorizacaoComoResolver')} />}
        {autorizacoes.length > 0 && (
          <ul className="lista-simples">
            {autorizacoes.map(item => (
              <li key={item.id}>
                <span>{item.organization?.name ?? '—'}</span>
                {/* `autoGrantedAt` vem da API e diz que a linha nasceu da REGRA,
                    sem concedente humano. Mostrar isso não é enfeite: quem lê a
                    tela precisa saber que não houve análise de ninguém. */}
                {item.autoGrantedAt && item.status === 'APPROVED' && (
                  <Badge tom="info">{t('treinador.autorizacaoAutomatica')}</Badge>
                )}
                <Badge tom={item.status === 'APPROVED' ? 'sucesso' : 'neutro'}>
                  {t(item.status === 'APPROVED' ? 'treinador.autorizado' : 'treinador.autorizacaoRevogada')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>{t('treinador.minhasEquipes')}</h3>
        {/* `AsyncSection` recebe um PREDICADO de vazio e uma FUNÇÃO de render:
            é o contrato dele, e respeitá-lo é o que faz esqueleto, vazio e
            conteúdo saírem de um lugar só em toda a aplicação. */}
        <AsyncSection state={equipes} empty={dados => !dados?.items?.length}>
          {dados => (
            <ul className="lista-simples">
              {dados.items.map(equipe => (
                <li key={equipe.id}>
                  <span>{equipe.name}</span>
                  <span className="muted">{equipe.organization?.name ?? '—'} — {t('treinador.atletasContagem', { n: equipe._count?.athletes ?? 0 })}</span>
                </li>
              ))}
            </ul>
          )}
        </AsyncSection>
        {!equipes.loading && !listaDeEquipes.length && (
          <EmptyState title={t('treinador.semEquipe')} description={t('treinador.semEquipeComoResolver')} />
        )}
      </section>

      <section className="card">
        <h3>{t('treinador.meusAtletas')}</h3>
        {/* Só dado esportivo e de filiação — decisão R-05. Não há coluna de
            documento nem de CPF porque a API não os entrega. */}
        <AsyncSection state={atletas} empty={dados => !dados?.items?.length}>
          {dados => (
            <div className="table-wrap"><table className="table">
              <thead>
                <tr>
                  <th>{t('treinador.colunaAtleta')}</th>
                  <th>{t('pedidoEquipe.matricula')}</th>
                  <th>{t('treinador.colunaEquipe')}</th>
                  <th>{t('treinador.colunaDesde')}</th>
                </tr>
              </thead>
              <tbody>
                {dados.items.map(linha => (
                  <tr key={linha.membershipId}>
                    <td>{linha.athlete?.stageName || linha.athlete?.fullName}</td>
                    <td>{linha.athlete?.affiliationNumber || '—'}</td>
                    <td>{linha.athlete?.team?.name ?? '—'}</td>
                    <td>{formatarData(linha.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </AsyncSection>
        {!atletas.loading && !(atletas.data?.items?.length) && (
          <EmptyState title={t('treinador.semAtleta')} description={t('treinador.semAtletaComoResolver')} />
        )}
      </section>

      {aprovado && autorizadoEmAlguma && <PedidosDasMinhasEquipes equipes={listaDeEquipes} notificar={notificar} />}

      <CartaoDeRanking coachId={meu.id} />

      {criandoEquipe && (
        <DialogoDeCriarEquipe
          autorizacoes={autorizacoes.filter(item => item.status === 'APPROVED')}
          notificar={notificar}
          onClose={() => setCriandoEquipe(false)}
          aoCriar={() => { equipes.reload?.(); cadastro.reload?.(); }}
        />
      )}
      {convidando && <DialogoDeConvite equipes={listaDeEquipes} notificar={notificar} onClose={() => setConvidando(false)} />}
    </>
  );
}

// Os pedidos que o treinador fez, por equipe. Ele CANCELA o que pediu; quem
// confirma ou recusa é o atleta, e por isso não há botão disso aqui.
function PedidosDasMinhasEquipes({ equipes, notificar }) {
  const { t } = useIdioma();
  // A EQUIPE ESCOLHIDA É DERIVADA, E NÃO CONGELADA NA PRIMEIRA RENDERIZAÇÃO.
  //
  // `useState(equipes[0]?.id)` lê a lista UMA vez: se as equipes ainda não
  // chegaram (elas vêm de `GET /coaches/me/teams`, outra requisição que a do
  // cadastro), o estado nasce vazio e NUNCA se corrige, porque o valor inicial
  // de `useState` é ignorado nas renderizações seguintes. O resultado, medido em
  // Chromium: "Nenhum convite enviado" para sempre, sem uma única chamada a
  // `GET /membership-requests` — o treinador não via os convites que acabou de
  // mandar. Passava e falhava conforme a ORDEM em que as duas respostas
  // voltavam, que é o pior tipo de defeito: some quando se vai olhar.
  //
  // `escolhida` cobre os dois casos com um só valor: o que a pessoa escolheu no
  // seletor, ou a primeira equipe assim que a lista existir.
  const [teamId, setTeamId] = useState('');
  const escolhida = teamId || equipes[0]?.id || '';
  const pedidos = useFetch(
    () => (escolhida ? api.membershipRequests.ofTeam({ teamId: escolhida }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] })),
    [escolhida],
    { ativo: Boolean(escolhida) }
  );

  const cancelar = async id => {
    try {
      await api.membershipRequests.cancel(id, t('pedidoEquipe.motivoCancelamento'));
      refreshData();
      notificar?.(t('pedidoEquipe.cancelado'), 'sucesso');
      pedidos.reload?.();
    } catch (erro) {
      notificar?.(mensagemDaFalha(erro, t('erro.generico')), 'erro');
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('pedidoEquipe.meusPedidos')}</h3>
        {equipes.length > 1 && (
          <select className="select-control" value={escolhida} onChange={evento => setTeamId(evento.target.value)} aria-label={t('pedidoEquipe.campoEquipe')}>
            {equipes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
      </div>

      <AsyncSection state={pedidos} empty={dados => !dados?.items?.length}>
        {dados => (
        <div className="table-wrap"><table className="table">
          <thead>
            <tr>
              <th>{t('treinador.colunaAtleta')}</th>
              <th>{t('pedidoEquipe.colunaSituacao')}</th>
              <th>{t('pedidoEquipe.colunaEnviadoEm')}</th>
              <th aria-label={t('acao.acoes')} />
            </tr>
          </thead>
          <tbody>
            {dados.items.map(pedido => (
              <tr key={pedido.id}>
                <td>{pedido.athlete?.stageName || pedido.athlete?.fullName}</td>
                <td><Badge tom={TOM_DO_PEDIDO[pedido.status] ?? 'neutro'}>{t(ROTULO_DO_PEDIDO[pedido.status] ?? 'pedidoEquipe.pendente')}</Badge></td>
                <td>{formatarData(pedido.requestedAt)}</td>
                <td>
                  {pedido.status === 'PENDING' && (
                    <button type="button" className="button button-secondary" onClick={() => cancelar(pedido.id)}>
                      {t('pedidoEquipe.cancelar')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        )}
      </AsyncSection>
      {!pedidos.loading && !(pedidos.data?.items?.length) && (
        <EmptyState title={t('pedidoEquipe.semPedido')} description={t('pedidoEquipe.semPedidoDescricao')} />
      )}
    </section>
  );
}

// ======================================================= A VEZ DO ATLETA
//
// É A CONFIRMAÇÃO DO ATLETA QUE CRIA O VÍNCULO. Esta tela é o único lugar da
// interface onde isso acontece, e as duas ações têm o mesmo peso visual: aceitar
// não é o caminho "certo" e recusar não é o "errado".
export function MinhaEquipe({ notificar }) {
  const { t } = useIdioma();
  const pedidos = useFetch(() => api.membershipRequests.mine().catch(() => ({ items: [] })), []);
  const [emCurso, setEmCurso] = useState(null);

  const responder = async (id, acao) => {
    setEmCurso(id);
    try {
      if (acao === 'confirmar') await api.membershipRequests.confirm(id);
      else await api.membershipRequests.reject(id, t('pedidoEquipe.motivoRecusaDoAtleta'));
      refreshData();
      notificar?.(t(acao === 'confirmar' ? 'pedidoEquipe.vinculoConfirmado' : 'pedidoEquipe.vinculoRecusado'), 'sucesso');
      pedidos.reload?.();
    } catch (erro) {
      notificar?.(mensagemDaFalha(erro, t('erro.generico')), 'erro');
    } finally {
      setEmCurso(null);
    }
  };

  const lista = pedidos.data?.items ?? [];
  const pendentes = lista.filter(item => item.status === 'PENDING');
  const decididos = lista.filter(item => item.status !== 'PENDING');

  return (
    <>
      <PageHead eyebrow={t('minhaEquipe.eyebrow')} title={t('minhaEquipe.titulo')} description={t('minhaEquipe.descricao')} />

      {pedidos.loading && <Skeleton linhas={4} />}
      {!pedidos.loading && !lista.length && (
        <EmptyState title={t('minhaEquipe.semConvite')} description={t('minhaEquipe.semConviteDescricao')} />
      )}

      <>
        {pendentes.map(pedido => (
          <section className="card" key={pedido.id}>
            <h3>{pedido.team?.name ?? '—'}</h3>
            <p className="muted">
              {pedido.team?.coach?.name ? t('minhaEquipe.convidadoPor', { treinador: pedido.team.coach.name }) : t('minhaEquipe.convidadoPelaEquipe')}
            </p>
            {pedido.reason && <p>{pedido.reason}</p>}

            {/* A CONSEQUÊNCIA VEM ANTES DO BOTÃO. Confirmar cria um vínculo
                exclusivo, e sair dele depende de decisão da administração — quem
                aceita precisa saber disso ANTES, não descobrir depois. */}
            <div className="alert alert-atencao" role="status">
              <ShieldCheck size={16} />
              <div>
                <p>{t('minhaEquipe.consequencia')}</p>
                <p className="muted">{t('minhaEquipe.consequenciaSaida')}</p>
              </div>
            </div>

            <div className="acoes-do-cartao">
              <button type="button" className="button button-secondary" disabled={emCurso === pedido.id} onClick={() => responder(pedido.id, 'recusar')}>
                {t('minhaEquipe.recusar')}
              </button>
              <button type="button" className="button button-primary" disabled={emCurso === pedido.id} onClick={() => responder(pedido.id, 'confirmar')}>
                {t('minhaEquipe.confirmar')}
              </button>
            </div>
          </section>
        ))}

        {decididos.length > 0 && (
          <section className="card">
            <h3>{t('minhaEquipe.historico')}</h3>
            <div className="table-wrap"><table className="table">
              <thead>
                <tr>
                  <th>{t('treinador.colunaEquipe')}</th>
                  <th>{t('pedidoEquipe.colunaSituacao')}</th>
                  <th>{t('minhaEquipe.colunaRespondidoEm')}</th>
                </tr>
              </thead>
              <tbody>
                {decididos.map(pedido => (
                  <tr key={pedido.id}>
                    <td>{pedido.team?.name ?? '—'}</td>
                    <td><Badge tom={TOM_DO_PEDIDO[pedido.status] ?? 'neutro'}>{t(ROTULO_DO_PEDIDO[pedido.status] ?? 'pedidoEquipe.pendente')}</Badge></td>
                    <td>{formatarData(pedido.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        )}
      </>
    </>
  );
}

// ============================================== A MESA CENTRAL (R-03 e R-04)
//
// DUAS DECISÕES DIFERENTES NA MESMA TELA, e a separação está escrita nela:
// aprovar o CADASTRO é da administração central; autorizar a ATUAÇÃO numa
// federação é da federação. Quem só tem uma das duas permissões vê só a metade
// que lhe cabe — e a API recusa a outra de todo modo.
const FILTROS_DE_ANALISE = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'CANCELLED'];

// Um diálogo para os cinco atos, porque os cinco pedem a mesma coisa: uma
// decisão e, quando ela é contra o interessado, um motivo. Cinco diálogos quase
// iguais é como um deles acaba sem o campo de motivo.
function DialogoDeDecisao({ coach, acao, notificar, onClose, aoPronto }) {
  const { t } = useIdioma();
  const [reason, setReason] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const exigeMotivo = ['reject', 'suspend', 'cancel'].includes(acao);

  const enviar = async evento => {
    evento.preventDefault();
    setRecusa(null);
    setEnviando(true);
    try {
      const motivo = reason.trim() || undefined;
      if (acao === 'approve') await api.coaches.approve(coach.id, motivo);
      if (acao === 'reject') await api.coaches.reject(coach.id, motivo);
      if (acao === 'suspend') await api.coaches.suspend(coach.id, motivo);
      if (acao === 'reactivate') await api.coaches.reactivate(coach.id, motivo);
      if (acao === 'cancel') await api.coaches.cancel(coach.id, motivo);
      refreshData();
      notificar?.(t('analiseTreinador.decisaoRegistrada'), 'sucesso');
      aoPronto?.();
      onClose();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={t(`analiseTreinador.acao.${acao}`)} description={coach.name} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('analiseTreinador.campoMotivo')} required={exigeMotivo} hint={t(exigeMotivo ? 'analiseTreinador.campoMotivoObrigatorio' : 'analiseTreinador.campoMotivoOpcional')}>
          <textarea rows={3} value={reason} onChange={evento => setReason(evento.target.value)} required={exigeMotivo} minLength={exigeMotivo ? 3 : undefined} maxLength={500} />
        </Field>

        <ModalActions onClose={onClose} saving={enviando} confirmLabel={t('analiseTreinador.confirmarDecisao')} />
      </form>
    </Modal>
  );
}

// A AUTORIZAÇÃO POR FEDERAÇÃO. A organização vem de uma lista das federações do
// operador — digitar id à mão seria convite a erro, e a API recusaria de todo
// modo quem apontasse federação alheia.
function DialogoDeAutorizacao({ coach, notificar, onClose, aoPronto, federacaoFixa = null }) {
  const { t } = useIdioma();
  // Com federação FIXA a lista nem é buscada: o escopo já foi escolhido na tela
  // de atuação, e reabrir um seletor ali convidaria a autorizar numa federação
  // diferente da que está sendo olhada. Sem ela, o diálogo segue como era, para
  // a mesa central.
  const organizacoes = useFetch(
    () => (federacaoFixa ? Promise.resolve({ items: [federacaoFixa] }) : api.organizations.list().catch(() => ({ items: [] }))),
    [federacaoFixa?.id]
  );
  const [organizationId, setOrganizationId] = useState(federacaoFixa?.id ?? '');
  const [reason, setReason] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const lista = organizacoes.data?.items ?? [];

  const enviar = async evento => {
    evento.preventDefault();
    setRecusa(null);
    setEnviando(true);
    try {
      await api.coaches.authorizeOrganization(coach.id, { organizationId, reason: reason.trim() || undefined });
      refreshData();
      notificar?.(t('analiseTreinador.autorizacaoRegistrada'), 'sucesso');
      aoPronto?.();
      onClose();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('analiseTreinador.autorizarTitulo')} description={t('analiseTreinador.autorizarDescricao')} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('analiseTreinador.campoFederacao')} required>
          {federacaoFixa
            ? <p><strong>{federacaoFixa.name}</strong></p>
            : (
              <select value={organizationId} onChange={evento => setOrganizationId(evento.target.value)} required>
                <option value="">{t('analiseTreinador.escolhaFederacao')}</option>
                {lista.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            )}
        </Field>

        <Field label={t('analiseTreinador.campoMotivo')} hint={t('analiseTreinador.campoMotivoOpcional')}>
          <textarea rows={2} value={reason} onChange={evento => setReason(evento.target.value)} maxLength={300} />
        </Field>

        {/* Com federação fixa o rótulo é o da seção da federação — "Autorizar em
            federação" é o texto da fila central, onde a federação ainda precisa
            ser escolhida. */}
        <ModalActions onClose={onClose} saving={enviando} disabled={!organizationId}
          confirmLabel={t(federacaoFixa ? 'atuacaoFederacao.autorizar' : 'analiseTreinador.autorizar')} />
      </form>
    </Modal>
  );
}

// ==================================== ATUAÇÃO NA FEDERAÇÃO (R-04) — a tela
//
// Esta seção existe por causa de um buraco encontrado na homologação manual
// (passo F4): a federação PODE autorizar — a rota respondia 200 para o diretor
// — mas o único botão de autorizar da interface morava dentro da fila de
// análise central, que exige `coaches.approve`. Quem tem `coaches.authorize_org`
// e não tem `coaches.approve` via duas caixas de recusa e nada mais.
//
// A lista vem de `GET /coaches/authorizable`, que devolve só cadastro APROVADO e
// só os campos de decisão. A situação mostrada é a DESTA federação: o diretor
// não descobre por aqui onde mais o treinador atua.
function AtuacaoNaFederacao({ notificar }) {
  const { t } = useIdioma();
  const [organizationId, setOrganizationId] = useState('');
  const [autorizando, setAutorizando] = useState(null);
  const [revogando, setRevogando] = useState(null);

  const organizacoes = useFetch(() => api.organizations.list().catch(erro => relancar(erro, {
    negado: t('atuacaoFederacao.semPermissao'), generico: t('erro.generico')
  })), []);
  const federacoes = organizacoes.data?.items ?? [];
  const escolhida = organizationId || federacoes[0]?.id || '';
  const federacao = federacoes.find(item => item.id === escolhida) ?? null;

  const treinadores = useFetch(
    () => (escolhida
      ? api.coaches.authorizable({ organizationId: escolhida, limit: 100 }).catch(erro => relancar(erro, {
        negado: t('atuacaoFederacao.semPermissao'), generico: t('erro.generico')
      }))
      : Promise.resolve({ items: [] })),
    [escolhida]
  );

  const situacao = treinador => {
    if (!treinador.authorization) return { rotulo: t('atuacaoFederacao.naoAutorizado'), tom: 'neutro' };
    if (treinador.authorization.status === 'APPROVED') return { rotulo: t('treinador.autorizado'), tom: 'sucesso' };
    return { rotulo: t('treinador.autorizacaoRevogada'), tom: 'atencao' };
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('atuacaoFederacao.titulo')}</h3>
        {federacoes.length > 1 && (
          <select className="select-control" value={escolhida} aria-label={t('atuacaoFederacao.campoFederacao')}
            onChange={evento => setOrganizationId(evento.target.value)}>
            {federacoes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
      </div>
      <p className="muted">{t('atuacaoFederacao.explicacao')}</p>

      <AsyncSection state={treinadores} empty={dados => !dados?.items?.length}
        vazio={<EmptyState title={t('atuacaoFederacao.vazio')} description={t('atuacaoFederacao.vazioDescricao')} />}>
        {dados => (
        <div className="table-wrap"><table className="table">
          <thead>
            <tr>
              <th>{t('treinador.campoNome')}</th>
              <th>{t('treinador.campoRegistro')}</th>
              <th>{t('atuacaoFederacao.colunaOrigem')}</th>
              <th>{t('pedidoEquipe.colunaSituacao')}</th>
              <th aria-label={t('acao.acoes')} />
            </tr>
          </thead>
          <tbody>
            {dados.items.map(treinador => {
              const estado = situacao(treinador);
              const autorizado = treinador.authorization?.status === 'APPROVED';
              return (
                <tr key={treinador.id}>
                  <td>{treinador.name}</td>
                  <td>{treinador.registration || '—'}</td>
                  <td>{[treinador.city, treinador.state].filter(Boolean).join(' — ') || '—'}</td>
                  <td><Badge tom={estado.tom}>{estado.rotulo}</Badge></td>
                  <td className="acoes-da-linha">
                    {autorizado
                      ? (
                        <button type="button" className="button button-secondary" onClick={() => setRevogando(treinador)}>
                          {t('atuacaoFederacao.revogar')}
                        </button>
                      )
                      : (
                        <button type="button" className="button button-secondary" onClick={() => setAutorizando(treinador)}>
                          {t('atuacaoFederacao.autorizar')}
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        )}
      </AsyncSection>

      {autorizando && federacao && (
        <DialogoDeAutorizacao
          coach={autorizando} federacaoFixa={federacao} notificar={notificar}
          onClose={() => setAutorizando(null)} aoPronto={() => treinadores.reload?.()}
        />
      )}
      {revogando && federacao && (
        <DialogoDeRevogacaoDeAtuacao
          coach={revogando} federacao={federacao} notificar={notificar}
          onClose={() => setRevogando(null)} aoPronto={() => treinadores.reload?.()}
        />
      )}
    </section>
  );
}

// A revogação EXIGE motivo — o servidor recusa sem ele com 422 REASON_REQUIRED,
// e a tela pede antes de gastar a viagem. O motivo fica na trilha de auditoria.
function DialogoDeRevogacaoDeAtuacao({ coach, federacao, notificar, onClose, aoPronto }) {
  const { t } = useIdioma();
  const [reason, setReason] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const enviar = async evento => {
    evento.preventDefault();
    setRecusa(null);
    setEnviando(true);
    try {
      await api.coaches.revokeOrganization(coach.id, { organizationId: federacao.id, reason: reason.trim() });
      refreshData();
      notificar?.(t('atuacaoFederacao.revogada'), 'sucesso');
      aoPronto?.();
      onClose();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('atuacaoFederacao.revogar')} description={`${coach.name} — ${federacao.name}`} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('analiseTreinador.campoMotivo')} required hint={t('atuacaoFederacao.motivoDica')}>
          <textarea rows={3} value={reason} onChange={evento => setReason(evento.target.value)} required minLength={3} maxLength={300} />
        </Field>

        <ModalActions onClose={onClose} saving={enviando} disabled={!reason.trim()} confirmLabel={t('atuacaoFederacao.revogar')} />
      </form>
    </Modal>
  );
}

export function AdminTreinadores({ notificar }) {
  const { t } = useIdioma();
  const { user } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const [decisao, setDecisao] = useState(null);
  const [autorizando, setAutorizando] = useState(null);

  // O QUE CADA AUTORIDADE VÊ NESTA TELA.
  //
  // Isto é CONVENIÊNCIA, e não barreira: quem decide continua sendo o servidor,
  // em `perm(...)` na rota e `assertCan(...)` no serviço. A tela esconder o que
  // a conta não pode usar evita o que a homologação manual encontrou no passo
  // F4 — o diretor de federação recebia duas caixas de "não foi possível
  // carregar" e um botão de conceder delegação que a API nunca aceitaria.
  // Oferecer ação que vai ser recusada não é segurança nem cortesia.
  const pode = podeCom(permissoesDe(user));
  const podeAnalisar = pode('coaches.approve');
  const podeAutorizarAtuacao = pode('coaches.authorize_org');
  const podeDelegar = pode('central.grant');

  const fila = useFetch(
    () => (podeAnalisar
      ? api.coaches.review({ status }).catch(erro => relancar(erro, {
        negado: t('analiseTreinador.semPermissao'), generico: t('erro.generico')
      }))
      : Promise.resolve({ items: [] })),
    [status, podeAnalisar]
  );

  const acoesDoEstado = coach => {
    if (coach.status === 'PENDING') return ['approve', 'reject'];
    if (coach.status === 'APPROVED') return ['suspend', 'cancel'];
    if (coach.status === 'SUSPENDED') return ['reactivate', 'cancel'];
    if (coach.status === 'REJECTED') return [];
    return [];
  };

  return (
    <>
      <PageHead eyebrow={t('analiseTreinador.eyebrow')} title={t('analiseTreinador.titulo')} description={t('analiseTreinador.descricao')} />

      {podeAnalisar && (
      <section className="card">
        <div className="card-head">
          <h3>{t('analiseTreinador.fila')}</h3>
          <select className="select-control" value={status} onChange={evento => setStatus(evento.target.value)} aria-label={t('analiseTreinador.filtrarPorSituacao')}>
            {FILTROS_DE_ANALISE.map(valor => (
              <option key={valor} value={valor}>{t(ROTULO_DO_CADASTRO[valor])}</option>
            ))}
          </select>
        </div>

        {/* Um estado por vez: carregando, recusa/erro, vazio ou a tabela. O texto
            de vazio é o da fila, entregue ao AsyncSection em `vazio` — antes ele
            ficava FORA, e aparecia junto do genérico. */}
        <AsyncSection state={fila} empty={dados => !dados?.items?.length}
          vazio={<EmptyState title={t('analiseTreinador.filaVazia')} description={t('analiseTreinador.filaVaziaDescricao')} />}>
          {dados => (
          <div className="table-wrap"><table className="table">
            <thead>
              <tr>
                <th>{t('treinador.campoNome')}</th>
                <th>{t('treinador.campoRegistro')}</th>
                <th>{t('analiseTreinador.colunaDocumentos')}</th>
                <th>{t('analiseTreinador.colunaEquipes')}</th>
                <th>{t('pedidoEquipe.colunaSituacao')}</th>
                <th aria-label={t('acao.acoes')} />
              </tr>
            </thead>
            <tbody>
              {dados.items.map(coach => (
                <tr key={coach.id}>
                  <td>
                    {coach.name}
                    {coach.user?.email && <span className="muted"> — {coach.user.email}</span>}
                  </td>
                  <td>{coach.registration || '—'}</td>
                  {/* CONTAGEM, e não a lista: o documento em si é da mesa de
                      análise e não aparece em listagem — decisão R-05. */}
                  <td>{coach._count?.documents ?? 0}</td>
                  <td>{coach._count?.teams ?? 0}</td>
                  <td><Badge tom={TOM_DO_CADASTRO[coach.status] ?? 'neutro'}>{t(ROTULO_DO_CADASTRO[coach.status])}</Badge></td>
                  <td className="acoes-da-linha">
                    {acoesDoEstado(coach).map(acao => (
                      <button key={acao} type="button" className="button button-secondary" onClick={() => setDecisao({ coach, acao })}>
                        {t(`analiseTreinador.acao.${acao}`)}
                      </button>
                    ))}
                    {coach.status === 'APPROVED' && (
                      <button type="button" className="button button-secondary" onClick={() => setAutorizando(coach)}>
                        {t('analiseTreinador.autorizar')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          )}
        </AsyncSection>
      </section>
      )}

      {podeAutorizarAtuacao && <AtuacaoNaFederacao notificar={notificar} />}

      {podeDelegar && <DelegacaoCentral notificar={notificar} />}

      {decisao && (
        <DialogoDeDecisao
          coach={decisao.coach}
          acao={decisao.acao}
          notificar={notificar}
          onClose={() => setDecisao(null)}
          aoPronto={() => fila.reload?.()}
        />
      )}
      {autorizando && (
        <DialogoDeAutorizacao
          coach={autorizando}
          notificar={notificar}
          onClose={() => setAutorizando(null)}
          aoPronto={() => fila.reload?.()}
        />
      )}
    </>
  );
}

// ================================================ DELEGAÇÃO CENTRAL (R-02)
//
// Transferir, desvincular e corrigir vínculo alteram a ATRIBUIÇÃO DE PONTOS, e
// desde R-02 nenhum papel recebe esse poder por construção — nem o diretor de
// evento, nem o administrador de plataforma. Só `SUPER_ADMIN` ou quem tiver uma
// concessão VIVA, com autor, motivo, escopo e prazo.
//
// A tela não oferece autoconcessão: o campo de destinatário é uma busca de
// conta, e a API recusa `userId` igual ao do autor com 403 SELF_GRANT_FORBIDDEN.
// Esconder o caminho é conveniência; a garantia é do servidor.
function DelegacaoCentral({ notificar }) {
  const { t } = useIdioma();
  const [abrindo, setAbrindo] = useState(false);
  const concessoes = useFetch(() => api.centralAuthorizations.list().catch(erro => relancar(erro, {
    negado: t('delegacao.semPermissao'), generico: t('erro.generico')
  })), []);

  const revogar = async id => {
    try {
      await api.centralAuthorizations.revoke(id, t('delegacao.motivoRevogacao'));
      refreshData();
      notificar?.(t('delegacao.revogada'), 'sucesso');
      concessoes.reload?.();
    } catch (erro) {
      notificar?.(mensagemDaFalha(erro, t('erro.generico')), 'erro');
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{t('delegacao.titulo')}</h3>
        <button type="button" className="button button-secondary" onClick={() => setAbrindo(true)}>{t('delegacao.conceder')}</button>
      </div>
      <p className="muted">{t('delegacao.explicacao')}</p>

      <AsyncSection state={concessoes} empty={dados => !dados?.items?.length}
        vazio={<EmptyState title={t('delegacao.semConcessao')} description={t('delegacao.semConcessaoDescricao')} />}>
        {dados => (
        <div className="table-wrap"><table className="table">
          <thead>
            <tr>
              <th>{t('delegacao.colunaPessoa')}</th>
              <th>{t('delegacao.colunaPermissao')}</th>
              <th>{t('delegacao.colunaEscopo')}</th>
              <th>{t('delegacao.colunaPrazo')}</th>
              <th aria-label={t('acao.acoes')} />
            </tr>
          </thead>
          <tbody>
            {dados.items.map(linha => (
              <tr key={linha.id}>
                <td>{linha.user?.name ?? '—'}<span className="muted"> — {linha.user?.email ?? ''}</span></td>
                <td><code>{linha.permission}</code></td>
                {/* Concessão sem escopo ou sem prazo é INERTE desde a correção
                    de A-02: `effectivePermissions` a ignora. A linha continua na
                    tabela porque apagá-la seria mexer em registro real — a tela
                    apenas diz, em voz alta, que ela não concede nada. */}
                <td>{linha.organization?.name ?? <span className="muted">{t('delegacao.inerte')}</span>}</td>
                <td>{linha.expiresAt ? formatarData(linha.expiresAt) : <span className="muted">{t('delegacao.inerte')}</span>}</td>
                <td>
                  <button type="button" className="button button-secondary" onClick={() => revogar(linha.id)}>{t('delegacao.revogar')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        )}
      </AsyncSection>

      {abrindo && <DialogoDeConcessao notificar={notificar} onClose={() => setAbrindo(false)} aoPronto={() => concessoes.reload?.()} />}
    </section>
  );
}

function DialogoDeConcessao({ notificar, onClose, aoPronto }) {
  const { t } = useIdioma();
  const [dados, setDados] = useState({ userId: '', permission: 'athletes.transfer', organizationId: '', reason: '', expiresAt: '' });
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const organizacoes = useFetch(() => api.organizations.list().catch(() => ({ items: [] })), []);
  const contas = useFetch(() => api.admin.users({ limit: 100 }).catch(() => ({ items: [] })), []);

  const campo = (chave, valor) => setDados(atual => ({ ...atual, [chave]: valor }));

  const enviar = async evento => {
    evento.preventDefault();
    setRecusa(null);
    setEnviando(true);
    try {
      await api.centralAuthorizations.grant({
        userId: dados.userId,
        permission: dados.permission,
        organizationId: dados.organizationId,
        reason: dados.reason,
        expiresAt: dados.expiresAt
      });
      refreshData();
      notificar?.(t('delegacao.concedida'), 'sucesso');
      aoPronto?.();
      onClose();
    } catch (erro) {
      setRecusa(mensagemDaFalha(erro, t('erro.generico')));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('delegacao.conceder')} description={t('delegacao.concederDescricao')} onClose={onClose}>
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <ShieldCheck size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('delegacao.campoPessoa')} required>
          <select value={dados.userId} onChange={evento => campo('userId', evento.target.value)} required>
            <option value="">{t('delegacao.escolhaPessoa')}</option>
            {(contas.data?.items ?? []).map(conta => (
              <option key={conta.id} value={conta.id}>{conta.name} — {conta.email}</option>
            ))}
          </select>
        </Field>

        {/* Uma permissão só na lista, e é proposital: `athletes.transfer` é a
            única delegável hoje (ver `PERMISSOES_CENTRAIS_DELEGADAS`). A API
            recusa qualquer outra com 422 e o motivo escrito. */}
        <Field label={t('delegacao.campoPermissao')} required hint={t('delegacao.campoPermissaoDica')}>
          <select value={dados.permission} onChange={evento => campo('permission', evento.target.value)} required>
            <option value="athletes.transfer">athletes.transfer</option>
          </select>
        </Field>

        {/* NÃO existe opção "todas as federações": a API recusa com 422
            ORGANIZATION_REQUIRED, e oferecer o caminho na tela só produziria uma
            recusa depois do preenchimento. */}
        <Field label={t('delegacao.campoEscopo')} required hint={t('delegacao.campoEscopoDica')}>
          <select value={dados.organizationId} onChange={evento => campo('organizationId', evento.target.value)} required>
            <option value="">{t('delegacao.escolhaEscopo')}</option>
            {(organizacoes.data?.items ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>

        <Field label={t('delegacao.campoPrazo')} required hint={t('delegacao.campoPrazoDica')}>
          <input type="date" required value={dados.expiresAt} onChange={evento => campo('expiresAt', evento.target.value)} />
        </Field>

        <Field label={t('analiseTreinador.campoMotivo')} required hint={t('delegacao.campoMotivoDica')}>
          <textarea rows={3} value={dados.reason} onChange={evento => campo('reason', evento.target.value)} required minLength={3} maxLength={500} />
        </Field>

        <ModalActions onClose={onClose} saving={enviando}
          disabled={!dados.userId || !dados.organizationId || !dados.expiresAt || !dados.reason.trim()}
          confirmLabel={t('delegacao.conceder')} />
      </form>
    </Modal>
  );
}

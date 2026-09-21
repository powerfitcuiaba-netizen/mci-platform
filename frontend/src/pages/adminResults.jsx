import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch, useListaPaginada } from '../lib/hooks';
import { AsyncSection, Badge, EmptyState, Field, Modal, ModalActions, PageHead, Paginacao } from '../components/ui';
import { formatarDataHora, estadoDaEntrada } from '../lib/format';
import { SeletorDeEvento, POR_PAGINA } from './adminEvent';
import { anunciar, MCIEvento } from '../lib/experiencia';
import { Revelacao } from '../components/experiencia';
import { useIdioma } from '../lib/idioma';

// O resultado inteiro tem dois estados; a entrada de cada atleta tem outros
// quatro. Misturar os dois mapas mostraria "Classificado" onde se lê
// "Publicado", então cada um tem o seu.
// O mapa leva à CHAVE do rótulo; quem traduz é quem desenha.
const CHAVE_DO_ESTADO = { PUBLISHED: 'resultado.publicado', DRAFT: 'resultado.rascunho' };
const estadoDaInscricaoDoResultado = (codigo, t) =>
  (CHAVE_DO_ESTADO[codigo] ? t(CHAVE_DO_ESTADO[codigo]) : codigo) || '—';

// Resultados. O MCI NÃO julga: o julgamento acontece fora, e esta tela LANÇA a
// colocação oficial recebida. Não há ficha de juiz, nota nem apuração — o
// operador transcreve o que veio decidido, e publicar continua sendo uma
// permissão à parte.

export function AdminResultados({ notificar }) {
  const { t } = useIdioma();
  const [eventId, setEventId] = useState('');
  const [corrigindo, setCorrigindo] = useState(null);
  const [versoes, setVersoes] = useState(null);
  const [publicando, setPublicando] = useState(null);

  const evento = useFetch(() => (eventId ? api.events.findOne(eventId) : Promise.resolve(null)), [eventId], { ativo: Boolean(eventId) });
  const resultados = useFetch(() => (eventId ? api.results.listByEvent(eventId) : Promise.resolve({ items: [] })), [eventId], { ativo: Boolean(eventId) });

  const classes = (evento.data?.eventCategories || []).flatMap(eventCategory =>
    eventCategory.divisions.flatMap(divisao =>
      divisao.classes.map(classe => ({ id: classe.id, rotulo: `${eventCategory.category.name} · ${divisao.name} · ${classe.name}` }))
    )
  );

  const [lancando, setLancando] = useState(null);

  // Qual classe acabou de receber ou publicar resultado. Serve para dar UM
  // destaque na linha afetada — e só nela. Destacar a lista inteira a cada
  // recarga faria o operador perder de vista o que realmente mudou.
  const [declarando, setDeclarando] = useState(false);
  const titulos = useFetch(
    () => (eventId ? api.ranking.listarOverall(eventId) : Promise.resolve([])),
    [eventId],
    { ativo: Boolean(eventId) }
  );

  const [recemMudada, setRecemMudada] = useState(null);
  useEffect(() => {
    if (!recemMudada) return undefined;
    const relogio = setTimeout(() => setRecemMudada(null), 2600);
    return () => clearTimeout(relogio);
  }, [recemMudada]);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('resultado.competicao')}
        title={t('resultado.titulo')}
        description={t('resultado.descricao')}
      />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title={t('resultado.selecioneEvento')} />
        : (
          <>
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><h2>{t('resultado.porClasse')}</h2></div>
              {classes.length
                ? classes.map((classe, indice) => {
                  const existente = (resultados.data?.items || []).find(item => item.classId === classe.id);
                  const destacada = recemMudada === classe.id;
                  return (
                    <Revelacao
                      as="div"
                      indice={indice}
                      key={classe.id}
                      className={`list-row${destacada ? ' linha-afetada varredura' : ''}`}
                    >
                      <span className="info">
                        <strong>{classe.rotulo}</strong>
                        <small>
                          {existente
                            ? t('resultado.resumoDaLinha', {
                              situacao: t(existente.status === 'PUBLISHED' ? 'resultado.publicado' : 'resultado.rascunho'),
                              versao: existente.version,
                              checksum: existente.checksum.slice(0, 10)
                            })
                            : t('resultado.aindaNaoRecebido')}
                        </small>
                      </span>
                      {existente?.hasUnresolvedTie && <Badge tom="perigo">{t('resultado.empateNaoResolvido')}</Badge>}
                      <button type="button" className="button button-secondary button-sm" onClick={() => setLancando(classe)}>
                        {t(existente ? 'resultado.relancar' : 'resultado.lancarResultado')}
                      </button>
                      {existente && existente.status !== 'PUBLISHED' && (
                        <button type="button" className="button button-primary button-sm" onClick={() => setPublicando(existente)}>{t('resultado.publicar')}</button>
                      )}
                      {existente && (
                        <>
                          <button type="button" className="button button-secondary button-sm" onClick={() => setCorrigindo(existente)}>{t('resultado.corrigir')}</button>
                          <button type="button" className="button button-ghost button-sm" onClick={() => setVersoes(existente)}>
                            {t('resultado.versoes')}
                          </button>
                        </>
                      )}
                    </Revelacao>
                  );
                })
                : <EmptyState title={t('resultado.semClasses')} />}
            </section>

            {/* O TÍTULO OVERALL.
                O MCI não julga: o Overall é DECLARADO pela organização, e o
                servidor registra a declaração em auditoria. O endpoint existia
                desde sempre e nenhuma tela o chamava — o bônus não tinha como
                ser concedido pelo produto, e o momento do campeão não tinha
                gatilho nenhum fora do laboratório. */}
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head">
                <div>
                  <h2>{t('resultado.tituloOverall')}</h2>
                  <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                    {t('resultado.tituloOverallNota')}
                  </small>
                </div>
                <button type="button" className="button button-primary button-sm" onClick={() => setDeclarando(true)}>
                  <Trophy size={14} /> {t('overall.declararOverall')}
                </button>
              </div>

              {/* A rota devolve `{ items: [...] }`, e não um array puro. Eu havia
                  assumido array — e o mock do teste repetiu a mesma suposição,
                  então o teste concordou comigo em vez de me contradizer. O
                  título era gravado no banco e simplesmente não aparecia.

                  O comentário fica AQUI FORA: dentro de `AsyncSection` ele
                  viraria um segundo filho, e o componente exige que o filho
                  seja uma função — o mesmo contrato que já derrubou esta tela
                  uma vez. */}
              <AsyncSection state={titulos} linhas={1}>
                {resposta => ((resposta.items || []).length
                  ? resposta.items.map((titulo, indice) => (
                    <Revelacao as="div" indice={indice} key={titulo.id} className="list-row">
                      <span className="placing placing-1"><Trophy size={14} /></span>
                      <span className="info">
                        <strong>{titulo.athlete.stageName || titulo.athlete.fullName}</strong>
                        <small>
                          {titulo.category?.name || t('resultado.overallDoEvento')}
                          {titulo.declaredAt
                            ? ` · ${t('resultado.declaradoEm', { data: formatarDataHora(titulo.declaredAt) })}`
                            : ''}
                          {titulo.note ? ` · ${titulo.note}` : ''}
                        </small>
                      </span>
                    </Revelacao>
                  ))
                  : <EmptyState title={t('resultado.nenhumTitulo')} description={t('resultado.nenhumTituloDescricao')} />
                )}
              </AsyncSection>
            </section>

            <AsyncSection state={resultados} linhas={3}>
              {dados => dados.items.map(resultado => (
                <section className="panel" key={resultado.id} style={{ marginBottom: 12 }}>
                  <div className="panel-head">
                    <div>
                      <h2>{resultado.competitionClass.division.eventCategory.category.name} · {resultado.competitionClass.name}</h2>
                      <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                        {t('resultado.versaoApurada', { versao: resultado.version, data: formatarDataHora(resultado.computedAt) })}
                      </small>
                    </div>
                    <Badge tom={resultado.status === 'PUBLISHED' ? 'ok' : 'alerta'}>
                      {t(resultado.status === 'PUBLISHED' ? 'resultado.publicado' : 'resultado.rascunho')}
                    </Badge>
                  </div>

                  {resultado.entries.map(entrada => (
                    <div className="list-row" key={entrada.id}>
                      <span className={entrada.status === 'TIE_UNRESOLVED' ? 'placing placing-tie' : `placing placing-${entrada.placing}`}>
                        {entrada.status === 'TIE_UNRESOLVED' ? t('resultado.empateCurto') : entrada.placing ?? '—'}
                      </span>
                      <span className="info">
                        <strong>{entrada.athlete.stageName || entrada.athlete.fullName}</strong>
                        <small>
                          {t('resultado.somaBruta', {
                            soma: entrada.score, bruta: entrada.rawScore, votos: entrada.breakdown?.judgeVotes ?? 0
                          })}
                        </small>
                      </span>
                      {entrada.status !== 'RANKED' && <Badge tom={estadoDaEntrada(entrada.status).tom}>{estadoDaEntrada(entrada.status).rotulo}</Badge>}
                    </div>
                  ))}
                </section>
              ))}
            </AsyncSection>
          </>
        )}

      {lancando && (
        <LancarResultado classe={lancando} eventId={eventId} notificar={notificar}
          onClose={() => setLancando(null)}
          onSalvo={() => { setRecemMudada(lancando.id); setLancando(null); resultados.reload(); }} />
      )}
      {publicando && (
        <PublicarResultado resultado={publicando} notificar={notificar} onClose={() => setPublicando(null)}
          onSalvo={() => { setRecemMudada(publicando.classId); setPublicando(null); resultados.reload(); }} />
      )}
      {corrigindo && (
        <CorrigirResultado resultado={corrigindo} notificar={notificar} onClose={() => setCorrigindo(null)}
          onSalvo={() => { setRecemMudada(corrigindo.classId); setCorrigindo(null); resultados.reload(); }} />
      )}
      {versoes && <HistoricoDeVersoes resultado={versoes} onClose={() => setVersoes(null)} />}
      {declarando && (
        <DeclararOverall eventId={eventId} notificar={notificar}
          onClose={() => setDeclarando(false)}
          onSalvo={() => { setDeclarando(false); titulos.reload(); }} />
      )}
    </div>
  );
}

// Lançamento do resultado OFICIAL recebido. A tela lista quem está inscrito na
// classe e pede a colocação que veio de fora — ela não sugere ordem, não
// ordena sozinha e não preenche nada: qualquer palpite da interface viraria
// julgamento disfarçado. Empate recebido é lançado como empate e trava a
// publicação até a comissão decidir.
function LancarResultado({ classe, eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [linhas, setLinhas] = useState([]);
  const [salvando, setSalvando] = useState(false);

  const inscricoes = useListaPaginada(
    cursor => api.registrations.listByEvent(eventId, { limit: POR_PAGINA, cursor: cursor || undefined }),
    [eventId]
  );

  useEffect(() => {
    // A API devolve `items[].competitionClass.id` — não existe `classId` no
    // item. O filtro antigo comparava com um campo inexistente, dava sempre
    // falso, e o diálogo listava ZERO inscritos: não havia como lançar
    // resultado nenhum. "Ordem de palco" já lia o campo certo, no mesmo
    // arquivo vizinho, o que mostra que era engano e não contrato diferente.
    const itens = inscricoes.items
      .filter(inscricao => (inscricao.items || []).some(item => item.competitionClass?.id === classe.id))
      .map(inscricao => ({
        athleteId: inscricao.athlete.id,
        nome: inscricao.athlete.fullName,
        placing: '',
        status: 'RANKED'
      }));
    // MESCLA, não substitui. A lista cresce quando o operador pede a próxima
    // página e volta a chegar quando outra tela grava algo — e em nenhum dos
    // dois casos o que ele já digitou pode ser apagado. Trocar por `setLinhas`
    // direto faria o "carregar mais" zerar as colocações da classe inteira.
    setLinhas(atual => itens.map(novo => atual.find(linha => linha.athleteId === novo.athleteId) || novo));
  }, [inscricoes.items, classe.id]);

  const alterar = (athleteId, campo, valor) =>
    setLinhas(atual => atual.map(linha => (linha.athleteId === athleteId ? { ...linha, [campo]: valor } : linha)));

  const enviar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const entries = linhas.map(linha => ({
        athleteId: linha.athleteId,
        placing: linha.status === 'RANKED' && linha.placing !== '' ? Number(linha.placing) : null,
        status: linha.status
      }));
      const resultado = await api.results.receive(classe.id, { entries });
      notificar(
        t(resultado.hasUnresolvedTie ? 'resultado.lancadoComEmpate' : 'resultado.lancadoAviso'),
        resultado.hasUnresolvedTie ? 'info' : 'ok'
      );
      // Empate não é conquista: a publicação ficou TRAVADA. Celebrar aqui
      // ensinaria o operador a ignorar justamente o caso que precisa de
      // atenção humana. O toast acima continua igual nos dois caminhos.
      anunciar(
        resultado.hasUnresolvedTie ? MCIEvento.AVISO : MCIEvento.SUCESSO,
        resultado.hasUnresolvedTie
          ? { titulo: t('resultado.empateNaoResolvido'), descricao: t('resultado.publicacaoTravada') }
          : { titulo: t('resultado.lancadoTitulo'), descricao: `${classe.rotulo}` }
      );
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('resultado.lancarEm', { classe: classe.rotulo })} onClose={onClose}>
      <form onSubmit={enviar}>
        <p className="muted" style={{ marginBottom: 12 }}>{t('resultado.julgamentoExterno')}</p>
        {/* `AsyncSection` recebe os filhos como FUNÇÃO — ela chama
            `children(state.data)`. Este bloco passava JSX direto e o nome da
            prop também estava errado (`estado`), então o diálogo estourava de
            duas formas diferentes. A lista vem de `linhas`, derivada por
            efeito, e não do argumento; por isso a função o ignora. */}
        <AsyncSection state={inscricoes}>
          {() => (linhas.length
            ? linhas.map(linha => (
              <div className="list-row" key={linha.athleteId}>
                <span className="info"><strong>{linha.nome}</strong></span>
                <input type="number" min="1" max="999" value={linha.placing} placeholder={t('overall.colocacao')}
                  disabled={linha.status !== 'RANKED'} style={{ width: 110 }}
                  onChange={evento => alterar(linha.athleteId, 'placing', evento.target.value)} />
                <select value={linha.status} onChange={evento => alterar(linha.athleteId, 'status', evento.target.value)}>
                  <option value="RANKED">{t('resultado.colocado')}</option>
                  <option value="TIE_UNRESOLVED">{t('resultado.empateNaoResolvido')}</option>
                  <option value="DISQUALIFIED">{t('resultado.desclassificado')}</option>
                  <option value="ABSENT">{t('resultado.ausente')}</option>
                </select>
              </div>
            ))
            : <EmptyState title={t('resultado.nenhumInscrito')} />)}
        </AsyncSection>
        {/* "Nenhum inscrito nesta classe" pode ser só a página 1: a lista vem
            do evento inteiro e é filtrada por classe DEPOIS de chegar. */}
        <Paginacao nextCursor={inscricoes.nextCursor} onMore={inscricoes.carregarMais} loading={inscricoes.carregandoMais} />
        {/* `ModalActions` NÃO renderiza filhos — ela monta os próprios botões
            a partir das props. Os botões escritos aqui dentro eram descartados
            em silêncio, e o diálogo real saía com "Cancelar" sem handler
            nenhum, rótulo "Salvar" no lugar de "Lançar resultado oficial" e
            sem a trava de lista vazia. Nada disso dava erro. */}
        <ModalActions
          onClose={onClose}
          saving={salvando}
          confirmLabel={t('resultado.lancarOficial')}
          disabled={!linhas.length}
        />
      </form>
    </Modal>
  );
}

function PublicarResultado({ resultado, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);

  const publicar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const resposta = await api.results.publish(resultado.classId, { reason: reason || null });
      const pontuaram = resposta.ranking?.awarded;
      notificar(t('resultado.publicadoComPontos', {
        complemento: pontuaram
          ? t('resultado.atletasPontuaram', { n: pontuaram })
          : t('resultado.semPontuacao')
      }));
      // Publicar é o instante em que a classificação deixa de ser rascunho e
      // passa a valer para o público e para o ranking. É o nível MOMENTO — e
      // NÃO o nível do campeão, que continua reservado. Nada aqui bloqueia o
      // operador: a celebração passa por cima e sai sozinha.
      anunciar(MCIEvento.RESULTADO_PUBLICADO, {
        titulo: t('resultado.publicadoTitulo'),
        descricao: pontuaram
          ? t('resultado.atletasPontuaram', { n: pontuaram })
          : t('resultado.classificacaoPublica')
      });
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('resultado.publicarResultado')} description={t('resultado.publicarDescricao')} onClose={onClose}>
      <form onSubmit={publicar}>
        <Field label={t('resultado.motivoObservacao')} hint={t('resultado.motivoHint')}>
          <textarea
            value={reason} onChange={evento => setReason(evento.target.value)}
            maxLength={300} placeholder={t('resultado.exemploMotivo')}
          />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('resultado.publicar')} />
      </form>
    </Modal>
  );
}

function CorrigirResultado({ resultado, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [reason, setReason] = useState('');
  const [entradas, setEntradas] = useState(
    resultado.entries.map(entrada => ({
      registrationItemId: entrada.registrationItemId,
      nome: entrada.athlete.stageName || entrada.athlete.fullName,
      placing: entrada.placing ?? '',
      status: entrada.status
    }))
  );
  const [salvando, setSalvando] = useState(false);

  const colocacoes = entradas.map(item => item.placing).filter(valor => valor !== '');
  const repetida = colocacoes.length !== new Set(colocacoes).size;

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.results.override(resultado.classId, {
        reason,
        entries: entradas.map(item => ({
          registrationItemId: item.registrationItemId,
          placing: item.placing === '' ? null : Number(item.placing),
          status: item.status
        }))
      });
      notificar(t('resultado.correcaoRegistradaAviso'));
      // Correção é conserto, não conquista: confirmação sóbria, nível EVENTO.
      anunciar(MCIEvento.SUCESSO, {
        titulo: t('resultado.correcaoRegistrada'), descricao: t('resultado.versaoPreservada')
      });
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('resultado.corrigirResultado')} description={t('resultado.corrigirDescricao')} wide onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('resultado.motivoDaCorrecao')} required>
          <textarea
            value={reason} onChange={evento => setReason(evento.target.value)}
            required minLength={5} maxLength={400} placeholder={t('resultado.exemploCorrecao')}
          />
        </Field>

        <div className="judge-sheet">
          {entradas.map((entrada, indice) => (
            <div className="judge-row" key={entrada.registrationItemId}>
              <span className="info"><strong>{entrada.nome}</strong></span>
              <select
                value={entrada.status}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, status: evt.target.value } : item)))}
                style={{ width: 150 }}
                aria-label={t('resultado.situacaoDe', { nome: entrada.nome })}
              >
                <option value="RANKED">{t('resultado.classificado')}</option>
                <option value="TIE_UNRESOLVED">{t('resultado.empateNaoResolvido')}</option>
                <option value="DISQUALIFIED">{t('resultado.desclassificado')}</option>
                <option value="ABSENT">{t('resultado.ausente')}</option>
              </select>
              <input
                type="number"
                min="1"
                max="200"
                value={entrada.placing}
                disabled={entrada.status !== 'RANKED'}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, placing: evt.target.value } : item)))}
                style={{ width: 80, background: 'var(--preto)', border: '1px solid var(--linha-forte)', borderRadius: 4, padding: 8, textAlign: 'center' }}
                aria-label={t('resultado.colocacaoDe', { nome: entrada.nome })}
              />
            </div>
          ))}
        </div>

        {repetida && (
          <div className="alert alert-erro" style={{ marginTop: 14 }}>
            <div>
              <strong>{t('resultado.colocacaoRepetida')}</strong>
              <p>{t('resultado.colocacaoRepetidaTexto')}</p>
            </div>
          </div>
        )}

        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('resultado.registrarCorrecao')} disabled={repetida} />
      </form>
    </Modal>
  );
}

function HistoricoDeVersoes({ resultado, onClose }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.results.versions(resultado.classId), [resultado.classId]);

  return (
    <Modal title={t('resultado.historicoDeVersoes')} description={t('resultado.historicoDescricao')} wide onClose={onClose}>
      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? dados.items.map(versao => (
            <div key={versao.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="placing">{versao.version}</span>
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', fontSize: 13 }}>{versao.reason}</strong>
                  <small style={{ color: 'var(--cinza-fraco)' }}>
                    {versao.createdBy?.name || t('resultado.sistema')} · {formatarDataHora(versao.createdAt)}
                    {' · '}{estadoDaInscricaoDoResultado(versao.snapshot.status, t)}
                  </small>
                </div>
              </div>
              <div className="chips" style={{ marginTop: 8 }}>
                {(versao.snapshot.entries || []).map(entrada => (
                  <span className="chip" key={entrada.registrationItemId}>
                    {entrada.placing ?? '—'}º · {estadoDaEntrada(entrada.status).rotulo}
                  </span>
                ))}
              </div>
            </div>
          ))
          : <EmptyState title={t('resultado.semVersoes')} />
        )}
      </AsyncSection>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.fechar')}</button>
      </div>
    </Modal>
  );
}

// ============================================================ TÍTULO OVERALL
//
// O MCI NÃO JULGA. O Overall é decidido pela comissão, fora da plataforma, e
// DECLARADO aqui — o servidor registra em auditoria como OVERALL_DECLARE e
// repontua os resultados já publicados do evento, porque declarar o título é
// um fato novo sobre resultados que já existiam.
//
// Esta é a única porta do produto para o Momento Campeão. Ela é estreita de
// propósito: exige permissão de ranking, exige escolher a pessoa numa lista de
// inscritos do evento, e acontece uma vez por evento. É isso que mantém o
// nível 5 raro — a raridade vem do FATO, não de uma regra de interface.
function DeclararOverall({ eventId, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const inscricoes = useListaPaginada(
    cursor => api.registrations.listByEvent(eventId, { limit: POR_PAGINA, cursor: cursor || undefined }),
    [eventId]
  );
  const evento = useFetch(() => api.events.findOne(eventId), [eventId]);
  const [athleteId, setAthleteId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [falha, setFalha] = useState(null);

  const atletas = inscricoes.items.map(item => ({
    id: item.athlete.id,
    nome: item.athlete.stageName || item.athlete.fullName
  }));
  const categorias = (evento.data?.eventCategories || []).map(ec => ({
    id: ec.category.id, nome: ec.category.name
  }));
  const escolhido = atletas.find(item => item.id === athleteId);

  const declarar = async evt => {
    evt.preventDefault();
    if (salvando || !athleteId) return;
    setSalvando(true);
    setFalha(null);
    try {
      await api.ranking.declararOverall(eventId, {
        athleteId,
        categoryId: categoryId || undefined,
        note: note.trim() || undefined
      });
      notificar(t('resultado.tituloDeclaradoAviso'));

      // O ÚNICO nível 5 da operação, e o único lugar do produto que o dispara.
      anunciar(MCIEvento.CAMPEAO, {
        titulo: categorias.find(c => c.id === categoryId)?.nome || t('resultado.campeaoOverall'),
        nome: escolhido?.nome,
        descricao: evento.data?.name
      });
      refreshData();
      onSalvo();
    } catch (erro) {
      setFalha(erro.message);
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={t('resultado.declararTitulo')}
      description={t('resultado.declararDescricao')}
      onClose={onClose}
    >
      <form onSubmit={declarar}>
        {falha && (
          <div className="alert alert-erro" style={{ marginBottom: 14 }}>
            <div>
              <strong>{t('resultado.tituloNaoDeclarado')}</strong>
              <p>{falha}</p>
              <p>{t('resultado.nadaFoiRegistrado')}</p>
            </div>
          </div>
        )}

        <Field label={t('overall.atleta')} required hint={t('resultado.somenteInscritos')}>
          <select value={athleteId} onChange={evt => setAthleteId(evt.target.value)} required>
            <option value="">{t('resultado.selecione')}</option>
            {atletas.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select>
        </Field>
        {/* O campeão Overall não pode ser inalcançável por estar na página 2
            da lista de inscritos. */}
        <Paginacao nextCursor={inscricoes.nextCursor} onMore={inscricoes.carregarMais} loading={inscricoes.carregandoMais} />

        <Field label={t('resultado.recorte')} hint={t('resultado.recorteHint')}>
          <select value={categoryId} onChange={evt => setCategoryId(evt.target.value)}>
            <option value="">{t('resultado.overallDoEvento')}</option>
            {categorias.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}
          </select>
        </Field>

        <Field label={t('resultado.observacao')} hint={t('resultado.observacaoHint')}>
          <textarea value={note} onChange={evt => setNote(evt.target.value)} maxLength={300}
            placeholder={t('resultado.exemploObservacao')} />
        </Field>

        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('overall.declararOverall')} disabled={!athleteId} />
      </form>
    </Modal>
  );
}

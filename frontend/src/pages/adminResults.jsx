import { useEffect, useState } from 'react';
import api, { refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Badge, EmptyState, Field, Modal, ModalActions, PageHead } from '../components/ui';
import { formatarDataHora } from '../lib/format';
import { SeletorDeEvento } from './adminEvent';
import { anunciar, MCIEvento } from '../lib/experiencia';
import { Revelacao } from '../components/experiencia';

// Resultados. O MCI NÃO julga: o julgamento acontece fora, e esta tela LANÇA a
// colocação oficial recebida. Não há ficha de juiz, nota nem apuração — o
// operador transcreve o que veio decidido, e publicar continua sendo uma
// permissão à parte.

export function AdminResultados({ notificar }) {
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
  const [recemMudada, setRecemMudada] = useState(null);
  useEffect(() => {
    if (!recemMudada) return undefined;
    const relogio = setTimeout(() => setRecemMudada(null), 2600);
    return () => clearTimeout(relogio);
  }, [recemMudada]);

  return (
    <div className="page">
      <PageHead eyebrow="Competição" title="Resultados" description="Lançamento do resultado oficial recebido, publicação protegida e correção versionada." />

      <div className="toolbar"><SeletorDeEvento eventId={eventId} onChange={setEventId} /></div>

      {!eventId
        ? <EmptyState title="Selecione um evento" />
        : (
          <>
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><h2>Resultado oficial por classe</h2></div>
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
                            ? `${existente.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'} · versão ${existente.version} · checksum ${existente.checksum.slice(0, 10)}…`
                            : 'Resultado ainda não recebido'}
                        </small>
                      </span>
                      {existente?.hasUnresolvedTie && <Badge tom="perigo">Empate não resolvido</Badge>}
                      <button type="button" className="button button-secondary button-sm" onClick={() => setLancando(classe)}>
                        {existente ? 'Relançar' : 'Lançar resultado'}
                      </button>
                      {existente && existente.status !== 'PUBLISHED' && (
                        <button type="button" className="button button-primary button-sm" onClick={() => setPublicando(existente)}>Publicar</button>
                      )}
                      {existente && (
                        <>
                          <button type="button" className="button button-secondary button-sm" onClick={() => setCorrigindo(existente)}>Corrigir</button>
                          <button type="button" className="button button-ghost button-sm" onClick={() => setVersoes(existente)}>Versões</button>
                        </>
                      )}
                    </Revelacao>
                  );
                })
                : <EmptyState title="Sem classes cadastradas" />}
            </section>

            <AsyncSection state={resultados} linhas={3}>
              {dados => dados.items.map(resultado => (
                <section className="panel" key={resultado.id} style={{ marginBottom: 12 }}>
                  <div className="panel-head">
                    <div>
                      <h2>{resultado.competitionClass.division.eventCategory.category.name} · {resultado.competitionClass.name}</h2>
                      <small style={{ color: 'var(--cinza-fraco)', fontSize: 11.5 }}>
                        Versão {resultado.version} · apurado em {formatarDataHora(resultado.computedAt)}
                      </small>
                    </div>
                    <Badge tom={resultado.status === 'PUBLISHED' ? 'ok' : 'alerta'}>{resultado.status === 'PUBLISHED' ? 'Publicado' : 'Rascunho'}</Badge>
                  </div>

                  {resultado.entries.map(entrada => (
                    <div className="list-row" key={entrada.id}>
                      <span className={entrada.status === 'TIE_UNRESOLVED' ? 'placing placing-tie' : `placing placing-${entrada.placing}`}>
                        {entrada.status === 'TIE_UNRESOLVED' ? 'EMP' : entrada.placing ?? '—'}
                      </span>
                      <span className="info">
                        <strong>{entrada.athlete.stageName || entrada.athlete.fullName}</strong>
                        <small>soma {entrada.score} · bruta {entrada.rawScore} · {entrada.breakdown?.judgeVotes ?? 0} voto(s)</small>
                      </span>
                      {entrada.status !== 'RANKED' && <Badge tom="perigo">{entrada.status}</Badge>}
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
    </div>
  );
}

// Lançamento do resultado OFICIAL recebido. A tela lista quem está inscrito na
// classe e pede a colocação que veio de fora — ela não sugere ordem, não
// ordena sozinha e não preenche nada: qualquer palpite da interface viraria
// julgamento disfarçado. Empate recebido é lançado como empate e trava a
// publicação até a comissão decidir.
function LancarResultado({ classe, eventId, notificar, onClose, onSalvo }) {
  const [linhas, setLinhas] = useState([]);
  const [salvando, setSalvando] = useState(false);

  const inscricoes = useFetch(() => api.registrations.listByEvent(eventId, { limit: 100 }), [eventId]);

  useEffect(() => {
    // A API devolve `items[].competitionClass.id` — não existe `classId` no
    // item. O filtro antigo comparava com um campo inexistente, dava sempre
    // falso, e o diálogo listava ZERO inscritos: não havia como lançar
    // resultado nenhum. "Ordem de palco" já lia o campo certo, no mesmo
    // arquivo vizinho, o que mostra que era engano e não contrato diferente.
    const itens = (inscricoes.data?.items || [])
      .filter(inscricao => (inscricao.items || []).some(item => item.competitionClass?.id === classe.id))
      .map(inscricao => ({
        athleteId: inscricao.athlete.id,
        nome: inscricao.athlete.fullName,
        placing: '',
        status: 'RANKED'
      }));
    setLinhas(itens);
  }, [inscricoes.data, classe.id]);

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
        resultado.hasUnresolvedTie
          ? 'Resultado lançado com empate não resolvido: a publicação fica travada até a correção.'
          : 'Resultado oficial lançado.',
        resultado.hasUnresolvedTie ? 'info' : 'ok'
      );
      // Empate não é conquista: a publicação ficou TRAVADA. Celebrar aqui
      // ensinaria o operador a ignorar justamente o caso que precisa de
      // atenção humana. O toast acima continua igual nos dois caminhos.
      anunciar(
        resultado.hasUnresolvedTie ? MCIEvento.AVISO : MCIEvento.SUCESSO,
        resultado.hasUnresolvedTie
          ? { titulo: 'Empate não resolvido', descricao: 'A publicação fica travada até a comissão decidir.' }
          : { titulo: 'Resultado lançado', descricao: `${classe.rotulo}` }
      );
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Modal title={`Lançar resultado — ${classe.rotulo}`} onClose={onClose}>
      <form onSubmit={enviar}>
        <p className="muted" style={{ marginBottom: 12 }}>
          O julgamento é externo. Transcreva a colocação oficial recebida; a
          plataforma não recalcula nem desempata.
        </p>
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
                <input type="number" min="1" max="999" value={linha.placing} placeholder="Colocação"
                  disabled={linha.status !== 'RANKED'} style={{ width: 110 }}
                  onChange={evento => alterar(linha.athleteId, 'placing', evento.target.value)} />
                <select value={linha.status} onChange={evento => alterar(linha.athleteId, 'status', evento.target.value)}>
                  <option value="RANKED">Colocado</option>
                  <option value="TIE_UNRESOLVED">Empate não resolvido</option>
                  <option value="DISQUALIFIED">Desclassificado</option>
                  <option value="ABSENT">Ausente</option>
                </select>
              </div>
            ))
            : <EmptyState title="Nenhum inscrito nesta classe" />)}
        </AsyncSection>
        {/* `ModalActions` NÃO renderiza filhos — ela monta os próprios botões
            a partir das props. Os botões escritos aqui dentro eram descartados
            em silêncio, e o diálogo real saía com "Cancelar" sem handler
            nenhum, rótulo "Salvar" no lugar de "Lançar resultado oficial" e
            sem a trava de lista vazia. Nada disso dava erro. */}
        <ModalActions
          onClose={onClose}
          saving={salvando}
          confirmLabel="Lançar resultado oficial"
          disabled={!linhas.length}
        />
      </form>
    </Modal>
  );
}

function PublicarResultado({ resultado, notificar, onClose, onSalvo }) {
  const [reason, setReason] = useState('');
  const [salvando, setSalvando] = useState(false);

  const publicar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      const resposta = await api.results.publish(resultado.classId, { reason: reason || null });
      const pontuaram = resposta.ranking?.awarded;
      notificar(`Resultado publicado. ${pontuaram ? `${pontuaram} atleta(s) pontuaram no ranking.` : 'Sem pontuação de ranking (evento sem temporada).'}`);
      // Publicar é o instante em que a classificação deixa de ser rascunho e
      // passa a valer para o público e para o ranking. É o nível MOMENTO — e
      // NÃO o nível do campeão, que continua reservado. Nada aqui bloqueia o
      // operador: a celebração passa por cima e sai sozinha.
      anunciar(MCIEvento.RESULTADO_PUBLICADO, {
        titulo: 'Resultado publicado',
        descricao: pontuaram ? `${pontuaram} atleta(s) pontuaram no ranking.` : 'Classificação agora é pública.'
      });
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Publicar resultado" description="Publicar torna a classificação pública e dispara a pontuação de ranking." onClose={onClose}>
      <form onSubmit={publicar}>
        <Field label="Motivo / observação" hint="Fica registrado na versão publicada.">
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} maxLength={300} placeholder="Ex: Resultado oficial conferido pela comissão técnica" />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Publicar" />
      </form>
    </Modal>
  );
}

function CorrigirResultado({ resultado, notificar, onClose, onSalvo }) {
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
      notificar('Correção registrada como nova versão.');
      // Correção é conserto, não conquista: confirmação sóbria, nível EVENTO.
      anunciar(MCIEvento.SUCESSO, { titulo: 'Correção registrada', descricao: 'A versão anterior foi preservada.' });
      refreshData();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Corrigir resultado" description="A correção não sobrescreve: cria a versão seguinte, preserva a anterior e exige motivo." wide onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Motivo da correção" required>
          <textarea value={reason} onChange={evento => setReason(evento.target.value)} required minLength={5} maxLength={400} placeholder="Ex: Desempate decidido em reunião da comissão técnica" />
        </Field>

        <div className="judge-sheet">
          {entradas.map((entrada, indice) => (
            <div className="judge-row" key={entrada.registrationItemId}>
              <span className="info"><strong>{entrada.nome}</strong></span>
              <select
                value={entrada.status}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, status: evt.target.value } : item)))}
                style={{ width: 150 }}
                aria-label={`Situação de ${entrada.nome}`}
              >
                <option value="RANKED">Classificado</option>
                <option value="TIE_UNRESOLVED">Empate não resolvido</option>
                <option value="DISQUALIFIED">Desclassificado</option>
                <option value="ABSENT">Ausente</option>
              </select>
              <input
                type="number"
                min="1"
                max="200"
                value={entrada.placing}
                disabled={entrada.status !== 'RANKED'}
                onChange={evt => setEntradas(atual => atual.map((item, posicao) => (posicao === indice ? { ...item, placing: evt.target.value } : item)))}
                style={{ width: 80, background: 'var(--preto)', border: '1px solid var(--linha-forte)', borderRadius: 4, padding: 8, textAlign: 'center' }}
                aria-label={`Colocação de ${entrada.nome}`}
              />
            </div>
          ))}
        </div>

        {repetida && (
          <div className="alert alert-erro" style={{ marginTop: 14 }}>
            <div><strong>Colocação repetida</strong><p>Duas colocações iguais não formam uma classificação válida.</p></div>
          </div>
        )}

        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Registrar correção" disabled={repetida} />
      </form>
    </Modal>
  );
}

function HistoricoDeVersoes({ resultado, onClose }) {
  const estado = useFetch(() => api.results.versions(resultado.classId), [resultado.classId]);

  return (
    <Modal title="Histórico de versões" description="Cada mudança de estado do resultado gera uma versão preservada." wide onClose={onClose}>
      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? dados.items.map(versao => (
            <div key={versao.id} style={{ borderBottom: '1px solid var(--linha)', padding: '12px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="placing">{versao.version}</span>
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', fontSize: 13 }}>{versao.reason}</strong>
                  <small style={{ color: 'var(--cinza-fraco)' }}>
                    {versao.createdBy?.name || 'sistema'} · {formatarDataHora(versao.createdAt)} · {versao.snapshot.status}
                  </small>
                </div>
              </div>
              <div className="chips" style={{ marginTop: 8 }}>
                {(versao.snapshot.entries || []).map(entrada => (
                  <span className="chip" key={entrada.registrationItemId}>
                    {entrada.placing ?? '—'}º · {entrada.status}
                  </span>
                ))}
              </div>
            </div>
          ))
          : <EmptyState title="Sem versões registradas" />
        )}
      </AsyncSection>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>Fechar</button>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { Eye, EyeOff, Megaphone, PencilLine, Plus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Badge, Field, Modal, ModalActions, PageHead } from '../components/ui';
import { formatarDataHora } from '../lib/format';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// A MENSAGEM DE ABERTURA — a tela de quem a escreve.
//
// Três coisas ficam visíveis porque são justamente as que se esquecem:
//
//   * A JANELA DE VALIDADE, escrita por extenso ao lado do recado. Um aviso
//     de setembro exibido em dezembro é ruído, e o jeito de isso acontecer é
//     ninguém ver quando ele vence.
//
//   * QUANTAS PESSOAS JÁ LERAM. É o que diz se o recado chegou — e é o que
//     transforma "apagar" em decisão consciente.
//
//   * QUE APAGAR DEIXA DE SER POSSÍVEL depois da primeira leitura. A tela
//     não esconde o botão: ela chama, e mostra a recusa do servidor, que
//     explica por quê e aponta a desativação.
// ==========================================================================

const vazio = organizationId => ({
  organizationId,
  title: '',
  body: '',
  startsAt: '',
  endsAt: '',
  showOnce: true
});

// O input `datetime-local` fala 'AAAA-MM-DDTHH:MM' e não entende fuso; a API
// fala ISO. As duas conversões ficam juntas para que ninguém precise procurar
// a outra metade.
const paraCampo = valor => (valor ? new Date(valor).toISOString().slice(0, 16) : '');
const paraApi = valor => (valor ? new Date(valor).toISOString() : null);

export function AdminMensagens({ notificar }) {
  const { t } = useIdioma();
  const { usuario } = useAuth();
  const [recarga, setRecarga] = useState(0);
  const [editando, setEditando] = useState(null);
  const [excluindo, setExcluindo] = useState(null);

  const organizationId = usuario?.organizations?.[0]?.organizationId ?? null;

  const estado = useFetch(
    () => api.athleteNotices.list(organizationId ? { organizationId, limit: 50 } : { limit: 50 }),
    [organizationId, recarga]
  );
  const recarregar = () => setRecarga(n => n + 1);

  const alternarAtivo = async aviso => {
    try {
      await api.athleteNotices.update(aviso.id, { active: !aviso.active });
      notificar?.(t(aviso.active ? 'recado.desativado' : 'recado.ativado'));
      recarregar();
    } catch (erro) {
      notificar?.(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('atleta.administracao')}
        title={t('recado.titulo')}
        description={t('recado.descricao')}
        actions={
          <button
            type="button"
            className="button button-primary button-sm"
            onClick={() => setEditando(vazio(organizationId))}
          >
            <Plus size={14} />{t('recado.novo')}
          </button>
        }
      />

      <AsyncSection state={estado} empty={dados => !dados.items?.length}>
        {dados => dados.items.map(aviso => (
          <section className="panel" key={aviso.id} style={{ marginTop: 18 }}>
            <div className="panel-head">
              <div>
                <h2 style={{ margin: 0 }}>{aviso.title}</h2>
                <small style={{ color: 'var(--cinza-fraco)' }}>
                  {aviso.startsAt || aviso.endsAt
                    ? t('recado.janela', {
                      de: aviso.startsAt ? formatarDataHora(aviso.startsAt) : t('recado.desdeJa'),
                      ate: aviso.endsAt ? formatarDataHora(aviso.endsAt) : t('recado.ateSegundaOrdem')
                    })
                    : t('recado.semJanela')}
                  {' · '}{t('recado.leituras', { total: aviso._count?.reads ?? 0 })}
                </small>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Badge tom={aviso.active ? 'ok' : 'neutro'}>{t(aviso.active ? 'recado.ativo' : 'recado.inativo')}</Badge>
                <Badge tom="neutro">{t(aviso.showOnce ? 'recado.umaVez' : 'recado.sempre')}</Badge>
                <button type="button" className="button button-secondary button-sm" onClick={() => alternarAtivo(aviso)}>
                  {aviso.active ? <EyeOff size={14} /> : <Eye size={14} />}
                  {t(aviso.active ? 'recado.desativar' : 'recado.ativar')}
                </button>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => setEditando({
                    ...aviso,
                    startsAt: paraCampo(aviso.startsAt),
                    endsAt: paraCampo(aviso.endsAt)
                  })}
                >
                  <PencilLine size={14} />{t('acao.editar')}
                </button>
                <button type="button" className="button button-secondary button-sm" onClick={() => setExcluindo(aviso)}>
                  <Trash2 size={14} />{t('acao.excluir')}
                </button>
              </div>
            </div>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{aviso.body}</p>
          </section>
        ))}
      </AsyncSection>

      {editando && (
        <DialogoDoRecado
          inicial={editando}
          notificar={notificar}
          onClose={() => setEditando(null)}
          onPronto={() => { setEditando(null); recarregar(); }}
        />
      )}

      {excluindo && (
        <DialogoDeExclusaoDoRecado
          aviso={excluindo}
          notificar={notificar}
          onClose={() => setExcluindo(null)}
          onPronto={() => { setExcluindo(null); recarregar(); }}
        />
      )}
    </div>
  );
}

function DialogoDoRecado({ inicial, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [form, setForm] = useState(inicial);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const editando = Boolean(inicial.id);
  const alterar = (campo, valor) => setForm(atual => ({ ...atual, [campo]: valor }));

  const enviar = async evento => {
    evento.preventDefault();
    setEnviando(true);
    setRecusa(null);

    const corpo = {
      title: form.title.trim(),
      body: form.body.trim(),
      startsAt: paraApi(form.startsAt),
      endsAt: paraApi(form.endsAt),
      showOnce: form.showOnce
    };

    try {
      if (editando) await api.athleteNotices.update(inicial.id, corpo);
      else await api.athleteNotices.create({ ...corpo, organizationId: form.organizationId });
      notificar?.(t(editando ? 'recado.atualizado' : 'recado.publicado'));
      onPronto();
    } catch (erro) {
      setRecusa(erro.message);
      setEnviando(false);
    }
  };

  return (
    <Modal
      title={t(editando ? 'recado.editar' : 'recado.novo')}
      description={t('recado.dialogoDescricao')}
      onClose={onClose}
    >
      <form onSubmit={enviar}>
        {recusa && (
          <div className="alert alert-erro" role="alert">
            <Megaphone size={16} />
            <div><p>{recusa}</p></div>
          </div>
        )}

        <Field label={t('recado.campoTitulo')} required>
          <input type="text" value={form.title} onChange={e => alterar('title', e.target.value)} required maxLength={140} />
        </Field>

        <Field label={t('recado.campoTexto')} required hint={t('recado.campoTextoDica')}>
          <textarea value={form.body} onChange={e => alterar('body', e.target.value)} required rows={6} maxLength={4000} />
        </Field>

        <Field label={t('recado.campoInicio')} hint={t('recado.campoInicioDica')}>
          <input type="datetime-local" value={form.startsAt} onChange={e => alterar('startsAt', e.target.value)} />
        </Field>

        <Field label={t('recado.campoFim')} hint={t('recado.campoFimDica')}>
          <input type="datetime-local" value={form.endsAt} onChange={e => alterar('endsAt', e.target.value)} />
        </Field>

        <Field label={t('recado.campoRepeticao')} hint={t('recado.campoRepeticaoDica')}>
          <select value={form.showOnce ? 'uma' : 'sempre'} onChange={e => alterar('showOnce', e.target.value === 'uma')}>
            <option value="uma">{t('recado.umaVez')}</option>
            <option value="sempre">{t('recado.sempre')}</option>
          </select>
        </Field>

        <ModalActions onClose={onClose} saving={enviando} confirmLabel={t(editando ? 'acao.salvar' : 'recado.publicar')} />
      </form>
    </Modal>
  );
}

// APAGAR É OFERECIDO, MAS QUEM DECIDE É O SERVIDOR.
//
// Depois que alguém leu, a linha de leitura é o registro de que a comunicação
// chegou — apagar o recado apagaria o que aquela pessoa foi comunicada. A tela
// não tenta prever: ela chama, e mostra a recusa como ela vem, com a contagem
// e o caminho da desativação.
function DialogoDeExclusaoDoRecado({ aviso, notificar, onClose, onPronto }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  const confirmar = async () => {
    setEnviando(true);
    setRecusa(null);
    try {
      await api.athleteNotices.remove(aviso.id);
      notificar?.(t('recado.excluido'));
      onPronto();
    } catch (erro) {
      setRecusa(erro.message);
      setEnviando(false);
    }
  };

  return (
    <Modal title={t('acao.excluir')} onClose={onClose}>
      <p>{t('recado.excluirDescricao')}</p>

      {recusa && (
        <div className="alert alert-erro" role="alert">
          <Megaphone size={16} />
          <div><p>{recusa}</p></div>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button button-danger" onClick={confirmar} disabled={enviando}>
          {t('acao.excluir')}
        </button>
      </div>
    </Modal>
  );
}

export default AdminMensagens;

import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { useAuth } from '../AuthContext';
import { useIdioma } from '../lib/idioma';
import { permissoesDe, podeCom } from '../lib/permissoes';
import {
  AsyncSection, Badge, ConfirmDialog, EmptyState, Field, Modal, ModalActions
} from '../components/ui';
import { invalidar, urlDaLogo } from '../lib/catalogoDePatrocinio';
import FaixaDePatrocinio from '../components/faixaDePatrocinio';

// ============================================================================
// CONFIGURAÇÕES → PATROCINADORES OFICIAIS.
//
// A tela onde o campeonato administra a própria vitrine. Antes desta tela,
// trocar um patrocinador era alterar `lib/patrocinadores.js` e fazer deploy.
//
// SÓ SUPER ADMIN. A conferência aqui é CONVENIÊNCIA, não defesa: o menu
// "Configurações" é liberado por `users.read`, que o diretor de evento tem —
// sem ela ele chegaria a esta aba e veria botões que só responderiam 403.
// Quem autoriza de verdade é a API, e abaixo dela a política do banco
// (`mci_is_super_admin()`). São três camadas para a mesma decisão.
//
// POUCOS CLIQUES, de propósito: adicionar é um modal só, com a logo junto;
// ativar/desativar é um clique na linha; ordem e nível se editam no mesmo
// formulário de edição. Nada de arrastar — mudar de nível por arrasto é
// acidente esperando acontecer, e a hierarquia é contrato comercial.
//
// TODO TEXTO VISÍVEL PASSA PELO DICIONÁRIO. O nível, não: `GLOBAL`,
// `DIAMANTE`, `GOLD` e `SILVER` são o enum do banco e continuam idênticos nos
// três idiomas. O que se traduz é o RÓTULO ao lado deles.
// ============================================================================

/**
 * A ordem dos níveis É a hierarquia.
 *
 * O valor é o enum do banco; a chave é o rótulo no dicionário. O rótulo do
 * Silver carrega a apresentação comercial ("apoio e parceiros") — que é
 * apresentação, e não um quinto nível.
 */
const NIVEIS = [
  ['GLOBAL', 'patrocinadores.nivelGlobal'],
  ['DIAMANTE', 'patrocinadores.nivelDiamante'],
  ['GOLD', 'patrocinadores.nivelGold'],
  ['SILVER', 'patrocinadores.nivelSilver']
];

const VAZIO = { code: '', name: '', level: 'GOLD', sortOrder: 0, siteUrl: '', active: true };

/** Sugere um código a partir do nome, e deixa o campo editável. */
const codigoSugerido = nome => nome
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * O retrato de uma logo, sempre dentro de uma caixa fixa e sem deformar.
 *
 * `object-fit: contain` e caixa de tamanho declarado: a arte encaixa na
 * própria proporção, e o espaço já está reservado antes de a imagem chegar —
 * sem deslocamento de layout quando ela carrega.
 */
function Previa({ src, alt, altura = 44 }) {
  if (!src) return <span className="patro-previa patro-previa-vazia" style={{ height: altura }} aria-hidden="true" />;
  return (
    <span className="patro-previa" style={{ height: altura }}>
      <img src={src} alt={alt} />
    </span>
  );
}

/**
 * O campo de arquivo com prévia imediata.
 *
 * A prévia sai de um `blob:` local — nada sobe até o formulário ser enviado.
 * A URL é revogada na troca e na desmontagem: sem isso cada escolha de arquivo
 * deixaria um objeto preso na memória da aba.
 */
function EscolherLogo({ onArquivo, rotulo, obrigatorio = false }) {
  const { t } = useIdioma();
  const [previa, setPrevia] = useState(null);
  const entrada = useRef(null);
  const anterior = useRef(null);

  useEffect(() => () => { if (anterior.current) URL.revokeObjectURL(anterior.current); }, []);

  const escolher = evento => {
    const arquivo = evento.target.files?.[0] || null;
    if (anterior.current) URL.revokeObjectURL(anterior.current);
    anterior.current = arquivo ? URL.createObjectURL(arquivo) : null;
    setPrevia(anterior.current);
    onArquivo(arquivo);
  };

  return (
    // `hint` e não um `<small>` solto: `Field` envolve tudo num `<label>`, e
    // texto solto ali entra no NOME ACESSÍVEL do campo.
    <Field label={rotulo} required={obrigatorio} hint={t('patrocinadores.dicaLogo')}>
      <div className="patro-escolher">
        <input
          ref={entrada}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={escolher}
          required={obrigatorio}
        />
        <Previa src={previa} alt={t('patrocinadores.altPrevia')} />
      </div>
    </Field>
  );
}

function FormularioDoPatrocinador({ patrocinador, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const editando = Boolean(patrocinador);
  const [form, setForm] = useState(() => (editando
    ? {
      code: patrocinador.code,
      name: patrocinador.name,
      level: patrocinador.level,
      sortOrder: patrocinador.sortOrder,
      siteUrl: patrocinador.siteUrl || '',
      active: patrocinador.active
    }
    : VAZIO));
  const [arquivo, setArquivo] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [codigoTocado, setCodigoTocado] = useState(false);

  const trocarNome = valor => setForm(atual => ({
    ...atual,
    name: valor,
    // O código acompanha o nome até alguém mexer nele. Depois disso é do
    // usuário, e a digitação não o sobrescreve.
    ...(editando || codigoTocado ? {} : { code: codigoSugerido(valor) })
  }));

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      if (editando) {
        await api.officialSponsors.update(patrocinador.id, {
          name: form.name,
          level: form.level,
          sortOrder: Number(form.sortOrder),
          siteUrl: form.siteUrl || null,
          active: form.active,
          // A VERSÃO DE ONDE PARTIMOS. Se outra pessoa salvou no meio do
          // caminho, a API responde 409 em vez de sobrescrever em silêncio.
          updatedAt: patrocinador.updatedAt
        });
        if (arquivo) await api.officialSponsors.changeLogo(patrocinador.id, arquivo);
        notificar(t('patrocinadores.atualizado'));
      } else {
        await api.officialSponsors.create(arquivo, {
          code: form.code,
          name: form.name,
          level: form.level,
          sortOrder: Number(form.sortOrder),
          siteUrl: form.siteUrl || undefined,
          active: form.active
        });
        notificar(t('patrocinadores.criado'));
      }
      // A vitrine inteira relê o catálogo na próxima montagem.
      invalidar();
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal
      title={editando
        ? t('patrocinadores.editarTitulo', { nome: patrocinador.name })
        : t('patrocinadores.novoTitulo')}
      description={editando
        ? t('patrocinadores.editarDescricao')
        : t('patrocinadores.novoDescricao')}
      onClose={onClose}
    >
      <form onSubmit={salvar}>
        <Field label={t('patrocinadores.campoNome')} required>
          <input type="text" value={form.name} onChange={evt => trocarNome(evt.target.value)} required minLength={2} maxLength={120} />
        </Field>

        {!editando && (
          <Field label={t('patrocinadores.campoCodigo')} required hint={t('patrocinadores.dicaCodigo')}>
            <input
              type="text"
              value={form.code}
              onChange={evt => { setCodigoTocado(true); setForm({ ...form, code: evt.target.value.toUpperCase() }); }}
              required
              pattern="[A-Z0-9-]{2,40}"
              title={t('patrocinadores.formatoCodigo')}
            />
          </Field>
        )}

        <Field label={t('patrocinadores.campoNivel')} required>
          <select value={form.level} onChange={evt => setForm({ ...form, level: evt.target.value })} required>
            {NIVEIS.map(([valor, chave]) => <option key={valor} value={valor}>{t(chave)}</option>)}
          </select>
        </Field>

        <Field label={t('patrocinadores.campoOrdem')} required hint={t('patrocinadores.dicaOrdem')}>
          <input
            type="number" min={0} max={9999} required
            value={form.sortOrder}
            onChange={evt => setForm({ ...form, sortOrder: evt.target.value })}
          />
        </Field>

        <Field label={t('patrocinadores.campoSite')} hint={t('patrocinadores.dicaSite')}>
          <input
            type="url" placeholder={t('patrocinadores.placeholderSite')}
            value={form.siteUrl}
            onChange={evt => setForm({ ...form, siteUrl: evt.target.value })}
          />
        </Field>

        {editando && (
          <Field label={t('patrocinadores.logoAtual')}>
            <Previa
              src={urlDaLogo(patrocinador)}
              alt={t('patrocinadores.altLogoAtual', { nome: patrocinador.name })}
              altura={56}
            />
          </Field>
        )}

        <EscolherLogo
          rotulo={editando ? t('patrocinadores.campoTrocarLogo') : t('patrocinadores.campoLogo')}
          obrigatorio={!editando}
          onArquivo={setArquivo}
        />

        <Field label={t('patrocinadores.situacao')}>
          <label className="patro-ativo">
            <input type="checkbox" checked={form.active} onChange={evt => setForm({ ...form, active: evt.target.checked })} />
            {t('patrocinadores.ativoDescricao')}
          </label>
        </Field>

        {/* Sem `confirmLabel` na edição: o padrão de `ModalActions` já é
            `acao.salvar`, e repetir a chave aqui seria uma segunda fonte para
            a mesma palavra. */}
        <ModalActions
          onClose={onClose}
          saving={salvando}
          confirmLabel={editando ? null : t('patrocinadores.salvarNovo')}
        />
      </form>
    </Modal>
  );
}

/**
 * A confirmação da remoção definitiva, com o motivo.
 *
 * ELE TEM ESTADO PRÓPRIO, e isso não é organização: o `motivo` morava na
 * página, e cada tecla re-renderizava o diálogo inteiro. O `Modal` leva o foco
 * para a caixa quando monta, e o resultado medido foi que só a PRIMEIRA letra
 * entrava — o campo perdia o foco em seguida. Estado de formulário pertence ao
 * formulário, que é como os outros modais deste arquivo sempre fizeram.
 */
function ConfirmarRemocao({ patrocinador, salvando, onClose, onConfirmar }) {
  const { t } = useIdioma();
  const [motivo, setMotivo] = useState('');

  return (
    <Modal
      title={t('patrocinadores.removerTitulo', { nome: patrocinador.name })}
      description={t('patrocinadores.removerDescricao')}
      onClose={onClose}
    >
      <form onSubmit={evt => { evt.preventDefault(); onConfirmar(motivo); }}>
        <Field label={t('patrocinadores.campoMotivo')} required hint={t('patrocinadores.dicaMotivo')}>
          <input
            type="text"
            value={motivo}
            onChange={evt => setMotivo(evt.target.value)}
            required minLength={5} maxLength={500}
            placeholder={t('patrocinadores.placeholderMotivo')}
          />
        </Field>
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('patrocinadores.removerConfirmar')} />
      </form>
    </Modal>
  );
}

export default function PatrocinadoresOficiais({ notificar }) {
  const { t } = useIdioma();
  const { user } = useAuth();
  const podeGerenciar = podeCom(permissoesDe(user))('sponsors.official');
  const estado = useFetch(() => (podeGerenciar ? api.officialSponsors.list() : Promise.resolve({ items: [] })), [podeGerenciar]);

  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState(null);
  const [desativando, setDesativando] = useState(null);
  const [removendo, setRemovendo] = useState(null);
  const [previaPublica, setPreviaPublica] = useState(false);
  const [agindo, setAgindo] = useState(false);

  const recarregar = () => { invalidar(); estado.reload(); };

  if (!podeGerenciar) {
    return (
      <EmptyState
        title={t('patrocinadores.semAcesso')}
        description={t('patrocinadores.semAcessoDescricao')}
      />
    );
  }

  const alternarAtivo = async patrocinador => {
    setAgindo(true);
    try {
      await api.officialSponsors.update(patrocinador.id, {
        active: !patrocinador.active, updatedAt: patrocinador.updatedAt
      });
      notificar(patrocinador.active
        ? t('patrocinadores.desativado')
        : t('patrocinadores.reativado'));
      recarregar();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setAgindo(false);
      setDesativando(null);
    }
  };

  const remover = async motivo => {
    setAgindo(true);
    try {
      await api.officialSponsors.remove(removendo.id, motivo);
      notificar(t('patrocinadores.removido'));
      recarregar();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setAgindo(false);
      setRemovendo(null);
    }
  };

  return (
    <>
      {/* Cabeçalho de SEÇÃO, e não um `PageHead`: a página já tem o dela, em
          "Configurações", e dois cabeçalhos empilhados com a mesma sobrancelha
          "Administração" leem como duas telas coladas. */}
      <header className="patro-cabecalho">
        <h2>{t('patrocinadores.titulo')}</h2>
        <p>{t('patrocinadores.descricao')}</p>
      </header>

      <div className="toolbar">
        <button type="button" className="button button-primary" onClick={() => setCriando(true)}>
          <Plus size={14} /> {t('patrocinadores.adicionar')}
        </button>
        {/* A PRÉVIA NÃO REDESENHA A VITRINE: ela monta o MESMO componente que
            o rodapé público usa. Uma cópia aqui divergiria do que o visitante
            vê, que é justamente o que uma prévia existe para evitar. */}
        <button type="button" className="button button-ghost" onClick={() => setPreviaPublica(v => !v)}>
          {previaPublica ? t('patrocinadores.ocultarPrevia') : t('patrocinadores.verComoPublico')}
        </button>
      </div>

      {previaPublica && (
        <section className="panel patro-previa-publica">
          <div className="panel-head">
            <h2>{t('patrocinadores.previaPublica')}</h2>
            <small>{t('patrocinadores.previaDescricao')}</small>
          </div>
          <FaixaDePatrocinio />
        </section>
      )}

      <AsyncSection state={estado} linhas={6}>
        {dados => {
          const todos = dados.items || [];
          if (!todos.length) {
            return (
              <EmptyState
                title={t('patrocinadores.catalogoVazio')}
                description={t('patrocinadores.catalogoVazioDescricao')}
              />
            );
          }
          return NIVEIS.map(([nivel, chave]) => {
            const doNivel = todos.filter(p => p.level === nivel);
            if (!doNivel.length) return null;
            return (
              <section className="panel" key={nivel}>
                <div className="panel-head">
                  <h2>{t(chave)}</h2>
                  <small>{t('patrocinadores.contagem', { n: doNivel.length })}</small>
                </div>
                {doNivel.map(p => (
                  <div className={`list-row patro-linha${p.active ? '' : ' patro-inativo'}`} key={p.id}>
                    <Previa
                      src={p.hasLogo ? urlDaLogo(p) : null}
                      alt={t('patrocinadores.altLogo', { nome: p.name })}
                    />
                    <span className="info">
                      <strong>{p.name}</strong>
                      <small>
                        {p.code} · {t('patrocinadores.ordem', { n: p.sortOrder })}
                        {p.siteUrl ? ` · ${t('patrocinadores.comSite')}` : ''}
                      </small>
                    </span>
                    <Badge tom={p.active ? 'ok' : 'neutro'}>
                      {p.active ? t('patrocinadores.ativo') : t('patrocinadores.inativo')}
                    </Badge>
                    <span className="patro-acoes">
                      <button type="button" className="button button-ghost button-sm" onClick={() => setEditando(p)}>
                        <Pencil size={13} /> {t('patrocinadores.editar')}
                      </button>
                      <button
                        type="button"
                        className="button button-ghost button-sm"
                        disabled={agindo}
                        onClick={() => (p.active ? setDesativando(p) : alternarAtivo(p))}
                      >
                        {p.active ? <EyeOff size={13} /> : <Eye size={13} />}
                        {' '}
                        {p.active ? t('patrocinadores.desativar') : t('patrocinadores.reativar')}
                      </button>
                      <button type="button" className="button button-ghost button-sm" onClick={() => setRemovendo(p)}>
                        <Trash2 size={13} /> {t('patrocinadores.remover')}
                      </button>
                    </span>
                  </div>
                ))}
              </section>
            );
          });
        }}
      </AsyncSection>

      {criando && (
        <FormularioDoPatrocinador
          notificar={notificar}
          onClose={() => setCriando(false)}
          onSalvo={() => { setCriando(false); recarregar(); }}
        />
      )}

      {editando && (
        <FormularioDoPatrocinador
          patrocinador={editando}
          notificar={notificar}
          onClose={() => setEditando(null)}
          onSalvo={() => { setEditando(null); recarregar(); }}
        />
      )}

      {desativando && (
        <ConfirmDialog
          title={t('patrocinadores.confirmarDesativar')}
          message={t('patrocinadores.confirmarDesativarTexto')}
          confirmLabel={t('patrocinadores.desativar')}
          onClose={() => setDesativando(null)}
          onConfirm={() => alternarAtivo(desativando)}
        />
      )}

      {removendo && (
        <ConfirmarRemocao
          patrocinador={removendo}
          salvando={agindo}
          onClose={() => setRemovendo(null)}
          onConfirmar={remover}
        />
      )}
    </>
  );
}

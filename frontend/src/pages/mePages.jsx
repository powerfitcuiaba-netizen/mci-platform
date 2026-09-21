import { useState } from 'react';
import { CalendarDays, KeyRound, Trophy } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Field, Metric, Modal, ModalActions, PageHead } from '../components/ui';
import { useIdioma } from '../lib/idioma';
import { ESTADO_PRO, formatarData, formatarDataHora, pesoEmKg, seloDoEvento, estadoDaBateria, estadoDaInscricao, papel, estadoDoUsuario } from '../lib/format';

// Painel do atleta e conta do usuário.

export function MeuPainel({ navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.dashboard.athlete(), []);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('carreira.meuEspaco')}
        title={t('painel.meuPainel')}
        description={t('painel.descricao')}
      />

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          if (!dados.athlete) {
            // O texto antigo dizia que o perfil nascia "no momento da
            // inscrição". Deixou de ser verdade quando a fila de solicitação
            // passou a existir: agora a própria pessoa pede, e a federação
            // confirma. Um vazio que descreve um caminho que não existe mais é
            // pior que nenhum vazio.
            return (
              <EmptyState
                title={t('carreira.semPerfil')}
                description={t('painel.semPerfilDescricao')}
                action={(
                  <>
                    <button type="button" className="button button-primary" onClick={() => navegar('minha-solicitacao')}>
                      {t('solicitacao.solicitarPerfil')}
                    </button>
                    <button type="button" className="button button-ghost" onClick={() => navegar('social')}>
                      {t('painel.irParaOFeed')}
                    </button>
                  </>
                )}
              />
            );
          }

          const { athlete, registrations, upcoming, results, rankings, titles, batches, unreadMessages, social } = dados;

          return (
            <>
              <section className="hero" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                <Avatar name={athlete.fullName} size="avatar-lg" />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <span className="eyebrow">{athlete.affiliation?.name || t('painel.semFiliacao')}</span>
                  <h1 style={{ marginTop: 6 }}>{athlete.stageName || athlete.fullName}</h1>
                  <div className="hero-meta">
                    <span>{athlete.city || '—'}{athlete.state ? `/${athlete.state}` : ''}</span>
                    <span>{athlete.team?.name || t('painel.semEquipe')}</span>
                    <span>{athlete.gym?.name || t('painel.semAcademia')}</span>
                    <Badge tom={ESTADO_PRO[athlete.proStatus].tom}>{ESTADO_PRO[athlete.proStatus].rotulo}</Badge>
                  </div>
                </div>
              </section>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <Metric label={t('painel.titulos')} value={titles} destaque />
                <Metric label={t('painel.inscricoes')} value={registrations.length} />
                <Metric
                  label={t('painel.publicacoes')} value={social?.posts ?? 0}
                  hint={t('painel.seguidores', { n: social?.followers ?? 0 })}
                />
                <Metric label={t('painel.mensagens')} value={unreadMessages} hint={t('painel.naCaixaDeEntrada')} />
              </div>

              <div className="grid grid-main" style={{ marginTop: 18 }}>
                <section className="panel">
                  <div className="panel-head"><h2>{t('painel.minhaAgenda')}</h2></div>
                  {upcoming.length
                    ? upcoming.map(inscricao => (
                      <button
                        key={inscricao.id}
                        type="button"
                        className="list-row"
                        style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left' }}
                        onClick={() => navegar(`campeonatos/${inscricao.event.slug}`)}
                      >
                        <span className="avatar"><CalendarDays size={15} /></span>
                        <span className="info">
                          <strong>{inscricao.event.name}</strong>
                          <small>
                            {formatarData(inscricao.event.startDate, inscricao.event.timezone)} · {inscricao.event.city || '—'}
                            {' · '}{inscricao.items.map(item => item.competitionClass.name).join(', ')}
                          </small>
                        </span>
                        {(() => {
                          const selo = seloDoEvento(inscricao.event);
                          return <Badge tom={selo.tom} aoVivo={selo.aoVivo}>{selo.rotulo}</Badge>;
                        })()}
                      </button>
                    ))
                    : <EmptyState title={t('painel.semEventosFuturos')} description={t('painel.semEventosFuturosDescricao')} />}

                  {batches.length > 0 && (
                    <>
                      <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', margin: '18px 0 10px' }}>{t('painel.minhasBaterias')}</h3>
                      {batches.map((ordem, indice) => (
                        <div className="list-row" key={`${ordem.batch.id}-${indice}`}>
                          <span className="placing">{ordem.position}</span>
                          <span className="info">
                            <strong>{ordem.batch.name}</strong>
                            <small>{ordem.batch.scheduledAt ? formatarDataHora(ordem.batch.scheduledAt) : t('painel.horarioADefinir')}</small>
                          </span>
                          <Badge tom={estadoDaBateria(ordem.status).tom}>{estadoDaBateria(ordem.status).rotulo}</Badge>
                        </div>
                      ))}
                    </>
                  )}
                </section>

                <section className="panel">
                  <div className="panel-head"><h2>{t('painel.meusResultados')}</h2></div>
                  {results.length
                    ? results.map((entrada, indice) => (
                      <div className="list-row" key={`${entrada.result.event.id}-${indice}`}>
                        <span className={`placing placing-${entrada.placing}`}>{entrada.placing ?? '—'}</span>
                        <span className="info">
                          <strong>{entrada.result.event.name}</strong>
                          <small>{entrada.registrationItem.competitionClass.name} · {formatarData(entrada.result.publishedAt)}</small>
                        </span>
                      </div>
                    ))
                    : <EmptyState title={t('painel.semResultados')} />}

                  {rankings.length > 0 && (
                    <>
                      <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', margin: '18px 0 10px' }}>{t('painel.meuRanking')}</h3>
                      {rankings.map(linha => (
                        <div className="list-row" key={linha.id}>
                          <span className={`placing placing-${linha.position}`}>{linha.position ?? '—'}</span>
                          <span className="info">
                            <strong>{linha.category?.name || t('painel.rankingGeral')}</strong>
                            <small>{linha.season.name}</small>
                          </span>
                          <strong style={{ color: 'var(--vermelho-claro)' }}>{linha.totalPoints}</strong>
                        </div>
                      ))}
                    </>
                  )}
                </section>
              </div>

              <section className="panel" style={{ marginTop: 18 }}>
                <div className="panel-head"><h2>{t('painel.minhasInscricoes')}</h2></div>
                {registrations.length
                  ? registrations.map(inscricao => (
                    <div className="list-row" key={inscricao.id}>
                      <span className="avatar"><Trophy size={15} /></span>
                      <span className="info">
                        <strong>{inscricao.event.name}</strong>
                        <small>
                          {inscricao.items.map(item => `${item.competitionClass.division.eventCategory.category.name} · ${item.competitionClass.name}`).join(' | ')}
                          {inscricao.weighIns[0]
                            ? ` · ${t('painel.pesagem', { peso: pesoEmKg(inscricao.weighIns[0].weightGrams) })}`
                            : ''}
                        </small>
                      </span>
                      {inscricao.checkIn?.status === 'CHECKED_IN' && <Badge tom="ok">{t('painel.checkInFeito')}</Badge>}
                      <Badge tom={estadoDaInscricao(inscricao.status).tom}>{estadoDaInscricao(inscricao.status).rotulo}</Badge>
                    </div>
                  ))
                  : <EmptyState title={t('painel.nenhumaInscricao')} />}
              </section>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function MinhaConta({ notificar }) {
  const { t } = useIdioma();
  const { user, refreshSession } = useAuth();
  const [editando, setEditando] = useState(false);
  const [trocandoSenha, setTrocandoSenha] = useState(false);

  return (
    <div className="page">
      <PageHead eyebrow={t('conta.conta')} title={t('conta.minhaConta')} description={t('conta.descricao')} />

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>{t('conta.dados')}</h2>
            <button type="button" className="button button-secondary button-sm" onClick={() => setEditando(true)}>
              {t('conta.editar')}
            </button>
          </div>
          <dl className="kv">
            <dt>{t('conta.nome')}</dt><dd>{user?.name}</dd>
            <dt>{t('conta.email')}</dt><dd>{user?.email}</dd>
            <dt>{t('conta.papelGlobal')}</dt><dd><Badge tom={papel(user?.role).tom}>{papel(user?.role).rotulo}</Badge></dd>
            <dt>{t('conta.situacao')}</dt>
            <dd><Badge tom={estadoDoUsuario(user?.status).tom}>{estadoDoUsuario(user?.status).rotulo}</Badge></dd>
          </dl>
          <button type="button" className="button button-secondary" style={{ marginTop: 16 }} onClick={() => setTrocandoSenha(true)}>
            <KeyRound size={14} /> {t('conta.trocarSenha')}
          </button>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>{t('conta.organizacoes')}</h2></div>
          {user?.organizations?.length
            ? user.organizations.map((vinculo, indice) => (
              <div className="list-row" key={`${vinculo.organizationId}-${indice}`}>
                <span className="info">
                  <strong>{vinculo.name || vinculo.organizationId}</strong>
                  <small>{vinculo.slug}</small>
                </span>
                <Badge tom={papel(vinculo.role).tom}>{papel(vinculo.role).rotulo}</Badge>
              </div>
            ))
            : <EmptyState title={t('conta.semVinculo')} description={t('conta.semVinculoDescricao')} />}
        </section>
      </div>

      {editando && (
        <EditarConta
          user={user}
          notificar={notificar}
          onClose={() => setEditando(false)}
          onSalvo={async () => { setEditando(false); await refreshSession(); }}
        />
      )}
      {trocandoSenha && <TrocarSenha notificar={notificar} onClose={() => setTrocandoSenha(false)} />}
    </div>
  );
}

function EditarConta({ user, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.auth.updateProfile(form);
      notificar(t('conta.dadosAtualizados'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('conta.editarConta')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('conta.nome')} required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required minLength={2} maxLength={120} /></Field>
        <Field label={t('conta.email')} required><input type="email" value={form.email} onChange={evt => setForm({ ...form, email: evt.target.value })} required maxLength={180} /></Field>
        <ModalActions onClose={onClose} saving={salvando} />
      </form>
    </Modal>
  );
}

function TrocarSenha({ notificar, onClose }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmacao: '' });
  const [salvando, setSalvando] = useState(false);

  const divergente = form.newPassword !== form.confirmacao;

  const salvar = async evento => {
    evento.preventDefault();
    if (divergente) return;
    setSalvando(true);
    try {
      await api.auth.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });
      notificar(t('conta.senhaAlterada'));
      onClose();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('conta.trocarSenha')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('conta.senhaAtual')} required><input type="password" value={form.currentPassword} onChange={evt => setForm({ ...form, currentPassword: evt.target.value })} required minLength={8} /></Field>
        <Field label={t('conta.novaSenha')} required hint={t('cadastro.senhaHint')}><input type="password" value={form.newPassword} onChange={evt => setForm({ ...form, newPassword: evt.target.value })} required minLength={8} /></Field>
        <Field label={t('conta.confirmarNovaSenha')} required><input type="password" value={form.confirmacao} onChange={evt => setForm({ ...form, confirmacao: evt.target.value })} required minLength={8} /></Field>
        {divergente && form.confirmacao && (
          <div className="alert alert-erro" style={{ marginBottom: 12 }}><div><strong>{t('conta.senhasNaoCoincidem')}</strong></div></div>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel={t('conta.trocarSenha')} disabled={divergente || !form.confirmacao} />
      </form>
    </Modal>
  );
}

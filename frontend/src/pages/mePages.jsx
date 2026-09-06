import { useState } from 'react';
import { CalendarDays, KeyRound, Trophy } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../AuthContext';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Field, Metric, Modal, ModalActions, PageHead } from '../components/ui';
import { ESTADO_EVENTO, ESTADO_PRO, formatarData, formatarDataHora, pesoEmKg } from '../lib/format';

// Painel do atleta e conta do usuário.

export function MeuPainel({ navegar }) {
  const estado = useFetch(() => api.dashboard.athlete(), []);

  return (
    <div className="page">
      <PageHead eyebrow="Meu espaço" title="Meu painel" description="Inscrições, agenda, baterias, resultados, ranking e vida social." />

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          if (!dados.athlete) {
            return (
              <EmptyState
                title="Você ainda não tem perfil de atleta"
                description="O perfil de atleta é criado pela organização no momento da inscrição, a partir do seu CPF. Enquanto isso, a área social está toda disponível."
                action={<button type="button" className="button button-primary" onClick={() => navegar('social')}>Ir para o feed</button>}
              />
            );
          }

          const { athlete, registrations, upcoming, results, rankings, titles, batches, unreadMessages, social } = dados;

          return (
            <>
              <section className="hero" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                <Avatar name={athlete.fullName} size="avatar-lg" />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <span className="eyebrow">{athlete.affiliation?.name || 'Sem filiação'}</span>
                  <h1 style={{ marginTop: 6 }}>{athlete.stageName || athlete.fullName}</h1>
                  <div className="hero-meta">
                    <span>{athlete.city || '—'}{athlete.state ? `/${athlete.state}` : ''}</span>
                    <span>{athlete.team?.name || 'Sem equipe'}</span>
                    <span>{athlete.gym?.name || 'Sem academia'}</span>
                    <Badge tom={ESTADO_PRO[athlete.proStatus].tom}>{ESTADO_PRO[athlete.proStatus].rotulo}</Badge>
                  </div>
                </div>
              </section>

              <div className="grid grid-4" style={{ marginTop: 18 }}>
                <Metric label="Títulos" value={titles} destaque />
                <Metric label="Inscrições" value={registrations.length} />
                <Metric label="Publicações" value={social?.posts ?? 0} hint={`${social?.followers ?? 0} seguidores`} />
                <Metric label="Mensagens" value={unreadMessages} hint="na caixa de entrada" />
              </div>

              <div className="grid grid-main" style={{ marginTop: 18 }}>
                <section className="panel">
                  <div className="panel-head"><h2>Minha agenda</h2></div>
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
                        <Badge tom={(ESTADO_EVENTO[inscricao.event.status] || {}).tom || 'neutro'}>
                          {(ESTADO_EVENTO[inscricao.event.status] || {}).rotulo || inscricao.event.status}
                        </Badge>
                      </button>
                    ))
                    : <EmptyState title="Sem eventos futuros" description="Suas próximas etapas aparecem aqui." />}

                  {batches.length > 0 && (
                    <>
                      <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', margin: '18px 0 10px' }}>Minhas baterias</h3>
                      {batches.map((ordem, indice) => (
                        <div className="list-row" key={`${ordem.batch.id}-${indice}`}>
                          <span className="placing">{ordem.position}</span>
                          <span className="info">
                            <strong>{ordem.batch.name}</strong>
                            <small>{ordem.batch.scheduledAt ? formatarDataHora(ordem.batch.scheduledAt) : 'horário a definir'}</small>
                          </span>
                          <Badge tom={ordem.status === 'CALLED' ? 'alerta' : 'neutro'}>{ordem.status}</Badge>
                        </div>
                      ))}
                    </>
                  )}
                </section>

                <section className="panel">
                  <div className="panel-head"><h2>Meus resultados</h2></div>
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
                    : <EmptyState title="Sem resultados publicados" />}

                  {rankings.length > 0 && (
                    <>
                      <h3 style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--cinza-fraco)', margin: '18px 0 10px' }}>Meu ranking</h3>
                      {rankings.map(linha => (
                        <div className="list-row" key={linha.id}>
                          <span className={`placing placing-${linha.position}`}>{linha.position ?? '—'}</span>
                          <span className="info">
                            <strong>{linha.category?.name || 'Geral'}</strong>
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
                <div className="panel-head"><h2>Minhas inscrições</h2></div>
                {registrations.length
                  ? registrations.map(inscricao => (
                    <div className="list-row" key={inscricao.id}>
                      <span className="avatar"><Trophy size={15} /></span>
                      <span className="info">
                        <strong>{inscricao.event.name}</strong>
                        <small>
                          {inscricao.items.map(item => `${item.competitionClass.division.eventCategory.category.name} · ${item.competitionClass.name}`).join(' | ')}
                          {inscricao.weighIns[0] ? ` · pesagem ${pesoEmKg(inscricao.weighIns[0].weightGrams)}` : ''}
                        </small>
                      </span>
                      {inscricao.checkIn?.status === 'CHECKED_IN' && <Badge tom="ok">Check-in feito</Badge>}
                      <Badge tom={inscricao.status === 'CONFIRMED' ? 'ok' : inscricao.status === 'CANCELLED' ? 'perigo' : 'alerta'}>{inscricao.status}</Badge>
                    </div>
                  ))
                  : <EmptyState title="Nenhuma inscrição" />}
              </section>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function MinhaConta({ notificar }) {
  const { user, refreshSession } = useAuth();
  const [editando, setEditando] = useState(false);
  const [trocandoSenha, setTrocandoSenha] = useState(false);

  return (
    <div className="page">
      <PageHead eyebrow="Conta" title="Minha conta" description="Dados de acesso, papéis e vínculos de organização." />

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Dados</h2>
            <button type="button" className="button button-secondary button-sm" onClick={() => setEditando(true)}>Editar</button>
          </div>
          <dl className="kv">
            <dt>Nome</dt><dd>{user?.name}</dd>
            <dt>Email</dt><dd>{user?.email}</dd>
            <dt>Papel global</dt><dd><Badge tom="info">{user?.role}</Badge></dd>
            <dt>Situação</dt><dd><Badge tom={user?.status === 'ACTIVE' ? 'ok' : 'perigo'}>{user?.status}</Badge></dd>
          </dl>
          <button type="button" className="button button-secondary" style={{ marginTop: 16 }} onClick={() => setTrocandoSenha(true)}>
            <KeyRound size={14} /> Trocar senha
          </button>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>Organizações</h2></div>
          {user?.organizations?.length
            ? user.organizations.map((vinculo, indice) => (
              <div className="list-row" key={`${vinculo.organizationId}-${indice}`}>
                <span className="info">
                  <strong>{vinculo.name || vinculo.organizationId}</strong>
                  <small>{vinculo.slug}</small>
                </span>
                <Badge tom="info">{vinculo.role}</Badge>
              </div>
            ))
            : <EmptyState title="Sem vínculo" description="Papéis operacionais são concedidos por organização." />}
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
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.auth.updateProfile(form);
      notificar('Dados atualizados.');
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Editar conta" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Nome" required><input value={form.name} onChange={evt => setForm({ ...form, name: evt.target.value })} required minLength={2} maxLength={120} /></Field>
        <Field label="Email" required><input type="email" value={form.email} onChange={evt => setForm({ ...form, email: evt.target.value })} required maxLength={180} /></Field>
        <ModalActions onClose={onClose} saving={salvando} />
      </form>
    </Modal>
  );
}

function TrocarSenha({ notificar, onClose }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmacao: '' });
  const [salvando, setSalvando] = useState(false);

  const divergente = form.newPassword !== form.confirmacao;

  const salvar = async evento => {
    evento.preventDefault();
    if (divergente) return;
    setSalvando(true);
    try {
      await api.auth.changePassword({ currentPassword: form.currentPassword, newPassword: form.newPassword });
      notificar('Senha alterada.');
      onClose();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title="Trocar senha" onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label="Senha atual" required><input type="password" value={form.currentPassword} onChange={evt => setForm({ ...form, currentPassword: evt.target.value })} required minLength={8} /></Field>
        <Field label="Nova senha" required hint="Ao menos 8 caracteres."><input type="password" value={form.newPassword} onChange={evt => setForm({ ...form, newPassword: evt.target.value })} required minLength={8} /></Field>
        <Field label="Confirmar nova senha" required><input type="password" value={form.confirmacao} onChange={evt => setForm({ ...form, confirmacao: evt.target.value })} required minLength={8} /></Field>
        {divergente && form.confirmacao && (
          <div className="alert alert-erro" style={{ marginBottom: 12 }}><div><strong>As senhas não coincidem</strong></div></div>
        )}
        <ModalActions onClose={onClose} saving={salvando} confirmLabel="Trocar senha" disabled={divergente || !form.confirmacao} />
      </form>
    </Modal>
  );
}

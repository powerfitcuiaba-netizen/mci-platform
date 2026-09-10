import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Field, MarcaMci } from '../components/ui';

// Login e cadastro. O cadastro aberto só cria papéis sem poder operacional —
// papel privilegiado é concessão administrativa, e a API recusa o contrário.

const PAPEIS_ABERTOS = [
  ['ATHLETE', 'Atleta'],
  ['COACH', 'Coach'],
  ['GYM', 'Academia'],
  ['TEAM', 'Equipe'],
  ['BRAND', 'Marca'],
  ['SPONSOR', 'Patrocinador'],
  ['MEDIA', 'Imprensa']
];

export default function Auth() {
  const { login, register } = useAuth();
  const [modo, setModo] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'ATHLETE' });
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async evento => {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      if (modo === 'login') await login({ email: form.email, password: form.password });
      else await register({ name: form.name, email: form.email, password: form.password, role: form.role });
    } catch (problema) {
      setErro(problema.message);
      setEnviando(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <MarcaMci largura={168} className="marca-na-entrada" />
        <span className="eyebrow">MCI Platform</span>
        <h1>{modo === 'login' ? 'Entrar' : 'Criar conta'}</h1>
        <p>Campeonato Brasileiro Muscle Contest</p>

        <form onSubmit={enviar}>
          {modo === 'registro' && (
            <>
              <Field label="Nome completo" required>
                <input value={form.name} onChange={evento => setForm({ ...form, name: evento.target.value })} required minLength={2} maxLength={120} autoComplete="name" />
              </Field>
              <Field label="Você é" required>
                <select value={form.role} onChange={evento => setForm({ ...form, role: evento.target.value })} required>
                  {PAPEIS_ABERTOS.map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
                </select>
              </Field>
            </>
          )}

          <Field label="Email" required>
            <input type="email" value={form.email} onChange={evento => setForm({ ...form, email: evento.target.value })} required autoComplete="email" />
          </Field>
          <Field label="Senha" required hint={modo === 'registro' ? 'Ao menos 8 caracteres.' : undefined}>
            <input
              type="password"
              value={form.password}
              onChange={evento => setForm({ ...form, password: evento.target.value })}
              required
              minLength={8}
              autoComplete={modo === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>

          {erro && <div className="alert alert-erro" style={{ marginBottom: 14 }}><div><strong>{erro}</strong></div></div>}

          <button type="submit" className="button button-primary" style={{ width: '100%' }} disabled={enviando}>
            {enviando ? 'Aguarde…' : modo === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        <div className="auth-foot">
          <span>{modo === 'login' ? 'Não tem conta?' : 'Já tem conta?'}</span>
          <button
            type="button"
            className="button button-ghost button-sm link-inline"
            onClick={() => { setModo(modo === 'login' ? 'registro' : 'login'); setErro(null); }}
          >
            {modo === 'login' ? 'Criar conta' : 'Entrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

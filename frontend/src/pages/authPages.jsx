import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Field, MarcaMci } from '../components/ui';

// Login e cadastro.
//
// O que este formulário oferece é PERFIL PÚBLICO, não nível de acesso. Os sete
// valores abaixo são os únicos que o cadastro aberto cria, e quem decide isso é
// o servidor: `PAPEIS_DE_CADASTRO_ABERTO` em src/utils/roles.js entra num
// `z.enum` no schema e é reconferido em authService.register. Esconder uma
// opção aqui não protegeria nada — a proteção é de lá, e esta lista apenas
// reflete o que o servidor aceita.
//
// Função de operação (direção de evento, pesagem, palco, resultados) é
// concessão administrativa, registrada em auditoria. Não se pede por aqui.

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
              <Field
                label="Você é"
                required
                hint="Define como você aparece na plataforma. Não é nível de acesso."
              >
                <select value={form.role} onChange={evento => setForm({ ...form, role: evento.target.value })} required>
                  {PAPEIS_ABERTOS.map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
                </select>
              </Field>

              {/*
                Sem botão de "solicitar acesso", de propósito: não existe fluxo
                de solicitação nesta plataforma, e um botão que só registra uma
                intenção seria promessa de aprovação que ninguém prometeu.
                A frase diz o que realmente acontece e a quem recorrer.
              */}
              <p className="muted" style={{ marginTop: -4, marginBottom: 16 }}>
                Funções de operação — direção de evento, credenciamento, pesagem,
                palco, resultados — não são escolhidas aqui. Elas são concedidas
                pela organização do campeonato a uma conta que já existe.
              </p>
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

          {/* role="alert" para que o leitor de tela anuncie a recusa: sem ele,
              quem não enxerga a tela fica sem saber por que o envio não passou. */}
          {erro && <div className="alert alert-erro" role="alert" style={{ marginBottom: 14 }}><div><strong>{erro}</strong></div></div>}

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

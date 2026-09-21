import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Field, MarcaMci } from '../components/ui';
import CadastroWizard from './cadastroWizard';
import { useIdioma } from '../lib/idioma';

// Entrada do sistema.
//
// Só o login mora aqui. Criar conta é um assistente de 5 etapas
// (`cadastroWizard.jsx`), e a escolha de perfil vive com ele, em
// `lib/formulario.js::PAPEIS_ABERTOS` — uma cópia só, porque duas divergem.
//
// O perfil escolhido no cadastro é PERFIL PÚBLICO, não nível de acesso: quem
// decide é o servidor (`PAPEIS_DE_CADASTRO_ABERTO` em src/utils/roles.js entra
// num `z.enum` e é reconferido em authService.register).

export default function Auth({ entradaContinua = false }) {
  const { t } = useIdioma();
  const { login } = useAuth();
  const [modo, setModo] = useState('login');
  const [form, setForm] = useState({ email: '', password: '' });
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  // Criar conta é um assistente de 5 etapas, noutro componente: são 14 campos,
  // e enfiá-los nesta caixa faria a pessoa rolar a tela inteira no celular
  // antes de ver o primeiro erro.
  if (modo === 'registro') return <CadastroWizard aoVoltarParaEntrada={() => setModo('login')} />;

  const enviar = async evento => {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await login({ email: form.email, password: form.password });
    } catch (problema) {
      setErro(problema.message);
      setEnviando(false);
    }
  };

  return (
    <div className={`auth-shell${entradaContinua ? ' entrada-continua' : ''}`}>
      <div className="auth-card">
        <MarcaMci largura={168} className="marca-na-entrada" />
        <span className="eyebrow">MCI Platform</span>
        <h1>{t('login.entrar')}</h1>
        <p>Campeonato Brasileiro Muscle Contest</p>

        <form onSubmit={enviar}>
          <Field label={t('login.email')} required>
            <input type="email" value={form.email} onChange={evento => setForm({ ...form, email: evento.target.value })} required autoComplete="email" />
          </Field>
          <Field label={t('login.senha')} required>
            <input
              type="password"
              value={form.password}
              onChange={evento => setForm({ ...form, password: evento.target.value })}
              required
              minLength={8}
              autoComplete="current-password"
            />
          </Field>

          {/* role="alert" para que o leitor de tela anuncie a recusa: sem ele,
              quem não enxerga a tela fica sem saber por que o envio não passou. */}
          {erro && <div className="alert alert-erro" role="alert" style={{ marginBottom: 14 }}><div><strong>{erro}</strong></div></div>}

          <button type="submit" className="button button-primary" style={{ width: '100%' }} disabled={enviando}>
            {enviando ? t('estado.aguarde') : t('login.entrar')}
          </button>
        </form>

        <div className="auth-foot">
          <span>{t('login.semConta')}</span>
          <button
            type="button"
            className="button button-ghost button-sm link-inline"
            onClick={() => { setModo('registro'); setErro(null); }}
          >
            {t('login.criarConta')}
          </button>
        </div>
      </div>
    </div>
  );
}

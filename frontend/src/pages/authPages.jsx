import { useState } from 'react';
import { useAuth } from '../AuthContext';
import { Field, MarcaMci } from '../components/ui';
import ParedeDePatrocinio from '../components/paredeDePatrocinio';
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
//
// A APRESENTAÇÃO MUDOU; A AUTENTICAÇÃO NÃO
//
// Esta tela ganhou marca, título, parede de patrocínio e dois controles novos.
// A rota continua `/auth/login`, o corpo enviado continua `{ email, password }`,
// e quem decide se a credencial vale continua sendo o servidor. "Lembrar de
// mim" NÃO vai para o servidor: é só o destino do token no navegador.

export default function Auth({ entradaContinua = false }) {
  const { t } = useIdioma();
  const { login } = useAuth();
  const [modo, setModo] = useState('login');
  const [form, setForm] = useState({ email: '', password: '' });
  const [lembrar, setLembrar] = useState(true);
  const [recuperando, setRecuperando] = useState(false);
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
      await login({ email: form.email, password: form.password, lembrar });
    } catch (problema) {
      setErro(problema.message);
      setEnviando(false);
    }
  };

  return (
    <div className={`auth-shell auth-arena${entradaContinua ? ' entrada-continua' : ''}`}>
      <div className="arena-palco">
        {/* A ordem no DOM é a ordem no telefone: marca, título, formulário.
            No desktop o CSS põe as duas primeiras à esquerda e o cartão à
            direita, sem mexer na ordem de leitura nem na de tabulação. */}
        <div className="arena-marca">
          <div className="arena-chancela">
            <MarcaMci largura={132} />
            <div className="arena-chancela-txt">
              <b>{t('login.chancela')}</b>
              <span>{t('login.desde')}</span>
            </div>
          </div>
          <div className="arena-titulo">
            <p className="linha1">{t('login.tituloLinha1')}</p>
            <p className="linha2">{t('login.tituloLinha2')}</p>
          </div>
          <div className="arena-lema"><i /><span>{t('login.lema')}</span><i /></div>
        </div>

        <div className="auth-card">
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

            <div className="auth-linha-apoio">
              {/* O rótulo ENVOLVE a caixa: o alvo de toque passa a ser a linha
                  inteira, e não um quadrado de 17px que ninguém acerta no
                  telefone. */}
              <label className="auth-lembrar">
                <input
                  type="checkbox"
                  checked={lembrar}
                  onChange={evento => setLembrar(evento.target.checked)}
                />
                {t('login.lembrarDeMim')}
              </label>
              <button
                type="button"
                className="auth-esqueci"
                aria-expanded={recuperando}
                onClick={() => setRecuperando(valor => !valor)}
              >
                {t('login.esqueciSenha')}
              </button>
            </div>

            {/* ESTE PAINEL DIZ A VERDADE, E É DE PROPÓSITO.
                Não há provedor de envio configurado, não há rota de
                redefinição e não há tabela de token no projeto — conferido por
                busca no código. Um botão que abrisse um formulário de "enviar
                link" mandaria a pessoa esperar um e-mail que nunca chega. */}
            {recuperando && (
              <div className="auth-recuperar" role="region" aria-label={t('login.recuperarTitulo')}>
                <p><b>{t('login.recuperarTitulo')}</b></p>
                <p>{t('login.recuperarComo')}</p>
                <p>{t('login.recuperarPorQue')}</p>
              </div>
            )}

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

      {/* A parede fica por último em qualquer largura: é contexto, não é o que
          a pessoa veio fazer aqui. */}
      <ParedeDePatrocinio />
    </div>
  );
}

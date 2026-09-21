import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext';
import { Field, MarcaMci } from '../components/ui';
import { buscarCep, MENSAGEM_DO_CEP } from '../lib/cep';
import {
  mascararTelefone, mascararCep, digitos, UFS, PAPEIS_ABERTOS,
  errosDaEtapa, corpoDoCadastro
} from '../lib/formulario';
import { useIdioma, TextoRico } from '../lib/idioma';

// ============================================================================
// CADASTRO COMPLETO — assistente de 5 etapas.
//
// Por que 5 telas e não um formulário só: são 14 campos. Numa tela única, o
// primeiro erro aparece a 14 campos de distância de onde a pessoa está, e no
// celular ela nem vê que errou. Cada etapa valida O QUE ELA MOSTRA.
//
// O QUE ESTA TELA NÃO FAZ, de propósito:
//
//  - Não pede CPF. Nem de atleta. O CPF é pedido na SOLICITAÇÃO de perfil de
//    atleta, em "Minha solicitação", depois de a conta existir. Duas razões,
//    as duas medidas: (1) o servidor RECUSA cadastro que traga CPF — não há
//    onde guardá-lo antes de existir um atleta; (2) a lista de entidades de
//    filiação vem de `GET /affiliations`, que EXIGE autenticação. Pedir CPF
//    aqui obrigaria a carregá-lo pela travessia do login — documento parado em
//    armazenamento de navegador — para contornar uma rota autenticada. Não.
//
//  - Não decide nível de acesso. O perfil escolhido é como a pessoa aparece na
//    plataforma. Função de operação é concessão da organização, com auditoria.
// ============================================================================

// As etapas em CHAVES: o rótulo do passo e o título da tela saem do
// dicionário, e a lista guarda só a ordem.
const ETAPAS = ['cadastro.etapa1', 'cadastro.etapa2', 'cadastro.etapa3', 'cadastro.etapa4', 'cadastro.etapa5'];

const TOTAL = ETAPAS.length;

const INICIAL = {
  name: '', birthDate: '', role: 'ATHLETE',
  email: '', password: '', phone: '', whatsapp: '',
  postalCode: '', addressLine: '', addressNumber: '', addressComplement: '', state: '', city: ''
};

function Passos({ etapa }) {
  const { t } = useIdioma();

  return (
    <ol className="passos" aria-label={t('cadastro.etapaDe', { atual: etapa, total: TOTAL })}>
      {ETAPAS.map((chave, indice) => {
        const numero = indice + 1;
        const estado = numero < etapa ? 'feito' : numero === etapa ? 'atual' : 'futuro';
        return (
          <li key={chave} className={`passo is-${estado}`} aria-current={numero === etapa ? 'step' : undefined}>
            <span className="passo-bolha">{numero < etapa ? '✓' : numero}</span>
            <span className="passo-rotulo">{t(chave)}</span>
          </li>
        );
      })}
    </ol>
  );
}

// O erro fica COLADO no campo e é ligado a ele por aria-describedby: um resumo
// no topo obriga quem usa leitor de tela a caçar o campo correspondente.
// `texto` é uma CHAVE de tradução vinda da validação, e não uma frase. Ver o
// comentário em `lib/formulario.js`.
function Erro({ id, texto }) {
  const { t } = useIdioma();

  if (!texto) return null;
  return <small id={id} className="campo-erro" role="alert">{t(texto)}</small>;
}

export default function CadastroWizard({ aoVoltarParaEntrada }) {
  const { t } = useIdioma();
  const { register } = useAuth();
  const [etapa, setEtapa] = useState(1);
  const [form, setForm] = useState(INICIAL);
  const [erros, setErros] = useState({});
  const [erroGeral, setErroGeral] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [cep, setCep] = useState({ estado: 'parado', mensagem: null });

  const titulo = useRef(null);
  // `enviado` trava o envio DUPLO por fora do estado: `setEnviando` é
  // assíncrono, e dois cliques rápidos no mesmo quadro leriam `enviando`
  // ainda falso e criariam duas contas.
  const enviado = useRef(false);
  const ultimoCepBuscado = useRef('');

  const campo = (nome, valor) => {
    setForm(anterior => ({ ...anterior, [nome]: valor }));
    // O erro some assim que a pessoa mexe no campo: mantê-lo enquanto ela
    // corrige é acusar algo que talvez já não seja verdade.
    setErros(anteriores => (anteriores[nome] ? { ...anteriores, [nome]: undefined } : anteriores));
  };

  // Foco no título a cada etapa. Sem isso o foco continua no botão "Continuar"
  // da tela anterior e quem navega por teclado recomeça do rodapé.
  useEffect(() => { titulo.current?.focus(); }, [etapa]);

  const eAtleta = form.role === 'ATHLETE';

  // ---- CEP -----------------------------------------------------------------
  // A consulta dispara ao COMPLETAR 8 dígitos, e não a cada tecla: o ViaCEP
  // não é nosso e não se bombardeia serviço de terceiro a cada caractere.
  const consultarCep = async valor => {
    const limpo = digitos(valor);
    if (limpo.length !== 8 || limpo === ultimoCepBuscado.current) return;
    ultimoCepBuscado.current = limpo;

    setCep({ estado: 'buscando', mensagem: null });
    const resultado = await buscarCep(limpo);

    if (resultado.situacao !== 'encontrado') {
      // Serviço fora NÃO trava o cadastro: a pessoa preenche à mão. Por isso
      // nenhum destes casos marca erro no campo — só informa.
      setCep({ estado: resultado.situacao, mensagem: MENSAGEM_DO_CEP[resultado.situacao] });
      return;
    }

    setCep({ estado: 'encontrado', mensagem: null });
    setForm(anterior => ({
      ...anterior,
      // O que a pessoa já digitou à mão não é sobrescrito pela consulta.
      addressLine: anterior.addressLine.trim() || resultado.endereco.addressLine,
      city: anterior.city.trim() || resultado.endereco.city,
      state: anterior.state.trim() || resultado.endereco.state
    }));
    setErros(anteriores => ({ ...anteriores, addressLine: undefined, city: undefined, state: undefined }));
  };

  // ---- navegação -----------------------------------------------------------
  const avancar = () => {
    const encontrados = errosDaEtapa(etapa, form);
    if (Object.keys(encontrados).length) {
      setErros(encontrados);
      return;
    }
    setErros({});
    setEtapa(atual => Math.min(atual + 1, TOTAL));
  };

  const voltar = () => {
    setErros({});
    setErroGeral(null);
    setEtapa(atual => Math.max(atual - 1, 1));
  };

  const enviar = async evento => {
    evento.preventDefault();
    if (enviado.current) return;

    // Revalida TODAS as etapas antes de enviar. A validação por etapa é
    // conveniência de navegação, não garantia: quem voltou e apagou um campo
    // chegaria aqui com o formulário incompleto.
    for (let numero = 1; numero <= TOTAL; numero += 1) {
      const encontrados = errosDaEtapa(numero, form);
      if (Object.keys(encontrados).length) {
        setErros(encontrados);
        setEtapa(numero);
        return;
      }
    }

    enviado.current = true;
    setEnviando(true);
    setErroGeral(null);

    try {
      await register(corpoDoCadastro(form));
      // Não há navegação daqui: criar a conta autentica a sessão, e a
      // aplicação troca a tela de entrada pelo painel sozinha.
    } catch (problema) {
      enviado.current = false;
      setEnviando(false);
      setErroGeral(problema.message);
      // 409 é e-mail já cadastrado: o campo está na etapa 2, e deixar a pessoa
      // na revisão com um erro sobre um campo que ela não vê é um beco.
      if (problema.status === 409) {
        setErros({ email: 'cadastro.emailJaCadastrado' });
        setEtapa(2);
      }
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card auth-card-larga">
        <MarcaMci largura={148} className="marca-na-entrada" />
        <span className="eyebrow">MCI Platform · {t('cadastro.etapaDe', { atual: etapa, total: TOTAL })}</span>
        <h1 tabIndex={-1} ref={titulo}>{t(`${ETAPAS[etapa - 1]}.titulo`)}</h1>

        <Passos etapa={etapa} />

        <form onSubmit={etapa === TOTAL ? enviar : evento => { evento.preventDefault(); avancar(); }} noValidate>
          {etapa === 1 && (
            <>
              <Field label={t('cadastro.nomeCompleto')} required>
                <input
                  value={form.name} onChange={e => campo('name', e.target.value)}
                  maxLength={120} autoComplete="name" autoFocus
                  aria-invalid={!!erros.name} aria-describedby={erros.name ? 'erro-name' : undefined}
                />
              </Field>
              <Erro id="erro-name" texto={erros.name} />

              <Field label={t('cadastro.dataDeNascimento')} required>
                <input
                  type="date" value={form.birthDate} onChange={e => campo('birthDate', e.target.value)}
                  autoComplete="bday"
                  aria-invalid={!!erros.birthDate} aria-describedby={erros.birthDate ? 'erro-birthDate' : undefined}
                />
              </Field>
              <Erro id="erro-birthDate" texto={erros.birthDate} />

              <Field label={t('cadastro.voceE')} required hint={t('cadastro.voceEHint')}>
                <select value={form.role} onChange={e => campo('role', e.target.value)}>
                  {PAPEIS_ABERTOS.map(codigo => <option key={codigo} value={codigo}>{t(`papel.${codigo}`)}</option>)}
                </select>
              </Field>
              <p className="muted" style={{ marginTop: -2 }}>
                {t(`papel.${form.role}.descricao`)}
              </p>
            </>
          )}

          {etapa === 2 && (
            <>
              <Field label={t('cadastro.email')} required>
                <input
                  type="email" value={form.email} onChange={e => campo('email', e.target.value)}
                  autoComplete="email" autoFocus
                  aria-invalid={!!erros.email} aria-describedby={erros.email ? 'erro-email' : undefined}
                />
              </Field>
              <Erro id="erro-email" texto={erros.email} />

              <Field label={t('cadastro.senha')} required hint={t('cadastro.senhaHint')}>
                <input
                  type="password" value={form.password} onChange={e => campo('password', e.target.value)}
                  autoComplete="new-password"
                  aria-invalid={!!erros.password} aria-describedby={erros.password ? 'erro-password' : undefined}
                />
              </Field>
              <Erro id="erro-password" texto={erros.password} />

              <div className="grade-dupla">
                <div>
                  <Field label={t('cadastro.telefone')} required>
                    <input
                      inputMode="numeric" value={form.phone}
                      onChange={e => campo('phone', mascararTelefone(e.target.value))}
                      autoComplete="tel-national" placeholder="(65) 99999-0000"
                      aria-invalid={!!erros.phone} aria-describedby={erros.phone ? 'erro-phone' : undefined}
                    />
                  </Field>
                  <Erro id="erro-phone" texto={erros.phone} />
                </div>
                <div>
                  <Field label={t('cadastro.whatsapp')} required>
                    <input
                      inputMode="numeric" value={form.whatsapp}
                      onChange={e => campo('whatsapp', mascararTelefone(e.target.value))}
                      placeholder="(65) 99999-0000"
                      aria-invalid={!!erros.whatsapp} aria-describedby={erros.whatsapp ? 'erro-whatsapp' : undefined}
                    />
                  </Field>
                  <Erro id="erro-whatsapp" texto={erros.whatsapp} />
                </div>
              </div>

              <button
                type="button" className="button button-ghost button-sm"
                onClick={() => campo('whatsapp', form.phone)}
                disabled={!form.phone}
              >
                {t('cadastro.mesmoNumero')}
              </button>
            </>
          )}

          {etapa === 3 && (
            <>
              <Field label={t('cadastro.cep')} required hint={t('cadastro.cepHint')}>
                <input
                  inputMode="numeric" value={form.postalCode} autoFocus
                  onChange={e => {
                    const valor = mascararCep(e.target.value);
                    campo('postalCode', valor);
                    consultarCep(valor);
                  }}
                  autoComplete="postal-code" placeholder="78000-000"
                  aria-invalid={!!erros.postalCode} aria-describedby={erros.postalCode ? 'erro-postalCode' : undefined}
                />
              </Field>
              <Erro id="erro-postalCode" texto={erros.postalCode} />
              {/* aria-live: a pessoa precisa saber que a busca aconteceu mesmo
                  sem enxergar o campo mudar de cor. */}
              <p className="muted" aria-live="polite" style={{ marginTop: -2 }}>
                {cep.estado === 'buscando' ? t('cadastro.buscandoEndereco') : cep.mensagem || ''}
              </p>

              <Field label={t('cadastro.endereco')} required>
                <input
                  value={form.addressLine} onChange={e => campo('addressLine', e.target.value)}
                  maxLength={200} autoComplete="street-address"
                  aria-invalid={!!erros.addressLine} aria-describedby={erros.addressLine ? 'erro-addressLine' : undefined}
                />
              </Field>
              <Erro id="erro-addressLine" texto={erros.addressLine} />

              <div className="grade-dupla">
                <div>
                  <Field label={t('cadastro.numero')} required>
                    <input
                      value={form.addressNumber} onChange={e => campo('addressNumber', e.target.value)}
                      maxLength={20}
                      aria-invalid={!!erros.addressNumber} aria-describedby={erros.addressNumber ? 'erro-addressNumber' : undefined}
                    />
                  </Field>
                  <Erro id="erro-addressNumber" texto={erros.addressNumber} />
                </div>
                <Field label={t('cadastro.complemento')}>
                  <input value={form.addressComplement} onChange={e => campo('addressComplement', e.target.value)} maxLength={80} />
                </Field>
              </div>

              <div className="grade-dupla">
                <div>
                  <Field label={t('cadastro.cidade')} required>
                    <input
                      value={form.city} onChange={e => campo('city', e.target.value)} maxLength={80}
                      aria-invalid={!!erros.city} aria-describedby={erros.city ? 'erro-city' : undefined}
                    />
                  </Field>
                  <Erro id="erro-city" texto={erros.city} />
                </div>
                <div>
                  <Field label={t('cadastro.uf')} required>
                    <select
                      value={form.state} onChange={e => campo('state', e.target.value)}
                      aria-invalid={!!erros.state} aria-describedby={erros.state ? 'erro-state' : undefined}
                    >
                      <option value="">—</option>
                      {UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}
                    </select>
                  </Field>
                  <Erro id="erro-state" texto={erros.state} />
                </div>
              </div>
            </>
          )}

          {etapa === 4 && (
            <div className="painel-informativo">
              {eAtleta ? (
                <>
                  <h2>{t('cadastro.filiacaoTitulo')}</h2>
                  <p>{t('cadastro.filiacaoTexto')}</p>
                  <p className="muted"><TextoRico chave="cadastro.filiacaoProximoPasso" /></p>
                  <p className="muted">{t('cadastro.cpfDepois')}</p>
                </>
              ) : (
                <>
                  <h2>{t('cadastro.semMaisNada')}</h2>
                  <p><TextoRico chave="cadastro.semMaisNadaTexto" valores={{ papel: t(`papel.${form.role}`) }} /></p>
                  <p className="muted">{t('cadastro.funcoesDeOperacao')}</p>
                </>
              )}
            </div>
          )}

          {etapa === 5 && (
            <div className="revisao">
              <p className="muted">{t('cadastro.confiraOsDados')}</p>
              <Revisao form={form} aoEditar={setEtapa} />
            </div>
          )}

          {erroGeral && (
            <div className="alert alert-erro" role="alert" style={{ marginBottom: 14 }}>
              <div><strong>{erroGeral}</strong></div>
            </div>
          )}

          <div className="acoes-do-passo">
            {etapa > 1
              ? <button type="button" className="button button-ghost" onClick={voltar} disabled={enviando}>{t('acao.voltar')}</button>
              : <button type="button" className="button button-ghost" onClick={aoVoltarParaEntrada}>{t('cadastro.jaTenhoConta')}</button>}

            <button type="submit" className="button button-primary" disabled={enviando}>
              {t(etapa < TOTAL ? 'cadastro.continuar' : enviando ? 'cadastro.enviando' : 'login.criarConta')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// A revisão é só leitura, com um atalho para a etapa de origem de cada bloco:
// achar o erro e não ter como voltar direto nele é o que faz a pessoa desistir
// na última tela.
function Revisao({ form, aoEditar }) {
  const { t } = useIdioma();
  const endereco = [
    `${form.addressLine}, ${form.addressNumber}`,
    form.addressComplement,
    `${form.city} — ${String(form.state).toUpperCase()}`,
    form.postalCode
  ].filter(Boolean).join(' · ');

  const blocos = [
    [1, t('cadastro.revisaoIdentidade'), [
      [t('cadastro.revisaoNome'), form.name],
      [t('cadastro.revisaoNascimento'), form.birthDate],
      [t('cadastro.revisaoPerfil'), t(`papel.${form.role}`)]
    ]],
    [2, t('cadastro.revisaoContato'), [
      [t('cadastro.email'), form.email],
      [t('cadastro.senha'), '••••••••'],
      [t('cadastro.telefone'), form.phone],
      [t('cadastro.whatsapp'), form.whatsapp]
    ]],
    [3, t('cadastro.revisaoEndereco'), [[t('cadastro.endereco'), endereco]]]
  ];

  return (
    <dl className="lista-revisao">
      {blocos.map(([numero, titulo, linhas]) => (
        <div key={titulo} className="bloco-revisao">
          <div className="bloco-revisao-topo">
            <h3>{titulo}</h3>
            <button type="button" className="button button-ghost button-sm" onClick={() => aoEditar(numero)}>
              {t('cadastro.editar')}
            </button>
          </div>
          {linhas.map(([rotulo, valor]) => (
            <div key={rotulo} className="linha-revisao">
              <dt>{rotulo}</dt>
              <dd>{valor || '—'}</dd>
            </div>
          ))}
        </div>
      ))}
    </dl>
  );
}

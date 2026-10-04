import { useEffect, useState } from 'react';
import { IdCard, Image as ImageIcon, Lock } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Badge, EmptyState, Field, PageHead } from '../components/ui';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// MEU CADASTRO.
//
// A tela onde o atleta COMPLETA o que falta no próprio cadastro — e onde ele
// vê, sem poder reescrever, o que identifica oficialmente a pessoa.
//
// O QUE ELA NÃO FAZ, E POR QUE ISSO É O PONTO
//
// Ela não deixa o atleta mudar a entidade de filiação, o número de filiação
// nem o número de atleta. Não por capricho de interface: o par
// (entidade, número de filiação) é a identidade pela qual o resultado oficial
// reconhece a pessoa. Atleta que editasse o próprio número poderia se
// apropriar do histórico de outro. A recusa já existe no servidor —
// `athleteService.update` descarta esses campos quando quem edita é o dono
// sem permissão de operador —, e a tela apenas DIZ isso em palavras, em vez de
// oferecer um campo que seria silenciosamente ignorado.
//
// A autoridade continua no servidor. Esconder o campo é honestidade com quem
// preenche, não segurança: os testes provam a recusa pela API, e não por aqui.
//
// DOIS NÚMEROS, DUAS COISAS
//
// "Número de filiação" e "número de atleta" não são sinônimos, e a tela
// explica a diferença onde ela importa. O primeiro identifica o atleta dentro
// da entidade; o segundo é operacional — credenciamento, chamada de palco. Os
// dois NÃO são replicados um no outro: `affiliationNumber` é único por
// (organização, filiação, número) e `athleteNumber` é único por (organização,
// número), sem a filiação. Copiar um no outro faria NPC+2932 e IFBB+2932
// colidirem, e a segunda pessoa — legítima — seria recusada.
//
// A rota de leitura é `/me/cadastro`: não aceita identificador de pessoa, e o
// backend deriva o atleta do token. Não há id para esta tela passar errado.
// A ESCRITA é `PATCH /athletes/:id`, a mesma de sempre, com o id que veio na
// própria resposta — é lá que a regra de campo restrito mora.
// ==========================================================================

// Os campos que o atleta edita, na ordem em que a tela pergunta. A LISTA
// AUTORITATIVA é a do servidor (`dados.campos`): esta aqui só diz como cada
// campo é desenhado. Se o servidor parar de oferecer um deles, ele desaparece
// da tela sem ninguém precisar lembrar de apagá-lo daqui.
const DESENHO_DO_CAMPO = Object.freeze({
  fullName: { rotulo: 'atleta.nomeCompleto', tipo: 'text', obrigatorio: true, min: 2, max: 160 },
  stageName: { rotulo: 'atleta.nomeEsportivo', tipo: 'text', max: 80 },
  birthDate: { rotulo: 'atleta.nascimento', tipo: 'date' },
  city: { rotulo: 'atleta.cidade', tipo: 'text', min: 2, max: 90 },
  state: { rotulo: 'atleta.estadoUf', tipo: 'text', min: 2, max: 2 },
  phone: { rotulo: 'atleta.telefone', tipo: 'tel', min: 8, max: 20 },
  email: { rotulo: 'atleta.email', tipo: 'email', max: 180 }
});

// VAZIO VIRA NULO, E NÃO STRING EM BRANCO.
//
// O schema do servidor trata os opcionais como `texto(min, max).nullable()`:
// uma cidade com `''` reprova por tamanho mínimo, e a pessoa levaria um 422
// por ter APAGADO um campo que podia ficar em branco. Nulo é "não informado",
// que é exatamente o que ela quis dizer.
const paraOServidor = form => {
  const payload = {};
  for (const [campo, valor] of Object.entries(form)) {
    const texto = String(valor ?? '').trim();
    payload[campo] = texto === '' ? null : texto;
  }
  return payload;
};

export default function MeuCadastro({ notificar, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.me.cadastro(), []);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('carreira.meuEspaco')}
        title={t('meuCadastro.titulo')}
        description={t('meuCadastro.descricao')}
      />

      <AsyncSection state={estado} linhas={4}>
        {dados => {
          if (!dados.athlete) {
            return (
              <EmptyState
                title={t('carreira.semPerfil')}
                description={t('carreira.semPerfilDescricao')}
              />
            );
          }

          return (
            <>
              <IdentidadeEsportiva identidade={dados.identidade} organizacao={dados.organization} />
              <Complemento dados={dados} notificar={notificar} recarregar={estado.reload} />
              <Foto navegar={navegar} />
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

// SOMENTE LEITURA, E A TELA DIZ ISSO EM PALAVRAS.
//
// Um campo desabilitado sem explicação parece defeito. Aqui o bloco inteiro é
// leitura, com o cadeado à vista e a frase que diz quem muda: a federação.
function IdentidadeEsportiva({ identidade, organizacao }) {
  const { t } = useIdioma();

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{t('meuCadastro.identidade')}</h2>
        <Badge tom="neutro"><Lock size={12} /> {t('meuCadastro.somenteLeitura')}</Badge>
      </div>

      <dl className="kv">
        <dt>{t('atleta.entidade')}</dt>
        <dd>{identidade?.affiliation?.name || t('meuCadastro.semFiliacao')}</dd>

        <dt>{t('atleta.numeroDeFiliacao')}</dt>
        <dd>{identidade?.affiliationNumber || '—'}</dd>

        <dt>{t('atleta.numeroDeAtleta')}</dt>
        <dd>{identidade?.athleteNumber || '—'}</dd>

        <dt>{t('atleta.cpf')}</dt>
        <dd>{identidade?.cpfMasked || '—'}</dd>
      </dl>

      <p className="hint" style={{ margin: '4px 0 0' }}>
        <IdCard size={14} style={{ verticalAlign: '-2px' }} />{' '}
        {t('atleta.numeroDeFiliacaoDica')}
      </p>
      <p className="hint" style={{ margin: '8px 0 0' }}>
        {t('atleta.numeroDeAtletaDica')}
      </p>
      <p className="hint" style={{ margin: '8px 0 0' }}>
        {t('meuCadastro.quemMuda', { organizacao: organizacao?.name || t('carreira.suaOrganizacao') })}
      </p>
    </section>
  );
}

// A FOTO NÃO É REFEITA AQUI.
//
// Ela já tem fluxo próprio, com normalização no aparelho, validação de MIME por
// assinatura de bytes e remoção. Construir um segundo envio nesta tela criaria
// duas fotos da mesma pessoa em dois lugares — e a pergunta "qual vale?" não
// tem resposta boa. Então esta seção APONTA para o fluxo que existe.
function Foto({ navegar }) {
  const { t } = useIdioma();

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head"><h2>{t('meuCadastro.foto')}</h2></div>
      <p className="hint" style={{ margin: '0 0 12px' }}>{t('meuCadastro.fotoDica')}</p>
      <button type="button" className="button button-secondary" onClick={() => navegar?.('perfil')}>
        <ImageIcon size={14} /> {t('meuCadastro.irParaAFoto')}
      </button>
    </section>
  );
}

function Complemento({ dados, notificar, recarregar }) {
  const { t } = useIdioma();
  const [form, setForm] = useState(() => ({ ...dados.editaveis }));
  const [salvando, setSalvando] = useState(false);

  // A RESPOSTA RECARREGADA MANDA NO FORMULÁRIO.
  //
  // Sem isto, salvar e recarregar deixava na tela o que foi digitado, e não o
  // que o servidor gravou — se ele normalizasse um valor (o e-mail em
  // minúsculas, por exemplo), a tela mentiria sobre o que está no banco.
  useEffect(() => { setForm({ ...dados.editaveis }); }, [dados.editaveis]);

  const campos = dados.campos.filter(campo => DESENHO_DO_CAMPO[campo]);
  const faltando = dados.faltando.filter(campo => DESENHO_DO_CAMPO[campo]);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.athletes.update(dados.athlete.id, paraOServidor(form));
      notificar(t('meuCadastro.salvo'));
      await recarregar();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-head">
        <h2>{t('meuCadastro.complete')}</h2>
        <Badge tom={faltando.length ? 'alerta' : 'ok'}>
          {faltando.length
            ? t('meuCadastro.faltam', { n: faltando.length })
            : t('meuCadastro.completo')}
        </Badge>
      </div>

      {faltando.length > 0 && (
        <div className="alert alert-alerta" style={{ marginBottom: 12 }}>
          <div>
            <strong>{t('meuCadastro.faltandoTitulo')}</strong>
            <p style={{ margin: '4px 0 0' }}>
              {faltando.map(campo => t(DESENHO_DO_CAMPO[campo].rotulo)).join(' · ')}
            </p>
          </div>
        </div>
      )}

      <form onSubmit={salvar}>
        <div className="grid grid-2">
          {campos.map(campo => {
            const desenho = DESENHO_DO_CAMPO[campo];
            return (
              <Field key={campo} label={t(desenho.rotulo)} required={desenho.obrigatorio}>
                <input
                  type={desenho.tipo}
                  value={form[campo] ?? ''}
                  onChange={evt => setForm(atual => ({ ...atual, [campo]: evt.target.value }))}
                  required={desenho.obrigatorio || undefined}
                  minLength={desenho.min}
                  maxLength={desenho.max}
                />
              </Field>
            );
          })}
        </div>

        <button type="submit" className="button button-primary" disabled={salvando} style={{ marginTop: 12 }}>
          {salvando ? t('meuCadastro.salvando') : t('meuCadastro.salvar')}
        </button>
      </form>
    </section>
  );
}

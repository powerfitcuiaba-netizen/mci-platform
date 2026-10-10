import { useEffect, useState } from 'react';
import { fetchMediaObjectUrl, refreshData } from '../services/api';
import { ACEITO_NO_SELETOR, CHAVE_DA_RECUSA, normalizarFotoDoAparelho } from '../lib/fotoDoAparelho';
import { useIdioma } from '../lib/idioma';
import { Badge, EmptyState, Field } from './ui';

// ============================================================================
// A FOTO DO ATLETA — o cartão que mostra, cobra e troca.
//
// POR QUE É UM COMPONENTE, E NÃO DUAS TELAS PARECIDAS
//
// Ele é montado em dois lugares com atores diferentes: o ATLETA, no Meu
// painel, enviando a própria foto; e o OPERADOR da federação, na ficha do
// atleta, enviando por quem não acessa a plataforma. O gesto é o mesmo, a
// recusa é a mesma, a normalização do arquivo é a mesma — o que muda é só qual
// chamada da API vai ao servidor, e isso entra por `enviar`.
//
// Duas cópias divergiriam na primeira correção: a conversão de HEIC entraria
// num lado e não no outro, e o atleta de iPhone seria recusado numa tela e
// aceito na outra.
//
// A IMAGEM É BUSCADA COM TOKEN e exposta como object URL. `<img src>` não manda
// cabeçalho, e token em query string acabaria em log de servidor, em histórico
// e no Referer. Mesmo desenho da foto do treinador e do avatar social.
//
// A CONVERSÃO ACONTECE ANTES DE SUBIR, e não é simetria com o cadastro: quem
// envia a foto depois costuma estar no celular, então é AQUI que o HEIC
// aparece mais. Deixar a conversão só no cadastro poria o 415 exatamente na
// tela de quem já é atleta.
// ============================================================================

export default function FotoDoAtleta({
  athleteId, temFoto, enviar, notificar, aoTrocar, titulo, dica
}) {
  const { t } = useIdioma();
  const [url, setUrl] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [recusa, setRecusa] = useState(null);

  useEffect(() => {
    if (!temFoto || !athleteId) { setUrl(null); return undefined; }
    let vivo = true;
    let endereco = null;

    fetchMediaObjectUrl(`/media/athletes/${athleteId}/photo`)
      .then(criado => {
        endereco = criado;
        if (vivo) setUrl(criado); else URL.revokeObjectURL(criado);
      })
      .catch(() => { if (vivo) setUrl(null); });

    return () => {
      vivo = false;
      if (endereco) URL.revokeObjectURL(endereco);
    };
  }, [athleteId, temFoto]);

  const aoEscolher = async arquivo => {
    if (!arquivo) return;
    setRecusa(null);

    // `enviando` cobre o PREPARO também: para quem está olhando, escolher a
    // foto e ela subir é um gesto só, e o campo fica indisponível do começo ao
    // fim dele.
    setEnviando(true);

    let pronta;
    try {
      pronta = await normalizarFotoDoAparelho(arquivo);
    } catch (problema) {
      setRecusa(problema.codigo ? t(CHAVE_DA_RECUSA[problema.codigo]) : problema.message);
      setEnviando(false);
      return;
    }

    try {
      await enviar(pronta);
      refreshData();
      notificar?.(t('atletaFoto.atualizada'), 'sucesso');
      aoTrocar?.();
    } catch (problema) {
      setRecusa(problema?.message || t('erro.generico'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3>{titulo ?? t('atletaFoto.titulo')}</h3>
        <Badge tom={temFoto ? 'sucesso' : 'atencao'}>
          {t(temFoto ? 'atletaFoto.naVitrine' : 'atletaFoto.foraDaVitrine')}
        </Badge>
      </div>

      {recusa && (
        <div className="alert alert-erro" role="alert">
          <div><p>{recusa}</p></div>
        </div>
      )}

      {/* A COBRANÇA, para quem foi cadastrado antes de a foto existir. Ela diz
          o que fazer E diz o que NÃO se perdeu — que é a parte que tira o
          susto. Ninguém está impedido de competir por não ter foto. */}
      {!temFoto && (
        <EmptyState title={t('atletaFoto.semFotoTitulo')} description={t('atletaFoto.semFotoComoResolver')} />
      )}

      {temFoto && url && (
        <img className="foto-do-atleta" src={url} alt={t('atletaFoto.atualAlt')} width={120} height={120} />
      )}

      <Field label={t(temFoto ? 'atletaFoto.trocar' : 'atletaFoto.enviar')} hint={dica ?? t('atletaFoto.dica')}>
        <input
          type="file"
          accept={ACEITO_NO_SELETOR}
          disabled={enviando}
          onChange={evento => aoEscolher(evento.target.files?.[0] ?? null)}
        />
      </Field>
    </section>
  );
}

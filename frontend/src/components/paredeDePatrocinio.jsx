import { useEffect, useState } from 'react';
import { useIdioma } from '../lib/idioma';
import Esteira from './esteira';
import Marca from './marcaDePatrocinio';
import { carregarPatrocinadores } from '../lib/catalogoDePatrocinio';
import { CATEGORIAS, CHAVE_DO_ROTULO, sentidoDaFaixa } from '../lib/patrocinadores';

// A parede de patrocínio da tela de entrada.
//
// Uma faixa por nível, cada uma correndo em esteira, em sentidos alternados.
// Tudo aqui é apresentação: nenhuma decisão de autorização ou de regra de
// negócio mora neste arquivo.
//
// AS MARCAS VÊM DO BANCO. Antes era uma lista versionada; agora é
// `/public/sponsors`, que devolve só quem está ATIVO. Desativar um
// patrocinador pela tela de administração o tira daqui sem deploy — que era o
// ponto de levar o catálogo para o banco.
//
// A MECÂNICA DO MOVIMENTO não mora aqui: medição de largura, contagem de
// cópias e duração do ciclo vivem em `components/esteira.jsx`, compartilhadas
// com o rodapé da vitrine.

export default function ParedeDePatrocinio() {
  const { t } = useIdioma();
  const [marcas, setMarcas] = useState(null);

  useEffect(() => {
    let vivo = true;
    carregarPatrocinadores().then(lista => { if (vivo) setMarcas(lista); });
    return () => { vivo = false; };
  }, []);

  // ENQUANTO CARREGA, NADA — e sem esqueleto. A parede é contexto, não é o que
  // a pessoa veio fazer na tela de entrada: um bloco cinza pulsando atrás do
  // formulário disputaria atenção com ele e empurraria o campo de e-mail para
  // baixo quando as artes chegassem. Catálogo vazio cai no mesmo caminho.
  if (!marcas?.length) return null;

  // Os níveis que de fato têm marca. Nível vazio não vira linha vazia.
  const porNivel = CATEGORIAS
    .map(nivel => ({ nivel, marcas: marcas.filter(m => m.level === nivel.toUpperCase()) }))
    .filter(faixa => faixa.marcas.length > 0);

  if (!porNivel.length) return null;

  return (
    <section className="parede-patro" aria-label={t('patrocinio.parede')}>
      {porNivel.map(({ nivel, marcas: doNivel }, indice) => (
        <div key={nivel} className={`faixa-patro t-${nivel}`}>
          <div className="faixa-patro-cab">
            <span>{t(CHAVE_DO_ROTULO[nivel])}</span>
            <i />
          </div>
          <Esteira
            itens={doNivel}
            chave={marca => marca.id}
            classeDoGrupo={`esteira-grupo-${nivel}`}
            sentido={sentidoDaFaixa(indice)}
            desenhar={(marca, ehClone) => <Marca patrocinador={marca} oculta={ehClone} />}
          />
        </div>
      ))}
    </section>
  );
}

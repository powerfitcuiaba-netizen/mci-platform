import { useEffect, useState } from 'react';
import { useIdioma } from '../lib/idioma';
import Esteira from './esteira';
import Marca from './marcaDePatrocinio';
import { carregarPatrocinadores } from '../lib/catalogoDePatrocinio';

// A FAIXA DE PATROCÍNIO DO RODAPÉ — a esteira da vitrine.
//
// A MESMA FONTE DA TELA DE ENTRADA, e isso é o ponto: as duas leem
// `/public/sponsors`, pelo mesmo módulo e pela MESMA requisição — o catálogo é
// buscado uma vez para o aplicativo inteiro. Não há segunda lista, não há
// segunda pasta, não há cópia de logo.
//
// POR QUE UMA FAIXA SÓ, E NÃO QUATRO
//
// A parede da entrada tem a página inteira e pode dar uma linha a cada nível.
// O rodapé divide a tela com ranking, tabela e ficha de atleta: quatro linhas
// ali seriam 300px de altura útil. Então é UMA esteira, com todas as marcas,
// na ordem que o servidor já devolveu — nível primeiro, depois a ordem dentro
// dele. A tela NÃO reordena nada: ordenar aqui seria a segunda fonte da
// hierarquia.
//
// A HIERARQUIA CONTINUA VISÍVEL porque a caixa de cada marca continua sendo a
// do seu nível, na escala do rodapé (`CAIXAS_DO_RODAPE`). A razão é menor —
// lado a lado numa faixa única, 10:1 pareceria defeito —, mas a ordem de
// tamanho NUNCA inverte, e há teste que reprova se inverter.
export default function FaixaDePatrocinio() {
  const { t } = useIdioma();
  const [marcas, setMarcas] = useState(null);

  useEffect(() => {
    let vivo = true;
    carregarPatrocinadores().then(lista => { if (vivo) setMarcas(lista); });
    return () => { vivo = false; };
  }, []);

  // SEM MARCAS, SEM FAIXA — e o mesmo vale enquanto carrega. Um rodapé vazio
  // ocuparia altura para não dizer nada, e reservá-la antes de saber se há
  // marca empurraria o conteúdo quando a resposta chegasse.
  if (!marcas?.length) return null;

  return (
    <footer className="rodape-patro" aria-label={t('patrocinio.parede')}>
      <div className="rodape-patro-cab">
        <span>{t('patrocinio.parede')}</span>
        <i />
      </div>
      <Esteira
        itens={marcas}
        chave={marca => marca.id}
        classeDoGrupo="esteira-grupo-rodape"
        desenhar={(marca, ehClone) => (
          <Marca
            patrocinador={marca}
            oculta={ehClone}
            // Atrás do conteúdo que a pessoa veio ler. Ver a nota em
            // `marcaDePatrocinio.jsx`.
            prioridade="low"
          />
        )}
      />
    </footer>
  );
}

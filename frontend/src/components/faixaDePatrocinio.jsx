import { useIdioma } from '../lib/idioma';
import Esteira from './esteira';
import Marca from './marcaDePatrocinio';
import { CATEGORIAS_COM_PASTILHA, marcasNaOrdemDaHierarquia } from '../lib/patrocinadores';

// A FAIXA DE PATROCÍNIO DO RODAPÉ — a esteira da vitrine.
//
// A MESMA FONTE DA TELA DE ENTRADA, e isso é o ponto.
//
// As marcas saem de `lib/patrocinadores.js`, que é a única lista do produto —
// a mesma que a parede da entrada consome, com os mesmos arquivos em
// `public/patrocinadores/`. Não há segunda lista, não há segunda pasta, não há
// cópia de logo. Entrar ou sair uma marca de lá muda as duas telas de uma vez.
//
// POR QUE UMA FAIXA SÓ, E NÃO QUATRO
//
// A parede da entrada tem a página inteira e pode dar uma linha a cada cota. O
// rodapé divide a tela com ranking, tabela e ficha de atleta: quatro linhas ali
// seriam 300px de altura útil. Então é UMA esteira, com todas as marcas, na
// ordem da hierarquia comercial — Global primeiro, Silver por último.
//
// A HIERARQUIA CONTINUA VISÍVEL porque a caixa de cada marca continua sendo a
// da sua cota, só que na escala do rodapé (`CAIXAS_DO_RODAPE`). A razão entre
// as cotas é menor — lado a lado numa faixa única, 10:1 pareceria defeito —,
// mas a ordem de tamanho NUNCA inverte, e há teste que reprova se inverter.
//
// O MOVIMENTO É O DA `Esteira`: cópias medidas, emenda em cima de si mesma,
// velocidade constante em pixels por segundo. Nada de `setInterval`, nada de
// estado de React por quadro — a animação é do CSS, em `transform`, e o React
// não re-renderiza enquanto ela corre.
export default function FaixaDePatrocinio() {
  const { t } = useIdioma();
  const marcas = marcasNaOrdemDaHierarquia();

  // SEM MARCAS, SEM FAIXA. Um rodapé vazio ocuparia altura para não dizer nada.
  if (!marcas.length) return null;

  return (
    <footer className="rodape-patro" aria-label={t('patrocinio.parede')}>
      <div className="rodape-patro-cab">
        <span>{t('patrocinio.parede')}</span>
        <i />
      </div>
      <Esteira
        itens={marcas}
        chave={marca => marca.arquivo}
        classeDoGrupo="esteira-grupo-rodape"
        desenhar={(marca, ehClone) => (
          <Marca
            marca={marca}
            pastilha={CATEGORIAS_COM_PASTILHA.includes(marca.categoria)}
            oculta={ehClone}
            // A cota vai na própria caixa: a faixa é uma só, e é daqui que sai
            // a escala de cada marca.
            classe={`t-${marca.categoria}`}
            // Atrás do conteúdo que a pessoa veio ler. Ver a nota em
            // `marcaDePatrocinio.jsx`.
            prioridade="low"
          />
        )}
      />
    </footer>
  );
}

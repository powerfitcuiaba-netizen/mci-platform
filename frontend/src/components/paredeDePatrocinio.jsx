import { useIdioma } from '../lib/idioma';
import Esteira from './esteira';
import Marca from './marcaDePatrocinio';
import {
  CATEGORIAS_COM_PASTILHA,
  CHAVE_DO_ROTULO,
  categoriasComMarcas,
  marcasDaCategoria,
  sentidoDaFaixa
} from '../lib/patrocinadores';

// A parede de patrocínio da tela de entrada.
//
// Uma faixa por categoria, cada uma correndo em esteira, em sentidos
// alternados. Tudo aqui é apresentação: nenhuma decisão de autorização ou de
// regra de negócio mora neste arquivo.
//
// A MECÂNICA DO MOVIMENTO NÃO MORA MAIS AQUI. Medição de largura, contagem de
// cópias e duração do ciclo vivem em `components/esteira.jsx`, porque o rodapé
// da vitrine passou a usar a mesma coisa. Duas cópias dessa conta divergiriam
// no primeiro ajuste — e ela já saiu errada uma vez.

function Faixa({ categoria, indice }) {
  const { t } = useIdioma();
  const marcas = marcasDaCategoria(categoria);
  const pastilha = CATEGORIAS_COM_PASTILHA.includes(categoria);

  if (!marcas.length) return null;

  return (
    <div className={`faixa-patro t-${categoria}`}>
      <div className="faixa-patro-cab">
        <span>{t(CHAVE_DO_ROTULO[categoria])}</span>
        <i />
      </div>
      <Esteira
        itens={marcas}
        chave={marca => marca.arquivo}
        classeDoGrupo={`esteira-grupo-${categoria}`}
        sentido={sentidoDaFaixa(indice)}
        desenhar={(marca, ehClone) => (
          <Marca marca={marca} pastilha={pastilha} oculta={ehClone} />
        )}
      />
    </div>
  );
}

/**
 * A parede inteira.
 *
 * Com `prefers-reduced-motion` nenhuma faixa anda: viram listas estáticas com
 * TODAS as marcas visíveis. Uma parede de patrocínio não pode depender de
 * animação para ser vista — quem liga a preferência precisa enxergar todo mundo,
 * não um trecho. O CSS cuida disso; aqui o componente só não atrapalha.
 */
export default function ParedeDePatrocinio() {
  const { t } = useIdioma();
  const categorias = categoriasComMarcas();
  if (!categorias.length) return null;

  return (
    <section className="parede-patro" aria-label={t('patrocinio.parede')}>
      {categorias.map((categoria, indice) => (
        <Faixa key={categoria} categoria={categoria} indice={indice} />
      ))}
    </section>
  );
}

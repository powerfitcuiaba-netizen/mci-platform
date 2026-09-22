'use strict';

const { createHash } = require('node:crypto');

// ============================================================================
// A CLASSE COMO ENTIDADE: NOME DE APRESENTAÇÃO, CÓDIGO TÉCNICO, E DONO.
//
// "Women's Physique - Masters 35+" são três informações numa string:
//
//   categoria  WOMENS_PHYSIQUE   já resolvida pelo adaptador, contra um mapa
//                                explícito — nunca por transformação de texto
//   divisão    Masters           é ela que responde a elegibilidade ao Super
//                                Overall, contra o catálogo da organização
//   classe     Masters 35+       o recorte em que o atleta efetivamente
//                                competiu, e que o ranking precisa filtrar
//
// Este arquivo cuida da TERCEIRA. Ele não recalcula a categoria e não mexe na
// elegibilidade: as duas continuam exatamente onde estavam, e é por isso que
// esta fase não altera um ponto sequer do que já foi pontuado.
//
// DUAS REPRESENTAÇÕES, E NENHUMA SUBSTITUI A OUTRA
//
//   displayName   "Masters 35+"   o texto COMO A ORIGEM ESCREVEU. É o que a
//                                 tela mostra. Nunca é derivado de volta do
//                                 código: "MASTERS_35" não vira "Masters 35+"
//                                 sem adivinhar onde estava o "+".
//   code          "MASTERS_35"    identidade técnica. É por ele que a classe
//                                 é reencontrada, e é ele que a unicidade
//                                 protege.
// ============================================================================

// Comprimento máximo do código. Acima disso o nome inteiro não cabe, e cortar
// em silêncio faria duas classes longas e diferentes virarem o mesmo código —
// uma duplicata invisível, que é exatamente o que a resolução idempotente
// existe para impedir. Ver `normalizarCodigoDeClasse`.
const MAXIMO_DO_CODIGO = 60;

/**
 * "Masters 35+" -> "MASTERS_35"; "Open Class A" -> "OPEN_CLASS_A".
 *
 * Maiúsculas, sem acento, e tudo que não for letra ou dígito vira separador.
 * O "+" de "35+" não sobrevive como caractere — sobrevive no `displayName`,
 * que é onde ele significa alguma coisa.
 */
function normalizarCodigoDeClasse(texto) {
  const base = String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!base) return null;
  if (base.length <= MAXIMO_DO_CODIGO) return base;

  // NOME LONGO DEMAIS: CORTAR SIM, EM SILÊNCIO NÃO.
  //
  // O sufixo é determinístico — mesma entrada, mesmo código, sempre —, então
  // a resolução continua idempotente; e ele é derivado do nome INTEIRO, então
  // dois nomes que só diferem depois do corte não colidem.
  const digest = createHash('sha256').update(base).digest('hex').slice(0, 12);
  return `${base.slice(0, MAXIMO_DO_CODIGO - 13).replace(/_+$/, '')}_${digest}`;
}

/**
 * O nome da classe como a origem escreveu.
 *
 * A fonte preferida é o LADO DIREITO do texto original: em
 * "Women's Bikini - Open Class A" a classe é "Open Class A", com o "Class"
 * que o operador vê na planilha. Recompor a partir da decomposição daria
 * "Open A", porque o adaptador tira o rótulo "Class" ao extrair o recorte —
 * correto para o rótulo, errado para o nome.
 *
 * A recomposição entra só quando não há texto composto: arquivo cuja coluna
 * de classe já vem simples ("OPEN"), onde não há lado direito nenhum.
 */
function nomeDeExibicaoDaClasse({ className = null, divisionName = null, classLabel = null } = {}) {
  const inteiro = String(className ?? '').trim();
  if (inteiro.includes(' - ')) {
    const direita = inteiro.split(' - ').slice(1).join(' - ').trim();
    if (direita) return direita;
  }

  const composto = [divisionName, classLabel].map(p => String(p ?? '').trim()).filter(Boolean).join(' ');
  return composto || inteiro || null;
}

/**
 * Acha a classe no catálogo da organização, e cria quando não existir.
 *
 * A ORDEM DE RESOLUÇÃO É A REGRA, E ELA NÃO É AMBÍGUA:
 *
 *   1. a classe DAQUELA CATEGORIA — (organização, categoria, código);
 *   2. na ausência dela, a classe GENÉRICA — (organização, NULL, código),
 *      que é o que ESTREANTE, NOVICE, OPEN e MASTER são: divisões que valem
 *      em qualquer categoria;
 *   3. na ausência das duas, cria a específica.
 *
 * A específica ganha da genérica SEMPRE. Uma organização que resolver criar
 * "OPEN de Women's Physique" com regra própria passa a ter essa regra
 * respeitada, sem que a genérica deixe de valer para as outras categorias.
 *
 * IDEMPOTENTE POR CONSTRUÇÃO: a segunda chamada com os mesmos argumentos
 * encontra o que a primeira criou. E se duas chamadas simultâneas passarem
 * juntas pela busca, os índices parciais `ClassCatalog_generica` e
 * `ClassCatalog_especifica` recusam a segunda inserção — a violação é
 * capturada e vira uma releitura, não um erro de servidor.
 *
 * `superOverallEligible` NASCE FALSO e não é inferido de lugar nenhum. A
 * regra homologada diz que só a Open alimenta o Super Overall, e quem
 * responde isso continua sendo a DIVISÃO contra o catálogo — não esta
 * função. Inventar elegibilidade aqui mudaria pontuação já apurada.
 */
async function resolverClasseDoCatalogo(cliente, { organizationId, categoryId = null, displayName, code = null, criar = true }) {
  if (!organizationId) return null;

  const codigo = code ?? normalizarCodigoDeClasse(displayName);
  if (!codigo) return null;

  const nome = String(displayName ?? '').trim() || codigo;

  if (categoryId) {
    const especifica = await cliente.classCatalog.findFirst({ where: { organizationId, categoryId, code: codigo } });
    if (especifica) return especifica;
  }

  const generica = await cliente.classCatalog.findFirst({ where: { organizationId, categoryId: null, code: codigo } });
  if (generica) return generica;

  // `criar: false` é o caminho do EVENTO julgado no MCI, e a diferença é
  // deliberada.
  //
  // Ali a classe já existe como `CompetitionClass`, montada pelo operador ao
  // configurar a prova; criar uma gêmea no catálogo encheria a lista que ele
  // governa de linhas que ele não pediu. E a criação escreve numa tabela cuja
  // política exige operador da organização — falhar aqui derrubaria a
  // publicação de um resultado por causa de um recorte de leitura, que é
  // trocar o essencial pelo acessório.
  //
  // Na IMPORTAÇÃO é o contrário: a classe chega como texto, não existe em
  // lugar nenhum, e não criá-la deixaria o resultado histórico sem recorte —
  // que é exatamente o defeito que esta fase corrige.
  if (!criar) return null;

  try {
    return await cliente.classCatalog.create({
      data: { organizationId, categoryId, code: codigo, name: nome, displayName: nome, superOverallEligible: false }
    });
  } catch (erro) {
    // Corrida entre a busca e a inserção. Os índices parciais seguraram; a
    // resposta certa é a linha que o outro caminho gravou, e não um 500.
    if (erro?.code !== 'P2002') throw erro;
    return (categoryId
      ? await cliente.classCatalog.findFirst({ where: { organizationId, categoryId, code: codigo } })
      : null)
      ?? await cliente.classCatalog.findFirst({ where: { organizationId, categoryId: null, code: codigo } });
  }
}

module.exports = {
  MAXIMO_DO_CODIGO,
  normalizarCodigoDeClasse,
  nomeDeExibicaoDaClasse,
  resolverClasseDoCatalogo
};

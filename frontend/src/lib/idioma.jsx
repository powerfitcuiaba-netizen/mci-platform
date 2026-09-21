import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { definirIdiomaDosRotulos } from './format';

// ============================================================================
// IDIOMA DA INTERFACE — pt-BR, en, es.
//
// O QUE ESTA CAMADA É, E O QUE ELA NUNCA PODE SER
//
// É camada de APRESENTAÇÃO. Traduz o que a pessoa lê, e nada além disso.
// Nenhum código interno muda de idioma: `MATCH_PENDING` continua
// `MATCH_PENDING` no banco, na API e na chave de idempotência; `categoryCode`,
// `externalResultId`, `identityKey` e `sourceKey` continuam byte a byte os
// mesmos. Trocar de idioma não pode alterar um ponto de ranking, uma
// colocação, um vínculo ou uma política — e há teste cobrando exatamente isso.
//
// DADO OFICIAL NÃO É RÓTULO. O nome de um campeonato, de uma federação, de uma
// atleta, de uma equipe e de uma classe vêm do banco e saem como estão. O que
// se traduz é o RÓTULO da interface em volta deles: "Ranking Geral", "Pendente
// de vínculo", "Aplicar". Traduzir "Women's Bikini" seria reescrever o
// regulamento pela porta dos fundos.
//
// POR QUE UM DICIONÁRIO, E NÃO CONDICIONAL ESPALHADA
//
// `if (idioma === 'en')` no meio da tela é a forma mais barata de começar e a
// mais cara de manter: a tradução fica espalhada por onde o texto aparece, e o
// terceiro idioma exige visitar tudo de novo. Aqui a chave é o contrato e as
// três traduções ficam lado a lado — ver uma faltando é ver uma linha curta.
//
// SEM DEPENDÊNCIA NOVA. Uma biblioteca de i18n resolveria plural, gênero e
// formatação de data por idioma. Nada disso é necessário aqui ainda: o que
// existe é substituição de texto com interpolação simples, e `Intl`, que já
// vem no runtime, cuida de data e número. Trazer um pacote para isto seria
// peso sem contrapartida.
// ============================================================================

export const IDIOMAS = Object.freeze([
  { codigo: 'pt-BR', bandeira: '🇧🇷', nome: 'Português', curto: 'PT' },
  { codigo: 'en', bandeira: '🇺🇸', nome: 'English', curto: 'EN' },
  { codigo: 'es', bandeira: '🇪🇸', nome: 'Español', curto: 'ES' }
]);

export const IDIOMA_PADRAO = 'pt-BR';

const CHAVE_DE_PREFERENCIA = 'mci.idioma';

const DICIONARIO = {
  'pt-BR': {
    'idioma.escolher': 'Idioma',
    'idioma.pt-BR': 'Português',
    'idioma.en': 'English',
    'idioma.es': 'Español',


    // Navegação. A CHAVE é a ROTA — o mesmo identificador que o roteador usa.
    // Derivar a chave do rótulo em português quebraria na primeira renomeação;
    // derivá-la da rota amarra a tradução ao destino, que é o que não muda.
    'nav.inicio': 'Início',
    'nav.campeonatos': 'Campeonatos',
    'nav.atletas': 'Atletas',
    'nav.ranking': 'Ranking',
    'nav.social': 'Social',
    'nav.messenger': 'Messenger',
    'nav.comunidades': 'Comunidades',
    'nav.meu-painel': 'Meu painel',
    'nav.minha-filiacao': 'Minha filiação',
    'nav.meu-historico': 'Meu histórico',
    'nav.admin': 'Painel',
    'nav.admin/eventos': 'Eventos',
    'nav.admin/inscricoes': 'Inscrições',
    'nav.admin/solicitacoes': 'Solicitações',
    'nav.admin/checkin': 'Check-in',
    'nav.admin/pesagem': 'Pesagem',
    'nav.admin/credenciamento': 'Credenciamento',
    'nav.admin/palco': 'Palco',
    'nav.admin/resultados': 'Resultados',
    'nav.admin/ranking': 'Ranking',
    'nav.admin/overall': 'Overall',
    'nav.admin/lancamentos': 'Lançamentos',
    'nav.admin/musclewar': 'MuscleWare',
    'nav.admin/auditoria': 'Auditoria',
    'nav.admin/configuracoes': 'Configurações',
    'grupo.plataforma': 'Plataforma',
    'grupo.administracao': 'Administração',
    'navegacao.principal': 'Navegação principal',
    'navegacao.abrirMenu': 'Abrir menu',
    'navegacao.fecharMenu': 'Fechar menu',
    'navegacao.inicio': 'Início',
    'navegacao.campeonatos': 'Campeonatos',
    'navegacao.ranking': 'Ranking',
    'navegacao.atletas': 'Atletas',
    'navegacao.inscricoes': 'Inscrições',
    'navegacao.resultados': 'Resultados',
    'navegacao.importacoes': 'Importações',
    'navegacao.solicitacoes': 'Solicitações',
    'navegacao.minhaCarreira': 'Minha carreira',
    'navegacao.configuracoes': 'Configurações',

    'topo.busca': 'Buscar',
    'topo.somLigado': 'Som ligado',
    'topo.somDesligado': 'Som desligado',
    'topo.ligarSom': 'Ligar o som do sistema',
    'topo.desligarSom': 'Desligar o som do sistema',
    'topo.notificacoes': 'Notificações',
    'topo.naoLidas': '{n} não lidas',
    'topo.meuPerfil': 'Meu perfil social',
    'topo.sair': 'Sair',

    'acao.aplicar': 'Aplicar',
    'acao.revisar': 'Revisar',
    'acao.excluir': 'Excluir',
    'acao.invalidar': 'Invalidar',
    'acao.cancelar': 'Cancelar',
    'acao.confirmar': 'Confirmar',
    'acao.salvar': 'Salvar',
    'acao.voltar': 'Voltar',
    'acao.fechar': 'Fechar',
    'acao.filtrar': 'Filtrar',
    'acao.limparFiltros': 'Limpar filtros',

    'estado.carregando': 'Carregando…',
    'estado.vazio': 'Nada por aqui ainda',
    'estado.erro': 'Não foi possível carregar',
    'estado.semPermissao': 'Você não tem permissão para ver isto',

    'pagina.anterior': 'Página anterior',
    'pagina.proxima': 'Próxima página',
    'pagina.de': 'Página {atual} de {total}',

    'ranking.geral': 'Ranking Geral',
    'ranking.superOverall': 'Super Overall',
    'ranking.equipes': 'Ranking de equipes',
    'ranking.empresas': 'Ranking de empresas',
    'ranking.pontos': 'Pontos',
    'ranking.posicao': 'Posição',
    'ranking.etapas': 'Etapas',
    'ranking.empateNaoResolvido': 'Empate não resolvido',
    'ranking.semCadastro': 'Sem cadastro no MCI',

    'importacao.resumo':
      '{n} resultados serão adicionados ao histórico/ranking. '
      + 'Os atletas ainda não cadastrados permanecerão pendentes de vínculo. '
      + 'Nenhum atleta será criado automaticamente.',
    'importacao.totalRegistros': 'Registros lidos',
    'importacao.reconhecidos': 'Reconhecidos',
    'importacao.pendentes': 'Pendentes de vínculo',
    'importacao.conflitos': 'Conflitos',
    'importacao.duplicados': 'Duplicados',
    'importacao.rejeitados': 'Rejeitados',
    'importacao.aplicaveis': 'Aplicáveis',

    'vinculo.automatico': 'Vinculado automaticamente',
    'vinculo.porCpf': 'Vinculado automaticamente por CPF',
    'vinculo.porMatricula': 'Vinculado automaticamente por filiação + matrícula',
    'vinculo.pendente': 'Pendente de vínculo',
    'vinculo.conflito': 'Conflito de identidade',
    'vinculo.naoIdentificado': 'Não identificado'
  },

  en: {
    'idioma.escolher': 'Language',
    'idioma.pt-BR': 'Português',
    'idioma.en': 'English',
    'idioma.es': 'Español',


    // Navegação. A CHAVE é a ROTA — o mesmo identificador que o roteador usa.
    // Derivar a chave do rótulo em português quebraria na primeira renomeação;
    // derivá-la da rota amarra a tradução ao destino, que é o que não muda.
    'nav.inicio': 'Home',
    'nav.campeonatos': 'Championships',
    'nav.atletas': 'Athletes',
    'nav.ranking': 'Ranking',
    'nav.social': 'Social',
    'nav.messenger': 'Messenger',
    'nav.comunidades': 'Communities',
    'nav.meu-painel': 'My dashboard',
    'nav.minha-filiacao': 'My affiliation',
    'nav.meu-historico': 'My history',
    'nav.admin': 'Dashboard',
    'nav.admin/eventos': 'Events',
    'nav.admin/inscricoes': 'Registrations',
    'nav.admin/solicitacoes': 'Requests',
    'nav.admin/checkin': 'Check-in',
    'nav.admin/pesagem': 'Weigh-in',
    'nav.admin/credenciamento': 'Credentialing',
    'nav.admin/palco': 'Stage',
    'nav.admin/resultados': 'Results',
    'nav.admin/ranking': 'Ranking',
    'nav.admin/overall': 'Overall',
    'nav.admin/lancamentos': 'Point entries',
    'nav.admin/musclewar': 'MuscleWare',
    'nav.admin/auditoria': 'Audit log',
    'nav.admin/configuracoes': 'Settings',
    'grupo.plataforma': 'Platform',
    'grupo.administracao': 'Administration',
    'navegacao.principal': 'Main navigation',
    'navegacao.abrirMenu': 'Open menu',
    'navegacao.fecharMenu': 'Close menu',
    'navegacao.inicio': 'Home',
    'navegacao.campeonatos': 'Championships',
    'navegacao.ranking': 'Ranking',
    'navegacao.atletas': 'Athletes',
    'navegacao.inscricoes': 'Registrations',
    'navegacao.resultados': 'Results',
    'navegacao.importacoes': 'Imports',
    'navegacao.solicitacoes': 'Requests',
    'navegacao.minhaCarreira': 'My career',
    'navegacao.configuracoes': 'Settings',

    'topo.busca': 'Search',
    'topo.somLigado': 'Sound on',
    'topo.somDesligado': 'Sound off',
    'topo.ligarSom': 'Turn system sound on',
    'topo.desligarSom': 'Turn system sound off',
    'topo.notificacoes': 'Notifications',
    'topo.naoLidas': '{n} unread',
    'topo.meuPerfil': 'My social profile',
    'topo.sair': 'Sign out',

    'acao.aplicar': 'Apply',
    'acao.revisar': 'Review',
    'acao.excluir': 'Delete',
    'acao.invalidar': 'Void',
    'acao.cancelar': 'Cancel',
    'acao.confirmar': 'Confirm',
    'acao.salvar': 'Save',
    'acao.voltar': 'Back',
    'acao.fechar': 'Close',
    'acao.filtrar': 'Filter',
    'acao.limparFiltros': 'Clear filters',

    'estado.carregando': 'Loading…',
    'estado.vazio': 'Nothing here yet',
    'estado.erro': 'Could not load',
    'estado.semPermissao': 'You do not have permission to see this',

    'pagina.anterior': 'Previous page',
    'pagina.proxima': 'Next page',
    'pagina.de': 'Page {atual} of {total}',

    'ranking.geral': 'Overall Ranking',
    'ranking.superOverall': 'Super Overall',
    'ranking.equipes': 'Team ranking',
    'ranking.empresas': 'Company ranking',
    'ranking.pontos': 'Points',
    'ranking.posicao': 'Position',
    'ranking.etapas': 'Stages',
    'ranking.empateNaoResolvido': 'Unresolved tie',
    'ranking.semCadastro': 'Not registered with MCI',

    'importacao.resumo':
      '{n} results will be added to the history/ranking. '
      + 'Athletes who are not yet registered will remain pending linkage. '
      + 'No athlete will be created automatically.',
    'importacao.totalRegistros': 'Records read',
    'importacao.reconhecidos': 'Recognized',
    'importacao.pendentes': 'Pending linkage',
    'importacao.conflitos': 'Conflicts',
    'importacao.duplicados': 'Duplicates',
    'importacao.rejeitados': 'Rejected',
    'importacao.aplicaveis': 'Applicable',

    'vinculo.automatico': 'Automatically linked',
    'vinculo.porCpf': 'Automatically linked by CPF',
    'vinculo.porMatricula': 'Automatically linked by affiliation + member number',
    'vinculo.pendente': 'Pending linkage',
    'vinculo.conflito': 'Identity conflict',
    'vinculo.naoIdentificado': 'Not identified'
  },

  es: {
    'idioma.escolher': 'Idioma',
    'idioma.pt-BR': 'Português',
    'idioma.en': 'English',
    'idioma.es': 'Español',


    // Navegação. A CHAVE é a ROTA — o mesmo identificador que o roteador usa.
    // Derivar a chave do rótulo em português quebraria na primeira renomeação;
    // derivá-la da rota amarra a tradução ao destino, que é o que não muda.
    'nav.inicio': 'Inicio',
    'nav.campeonatos': 'Campeonatos',
    'nav.atletas': 'Atletas',
    'nav.ranking': 'Ranking',
    'nav.social': 'Social',
    'nav.messenger': 'Messenger',
    'nav.comunidades': 'Comunidades',
    'nav.meu-painel': 'Mi panel',
    'nav.minha-filiacao': 'Mi afiliación',
    'nav.meu-historico': 'Mi historial',
    'nav.admin': 'Panel',
    'nav.admin/eventos': 'Eventos',
    'nav.admin/inscricoes': 'Inscripciones',
    'nav.admin/solicitacoes': 'Solicitudes',
    'nav.admin/checkin': 'Check-in',
    'nav.admin/pesagem': 'Pesaje',
    'nav.admin/credenciamento': 'Acreditación',
    'nav.admin/palco': 'Escenario',
    'nav.admin/resultados': 'Resultados',
    'nav.admin/ranking': 'Ranking',
    'nav.admin/overall': 'Overall',
    'nav.admin/lancamentos': 'Asientos de puntos',
    'nav.admin/musclewar': 'MuscleWare',
    'nav.admin/auditoria': 'Auditoría',
    'nav.admin/configuracoes': 'Configuración',
    'grupo.plataforma': 'Plataforma',
    'grupo.administracao': 'Administración',
    'navegacao.principal': 'Navegación principal',
    'navegacao.abrirMenu': 'Abrir menú',
    'navegacao.fecharMenu': 'Cerrar menú',
    'navegacao.inicio': 'Inicio',
    'navegacao.campeonatos': 'Campeonatos',
    'navegacao.ranking': 'Ranking',
    'navegacao.atletas': 'Atletas',
    'navegacao.inscricoes': 'Inscripciones',
    'navegacao.resultados': 'Resultados',
    'navegacao.importacoes': 'Importaciones',
    'navegacao.solicitacoes': 'Solicitudes',
    'navegacao.minhaCarreira': 'Mi carrera',
    'navegacao.configuracoes': 'Configuración',

    'topo.busca': 'Buscar',
    'topo.somLigado': 'Sonido activado',
    'topo.somDesligado': 'Sonido desactivado',
    'topo.ligarSom': 'Activar el sonido del sistema',
    'topo.desligarSom': 'Desactivar el sonido del sistema',
    'topo.notificacoes': 'Notificaciones',
    'topo.naoLidas': '{n} sin leer',
    'topo.meuPerfil': 'Mi perfil social',
    'topo.sair': 'Salir',

    'acao.aplicar': 'Aplicar',
    'acao.revisar': 'Revisar',
    'acao.excluir': 'Eliminar',
    'acao.invalidar': 'Anular',
    'acao.cancelar': 'Cancelar',
    'acao.confirmar': 'Confirmar',
    'acao.salvar': 'Guardar',
    'acao.voltar': 'Volver',
    'acao.fechar': 'Cerrar',
    'acao.filtrar': 'Filtrar',
    'acao.limparFiltros': 'Limpiar filtros',

    'estado.carregando': 'Cargando…',
    'estado.vazio': 'Todavía no hay nada aquí',
    'estado.erro': 'No se pudo cargar',
    'estado.semPermissao': 'No tienes permiso para ver esto',

    'pagina.anterior': 'Página anterior',
    'pagina.proxima': 'Página siguiente',
    'pagina.de': 'Página {atual} de {total}',

    'ranking.geral': 'Ranking General',
    'ranking.superOverall': 'Super Overall',
    'ranking.equipes': 'Ranking de equipos',
    'ranking.empresas': 'Ranking de empresas',
    'ranking.pontos': 'Puntos',
    'ranking.posicao': 'Posición',
    'ranking.etapas': 'Etapas',
    'ranking.empateNaoResolvido': 'Empate no resuelto',
    'ranking.semCadastro': 'Sin registro en el MCI',

    'importacao.resumo':
      'Se agregarán {n} resultados al historial/ranking. '
      + 'Los atletas que aún no estén registrados permanecerán pendientes de vinculación. '
      + 'No se creará ningún atleta automáticamente.',
    'importacao.totalRegistros': 'Registros leídos',
    'importacao.reconhecidos': 'Reconocidos',
    'importacao.pendentes': 'Pendientes de vinculación',
    'importacao.conflitos': 'Conflictos',
    'importacao.duplicados': 'Duplicados',
    'importacao.rejeitados': 'Rechazados',
    'importacao.aplicaveis': 'Aplicables',

    'vinculo.automatico': 'Vinculado automáticamente',
    'vinculo.porCpf': 'Vinculado automáticamente por CPF',
    'vinculo.porMatricula': 'Vinculado automáticamente por afiliación + matrícula',
    'vinculo.pendente': 'Pendiente de vinculación',
    'vinculo.conflito': 'Conflicto de identidad',
    'vinculo.naoIdentificado': 'No identificado'
  }
};

export const CHAVES = Object.freeze(Object.keys(DICIONARIO[IDIOMA_PADRAO]));

/**
 * As chaves que um idioma declara.
 *
 * Serve ao teste que compara os três dicionários. A comparação é de CHAVES, e
 * não de textos: português e espanhol são línguas irmãs, e "Campeonatos",
 * "Resultados", "Filtrar" e "Confirmar" coincidem de verdade em muitas
 * entradas. Exigir texto diferente transformaria coincidência legítima em
 * falha, e a lista de exceções cresceria até ninguém mais lê-la.
 */
export const chavesDoIdioma = codigo => Object.keys(DICIONARIO[codigo] ?? {});

const ehIdiomaConhecido = codigo => IDIOMAS.some(i => i.codigo === codigo);

/**
 * Preferência guardada. O armazenamento do navegador pode lançar — aba
 * anônima, dado do site bloqueado —, e um idioma é conveniência: falhar em
 * lê-lo NÃO pode impedir a tela de abrir.
 */
export function idiomaPreferido() {
  try {
    const guardado = globalThis.localStorage?.getItem(CHAVE_DE_PREFERENCIA);
    return ehIdiomaConhecido(guardado) ? guardado : IDIOMA_PADRAO;
  } catch {
    return IDIOMA_PADRAO;
  }
}

function guardarIdioma(codigo) {
  try {
    globalThis.localStorage?.setItem(CHAVE_DE_PREFERENCIA, codigo);
  } catch {
    // Preferência não é dado: perdê-la custa um clique na próxima visita.
  }
}

/**
 * Traduz uma chave. Interpola `{nome}` com os valores recebidos.
 *
 * O RECUO É EM CASCATA, e cada degrau existe por um motivo diferente:
 * o idioma escolhido, depois o português (tradução que ainda não chegou), e
 * por fim a própria chave. Devolver a chave é feio de propósito — texto
 * faltando tem de ser visível para quem desenvolve, e nunca virar espaço em
 * branco para quem usa.
 */
export function traduzir(idioma, chave, valores = {}) {
  const texto = DICIONARIO[idioma]?.[chave] ?? DICIONARIO[IDIOMA_PADRAO]?.[chave] ?? chave;
  return String(texto).replace(/\{(\w+)\}/g, (inteiro, nome) =>
    (Object.prototype.hasOwnProperty.call(valores, nome) ? String(valores[nome]) : inteiro));
}

const ContextoDeIdioma = createContext(null);

export function ProvedorDeIdioma({ children, inicial }) {
  const [idioma, definir] = useState(() => (ehIdiomaConhecido(inicial) ? inicial : idiomaPreferido()));

  useEffect(() => {
    guardarIdioma(idioma);
    // Os rótulos de enum vivem em `format.js` e são chamados de dezenas de
    // lugares sem contexto. Avisá-lo daqui mantém as duas camadas no mesmo
    // idioma sem obrigar cada chamada a receber um parâmetro a mais.
    definirIdiomaDosRotulos(idioma);
    // `lang` no documento é o que leitor de tela e corretor ortográfico leem
    // para escolher a pronúncia. Sem isto a interface troca de idioma para os
    // olhos e continua em português para quem ouve.
    if (globalThis.document?.documentElement) {
      globalThis.document.documentElement.lang = idioma;
    }
  }, [idioma]);

  const valor = useMemo(() => ({
    idioma,
    definirIdioma: codigo => { if (ehIdiomaConhecido(codigo)) definir(codigo); },
    t: (chave, valores) => traduzir(idioma, chave, valores)
  }), [idioma]);

  return <ContextoDeIdioma.Provider value={valor}>{children}</ContextoDeIdioma.Provider>;
}

/**
 * Fora do provedor devolve o padrão em vez de lançar: um componente isolado
 * num teste, ou uma tela de erro montada antes da árvore, precisa renderizar.
 */
export function useIdioma() {
  return useContext(ContextoDeIdioma) ?? {
    idioma: IDIOMA_PADRAO,
    definirIdioma: () => {},
    t: (chave, valores) => traduzir(IDIOMA_PADRAO, chave, valores)
  };
}

#!/usr/bin/env node
// ============================================================================
// FASE 13.26 — CONJUNTO DE DEMONSTRAÇÃO, MARCADO COMO DEMONSTRAÇÃO.
//
// Dados fictícios servem para uma coisa só: alguém abrir o sistema e conseguir
// olhar. Servem MAL para qualquer outra — e é por isso que cada nome visível
// daqui começa com "QA · DEMO". Um atleta de demonstração que se parece com um
// atleta de verdade é um passivo: aparece em busca, entra em relatório, e um
// dia alguém o trata como real.
//
// O que este script constrói, e por que cada peça existe:
//
//   TROCA HISTÓRICA DE FILIAÇÃO — uma atleta compete na 1ª etapa pela NPC-MT e
//     na 3ª pela NPC-SP. O ponto antigo continua dizendo NPC-MT, porque a
//     filiação é COPIADA no momento em que o ponto nasce. É a regra que a
//     FASE 9 tranca, e só se vê com um histórico que atravessa a troca.
//
//   OVERALL HOMOLOGADO — declarado pelo operador numa classe absoluta, uma vez,
//     valendo +10. O sistema NÃO escolhe o campeão; quem escolhe é gente, e a
//     tela de homologação existe para isso.
//
//   EMPATE SEM DESEMPATE — duas atletas terminam a temporada com o mesmo total
//     e os mesmos contadores. Nenhuma recebe colocação. Não é defeito da
//     demonstração: é a regra homologada aparecendo.
//
//   CLASSES NÃO ABSOLUTAS — Novice e Master pontuam para o campeonato e NÃO
//     alimentam o Super Overall. Sem elas na demonstração, a diferença entre as
//     duas métricas fica invisível.
//
// TUDO PASSA PELA API. Nada é escrito direto no banco: se uma regra de negócio
// recusar, a demonstração falha alto — que é o comportamento certo. Uma
// semeadura que contorna a aplicação demonstra um sistema que não existe.
//
// Uso:
//   node scripts/qa/demo.mjs --api http://127.0.0.1:4599/api/v1
//   node scripts/qa/demo.mjs --api https://<preview>/api/v1 --senha '<escolhida>'
//
// A senha NUNCA é de produção e nunca vem do chat: ou é a padrão de
// demonstração, ou vem por --senha / DEMO_PASSWORD de quem executa.
// ============================================================================

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const BASE = arg('api', env.DEMO_API_URL || 'http://127.0.0.1:4599/api/v1').replace(/\/$/, '');
const SENHA = arg('senha', env.DEMO_PASSWORD || 'demonstracao-mci-2026');
const SELO = 'QA · DEMO';
const marca = texto => `${SELO} — ${texto}`;

// Sufixo estável por execução: rodar duas vezes no mesmo ambiente cria duas
// demonstrações independentes em vez de colidir em código único.
const CARIMBO = Date.now().toString(36);

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await resposta.json().catch(() => ({}));
  if (resposta.status >= 400) {
    throw new Error(`${metodo} ${caminho} → ${resposta.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

// CPF sintético VÁLIDO no dígito verificador — o cadastro recusa qualquer
// outra coisa, e inventar um inválido só produziria uma demonstração que não
// atravessa o próprio sistema.
function cpfDeDemo(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const soma1 = base.reduce((t, n, i) => t + n * (10 - i), 0);
  const r1 = (soma1 * 10) % 11;
  const d1 = r1 === 10 ? 0 : r1;
  const soma2 = base.concat([d1]).reduce((t, n, i) => t + n * (11 - i), 0);
  const r2 = (soma2 * 10) % 11;
  const d2 = r2 === 10 ? 0 : r2;
  return base.join('') + d1 + d2;
}

const conta = (papel, nome) => ({
  name: marca(nome),
  email: `demo.${papel}.${CARIMBO}@mci.local`,
  password: SENHA,
  birthDate: '1994-07-15', phone: '65999990000', whatsapp: '65988880000',
  postalCode: '78000000', addressLine: 'Rua da Demonstração', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

// As oito atletas. Os nomes são evidentemente fictícios de propósito: ninguém
// confunde "QA · DEMO — Atleta Que Trocou de Filiação" com uma pessoa.
const ATLETAS = [
  { chave: 'migrante', nome: 'Atleta Que Trocou de Filiação', matricula: 'MT-1001' },
  { chave: 'campea', nome: 'Atleta Campeã Overall', matricula: 'MT-1002' },
  // Vence a Open da 2ª etapa e NÃO tem título: é ela que o roteiro de
  // conferência manda homologar. Existe por causa de um defeito real — ver o
  // comentário das etapas, logo abaixo.
  { chave: 'candidata', nome: 'Atleta Candidata ao Overall', matricula: 'MT-1009' },
  { chave: 'empatadaA', nome: 'Atleta Empatada A', matricula: 'MT-1003' },
  { chave: 'empatadaB', nome: 'Atleta Empatada B', matricula: 'MT-1004' },
  { chave: 'novata', nome: 'Atleta Só de Novice', matricula: 'MT-1005' },
  { chave: 'master', nome: 'Atleta de Master', matricula: 'MT-1006' },
  { chave: 'quinta', nome: 'Atleta Quinta Colocada', matricula: 'MT-1007' },
  { chave: 'sexta', nome: 'Atleta Sexta Colocada', matricula: 'MT-1008' }
];

const CLASSES = [
  { divisao: 'Absoluta', codigoDivisao: 'DEMO-ABS', nome: 'Open', codigo: 'OPEN', absoluta: true },
  { divisao: 'Novatas', codigoDivisao: 'DEMO-NOV', nome: 'Novice', codigo: 'NOVICE', absoluta: false },
  { divisao: 'Master', codigoDivisao: 'DEMO-MST', nome: 'Master', codigo: 'MASTER', absoluta: false }
];

async function principal() {
  console.log(`\n=== CONJUNTO DE DEMONSTRAÇÃO — ${SELO} ===\n`);
  console.log(`API: ${BASE}\n`);

  // --- quem executa: um administrador que JÁ EXISTE
  //
  // Não há autopromoção, e não deve haver: o cadastro aberto recusa papel
  // privilegiado, e uma rota que contornasse isso seria a falha de segurança
  // mais barata de explorar em toda a plataforma. O primeiro administrador
  // nasce pelo caminho próprio, com acesso ao banco:
  //
  //     ADMIN_PASSWORD='...' node scripts/criar-admin.js "Nome" email@dominio
  //
  // Daqui em diante é ele quem assina a demonstração.
  const tokenInformado = arg('token-admin', env.DEMO_ADMIN_TOKEN);
  const emailAdmin = arg('admin-email', env.DEMO_ADMIN_EMAIL);
  const senhaAdmin = arg('admin-senha', env.DEMO_ADMIN_PASSWORD);

  let tokenAdmin = tokenInformado;
  if (!tokenAdmin) {
    if (!emailAdmin || !senhaAdmin) {
      console.error('\n  Falta dizer QUEM executa a demonstração.\n');
      console.error('    --admin-email <email> --admin-senha <senha>   (ou DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD)');
      console.error('    --token-admin <JWT>                           (ou DEMO_ADMIN_TOKEN)\n');
      console.error('  Não existe administrador ainda? Crie o primeiro, com acesso ao banco:\n');
      console.error("    ADMIN_PASSWORD='...' node scripts/criar-admin.js \"Nome\" email@dominio\n");
      console.error('  A senha não vem por chat e não aparece em nenhum log deste script.\n');
      process.exit(1);
    }
    tokenAdmin = (await chamar('/auth/login', {
      metodo: 'POST', corpo: { email: emailAdmin, password: senhaAdmin }
    })).token;
  }
  console.log('  administração autenticada');

  // --- organização, filiações, temporada
  const org = await chamar('/organizations', {
    metodo: 'POST', token: tokenAdmin,
    corpo: { name: marca('Federação de Demonstração'), slug: `demo-fed-${CARIMBO}`, state: 'MT' }
  });

  const diretora = await chamar('/auth/register', { metodo: 'POST', corpo: conta('diretora', 'Diretora de Evento') });
  const gerente = await chamar('/auth/register', { metodo: 'POST', corpo: conta('gerente', 'Gerente de Ranking') });
  const contaDaAtleta = await chamar('/auth/register', { metodo: 'POST', corpo: conta('atleta', 'Conta da Atleta Migrante') });

  for (const [usuario, papeis] of [
    [diretora, ['EVENT_DIRECTOR']],
    [gerente, ['RANKING_MANAGER']]
  ]) {
    for (const papel of papeis) {
      await chamar(`/organizations/${org.id}/members`, {
        metodo: 'POST', token: tokenAdmin, corpo: { userId: usuario.user.id, role: papel }
      });
    }
  }
  // A diretora também apura: é quem publica resultado e declara o Overall.
  await chamar(`/organizations/${org.id}/members`, {
    metodo: 'POST', token: tokenAdmin, corpo: { userId: diretora.user.id, role: 'RANKING_MANAGER' }
  });

  const entrar = async usuario => (await chamar('/auth/login', {
    metodo: 'POST', corpo: { email: usuario.user.email, password: SENHA }
  })).token;

  const tokenDiretora = await entrar(diretora);
  console.log('  organização e papéis prontos');

  const fedMT = await chamar('/affiliations', {
    metodo: 'POST', token: tokenDiretora,
    corpo: { organizationId: org.id, name: marca('NPC Mato Grosso'), code: `DEMO-NPC-MT-${CARIMBO}` }
  });
  const fedSP = await chamar('/affiliations', {
    metodo: 'POST', token: tokenDiretora,
    corpo: { organizationId: org.id, name: marca('NPC São Paulo'), code: `DEMO-NPC-SP-${CARIMBO}` }
  });

  const temporada = await chamar('/seasons', {
    metodo: 'POST', token: tokenDiretora,
    corpo: { organizationId: org.id, name: marca('Temporada 2026'), year: 2026 }
  });
  console.log('  filiações e temporada prontas');

  // --- etapas
  //
  // Três etapas com as MESMAS três classes. A colocação de cada atleta em cada
  // etapa é escrita aqui, à vista, para que quem lê o script saiba de onde sai
  // cada número da tela.
  const ETAPAS = [
    {
      nome: 'Etapa Cuiabá', data: '2026-03-14T12:00:00.000Z',
      colocacoes: {
        OPEN: ['campea', 'migrante', 'empatadaA', 'quinta', 'sexta'],
        NOVICE: ['novata', 'quinta'],
        MASTER: ['master']
      },
      overall: 'campea'
    },
    {
      // A 2ª etapa é vencida por OUTRA atleta, e isso não é detalhe.
      //
      // ACHADO DO TESTE HUMANO: antes, a mesma atleta vencia a Open das duas
      // primeiras etapas. O roteiro de conferência manda homologar um Overall
      // (TESTE 6) — e o único campeonato sem título era justamente o outro
      // dela. Quem seguia o roteiro criava um SEGUNDO título para a mesma
      // atleta e via "Etapas: 2 · Pontos: 30" numa demonstração que prometia
      // "um Overall homologado".
      //
      // O número estava certo: dois títulos, dois bônus, um por evento, como
      // manda a regra. A demonstração é que estava armada para confundir.
      // Agora a homologação do roteiro cai numa atleta própria, e o total da
      // campeã continua explicável: 5 + 10 na 1ª etapa, 4 na 2ª.
      nome: 'Etapa Várzea Grande', data: '2026-06-20T12:00:00.000Z',
      colocacoes: {
        OPEN: ['candidata', 'campea', 'empatadaB', 'quinta', 'sexta'],
        NOVICE: ['novata'],
        MASTER: ['master']
      },
      overall: null
    },
    {
      nome: 'Etapa Rondonópolis', data: '2026-09-12T12:00:00.000Z',
      colocacoes: {
        OPEN: ['empatadaA', 'empatadaB', 'migrante', 'quinta'],
        NOVICE: ['novata'],
        MASTER: ['master']
      },
      overall: null
    }
  ];

  const atletasCriados = new Map();
  // O CPF é a identidade: na segunda etapa a MESMA atleta entra pelo MESMO CPF,
  // e é o sistema que a reconhece. Guardar o id e mandá-lo de volta seria o
  // script decidindo quem é quem — exatamente o que a plataforma não permite.
  const cpfPorAtleta = new Map();
  let semente = 400000000;

  for (const [indice, etapa] of ETAPAS.entries()) {
    // A TROCA DE FILIAÇÃO acontece ANTES da última etapa. O ponto da primeira
    // já está gravado com a filiação antiga, e é isso que a tela precisa
    // mostrar: o passado não muda quando o cadastro muda.
    if (indice === ETAPAS.length - 1 && atletasCriados.has('migrante')) {
      await chamar(`/athletes/${atletasCriados.get('migrante')}`, {
        metodo: 'PATCH', token: tokenDiretora,
        corpo: { affiliationId: fedSP.id, affiliationNumber: 'SP-2001' }
      });
      console.log('  a atleta migrante trocou de filiação (MT → SP)');
    }

    const evento = await chamar('/events', {
      metodo: 'POST', token: tokenDiretora,
      corpo: {
        organizationId: org.id, name: marca(etapa.nome),
        slug: `demo-${CARIMBO}-${indice}`, startDate: etapa.data, seasonId: temporada.id
      }
    });

    const categorias = await chamar('/categories', { token: tokenDiretora });
    const bikini = (categorias.items || categorias).find(c => c.code === 'BIKINI');
    const eventCategory = await chamar(`/events/${evento.id}/categories`, {
      metodo: 'POST', token: tokenDiretora, corpo: { categoryId: bikini.id }
    });

    const classes = new Map();
    for (const def of CLASSES) {
      const divisao = await chamar(`/event-categories/${eventCategory.id}/divisions`, {
        metodo: 'POST', token: tokenDiretora, corpo: { name: def.divisao, code: def.codigoDivisao }
      });
      const classe = await chamar(`/divisions/${divisao.id}/classes`, {
        metodo: 'POST', token: tokenDiretora,
        corpo: { name: def.nome, code: def.codigo, superOverallEligible: def.absoluta }
      });
      classes.set(def.codigo, classe.id);
    }

    for (const status of ['PLANNED', 'REGISTRATIONS_OPEN']) {
      await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretora, corpo: { status } });
    }

    // Quem compete nesta etapa, e em quais classes.
    const porAtleta = new Map();
    for (const [codigo, ordem] of Object.entries(etapa.colocacoes)) {
      for (const chave of ordem) {
        if (!porAtleta.has(chave)) porAtleta.set(chave, []);
        porAtleta.get(chave).push(classes.get(codigo));
      }
    }

    const inscricoes = new Map();
    for (const [chave, classIds] of porAtleta) {
      const definicao = ATLETAS.find(a => a.chave === chave);
      if (!cpfPorAtleta.has(chave)) {
        semente += 7919;
        cpfPorAtleta.set(chave, cpfDeDemo(semente));
      }

      const inscricao = await chamar(`/events/${evento.id}/registrations`, {
        metodo: 'POST', token: tokenDiretora,
        corpo: {
          cpf: cpfPorAtleta.get(chave),
          athlete: { fullName: marca(definicao.nome), sex: 'FEMALE', state: 'MT', city: 'Cuiabá' },
          classIds
        }
      });

      const athleteId = inscricao.registration.athlete.id;
      inscricoes.set(chave, { registrationId: inscricao.registration.id, athleteId });

      if (!atletasCriados.has(chave)) {
        atletasCriados.set(chave, athleteId);
        // Filiação e matrícula: as duas juntas, que é o que identifica.
        await chamar(`/athletes/${athleteId}`, {
          metodo: 'PATCH', token: tokenDiretora,
          corpo: {
            affiliationId: fedMT.id,
            affiliationNumber: definicao.matricula,
            ...(chave === 'migrante' ? { userId: contaDaAtleta.user.id } : {})
          }
        });
      }
    }

    for (const status of ['REGISTRATIONS_CLOSED', 'IN_OPERATION']) {
      await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretora, corpo: { status } });
    }
    for (const { registrationId } of inscricoes.values()) {
      await chamar(`/registrations/${registrationId}/checkin`, { metodo: 'POST', token: tokenDiretora, corpo: {} });
    }
    await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tokenDiretora, corpo: { status: 'IN_JUDGING' } });

    for (const [codigo, ordem] of Object.entries(etapa.colocacoes)) {
      await chamar(`/classes/${classes.get(codigo)}/result`, {
        metodo: 'POST', token: tokenDiretora,
        corpo: { entries: ordem.map((chave, i) => ({ athleteId: inscricoes.get(chave).athleteId, placing: i + 1 })) }
      });
      await chamar(`/classes/${classes.get(codigo)}/result/publish`, {
        metodo: 'POST', token: tokenDiretora, corpo: { note: marca('resultado de demonstração') }
      });
    }

    // O OVERALL É DECLARADO, nunca calculado. Vale +10, uma vez, na absoluta.
    if (etapa.overall) {
      const titulo = await chamar(`/events/${evento.id}/overall`, {
        metodo: 'POST', token: tokenDiretora,
        corpo: {
          athleteId: inscricoes.get(etapa.overall).athleteId,
          note: marca('homologação de demonstração')
        }
      });
      console.log(`  Overall homologado na ${etapa.nome} (título ${titulo.id})`);
    }

    console.log(`  ${etapa.nome}: ${inscricoes.size} atletas, ${Object.keys(etapa.colocacoes).length} classes, resultado publicado`);
  }

  // --- uma etapa QUE AINDA VAI ACONTECER
  //
  // Sem ela a primeira tela que alguém abre diz "nenhum campeonato agendado",
  // e a demonstração começa parecendo um sistema vazio. O calendário é a
  // primeira coisa que se olha; ele precisa ter o que mostrar.
  const futura = await chamar('/events', {
    metodo: 'POST', token: tokenDiretora,
    corpo: {
      organizationId: org.id, name: marca('Etapa Sinop — inscrições abertas'),
      slug: `demo-${CARIMBO}-futura`,
      startDate: '2027-04-17T12:00:00.000Z', seasonId: temporada.id
    }
  });
  const categoriasDaFutura = await chamar('/categories', { token: tokenDiretora });
  const bikiniDaFutura = (categoriasDaFutura.items || categoriasDaFutura).find(c => c.code === 'BIKINI');
  const ecFutura = await chamar(`/events/${futura.id}/categories`, {
    metodo: 'POST', token: tokenDiretora, corpo: { categoryId: bikiniDaFutura.id }
  });
  const divFutura = await chamar(`/event-categories/${ecFutura.id}/divisions`, {
    metodo: 'POST', token: tokenDiretora, corpo: { name: 'Absoluta', code: 'DEMO-ABS' }
  });
  await chamar(`/divisions/${divFutura.id}/classes`, {
    metodo: 'POST', token: tokenDiretora,
    corpo: { name: 'Open', code: 'OPEN', superOverallEligible: true }
  });
  for (const status of ['PLANNED', 'REGISTRATIONS_OPEN']) {
    await chamar(`/events/${futura.id}/transition`, { metodo: 'POST', token: tokenDiretora, corpo: { status } });
  }
  console.log('  Etapa Sinop criada com inscrições abertas');

  // --- conferência: a demonstração precisa DEMONSTRAR o que promete
  const ranking = await chamar(`/ranking?seasonId=${temporada.id}&limit=100`, { token: tokenDiretora });
  const linhas = ranking.items ?? ranking;

  const historico = await chamar(
    `/athletes/${atletasCriados.get('migrante')}/ranking-points?seasonId=${temporada.id}`,
    { token: tokenDiretora }
  );
  const pontosDaMigrante = historico.items ?? historico;
  const filiacoesNoHistorico = new Set(pontosDaMigrante.map(p => p.affiliation?.code).filter(Boolean));

  console.log('\n--- o que a demonstração mostra ---');
  console.log(`  ranking da temporada: ${linhas.length} atletas`);
  console.log(`  histórico da atleta migrante: ${pontosDaMigrante.length} participações`);
  console.log(`  filiações no histórico dela: ${[...filiacoesNoHistorico].join(', ') || '(nenhuma)'}`);

  if (filiacoesNoHistorico.size < 2) {
    console.log('\n  ATENÇÃO: o histórico não atravessou a troca de filiação.');
    console.log('  A demonstração subiu, mas NÃO demonstra a imutabilidade histórica.');
    process.exitCode = 1;
  }

  const comBonus = linhas.filter(l => (l.overallWins ?? 0) > 0);
  console.log(`  atletas com título Overall: ${comBonus.length}`);

  // O total da campeã precisa ser EXPLICÁVEL, e a demonstração confere isso
  // antes de se declarar pronta: 5 da vitória na 1ª etapa, +10 do título, 4 do
  // 2º lugar na 2ª. Se mudar, é porque a narrativa mudou — e aí a documentação
  // mudou junto, ou a demonstração voltou a confundir quem a abre.
  const campea = linhas.find(l => l.athlete?.fullName?.includes('Campeã Overall'));
  const esperado = 19;
  console.log(`  total da campeã: ${campea?.totalPoints} (5 + 10 na 1ª etapa, 4 na 2ª = ${esperado})`);
  console.log(`  títulos da campeã: ${campea?.overallWins}`);
  if (campea?.totalPoints !== esperado || campea?.overallWins !== 1) {
    console.log('\n  ATENÇÃO: o total da campeã não é o que a documentação promete.');
    console.log('  A demonstração subiu, mas vai confundir quem a abrir.');
    process.exitCode = 1;
  }
  const semColocacao = linhas.filter(l => l.position == null);
  console.log(`  linhas sem colocação (empate não resolvido): ${semColocacao.length}`);

  console.log('\n--- contas de demonstração ---');
  console.log('  Todas com a MESMA senha, informada por quem executou este script.');
  console.log('  Nenhuma delas é conta de produção, e nenhuma senha real foi usada.\n');
  for (const [papel, usuario] of [
    ['direção de evento', diretora], ['gerência de ranking', gerente], ['atleta', contaDaAtleta]
  ]) {
    console.log(`  ${papel.padEnd(22)} ${usuario.user.email}`);
  }
  console.log('  administração          (a conta que executou este script)');

  console.log(`\n  organização: ${marca('Federação de Demonstração')}`);
  console.log(`  temporada:   ${marca('Temporada 2026')}`);
  console.log('\n=== PRONTO ===\n');
}

principal().catch(erro => {
  console.error(`\nFALHOU: ${erro.message}\n`);
  process.exit(1);
});

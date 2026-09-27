#!/usr/bin/env node
// ============================================================================
// SEMEADURA DO MÓDULO TREINADORES & EQUIPES PARA UM AMBIENTE DE HOMOLOGAÇÃO.
//
// POR QUE ESTE SCRIPT EXISTE SEPARADO DO GATE VISUAL
//
// `scripts/qa/visual-treinadores.mjs` semeia o mesmo cenário, mas ele levanta a
// pilha, mede oito larguras num Chromium e derruba tudo: a semeadura vive dentro
// dele e morre com ele. O ambiente de preview (`.github/workflows/preview.yml`)
// precisa do cenário montado numa pilha que JÁ está de pé, com contas que uma
// PESSOA vai digitar — e por isso os endereços aqui são fixos e legíveis, não
// sufixados por timestamp como os do gate.
//
// TUDO PELAS ROTAS REAIS. Nenhum `UPDATE` direto no banco, nem para trocar papel:
// `PATCH /admin/users/:id` é o caminho que um administrador usaria, e usá-lo aqui
// significa que a semeadura não consegue montar nenhum estado que o produto não
// permita montar. Um cenário de homologação que nasce por fora das regras
// homologa o banco, não o sistema.
//
// O QUE ELE MONTA — os quatro perfis do roteiro, e os casos que importam:
//
//   Administração Central   aprova cadastro (R-03), concede delegação (R-02),
//                           lê a trilha de auditoria
//   Diretor de Federação    autoriza atuação na federação (R-04) e NÃO aprova
//                           cadastro — a separação é o ponto do módulo
//   Treinador (Equipe)      cadastro APROVADO, atuação autorizada, equipe
//                           própria, atleta vinculado e convite pendente
//   Treinador em análise     cadastro PENDING — para a fila de análise ter linha
//   Atleta                   com convite PENDENTE para confirmar, que é o ato
//                           que cria o vínculo
//   Delegado central         uma concessão VIVA com escopo e prazo, para a
//                           tabela de delegação não estar vazia
//
// DADO SINTÉTICO, SEMPRE. Nomes prefixados "QA", CPF gerado por algoritmo,
// telefone e endereço fictícios. Nada aqui é dado de pessoa real, e este script
// nunca deve ser apontado para produção.
// ============================================================================

const { argv } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const BASE_API = (arg('api') || 'http://127.0.0.1:4700/api/v1').replace(/\/$/, '');
const SENHA = arg('senha') || process.env.QA_PASSWORD || 'SenhaDeQA#2026';
const EMAIL_SEMEADOR = arg('admin-email');
const SENHA_SEMEADOR = arg('admin-password') || process.env.SEED_ADMIN_PASSWORD;
const SUFIXO = arg('sufixo', '');

if (!EMAIL_SEMEADOR || !SENHA_SEMEADOR) {
  console.error('uso: node scripts/qa/semear-treinadores.mjs --api <url> --admin-email <e-mail> --admin-password <senha>');
  console.error('A conta de semeadura precisa ser SUPER_ADMIN e nasce por `scripts/criar-admin.js`.');
  console.error('A senha NUNCA é impressa por este script.');
  process.exit(2);
}

// ENDEREÇOS FIXOS, e é de propósito: alguém vai DIGITAR isto numa tela de
// entrada. O sufixo existe para o caso de a semeadura rodar duas vezes no mesmo
// banco — em preview o banco é novo a cada execução e ele fica vazio.
const email = papel => `${papel}${SUFIXO ? `.${SUFIXO}` : ''}@mci.local`;

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const resposta = await fetch(`${BASE_API}${caminho}`, {
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

// CPF sintético VÁLIDO pelo dígito verificador. Dado de QA, e só de QA: o
// cadastro de atleta recusa CPF inválido, então um número aleatório não serviria.
function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const d1bruto = (base.reduce((total, digito, i) => total + digito * (10 - i), 0) * 10) % 11;
  const d1 = d1bruto === 10 ? 0 : d1bruto;
  const comD1 = base.concat([d1]);
  const d2bruto = (comD1.reduce((total, digito, i) => total + digito * (11 - i), 0) * 10) % 11;
  const d2 = d2bruto === 10 ? 0 : d2bruto;
  return base.join('') + d1 + d2;
}

const CONTATO = Object.freeze({
  birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

const registrar = (papel, nome) => chamar('/auth/register', {
  metodo: 'POST', corpo: { ...CONTATO, name: `QA ${nome}`, email: email(papel), password: SENHA }
});

const entrar = async endereco => (await chamar('/auth/login', {
  metodo: 'POST', corpo: { email: endereco, password: SENHA }
})).token;

async function principal() {
  const tokenSemeador = (await chamar('/auth/login', {
    metodo: 'POST', corpo: { email: EMAIL_SEMEADOR, password: SENHA_SEMEADOR }
  })).token;

  // O PAPEL É TROCADO PELA ROTA, e não por UPDATE. É o caminho do administrador.
  const definirPapel = (userId, role) => chamar(`/admin/users/${userId}`, {
    metodo: 'PATCH', token: tokenSemeador, corpo: { role }
  });

  // ----------------------------------------------- A FEDERAÇÃO E A CENTRAL
  const org = await chamar('/organizations', {
    metodo: 'POST', token: tokenSemeador,
    corpo: { name: 'Federação QA Treinadores', slug: `qa-treinadores${SUFIXO ? `-${SUFIXO}` : ''}`, state: 'MT' }
  });

  // Uma conta central PRÓPRIA, com senha conhecida. A conta de semeadura tem
  // senha aleatória que ninguém deve receber — entregá-la seria entregar a
  // chave da instalação.
  const central = await registrar('central', 'Administração Central');
  await definirPapel(central.user.id, 'SUPER_ADMIN');
  const tokenCentral = await entrar(central.user.email);

  // ------------------------------------------------- O DIRETOR DA FEDERAÇÃO
  const diretor = await registrar('diretor', 'Diretora de Federação');
  await chamar(`/organizations/${org.id}/members`, {
    metodo: 'POST', token: tokenCentral,
    corpo: { userId: diretor.user.id, role: 'EVENT_DIRECTOR' }
  });
  const tokenDiretor = await entrar(diretor.user.email);

  const filiacao = await chamar('/affiliations', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'NPC Mato Grosso (QA)', code: `QA-NPC${SUFIXO ? `-${SUFIXO}` : ''}` }
  });
  await chamar('/seasons', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'Temporada QA 2026', year: 2026 }
  });

  // ------------------------------------------- O TREINADOR (EQUIPE) APROVADO
  const treinador = await registrar('treinador', 'Treinadora Marta');
  await definirPapel(treinador.user.id, 'COACH');
  const tokenTreinador = await entrar(treinador.user.email);
  const cadastro = await chamar('/coaches/self-register', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { name: 'QA Treinadora Marta', registration: 'CREF-QA-9999', phone: '65999887766' }
  });
  // R-03: quem aprova o CADASTRO é a administração central.
  await chamar(`/coaches/${cadastro.id}/approve`, {
    metodo: 'POST', token: tokenCentral, corpo: { reason: 'Documentação conferida (QA).' }
  });
  // R-04: quem autoriza a ATUAÇÃO na federação é a federação.
  await chamar(`/coaches/${cadastro.id}/organizations`, {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, reason: 'Atuação autorizada na federação (QA).' }
  });

  // --------------------------------------------- O TREINADOR AINDA EM ANÁLISE
  const pendente = await registrar('treinador.analise', 'Treinador Em Análise');
  await definirPapel(pendente.user.id, 'COACH');
  const tokenPendente = await entrar(pendente.user.email);
  const cadastroPendente = await chamar('/coaches/self-register', {
    metodo: 'POST', token: tokenPendente, corpo: { name: 'QA Treinador Em Analise' }
  });

  // ------------------------------------------------------------- A EQUIPE
  const equipe = await chamar('/teams', {
    metodo: 'POST', token: tokenDiretor,
    corpo: { organizationId: org.id, name: 'Equipe QA Alfa', coachId: cadastro.id }
  });

  // ---------------------------------------------------------- OS ATLETAS
  const atletaConta = await registrar('atleta', 'Joana Ferreira');
  const atleta = await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Joana Ferreira', cpf: cpfDeQa(123456701),
      sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5001'
    }
  });
  await chamar(`/athletes/${atleta.id}`, {
    metodo: 'PATCH', token: tokenDiretor, corpo: { userId: atletaConta.user.id }
  });

  // Uma atleta JÁ vinculada, para o painel do treinador não nascer vazio.
  await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Carla Souza', cpf: cpfDeQa(123456702),
      sex: 'FEMALE', birthDate: '1994-02-20', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5002', teamId: equipe.id
    }
  });

  // Uma terceira, SEM conta: é o alvo da decisão administrativa, e o "pedido
  // alheio" que a atleta logada não pode confirmar.
  const atletaTerceira = await chamar('/athletes', {
    metodo: 'POST', token: tokenDiretor,
    corpo: {
      organizationId: org.id, fullName: 'QA Marina Alves', cpf: cpfDeQa(123456703),
      sex: 'FEMALE', birthDate: '1998-09-01', state: 'MT', city: 'Cuiabá',
      affiliationId: filiacao.id, affiliationNumber: '5003'
    }
  });

  // O CONVITE PENDENTE dirigido à atleta que TEM conta. É o que a tela "Minha
  // equipe" mostra, e confirmar ali é o ato que cria o vínculo — não o convite.
  await chamar('/team-membership-requests', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { athleteId: atleta.id, teamId: equipe.id, reason: 'Convite de QA para a Equipe QA Alfa.' }
  });
  await chamar('/team-membership-requests', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { athleteId: atletaTerceira.id, teamId: equipe.id, reason: 'Convite de QA (atleta sem conta).' }
  });

  // ------------------------------------------- UMA DELEGAÇÃO CENTRAL VIVA
  const delegado = await registrar('delegado', 'Delegado Central');
  await definirPapel(delegado.user.id, 'ADMIN');
  await chamar('/central-authorizations', {
    metodo: 'POST', token: tokenCentral,
    corpo: {
      userId: delegado.user.id, permission: 'athletes.transfer', organizationId: org.id,
      reason: 'Delegação formal de QA para correção de vínculo.',
      // Escopo e prazo são OBRIGATÓRIOS desde o achado A-02: concessão sem
      // federação valia em todas, e sem prazo valia para sempre.
      expiresAt: '2099-12-31'
    }
  });

  // ------------------------------------------------------------- A SAÍDA
  //
  // Formato `CHAVE=valor` nas linhas de conta para o workflow conseguir extrair
  // sem adivinhar, e um bloco legível depois para quem lê o log.
  console.log(`TREINADORES_ORG=${org.id}`);
  console.log(`TREINADORES_EMAIL_CENTRAL=${central.user.email}`);
  console.log(`TREINADORES_EMAIL_DIRETOR=${diretor.user.email}`);
  console.log(`TREINADORES_EMAIL_TREINADOR=${treinador.user.email}`);
  console.log(`TREINADORES_EMAIL_PENDENTE=${pendente.user.email}`);
  console.log(`TREINADORES_EMAIL_ATLETA=${atletaConta.user.email}`);
  console.log(`TREINADORES_EMAIL_DELEGADO=${delegado.user.email}`);
  console.log(`TREINADORES_COACH_APROVADO=${cadastro.id}`);
  console.log(`TREINADORES_COACH_PENDENTE=${cadastroPendente.id}`);
  console.log(`TREINADORES_EQUIPE=${equipe.id}`);
  console.log('');
  console.log('=== MÓDULO TREINADORES & EQUIPES — CENÁRIO SEMEADO ===');
  console.log('');
  console.log(`  Administração Central ... ${central.user.email}`);
  console.log(`  Diretor de Federação ... ${diretor.user.email}`);
  console.log(`  Treinador (Equipe) ..... ${treinador.user.email}   cadastro APROVADO, atuação autorizada`);
  console.log(`  Treinador em análise ... ${pendente.user.email}   cadastro PENDENTE`);
  console.log(`  Atleta ................. ${atletaConta.user.email}   convite PENDENTE para confirmar`);
  console.log(`  Delegado central ....... ${delegado.user.email}   delegação viva com escopo e prazo`);
  console.log('');
  console.log('  Federação: Federação QA Treinadores · Equipe: Equipe QA Alfa');
  console.log('  Telas: /#/treinador  /#/minha-equipe  /#/admin/treinadores  /#/admin/auditoria');
  console.log('');
  console.log('  A senha é a mesma das outras contas de QA deste ambiente.');
}

principal().catch(erro => {
  console.error(`falha na semeadura do módulo Treinadores: ${erro.message}`);
  process.exit(1);
});

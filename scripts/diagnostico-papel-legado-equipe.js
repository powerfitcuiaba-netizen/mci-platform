#!/usr/bin/env node
// ==========================================================================
// DIAGNÓSTICO SOMENTE LEITURA — CONTAS COM O PAPEL LEGADO `TEAM`.
//
// POR QUE ESTE SCRIPT EXISTE
//
// A decisão aprovada unificou as duas ofertas de cadastro — "Coach" e "Equipe" —
// numa só: **Treinador (Equipe)**, que é o papel `COACH`. `TEAM` saiu de
// `PAPEIS_DE_CADASTRO_ABERTO` e ninguém mais nasce com ele.
//
// O QUE A UNIFICAÇÃO NÃO FAZ, DE PROPÓSITO: converter as contas que já têm
// `TEAM`. Medido em `src/utils/permissions.js`: `TEAM: operacional()` dá as 14
// leituras de `BASE_AUTENTICADO` — as mesmas de qualquer conta autenticada — e
// NENHUMA permissão de treinador; `COACH: operacional(...)` dá as mesmas 14 MAIS
// cinco (`registrations.read`, `coaches.read_own`, `teams.read_own`,
// `athletes.lookup_affiliation`, `teams.request_membership`). Converter
// automaticamente seria AMPLIAR privilégio de contas reais sem a aprovação
// central que R-03 exige, sem motivo registrado e sem trilha de quem decidiu. A
// plataforma não faz isso por migration, e este script não faz por script.
//
// ESTE SCRIPT NÃO ALTERA NADA. Ele responde três perguntas que a mesa central
// precisa responder para decidir conta por conta:
//
//   1. quantas contas têm o papel legado;
//   2. quais delas JÁ têm cadastro de treinador (essas só precisam do papel
//      trocado para enxergar a própria área; a decisão cadastral já existe);
//   3. quais NÃO têm — essas precisam pedir o cadastro pela rota e esperar a
//      análise central, que é o caminho normal.
//
//     node scripts/diagnostico-papel-legado-equipe.js
//
// `User` NÃO TEM RLS, então esta leitura não depende de contexto de sessão — ao
// contrário de `CentralAuthorization`, que tem FORCE RLS e exige
// `mci.user_id`. Por isso aqui não há id de administrador a informar: se
// houvesse, seria teatro.
//
// NENHUM SEGREDO É IMPRESSO: a DATABASE_URL não aparece, nem parcialmente. Não
// sai e-mail de ninguém — a linha traz id e nome, que é o que identifica a quem
// falar.
// ==========================================================================

// A URL É LIDA DO AMBIENTE **ANTES** DO `require`, e isso não é estilo.
//
// `require('@prisma/client')` carrega o arquivo `.env` para dentro de
// `process.env`. Medido nos outros dois diagnósticos: numa máquina com `.env`
// presente, rodar sem `DATABASE_URL` no ambiente NÃO falhava — o script
// conectava no banco do `.env` e imprimia números plausíveis DE OUTRO BANCO, sem
// dizer qual havia lido.
const URL_DO_AMBIENTE = process.env.DATABASE_URL;

const { PrismaClient } = require('@prisma/client');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const AMARELO = s => `\x1b[33m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

const PAPEL_LEGADO = 'TEAM';

async function principal() {
  if (!URL_DO_AMBIENTE) {
    console.error('DATABASE_URL ausente no ambiente. Rode no mesmo ambiente da aplicação.');
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();
  try {
    // O NOME DO BANCO NA SAÍDA. Nome de banco não é segredo — a credencial é —, e
    // sem ele a evidência guardada não diz de onde veio.
    const [{ banco }] = await prisma.$queryRaw`SELECT current_database() AS banco`;
    console.log(`banco consultado: ${banco}\n`);

    const contas = await prisma.user.findMany({
      where: { role: PAPEL_LEGADO },
      select: {
        id: true, name: true, status: true, createdAt: true,
        coach: { select: { id: true, status: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    // `coach` é relação de um-para-um por `Coach.userId`. Quando a conta não tem
    // cadastro, o Prisma devolve `null` — e é essa diferença que separa os dois
    // caminhos administrativos.
    const comCadastro = contas.filter(c => c.coach);
    const semCadastro = contas.filter(c => !c.coach);

    console.log('=== CONTAS COM O PAPEL LEGADO `TEAM` ===\n');
    console.log(`total ......................................... ${contas.length}`);
    console.log(`${AMARELO('já possuem cadastro de treinador')} .............. ${comCadastro.length}`);
    console.log(`${CINZA('sem cadastro de treinador')} ..................... ${semCadastro.length}\n`);

    const detalhar = (titulo, linhas, comSituacaoCadastral) => {
      if (!linhas.length) return;
      console.log(`--- ${titulo} ---`);
      for (const c of linhas) {
        console.log(
          `  ${c.id}  ${c.name}`
          + `  conta=${c.status}`
          + (comSituacaoCadastral ? `  cadastro=${c.coach.status}` : '')
          + `  criada=${new Date(c.createdAt).toISOString().slice(0, 10)}`
        );
      }
      console.log('');
    };

    detalhar('JÁ TÊM CADASTRO DE TREINADOR', comCadastro, true);
    detalhar('SEM CADASTRO DE TREINADOR', semCadastro, false);

    if (!contas.length) {
      console.log(VERDE('NENHUMA conta tem o papel legado: a unificação não deixa ninguém para trás aqui.'));
      return;
    }

    console.log(AMARELO(`${contas.length} conta(s) seguem com o papel legado \`TEAM\`.`));
    console.log('');
    console.log('NADA É CONVERTIDO AUTOMATICAMENTE, e a razão é de privilégio: `TEAM` não tem');
    console.log('nenhuma permissão de treinador, e `COACH` tem cinco. Trocar o papel em massa');
    console.log('concederia área de treinador a contas que nunca passaram pela aprovação');
    console.log('central (R-03).');
    console.log('');
    console.log('Caminho para quem JÁ tem cadastro de treinador: a administração central troca o');
    console.log('papel da conta para Treinador (Equipe) em `PATCH /admin/users/:id`, uma a uma —');
    console.log('a trilha registra quem decidiu.');
    console.log('');
    console.log('Caminho para quem NÃO tem: a pessoa pede o cadastro na própria área e a');
    console.log('administração central analisa. É o fluxo normal, sem atalho.');
    // Saída 1 para o script ser usável como porta de deploy: há decisão humana
    // pendente. Ela não impede a publicação da unificação — impede considerar a
    // migração dessas contas como "já resolvida".
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch(erro => {
  // A mensagem do Prisma pode carregar a URL de conexão; aqui sai só o código.
  console.error(`falha no diagnóstico: ${erro.code ?? erro.name ?? 'erro'}`);
  process.exitCode = 2;
});

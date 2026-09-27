import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O DIAGNÓSTICO QUE DECIDE SE A MIGRATION PODE SUBIR.
//
// `20260927030000` devolve a PENDING os cadastros aprovados SEM revisor e SEM
// data de revisão — os que nenhuma pessoa decidiu. O diagnóstico existe para
// dizer, ANTES do deploy, quantos são e quais estão em uso, porque esses param
// de atuar no instante em que a migration roda.
//
// O predicado dele precisa ser o MESMO da migration. Se divergirem, o
// diagnóstico deixa de diagnosticar o que vai acontecer — e ninguém nota, porque
// os dois continuam respondendo.
//
// Esta suíte roda o script como PROCESSO: é a execução que decide o deploy.
// ============================================================================

const SCRIPT = 'scripts/diagnostico-treinadores-legados.js';

// eslint-disable-next-line no-control-regex
const semCor = texto => texto.replace(/\u001b\[[0-9;]*m/g, '');

function rodar({ semAmbiente = false } = {}) {
  const env = { ...process.env };
  if (semAmbiente) delete env.DATABASE_URL;
  try {
    return { codigo: 0, saida: semCor(execFileSync('node', [SCRIPT], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (erro) {
    return { codigo: erro.status, saida: semCor(`${erro.stdout ?? ''}${erro.stderr ?? ''}`) };
  }
}

let admin;
let orgA;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  orgA = (await criarOrganizacao(admin, { name: unico('Federação A') })).id;
});

// Aprovado POR MIGRATION: sem revisor e sem data — foi o que A-05 encontrou.
const legado = (nome, extras = {}) => comoAtor(admin, tx => tx.coach.create({
  data: { name: nome, status: 'APPROVED', ...extras },
  select: { id: true }
}));

// Aprovado POR PESSOA: com revisor e data, que só `coachService.transicionar`
// escreve. A migration não toca nestes.
const decididoPorPessoa = nome => comoAtor(admin, tx => tx.coach.create({
  data: { name: nome, status: 'APPROVED', reviewedById: admin.id, reviewedAt: new Date() },
  select: { id: true }
}));

// REVISÃO PELA METADE: um dos dois campos preenchido, o outro não.
//
// `reviewedById` e `reviewedAt` são colunas independentes e as duas aceitam
// nulo. A migration 20260927030000 só devolve a PENDING a linha em que AMBOS
// são nulos (`"reviewedById" IS NULL AND "reviewedAt" IS NULL`), então uma
// linha com apenas um deles preenchido NÃO é tocada — e o diagnóstico tem de
// concordar com a migration, não com metade dela.
const revisaoPelaMetade = (nome, metade) => comoAtor(admin, tx => tx.coach.create({
  data: {
    name: nome,
    status: 'APPROVED',
    reviewedById: metade === 'so-revisor' ? admin.id : null,
    reviewedAt: metade === 'so-data' ? new Date() : null
  },
  select: { id: true }
}));

describe('diagnóstico de treinadores legados', () => {
  it('banco sem cadastro legado: a migration não terá efeito, e ele diz isso', async () => {
    await decididoPorPessoa('Marta Decidida');

    const { codigo, saida } = rodar();
    expect(saida).toMatch(/aprovados COM revisor \(não serão tocados\)[ .]*1/);
    expect(saida).toMatch(/aprovados SEM revisor \(voltam a PENDING\)[ .]*0/);
    expect(saida).toMatch(/NENHUM cadastro volta a pendente/);
    expect(codigo, 'sem decisão pendente, o deploy não é barrado').toBe(0);
  });

  it('cadastro legado é contado, nomeado e barra o deploy com código 1', async () => {
    await legado('Carlos Legado');
    await decididoPorPessoa('Marta Decidida');

    const { codigo, saida } = rodar();
    expect(saida).toMatch(/aprovados SEM revisor \(voltam a PENDING\)[ .]*1/);
    expect(saida).toMatch(/--- VOLTAM A PENDING ---/);
    expect(saida, 'o nome aparece porque é o que diz a quem falar').toContain('Carlos Legado');
    expect(saida, 'e quem foi decidido por pessoa NÃO aparece na lista').not.toMatch(/Marta Decidida\s+criado/);
    expect(codigo, 'há decisão humana pendente antes de publicar').toBe(1);
  });

  it('EM USO é o que separa incômodo de interrupção', async () => {
    // Um legado com equipe para pela migration; um legado sem nada, não.
    const comEquipe = await legado('Treinador Com Equipe');
    await legado('Treinador Sem Uso');
    await comoAtor(admin, tx => tx.team.create({
      data: { name: unico('Equipe'), organizationId: orgA, coachId: comEquipe.id },
      select: { id: true }
    }));

    const { saida } = rodar();
    expect(saida).toMatch(/aprovados SEM revisor \(voltam a PENDING\)[ .]*2/);
    expect(saida).toMatch(/destes, EM USO \(equipe\/atleta\/federação\)[ .]*1/);
    expect(saida).toMatch(/Treinador Com Equipe.*EM USO: 1 equipe\(s\)/);
    expect(saida).toMatch(/Treinador Sem Uso.*sem uso registrado/);
  });

  it('a saída diz de qual banco veio', async () => {
    const { saida } = rodar();
    expect(saida, 'evidência que não identifica a base não é evidência').toMatch(/banco consultado: \w+/);
  });

  it('sem DATABASE_URL no ambiente ele RECUSA — o .env não pode salvá-lo', async () => {
    // `require('@prisma/client')` carrega o `.env` para `process.env`. Sem a
    // captura antes do `require`, este comando conectaria no banco do `.env` e
    // imprimiria números plausíveis de OUTRO banco.
    await legado('Carlos Legado');

    const { codigo, saida } = rodar({ semAmbiente: true });
    expect(codigo).toBe(2);
    expect(saida).toMatch(/DATABASE_URL ausente no ambiente/);
    expect(saida, 'e não relata nada sobre cadastro nenhum').not.toMatch(/VOLTAM A PENDING/);
  });

  it('revisão pela metade NÃO volta a pendente — o predicado exige os DOIS nulos', async () => {
    // Por que este teste existe: a mutação TE-L2 apaga `reviewedAt === null` do
    // predicado do diagnóstico e SOBREVIVIA, porque todo cadastro decidido nas
    // outras provas tem os dois campos preenchidos. Com os dois preenchidos,
    // apagar metade da condição não muda resposta nenhuma — e a barreira ficava
    // sem medida. Estas duas linhas são o único estado em que as duas metades do
    // predicado respondem coisas diferentes.
    await revisaoPelaMetade('Ana Somente Data', 'so-data');
    await revisaoPelaMetade('Bruno Somente Revisor', 'so-revisor');

    const { codigo, saida } = rodar();
    expect(saida, 'nenhuma das duas é tocada pela migration').toMatch(/aprovados SEM revisor \(voltam a PENDING\)[ .]*0/);
    expect(saida).toMatch(/aprovados COM revisor \(não serão tocados\)[ .]*2/);
    expect(saida, 'e portanto não há lista de regresso').not.toMatch(/--- VOLTAM A PENDING ---/);
    expect(saida).not.toContain('Ana Somente Data');
    expect(saida).not.toContain('Bruno Somente Revisor');
    expect(codigo, 'sem decisão pendente, o deploy não é barrado').toBe(0);
  });

  it('não imprime segredo nem contato de ninguém', async () => {
    await legado('Carlos Legado', { email: 'carlos@exemplo.org', phone: '65999990000' });

    const { saida } = rodar();
    expect(saida, 'a URL de conexão não aparece').not.toMatch(/postgres(ql)?:\/\//);
    expect(saida, 'nem e-mail').not.toMatch(/@/);
    expect(saida, 'nem telefone').not.toContain('65999990000');
  });
});

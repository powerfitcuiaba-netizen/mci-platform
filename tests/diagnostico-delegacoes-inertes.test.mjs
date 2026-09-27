import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O DIAGNÓSTICO DE DELEGAÇÕES INERTES PRECISA DE CONTEXTO PARA ENXERGAR.
//
// `CentralAuthorization` tem `FORCE ROW LEVEL SECURITY`, e `central_leitura`
// exige administração de plataforma ou dono da linha. Um `PrismaClient` cru não
// passa por `withUserContext`, então lê ZERO linhas — e a versão anterior do
// script relatava isso como "nenhuma concessão perde efeito", com código 0.
//
// Era a única pergunta que o script existia para responder, e ele respondia
// errado justamente no banco onde a resposta importa: produção, com RLS ativa.
//
// Esta suíte roda o script DE VERDADE, como processo, contra o banco de teste.
// Não simula o Prisma nem chama uma função interna: o que quebrou em produção
// foi a execução, e é a execução que precisa ficar medida.
// ============================================================================

const SCRIPT = 'scripts/diagnostico-delegacoes-inertes.js';

// O script é um processo: a saída dele é o que se mede, e o código de saída faz
// parte da resposta — 0 "não há", 1 "há decisão pendente", 2 "não consegui ler".
// A cor é do terminal, não da mensagem: sem tirá-la, `conformes (…)` e o número
// ficam separados por uma sequência de escape e a conferência falha por motivo
// nenhum.
// eslint-disable-next-line no-control-regex
const semCor = texto => texto.replace(/\u001b\[[0-9;]*m/g, '');

function rodar(...argumentos) {
  try {
    const saida = execFileSync('node', [SCRIPT, ...argumentos], {
      encoding: 'utf8', env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    return { codigo: 0, saida: semCor(saida) };
  } catch (erro) {
    return { codigo: erro.status, saida: semCor(`${erro.stdout ?? ''}${erro.stderr ?? ''}`) };
  }
}

let admin;
let comum;
let delegado;
let orgA;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  comum = await criarUsuario({ name: 'Conta Qualquer' });
  delegado = await criarUsuario({ role: 'ADMIN', name: 'Pessoa Delegada' });
  orgA = (await criarOrganizacao(admin, { name: unico('Federação A') })).id;
});

const plantar = ({ organizationId, expiresAt }) => comoAtor(admin, tx =>
  tx.centralAuthorization.create({
    data: {
      userId: delegado.id, permission: 'athletes.transfer',
      organizationId, expiresAt,
      reason: 'Linha gravada fora da rota, como um script antigo faria.',
      grantedById: admin.id,
      activeKey: `${delegado.id}:athletes.transfer:${organizationId ?? 'ALL'}`
    },
    select: { id: true }
  }));

describe('diagnóstico de delegações inertes', () => {
  it('sem id de administrador ele RECUSA, em vez de relatar ausência', async () => {
    await plantar({ organizationId: null, expiresAt: null });

    const { codigo, saida } = rodar();
    expect(codigo, 'não consigo ler é código 2, nunca 0').toBe(2);
    expect(saida).toMatch(/Informe o id de uma conta SUPER_ADMIN/);
    expect(saida, 'a saída explica que vazio não é ausência').toMatch(/não consigo ver/i);
    expect(saida, 'e não relata ausência de delegação').not.toMatch(/NENHUMA concessão viva/);
  });

  it('com contexto de administração central ele ENXERGA a concessão inerte', async () => {
    await plantar({ organizationId: null, expiresAt: '2099-12-31T00:00:00.000Z' });

    const { codigo, saida } = rodar(admin.id);
    expect(saida).toMatch(/total de linhas vivas[ .]*1/);
    expect(saida, 'a linha sem escopo é apontada').toMatch(/PERDEM EFEITO POR FALTA DE ESCOPO/);
    expect(saida).toMatch(/Pessoa Delegada/);
    expect(codigo, 'há decisão humana pendente antes de publicar').toBe(1);
  });

  it('a concessão CONFORME não é apontada como perda', async () => {
    await plantar({ organizationId: orgA, expiresAt: '2099-12-31T00:00:00.000Z' });

    const { codigo, saida } = rodar(admin.id);
    expect(saida).toMatch(/conformes \(escopo \+ prazo no futuro\)[ .]*1/);
    expect(saida).toMatch(/NENHUMA concessão viva perde efeito/);
    expect(codigo).toBe(0);
  });

  it('com conta NÃO administradora ele recusa — leitura parcial não é diagnóstico', async () => {
    // A conta comum leria apenas as concessões dela mesma. Apresentar isso como
    // o quadro inteiro é pior que não responder: parece resposta.
    await plantar({ organizationId: null, expiresAt: null });

    const { codigo, saida } = rodar(comum.id);
    expect(codigo).toBe(2);
    expect(saida).toMatch(/CONTA_NAO_ADMINISTRADORA/);
    expect(saida).not.toMatch(/NENHUMA concessão viva/);
  });

  it('`--listar-admins` dá o id sem exigir consulta improvisada', async () => {
    // Quem roda no Shell do Render precisa do id. Sem esta saída, escreveria um
    // `node -e` com Prisma na mão, perto da credencial — improviso ali é como
    // credencial vaza.
    const { codigo, saida } = rodar('--listar-admins');
    expect(codigo).toBe(0);
    expect(saida).toMatch(/CONTAS SUPER_ADMIN/);
    expect(saida, 'o id da conta central aparece').toContain(admin.id);
    expect(saida, 'e a conta comum NÃO aparece').not.toContain(comum.id);
    expect(saida, 'sem e-mail').not.toMatch(/@/);
  });

  it('não imprime segredo nem e-mail de ninguém', async () => {
    await plantar({ organizationId: null, expiresAt: null });

    const { saida } = rodar(admin.id);
    expect(saida, 'a URL de conexão não aparece').not.toMatch(/postgres(ql)?:\/\//);
    expect(saida, 'nem o e-mail de quem recebeu a delegação').not.toContain(delegado.email);
    expect(saida, 'nem arroba nenhum').not.toMatch(/@/);
  });

  it('a recusa por ausência de contexto NÃO é confundida com banco vazio', async () => {
    // Sem nenhuma concessão no banco, a resposta correta é "não há" com código
    // 0. É o contraste que dá sentido ao teste anterior: o script distingue os
    // dois casos, e antes desta correção ele não distinguia.
    const { codigo, saida } = rodar(admin.id);
    expect(saida).toMatch(/total de linhas vivas[ .]*0/);
    expect(saida).toMatch(/NENHUMA concessão viva perde efeito/);
    expect(codigo).toBe(0);
  });
});

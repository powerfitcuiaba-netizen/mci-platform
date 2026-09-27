import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { limparBanco, garantirCatalogo, criarUsuario, comoAtor, unico } from './helpers.mjs';

// ============================================================================
// O DIAGNÓSTICO QUE DIZ QUEM FICOU COM O PAPEL LEGADO DE EQUIPE.
//
// A unificação removeu `TEAM` da oferta de cadastro e NÃO converteu ninguém: a
// conversão ampliaria privilégio de contas reais sem a aprovação central que
// R-03 exige. Sobra uma pergunta administrativa — quem está nessa situação, e
// quem já tem cadastro de treinador —, e é essa que este script responde.
//
// Ele NÃO altera nada. Esta suíte o roda como PROCESSO, porque é a execução que
// a mesa central vai ler, e não a função.
// ============================================================================

const SCRIPT = 'scripts/diagnostico-papel-legado-equipe.js';

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

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
});

const comCadastroDeTreinador = async (conta, nome) => comoAtor(admin, tx => tx.coach.create({
  data: { userId: conta.id, name: nome, registration: unico('REG').slice(0, 24), status: 'PENDING' },
  select: { id: true }
}));

describe('diagnóstico do papel legado de equipe', () => {
  it('banco sem conta legada: ele diz que a unificação não deixa ninguém para trás', async () => {
    await criarUsuario({ role: 'COACH', name: 'Treinador Atual' });

    const { codigo, saida } = rodar();
    expect(saida).toMatch(/total[ .]*0/);
    expect(saida).toMatch(/NENHUMA conta tem o papel legado/);
    expect(codigo, 'sem decisão pendente, o deploy não é barrado').toBe(0);
  });

  it('separa quem JÁ tem cadastro de treinador de quem não tem — são dois caminhos diferentes', async () => {
    // Esta separação é o motivo de o script existir: quem já tem cadastro só
    // precisa do papel trocado; quem não tem precisa pedir e esperar análise.
    const pronta = await criarUsuario({ role: 'TEAM', name: 'Equipe Com Cadastro' });
    await criarUsuario({ role: 'TEAM', name: 'Equipe Sem Cadastro' });
    await comCadastroDeTreinador(pronta, 'Equipe Com Cadastro');

    const { codigo, saida } = rodar();
    expect(saida).toMatch(/total[ .]*2/);
    expect(saida).toMatch(/já possuem cadastro de treinador[ .]*1/);
    expect(saida).toMatch(/sem cadastro de treinador[ .]*1/);
    expect(saida).toMatch(/--- JÁ TÊM CADASTRO DE TREINADOR ---/);
    expect(saida).toMatch(/Equipe Com Cadastro.*cadastro=PENDING/);
    expect(saida).toMatch(/--- SEM CADASTRO DE TREINADOR ---/);
    expect(saida, 'o nome aparece porque é o que diz a quem falar').toContain('Equipe Sem Cadastro');
    expect(codigo, 'há decisão humana pendente conta por conta').toBe(1);
  });

  it('não conta quem não é legado — nem treinador, nem atleta, nem administração', async () => {
    await criarUsuario({ role: 'COACH', name: 'Treinador Atual' });
    await criarUsuario({ role: 'ATHLETE', name: 'Atleta Comum' });
    await criarUsuario({ role: 'GYM', name: 'Academia' });

    const { codigo, saida } = rodar();
    expect(saida).toMatch(/total[ .]*0/);
    expect(saida).not.toContain('Treinador Atual');
    expect(saida).not.toContain('Atleta Comum');
    expect(saida).not.toContain('Academia');
    expect(codigo).toBe(0);
  });

  it('não sugere conversão automática — diz que a decisão é da administração central', async () => {
    await criarUsuario({ role: 'TEAM', name: 'Equipe Legada' });

    const { saida } = rodar();
    expect(saida).toMatch(/NADA É CONVERTIDO AUTOMATICAMENTE/);
    expect(saida, 'a razão tem de estar escrita, não subentendida').toMatch(/R-03/);
    expect(saida).toMatch(/PATCH \/admin\/users\/:id/);
  });

  it('a saída diz de qual banco veio', async () => {
    const { saida } = rodar();
    expect(saida, 'evidência que não identifica a base não é evidência').toMatch(/banco consultado: \w+/);
  });

  it('sem DATABASE_URL no ambiente ele RECUSA — o .env não pode salvá-lo', async () => {
    // `require('@prisma/client')` carrega o `.env` para `process.env`. Sem a
    // captura antes do `require`, este comando conectaria no banco do `.env` e
    // imprimiria números plausíveis de OUTRO banco.
    await criarUsuario({ role: 'TEAM', name: 'Equipe Legada' });

    const { codigo, saida } = rodar({ semAmbiente: true });
    expect(codigo).toBe(2);
    expect(saida).toMatch(/DATABASE_URL ausente no ambiente/);
    expect(saida, 'e não relata nada sobre conta nenhuma').not.toMatch(/PAPEL LEGADO/);
  });

  it('não imprime segredo nem contato de ninguém', async () => {
    await criarUsuario({ role: 'TEAM', name: 'Equipe Legada' });

    const { saida } = rodar();
    expect(saida, 'a URL de conexão não aparece').not.toMatch(/postgres(ql)?:\/\//);
    expect(saida, 'nem e-mail').not.toMatch(/@/);
  });
});

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, gerarCpf
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { conferirIdentidades, aprovado } = require('../scripts/gate-de-identidade.js');
const adapter = require('../src/utils/musclewar/adapter.js');

// ==========================================================================
// O GATE QUE CORRE ANTES DA GRAVAÇÃO.
//
// A importação não cria atleta — é regra, não limitação: arquivo externo não
// fabrica identidade dentro do MCI. A consequência é que aplicar um lote numa
// base sem os atletas não dá erro: dá um lote inteiro em MATCH_PENDING e a
// impressão de que a importação "não funcionou".
//
// Este gate responde antes, e responde por quê. O que ele NUNCA pode fazer é
// resolver sozinho: nem criar atleta, nem escolher entre dois candidatos, nem
// aceitar um vínculo que só o nome sustenta.
// ==========================================================================

let admin, gerente, organizationId, npc, outraFiliacao;

const csv = linhas => [
  'Athlete #,Class,First Name,Last Name,Member Number,Placing', ...linhas
].join('\n');

const linha = (matricula, primeiro, ultimo, i = 1) =>
  `${i},Men's Bodybuilding - Novice,${primeiro},${ultimo},${matricula},1`;

const rodar = conteudo => comoAtor(gerente, tx => conferirIdentidades(tx, {
  registros: adapter.parse('CSV', conteudo, { defaultAffiliationCode: 'NPC' }),
  organizationId,
  affiliationCode: 'NPC'
}));

const cadastrar = (matricula, fullName, affiliationId, semente) => comoAtor(gerente, tx => tx.athlete.create({
  data: {
    organizationId, fullName, sex: 'MALE', affiliationId, affiliationNumber: matricula,
    identity: { create: { organizationId, cpf: gerarCpf(semente) } }
  }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;
  gerente = await criarUsuario({ name: 'Gerente' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'National Physique Committee', code: 'NPC' })).body;
  outraFiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' })).body;
});

describe('matrícula + filiação identificam', () => {
  it('atleta cadastrado na NPC com aquela matrícula sai MATCHED', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 501);
    const { linhas, resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('MATCHED');
    expect(linhas[0].athleteId).toBeTruthy();
    expect(linhas[0].affiliation).toBe('NPC');
    expect(resumo.MATCHED).toBe(1);
    expect(aprovado(resumo)).toBe(true);
  });

  it('o relatório conta as linhas do arquivo por atleta, não só os atletas', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 502);
    const { linhas } = await rodar(csv([
      `1,Men's Bodybuilding - Novice,Yuri,Santinelli,88281,1`,
      `2,Men's Classic Physique - Novice,Yuri,Santinelli,88281,1`
    ]));
    expect(linhas).toHaveLength(1);
    expect(linhas[0].linhasNoArquivo).toBe(2);
  });
});

describe('matrícula inexistente', () => {
  it('sai MATCH_PENDING, e não UNKNOWN nem CONFLICT', async () => {
    const { linhas, resumo } = await rodar(csv([linha('99999', 'Ninguem', 'Cadastrado')]));

    expect(linhas[0].status).toBe('MATCH_PENDING');
    expect(linhas[0].athleteId).toBeNull();
    expect(resumo.MATCH_PENDING).toBe(1);
    expect(aprovado(resumo)).toBe(false);
  });

  it('linha sem matrícula nenhuma sai UNKNOWN', async () => {
    const { linhas, resumo } = await rodar(csv([`1,Men's Bodybuilding - Novice,Sem,Matricula,,1`]));
    expect(linhas[0].status).toBe('UNKNOWN');
    expect(resumo.UNKNOWN).toBe(1);
    expect(aprovado(resumo)).toBe(false);
  });
});

describe('matrícula em filiação errada', () => {
  it('sai CONFLICT, dizendo sob qual filiação ela está', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', outraFiliacao.id, 503);
    const { linhas, resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('CONFLICT');
    expect(linhas[0].motivo).toMatch(/FED-MT/);
    expect(resumo.filiacoesDiferentes).toBe(1);
    expect(aprovado(resumo)).toBe(false);
  });

  it('nome idêntico NÃO salva um vínculo de filiação errada', async () => {
    // O nome bate perfeitamente. A filiação não. Bloqueia.
    await cadastrar('88281', 'YURI SANTINELLI', outraFiliacao.id, 504);
    const { linhas } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    expect(linhas[0].status).toBe('CONFLICT');
  });

  it('a filiação do lote não existir na organização é CONFLICT, não vínculo', async () => {
    await comoAtor(gerente, tx => tx.athlete.create({
      data: {
        organizationId, fullName: 'SEM FILIACAO', sex: 'MALE', affiliationNumber: '88281',
        identity: { create: { organizationId, cpf: gerarCpf(505) } }
      }
    }));
    const { linhas } = await comoAtor(gerente, tx => conferirIdentidades(tx, {
      registros: adapter.parse('CSV', csv([linha('88281', 'Yuri', 'Santinelli')]), { defaultAffiliationCode: 'IFBB' }),
      organizationId, affiliationCode: 'IFBB'
    }));
    expect(linhas[0].status).toBe('CONFLICT');
  });
});

describe('matrícula duplicada', () => {
  it('duas pessoas com a mesma matrícula é CONFLICT, e o gate não escolhe', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 506);
    await cadastrar('88281', 'OUTRO HOMONIMO', npc.id, 507);

    const { linhas, resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('CONFLICT');
    expect(linhas[0].motivo).toMatch(/duplicada/i);
    // Os dois candidatos aparecem: sem isso, "conflito" é uma frase.
    expect(linhas[0].motivo).toMatch(/YURI SANTINELLI/);
    expect(linhas[0].motivo).toMatch(/OUTRO HOMONIMO/);
    expect(linhas[0].athleteId).toBeNull();
    expect(resumo.matriculasDuplicadas).toBe(1);
    expect(aprovado(resumo)).toBe(false);
  });
});

describe('nome não é chave', () => {
  it('nome igual e matrícula ausente NÃO vira vínculo', async () => {
    // O atleta existe, com o nome exato. A matrícula do arquivo é outra.
    // Casar por nome aqui creditaria o resultado a quem o arquivo não indicou.
    await cadastrar('11111', 'YURI SANTINELLI', npc.id, 508);
    const { linhas } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('MATCH_PENDING');
    expect(linhas[0].athleteId).toBeNull();
  });

  it('nome divergente com matrícula e filiação certas continua MATCHED', async () => {
    // Nome de casada, abreviação, grafia da planilha: a matrícula identificou
    // sem ambiguidade, e derrubar o vínculo por causa do nome criaria trabalho
    // manual em cima de um caso que já está resolvido.
    await cadastrar('88281', 'YURI SANTINELLI DA SILVA', npc.id, 509);
    const { linhas, resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('MATCHED');
    expect(linhas[0].nomeDiverge).toBe(true);
    expect(resumo.divergenciasDeNome).toBe(1);
    // Divergência de nome NÃO reprova o gate.
    expect(aprovado(resumo)).toBe(true);
  });

  it('acento e caixa não contam como divergência', async () => {
    await cadastrar('88281', 'JOÃO GABRIEL FONSECA', npc.id, 510);
    const { linhas } = await rodar(csv([linha('88281', 'Joao', 'Gabriel Fonseca')]));
    expect(linhas[0].status).toBe('MATCHED');
    expect(linhas[0].nomeDiverge).toBe(false);
  });
});

describe('o gate não altera nada', () => {
  const contarTudo = () => comoAtor(gerente, async tx => ({
    atletas: await tx.athlete.count(),
    pontos: await tx.rankingPoint.count(),
    lotes: await tx.muscleWarImport.count(),
    itens: await tx.muscleWarImportItem.count(),
    resultados: await tx.externalResult.count()
  }));

  it('não cria atleta, nem ponto, nem lote — nem para os que faltam', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 511);
    const antes = await contarTudo();

    await rodar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1),
      linha('99999', 'Nao', 'Cadastrado', 2)
    ]));

    expect(await contarTudo()).toEqual(antes);
    expect(antes.pontos).toBe(0);
  });

  it('rodar três vezes dá exatamente o mesmo relatório', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 512);
    await cadastrar('147986', 'KANANDA AZEVEDO', outraFiliacao.id, 513);

    const arquivo = csv([
      linha('88281', 'Yuri', 'Santinelli', 1),
      linha('147986', 'Kananda', 'Azevedo', 2),
      linha('99999', 'Nao', 'Cadastrado', 3)
    ]);

    const primeira = await rodar(arquivo);
    const segunda = await rodar(arquivo);
    const terceira = await rodar(arquivo);

    expect(JSON.stringify(segunda.linhas)).toBe(JSON.stringify(primeira.linhas));
    expect(JSON.stringify(terceira.linhas)).toBe(JSON.stringify(primeira.linhas));
    expect(terceira.resumo).toEqual(primeira.resumo);
  });

  it('o estado do banco é o mesmo depois de três execuções', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 514);
    const antes = await contarTudo();
    const arquivo = csv([linha('88281', 'Yuri', 'Santinelli')]);

    await rodar(arquivo); await rodar(arquivo); await rodar(arquivo);

    expect(await contarTudo()).toEqual(antes);
  });
});

describe('o veredito do gate', () => {
  it('só aprova quando TODOS estão MATCHED', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 515);
    await cadastrar('147986', 'KANANDA AZEVEDO', npc.id, 516);

    const bom = await rodar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1), linha('147986', 'Kananda', 'Azevedo', 2)
    ]));
    expect(bom.resumo.MATCHED).toBe(2);
    expect(aprovado(bom.resumo)).toBe(true);

    // Um único pendente entre dois reprova o lote inteiro.
    const ruim = await rodar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1), linha('99999', 'Nao', 'Cadastrado', 2)
    ]));
    expect(aprovado(ruim.resumo)).toBe(false);
  });

  it('base vazia não é aprovação', async () => {
    const { resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));
    expect(aprovado(resumo)).toBe(false);
  });

  it('arquivo sem nenhum atleta não é aprovação por vacuidade', async () => {
    const { resumo } = await comoAtor(gerente, tx => conferirIdentidades(tx, {
      registros: [], organizationId, affiliationCode: 'NPC'
    }));
    expect(resumo.atletasDistintos).toBe(0);
    expect(aprovado(resumo)).toBe(false);
  });
});

describe('os status particionam o conjunto', () => {
  // É esta partição que autoriza `aprovado` a checar uma igualdade só. Sem ela
  // trancada aqui, um caminho novo de saída sem status passaria despercebido e
  // o gate aprovaria um lote com pendências.
  it('MATCHED + PENDING + CONFLICT + UNKNOWN sempre soma o total', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 517);        // MATCHED
    await cadastrar('147986', 'KANANDA AZEVEDO', outraFiliacao.id, 518); // CONFLICT (filiação)
    await cadastrar('155494', 'CAROLINA MARTINS', npc.id, 519);      // duplicada abaixo
    await cadastrar('155494', 'CAROLINA HOMONIMA', npc.id, 520);     // CONFLICT (duplicada)

    const { resumo } = await rodar(csv([
      linha('88281', 'Yuri', 'Santinelli', 1),
      linha('147986', 'Kananda', 'Azevedo', 2),
      linha('155494', 'Carolina', 'Martins', 3),
      linha('99999', 'Nao', 'Cadastrado', 4),
      `5,Men's Bodybuilding - Novice,Sem,Matricula,,1`
    ]));

    const soma = resumo.MATCHED + resumo.MATCH_PENDING + resumo.CONFLICT + resumo.UNKNOWN;
    expect(soma).toBe(resumo.atletasDistintos);
    expect(resumo).toMatchObject({
      atletasDistintos: 5, MATCHED: 1, MATCH_PENDING: 1, CONFLICT: 2, UNKNOWN: 1
    });
    expect(aprovado(resumo)).toBe(false);
  });
});

describe('o gate não enxerga outra organização', () => {
  it('atleta de outro tenant com a MESMA matrícula não vira vínculo', async () => {
    // O cenário que mais engana: a matrícula existe, o nome bate, e o atleta
    // pertence a outra organização. Reconhecê-lo creditaria o resultado a uma
    // pessoa de fora do campeonato — e a chave do arquivo não tem como dizer
    // isso ao operador.
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Vizinho' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Outra Federação' });
    const outroGerente = await criarUsuario({ name: 'Gerente Vizinho' });
    await vincular(outraOrg.id, outroGerente, 'REGISTRATION_OPERATOR');

    const filiacaoVizinha = (await api().post('/api/v1/affiliations').set(outroAdmin.auth())
      .send({ organizationId: outraOrg.id, name: 'NPC', code: 'NPC' })).body;

    await comoAtor(outroGerente, tx => tx.athlete.create({
      data: {
        organizationId: outraOrg.id, fullName: 'YURI SANTINELLI', sex: 'MALE',
        affiliationId: filiacaoVizinha.id, affiliationNumber: '88281',
        identity: { create: { organizationId: outraOrg.id, cpf: gerarCpf(521) } }
      }
    }));

    const { linhas, resumo } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    expect(linhas[0].status).toBe('MATCH_PENDING');
    expect(linhas[0].athleteId).toBeNull();
    expect(resumo.MATCHED).toBe(0);
    expect(aprovado(resumo)).toBe(false);
  });

  it('o atleta da organização certa é encontrado mesmo com o homônimo vizinho existindo', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Vizinho 2' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Terceira Federação' });
    const outroGerente = await criarUsuario({ name: 'Gerente Vizinho 2' });
    await vincular(outraOrg.id, outroGerente, 'REGISTRATION_OPERATOR');
    const filiacaoVizinha = (await api().post('/api/v1/affiliations').set(outroAdmin.auth())
      .send({ organizationId: outraOrg.id, name: 'NPC', code: 'NPC' })).body;

    await comoAtor(outroGerente, tx => tx.athlete.create({
      data: {
        organizationId: outraOrg.id, fullName: 'IMPOSTOR', sex: 'MALE',
        affiliationId: filiacaoVizinha.id, affiliationNumber: '88281',
        identity: { create: { organizationId: outraOrg.id, cpf: gerarCpf(522) } }
      }
    }));
    const meu = await cadastrar('88281', 'YURI SANTINELLI', npc.id, 523);

    const { linhas } = await rodar(csv([linha('88281', 'Yuri', 'Santinelli')]));

    // Um só candidato — o da minha organização. O vizinho não entra na conta,
    // nem como MATCHED nem como "duplicada".
    expect(linhas[0].status).toBe('MATCHED');
    expect(linhas[0].athleteId).toBe(meu.id);
  });
});

describe('o gate recusa correr sem contexto de RLS', () => {
  // MEDIDO, não suposto: a mesma consulta, pelas mesmas matrículas, devolveu
  // 0 atletas sob contexto de ator e 1 atleta DE OUTRA ORGANIZAÇÃO sem
  // contexto — porque a conexão de manutenção é dona do schema e o RLS não se
  // aplica a ela. Um gate que aceitasse rodar assim leria o banco inteiro com
  // privilégio de dono, tendo uma cláusula de aplicação como única barreira.
  const rodarScript = args => spawnSync(
    process.execPath, ['scripts/gate-de-identidade.js', ...args], { encoding: 'utf8', env: process.env }
  );

  it('sem --ator, recusa e explica por quê', () => {
    const r = rodarScript(['--csv', 'package.json', '--organizacao', 'x', '--filiacao', 'NPC']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--ator/);
    expect(r.stderr).toMatch(/OUTRAS organizações/);
  });

  it('a recusa vem antes de qualquer leitura do banco', () => {
    // Se a validação corresse depois da consulta, o vazamento já teria
    // acontecido quando a mensagem aparecesse.
    const r = rodarScript(['--organizacao', 'x', '--filiacao', 'NPC']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Faltam argumentos/);
  });
});

describe('o script, de ponta a ponta, pela linha de comando', () => {
  // Os testes acima chamam a função direto, com uma transação já sob contexto.
  // Isso deixa `principal()` sem cobertura — e é lá que mora a decisão de
  // abrir contexto de RLS. A suíte de mutação pegou exatamente isso: trocar
  // `withUserContext(ator, ...)` por `prisma` não quebrava nada.
  it('roda sob contexto de ator, e por isso não vê o homônimo de outro tenant', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin CLI' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Federação CLI' });
    const outroGerente = await criarUsuario({ name: 'Gerente CLI' });
    await vincular(outraOrg.id, outroGerente, 'REGISTRATION_OPERATOR');
    const filiacaoVizinha = (await api().post('/api/v1/affiliations').set(outroAdmin.auth())
      .send({ organizationId: outraOrg.id, name: 'NPC', code: 'NPC' })).body;

    // Mesma matrícula, outra organização. Sem RLS, a consulta acha os dois e o
    // gate reprova por "matrícula duplicada" — um falso conflito que pararia
    // uma importação legítima.
    await comoAtor(outroGerente, tx => tx.athlete.create({
      data: {
        organizationId: outraOrg.id, fullName: 'HOMONIMO DE OUTRO TENANT', sex: 'MALE',
        affiliationId: filiacaoVizinha.id, affiliationNumber: '88281',
        identity: { create: { organizationId: outraOrg.id, cpf: gerarCpf(524) } }
      }
    }));
    const meu = await cadastrar('88281', 'YURI SANTINELLI', npc.id, 525);

    const arquivo = join(tmpdir(), `gate-${Date.now()}.csv`);
    writeFileSync(arquivo, csv([linha('88281', 'Yuri', 'Santinelli')]));

    const r = spawnSync(process.execPath, [
      'scripts/gate-de-identidade.js',
      '--csv', arquivo, '--organizacao', organizationId, '--filiacao', 'NPC',
      '--ator', gerente.id, '--json'
    ], { encoding: 'utf8', env: process.env });

    rmSync(arquivo, { force: true });

    expect(r.stderr).toBe('');
    const saida = JSON.parse(r.stdout);
    expect(saida.linhas).toHaveLength(1);
    expect(saida.linhas[0].status).toBe('MATCHED');
    expect(saida.linhas[0].athleteId).toBe(meu.id);
    expect(saida.resumo.matriculasDuplicadas).toBe(0);
    // Gate aprovado sai com 0; reprovado sai com 1. É o que o torna utilizável
    // como porta num roteiro de operação, e não só relatório para ler.
    expect(r.status).toBe(0);
  }, 60000);

  it('sai com código 1 quando reprova, sem escrever nada', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 526);
    const antes = await comoAtor(gerente, tx => tx.athlete.count());

    const arquivo = join(tmpdir(), `gate-${Date.now()}-reprova.csv`);
    writeFileSync(arquivo, csv([
      linha('88281', 'Yuri', 'Santinelli', 1), linha('99999', 'Nao', 'Cadastrado', 2)
    ]));

    const r = spawnSync(process.execPath, [
      'scripts/gate-de-identidade.js',
      '--csv', arquivo, '--organizacao', organizationId, '--filiacao', 'NPC', '--ator', gerente.id
    ], { encoding: 'utf8', env: process.env });

    rmSync(arquivo, { force: true });

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/IDENTIDADE NÃO HOMOLOGADA/);
    expect(await comoAtor(gerente, tx => tx.athlete.count())).toBe(antes);
  }, 60000);

  it('aprovado imprime a frase que o gate exige, e nada além dela', async () => {
    await cadastrar('88281', 'YURI SANTINELLI', npc.id, 527);

    const arquivo = join(tmpdir(), `gate-${Date.now()}-aprova.csv`);
    writeFileSync(arquivo, csv([linha('88281', 'Yuri', 'Santinelli')]));

    const r = spawnSync(process.execPath, [
      'scripts/gate-de-identidade.js',
      '--csv', arquivo, '--organizacao', organizationId, '--filiacao', 'NPC', '--ator', gerente.id
    ], { encoding: 'utf8', env: process.env });

    rmSync(arquivo, { force: true });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/IDENTIDADE HOMOLOGADA — 1\/1 MATCHED — IMPORTAÇÃO AINDA NÃO APLICADA\./);
  }, 60000);
});

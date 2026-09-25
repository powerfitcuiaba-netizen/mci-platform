import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';

// ============================================================================
// OS DOIS COMANDOS OPERACIONAIS DE VÍNCULO DE CONTA DO ATLETA.
//
// O CASO REAL QUE ORIGINOU ESTE ARQUIVO
//
// Um cadastro foi feito em produção pelo AUTOCADASTRO enquanto a pessoa estava
// logada na conta administrativa dela. O autocadastro grava
// `userId: pedido.userId` no atleta que cria — a conta que abriu o pedido —, e
// o resultado é que "Meu Histórico" da conta administrativa passou a mostrar o
// atleta e o histórico importado dele.
//
// Desfazer isso é zerar UMA coluna (`Athlete.userId`); e devolver o atleta para
// a conta do próprio atleta é escrever a MESMA coluna com o id da conta dele.
// Não existe tela para nenhuma das duas: varredura por `userId` em
// `adminAtleta.jsx` e `adminAtletas.jsx` não acha nada. Existe a rota
// PATCH /athletes/:id — e usá-la à mão exige token, DevTools ou curl.
//
// `scripts/operacao/` é a resposta a isso: dois comandos que rodam no shell do
// ambiente (no Render, `/app`), chamam o SERVIÇO OFICIAL — `athleteService.update`,
// o mesmo que a rota usa: mesma autorização, mesma auditoria, mesma transação —,
// conferem pré-condições antes de escrever, e conferem o resultado depois.
//
// O QUE ESTE ARQUIVO TRAVA
//
// 1. Que a escrita seja CIRÚRGICA: a única diferença aceita no atleta é
//    `userId`; `RankingPoint` e `AthleteIdentity` não se movem.
// 2. Que as pré-condições ABORTEM de verdade — cada uma delas, uma a uma.
// 3. Que o modo leitura não escreva NADA.
// 4. Que a segunda execução seja idempotente.
// 5. Que o CPF nunca seja impresso: sai só uma impressão digital.
// 6. Que a RECEITA DE COLAGEM sobreviva ao heredoc do shell — é a parte que
//    quebra em silêncio, por causa dos backticks dos template literals, e que
//    nenhum teste do script em si veria.
// ============================================================================
const RAIZ = process.cwd();
const DESVINCULAR = path.join(RAIZ, 'scripts/operacao/desvincular-conta-do-atleta.js');
const VINCULAR = path.join(RAIZ, 'scripts/operacao/vincular-conta-do-atleta.js');

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
const MATRICULA = '2932';
const NOME = 'ATLETA DE TESTE QA';
const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999991234', whatsapp: '65988884321', postalCode: '78000000',
  addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

let admin;
let gerente;
let organizationId;
let seasonId;
let npc;
let atletaId;

/** Roda um comando de `scripts/operacao/` como o operador rodaria: `node <arquivo>`. */
function rodar(comando, ambiente) {
  return new Promise(resolve => {
    execFile(process.execPath, [comando], { cwd: RAIZ, env: { ...process.env, ...ambiente } },
      (erro, saida, erros) => resolve({ codigo: erro ? erro.code ?? 1 : 0, saida, erros }));
  });
}

/**
 * A RECEITA DE COLAGEM, montada a partir do arquivo REAL do repositório.
 *
 * É o que vai para o shell de produção quando a imagem em execução ainda não
 * tem `scripts/operacao/`: `cat > arquivo <<'FIM'` … `FIM`, e depois a chamada.
 * O delimitador entre aspas simples é o que faz o shell não tocar em nada —
 * inclusive nos backticks dos template literais do script.
 */
function receitaDeColagem(comando, ambiente) {
  const conteudo = readFileSync(comando, 'utf8');
  // O DELIMITADOR NÃO PODE APARECER NO CONTEÚDO. Se aparecesse, o heredoc
  // fecharia no meio do script e o shell tentaria executar o resto.
  expect(conteudo.split('\n'), 'o delimitador do heredoc não pode ser uma linha do script')
    .not.toContain('FIM');
  const destino = path.join(mkdtempSync(path.join(tmpdir(), 'mci-colagem-')), 'comando.js');
  const variaveis = Object.entries(ambiente).map(([k, v]) => `${k}='${v}'`).join(' ');
  return [
    `cd '${RAIZ}' && cat > '${destino}' <<'FIM'`,
    conteudo + 'FIM',
    `cd '${RAIZ}' && ${variaveis} node '${destino}'`,
    ''
  ].join('\n');
}

/** Cola a receita num shell de verdade, como o operador faria. */
function colar(comando, ambiente) {
  const script = path.join(mkdtempSync(path.join(tmpdir(), 'mci-bloco-')), 'bloco.sh');
  writeFileSync(script, receitaDeColagem(comando, ambiente));
  return new Promise(resolve => {
    // `cwd` de propósito FORA da aplicação: é o `cd` dentro do bloco que tem de
    // levar o comando ao lugar certo, e não o diretório de quem colou.
    execFile('bash', [script], { cwd: tmpdir(), env: { ...process.env } },
      (erro, saida, erros) => resolve({ codigo: erro ? erro.code ?? 1 : 0, saida, erros }));
  });
}

const userIdDoAtleta = () => comoAtor(admin, tx => tx.athlete.findUnique({
  where: { id: atletaId }, select: { userId: true }
})).then(a => a.userId);

const cadastrarPessoa = async nome => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

beforeAll(() => garantirCatalogo());

// O CENÁRIO DE PRODUÇÃO, reproduzido: histórico importado ANTES de o atleta
// existir, e o autocadastro feito pela conta administrativa.
beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  organizationId = (await criarOrganizacao(admin, {
    name: 'Federação Oficial', autocadastroAberto: true
  })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC - National Physique Committe', code: 'NPC', kind: 'ENTITY' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }]
  });

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
    content: [CABECALHO, `1,Women's Bikini - Open Class A,QA,DE TESTE,${MATRICULA},Brazil,25,1,90.0,1`].join('\n'),
    externalIdPrefix: 'IPIRANGA', defaultAffiliationCode: 'NPC'
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  expect((await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth())).status).toBe(200);

  const pedido = await api().post('/api/v1/athlete-requests').set(admin.auth()).send({
    fullName: NOME, cpf: gerarCpf(880001), sex: 'FEMALE', birthDate: '1998-07-15',
    affiliationId: npc.id, affiliationNumber: MATRICULA
  });
  expect(pedido.status, JSON.stringify(pedido.body).slice(0, 400)).toBe(201);

  atletaId = (await comoAtor(admin, tx => tx.athlete.findFirst({
    where: { affiliationId: npc.id, affiliationNumber: MATRICULA }, select: { id: true }
  }))).id;

  // A LINHA DE BASE DO CENÁRIO. Sem ela, os testes mediriam outra coisa.
  expect(await userIdDoAtleta(), 'o atleta nasceu ligado à conta administrativa').toBe(admin.id);
});

describe('desvincular-conta-do-atleta', () => {
  const ambiente = extra => ({
    ALVO_ATHLETE_ID: atletaId, ALVO_USER_ID: admin.id, ALVO_NOME: NOME, ...extra
  });
  const executar = extra => rodar(DESVINCULAR, ambiente(extra));

  it('sem APLICAR: é somente leitura, mostra o estado e aprova as pré-condições', async () => {
    const r = await executar();
    expect(r.codigo, r.erros).toBe(0);
    expect(r.saida).toContain('=== ESTADO ATUAL (somente leitura) ===');
    expect(r.saida).toContain(`athleteId          ${atletaId}`);
    expect(r.saida).toContain(`userId             ${admin.id}`);
    expect(r.saida).toContain('1 linha(s), soma 5 ponto(s)');
    expect(r.saida).toContain('MODO LEITURA. Nada foi escrito.');
    expect(r.saida).not.toContain('FALHOU');
    // O CPF NÃO APARECE: sai só a marca.
    expect(r.saida).toContain('11 dígitos, termina em');
    expect(r.saida).not.toMatch(/\b\d{11}\b/);
    expect(await userIdDoAtleta(), 'nada foi escrito').toBe(admin.id);
  });

  it('com APLICAR=sim: desvincula, e os dez vereditos passam', async () => {
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo, r.saida + r.erros).toBe(0);
    expect(r.saida).toContain('CONCLUÍDO — a correção foi aplicada e verificada.');
    expect(r.saida).not.toContain('FALHOU');
    expect((r.saida.match(/PASS {2}/g) ?? []).length, 'os dez vereditos').toBe(10);
    expect(r.saida).toContain('RankingPoints             1 -> 1 linha(s)');
    expect(r.saida).toContain('soma de pontos            5 -> 5');

    const atleta = await comoAtor(admin, tx => tx.athlete.findUnique({
      where: { id: atletaId }, select: { userId: true, status: true, affiliationNumber: true, affiliationId: true }
    }));
    expect(atleta.userId).toBeNull();
    expect(atleta.status).toBe('ACTIVE');
    expect(atleta.affiliationNumber).toBe(MATRICULA);
    expect(atleta.affiliationId).toBe(npc.id);
    expect(await comoAtor(admin, tx => tx.rankingPoint.count({ where: { athleteId: atletaId } }))).toBe(1);

    // "Meu Histórico" do admin não resolve mais atleta nenhum.
    const doAdmin = await api().get('/api/v1/me/history').set(admin.auth());
    expect(doAdmin.status).toBe(200);
    expect(doAdmin.body.athlete).toBeNull();
  });

  it('segunda execução: idempotente, não escreve e sai 0', async () => {
    expect((await executar({ APLICAR: 'sim' })).codigo).toBe(0);
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo, r.erros).toBe(0);
    expect(r.saida).toContain('JÁ DESVINCULADO: userId é null. Nada a fazer (idempotente).');
    expect(r.saida).not.toContain('CONCLUÍDO');
  });

  it('nome divergente: ABORTA sem escrever', async () => {
    const r = await executar({ ALVO_NOME: 'OUTRA PESSOA', APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('FALHOU  o nome confere exatamente');
    expect(r.erros).toContain('ABORTADO: pré-condição não satisfeita. NADA foi escrito.');
    expect(await userIdDoAtleta(), 'nada foi escrito').toBe(admin.id);
  });

  it('atleta inexistente: ABORTA sem escrever', async () => {
    const r = await executar({ ALVO_ATHLETE_ID: 'cmzzzzzzz0000zzzzzzzzzzzz', APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('não encontrado');
    expect(await userIdDoAtleta()).toBe(admin.id);
  });

  it('ator que não é administrador: ABORTA sem escrever', async () => {
    const r = await executar({ ALVO_USER_ID: gerente.id, APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('não é administrador');
    expect(await userIdDoAtleta()).toBe(admin.id);
  });

  it('ALVO_USER_ID de OUTRO administrador: ABORTA sem desvincular', async () => {
    // A LACUNA QUE UM MUTANTE ABRIU. Removi a pré-condição "o userId atual é o
    // esperado" e a suíte inteira continuou verde: nenhum teste passava um
    // ALVO_USER_ID que fosse administrador E não fosse o dono atual do atleta.
    //
    // Sem essa conferência, um id trocado na hora de colar o comando
    // desvincularia a conta que ESTIVER lá, seja ela qual for — silenciosamente,
    // porque `userId: null` não depende de quem é o dono.
    //
    // O ator aqui É administrador (a conferência de papel passa) e `mci_member_of`
    // devolve verdadeiro para qualquer administrador de plataforma, então a RLS
    // TAMBÉM deixa ele ver a linha. O único obstáculo é a pré-condição.
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Outro Diretor' });
    const r = await rodar(DESVINCULAR, {
      ALVO_ATHLETE_ID: atletaId, ALVO_USER_ID: outroAdmin.id, ALVO_NOME: NOME, APLICAR: 'sim'
    });
    expect(r.codigo).toBe(1);
    expect(r.saida, 'o atleta foi encontrado: não é a RLS que barra').toContain('=== ESTADO ATUAL');
    expect(r.saida).toContain('FALHOU  o userId atual é o esperado');
    expect(r.erros).toContain('ABORTADO: pré-condição não satisfeita. NADA foi escrito.');
    expect(await userIdDoAtleta(), 'a conta original segue lá').toBe(admin.id);
  });

  it('variável obrigatória ausente: ABORTA sem escrever', async () => {
    const r = await rodar(DESVINCULAR, { ...ambiente(), ALVO_NOME: '', APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('ALVO_NOME não definida');
    expect(await userIdDoAtleta()).toBe(admin.id);
  });
});

describe('vincular-conta-do-atleta', () => {
  let pessoa;

  // A ETAPA ANTERIOR JÁ FEITA: o atleta está sem conta.
  beforeEach(async () => {
    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A conta do PRÓPRIO atleta, criada por ele mesmo, com a senha dele.
    pessoa = await cadastrarPessoa('Atleta De Teste QA');
  });

  const ambiente = extra => ({
    ALVO_ATHLETE_ID: atletaId, ADMIN_USER_ID: admin.id, ALVO_NOME: NOME,
    ALVO_EMAIL: pessoa.email, ...extra
  });
  const executar = extra => rodar(VINCULAR, ambiente(extra));

  it('sem APLICAR: somente leitura, pré-condições todas aprovadas', async () => {
    const r = await executar();
    expect(r.codigo, r.erros).toBe(0);
    expect(r.saida).toContain('userId do atleta   null');
    expect(r.saida).toContain('atletas c/ matríc. 1');
    expect(r.saida).toContain('papel=ATHLETE status=ACTIVE');
    expect(r.saida).toContain('MODO LEITURA. Nada foi escrito.');
    expect(r.saida).not.toContain('FALHOU');
    expect(await userIdDoAtleta()).toBeNull();
  });

  it('com APLICAR=sim: vincula ao MESMO atleta, sem duplicar nada', async () => {
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo, r.saida + r.erros).toBe(0);
    expect(r.saida).toContain('CONCLUÍDO — a conta do atleta foi vinculada ao mesmo atleta e verificada.');
    expect(r.saida).not.toContain('FALHOU');
    expect((r.saida.match(/PASS {2}/g) ?? []).length, 'os onze vereditos').toBe(11);
    expect(r.saida).toContain('atletas com a matrícula   1 -> 1');
    expect(r.saida).toContain('soma de pontos            5 -> 5');

    expect(await userIdDoAtleta()).toBe(pessoa.id);
    expect(await comoAtor(admin, tx => tx.athlete.count()), 'nenhum atleta novo').toBe(1);
    expect(await comoAtor(admin, tx => tx.rankingPoint.count()), 'nenhum ponto novo').toBe(1);

    // O ATLETA VÊ O HISTÓRICO DELE, pela rota real, com o token dele.
    const hist = await api().get('/api/v1/me/history').set(pessoa.auth());
    expect(hist.status).toBe(200);
    expect(hist.body.athlete?.id).toBe(atletaId);
    expect(hist.body.total).toBe(1);
    expect(hist.body.totals.points).toBe(5);

    // E o admin não vê mais nada.
    expect((await api().get('/api/v1/me/history').set(admin.auth())).body.athlete).toBeNull();
  });

  it('segunda execução: idempotente', async () => {
    expect((await executar({ APLICAR: 'sim' })).codigo).toBe(0);
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo, r.erros).toBe(0);
    expect(r.saida).toContain('JÁ VINCULADO a esta conta. Nada a fazer (idempotente).');
  });

  it('atleta ainda ligado a outra conta: ABORTA sem escrever', async () => {
    expect((await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth())
      .send({ userId: admin.id })).status).toBe(200);
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('FALHOU  o atleta está SEM conta (userId null)');
    expect(r.erros).toContain('NADA foi escrito');
    expect(await userIdDoAtleta()).toBe(admin.id);
  });

  it('e-mail sem conta: ABORTA e diz o que o PRÓPRIO atleta precisa fazer', async () => {
    const r = await executar({ ALVO_EMAIL: 'ninguem@exemplo.test', APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.erros).toContain('não existe conta com o e-mail informado');
    expect(r.erros).toContain('O PRÓXIMO PASSO É DO ATLETA');
    expect(await userIdDoAtleta()).toBeNull();
  });

  it('conta que já é de outro atleta: ABORTA sem escrever', async () => {
    await comoAtor(admin, tx => tx.athlete.create({
      data: { organizationId, fullName: 'OUTRO ATLETA', sex: 'MALE', userId: pessoa.id, createdById: admin.id },
      select: { id: true }
    }));
    const r = await executar({ APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('FALHOU  a conta não é de outro atleta');
    expect(await userIdDoAtleta()).toBeNull();
  });

  it('conta administrativa como destino: ABORTA sem escrever', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Outro Diretor' });
    const r = await executar({ ALVO_EMAIL: outroAdmin.email, APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('FALHOU  a conta NÃO é administrativa');
    expect(await userIdDoAtleta()).toBeNull();
  });

  it('nome divergente: ABORTA sem escrever', async () => {
    const r = await executar({ ALVO_NOME: 'OUTRA PESSOA', APLICAR: 'sim' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('FALHOU  o nome confere exatamente');
    expect(await userIdDoAtleta()).toBeNull();
  });
});

describe('a receita de colagem, num shell de verdade', () => {
  it('a leitura da desvinculação sobrevive ao heredoc e não escreve', async () => {
    const r = await colar(DESVINCULAR, { ALVO_ATHLETE_ID: atletaId, ALVO_USER_ID: admin.id, ALVO_NOME: NOME });
    expect(r.codigo, r.saida + r.erros).toBe(0);
    expect(r.saida).toContain('=== ESTADO ATUAL (somente leitura) ===');
    expect(r.saida).toContain('MODO LEITURA. Nada foi escrito.');
    expect(r.saida).not.toContain('FALHOU');
    expect(await userIdDoAtleta(), 'nada foi escrito').toBe(admin.id);
  });

  it('a escrita da desvinculação, colada, aprova os dez vereditos', async () => {
    const r = await colar(DESVINCULAR, {
      APLICAR: 'sim', ALVO_ATHLETE_ID: atletaId, ALVO_USER_ID: admin.id, ALVO_NOME: NOME
    });
    expect(r.codigo, r.saida + r.erros).toBe(0);
    expect(r.saida).toContain('CONCLUÍDO — a correção foi aplicada e verificada.');
    expect((r.saida.match(/PASS {2}/g) ?? []).length).toBe(10);
    expect(await userIdDoAtleta()).toBeNull();
  });

  it('a vinculação, colada, devolve o MESMO atleta para a conta dele', async () => {
    expect((await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null })).status).toBe(200);
    const pessoa = await cadastrarPessoa('Atleta De Teste QA');
    const comum = { ALVO_ATHLETE_ID: atletaId, ADMIN_USER_ID: admin.id, ALVO_NOME: NOME, ALVO_EMAIL: pessoa.email };

    const leitura = await colar(VINCULAR, comum);
    expect(leitura.codigo, leitura.saida + leitura.erros).toBe(0);
    expect(leitura.saida).toContain('MODO LEITURA. Nada foi escrito.');
    expect(await userIdDoAtleta(), 'a leitura não escreveu').toBeNull();

    const escrita = await colar(VINCULAR, { ...comum, APLICAR: 'sim' });
    expect(escrita.codigo, escrita.saida + escrita.erros).toBe(0);
    expect(escrita.saida).toContain('CONCLUÍDO — a conta do atleta foi vinculada ao mesmo atleta e verificada.');
    expect((escrita.saida.match(/PASS {2}/g) ?? []).length).toBe(11);
    expect(await userIdDoAtleta()).toBe(pessoa.id);
    expect(await comoAtor(admin, tx => tx.athlete.count())).toBe(1);
    expect(await comoAtor(admin, tx => tx.rankingPoint.count())).toBe(1);
  });

  it('nenhum dos dois comandos carrega CPF, senha ou DATABASE_URL no texto', () => {
    for (const comando of [DESVINCULAR, VINCULAR]) {
      const texto = readFileSync(comando, 'utf8');
      expect(texto, comando).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
      expect(texto, comando).not.toMatch(/postgres(ql)?:\/\//);
      expect(texto, comando).not.toMatch(/DATABASE_URL/);
      expect(texto, comando).not.toMatch(/passwordHash|password\s*[:=]/);
      // O CPF é comparado e nunca impresso: o único caminho dele para a saída
      // é a impressão digital.
      if (/identidade\.cpf/.test(texto)) {
        expect(texto, comando).toMatch(/cpfMarca|createHash/);
      }
    }
  });
});

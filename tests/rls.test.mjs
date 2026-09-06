import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar, gerarCpf, comoAtor
} from './helpers.mjs';

// Row Level Security executado de verdade.
//
// A suíte conecta como `mci_app` — papel sem BYPASSRLS e que não é dono do
// schema — e consulta as tabelas diretamente, sem passar pela API. É a única
// forma de provar que a barreira é do banco, e não apenas do service.

const urlApp = process.env.RLS_DATABASE_URL
  || (process.env.DATABASE_URL || '').replace(/\/\/[^:]+:[^@]+@/, '//mci_app:mci_app_local_dev@');

const appClient = new PrismaClient({ datasources: { db: { url: urlApp } } });

// Executa consultas com o ator definido para a transação, como faz
// src/config/rlsSession.js em produção.
async function comoUsuario(userId, consulta) {
  return appClient.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('mci.user_id', ${String(userId ?? '')}, true)`;
    return consulta(tx);
  });
}

let ana;
let bruno;
let carla;

beforeAll(async () => {
  garantirCatalogo();
  // Falha alto se o papel de aplicação não existir: um RLS "testado" contra o
  // dono do schema não testaria nada.
  const [{ rolbypassrls: bypass }] = await appClient.$queryRawUnsafe(
    "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"
  );
  expect(bypass, 'o papel de teste não pode ter BYPASSRLS').toBe(false);
});

afterAll(() => appClient.$disconnect());

beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
  bruno = await criarUsuario({ name: 'Bruno' });
  carla = await criarUsuario({ name: 'Carla' });
});

describe('RLS — mensagens privadas', () => {
  it('participante lê a conversa; terceiro não enxerga uma linha sequer', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
    await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth())
      .send({ body: 'Conteúdo confidencial' });

    const comoAna = await comoUsuario(ana.id, tx => tx.message.findMany());
    expect(comoAna).toHaveLength(1);
    expect(comoAna[0].body).toBe('Conteúdo confidencial');

    const comoBruno = await comoUsuario(bruno.id, tx => tx.message.findMany());
    expect(comoBruno).toHaveLength(1);

    // Carla não participa: o banco não devolve a mensagem nem a conversa.
    const comoCarla = await comoUsuario(carla.id, tx => tx.message.findMany());
    expect(comoCarla).toHaveLength(0);

    const conversasDaCarla = await comoUsuario(carla.id, tx => tx.conversation.findMany());
    expect(conversasDaCarla).toHaveLength(0);
  });

  it('sem ator definido, nenhuma mensagem é visível — a política falha fechada', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
    await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth()).send({ body: 'x' });

    const semContexto = await appClient.message.findMany();
    expect(semContexto).toHaveLength(0);
  });

  it('terceiro não consegue inserir mensagem em conversa alheia nem pelo banco', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    await expect(comoUsuario(carla.id, tx => tx.message.create({
      data: { conversationId: conversa.body.id, senderId: carla.profileId, body: 'invasão' }
    }))).rejects.toThrow();
  });
});

describe('RLS — publicações', () => {
  it('publicação privada só é lida pelo autor', async () => {
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Privado', visibility: 'PRIVATE' });

    expect(await comoUsuario(ana.id, tx => tx.post.findMany())).toHaveLength(1);
    expect(await comoUsuario(bruno.id, tx => tx.post.findMany())).toHaveLength(0);
  });

  it('publicação para seguidores é lida por quem segue e por mais ninguém', async () => {
    const handleAna = (await prisma.socialProfile.findUnique({ where: { userId: ana.id } })).handle;
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Seguidores', visibility: 'FOLLOWERS' });
    await api().post(`/api/v1/social/profiles/${handleAna}/follow`).set(bruno.auth());

    expect(await comoUsuario(bruno.id, tx => tx.post.findMany())).toHaveLength(1);
    expect(await comoUsuario(carla.id, tx => tx.post.findMany())).toHaveLength(0);
  });

  it('publicação pública é lida por qualquer ator identificado', async () => {
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Pública', visibility: 'PUBLIC' });
    expect(await comoUsuario(carla.id, tx => tx.post.findMany())).toHaveLength(1);
  });
});

describe('RLS — dados restritos do campeonato', () => {
  let admin;
  let diretorA;
  let orgA;
  let diretorB;
  let orgB;

  beforeEach(async () => {
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

    diretorA = await criarUsuario({ name: 'Diretor A' });
    orgA = await criarOrganizacao(admin, { name: 'Federação A' });
    await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

    diretorB = await criarUsuario({ name: 'Diretor B' });
    orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    await vincular(orgB.id, diretorB, 'EVENT_DIRECTOR');
  });

  it('atleta de uma organização não é lido por operador de outra', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Da A', cpf: gerarCpf(191919191) });

    const vistoPorA = await comoUsuario(diretorA.id, tx => tx.athlete.findMany());
    expect(vistoPorA).toHaveLength(1);

    const vistoPorB = await comoUsuario(diretorB.id, tx => tx.athlete.findMany());
    expect(vistoPorB).toHaveLength(0);

    // Nem por id direto: a política não é um filtro de listagem.
    const porId = await comoUsuario(diretorB.id, tx => tx.athlete.findUnique({ where: { id: vistoPorA[0].id } }));
    expect(porId).toBeNull();
  });

  it('documento de atleta só é lido pelo dono e pelo operador da organização', async () => {
    const atletaUsuario = await criarUsuario({ name: 'Atleta com documento' });
    const atleta = await criarAtleta(diretorA, orgA.id, { fullName: 'Documentada', cpf: gerarCpf(181818181) });
    // O cenário é montado em nome do diretor da organização: com FORCE ligado,
    // nem o dono do schema escreve em tabela protegida sem ator definido.
    await comoAtor(diretorA, async tx => {
      await tx.athlete.update({ where: { id: atleta.id }, data: { userId: atletaUsuario.id } });
      await tx.athleteDocument.create({
        data: { athleteId: atleta.id, kind: 'MEDICAL', title: 'Atestado', fileName: 'a.pdf', storageKey: `teste/${atleta.id}.pdf`, sizeBytes: 10 }
      });
    });

    expect(await comoUsuario(atletaUsuario.id, tx => tx.athleteDocument.findMany())).toHaveLength(1);
    expect(await comoUsuario(diretorA.id, tx => tx.athleteDocument.findMany())).toHaveLength(1);
    expect(await comoUsuario(diretorB.id, tx => tx.athleteDocument.findMany())).toHaveLength(0);
    expect(await comoUsuario(bruno.id, tx => tx.athleteDocument.findMany())).toHaveLength(0);
  });

  it('resultado não publicado só é lido por operador da organização do evento', async () => {
    const juiz = await criarUsuario({ name: 'Juiz' });
    await vincular(orgA.id, juiz, 'JUDGE');

    const { event, competitionClass } = await criarEventoCompleto(diretorA, orgA.id);
    await transicionar(diretorA, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(171717171), athlete: { fullName: 'Competidora', sex: 'FEMALE' }, classIds: [competitionClass.id] });

    await transicionar(diretorA, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretorA.auth()).send({});
    await transicionar(diretorA, event.id, ['IN_JUDGING']);

    const painel = await api().post(`/api/v1/events/${event.id}/panels`).set(diretorA.auth()).send({ name: 'Painel' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: juiz.id, seat: 1, role: 'HEAD' });

    const sessao = await api().post('/api/v1/judging-sessions').set(diretorA.auth())
      .send({ classId: competitionClass.id, panelId: painel.body.id, round: 'FINALS' });
    const item = await prisma.registrationItem.findFirst({ where: { classId: competitionClass.id } });

    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juiz.auth())
      .send({ placings: [{ registrationItemId: item.id, placing: 1 }] });
    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretorA.auth());
    await api().post(`/api/v1/classes/${competitionClass.id}/result/calculate`).set(diretorA.auth());

    expect(await comoUsuario(diretorA.id, tx => tx.result.findMany())).toHaveLength(1);
    expect(await comoUsuario(diretorB.id, tx => tx.result.findMany())).toHaveLength(0);
    expect(await comoUsuario(bruno.id, tx => tx.result.findMany())).toHaveLength(0);

    // Publicado, passa a ser visível para qualquer ator.
    await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretorA.auth()).send({});
    expect(await comoUsuario(bruno.id, tx => tx.result.findMany())).toHaveLength(1);
  });

  it('notificação só é lida pelo destinatário', async () => {
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Post' });
    const post = await prisma.post.findFirst();
    await api().post(`/api/v1/social/posts/${post.id}/like`).set(bruno.auth());

    expect(await comoUsuario(ana.id, tx => tx.notification.findMany())).toHaveLength(1);
    expect(await comoUsuario(carla.id, tx => tx.notification.findMany())).toHaveLength(0);
  });

  it('auditoria fica restrita a administrador e ao operador da própria organização', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Auditada', cpf: gerarCpf(161616161) });

    const comoAdmin = await comoUsuario(admin.id, tx => tx.auditLog.findMany());
    expect(comoAdmin.length).toBeGreaterThan(0);

    // Sem papel operacional, nenhuma linha.
    expect(await comoUsuario(bruno.id, tx => tx.auditLog.findMany())).toHaveLength(0);

    // Diretor da outra federação vê a própria trilha, nunca a da organização A.
    const comoDiretorB = await comoUsuario(diretorB.id, tx => tx.auditLog.findMany());
    expect(comoDiretorB.every(linha => linha.organizationId === orgB.id)).toBe(true);
    expect(comoDiretorB.some(linha => linha.organizationId === orgA.id)).toBe(false);
  });

  it('lote de importação MuscleWar é restrito à organização', async () => {
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgA.id, gerente, 'RANKING_MANAGER');

    await comoAtor(gerente, tx => tx.muscleWarImport.create({
      data: { organizationId: orgA.id, sourceType: 'CSV', sourceRef: 'lote.csv', createdById: gerente.id }
    }));

    expect(await comoUsuario(gerente.id, tx => tx.muscleWarImport.findMany())).toHaveLength(1);
    expect(await comoUsuario(diretorB.id, tx => tx.muscleWarImport.findMany())).toHaveLength(0);
  });
});

describe('RLS — o CPF é protegido pela linha, não pela projeção', () => {
  let admin;
  let diretorA;
  let orgA;
  let diretorB;
  let orgB;

  beforeEach(async () => {
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

    diretorA = await criarUsuario({ name: 'Diretor A' });
    orgA = await criarOrganizacao(admin, { name: 'Federação A' });
    await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

    diretorB = await criarUsuario({ name: 'Diretor B' });
    orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    await vincular(orgB.id, diretorB, 'EVENT_DIRECTOR');
  });

  // O CPF vive em "AthleteIdentity" justamente porque o RLS é barreira de
  // linha e não de coluna. Enquanto morava em "Athlete" — cuja política
  // precisa liberar leitura anônima para o diretório público funcionar — o
  // número ficava ao alcance de qualquer visitante no nível do banco, e o que
  // o mantinha fora das respostas era a projeção do service. Estes testes
  // consultam o banco DIRETO, sem passar pela API, que é a única forma de
  // provar que a barreira mudou de lugar.

  it('visitante anônimo enxerga o atleta e não enxerga o CPF', async () => {
    const cpf = gerarCpf(919191911);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Exposta', cpf });

    const atletas = await comoUsuario(null, tx => tx.athlete.findMany());
    expect(atletas.length, 'o diretório público de atletas precisa continuar funcionando').toBeGreaterThanOrEqual(1);

    // A prova: nem um SELECT sem projeção nenhuma traz CPF, porque a LINHA
    // não vem. Não há como um serializador descuidado vazá-lo.
    const identidades = await comoUsuario(null, tx => tx.athleteIdentity.findMany());
    expect(identidades).toHaveLength(0);
    expect(JSON.stringify(atletas)).not.toContain(cpf);
  });

  it('operador da organização lê o CPF dos seus atletas', async () => {
    const cpf = gerarCpf(929292922);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Da casa', cpf });

    const identidades = await comoUsuario(diretorA.id, tx => tx.athleteIdentity.findMany());
    expect(identidades).toHaveLength(1);
    expect(identidades[0].cpf).toBe(cpf);
  });

  it('operador de outra organização não lê o CPF — nem conhecendo o atleta', async () => {
    const cpf = gerarCpf(939393933);
    const atleta = await criarAtleta(diretorA, orgA.id, { fullName: 'Da federação A', cpf });

    expect(await comoUsuario(diretorB.id, tx => tx.athleteIdentity.findMany())).toHaveLength(0);
    expect(await comoUsuario(diretorB.id, tx => tx.athleteIdentity.findUnique({ where: { athleteId: atleta.id } }))).toBeNull();
  });

  it('o próprio atleta lê o próprio CPF, e não o de outro', async () => {
    const usuarioAtleta = await criarUsuario({ name: 'Atleta dona do CPF' });
    const cpfDela = gerarCpf(949494944);
    const dela = await criarAtleta(diretorA, orgA.id, { fullName: 'Dona', cpf: cpfDela });
    await comoAtor(diretorA, tx => tx.athlete.update({ where: { id: dela.id }, data: { userId: usuarioAtleta.id } }));

    await criarAtleta(diretorA, orgA.id, { fullName: 'Outra', cpf: gerarCpf(959595955) });

    const visiveis = await comoUsuario(usuarioAtleta.id, tx => tx.athleteIdentity.findMany());
    expect(visiveis).toHaveLength(1);
    expect(visiveis[0].cpf).toBe(cpfDela);
  });

  it('terceiro autenticado sem vínculo não lê CPF nenhum', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Protegida', cpf: gerarCpf(969696966) });
    expect(await comoUsuario(bruno.id, tx => tx.athleteIdentity.findMany())).toHaveLength(0);
  });

  it('a rota pública do atleta continua respondendo, e sem o CPF', async () => {
    const cpf = gerarCpf(979797977);
    const atleta = await criarAtleta(diretorA, orgA.id, { fullName: 'Pública', cpf });

    const pagina = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(pagina.status).toBe(200);
    expect(JSON.stringify(pagina.body)).not.toContain(cpf);
  });
});

// FASE 12.6 — toda operação sensível está mesmo atrás de um guarda?
//
// Os testes de segurança existentes provam casos escolhidos a dedo: este
// diretor não cria evento naquela organização, aquele atleta não lê o CPF.
// Falta a varredura sistemática: 14 papéis × 18 operações sensíveis, cada uma
// por requisição HTTP real, mais o visitante anônimo.
//
// O QUE ESTE TESTE PROVA — e o que ele NÃO prova.
//
// A expectativa é derivada de `can(ator, permissão)`, a MESMA função que a
// rota consulta. Logo ele NÃO consegue flagrar divergência entre a matriz e a
// rota: se alguém conceder uma permissão a mais na matriz, os dois lados
// mudam juntos e o teste continua verde. Quem guarda a matriz é
// `unidade-dominio.test.mjs`, que fixa os valores esperados à mão.
//
// O que ele prova é outra coisa, e é o que faltava: que cada uma destas
// operações está REALMENTE atrás de um guarda. Uma rota que perca a
// verificação de permissão passa a responder 2xx (ou 404, ou 422) para papéis
// que deveriam levar 403 — e aí todo papel sem a permissão reprova de uma vez.
// Conferido removendo as duas camadas de guarda de `/audit`: 12 papéis
// reprovaram na hora.
//
// (Ao conferir, apareceu um detalhe que vale registrar: remover SÓ o
// middleware da rota não abre nada, porque o serviço confere de novo. A
// barreira é dupla de propósito.)
//
// Leitura das asserções:
//   - papel COM a permissão: a resposta pode ser qualquer coisa MENOS 403.
//     (422 por corpo incompleto, 404 por id inexistente — tudo bem: o que se
//      afirma é que a autorização não barrou.)
//   - papel SEM a permissão: tem de ser exatamente 403.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar, gerarCpf, unico
} from './helpers.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { can } = require('../src/utils/permissions.js');

// Papéis de organização: o vínculo é que concede, e é ele que a rota consulta.
const PAPEIS = [
  'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'RESULTS_OPERATOR', 'RANKING_MANAGER',
  'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR',
  'JUDGE_COORDINATOR', 'JUDGE', 'STAFF', 'SOCIAL_ADMIN', 'MODERATOR', 'COACH', 'ATHLETE'
];

let ctx = {};

// Cada sonda é uma requisição real a uma rota real, com a permissão que ela
// deveria exigir. Corpo mínimo: o objetivo é a autorização, não a validação.
const SONDAS = [
  { nome: 'criar evento', permissao: 'events.create',
    executar: (t) => api().post('/api/v1/events').set(t).send({ organizationId: ctx.orgId, name: 'Sonda', slug: unico('sonda'), startDate: '2026-12-01T12:00:00.000Z' }) },

  { nome: 'editar evento', permissao: 'events.update',
    executar: (t) => api().patch(`/api/v1/events/${ctx.eventId}`).set(t).send({ description: 'sonda' }) },

  { nome: 'cadastrar atleta', permissao: 'athletes.create',
    executar: (t) => api().post('/api/v1/athletes').set(t).send({ organizationId: ctx.orgId, fullName: 'Sonda Atleta', cpf: gerarCpf(), sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá' }) },

  { nome: 'consultar atleta por CPF', permissao: 'athletes.read_sensitive',
    executar: (t) => api().post('/api/v1/athletes/lookup').set(t).send({ organizationId: ctx.orgId, cpf: ctx.cpf }) },

  { nome: 'inscrever no evento', permissao: 'registrations.create',
    executar: (t) => api().post(`/api/v1/events/${ctx.eventId}/registrations`).set(t).send({ cpf: gerarCpf(), classIds: [ctx.classId] }) },

  { nome: 'fazer check-in', permissao: 'checkin.operate',
    executar: (t) => api().post(`/api/v1/registrations/${ctx.registrationId}/checkin`).set(t).send({}) },

  { nome: 'registrar pesagem', permissao: 'weighin.operate',
    executar: (t) => api().post(`/api/v1/registrations/${ctx.registrationId}/weighins`).set(t).send({ weightGrams: 56000 }) },

  { nome: 'emitir credencial', permissao: 'credentials.manage',
    executar: (t) => api().post(`/api/v1/events/${ctx.eventId}/credentials`).set(t).send({ type: 'ATHLETE', holderName: 'Sonda' }) },

  { nome: 'montar bateria', permissao: 'stage.manage',
    executar: (t) => api().post(`/api/v1/events/${ctx.eventId}/batches`).set(t).send({ name: 'Sonda', classId: ctx.classId }) },

  { nome: 'receber resultado externo', permissao: 'results.receive',
    executar: (t) => api().post(`/api/v1/classes/${ctx.classId}/result`).set(t).send({ entries: [{ athleteId: ctx.athleteId, placing: 1, status: 'RANKED' }], reason: 'sonda', source: 'EXTERNAL' }) },

  { nome: 'publicar resultado', permissao: 'results.publish',
    executar: (t) => api().post(`/api/v1/classes/${ctx.classId}/result/publish`).set(t).send({ reason: 'sonda de publicacao' }) },

  { nome: 'corrigir resultado publicado', permissao: 'results.override',
    executar: (t) => api().post(`/api/v1/classes/${ctx.classId}/result/override`).set(t).send({ reason: 'sonda de correcao', entries: [{ registrationItemId: ctx.registrationItemId, placing: 1, status: 'RANKED' }] }) },

  { nome: 'gravar tabela de pontos da temporada', permissao: 'ranking.manage',
    executar: (t) => api().put(`/api/v1/seasons/${ctx.seasonId}/points-rules`).set(t).send({ rules: [{ placing: 1, points: 5 }] }) },

  { nome: 'importar planilha MuscleWar', permissao: 'musclewar.import',
    executar: (t) => api().post('/api/v1/musclewar/imports').set(t).send({ organizationId: ctx.orgId, seasonId: ctx.seasonId, sourceType: 'CSV', sourceRef: 'sonda.csv', content: 'cpf,colocacao\n' }) },

  { nome: 'ler a trilha de auditoria', permissao: 'audit.read',
    executar: (t) => api().get(`/api/v1/audit?organizationId=${ctx.orgId}&limit=1`).set(t) },

  { nome: 'moderar denúncia social', permissao: 'social.moderate',
    executar: (t) => api().get('/api/v1/social/reports?limit=1').set(t) },

  { nome: 'criar equipe', permissao: 'teams.manage',
    executar: (t) => api().post('/api/v1/teams').set(t).send({ organizationId: ctx.orgId, name: unico('Equipe') }) },

  { nome: 'promover atleta a PRO', permissao: 'pro.manage',
    executar: (t) => api().post(`/api/v1/athletes/${ctx.athleteId}/pro-status`).set(t).send({ status: 'ACTIVE', reason: 'sonda de promocao' }) }
];

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();

  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin da Matriz' });
  const org = await criarOrganizacao(admin, { name: 'Federação da Matriz' });
  const diretor = await criarUsuario({ name: 'Diretora da Matriz' });
  await vincular(org.id, diretor, 'EVENT_DIRECTOR');

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: 'Temporada da Matriz', year: 2026 });

  const cpf = gerarCpf(770000001);
  const atleta = await criarAtleta(diretor, org.id, { cpf, fullName: 'Atleta da Matriz' });
  const montado = await criarEventoCompleto(diretor, org.id, { seasonId: temporada.body.id });

  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`)
    .set(diretor.auth()).send({ cpf, classIds: [montado.competitionClass.id] });
  await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED']);

  ctx = {
    orgId: org.id,
    eventId: montado.event.id,
    classId: montado.competitionClass.id,
    seasonId: temporada.body.id,
    athleteId: atleta.id,
    cpf,
    registrationId: inscricao.body.registration.id,
    registrationItemId: inscricao.body.registration.items[0].id
  };

  // Um usuário por papel, todos vinculados à MESMA organização: o que muda
  // entre eles é só o papel, então qualquer diferença de resposta é do RBAC.
  ctx.porPapel = {};
  for (const papel of PAPEIS) {
    const usuario = await criarUsuario({ name: `Usuário ${papel}` });
    await vincular(org.id, usuario, papel);
    ctx.porPapel[papel] = usuario;
  }
});

describe('matriz de permissões × comportamento real das rotas', () => {
  for (const papel of PAPEIS) {
    describe(papel, () => {
      for (const sonda of SONDAS) {
        it(`${sonda.nome} (${sonda.permissao})`, async () => {
          const usuario = ctx.porPapel[papel];
          // O ator que a rota vê: papel global do usuário + vínculo na organização.
          const ator = { id: usuario.id, role: usuario.role, memberships: [{ organizationId: ctx.orgId, role: papel }] };
          const permitido = can(ator, sonda.permissao, ctx.orgId);

          const resposta = await sonda.executar(usuario.auth());

          if (permitido) {
            expect(resposta.status, `${papel} deveria passar pela autorização de ${sonda.permissao}, veio ${resposta.status} ${JSON.stringify(resposta.body).slice(0, 200)}`)
              .not.toBe(403);
          } else {
            expect(resposta.status, `${papel} NÃO deveria passar por ${sonda.permissao}, veio ${resposta.status} ${JSON.stringify(resposta.body).slice(0, 200)}`)
              .toBe(403);
          }
        });
      }
    });
  }
});

describe('visitante anônimo', () => {
  for (const sonda of SONDAS) {
    it(`${sonda.nome} exige autenticação`, async () => {
      const resposta = await sonda.executar({});
      expect(resposta.status, `${sonda.nome} respondeu ${resposta.status} sem token`).toBe(401);
    });
  }
});

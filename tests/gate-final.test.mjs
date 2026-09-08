// GATE FINAL — achados da auditoria ofensiva.
//
// Cada teste aqui corresponde a um ataque que funcionou contra a API rodando
// em NODE_ENV=production, antes da correção.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar, gerarCpf
} from './helpers.mjs';

let diretorA, inscricaoB, inscricaoA;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN' });

  const orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  diretorA = await criarUsuario({ name: 'Diretor A' });
  await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');
  const cpfA = gerarCpf(771111111);
  await criarAtleta(diretorA, orgA.id, { cpf: cpfA, fullName: 'Atleta A' });
  const montadoA = await criarEventoCompleto(diretorA, orgA.id);
  await transicionar(diretorA, montadoA.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  const rA = await api().post(`/api/v1/events/${montadoA.event.id}/registrations`)
    .set(diretorA.auth()).send({ cpf: cpfA, classIds: [montadoA.competitionClass.id] });
  inscricaoA = rA.body.registration.id;

  const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
  const diretorB = await criarUsuario({ name: 'Diretor B' });
  await vincular(orgB.id, diretorB, 'EVENT_DIRECTOR');
  const cpfB = gerarCpf(772222222);
  await criarAtleta(diretorB, orgB.id, { cpf: cpfB, fullName: 'Atleta B' });
  const montadoB = await criarEventoCompleto(diretorB, orgB.id);
  await transicionar(diretorB, montadoB.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  const rB = await api().post(`/api/v1/events/${montadoB.event.id}/registrations`)
    .set(diretorB.auth()).send({ cpf: cpfB, classIds: [montadoB.competitionClass.id] });
  inscricaoB = rB.body.registration.id;
});

// ACHADO: `registration.findUnique({ include: { athlete } })` estourava quando
// o RLS escondia o dono — a relação é obrigatória no schema e o Prisma recebia
// null. Saía 500 onde deveria sair 404.
//
// O 500 não era só código errado: era ORÁCULO DE EXISTÊNCIA. Medido contra a
// API em produção, com o diretor de outra federação — inscrição dele 200,
// inscrição alheia 500, id inventado 404. Três respostas distinguíveis dão um
// varredor de ids: dá para descobrir quais inscrições existem em federações
// que não são a sua.
describe('inscrição de outra federação não se distingue de inscrição inexistente', () => {
  const INEXISTENTE = 'cmtsxxxxxxxxxxxxxxxxxxxxx';

  it('leitura: alheia e inexistente respondem igual', async () => {
    const alheia = await api().get(`/api/v1/registrations/${inscricaoB}`).set(diretorA.auth());
    const fantasma = await api().get(`/api/v1/registrations/${INEXISTENTE}`).set(diretorA.auth());

    expect(alheia.status).toBe(404);
    expect(alheia.status).toBe(fantasma.status);
    expect(alheia.body).toEqual(fantasma.body);
  });

  it('a própria inscrição continua legível', async () => {
    const propria = await api().get(`/api/v1/registrations/${inscricaoA}`).set(diretorA.auth());
    expect(propria.status).toBe(200);
    expect(propria.body.athlete.fullName).toBe('Atleta A');
  });

  it('check-in, pesagem e cancelamento: alheia e inexistente respondem igual', async () => {
    const casos = [
      ['post', id => api().post(`/api/v1/registrations/${id}/checkin`).send({})],
      ['post', id => api().post(`/api/v1/registrations/${id}/weighins`).send({ weightGrams: 60000 })],
      ['post', id => api().post(`/api/v1/registrations/${id}/cancel`).send({ reason: 'sonda de invasao' })]
    ];

    for (const [, chamar] of casos) {
      const alheia = await chamar(inscricaoB).set(diretorA.auth());
      const fantasma = await chamar(INEXISTENTE).set(diretorA.auth());
      expect(alheia.status, `alheia respondeu ${alheia.status}`).toBe(404);
      expect(alheia.status).toBe(fantasma.status);
      expect(alheia.body).toEqual(fantasma.body);
    }
  });

  it('nenhuma dessas tentativas escreveu coisa alguma na federação vizinha', async () => {
    const inscricao = await prisma.registration.findUnique({ where: { id: inscricaoB } });
    expect(inscricao.status).toBe('CONFIRMED');
    expect(await prisma.checkIn.count({ where: { registrationId: inscricaoB } })).toBe(0);
    expect(await prisma.weighIn.count({ where: { registrationId: inscricaoB } })).toBe(0);
  });
});

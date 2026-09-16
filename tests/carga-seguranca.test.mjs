import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 13.9–13.15 — TENTAR QUEBRAR.
//
// "Não encontrei vulnerabilidade" não é prova de segurança. Cada teste aqui é
// um ATAQUE: manipula id, troca tenant, injeta campo privilegiado, forja
// token, pede paginação absurda. O que se prova é que a porta está trancada —
// e, quando ela cede, o teste falha e vira defeito.
//
// Duas organizações completas, com todos os papéis, porque isolamento só se
// prova com dois lados.
// ============================================================================

let adminA, diretorA, atletaContaA, orgA, seasonA, eventoA, atletaA;
let diretorB, orgB, seasonB, eventoB, atletaB;

const cpfSeq = (() => { let n = 770000000; return () => gerarCpf(n += 8117); })();

async function montarCasa(sufixo) {
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: `Admin ${sufixo}` });
  const org = await criarOrganizacao(admin, { name: unico(`Federação ${sufixo}`) });
  const diretor = await criarUsuario({ name: `Diretora ${sufixo}` });
  await vincular(org.id, diretor, 'EVENT_DIRECTOR');
  await vincular(org.id, diretor, 'RANKING_MANAGER');
  const conta = await criarUsuario({ name: `Conta Atleta ${sufixo}` });

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: org.id, name: unico('Temporada'), year: 2026 });

  const montado = await criarEventoCompleto(diretor, org.id, { seasonId: temporada.body.id });
  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`).set(diretor.auth())
    .send({ cpf: cpfSeq(), athlete: { fullName: `Atleta ${sufixo}`, sex: 'FEMALE' }, classIds: [montado.competitionClass.id] });
  const athleteId = inscricao.body.registration.athlete.id;

  await api().patch(`/api/v1/athletes/${athleteId}`).set(diretor.auth()).send({ userId: conta.id });

  await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretor.auth()).send({});
  await transicionar(diretor, montado.event.id, ['IN_JUDGING']);
  await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: [{ athleteId, placing: 1 }] });
  await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });

  return { admin, org, diretor, conta, seasonId: temporada.body.id, evento: montado.event, athleteId, classe: montado.competitionClass };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  const a = await montarCasa('A');
  const b = await montarCasa('B');
  ({ admin: adminA, diretor: diretorA, conta: atletaContaA, org: orgA, seasonId: seasonA, evento: eventoA, athleteId: atletaA } = a);
  ({ diretor: diretorB, org: orgB, seasonId: seasonB, evento: eventoB, athleteId: atletaB } = b);
});

const recusado = status => [400, 401, 403, 404, 422].includes(status);

describe('13.9 — IDOR e BOLA: id na URL não é autorização', () => {
  it('operador de A não alcança NENHUM recurso de B pela URL', async () => {
    const alvos = [
      ['GET', `/api/v1/athletes/${atletaB}`],
      ['GET', `/api/v1/athletes/${atletaB}/ranking-points`],
      ['GET', `/api/v1/events/${eventoB.id}/overall/candidates`],
      ['GET', `/api/v1/events/${eventoB.id}/overall/preview?athleteId=${atletaB}`],
      ['GET', `/api/v1/events/${eventoB.id}/registrations`],
      ['POST', `/api/v1/events/${eventoB.id}/overall`],
      ['POST', `/api/v1/seasons/${seasonB}/recompute`]
    ];

    for (const [metodo, rota] of alvos) {
      const requisicao = metodo === 'GET'
        ? api().get(rota).set(diretorA.auth())
        : api().post(rota).set(diretorA.auth()).send({ athleteId: atletaB });
      const resposta = await requisicao;
      expect(recusado(resposta.status), `${metodo} ${rota} devolveu ${resposta.status}`).toBe(true);
    }
  });

  it('atleta de A não lê o histórico de B por nenhuma porta', async () => {
    const alvos = [
      `/api/v1/athletes/${atletaB}/ranking-points`,
      `/api/v1/athletes/${atletaB}`
    ];
    for (const rota of alvos) {
      const resposta = await api().get(rota).set(atletaContaA.auth());
      expect(recusado(resposta.status), `${rota} devolveu ${resposta.status}`).toBe(true);
    }
  });

  it('a rota /me ignora todo id de cliente e responde sobre o dono do token', async () => {
    const resposta = await api().get('/api/v1/me/history').set(atletaContaA.auth())
      .query({ athleteId: atletaB, organizationId: orgB.id, seasonId: seasonB });

    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete.id, 'continua sendo o dono do token').toBe(atletaA);
    // E nenhum ponto da outra casa entrou.
    expect(JSON.stringify(resposta.body)).not.toContain(atletaB);
  });
});

describe('13.11 — mass assignment: campo privilegiado no corpo', () => {
  it('cadastro não aceita papel privilegiado autoatribuído', async () => {
    const resposta = await api().post('/api/v1/auth/register').send({
      name: 'Invasor Mass Assignment', email: `mass.${Date.now()}@mci.test`,
      password: 'senha-de-teste-123', birthDate: '1995-03-10', phone: '65999991234',
      whatsapp: '65988884321', postalCode: '78000000', addressLine: 'Rua', addressNumber: '1',
      state: 'MT', city: 'Cuiabá',
      role: 'SUPER_ADMIN', permissions: ['*'], organizationId: orgA.id
    });

    // Aceito ou recusado, o que não pode é virar SUPER_ADMIN.
    if (resposta.status === 201) {
      const criado = await comoAtor(adminA, tx => tx.user.findUnique({ where: { id: resposta.body.user.id } }));
      expect(criado.role, 'papel privilegiado autoatribuído').not.toBe('SUPER_ADMIN');
      const vinculos = await comoAtor(adminA, tx => tx.organizationMember.count({ where: { userId: criado.id } }));
      expect(vinculos, 'vínculo de organização autoatribuído').toBe(0);
    } else {
      expect(recusado(resposta.status)).toBe(true);
    }
  });

  it('o atleta não injeta pontuação nem título pelo corpo', async () => {
    const antes = await comoAtor(diretorA, tx => tx.rankingPoint.findMany({ where: { athleteId: atletaA } }));

    const resposta = await api().patch(`/api/v1/athletes/${atletaA}`).set(atletaContaA.auth()).send({
      overallBonus: 999, isOverallChampion: true, rankingPoints: 999,
      placementPoints: 999, points: 999,
      organizationId: orgB.id, affiliationId: 'qualquer', createdAt: '1990-01-01T00:00:00.000Z'
    });
    expect([200, 400, 403, 422]).toContain(resposta.status);

    const depois = await comoAtor(diretorA, tx => tx.rankingPoint.findMany({ where: { athleteId: atletaA } }));
    expect(depois.map(p => p.points), 'pontuação alterada pelo corpo').toEqual(antes.map(p => p.points));
    expect(depois.every(p => p.overallBonus === 0), 'bônus injetado pelo corpo').toBe(true);

    const atleta = await comoAtor(diretorA, tx => tx.athlete.findUnique({ where: { id: atletaA } }));
    expect(atleta.organizationId, 'organização trocada pelo corpo').toBe(orgA.id);
  });

  it('organizationId no corpo não muda a casa do recurso criado', async () => {
    // O diretor de A tenta criar temporada NA organização B.
    const resposta = await api().post('/api/v1/seasons').set(diretorA.auth())
      .send({ organizationId: orgB.id, name: unico('Temporada Invasora'), year: 2026 });
    expect(recusado(resposta.status), `criou temporada em B: ${resposta.status}`).toBe(true);
  });
});

describe('13.13 — autenticação: token ausente, inválido e adulterado', () => {
  it('sem token, rota protegida é 401', async () => {
    for (const rota of ['/api/v1/me/history', '/api/v1/me/affiliation', `/api/v1/events/${eventoA.id}/overall/candidates`]) {
      const resposta = await api().get(rota);
      expect(resposta.status, rota).toBe(401);
    }
  });

  it('token com assinatura adulterada é recusado', async () => {
    const valido = atletaContaA.auth().Authorization.replace('Bearer ', '');
    const [cabecalho, corpo, assinatura] = valido.split('.');

    const adulterados = [
      `${cabecalho}.${corpo}.${'x'.repeat(assinatura.length)}`,
      // Carga trocada, assinatura antiga: o clássico "vou mudar o meu id".
      `${cabecalho}.${Buffer.from(JSON.stringify({ sub: 'outro', id: 'outro' })).toString('base64url')}.${assinatura}`,
      // alg: none
      `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${corpo}.`,
      'nao.e.um.token',
      ''
    ];

    for (const token of adulterados) {
      const resposta = await api().get('/api/v1/me/history').set({ Authorization: `Bearer ${token}` });
      expect(resposta.status, `token "${token.slice(0, 24)}…" passou`).toBe(401);
    }
  });

  it('senha errada não entra, e a resposta não diz qual metade falhou', async () => {
    const resposta = await api().post('/api/v1/auth/login')
      .send({ email: atletaContaA.email, password: 'senha-errada-123' });
    expect(resposta.status).toBe(401);
    expect(JSON.stringify(resposta.body)).not.toMatch(/senha incorreta|usuário não encontrado|e-mail não/i);
  });
});

describe('13.14 — API hardening: entrada hostil', () => {
  it('paginação absurda é recusada ou limitada, nunca obedecida', async () => {
    const casos = [
      { limit: 999999 }, { limit: -1 }, { limit: 0 },
      { limit: 'muitos' }, { cursor: 'não-existe' }, { cursor: 'a'.repeat(500) }
    ];

    for (const query of casos) {
      const resposta = await api().get('/api/v1/ranking').query({ seasonId: seasonA, ...query });
      expect([200, 400, 422].includes(resposta.status), `${JSON.stringify(query)} → ${resposta.status}`).toBe(true);
      if (resposta.status === 200) {
        const itens = resposta.body.items ?? resposta.body;
        expect(itens.length, `${JSON.stringify(query)} devolveu demais`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('id inexistente e id malformado não viram 500', async () => {
    const ids = ['nao-existe', '../../etc/passwd', '00000000-0000-0000-0000-000000000000', "' OR 1=1 --", 'a'.repeat(300)];
    for (const idHostil of ids) {
      const resposta = await api().get(`/api/v1/athletes/${encodeURIComponent(idHostil)}`).set(diretorA.auth());
      expect(resposta.status, `id "${idHostil.slice(0, 20)}" → ${resposta.status}`).toBeLessThan(500);
    }
  });

  it('enum inválido e filtro desconhecido não viram 500', async () => {
    const respostas = await Promise.all([
      api().get('/api/v1/events').set(diretorA.auth()).query({ status: 'NAO_EXISTE' }),
      api().get('/api/v1/ranking').query({ seasonId: seasonA, campoInventado: 'x' }),
      api().get('/api/v1/ranking/by').query({ seasonId: seasonA })
    ]);
    for (const r of respostas) expect(r.status).toBeLessThan(500);
  });

  it('nenhuma resposta de erro carrega stack trace', async () => {
    const respostas = await Promise.all([
      api().get('/api/v1/athletes/nao-existe').set(diretorA.auth()),
      api().post('/api/v1/auth/login').send({ email: 'x', password: 'y' }),
      api().get(`/api/v1/events/${eventoB.id}/overall/candidates`).set(diretorA.auth())
    ]);
    for (const r of respostas) {
      const corpo = JSON.stringify(r.body);
      expect(corpo, 'stack no corpo').not.toMatch(/at \w+ \(|node_modules|\.js:\d+:\d+/);
    }
  });
});

describe('13.14 — dado sensível não sai por resposta não autorizada', () => {
  it('ranking público não carrega CPF, telefone nem endereço', async () => {
    const resposta = await api().get('/api/v1/ranking').query({ seasonId: seasonA, limit: 100 });
    const corpo = JSON.stringify(resposta.body).toLowerCase();

    for (const proibido of ['"cpf"', 'phone', 'whatsapp', 'addressline', 'postalcode', 'passwordhash', 'affiliationnumber']) {
      expect(corpo, `${proibido} no ranking público`).not.toContain(proibido);
    }
  });

  it('busca pública não devolve CPF', async () => {
    const resposta = await api().get('/api/v1/public/events').query({ search: 'a' });
    expect(resposta.status).toBeLessThan(500);
    expect(JSON.stringify(resposta.body).toLowerCase()).not.toContain('"cpf"');
  });

  it('nenhuma resposta pública expõe chave de armazenamento', async () => {
    const respostas = await Promise.all([
      api().get('/api/v1/ranking').query({ seasonId: seasonA }),
      api().get('/api/v1/public/events'),
      api().get(`/api/v1/events/${eventoA.id}/overall`)
    ]);
    for (const r of respostas) {
      const corpo = JSON.stringify(r.body);
      expect(corpo, 'chave de storage vazada').not.toMatch(/photoKey|avatarKey|coverKey|storageKey/);
    }
  });
});

describe('13.10 — RLS: a política do banco também recusa', () => {
  it('ator de A não enxerga atleta de B nem por consulta direta', async () => {
    const vistos = await comoAtor(diretorA, tx => tx.athlete.findMany({ select: { id: true, organizationId: true } }));
    expect(vistos.length, 'A enxerga algum atleta').toBeGreaterThan(0);
    expect(vistos.every(a => a.organizationId === orgA.id), 'atleta de B visível para ator de A').toBe(true);
  });

  it('ator de A não escreve na casa de B nem por consulta direta', async () => {
    await expect(comoAtor(diretorA, tx => tx.athlete.update({
      where: { id: atletaB }, data: { fullName: 'INVADIDO' }
    }))).rejects.toThrow();

    const intacto = await comoAtor(diretorB, tx => tx.athlete.findUnique({ where: { id: atletaB } }));
    expect(intacto.fullName).not.toBe('INVADIDO');
  });
});

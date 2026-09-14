import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, criarEventoCompleto, transicionar, gerarCpf } from './helpers.mjs';

// ============================================================================
// AUDITORIA — o mesmo engano, no último lugar onde ele ainda estava.
//
// `auditService.list` devolvia `total: items.length`. É a MESMA classe de
// defeito que o check-in tinha: o "total" é o tamanho da página, não do
// conjunto. Numa trilha de auditoria isso é pior do que numa lista comum —
// auditoria existe para responder "isto aconteceu quantas vezes?", e um total
// que na verdade é o teto responde sempre a mesma coisa.
//
// A tela não exibia esse número, o que reduzia o impacto hoje. Mas número
// errado exposto por API é defeito mesmo quando ninguém está olhando: a
// próxima tela que o consumir vai acreditar nele.
// ============================================================================

const ACOES_ESPERADAS = 140;
let admin, diretor, organizacao, evento;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  organizacao = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  diretor = await criarUsuario({ name: 'Diretor' });
  await vincular(organizacao.id, diretor, 'EVENT_DIRECTOR');

  const montado = await criarEventoCompleto(diretor, organizacao.id);
  evento = montado.event;
  await transicionar(diretor, evento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  // Cada inscrição grava uma linha de auditoria. 140 passa do teto de 100 e
  // fica abaixo do limite máximo de 200 — é exatamente a faixa onde o defeito
  // aparecia sem que nada estourasse.
  for (let i = 0; i < ACOES_ESPERADAS; i += 1) {
    const resposta = await api()
      .post(`/api/v1/events/${evento.id}/registrations`)
      .set(diretor.auth())
      .send({
        cpf: gerarCpf(500000 + i),
        athlete: { fullName: `Atleta ${String(i).padStart(3, '0')}`, sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá' },
        classIds: [montado.competitionClass.id]
      });
    if (resposta.status !== 201) throw new Error(`inscrição ${i}: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  }
}, 300000);

afterAll(async () => { await prisma.$disconnect(); });

const auditar = (query = '') => api().get(`/api/v1/audit${query}`).set(admin.auth());

describe('o total da auditoria é do conjunto, não da página', () => {
  it('com 140 registros e limite 100, o total NÃO é 100', async () => {
    const resposta = await auditar('?action=REGISTRATION_CREATE&limit=100');
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
    expect(resposta.body.items.length).toBe(100);
    // Este era o defeito: `total` vinha de `items.length`.
    expect(resposta.body.total, 'o total veio da página, não da trilha').toBe(ACOES_ESPERADAS);
  });

  it('o total não muda quando o limite muda', async () => {
    const dez = await auditar('?action=REGISTRATION_CREATE&limit=10');
    const cem = await auditar('?action=REGISTRATION_CREATE&limit=100');
    expect(dez.body.items.length).toBe(10);
    expect(cem.body.items.length).toBe(100);
    expect(dez.body.total).toBe(cem.body.total);
    expect(dez.body.total).toBe(ACOES_ESPERADAS);
  });

  it('o total respeita o filtro — é o total DO FILTRO, não do banco inteiro', async () => {
    const tudo = await auditar('?limit=5');
    const soInscricao = await auditar('?action=REGISTRATION_CREATE&limit=5');
    const inexistente = await auditar('?action=ACAO_QUE_NAO_EXISTE&limit=5');
    expect(soInscricao.body.total).toBe(ACOES_ESPERADAS);
    expect(tudo.body.total, 'o total sem filtro deveria incluir as outras ações').toBeGreaterThan(ACOES_ESPERADAS);
    expect(inexistente.body.total).toBe(0);
    expect(inexistente.body.items).toEqual([]);
  });
});

describe('a trilha inteira é alcançável', () => {
  const percorrer = async (limite, filtro = 'action=REGISTRATION_CREATE') => {
    const vistos = [];
    let cursor = null;
    let voltas = 0;
    do {
      const partes = [filtro, `limit=${limite}`, cursor ? `cursor=${cursor}` : ''].filter(Boolean);
      const resposta = await auditar(`?${partes.join('&')}`);
      expect(resposta.status, JSON.stringify(resposta.body).slice(0, 200)).toBe(200);
      vistos.push(...resposta.body.items.map(item => item.id));
      cursor = resposta.body.nextCursor;
      voltas += 1;
      if (voltas > ACOES_ESPERADAS + 10) throw new Error('paginação da auditoria não terminou');
    } while (cursor);
    return vistos;
  };

  it('a resposta traz nextCursor enquanto houver trilha adiante', async () => {
    const resposta = await auditar('?action=REGISTRATION_CREATE&limit=50');
    expect(resposta.body.nextCursor, 'não há como pedir a página seguinte da auditoria').toBeTruthy();
  });

  it('percorrendo tudo, nenhum registro some nem repete', async () => {
    const vistos = await percorrer(25);
    expect(new Set(vistos).size, 'registro de auditoria repetido entre páginas').toBe(vistos.length);
    expect(vistos.length, 'registro de auditoria sumiu na virada de página').toBe(ACOES_ESPERADAS);
  });

  it('o mesmo vale no teto de 200', async () => {
    const vistos = await percorrer(200);
    expect(new Set(vistos).size).toBe(ACOES_ESPERADAS);
  });

  it('a ordem é a mesma toda vez — auditoria embaralhada não é auditoria', async () => {
    const primeira = await percorrer(30);
    const segunda = await percorrer(30);
    expect(primeira).toEqual(segunda);
  });

  it('e é decrescente no tempo: o mais recente primeiro', async () => {
    const resposta = await auditar('?action=REGISTRATION_CREATE&limit=20');
    const momentos = resposta.body.items.map(item => new Date(item.createdAt).getTime());
    for (let i = 1; i < momentos.length; i += 1) {
      expect(momentos[i]).toBeLessThanOrEqual(momentos[i - 1]);
    }
  });
});

describe('os limites da auditoria', () => {
  it('o teto de 200 continua de pé', async () => {
    const resposta = await auditar('?limit=201');
    expect(resposta.status).toBe(400);
  });

  it('cursor gigante é recusado antes de chegar ao banco', async () => {
    const resposta = await auditar(`?limit=10&cursor=${'a'.repeat(5000)}`);
    expect(resposta.status).toBe(400);
  });

  it('cursor inventado não devolve a trilha inteira', async () => {
    const resposta = await auditar('?limit=10&cursor=nao-existe-esse-id');
    expect([200, 400, 404]).toContain(resposta.status);
    if (resposta.status === 200) expect(resposta.body.items.length).toBeLessThanOrEqual(10);
  });

  it('quem não tem audit.read continua fora', async () => {
    const resposta = await api().get('/api/v1/audit?limit=5').set(diretor.auth());
    expect(resposta.status).toBe(403);
  });
});

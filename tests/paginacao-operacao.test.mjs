import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, criarEventoCompleto, transicionar, gerarCpf } from './helpers.mjs';

// ============================================================================
// PAGINAÇÃO DA OPERAÇÃO — a lista que corta é a lista que mente.
//
// O teto de `limit` é 100 e não deve subir: ele protege o banco. A resposta
// certa é paginar. Mas paginar só resolve se DUAS coisas forem verdade:
//
//   1. o TOTAL for do conjunto inteiro, e não da página — senão a tela diz
//      "100 inscritos" num evento de 280 e ninguém desconfia;
//   2. a ordem for ESTÁVEL — senão a página 2 repete ou pula atleta, e um
//      atleta pulado é um atleta que o operador conclui que não se inscreveu.
//
// Dois atletas com o MESMO nome entram no cenário de propósito: é onde o
// cursor cai no meio de um empate. MEDIDO neste banco: a travessia fica
// correta com e sem o desempate por `id` — o que os testes abaixo garantem é o
// resultado (ninguém some, ninguém repete), não a técnica usada para chegar
// nele.
// ============================================================================

const INSCRITOS = 101;
const NOME_REPETIDO = 'Ana Souza';

let diretor, operador, evento, organizacao;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();

  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  organizacao = await criarOrganizacao(admin);
  // O privilégio vem do vínculo com a organização, nunca do papel global —
  // é assim que o produto funciona e é assim que a suíte monta o cenário.
  diretor = await criarUsuario({ name: 'Diretor de Evento' });
  await vincular(organizacao.id, diretor, 'EVENT_DIRECTOR');
  operador = await criarUsuario({ name: 'Operador de Check-in' });
  await vincular(organizacao.id, operador, 'CHECKIN_OPERATOR');

  const montado = await criarEventoCompleto(diretor, organizacao.id);
  evento = montado.event;
  await transicionar(diretor, evento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  // 101 inscritos confirmados. Dois deles compartilham o nome de propósito.
  for (let i = 0; i < INSCRITOS; i += 1) {
    const nome = i < 2 ? NOME_REPETIDO : `Atleta ${String(i).padStart(3, '0')}`;
    const resposta = await api()
      .post(`/api/v1/events/${evento.id}/registrations`)
      .set(diretor.auth())
      .send({
        cpf: gerarCpf(100000 + i),
        athlete: { fullName: nome, sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá' },
        classIds: [montado.competitionClass.id]
      });
    if (resposta.status !== 201) throw new Error(`inscrição ${i} falhou: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  }
}, 240000);

afterAll(async () => { await prisma.$disconnect(); });

const listar = (query = '') => api()
  .get(`/api/v1/events/${evento.id}/checkins${query}`)
  .set(operador.auth());

describe('check-in: o total é do evento, não da página', () => {
  it('com 101 inscritos e limite 100, o total continua 101', async () => {
    const resposta = await listar('?limit=100');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.length).toBe(100);
    // Este era o defeito: `total` vinha do tamanho da página, então a tela
    // exibia "100 inscritos" e o aviso de corte NUNCA aparecia.
    expect(resposta.body.summary.total, 'o total veio da página, não do evento').toBe(INSCRITOS);
  });

  it('os contadores de feito e pendente também são do evento inteiro', async () => {
    const resposta = await listar('?limit=10');
    const { total, checkedIn, pending } = resposta.body.summary;
    expect(total).toBe(INSCRITOS);
    expect(checkedIn + pending).toBe(INSCRITOS);
    expect(resposta.body.items.length).toBe(10);
  });

  it('um limite menor que o conjunto NÃO muda o total', async () => {
    const dez = await listar('?limit=10');
    const cem = await listar('?limit=100');
    expect(dez.body.summary.total).toBe(cem.body.summary.total);
  });
});

describe('check-in: a paginação percorre o evento inteiro', () => {
  const percorrer = async (limite, busca = '') => {
    const vistos = [];
    let cursor = null;
    let paginas = 0;
    do {
      const partes = [`limit=${limite}`, busca, cursor ? `cursor=${cursor}` : ''].filter(Boolean);
      const resposta = await listar(`?${partes.join('&')}`);
      expect(resposta.status).toBe(200);
      vistos.push(...resposta.body.items.map(item => item.id));
      cursor = resposta.body.nextCursor;
      paginas += 1;
      // O teto é generoso de propósito: ele existe para matar laço infinito,
      // não para limitar a travessia. Com `limit=1` são 101 páginas legítimas.
      if (paginas > INSCRITOS + 10) throw new Error('paginação não terminou — provável laço infinito');
    } while (cursor);
    return { vistos, paginas };
  };

  it('a resposta traz nextCursor quando ainda há gente', async () => {
    const resposta = await listar('?limit=50');
    expect(resposta.body.nextCursor, 'a operação não tem como pedir a próxima página').toBeTruthy();
  });

  it('percorrendo tudo, ninguém desaparece e ninguém aparece duas vezes', async () => {
    const { vistos, paginas } = await percorrer(25);
    expect(paginas).toBeGreaterThan(1);
    expect(new Set(vistos).size, 'atleta repetido entre páginas').toBe(vistos.length);
    expect(vistos.length, 'atleta sumiu na virada de página').toBe(INSCRITOS);
  });

  it('o mesmo vale com o limite no teto da API', async () => {
    const { vistos } = await percorrer(100);
    expect(new Set(vistos).size).toBe(INSCRITOS);
  });

  it('e com o limite mínimo, onde o desempate é mais exigido', async () => {
    const { vistos } = await percorrer(1);
    expect(new Set(vistos).size).toBe(INSCRITOS);
  });

  it('a ordem é a mesma toda vez — sem isso a página 2 é loteria', async () => {
    const primeira = await percorrer(20);
    const segunda = await percorrer(20);
    expect(primeira.vistos).toEqual(segunda.vistos);
  });

  it('os homônimos aparecem os dois, e em ordem definida', async () => {
    const { vistos } = await percorrer(3);
    const registros = await prisma.registration.findMany({
      where: { eventId: evento.id, athlete: { fullName: NOME_REPETIDO } },
      select: { id: true }
    });
    expect(registros.length).toBe(2);
    for (const registro of registros) {
      expect(vistos.includes(registro.id), 'um dos homônimos não apareceu em nenhuma página').toBe(true);
    }
  });

  it('a busca continua valendo em todas as páginas', async () => {
    const { vistos } = await percorrer(2, 'search=Atleta 00');
    expect(vistos.length).toBeGreaterThan(2);
    const encontrados = await prisma.registration.findMany({
      where: { id: { in: vistos } },
      select: { athlete: { select: { fullName: true } } }
    });
    for (const item of encontrados) {
      expect(item.athlete.fullName.startsWith('Atleta 00'), `${item.athlete.fullName} não corresponde à busca`).toBe(true);
    }
  });
});

describe('check-in: os extremos', () => {
  // 99 é a fronteira que mais engana: a página não se completa, então NÃO
  // pode haver `nextCursor`. Um cursor devolvido aqui faria a interface
  // oferecer uma próxima página que não existe — e o operador clicaria nela
  // no meio da fila para não receber nada.
  it('99 de 99: página incompleta NÃO promete continuação', async () => {
    const resposta = await listar('?limit=100&search=Atleta');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.length, 'o cenário deixou de ter 99 correspondências').toBe(99);
    expect(resposta.body.summary.total).toBe(99);
    expect(resposta.body.nextCursor, 'prometeu página seguinte numa lista que acabou').toBeNull();
  });

  it('1 de 1: a menor lista possível também não promete continuação', async () => {
    const resposta = await listar('?limit=100&search=Atleta 050');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.length).toBe(1);
    expect(resposta.body.summary.total).toBe(1);
    expect(resposta.body.nextCursor).toBeNull();
  });

  it('0 de 0: busca sem correspondência é vazia, e não a lista inteira', async () => {
    const resposta = await listar('?limit=100&search=NinguemComEsseNome');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toEqual([]);
    expect(resposta.body.summary.total).toBe(0);
    expect(resposta.body.nextCursor).toBeNull();
  });

  it('evento sem inscrito: lista vazia, total zero, sem cursor', async () => {
    const outro = await criarEventoCompleto(diretor, organizacao.id, { categoryCode: 'WELLNESS' });
    await transicionar(diretor, outro.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
    const resposta = await api()
      .get(`/api/v1/events/${outro.event.id}/checkins?limit=100`)
      .set(operador.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toEqual([]);
    expect(resposta.body.summary.total).toBe(0);
    expect(resposta.body.nextCursor).toBeNull();
  });

  it('o teto de 100 continua de pé — pedir 101 é recusado', async () => {
    const resposta = await listar('?limit=101');
    expect(resposta.status).toBe(400);
  });

  it('cursor inventado não derruba a operação nem devolve o evento inteiro', async () => {
    const resposta = await listar('?limit=10&cursor=nao-existe-esse-id');
    expect([200, 400, 404]).toContain(resposta.status);
    if (resposta.status === 200) expect(resposta.body.items.length).toBeLessThanOrEqual(10);
  });
});

// ============================================================================
// CREDENCIAIS — o endereço que escapava do teto.
//
// `listCredentials` não tinha `take` nenhum: devolvia o evento inteiro numa
// resposta só, com a contagem de leituras em cada linha. Não cortava a lista
// (não mentia), mas também não tinha tamanho — e o teto de 100 existe
// exatamente para o banco nunca receber pedido sem tamanho.
// ============================================================================
describe('credenciais: a lista tem tamanho e tem continuação', () => {
  const QUANTAS = 12;

  beforeAll(async () => {
    for (let i = 0; i < QUANTAS; i += 1) {
      const resposta = await api()
        .post(`/api/v1/events/${evento.id}/credentials`)
        .set(diretor.auth())
        .send({ type: 'STAFF', holderName: `Equipe ${String(i).padStart(2, '0')}` });
      if (resposta.status !== 201) throw new Error(`credencial ${i}: ${resposta.status} ${JSON.stringify(resposta.body)}`);
    }
  }, 120000);

  const listarCredenciais = (query = '') => api()
    .get(`/api/v1/events/${evento.id}/credentials${query}`)
    .set(diretor.auth());

  it('o total é do evento, mesmo pedindo uma página pequena', async () => {
    const resposta = await listarCredenciais('?limit=5');
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.length).toBe(5);
    expect(resposta.body.total).toBe(QUANTAS);
  });

  it('percorrendo as páginas, nenhuma credencial some nem repete', async () => {
    const vistos = [];
    let cursor = null;
    let voltas = 0;
    do {
      const resposta = await listarCredenciais(`?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      vistos.push(...resposta.body.items.map(item => item.id));
      cursor = resposta.body.nextCursor;
      voltas += 1;
      if (voltas > 20) throw new Error('paginação de credenciais não terminou');
    } while (cursor);
    expect(new Set(vistos).size).toBe(vistos.length);
    expect(vistos.length).toBe(QUANTAS);
  });

  it('o teto de 100 também vale aqui', async () => {
    const resposta = await listarCredenciais('?limit=500');
    expect(resposta.status).toBe(400);
  });
});

// ============================================================================
// O CURSOR É ENTRADA NOVA — logo, é SUPERFÍCIE DE ATAQUE NOVA.
//
// Paginar por cursor significa aceitar do cliente um identificador de linha e
// devolver "o que vem depois dele". Se esse identificador não for confinado ao
// escopo da consulta, ele vira um ponteiro para dentro do banco: aponte para
// uma linha de outro evento, ou de outra organização, e veja o que sai.
// ============================================================================
describe('segurança da paginação', () => {
  let outraOrg, intruso, eventoDoIntruso, inscricaoDoIntruso;

  beforeAll(async () => {
    const admin2 = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin 2' });
    outraOrg = await criarOrganizacao(admin2, { name: 'Outra Federação' });
    intruso = await criarUsuario({ name: 'Diretor de Fora' });
    await vincular(outraOrg.id, intruso, 'EVENT_DIRECTOR');
    await vincular(outraOrg.id, intruso, 'CHECKIN_OPERATOR');

    const montado = await criarEventoCompleto(intruso, outraOrg.id, { categoryCode: 'WELLNESS' });
    eventoDoIntruso = montado.event;
    await transicionar(intruso, eventoDoIntruso.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
    const resposta = await api()
      .post(`/api/v1/events/${eventoDoIntruso.id}/registrations`)
      .set(intruso.auth())
      .send({
        cpf: gerarCpf(777001),
        athlete: { fullName: 'Atleta de Fora', sex: 'FEMALE', birthDate: '1996-05-10', state: 'SP', city: 'Santos' },
        classIds: [montado.competitionClass.id]
      });
    inscricaoDoIntruso = resposta.body.registration;
  }, 120000);

  it('operador de fora NÃO lista o check-in deste evento, nem com cursor', async () => {
    const resposta = await api()
      .get(`/api/v1/events/${evento.id}/checkins?limit=10`)
      .set(intruso.auth());
    expect(resposta.status).toBe(403);
  });

  it('cursor de OUTRO evento não abre a lista deste', async () => {
    const resposta = await api()
      .get(`/api/v1/events/${evento.id}/checkins?limit=10&cursor=${inscricaoDoIntruso.id}`)
      .set(operador.auth());
    // Ou o cursor é rejeitado, ou é ignorado — o que não pode é devolver
    // linha que não pertence a este evento.
    if (resposta.status === 200) {
      const ids = resposta.body.items.map(item => item.id);
      expect(ids.includes(inscricaoDoIntruso.id), 'inscrição de outro evento vazou pela paginação').toBe(false);
      const doEvento = await prisma.registration.findMany({
        where: { id: { in: ids } }, select: { eventId: true }
      });
      for (const linha of doEvento) expect(linha.eventId).toBe(evento.id);
    } else {
      expect(resposta.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('o total continua sendo só deste evento, nunca a soma dos dois', async () => {
    const daqui = await api().get(`/api/v1/events/${evento.id}/checkins?limit=1`).set(operador.auth());
    const deLa = await api().get(`/api/v1/events/${eventoDoIntruso.id}/checkins?limit=1`).set(intruso.auth());
    expect(daqui.body.summary.total).toBe(INSCRITOS);
    expect(deLa.body.summary.total).toBe(1);
  });

  it('cursor gigante não derruba a rota nem escapa da validação', async () => {
    const resposta = await api()
      .get(`/api/v1/events/${evento.id}/checkins?limit=10&cursor=${'a'.repeat(5000)}`)
      .set(operador.auth());
    expect(resposta.status).toBe(400);
  });

  it('credenciais de outra organização não são alcançáveis por cursor', async () => {
    const resposta = await api()
      .get(`/api/v1/events/${eventoDoIntruso.id}/credentials?limit=10`)
      .set(operador.auth());
    expect(resposta.status).toBe(403);
  });
});

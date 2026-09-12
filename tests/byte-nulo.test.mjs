import { describe, it, expect, beforeAll } from 'vitest';
import { api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, criarAtleta, gerarCpf } from './helpers.mjs';

// ==========================================================================
// O byte NUL não chega ao banco.
//
// Encontrado em teste de invasão: `GET /api/v1/public/athletes/%00` devolvia
// 500. O PostgreSQL RECUSA 0x00 em coluna de texto ("invalid byte sequence for
// encoding UTF8"), então o erro nascia lá embaixo, já dentro da consulta, e
// subia como erro não tratado.
//
// A varredura mediu o tamanho: 890 requisições em 89 rotas com parâmetro,
// 81 combinações de rota e ator respondendo 5xx — e SEIS delas alcançáveis sem
// nenhuma autenticação. Nada vazava: o corpo da resposta já era redigido para
// INTERNAL_ERROR. O que vazava era a operação — qualquer pessoa na internet
// derrubava a linha de base de 5xx e enchia o log de pilha, afogando erro de
// verdade no ruído justamente no dia em que o log importa.
//
// Nenhuma das outras cargas da varredura reproduziu o problema: travessia de
// caminho, CR/LF, unicode inválido e string de 300 caracteres já eram
// tratados. A causa é única, e por isso a defesa é uma só, na porta.
// ==========================================================================

const NUL = String.fromCharCode(0);

let admin;
let operador;
let atleta;
let organizacao;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  organizacao = await criarOrganizacao(admin);
  operador = await criarUsuario({ role: 'ATHLETE', name: 'Diretor' });
  await vincular(organizacao.id, operador, 'EVENT_DIRECTOR');
  atleta = await criarAtleta(operador, organizacao.id, { cpf: gerarCpf() });
});

describe('byte NUL é recusado na porta, e não no banco', () => {
  it('no parâmetro de caminho de rota pública, sem autenticação', async () => {
    const resposta = await api().get('/api/v1/public/athletes/%00');
    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('INVALID_CHARACTER');
  });

  it('no parâmetro de caminho de rota autenticada', async () => {
    const resposta = await api().get('/api/v1/athletes/%00').set(operador.auth());
    expect(resposta.status).toBe(400);
  });

  it('no meio de um identificador que de resto parece válido', async () => {
    const resposta = await api().get(`/api/v1/athletes/${atleta.id.slice(0, 5)}%00${atleta.id.slice(5)}`).set(operador.auth());
    expect(resposta.status).toBe(400);
  });

  it('na string de consulta', async () => {
    const busca = await api().get('/api/v1/athletes?search=%00').set(operador.auth());
    expect(busca.status).toBe(400);

    const cursor = await api().get('/api/v1/athletes?cursor=%00').set(operador.auth());
    expect(cursor.status).toBe(400);
  });

  it('no corpo da requisição', async () => {
    const resposta = await api()
      .post('/api/v1/organizations')
      .set(admin.auth())
      .send({ name: `Federacao${NUL}Falsa`, slug: 'federacao-com-nulo', kind: 'FEDERATION', state: 'MT' });
    expect(resposta.status).toBe(400);
  });

  it('aninhado dentro de um objeto do corpo', async () => {
    const resposta = await api()
      .post('/api/v1/athletes')
      .set(operador.auth())
      .send({ fullName: 'Atleta', organizationId: organizacao.id, cpf: gerarCpf(), birthDate: '1990-01-01', sex: 'MALE', city: `Cui${NUL}aba`, state: 'MT' });
    expect(resposta.status).toBe(400);
  });

  it('nenhuma resposta de byte NUL é 5xx, em rota pública ou privada', async () => {
    const rotas = [
      ['/api/v1/public/athletes/%00', false],
      ['/api/v1/public/events/%00', false],
      ['/api/v1/classes/%00/result', false],
      ['/api/v1/events/%00/results', false],
      ['/api/v1/media/posts/%00', false],
      ['/api/v1/social/posts/%00', false],
      ['/api/v1/athletes/%00', true],
      ['/api/v1/organizations/%00', true],
      ['/api/v1/registrations/%00', true]
    ];
    for (const [rota, exigeAuth] of rotas) {
      const pedido = api().get(rota);
      const resposta = await (exigeAuth ? pedido.set(operador.auth()) : pedido);
      expect(resposta.status, `${rota} respondeu ${resposta.status}`).toBeLessThan(500);
    }
  });

  it('a guarda não atrapalha requisição legítima', async () => {
    const legitima = await api().get(`/api/v1/athletes/${atleta.id}`).set(operador.auth());
    expect(legitima.status).toBe(200);

    // "%2500" é o texto "%00", não um byte nulo: precisa passar.
    const textoLiteral = await api().get('/api/v1/athletes?search=%2500').set(operador.auth());
    expect(textoLiteral.status).toBe(200);

    // Acentos, espaço e traço continuam valendo em busca.
    const acentos = await api().get('/api/v1/athletes?search=Jo%C3%A3o%20da%20Silva-Souza').set(operador.auth());
    expect(acentos.status).toBe(200);
  });
});

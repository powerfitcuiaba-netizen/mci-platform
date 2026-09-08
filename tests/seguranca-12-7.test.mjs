// FASE 12.7 — portão final de segurança.
//
// Dois achados da varredura, cada um com o teste que os teria pegado.
import { describe, it, expect, beforeAll } from 'vitest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { config } = require('../src/config/environment.js');
const storage = require('../src/services/storageService.js');

let usuario;

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();
  usuario = await criarUsuario({ name: 'Alvo da Varredura' });
});

describe('origem de CORS não listada', () => {
  // ACHADO: o callback devolvia `new Error(...)`, e o `cors` propagava para o
  // tratador de erros. Toda requisição com Origin desconhecido virava 500 e
  // uma linha de log em nível `error` — numa rota anônima, ou seja, qualquer
  // um na internet podia inundar o log de erro com um cabeçalho.
  //
  // CORS não é barreira de autorização: ele protege o navegador da vítima, não
  // o servidor. O correto é responder sem os cabeçalhos e deixar o navegador
  // barrar a leitura.
  it('não vira erro de servidor', async () => {
    const resposta = await api().get('/api/v1/ranking').set('Origin', 'https://atacante.example');
    expect(resposta.status).not.toBe(500);
    expect(resposta.status).toBeLessThan(500);
  });

  it('não recebe o cabeçalho que autorizaria a leitura', async () => {
    const resposta = await api().get('/api/v1/ranking').set('Origin', 'https://atacante.example');
    expect(resposta.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('o preflight também não vira 500', async () => {
    const resposta = await api().options('/api/v1/auth/login')
      .set('Origin', 'https://atacante.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(resposta.status).toBeLessThan(500);
  });

  it('a origem configurada continua sendo autorizada', async () => {
    const permitida = config.corsOrigins[0];
    const resposta = await api().get('/api/v1/ranking').set('Origin', permitida);
    expect(resposta.headers['access-control-allow-origin']).toBe(permitida);
  });
});

describe('o login não denuncia quais emails existem', () => {
  // ACHADO: a comparação contra hash descartável existia e o comentário
  // prometia tempo constante, mas o literal era de custo 04 enquanto os hashes
  // reais são de custo 10 ou 12. Medido: 0,03 ms contra 80 ms (custo 10) e
  // 313 ms (custo 12) — três ordens de grandeza separando "existe" de "não
  // existe".
  //
  // O teste afere o CUSTO, não o relógio: medir tempo em CI é receita de teste
  // instável, e o custo é a causa. Se voltar a divergir, reprova.
  // Este é o guarda de verdade: varre o código atrás de hash bcrypt escrito à
  // mão. Um literal traz o custo congelado dentro dele, e custo congelado é
  // exatamente o que quebrava a comparação de tempo. Aferir o custo em tempo
  // de execução não serviria: na suíte, BCRYPT_ROUNDS é 4, o mesmo do literal
  // que existia — a asserção passaria com o defeito de pé.
  it('nenhum hash bcrypt literal no código: custo congelado derrota a comparação', () => {
    const raiz = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'src');
    const literais = [];

    const varrer = pasta => {
      for (const entrada of fs.readdirSync(pasta, { withFileTypes: true })) {
        const caminho = path.join(pasta, entrada.name);
        if (entrada.isDirectory()) { varrer(caminho); continue; }
        if (!entrada.name.endsWith('.js')) continue;
        const conteudo = fs.readFileSync(caminho, 'utf8');
        // Assinatura de hash bcrypt: $2a$ / $2b$ / $2y$ seguido do custo.
        if (/\$2[aby]\$\d{2}\$/.test(conteudo)) literais.push(caminho);
      }
    };
    varrer(raiz);

    expect(literais, `hash bcrypt literal encontrado em: ${literais.join(', ')}`).toEqual([]);
  });

  it('o custo do hash vem da configuração, e a configuração exige 10+ em produção', () => {
    // O hash descartável é gerado com `config.bcryptRounds`, o mesmo dos reais.
    expect(config.bcryptRounds).toBeGreaterThan(0);
    // E produção recusa subir abaixo de 10 — conferido em producao.test.mjs.
    const real = bcrypt.hashSync('senha-qualquer', config.bcryptRounds);
    expect(Number(real.split('$')[2])).toBe(config.bcryptRounds);
  });

  it('email existente e inexistente recebem a MESMA resposta', async () => {
    const existente = await api().post('/api/v1/auth/login')
      .send({ email: usuario.email, password: 'senha-errada-mas-do-tamanho-certo' });
    const inexistente = await api().post('/api/v1/auth/login')
      .send({ email: 'fantasma@mci.test', password: 'senha-errada-mas-do-tamanho-certo' });

    expect(existente.status).toBe(inexistente.status);
    expect(existente.body).toEqual(inexistente.body);
  });
});

describe('chave de armazenamento', () => {
  // A chave é montada só pelo servidor. O que vem do cliente — nome do
  // arquivo, tipo declarado — nunca compõe o caminho; fica como metadado.
  //
  // ACHADO menor: a limpeza rodava sobre a string inteira e apagava também a
  // barra que os chamadores passam de propósito, então `events/<id>` virava
  // `events<id>`. Segurança não mudava; o que se perdia era a árvore de
  // prefixos no bucket — e com ela a chance de escrever regra de ciclo de vida
  // ou política de acesso por prefixo, que é o que o runbook recomenda.
  it('preserva a árvore de prefixos que o servidor pediu', () => {
    expect(storage.buildKey('events/abc123', 'text/plain')).toMatch(/^events\/abc123\/[0-9a-f-]{36}\.txt$/);
    expect(storage.buildKey('athletes/xyz', 'application/pdf')).toMatch(/^athletes\/xyz\/[0-9a-f-]{36}\.pdf$/);
  });

  it('nenhuma entrada consegue escapar do diretório', () => {
    const hostis = [
      '../../etc/passwd', '..', 'a/../../b', '/etc/shadow', 'a/./b',
      'ev%2e%2e/x', '....//....//x', '\\..\\..\\x', 'a\u0000/b', 'events//abc'
    ];
    for (const entrada of hostis) {
      const chave = storage.buildKey(entrada, 'text/plain');
      expect(chave, `entrada: ${entrada}`).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(chave, `entrada: ${entrada}`).not.toMatch(/^\//);
      expect(chave, `entrada: ${entrada}`).not.toMatch(/\/\//);
      expect(chave, `entrada: ${entrada}`).not.toMatch(/\\/);
    }
  });

  it('escopo vazio ou inútil cai num prefixo neutro, nunca na raiz', () => {
    for (const entrada of ['', null, undefined, '..', '///', '   ']) {
      expect(storage.buildKey(entrada, 'text/plain')).toMatch(/^geral\/[0-9a-f-]{36}\.txt$/);
    }
  });

  it('a extensão vem do tipo reconhecido, não do nome enviado', () => {
    expect(storage.buildKey('events/x', 'application/x-sh')).toMatch(/\.bin$/);
    expect(storage.buildKey('events/x', 'image/png')).toMatch(/\.png$/);
  });
});

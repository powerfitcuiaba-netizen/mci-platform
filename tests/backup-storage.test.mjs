// FASE 13 — backup e restauração dos ARQUIVOS, exercitados de verdade.
//
// O dump do PostgreSQL não guarda arquivo algum: guarda a referência. A fase
// 12.3 provou o efeito — documento restaurado aparecia na listagem do evento e
// o download devolvia 404. Estes testes existem para que o par banco+storage
// não volte a ser meia recuperação.
//
// A lista do que copiar vem do BANCO, não de uma varredura de diretório: assim
// funciona igual para disco e para bucket, e copia exatamente o que o sistema
// referencia — o que faz o backup casar com o dump da mesma janela.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto
} from './helpers.mjs';

const URL_BACKUP = process.env.BACKUP_DATABASE_URL;
const RAIZ = process.env.STORAGE_DIR || './uploads-test';

// Captura stdout E stderr: o relato sai num, os avisos saem no outro, e um
// teste que só lesse metade daria verde sem ter olhado a metade que importa.
function rodar(args, env = {}) {
  const resultado = spawnSync('node', args, {
    env: { ...process.env, ...env }, encoding: 'utf8'
  });
  return { ok: resultado.status === 0, saida: `${resultado.stdout || ''}${resultado.stderr || ''}` };
}

const relatoDe = saida => JSON.parse(saida.trim().split('\n').filter(l => l.startsWith('{')).pop());

let evento, diretor;
const enviados = [];
const temporarios = [];

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();
  const admin = await criarUsuario({ role: 'SUPER_ADMIN' });
  const org = await criarOrganizacao(admin, { name: 'Federação do Storage' });
  diretor = await criarUsuario({ name: 'Diretora do Storage' });
  await vincular(org.id, diretor, 'EVENT_DIRECTOR');
  const montado = await criarEventoCompleto(diretor, org.id);
  evento = montado.event;

  for (let i = 1; i <= 3; i++) {
    const conteudo = Buffer.from(`REGULAMENTO OFICIAL — documento ${i}\n`);
    const resposta = await api()
      .post(`/api/v1/events/${evento.id}/documents`)
      .set(diretor.auth())
      .attach('file', conteudo, { filename: `regulamento-${i}.txt`, contentType: 'text/plain' })
      .field('kind', 'REGULATION');
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    enviados.push({
      id: resposta.body.id,
      chave: resposta.body.storageKey,
      sha256: crypto.createHash('sha256').update(conteudo).digest('hex')
    });
  }
});

afterAll(() => {
  for (const caminho of temporarios) fs.rmSync(caminho, { recursive: true, force: true });
});

describe.skipIf(!URL_BACKUP)('backup e restauração do storage', () => {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-storage-'));
  temporarios.push(destino);
  let pasta = null;

  it('copia todo objeto que o banco referencia, com checksum', () => {
    const r = rodar(['scripts/backup-storage.js', destino], { DATABASE_URL: URL_BACKUP });
    expect(r.ok, r.saida).toBe(true);
    const relato = relatoDe(r.saida);
    pasta = relato.pasta;

    expect(relato.referenciados).toBe(3);
    expect(relato.copiados).toBe(3);
    expect(relato.ausentes).toBe(0);

    const manifesto = JSON.parse(fs.readFileSync(path.join(pasta, 'manifesto.json'), 'utf8'));
    for (const enviado of enviados) {
      const objeto = manifesto.objetos.find(o => o.chave === enviado.chave);
      expect(objeto, `chave ausente no manifesto: ${enviado.chave}`).toBeTruthy();
      // O checksum do manifesto é o do arquivo que o cliente enviou.
      expect(objeto.sha256).toBe(enviado.sha256);
      // E o arquivo copiado bate com o próprio checksum.
      const copia = fs.readFileSync(path.join(pasta, 'objetos', enviado.chave));
      expect(crypto.createHash('sha256').update(copia).digest('hex')).toBe(objeto.sha256);
    }

    // O checksum do manifesto é o do manifesto, não de outra coisa ao lado.
    const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(pasta, 'manifesto.json'))).digest('hex');
    expect(fs.readFileSync(path.join(pasta, 'manifesto.json.sha256'), 'utf8').trim()).toBe(real);
  });

  it('recusa restaurar sobre storage que já tem os objetos', () => {
    expect(pasta).toBeTruthy();
    const r = rodar(['scripts/restore-storage.js', pasta], { STORAGE_DIR: RAIZ });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('storage vazio');
  });

  it('restaura em storage vazio e os bytes voltam idênticos', () => {
    expect(pasta).toBeTruthy();
    const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-vazio-'));
    temporarios.push(vazio);

    const r = rodar(['scripts/restore-storage.js', pasta], { STORAGE_DIR: vazio });
    expect(r.ok, r.saida).toBe(true);
    expect(relatoDe(r.saida).restaurados).toBe(3);

    for (const enviado of enviados) {
      const conteudo = fs.readFileSync(path.join(vazio, enviado.chave));
      expect(crypto.createHash('sha256').update(conteudo).digest('hex')).toBe(enviado.sha256);
    }
  });

  it('recusa manifesto adulterado, sem gravar nada', () => {
    expect(pasta).toBeTruthy();
    const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-adulterado-'));
    const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-vazio-'));
    temporarios.push(copia, vazio);
    fs.cpSync(pasta, copia, { recursive: true });

    const manifesto = JSON.parse(fs.readFileSync(path.join(copia, 'manifesto.json'), 'utf8'));
    manifesto.totalCopiado = 999;
    fs.writeFileSync(path.join(copia, 'manifesto.json'), JSON.stringify(manifesto, null, 2));

    const r = rodar(['scripts/restore-storage.js', copia], { STORAGE_DIR: vazio });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('checksum do manifesto');
    expect(fs.readdirSync(vazio)).toHaveLength(0);
  });

  it('recusa objeto adulterado, e não grava NENHUM — nem os íntegros', () => {
    expect(pasta).toBeTruthy();
    const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-obj-'));
    const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-vazio-'));
    temporarios.push(copia, vazio);
    fs.cpSync(pasta, copia, { recursive: true });

    // Estraga UM objeto. Os outros dois seguem íntegros de propósito: storage
    // meio restaurado é pior do que storage nenhum, porque ninguém sabe onde
    // a restauração parou.
    fs.appendFileSync(path.join(copia, 'objetos', enviados[0].chave), 'x');

    const r = rodar(['scripts/restore-storage.js', copia], { STORAGE_DIR: vazio });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('checksum divergente');
    expect(r.saida).toContain('Nada foi gravado');
    expect(fs.readdirSync(vazio)).toHaveLength(0);
  });

  it('relata referência que aponta para arquivo inexistente, sem esconder', () => {
    // Perda de dado já ocorrida: o backup salva o que existe e diz quantas
    // referências ficaram órfãs, em vez de fingir que está tudo lá.
    const sumido = path.join(RAIZ, enviados[0].chave);
    const guardado = fs.readFileSync(sumido);
    fs.rmSync(sumido);
    try {
      const outro = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-parcial-'));
      temporarios.push(outro);
      const r = rodar(['scripts/backup-storage.js', outro], { DATABASE_URL: URL_BACKUP });
      expect(r.ok, r.saida).toBe(true);
      const relato = relatoDe(r.saida);
      expect(relato.referenciados).toBe(3);
      expect(relato.copiados).toBe(2);
      expect(relato.ausentes).toBe(1);
      expect(r.saida).toContain('AVISO');
    } finally {
      fs.mkdirSync(path.dirname(sumido), { recursive: true });
      fs.writeFileSync(sumido, guardado);
    }
  });
});

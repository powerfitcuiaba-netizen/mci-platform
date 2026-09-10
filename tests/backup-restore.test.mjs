// Backup e restauração exercitados de verdade.
//
// A FASE 12.3 encontrou o repositório SEM mecanismo de backup: havia só uma
// linha não marcada num checklist. Estes testes existem para que o mecanismo
// não volte a ser uma linha em checklist — cada garantia do procedimento é
// executada contra um PostgreSQL real.
//
// O que é provado aqui:
//   - o dump sai legível, com objetos, e com checksum que confere;
//   - o restore recusa banco de destino não vazio (não sobrescreve nada);
//   - o restore recusa dump corrompido ANTES de tocar no destino;
//   - o backup recusa rodar por papel sem BYPASSRLS, porque sob FORCE ROW
//     LEVEL SECURITY esse papel produziria um backup incompleto;
//   - o FORCE RLS e as políticas atravessam o restore;
//   - o dump não carrega segredo de ambiente.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const URL_TESTE = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';

// O papel de backup precisa de BYPASSRLS. Sem ele configurado no cluster de
// teste, o cenário não pode ser montado — e um teste que se declara verde sem
// ter rodado é pior do que teste nenhum.
const URL_BACKUP = process.env.BACKUP_DATABASE_URL;

const semUrl = url => url.replace(/\?.*$/, '');
const trocarBanco = (url, novo) => semUrl(url).replace(/\/[^/]+$/, `/${novo}`);

function rodar(comando, args, env = {}) {
  try {
    return { ok: true, saida: execFileSync(comando, args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (erro) {
    return { ok: false, codigo: erro.status, saida: `${erro.stdout || ''}${erro.stderr || ''}` };
  }
}
const psql = (url, sql) => rodar('psql', [semUrl(url), '-tAc', sql]);

// Só roda se houver PostgreSQL de verdade E papel de backup provisionado.
const disponivel = psql(URL_TESTE, 'select 1').ok;
const temPapelBackup = Boolean(URL_BACKUP) && psql(URL_BACKUP, 'select 1').ok;

describe.skipIf(!disponivel)('backup e restauração', () => {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-backup-'));
  const bancoAlvo = `mci_restore_teste_${crypto.randomBytes(4).toString('hex')}`;
  const urlAlvo = trocarBanco(URL_TESTE, bancoAlvo);
  let dump = null;

  afterAll(() => {
    psql(URL_TESTE, `DROP DATABASE IF EXISTS "${bancoAlvo}"`);
    fs.rmSync(destino, { recursive: true, force: true });
  });

  it.skipIf(!temPapelBackup)('produz um dump legível, com objetos e com checksum', () => {
    const r = rodar('bash', ['scripts/backup.sh', destino], { DATABASE_URL: URL_BACKUP });
    expect(r.saida).toBeTruthy();
    expect(r.ok, r.saida).toBe(true);
    const relato = JSON.parse(r.saida.trim().split('\n').pop());
    dump = relato.arquivo;
    expect(fs.existsSync(dump)).toBe(true);
    expect(relato.bytes).toBeGreaterThan(0);
    expect(relato.objetos).toBeGreaterThan(0);
    // O checksum gravado tem de ser o do arquivo — não um valor calculado
    // sobre outra coisa e escrito ao lado.
    const real = crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex');
    expect(fs.readFileSync(`${dump}.sha256`, 'utf8').trim()).toBe(real);
    expect(relato.sha256).toBe(real);
    // pg_restore --list prova que o arquivo é um dump, não bytes quaisquer.
    expect(rodar('pg_restore', ['--list', dump]).ok).toBe(true);
  });

  it('recusa fazer backup por papel sem BYPASSRLS, e não deixa arquivo parcial', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'mci-backup-neg-'));
    const r = rodar('bash', ['scripts/backup.sh', pasta], { DATABASE_URL: URL_TESTE });
    // O papel da suíte é o dono do schema: sob FORCE RLS ele NÃO pode dumpar.
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('FORCE ROW LEVEL SECURITY');
    // Regra dura: nada de arquivo com cara de backup depois de uma falha.
    expect(fs.readdirSync(pasta)).toHaveLength(0);
    fs.rmSync(pasta, { recursive: true, force: true });
  });

  it.skipIf(!temPapelBackup)('recusa restaurar dump corrompido, sem tocar no destino', () => {
    expect(dump).toBeTruthy();
    const adulterado = path.join(destino, 'adulterado.dump');
    fs.copyFileSync(dump, adulterado);
    fs.copyFileSync(`${dump}.sha256`, `${adulterado}.sha256`);
    fs.appendFileSync(adulterado, 'x');

    psql(URL_TESTE, `DROP DATABASE IF EXISTS "${bancoAlvo}"`);
    expect(psql(URL_TESTE, `CREATE DATABASE "${bancoAlvo}"`).ok).toBe(true);

    const r = rodar('bash', ['scripts/restore.sh', adulterado], { TARGET_DATABASE_URL: urlAlvo });
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('checksum');
    // Recusar depois de já ter criado metade das tabelas não seria recusar.
    const tabelas = psql(urlAlvo, "select count(*) from information_schema.tables where table_schema='public'");
    expect(tabelas.saida.trim()).toBe('0');
  });

  it.skipIf(!temPapelBackup)('restaura, preserva FORCE RLS e as políticas, e depois recusa repetir', () => {
    expect(dump).toBeTruthy();
    const r = rodar('bash', ['scripts/restore.sh', dump], { TARGET_DATABASE_URL: urlAlvo });
    expect(r.ok, r.saida).toBe(true);
    const relato = JSON.parse(r.saida.trim().split('\n').pop());
    expect(relato.tabelas).toBeGreaterThan(0);

    const contar = (url, sql) => Number(psql(url, sql).saida.trim());
    const forcado = "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relforcerowsecurity";
    const politicas = "select count(*) from pg_policies where schemaname='public'";

    // A barreira do banco tem de atravessar o restore: um banco recuperado com
    // RLS a menos é um vazamento silencioso no pior momento possível.
    expect(contar(urlAlvo, forcado)).toBe(contar(URL_TESTE, forcado));
    expect(contar(urlAlvo, forcado)).toBe(relato.tabelasComForceRls);
    expect(contar(urlAlvo, politicas)).toBe(contar(URL_TESTE, politicas));

    // Restaurar de novo, agora com o banco povoado, tem de ser recusado.
    const repetir = rodar('bash', ['scripts/restore.sh', dump], { TARGET_DATABASE_URL: urlAlvo });
    expect(repetir.ok).toBe(false);
    expect(repetir.saida).toContain('banco vazio');
  });

  it.skipIf(!temPapelBackup)('o dump não carrega segredo de ambiente', () => {
    expect(dump).toBeTruthy();
    const texto = path.join(destino, 'conferencia.sql');
    expect(rodar('pg_restore', ['-f', texto, dump]).ok).toBe(true);
    const conteudo = fs.readFileSync(texto, 'utf8');
    // Não se imprime o valor procurado — só se relata se ele apareceu.
    for (const segredo of [process.env.JWT_SECRET, senhaDe(URL_TESTE)]) {
      if (segredo && segredo.length >= 8) expect(conteudo.includes(segredo)).toBe(false);
    }
    fs.rmSync(texto, { force: true });
  });
});

function senhaDe(url) {
  const m = /\/\/[^:]+:([^@]+)@/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

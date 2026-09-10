#!/usr/bin/env node
//
// Backup dos ARQUIVOS do MCI — documento de atleta, mídia social, anexo de
// mensagem, foto de perfil.
//
// Existe porque o dump do PostgreSQL NÃO guarda arquivo algum. Ele guarda a
// referência (`storageKey`, `fileName`, `sizeBytes`); os bytes vivem fora do
// banco, em disco ou em bucket. Provado na fase 12.3: um documento enviado,
// dumpado e restaurado num ambiente de storage vazio aparecia na listagem do
// evento com título e tamanho, e o download devolvia 404.
//
// A lista do que copiar vem do BANCO, não de uma varredura do diretório. Duas
// razões: funciona igual para disco e para bucket, sem precisar listar objetos
// no provedor; e copia exatamente o que o sistema referencia, o que faz o
// backup casar com o dump da mesma janela. Arquivo órfão — sem linha que o
// aponte — não é copiado de propósito: ninguém precisa dele para recuperar.
//
// O caminho contrário também é relatado, e é o que importa: linha que aponta
// para arquivo inexistente. Isso é perda de dado já ocorrida, e o backup diz
// quantas são em vez de escondê-las.
//
// Uso:
//   DATABASE_URL='postgresql://mci_backup:...@host:5432/mci' \
//   STORAGE_DRIVER=s3 S3_BUCKET=... [demais variáveis do provedor] \
//     node scripts/backup-storage.js [diretório]
//
//   DATABASE_URL=... STORAGE_DIR=./uploads node scripts/backup-storage.js /var/backups/mci
//
// O papel do banco precisa enxergar todas as linhas: sob FORCE ROW LEVEL
// SECURITY, o dono do schema NÃO enxerga. É o mesmo papel de scripts/backup.sh.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const { Prisma, PrismaClient } = require('@prisma/client');
const storage = require('../src/services/storageService');

// Campos `*Key` que NÃO apontam para o storage. Ficam listados porque a
// varredura abaixo reprova diante de qualquer campo desconhecido: assim uma
// coluna nova de arquivo não passa despercebida — o backup para e pede
// classificação em vez de deixar os bytes de fora em silêncio.
const NAO_SAO_ARQUIVO = new Set([
  // Chave determinística da conversa direta entre dois perfis. É identidade,
  // não caminho de objeto.
  'Conversation.directKey'
]);

function mapearCampos() {
  const arquivos = [];
  const desconhecidos = [];

  for (const modelo of Prisma.dmmf.datamodel.models) {
    for (const campo of modelo.fields) {
      if (campo.type !== 'String' || !/Key$/.test(campo.name)) continue;
      const nome = `${modelo.name}.${campo.name}`;
      if (NAO_SAO_ARQUIVO.has(nome)) continue;
      if (/^(storageKey|photoKey|avatarKey|coverKey)$/.test(campo.name)) arquivos.push({ modelo: modelo.name, campo: campo.name, opcional: !campo.isRequired });
      else desconhecidos.push(nome);
    }
  }

  if (desconhecidos.length) {
    throw new Error(
      `campo "*Key" não classificado: ${desconhecidos.join(', ')}.\n`
      + 'Se aponta para o storage, acrescente o nome ao padrão em mapearCampos(); '
      + 'se não aponta, liste em NAO_SAO_ARQUIVO. O backup não continua às cegas.'
    );
  }
  return arquivos;
}

const nomeDelegate = modelo => modelo.charAt(0).toLowerCase() + modelo.slice(1);

async function coletarChaves(prisma, campos) {
  const chaves = new Map();

  for (const { modelo, campo, opcional } of campos) {
    // `not: null` só é aceito em coluna anulável; em coluna obrigatória o
    // Prisma recusa a consulta. Quem diz qual é qual é o próprio schema.
    const linhas = await prisma[nomeDelegate(modelo)].findMany({
      ...(opcional ? { where: { [campo]: { not: null } } } : {}),
      select: { id: true, [campo]: true }
    });
    for (const linha of linhas) {
      const chave = linha[campo];
      if (!chave) continue;
      if (!chaves.has(chave)) chaves.set(chave, []);
      chaves.get(chave).push(`${modelo}.${campo}#${linha.id}`);
    }
  }
  return chaves;
}

async function copiar(chave, destinoRaiz) {
  const destino = path.join(destinoRaiz, 'objetos', chave);
  await fsp.mkdir(path.dirname(destino), { recursive: true });

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const leitura = await storage.createReadStream(chave);
  leitura.on('data', pedaco => { bytes += pedaco.length; hash.update(pedaco); });
  await pipeline(leitura, fs.createWriteStream(destino));

  return { sha256: hash.digest('hex'), bytes };
}

async function principal() {
  const destinoRaiz = process.argv[2] || process.env.BACKUP_DIR || './backups';
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não definida');

  const campos = mapearCampos();
  const prisma = new PrismaClient();
  const inicio = Date.now();

  const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const pasta = path.join(destinoRaiz, `storage-${carimbo}`);

  // Falha no meio não pode deixar uma pasta parcial com cara de backup bom.
  const limpar = () => fs.rmSync(pasta, { recursive: true, force: true });

  try {
    await fsp.mkdir(pasta, { recursive: true });

    const chaves = await coletarChaves(prisma, campos);
    const objetos = [];
    const ausentes = [];

    for (const [chave, origens] of chaves) {
      if (!(await storage.exists(chave))) { ausentes.push({ chave, origens }); continue; }
      const { sha256, bytes } = await copiar(chave, pasta);
      objetos.push({ chave, sha256, bytes, origens });
    }

    const manifesto = {
      criadoEm: new Date().toISOString(),
      driver: storage.driver(),
      camposLidos: campos.map(c => `${c.modelo}.${c.campo}`),
      totalReferenciado: chaves.size,
      totalCopiado: objetos.length,
      totalAusente: ausentes.length,
      bytes: objetos.reduce((soma, o) => soma + o.bytes, 0),
      objetos,
      // Linha que aponta para arquivo que não existe. Não impede o backup — o
      // que existe continua sendo salvo —, mas é perda de dado já ocorrida e
      // aparece no relato em vez de sumir.
      ausentes
    };

    const caminhoManifesto = path.join(pasta, 'manifesto.json');
    await fsp.writeFile(caminhoManifesto, JSON.stringify(manifesto, null, 2));
    const somaManifesto = crypto.createHash('sha256').update(await fsp.readFile(caminhoManifesto)).digest('hex');
    await fsp.writeFile(`${caminhoManifesto}.sha256`, `${somaManifesto}\n`);

    console.log(JSON.stringify({
      pasta,
      driver: manifesto.driver,
      referenciados: manifesto.totalReferenciado,
      copiados: manifesto.totalCopiado,
      ausentes: manifesto.totalAusente,
      bytes: manifesto.bytes,
      ms: Date.now() - inicio,
      sha256: somaManifesto
    }));

    if (ausentes.length) {
      console.error(`AVISO: ${ausentes.length} referência(s) apontam para arquivo inexistente. Ver "ausentes" no manifesto.`);
    }
  } catch (erro) {
    limpar();
    throw erro;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

principal().catch(erro => {
  process.stderr.write(`FALHA: ${erro.message}\n`);
  process.exit(1);
});

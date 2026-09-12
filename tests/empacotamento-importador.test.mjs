import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { prisma, limparBanco, criarUsuario, criarOrganizacao } from './helpers.mjs';

// ==========================================================================
// O script que existe na imagem e o dado que ele lê precisam viajar juntos.
//
// O importador de campeonatos foi para produção sem o calendário: o Dockerfile
// enumera as cópias uma a uma, `data/` nasceu depois da última edição dele, e
// nada acusou. O deploy subiu verde e o script morreu com ENOENT em
// /app/data/campeonatos-2026.json — a falha só aparece quando alguém roda.
//
// Este arquivo fecha os dois lados: o empacotamento (o diretório entra na
// imagem, e o .dockerignore não o tira do contexto) e o comportamento do
// importador (acha o arquivo de qualquer diretório, e --dry-run não grava).
//
// Docker não está disponível neste ambiente, então a parte de empacotamento é
// verificada lendo o Dockerfile e o .dockerignore, não construindo a imagem.
// É uma prova mais fraca do que um build real e está dita aqui como tal.
// ==========================================================================

const RAIZ = process.cwd();
const dockerfile = readFileSync('Dockerfile', 'utf8');

// O estágio final é o que vira a imagem executada. Copiar no estágio `deps`
// não colocaria nada em produção.
const estagioDeRuntime = (() => {
  const partes = dockerfile.split(/^FROM\s+\S+\s+AS\s+runtime\s*$/m);
  if (partes.length !== 2) throw new Error('Dockerfile sem um único estágio "runtime": este teste precisa ser revisto junto com ele.');
  return partes[1];
})();

// Fontes de cada COPY do estágio de runtime — a última palavra da linha é o
// destino.
const origensCopiadas = [...estagioDeRuntime.matchAll(/^COPY(?:\s+--from=\S+)?\s+(.+)$/gm)]
  .flatMap(linha => linha[1].trim().split(/\s+/).slice(0, -1));

// Reprodução simplificada do casamento de padrões do .dockerignore: basta para
// os padrões que este repositório usa (nomes literais e `*` dentro de um
// segmento). Não substitui o build real; serve para acusar o dia em que
// alguém acrescentar uma linha que apague `data/` do contexto.
function excluidoDoContexto(caminho) {
  const escapar = texto => texto.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const segmentos = caminho.split('/');
  const prefixos = segmentos.map((_, i) => segmentos.slice(0, i + 1).join('/'));

  let excluido = false;
  for (const linha of readFileSync('.dockerignore', 'utf8').split('\n').map(l => l.trim())) {
    if (!linha || linha.startsWith('#')) continue;
    const negacao = linha.startsWith('!');
    const padrao = negacao ? linha.slice(1) : linha;
    const regex = new RegExp(`^${padrao.split('/').map(seg => seg.split('*').map(escapar).join('[^/]*')).join('/')}$`);
    if (prefixos.some(prefixo => regex.test(prefixo))) excluido = !negacao;
  }
  return excluido;
}

// O caminho não é redigitado aqui: a expressão é extraída do próprio
// importador e avaliada com o __dirname que ele teria. Se alguém mover o
// arquivo, o teste segue a mudança em vez de testar uma cópia desatualizada.
const caminhoQueOImportadorLe = (() => {
  const fonte = readFileSync('scripts/importar-campeonatos.js', 'utf8');
  const expressao = fonte.match(/^const ARQUIVO = (.+);$/m)?.[1];
  if (!expressao) throw new Error('constante ARQUIVO não encontrada no importador');
  return vm.runInNewContext(expressao, { path, __dirname: path.join(RAIZ, 'scripts') });
})();

describe('empacotamento do importador de campeonatos', () => {
  it('o arquivo que o importador lê existe no repositório e tem os 47 campeonatos', () => {
    const dados = JSON.parse(readFileSync(caminhoQueOImportadorLe, 'utf8'));
    expect(dados.eventos).toHaveLength(47);
  });

  it('o diretório desse arquivo é copiado para a imagem no estágio de runtime', () => {
    const relativo = path.relative(RAIZ, caminhoQueOImportadorLe);
    expect(relativo.startsWith('..'), `${relativo} está fora do repositório`).toBe(false);

    const diretorioDeTopo = relativo.split(path.sep)[0];
    expect(origensCopiadas, `o Dockerfile não copia "${diretorioDeTopo}": o script iria para a imagem sem o dado que lê`)
      .toContain(diretorioDeTopo);
  });

  it('o .dockerignore não tira esse arquivo do contexto de build', () => {
    const relativo = path.relative(RAIZ, caminhoQueOImportadorLe).split(path.sep).join('/');
    expect(excluidoDoContexto(relativo), `${relativo} está excluído do contexto: o COPY falharia no build`).toBe(false);
  });

  it('o script que lê o arquivo também é copiado — os dois viajam juntos ou nenhum serve', () => {
    expect(origensCopiadas).toContain('scripts');
    expect(excluidoDoContexto('scripts/importar-campeonatos.js')).toBe(false);
  });
});

describe('importador: localização do arquivo e --dry-run', () => {
  const executar = (args, cwd) => spawnSync(
    process.execPath,
    [path.join(RAIZ, 'scripts', 'importar-campeonatos.js'), ...args],
    { cwd, env: process.env, encoding: 'utf8', timeout: 120000 }
  );

  const contar = async () => ({
    eventos: await prisma.event.count(),
    temporadas: await prisma.rankingSeason.count(),
    auditoria: await prisma.auditLog.count()
  });

  let admin;

  beforeAll(async () => {
    await limparBanco();
    admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador da importação' });
    await criarOrganizacao(admin, { name: 'Muscle Contest Brasil' });
  });

  it('acha o arquivo rodando de OUTRO diretório — o caminho é relativo ao script, não ao cwd', async () => {
    const antes = await contar();
    // O diretório temporário do sistema não tem `data/` nenhum: se o importador
    // dependesse do cwd, este é o cenário que quebraria — e é o cenário do
    // Render, onde o processo não parte da raiz do projeto.
    const resultado = executar(['--dry-run'], path.parse(RAIZ).root);

    expect(resultado.stderr, 'o importador não localizou o arquivo').not.toMatch(/ENOENT|no such file/i);
    expect(resultado.status, `stdout: ${resultado.stdout}\nstderr: ${resultado.stderr}`).toBe(0);
    expect(resultado.stdout).toContain('ENSAIO — nada será gravado');
    expect(resultado.stdout).toMatch(/criados 47/);

    // A prova de que o ensaio é ensaio: nenhuma linha a mais em lugar nenhum,
    // nem sequer no log de auditoria.
    expect(await contar()).toEqual(antes);
  });

  it('--dry-run não cria nem a temporada — o efeito colateral mais fácil de passar batido', async () => {
    expect(await prisma.rankingSeason.count()).toBe(0);
    expect(await prisma.event.count()).toBe(0);
  });

  it('com mais de uma organização, recusa escolher sozinho e não grava nada', async () => {
    await criarOrganizacao(admin, { name: 'Segunda federação' });
    const antes = await contar();

    const resultado = executar([], RAIZ);

    expect(resultado.status).not.toBe(0);
    expect(resultado.stderr).toMatch(/Há 2 organizações/);
    expect(resultado.stderr).toMatch(/--organizacao=/);
    expect(await contar()).toEqual(antes);
  });

  it('só aceita DRAFT ou PLANNED: a importação não abre inscrição', () => {
    const resultado = executar(['--status=REGISTRATIONS_OPEN', '--dry-run'], RAIZ);
    expect(resultado.status).not.toBe(0);
    expect(resultado.stderr).toMatch(/--status aceita apenas DRAFT ou PLANNED/);
  });
});

describe('o calendário não pede migration nenhuma', () => {
  it('as migrations continuam sendo exatamente as já homologadas', () => {
    // Carregar o calendário é escrita em tabela existente: `Event` e
    // `RankingSeason` já existem desde 20260906120000. Uma migration nova
    // entrando junto com uma carga de dados seria mudança de schema disfarçada
    // de importação — esta lista só muda de propósito, com revisão.
    const migrations = readdirSync('prisma/migrations').filter(nome => /^\d{14}_/.test(nome)).sort();
    expect(migrations).toEqual([
      '20260906120000_mci_dominio_esportivo',
      '20260906130000_rls',
      '20260906180000_force_rls',
      '20260906190000_rls_conversa_estrita',
      '20260906200000_rls_politicas_por_comando',
      '20260906210000_rls_superficie_publica',
      '20260906220000_rls_autor_ve_o_proprio_conteudo',
      '20260906230000_cpf_em_tabela_propria',
      '20260906240000_pontuacao_overall_desempate',
      '20260906250000_classes_e_super_overall',
      '20260906260000_empresas_competidoras',
      '20260906270000_vinculo_unico_atleta_equipe',
      '20260906280000_pontos_do_campeonato_e_super_overall'
    ]);
  });
});

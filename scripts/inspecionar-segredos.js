#!/usr/bin/env node
// ==========================================================================
// INSPEÇÃO DE SEGREDOS — SEM IMPRIMIR NENHUM VALOR.
//
// POR QUE ESTE SCRIPT EXISTE (achado A-08)
//
// A auditoria independente encontrou a credencial do PostgreSQL de
// desenvolvimento escrita por extenso em 17 arquivos de ferramental (suíte,
// scripts de QA, mutação). Não é vazamento de produção — é a senha do banco
// DESCARTÁVEL que a suíte cria e destrói na máquina de quem desenvolve, e ela
// precisa ser conhecida para o comando ser um comando só. Trocá-la por variável
// de ambiente em 17 arquivos não aumentaria segurança nenhuma e tiraria do ar o
// `npm test` de quem clona o repositório.
//
// O que FALTAVA era o controle: alguma coisa que distinga "credencial local
// conhecida e documentada" de "segredo de verdade commitado por engano". É isso
// que este script faz, e ele é a resposta ao achado.
//
// REGRA DE OURO DESTE ARQUIVO: nenhum valor é impresso. Nem inteiro, nem
// parcial, nem em mensagem de erro. O que sai é ARQUIVO, LINHA e a CLASSE do
// achado. Quem precisa ver o valor abre o arquivo — e essa pessoa já tem acesso
// a ele.
//
//     node scripts/inspecionar-segredos.js
//
// Saída 0 = nenhum segredo desconhecido em arquivo versionado.
// Saída 1 = há achado a explicar. Saída 2 = o próprio script não pôde rodar.
// ==========================================================================

const { execSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const VERMELHO = s => `\x1b[31m${s}\x1b[0m`;
const AMARELO = s => `\x1b[33m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

// ---------------------------------------------------------------- padrões
//
// Cada padrão descreve uma FORMA de segredo, não um valor. `classe` é o que o
// relatório imprime; o trecho casado nunca sai daqui.
const PADROES = [
  { classe: 'URL de banco com senha', re: /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/gi },
  { classe: 'chave privada PEM', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { classe: 'token do GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { classe: 'chave da AWS', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { classe: 'chave de API genérica', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/gi },
  { classe: 'JWT concreto', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g }
];

// ------------------------------------------------------------ permitidos
//
// LISTA EXPLÍCITA, e cada linha precisa de uma razão escrita. É o oposto de
// silenciar o scanner: quem adicionar uma entrada aqui está afirmando, por
// escrito, que aquilo não é segredo.
const PERMITIDOS = [
  {
    // A senha do PostgreSQL LOCAL da suíte. O banco é criado e destruído pela
    // própria suíte, aceita conexão só de 127.0.0.1 e não existe em ambiente
    // nenhum de publicação. Nome e senha são fixos de propósito: é o que faz
    // `npm test` funcionar sem configuração.
    classe: 'URL de banco com senha',
    re: /postgresql:\/\/mci:mci_local_dev@127\.0\.0\.1:5432\//,
    porQue: 'banco PostgreSQL local e descartável da suíte; não existe em publicação'
  },
  {
    // Os outros bancos locais do ferramental (QA visual, mutação, carga). Todos
    // em 127.0.0.1, todos criados e destruídos pelo próprio script.
    classe: 'URL de banco com senha',
    re: /@127\.0\.0\.1:5432\//,
    caminho: /^(?:scripts\/|tests\/|docs\/)/,
    porQue: 'banco local (127.0.0.1) de ferramental descartável'
  },
  {
    // O serviço PostgreSQL do runner do GitHub Actions. Vive dentro do job,
    // morre com ele, e não é alcançável de fora. As credenciais do job são
    // literais de propósito: o banco não sobrevive ao job.
    classe: 'URL de banco com senha',
    re: /@localhost:5432\//,
    caminho: /^\.github\/workflows\//,
    porQue: 'PostgreSQL efêmero do runner de CI, criado e destruído no job'
  },
  {
    // Exemplos de documentação: `host`, `<banco>`, `usuario`. Existem para ser
    // substituídos, e substituí-los é justamente o que a instrução pede.
    classe: 'URL de banco com senha',
    re: /@(?:host|HOST|<[^>]*>|servidor|localhost):/,
    caminho: /^(?:docs\/|scripts\/)/,
    porQue: 'placeholder de documentação'
  },
  {
    classe: 'URL de banco com senha',
    re: /postgres(?:ql)?:\/\//,
    caminho: /(?:^|\/)\.env\.example$/,
    porQue: 'arquivo de exemplo: é o molde que quem publica preenche'
  },
  {
    // Exemplos genéricos com usuário/senha nomeados.
    classe: 'URL de banco com senha',
    re: /postgres(?:ql)?:\/\/(?:usuario|user|USER|usuário|SENHA|senha|exemplo|example)[^@]*@/,
    porQue: 'placeholder de documentação'
  }
];

const EXTENSOES = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.yml', '.yaml', '.md', '.sql', '.sh', '.example', '.txt', '.env']);
const LIMITE_DE_BYTES = 2 * 1024 * 1024;

function arquivosVersionados() {
  // `git ls-files` é a fonte certa: o que importa é o que está VERSIONADO. Um
  // segredo num arquivo ignorado incomoda quem o tem na máquina; um segredo
  // versionado incomoda todo mundo, para sempre.
  const saida = execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return saida.split('\0').filter(Boolean);
}

// A conferência é sobre a LINHA INTEIRA, e não sobre o trecho casado: o padrão
// para de casar no `@`, então só a linha diz qual é o host — e é o host que
// separa "banco local descartável" de "banco de verdade". A linha nunca é
// impressa; ela só entra aqui.
function ehPermitido(classe, linha, caminho) {
  return PERMITIDOS.find(p =>
    p.classe === classe
    && p.re.test(linha)
    && (!p.caminho || p.caminho.test(caminho))) ?? null;
}

function principal() {
  let arquivos;
  try {
    arquivos = arquivosVersionados();
  } catch {
    console.error('não foi possível listar os arquivos versionados (git ls-files).');
    process.exitCode = 2;
    return;
  }

  const achados = [];
  const tolerados = [];
  let lidos = 0;

  for (const caminho of arquivos) {
    const ponto = caminho.lastIndexOf('.');
    const ext = ponto >= 0 ? caminho.slice(ponto) : '';
    if (!EXTENSOES.has(ext) && !caminho.endsWith('.env.example')) continue;

    let conteudo;
    try {
      if (statSync(caminho).size > LIMITE_DE_BYTES) continue;
      conteudo = readFileSync(caminho, 'utf8');
    } catch {
      continue;
    }
    lidos += 1;

    const linhas = conteudo.split('\n');
    for (const { classe, re } of PADROES) {
      for (let i = 0; i < linhas.length; i += 1) {
        // `re` é global: reiniciar o índice é obrigatório entre linhas, senão
        // metade dos casos passa batido.
        re.lastIndex = 0;
        const casado = re.exec(linhas[i]);
        if (!casado) continue;

        const permitido = ehPermitido(classe, linhas[i], caminho);
        // ATENÇÃO: `casado[0]` NÃO entra no registro. Só a posição e a classe.
        const registro = { caminho, linha: i + 1, classe, porQue: permitido?.porQue ?? null };
        if (permitido) tolerados.push(registro);
        else achados.push(registro);
      }
    }
  }

  console.log('=== INSPEÇÃO DE SEGREDOS EM ARQUIVO VERSIONADO ===\n');
  console.log(`arquivos inspecionados ......... ${lidos}`);
  console.log(`${CINZA('achados PERMITIDOS (com razão escrita)')} ... ${tolerados.length}`);
  console.log(`${achados.length ? VERMELHO('achados A EXPLICAR') : VERDE('achados A EXPLICAR')} ............ ${achados.length}\n`);

  if (tolerados.length) {
    console.log('--- PERMITIDOS ---');
    const porRazao = new Map();
    for (const t of tolerados) {
      const chave = `${t.classe} — ${t.porQue}`;
      porRazao.set(chave, (porRazao.get(chave) ?? 0) + 1);
    }
    for (const [chave, quantas] of porRazao) console.log(`  ${quantas.toString().padStart(3)}x  ${chave}`);
    console.log('');
  }

  if (!achados.length) {
    console.log(VERDE('NENHUM segredo desconhecido em arquivo versionado.'));
    console.log(CINZA('Nenhum valor foi impresso por este script — por desenho.'));
    return;
  }

  console.log(VERMELHO('--- A EXPLICAR (arquivo e linha; o valor NÃO é impresso) ---'));
  for (const a of achados) console.log(`  ${a.caminho}:${a.linha}  ${a.classe}`);
  console.log('');
  console.log(AMARELO('Cada linha acima é: um segredo a remover do histórico, ou uma entrada nova'));
  console.log(AMARELO('em PERMITIDOS com a razão escrita. Não há terceira opção.'));
  process.exitCode = 1;
}

principal();

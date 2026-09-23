// ==========================================================================
// A CONFERÊNCIA QUE FALTAVA NOS SCRIPTS DE MUTAÇÃO.
//
// POR QUE ELA EXISTE — e a resposta é um defeito que quase foi para produção.
//
// Um script de mutação passa a execução inteira com o repositório sujo de
// propósito: ele escreve o mutante, roda a suíte, restaura, repete. Durante os
// quinze minutos em que roda, QUALQUER `git add -A` em outro lugar fotografa o
// arquivo no meio da mutação e commita o defeito.
//
// Foi exatamente o que aconteceu. Um commit feito enquanto a bateria rodava
// levou junto `homonimos: false` — o mutante que apaga o aviso de homônimos do
// histórico importado. O script restaurou o arquivo em seguida, como sempre
// faz, e o resultado foi o pior dos dois mundos: a árvore de trabalho CERTA, o
// commit ERRADO, e nada acusando.
//
// O QUE ESTA CONFERÊNCIA FAZ
//
// Depois de restaurar, compara cada arquivo alvo com o que o git tem em HEAD.
// Se diferirem, uma de duas coisas aconteceu, e as duas são graves:
//
//   * a restauração falhou — o mutante ficou na árvore de trabalho;
//   * alguém commitou durante a execução — o mutante ficou no histórico.
//
// Nos dois casos o script reprova e diz qual arquivo. Um gate de mutação que
// não sabe se ele mesmo sujou o repositório não tem autoridade para aprovar
// coisa nenhuma.
// ==========================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function conferirRestauracao(raiz, arquivos) {
  const divergentes = [];

  for (const relativo of [...new Set(arquivos)]) {
    let noGit;
    try {
      noGit = execFileSync('git', ['show', `HEAD:${relativo}`], {
        cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
      });
    } catch {
      // Arquivo que o git não conhece não tem com o que ser comparado. Não é
      // o caso dos alvos de mutação, mas engasgar aqui esconderia o problema
      // de verdade.
      continue;
    }

    const noDisco = readFileSync(path.join(raiz, relativo), 'utf8');
    if (noDisco !== noGit) divergentes.push(relativo);
  }

  return divergentes;
}

export function relatarRestauracao(divergentes) {
  if (!divergentes.length) {
    console.log('  restauração .... conferida contra o git — nenhum arquivo alvo divergente');
    return true;
  }

  console.log(`\n  RESTAURAÇÃO DIVERGENTE .. ${divergentes.length} arquivo(s) diferem do que o git tem em HEAD:`);
  for (const arquivo of divergentes) console.log(`     x ${arquivo}`);
  console.log('     Ou a restauração falhou, ou houve commit DURANTE esta execução.');
  console.log('     Confira com: git diff -- <arquivo>   e   git show HEAD -- <arquivo>');
  return false;
}

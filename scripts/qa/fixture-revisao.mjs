#!/usr/bin/env node
// ============================================================================
// A PÁGINA DE MEDIÇÃO DA REVISÃO DE IMPORTAÇÃO — 191 LINHAS, DADOS DE QA.
//
// `modal-na-viewport.mjs` precisa de uma revisão do tamanho real (o Ipiranga
// tem 191 registros) para medir se o diálogo cabe. Montar essa página à mão na
// máquina de quem roda o script tornava a medição irreprodutível: cada um
// media um HTML diferente, e o número não valia como prova.
//
// OS NOMES SÃO DE QA, NÃO DE ATLETAS.
// -----------------------------------------------------------------------
// Este repositório é público. Nenhum nome, CPF ou matrícula de competidor
// real entra aqui. Os nomes começam com "QA" justamente para que ninguém os
// confunda com cadastro, e o CPF já vai na forma mascarada que a tela mostra.
// O COMPRIMENTO deles, porém, é calibrado pelo pior caso real (28 caracteres,
// nome composto com preposição): medir com nome curto daria um "cabe" falso.
//
// As CLASSES são as formas oficiais que chegam no arquivo do MuscleWare —
// elas decidem a largura da coluna e não podem ser encurtadas para a medição
// passar.
//
// USO:  node scripts/qa/fixture-revisao.mjs <pasta-de-saida>
//       (escreve revisao.html e copia frontend/src/styles.css para o lado)
// ============================================================================

import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Sete arquétipos: cada um cobre um comprimento de nome e uma situação. A
// tabela repete o ciclo até 191 para que toda coluna seja exercitada.
const MODELOS = [
  { nome: 'QA ATLETA NOME COMPOSTO LONGO', categoria: 'MENS_BODYBUILDING',
    classe: "Men's Bodybuilding - Open Middleweight",
    selo: ['perigo', 'REJEITADO'], motivo: 'Registro sem identificador externo' },
  { nome: 'QA ATLETA DOIS', categoria: 'CLASSIC_PHYSIQUE',
    classe: "Men's Classic Physique - Open Class A",
    selo: ['ok', 'RECONHECIDO'], motivo: 'por matrícula de filiação' },
  { nome: 'QA ATLETA DOS SANTOS TRES', categoria: 'BIKINI',
    classe: "Women's Bikini - Novice",
    selo: ['alerta', 'PENDENTE'], motivo: 'Atleta não encontrado' },
  { nome: 'QA ATLETA DE ALMEIDA QUATRO', categoria: 'MENS_PHYSIQUE',
    classe: "Men's Physique - Masters 35+",
    selo: ['perigo', 'CONFLITO'], motivo: 'Categoria não identificada a partir da classe' },
  { nome: 'QA ATLETA CINCO', categoria: 'WELLNESS',
    classe: "Women's Wellness - Open Class B",
    selo: ['neutro', 'DUPLICADO'], motivo: 'Resultado já existente na plataforma' },
  { nome: 'QA ATLETA DA SILVA SEIS', categoria: 'FITMODEL',
    classe: "Women's Fit Model - True Novice",
    selo: ['perigo', 'REJEITADO'], motivo: 'Registro sem identificador externo' },
  { nome: 'QA ATLETA SETE', categoria: 'MENS_BODYBUILDING',
    classe: "Men's Bodybuilding - Junior",
    selo: ['ok', 'RECONHECIDO'], motivo: 'por matrícula de filiação' }
];

const TOTAL = 191;
const POR_PAGINA = 50;

const escapar = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function linhas() {
  const saida = [];
  for (let i = 0; i < POR_PAGINA; i += 1) {
    const m = MODELOS[i % MODELOS.length];
    const ordem = String(i).padStart(2, '0').slice(-2);
    saida.push(
      '<tr>'
      + `<td class="num">${i + 1}</td>`
      + `<td class="num">***.***.**${ordem}-**</td>`
      + `<td>${escapar(m.nome)}</td><td>NPC</td>`
      + `<td class="num">${88000 + i}</td>`
      + `<td>${m.categoria}</td>`
      + `<td>${escapar(m.classe)}</td>`
      + `<td class="num">${(i % 7) + 1}</td><td class="num">—</td>`
      + `<td><span class="badge badge-${m.selo[0]}">${m.selo[1]}</span>`
      + '<small style="display:block;color:var(--cinza-fraco);margin-top:3px">'
      + `${escapar(m.motivo)}</small></td>`
      + '<td><div class="acoes-da-linha">'
      + '<button type="button" class="button button-secondary button-sm">Vincular</button>'
      + '</div></td>'
      + '</tr>'
    );
  }
  return saida.join('\n');
}

const metrica = (rotulo, valor) => `<div class="metric"><span>${rotulo}</span><strong>${valor}</strong></div>`;

export function gerarFixture(destino) {
  mkdirSync(destino, { recursive: true });
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revisar importação — medição de QA</title>
<link rel="stylesheet" href="styles.css"></head>
<body><div class="shell"><div class="main"><main><div class="page">
<header class="page-head"><h1>Importações MuscleWare</h1></header></div></main></div></div>

<div class="modal-layer" role="dialog" aria-modal="true" aria-label="Revisar importação">
<button type="button" class="modal-scrim" tabindex="-1" aria-hidden="true"></button>
<div class="modal modal-wide" tabindex="-1">
<div class="modal-head"><div><h2>Revisar importação</h2>
<p>Confira os totais antes de aplicar. Linhas pendentes podem ser vinculadas manualmente.</p></div>
<button type="button" class="icon-button" aria-label="Fechar">X</button></div>

<div class="alert alert-info" style="margin-bottom:14px"><div>
<strong>Etapa de QA</strong><p>12/09/2026 · Cuiabá/MT · Temporada 2026</p></div></div>

<div class="import-summary">
${metrica('Registros', TOTAL)}
${metrica('Reconhecidos', 0)}
${metrica('Pendentes', 0)}
${metrica('Conflitos', 0)}
${metrica('Duplicados', 0)}
${metrica('Rejeitados', TOTAL)}
${metrica('Aplicados', 0)}
</div>

<div class="import-filtros">
<div class="import-busca"><input type="search" placeholder="Buscar atleta, matrícula, classe..."></div>
<label for="f">Situação</label><select id="f"><option>Todas</option></select>
<label for="fc">Categoria</label><select id="fc"><option>Todas</option></select>
<span class="import-contagem">Mostrando 1–${POR_PAGINA} de ${TOTAL} registros</span></div>

<div class="table-wrap tabela-em-modal"><table class="table">
<thead><tr><th>#</th><th>CPF</th><th>Atleta</th><th>Filiação</th><th>Matrícula</th>
<th>Categoria</th><th>Classe</th><th class="num">Col.</th><th class="num">Pts arquivo</th>
<th>Situação</th><th></th></tr></thead>
<tbody>
${linhas()}
</tbody></table></div>

<div class="import-paginacao">
<button type="button" class="button button-secondary button-sm" disabled>Anterior</button>
<span>Página 1 de 4</span>
<button type="button" class="button button-secondary button-sm">Próxima</button></div>

<div class="modal-actions">
<button type="button" class="button button-secondary">Cancelar</button>
<button type="button" class="button button-primary">Aplicar importação</button></div>
</div></div></body></html>
`;
  writeFileSync(resolve(destino, 'revisao.html'), html);
  copyFileSync(resolve(RAIZ, 'frontend/src/styles.css'), resolve(destino, 'styles.css'));
  return destino;
}

// Chamado direto pela linha de comando: gera e diz onde ficou.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destino = resolve(process.argv[2] || 'tmp/qa-revisao');
  gerarFixture(destino);
  console.log(destino);
}

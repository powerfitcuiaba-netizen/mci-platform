import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', '..');
const SAIDA = path.join(AQUI, 'build');

// A marca oficial é lida do seu único lugar no repositório. Não existe cópia,
// recorte nem variante: ver frontend/public/LEIA-marca.md.
const MARCA = path.join(RAIZ, 'frontend', 'public', 'marca-mci.png');
const marca = fs.readFileSync(MARCA).toString('base64');

const mapa = JSON.parse(fs.readFileSync(path.join(SAIDA, 'mapa.json'), 'utf8')); // titulo -> pagina em corpo.pdf
const deslocamento = Number(process.argv[2] || 0);              // folhas pre-textuais contadas

const corpo = fs.readFileSync(path.join(AQUI, 'corpo.html'), 'utf8');
const titulos = [...corpo.matchAll(/<h([12])[^>]*>(.*?)<\/h\1>/g)].map(m => ({
  nivel: Number(m[1]),
  texto: m[2].replace(/<[^>]+>/g, '').trim()
}));

const normalizar = s => s.toLowerCase().replace(/\s+/g, '');

function paginaDe(texto) {
  const chave = normalizar(texto);
  return mapa[chave] ? mapa[chave] + deslocamento : '—';
}

const itensSumario = titulos.map(t => {
  const m = t.texto.match(/^([\d.]+)\s+(.*)$/);
  const ind = m ? m[1] : '';
  const tit = m ? m[2] : t.texto;
  return `<li class="n${t.nivel}"><div class="linha"><span class="ind">${ind}</span><span class="tit">${tit}</span><span class="pontos"></span><span class="pg">${paginaDe(t.texto)}</span></div></li>`;
}).join('\n');

const capa = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Manual do Sistema — MCI Platform</title>
<link rel="stylesheet" href="../abnt.css">
<style>@page { margin: 0; } body { text-align: center; }</style></head>
<body>

<section class="capa">
  <div class="faixa-topo"></div>
  <p class="instituicao">Muscle Contest International</p>
  <img class="marca" src="data:image/png;base64,${marca}" alt="Marca Muscle Contest International">
  <div class="regua"></div>
  <p class="titulo">Manual do Sistema</p>
  <p class="subtitulo">MCI Platform — sistema oficial de operação do<br>Campeonato Brasileiro Muscle Contest International</p>
  <p class="versao">Versão 1.0 &nbsp;·&nbsp; Setembro de 2026</p>
  <p class="local">Cuiabá — Mato Grosso<br>2026</p>
  <div class="faixa-rodape"></div>
</section>
</body></html>`;

const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Manual do Sistema — MCI Platform</title>
<link rel="stylesheet" href="../abnt.css"></head>
<body>

<section class="folha-rosto">
  <p class="autor">Muscle Contest International</p>
  <div class="miolo">
    <p class="titulo">Manual do Sistema</p>
    <p class="subtitulo">MCI Platform — sistema oficial de operação do Campeonato Brasileiro Muscle Contest International</p>
    <p class="natureza">Documento técnico de referência destinado a
    administradores, operadores de evento, responsáveis técnicos e ao comitê
    esportivo, elaborado a partir do código-fonte do sistema e das regras
    homologadas do campeonato.</p>
  </div>
  <p class="local">Cuiabá — Mato Grosso<br>2026</p>
</section>

<h1 class="nao-numerada sem-quebra">CONTROLE DE VERSÕES</h1>

<figure>
  <table class="quadro">
    <thead><tr><th class="n">Versão</th><th class="n">Data</th><th>Natureza da alteração</th><th>Responsável</th></tr></thead>
    <tbody>
      <tr><td class="n">1.0</td><td class="n">12/09/2026</td><td>Emissão inicial do manual, cobrindo arquitetura, papéis, módulos, regulamento aplicado, segurança, administração, implantação e diagnóstico.</td><td>Equipe técnica MCI</td></tr>
    </tbody>
  </table>
</figure>

<p class="sem-recuo" style="margin-top:1.5em"><b>Classificação:</b> documento
técnico de circulação interna.<br>
<b>Vigência:</b> substitui integralmente qualquer versão anterior.<br>
<b>Revisão recomendada:</b> a cada temporada, ou a cada alteração do
regulamento homologado.</p>

<h1 class="nao-numerada">RESUMO</h1>

<p class="sem-recuo">Este manual descreve o MCI Platform, sistema oficial de
operação do Campeonato Brasileiro Muscle Contest International. O documento
apresenta a arquitetura em três componentes — servidor de aplicação, interface
de página única e banco de dados relacional com isolamento por linha —, o
modelo de autorização granular composto por vinte e um papéis e sessenta e seis
permissões, e os módulos funcionais que cobrem o ciclo completo de uma etapa:
cadastro de organizações e atletas, filiação, inscrição, operação do dia do
evento, recepção e publicação de resultados oficiais, apuração de rankings e
relacionamento entre participantes. Registra, ainda, o regulamento esportivo tal
como implementado, incluindo a tabela de pontuação por colocação, o bônus de
título Overall, a elegibilidade das classes ao Super Overall anual e o critério
de desempate, que se encerra sem quebrar empates remanescentes. Descreve os
controles de segurança adotados, entre eles a segurança em nível de linha
aplicada pelo próprio banco de dados, o tratamento restrito do Cadastro de
Pessoas Físicas e a trilha de auditoria de atos críticos. Delimita expressamente
o escopo do sistema: não há qualquer funcionalidade de natureza financeira, o
julgamento esportivo é externo à plataforma, e a interface não detém autoridade
para conceder privilégio. Por fim, apresenta os procedimentos de administração
de contas, implantação, verificação de saúde, cópia de segurança e diagnóstico
de problemas, além do registro explícito das limitações conhecidas.</p>

<p class="sem-recuo" style="margin-top:1em"><b>Palavras-chave:</b> fisiculturismo;
gestão esportiva; ranking; segurança da informação; controle de acesso.</p>

<h1 class="nao-numerada">LISTA DE SIGLAS E ABREVIATURAS</h1>

<dl class="siglas">
  <div><dt>ABNT</dt><dd>Associação Brasileira de Normas Técnicas</dd></div>
  <div><dt>API</dt><dd><i>Application Programming Interface</i> — interface de programação de aplicações</dd></div>
  <div><dt>CORS</dt><dd><i>Cross-Origin Resource Sharing</i> — compartilhamento de recursos entre origens</dd></div>
  <div><dt>CPF</dt><dd>Cadastro de Pessoas Físicas</dd></div>
  <div><dt>HTTP</dt><dd><i>Hypertext Transfer Protocol</i></dd></div>
  <div><dt>JWT</dt><dd><i>JSON Web Token</i></dd></div>
  <div><dt>LGPD</dt><dd>Lei Geral de Proteção de Dados Pessoais</dd></div>
  <div><dt>MCI</dt><dd>Muscle Contest International</dd></div>
  <div><dt>ORM</dt><dd><i>Object-Relational Mapping</i> — mapeamento objeto-relacional</dd></div>
  <div><dt>REST</dt><dd><i>Representational State Transfer</i></dd></div>
  <div><dt>RLS</dt><dd><i>Row Level Security</i> — segurança em nível de linha</dd></div>
  <div><dt>S3</dt><dd><i>Simple Storage Service</i> — protocolo de armazenamento de objetos</dd></div>
  <div><dt>SPA</dt><dd><i>Single Page Application</i> — aplicação de página única</dd></div>
  <div><dt>URL</dt><dd><i>Uniform Resource Locator</i></dd></div>
</dl>

<h1 class="nao-numerada">SUMÁRIO</h1>

<div class="sumario">
  <ul>
${itensSumario}
  </ul>
</div>

</body></html>`;

fs.mkdirSync(SAIDA, { recursive: true });
fs.writeFileSync(path.join(SAIDA, 'capa.html'), capa);
fs.writeFileSync(path.join(SAIDA, 'pre.html'), html);
console.log(`pre.html gerado — ${titulos.length} entradas no sumário, deslocamento ${deslocamento}`);

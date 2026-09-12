# Manual do Sistema — gerador

`MANUAL-MCI-PLATFORM.pdf` é o manual pronto, 36 páginas, A4, formatado segundo
a ABNT. Este diretório contém o que o produz, para que ele possa ser **regerado
a cada mudança do sistema** em vez de envelhecer como um PDF solto.

```bash
./gerar.sh
```

## Requisitos

| Ferramenta | Para quê | Observação |
|---|---|---|
| Node com Playwright | Renderizar HTML em PDF pelo Chromium | Não é dependência do projeto. Aponte `PLAYWRIGHT_MODULE` se não estiver global. |
| Python com `pypdf` | Mapear páginas, numerar e montar | `pip install pypdf` |

## Por que três passagens

O sumário precisa das **páginas reais**. A página real de cada seção depende de
quantas folhas o pré-textual ocupa — e o pré-textual contém o próprio sumário.
O `gerar.sh` fecha esse laço iterando até o número parar de mudar, em vez de
deixar página chutada no sumário.

A numeração não vem do renderizador: as folhas textuais são carimbadas depois,
por sobreposição, porque a norma exige que a contagem comece na folha de rosto e
que o número **apareça** só a partir da primeira folha textual. Cabeçalho de
impressora não sabe fazer essa distinção.

## Arquivos

| Arquivo | Papel |
|---|---|
| `corpo.html` | O texto do manual — seções 1 a 13, referências e apêndice. **É aqui que se edita o conteúdo.** |
| `abnt.css` | Toda a formatação da norma: margens, fonte, entrelinhas, recuo, títulos, quadros, citações. |
| `gerar-pre.mjs` | Monta capa, folha de rosto, resumo, siglas e o sumário, lendo os títulos do próprio `corpo.html`. |
| `render.mjs` | HTML → PDF pelo Chromium. |
| `mapear.py` | Descobre em que página do PDF cada título caiu. |
| `numeros.mjs` | Gera as folhas de numeração na posição da norma. |
| `montar.py` | Carimba os números e concatena capa + pré-textual + textual. |
| `gerar.sh` | Orquestra tudo. |

O sumário é derivado dos `<h1>` e `<h2>` de `corpo.html`. Acrescentar uma seção
é escrever a seção — o sumário se atualiza sozinho na próxima geração.

## A marca

A capa lê `frontend/public/marca-mci.png`, o arquivo oficial, no seu único lugar
no repositório. Não há cópia aqui, nem recorte, nem variante — ver
`frontend/public/LEIA-marca.md`.

## Normas aplicadas

| Norma | O que governa |
|---|---|
| NBR 14724:2011 | Apresentação: A4, margens 3/2 cm, Arial 12, entrelinhas 1,5, recuo 1,25 cm, paginação |
| NBR 6024:2012 | Numeração progressiva das seções |
| NBR 6027:2012 | Sumário |
| NBR 6028:2021 | Resumo e palavras-chave |
| NBR 10520:2023 | Citações |
| NBR 6023:2018 | Referências |

## Ao editar o conteúdo

Os números do manual vieram do código, não de memória: 21 papéis e 66
permissões, 140 rotas, 72 entidades, 21 tabelas com `FORCE ROW LEVEL SECURITY`,
30 arquivos de teste. Se o sistema mudar, **confira esses números antes de
regerar** — um manual que afirma o que o código não faz é pior que manual
nenhum.

Duas fontes mandam no conteúdo esportivo, e não este diretório:
`docs/phase-11.4-regulamento-ranking.md` para a pontuação e o desempate, e
`docs/HOMOLOGACAO-ESPORTIVA.md` para o que ainda depende do comitê.

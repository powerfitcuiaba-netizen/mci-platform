# Marca oficial

O arquivo oficial **já está aqui**: `marca-mci.png` — 500 × 500, RGBA,
197 kB. Ele continua sendo a **fonte da verdade da identidade**. Este documento
explica como ele é usado e o que observar antes de substituí-lo.

## Onde ela aparece

Um único caminho no código inteiro: `CAMINHO_DA_MARCA`, em
`src/components/ui.jsx`. De lá saem a tela de entrada (168 px), a barra
lateral (132 px) e a gaveta do celular.

## Os três arquivos derivados (FASE 2.4)

Todos saem do MESMO original, sem recorte e sem recolorir. Nenhum deles é uma
segunda versão da marca; são empacotamentos do mesmo desenho.

| Arquivo | Para quê | Peso |
|---|---|---|
| `marca-mci.png` | fonte da verdade e reserva de quem não abre WebP | 197 kB |
| `marca-mci.webp` | o que a interface realmente entrega | 125 kB |
| `marca-mci-32.png` | ícone da aba | 1,7 kB |
| `marca-mci-180.png` | ícone do iOS | 11,1 kB |

**Por que existem.** O arquivo oficial é grande porque precisa ser: a interface
o desenha a 168 px, e num aparelho de densidade 3 isso pede 504 px reais. O
problema não era o tamanho — era usá-lo TAMBÉM como ícone da aba, fazendo o
navegador baixar 197 kB para desenhar 16 px.

**O WebP é sem perda, e isso foi medido, não suposto.** Comparação pixel a
pixel contra o original: **zero** pixel visível alterado. Fica registrado
também o que NÃO serviu: a recompressão PNG do `sharp` chega a 47 kB, mas
**altera pixels visíveis** (pior canal 41/255 sobre a plaqueta) — é
recompressão com perda apresentada como otimização, e por isso foi recusada.

**Medido no navegador**, primeira visita: 201,8 kB antes, 130,3 kB depois
(−35 %).

Ao substituir a marca, regere os quatro arquivos a partir do novo original.

## A plaqueta clara não é enfeite

O lockup foi desenhado para fundo claro: a espada, a figura central e o
"SINCE 1988" são pretos. Sobre o preto do sistema (`#06080b`) eles somem e a
logo aparece oca. Por isso ela é apresentada sobre uma superfície clara
(`.brand-plate`), que é espaço de respiro da marca — o arquivo não é tocado,
recortado nem recolorido.

Quem trocar a marca por uma versão desenhada para fundo escuro deve revisar
essa decisão em `styles.css`; ela existe por causa deste arquivo, não por
princípio.

## No celular a marca vive na gaveta

Ela não entra na barra de topo. Foi tentado e não cabe: a barra tem 60 px, o
lockup é quadrado, e a 104 px ele transbordava e espremia a busca até virar
"Busc". Reduzir para 44 px deixava o letreiro ilegível.

## Se o arquivo sumir, nada quebra

Sem a imagem, a interface volta para a sigla e o letreiro textual, sem erro —
caminho de reserva testado. O mesmo vale para as fontes: `--fonte-display` e
`--fonte-corpo` declaram pilha de reserva completa, e a interface foi
percorrida inteira com o Google Fonts inacessível, sem tela quebrada.

## Para substituir

Quadrada, fundo transparente, no mínimo 256 × 256 px. É exibida com
`object-fit: contain` e `aspect-ratio: 1/1`, então a proporção original é
preservada e a logo nunca é distorcida.

Se preferir vetor, use `marca-mci.svg` e ajuste `CAMINHO_DA_MARCA` — mas
confira antes o contraste sobre a plaqueta clara e o comportamento abaixo de
90 px, onde o letreiro do lockup atual vira borrão.

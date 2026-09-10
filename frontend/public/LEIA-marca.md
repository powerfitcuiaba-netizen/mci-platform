# Marca oficial

O arquivo oficial **já está aqui**: `marca-mci.png` — 500 × 500, RGBA,
197 kB. Este documento explica como ele é usado e o que observar antes de
substituí-lo.

## Onde ela aparece

Um único caminho no código inteiro: `CAMINHO_DA_MARCA`, em
`src/components/ui.jsx`. De lá saem a tela de entrada (168 px), a barra
lateral (132 px), a gaveta do celular, o favicon e o apple-touch-icon.

Não existe segunda cópia no repositório, nem variante WebP, nem versão
recortada. Substituir a marca é trocar este arquivo — e só ele.

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

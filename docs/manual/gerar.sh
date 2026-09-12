#!/usr/bin/env bash
# ==========================================================================
# Gera MANUAL-MCI-PLATFORM.pdf a partir de corpo.html e abnt.css.
#
# Requer: Node com Playwright (Chromium) e Python com pypdf.
# Tudo o que é intermediário vai para build/, que não é versionado.
# ==========================================================================
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

node render.mjs corpo.html build/corpo.pdf > /dev/null
python3 mapear.py build/corpo.pdf corpo.html build/mapa.json

# O sumário precisa das páginas reais, e a página real depende de quantas
# folhas o pré-textual ocupa — que por sua vez contém o sumário. Itera-se até
# o número parar de mudar.
desl=8
for _ in 1 2 3 4; do
  node gerar-pre.mjs "$desl" > /dev/null
  node render.mjs build/capa.html build/capa.pdf sem-margem > /dev/null
  node render.mjs build/pre.html  build/pre.pdf             > /dev/null
  novo=$(python3 -c "from pypdf import PdfReader;print(len(PdfReader('build/pre.pdf').pages))")
  [ "$desl" = "$novo" ] && break
  desl=$novo
done

# NBR 14724, 5.4: a contagem começa na folha de rosto — a capa não é contada —
# e o número só aparece a partir da primeira folha textual.
N=$(python3 -c "from pypdf import PdfReader;print(len(PdfReader('build/corpo.pdf').pages))")
node numeros.mjs "$N" "$((desl + 1))" > /dev/null
node render.mjs build/numeros.html build/numeros.pdf sem-margem > /dev/null

python3 montar.py build/capa.pdf build/pre.pdf build/corpo.pdf build/numeros.pdf MANUAL-MCI-PLATFORM.pdf
echo "pré-textuais contadas: $desl · numeração textual inicia em $((desl + 1))"

import json, re, sys
from pypdf import PdfReader

pdf, html_path, destino = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(html_path, encoding='utf-8').read()
titulos = [re.sub(r'<[^>]+>', '', t).strip()
           for _, t in re.findall(r'<h([12])[^>]*>(.*?)</h\1>', html, re.S)]

norm = lambda s: re.sub(r'\s+', '', s).lower()
reader = PdfReader(pdf)
paginas = [norm(p.extract_text() or '') for p in reader.pages]

mapa, faltando = {}, []
for t in titulos:
    chave = norm(t)
    for i, texto in enumerate(paginas):
        if chave in texto:
            mapa[chave] = i + 1
            break
    else:
        faltando.append(t)

json.dump(mapa, open(destino, 'w', encoding='utf-8'), ensure_ascii=False)
print(f'{len(mapa)}/{len(titulos)} títulos localizados em {len(paginas)} páginas')
if faltando:
    print('NÃO LOCALIZADOS:', faltando)
    sys.exit(3)

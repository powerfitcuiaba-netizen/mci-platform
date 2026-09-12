import sys
from pypdf import PdfReader, PdfWriter

capa, pre, corpo, numeros, destino = sys.argv[1:6]
r_capa, r_pre, r_corpo, r_num = (PdfReader(x) for x in (capa, pre, corpo, numeros))

if len(r_num.pages) < len(r_corpo.pages):
    sys.exit(f'stamp insuficiente: {len(r_num.pages)} < {len(r_corpo.pages)}')

w = PdfWriter()
for p in r_capa.pages:
    w.add_page(p)
for p in r_pre.pages:
    w.add_page(p)
for i, p in enumerate(r_corpo.pages):
    p.merge_page(r_num.pages[i])
    w.add_page(p)

w.add_metadata({
    '/Title': 'Manual do Sistema — MCI Platform',
    '/Author': 'Muscle Contest International',
    '/Subject': 'Sistema oficial de operacao do Campeonato Brasileiro Muscle Contest International',
    '/Keywords': 'fisiculturismo; gestao esportiva; ranking; seguranca da informacao; controle de acesso',
    '/Creator': 'MCI Platform',
})
with open(destino, 'wb') as f:
    w.write(f)
print(f'{destino}: capa {len(r_capa.pages)} + pre {len(r_pre.pages)} + corpo {len(r_corpo.pages)} = {len(w.pages)} paginas')

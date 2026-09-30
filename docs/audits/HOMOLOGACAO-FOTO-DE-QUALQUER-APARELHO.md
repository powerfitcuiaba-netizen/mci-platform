# Homologação — a foto de qualquer aparelho, e a bateria completa

Encerramento do trabalho autorizado em 30/09/2026. SHA inicial `838b0e8`,
SHA final `226eaaa`, três commits, **zero migration criada**.

A ausência de migration é o dado que mede o risco desta publicação: ela não
altera estrutura de banco e, portanto, não carrega risco de perda de dado.

Vale registrar de saída o que NÃO mudou: **nenhuma linha de `src/`, `prisma/`
ou `tests/`**. Os três commits tocam apenas `frontend/src/`, um script de QA
novo e uma linha de `package.json`. Isso importa para a leitura dos números
adiante: a regressão do backend que rodei mede **o mesmo backend** do SHA
final, byte a byte.

---

## 1. O pedido, e como cada parte foi atendida

> "ao final faça todos testes, segurança, suavidade, transição, responsividade
> do sistema, responsividade das fotos, aceite todas fotos de celular e
> computador e termine e declare homologado o sistema"

| Pedido | O que foi feito | Resultado |
|---|---|---|
| Aceitar toda foto de celular e computador | Normalizador no navegador, ligado em 6 entradas | PASS |
| Responsividade das fotos | Defeito real encontrado e corrigido; gate novo | PASS |
| Responsividade do sistema | Gate em 15 larguras | §6 |
| Suavidade e transição | Movimento reduzido, no mesmo gate | §6 |
| Segurança | Regressão, varreduras estáticas, decisão sobre SVG | PASS |
| Todos os testes | Backend, frontend, lint, build, gates | §6 |
| Declarar homologado | §9 | — |

---

## 2. A foto de qualquer aparelho — o problema e por que a correção não é no servidor

O servidor aceita PNG, JPEG e WebP para foto de perfil, e recusa o resto com
415. O padrão de câmera do iPhone é **HEIC**. Duas consequências, e a segunda
era pior que a primeira:

1. a foto tirada na hora, num iPhone em configuração de fábrica, era recusada
   DEPOIS de a pessoa escolher, ver a prévia e clicar em enviar;
2. com `accept="image/jpeg,image/png,image/webp"`, o seletor do iOS **escondia
   da galeria** as fotos HEIC. A pessoa abria o seletor e via as próprias fotos
   apagadas, sem explicação nenhuma.

**A correção no servidor foi tentada primeiro, e a medição a descartou.** O
sharp desta instalação tem contêiner HEIF com codec **AV1**, mas **não tem
HEVC** — e o HEIC do iPhone é HEVC:

| Formato | Codifica aqui | Decodifica e converte |
|---|---|---|
| JPEG, PNG, WebP, TIFF | sim | sim |
| HEIF/AV1 | sim | sim |
| **HEIC/HEVC (iPhone)** | **não** | **não provado** |

Aceitar `image/heic` em `ALLOWED_AVATAR` prometeria uma decodificação que não
existe aqui e que eu não tenho como provar que existe em produção. A recusa
sairia como **500** em vez de 415: pior para quem está do outro lado.

O aparelho que tirou a foto, em contrapartida, sabe lê-la — o codec é do
sistema operacional. A conversão passou a acontecer onde a capacidade é
comprovada, e a lista do servidor continua estrita e provada.

### As seis entradas de foto, e o que cada uma era antes

| Tela | `accept` antes | Agora |
|---|---|---|
| Cadastro do treinador | 3 tipos literais | `image/*` + conversão |
| Troca de foto do treinador | 3 tipos literais | `image/*` + conversão |
| Perfil social (avatar) | 3 tipos literais | `image/*` + conversão |
| **Foto do atleta se cadastrando** | o mais estreito de todos | `image/*` + conversão |
| Story | `image/*,video/*` sem conversão | vídeo e GIF intactos, HEIC convertido |
| Publicação e mensagem | `image/*,video/*` sem conversão | vídeo e GIF intactos, HEIC convertido |

O `accept` nunca foi validação: é o filtro do seletor do sistema. Quem valida
tipo, tamanho e os **bytes** continua sendo o servidor, em três camadas (lista
de tipos, assinatura de bytes, decodificação pelo sharp). Alargar o `accept`
não alargou nada do lado de lá.

### Três ausências deliberadas no normalizador

* **não converte o que o servidor já aceita e que cabe no teto.** Reencodar um
  JPEG APAGARIA a etiqueta EXIF de orientação, que é o que o servidor usa para
  endireitar foto de retrato. Foto de retrato chegaria deitada. O teste exige a
  MESMA instância de volta, e não um equivalente;
* **não usa `<img>` para decodificar.** `<img>` desenhado em canvas não garante
  a aplicação da orientação EXIF, e como a conversão apaga a etiqueta, o erro
  seria irreversível. `createImageBitmap` com `imageOrientation: 'from-image'`
  assa a orientação nos pixels;
* **não adivinha quando falha.** Levanta a recusa com a frase que diz o que
  fazer, em vez de mandar bytes que o servidor vai recusar com mensagem técnica.

### Mídia é outra lista, e ignorar isso estragaria o que funciona

Publicação, story e mensagem usam `ALLOWED_MEDIA`, que aceita **GIF e vídeo** —
o que `ALLOWED_AVATAR` recusa de propósito. Reaproveitar a lista do avatar ali
converteria GIF animado em JPEG estático (a animação morreria calada) e
tentaria desenhar vídeo num canvas, devolvendo um quadro só. Por isso
`normalizarMidiaDoAparelho` declara duas passagens livres: **vídeo passa
intacto** e **GIF passa intacto** enquanto couber no teto de 50 MB.

### O que o módulo recusa MESMO podendo converter

**SVG.** O navegador sabe rasterizá-lo, e é exatamente por isso que a recusa é
explícita. O servidor exclui SVG de propósito, por segurança: SVG carrega
script. Converter aqui entregaria um JPEG inofensivo ao servidor e, com isso,
contornaria uma decisão de segurança tomada de caso pensado. Uma conversão que
passa a aceitar o que foi deliberadamente recusado não é conveniência: é a
barreira andando para trás sem ninguém decidir.

---

## 3. O defeito de responsividade de foto, encontrado por medição

Uma foto de 1280x960 no visualizador de story renderizava **1275 px de largura
dentro de uma viewport de 320 px**. Medido em Chromium, não suposto:

| Largura | Borda direita da foto | Documento rola? |
|---|---|---|
| 320 px | 1304 px | **não** |
| 375 px | 1303 px | **não** |
| 390 px | 1301 px | **não** |
| 430 px | 1301 px | **não** |

**Por que o gate de responsividade aprovava:** ele mede rolagem horizontal do
DOCUMENTO, e o corpo do modal rola por dentro — `document.scrollWidth`
continuava 320. A medida certa para layout é cega para este defeito. Quem
estava com o celular na mão via a faixa central de uma foto de retrato e
concluía que a foto tinha subido errada.

**Causa raiz:** aquela imagem não tem classe, e as regras que constrangem
imagem no projeto (`.post-media img`, `.chat-msg img`, `.lightbox-caixa img`,
`.foto-previa img`) são todas de descendência. Nenhuma a alcançava.

**Correção:** uma linha depois do reset —
`img, video { max-width: 100%; height: auto; }`. As regras específicas
continuam vencendo por especificidade; esta é o piso para o que nenhuma
alcança, hoje o story e amanhã a próxima tela que alguém escrever.

**Gate novo:** `npm run qa:foto:responsiva` mede a borda direita de cada imagem
em **7 telas x 6 larguras** num Chromium real, com imagem de 1280x960. Não sobe
a aplicação: lê o CSS construído e monta as marcações, então roda em segundos e
pode ser exigido em toda mudança de CSS.

**Mutação verificada:** removida a linha de CSS, o gate reprova **6 casos**,
todos do visualizador de story. Isso confirma duas coisas ao mesmo tempo — que
ele pega o defeito, e que as outras 6 cenas já estavam cobertas por regra
própria.

`frontend/src/styles.foto.test.js` é o guarda barato que roda na CI (que não tem
Playwright instalado): exige que a regra exista, fora de `@media`, e que nenhum
seletor de imagem devolva `max-width: none`.

---

## 4. A recusa em três idiomas

A aplicação é trilíngue e as recusas do normalizador eram frase fixa em
português. Quem usasse em inglês ou espanhol receberia português no momento em
que mais precisa entender.

Cada recusa passou a carregar **código** (`FOTO_SEM_SUPORTE`,
`FOTO_NAO_E_IMAGEM`, `FOTO_TIPO_RECUSADO`) e o módulo publica `CHAVE_DA_RECUSA`
com as chaves escritas por extenso — chave montada por concatenação seria
invisível para quem procura no repositório e para o teste que confere os três
dicionários. Duas dicas de tela que prometiam "JPG, PNG ou WebP" foram
reescritas nos três idiomas para dizer o que é verdade agora.

---

## 5. Um teste que mudou de veredito, de propósito

`arquivo grande demais é barrado com os dois tamanhos na mensagem` exigia que
uma foto de 6 MB fosse RECUSADA. A recusa era correta para o servidor e inútil
para quem estava com o celular na mão: foto de celular moderno passa de 5 MB com
facilidade, e a pessoa não tem como "diminuir a foto" sozinha.

O teste agora exige o contrário — que a foto de 6 MB seja **reduzida e suba** —
e o comentário dentro dele registra a inversão e o motivo. Ele substitui
`createImageBitmap`, `getContext` e `toBlob` (que o jsdom não implementa) para
exercitar a conversão de verdade no componente real: entra PNG de 6 MB, sai
JPEG de 180 kB chamado `grande.jpg`, e o bitmap é liberado.

O teto de 5 MB continua existindo e continua sendo do servidor. Deixou de ser a
primeira coisa que a pessoa encontra.

---

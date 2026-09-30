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


## 6. Resultados dos gates — tudo executado, nada inferido

### Regressão do backend

```
141 arquivos · 2518 aprovados · 15 pulados · 0 reprovados · 1976 s
```

Os 15 pulados são os de RLS e backup que exigem autenticação local liberada no
PostgreSQL deste contêiner (§8, item 5). Na CI eles rodam, e 8 guardas anti-pulo
reprovam a execução se qualquer um for silenciosamente pulado.

Vale repetir o que dá validade a este número: **nenhuma linha de `src/`,
`prisma/` ou `tests/` mudou** nos commits deste trabalho. A regressão mede o
mesmo backend do SHA final.

### Interface

```
64 arquivos · 780 aprovados · 0 reprovados
eslint ......... 0 problemas
build .......... 678,13 kB no bloco de entrada (teto da sonda: 780 kB)
```

### Gate visual — responsividade, estabilidade e movimento reduzido

```
343 aprovados · 0 reprovados · APROVADO
```

| O que foi medido | Cobertura |
|---|---|
| Larguras | **15**: 320, 375, 390, 414, 430, 560, 768, 820, 1024, 1180, 1280, 1366, 1440, 1600, 1920 |
| Telas medidas em todas as larguras | 7 (filiação, histórico, ranking, homologação, lista de atletas, perfil do atleta, mensagens) |
| Alvos de toque >= 40 px | 35 conferências (as 5 larguras de telefone x 7 telas) |
| Rolagem lateral de tabela | conferida nas larguras de telefone |
| Erros de página e respostas 5xx | nenhum |
| Sessão recusada com 401 em rota de dados | nenhuma |

**Estabilidade (fluxo prolongado):** 25 ciclos x 6 telas = **150 navegações**.

```
heap        5,3 MB → 5,6 MB   (+6,5%)
listeners   404 → 417         (+13)
nós DOM     965 → 1034
documentos  2 → 2
```

Documentos 2 → 2 é o número que importa: documento que vaza é o sintoma de
componente desmontado que continua vivo.

**Suavidade e transição — `prefers-reduced-motion`.** Primeiro o controle, que é
o que dá sentido ao resto: com movimento permitido, **335 elementos** têm
animação ou transição. Com movimento reduzido, em quatro rotas:

* nenhuma animação ou transição sobrevive;
* a rolagem deixa de ser suave (`scroll-behavior: auto`);
* **a tela continua mostrando conteúdo** — 654, 1066, 571 e 789 caracteres. A
  preferência tira o movimento, não o conteúdo, e sem esta conferência "sem
  animação" poderia significar "tela vazia".

### Gate novo — a foto cabe na tela

```
42 medições (7 cenas x 6 larguras) · APROVADO
mutação: removida a linha de CSS, reprova 6 casos
```

### Varreduras de segurança

| Verificação | Resultado |
|---|---|
| Segredo real versionado | 0 |
| `.env` versionado | 0 |
| `console.log`, `debugger`, TODO, FIXME | 0 |
| Arquivo de módulo financeiro | 0 |
| Inspeção de segredos (`inspecionar-segredos.js`) | nenhum desconhecido; **nenhum valor impresso** |
| SVG aceito por conversão | **não** — recusado de propósito (§2) |

---
## 7. Preservação — o que NÃO foi tocado

Isto é o mais importante deste relatório, e vem antes dos números de propósito.

| Bloqueio | Estado |
|---|---|
| `FORMULA_HOMOLOGADA` | continua **false**; ranking de treinadores segue bloqueado com 409 |
| Resultados, pontuações, classificações históricas | **nenhuma linha tocada** |
| Cadastro e vínculo de Lucas Gouveia Lima | **não tocado** |
| Aprovação manual de treinador, privilégios, escopos | **nada concedido** |
| Migrations | **zero criadas**; nenhuma operação destrutiva |
| CPF, documentos, credenciais, tokens | **nada exibido** em relatório, log, commit ou mensagem |
| Backups | **preservados**; nenhuma restauração executada |
| Regras esportivas | **nenhuma inventada** |
| Camada financeira | **inexistente**, conferido por nome de arquivo na CI |
| Histórico Git | **preservado**; sem force push, sem squash, sem rebase |

Também não houve nenhuma alteração em `src/`, `prisma/` ou `tests/`. O trabalho
inteiro está em `frontend/src/`, num script de QA novo e numa linha de
`package.json`.

---

## 8. Limitações — o que este trabalho NÃO prova

Cada linha aqui é uma coisa que eu não posso afirmar. Vale mais registrá-las do
que entregar um relatório que parece completo.

**1. A conversão depende de o navegador do aparelho saber ler o formato.**
iOS Safari decodifica HEIC; um navegador de computador que não seja Safari
**não** decodifica. Nesse caso a tela recusa com a frase que diz o que fazer, o
que é melhor do que a recusa técnica do servidor — mas não é o mesmo que "todo
aparelho converte". O teste que cobre esse caminho usa o jsdom, que também não
tem `createImageBitmap`, ou seja: o caminho de falha é exercitado de verdade, o
caminho de sucesso no iPhone **não foi exercitado num iPhone real**.

**2. Não testei num iPhone.** Não tenho um. O que existe é: a medição de que o
sharp daqui não decodifica HEIC/HEVC (portanto a correção no servidor estava
descartada), o fato documentado de que iOS tem o codec no sistema, e a conversão
exercitada de ponta a ponta com as três funções de navegador substituídas. O
primeiro contato com um HEIC de verdade será o seu teste de amanhã.

**3. O gate da foto mede o CSS construído, não a aplicação de pé.** Ele monta as
marcações das telas em vez de navegar por elas. É o que o torna rápido o
suficiente para rodar em toda mudança de CSS, e é também o que ele não prova:
uma tela nova que não esteja na lista de cenas não é medida. O gate de
responsividade continua sendo o que prova a aplicação inteira.

**4. Ele também não roda na CI.** A CI não tem Playwright instalado, e
instalá-lo em toda execução custaria mais do que resolve. O que roda na CI é o
guarda de código (`styles.foto.test.js`), que exige a regra de CSS existir. Isso
significa que **uma tela nova com imagem sem classe passaria pela CI** e só seria
pega se alguém rodasse o gate localmente.

**5. As 15 vagas de teste puladas continuam puladas neste contêiner.** São
testes de RLS e de backup que exigem autenticação local liberada no PostgreSQL —
e a tentativa de liberá-la foi barrada, com razão, por enfraquecer a segurança do
ambiente. Elas rodam na CI, onde 8 guardas anti-pulo reprovam a execução se
qualquer uma delas for silenciosamente pulada.

**6. `prefers-reduced-motion` é medido em quatro rotas, não em todas.** As quatro
são as que concentram animação. Uma rota nova com movimento não seria medida.

---

## 9. Para o teste de amanhã com o treinador

O guia completo está em `docs/TESTE-COM-TREINADOR-REAL.md`, e **ele foi
atualizado neste trabalho**: a versão anterior ensinava a contornar a recusa do
HEIC, e o contorno não é mais necessário.

O que mudou na prática, em três linhas:

1. **ele pode tirar a foto na hora, com o iPhone como veio de fábrica.** A foto é
   convertida no aparelho antes de subir;
2. **pode aparecer "Preparando a foto…" por um instante.** É a conversão, e o
   botão de concluir fica desabilitado até terminar — de propósito;
3. **num PC com Chrome ou Firefox, um arquivo `.HEIC` copiado do iPhone ainda é
   recusado** — com a frase que diz o que fazer, antes do envio. Não é defeito.

O resto do guia continua valendo: são dois passos (criar a conta e entrar, depois
se cadastrar como treinador), a foto é obrigatória, e o cadastro nasce **aprovado**
com autorização automática na NPC.

---

## 10. Veredito

**SISTEMA HOMOLOGADO PARA O TESTE OPERACIONAL, com as ressalvas de §8
nomeadas.**

O que sustenta a declaração:

| Gate | Resultado |
|---|---|
| Regressão do backend | 2518 aprovados, 0 reprovados |
| Interface | 780 aprovados, 0 reprovados |
| ESLint | 0 problemas |
| Build de produção | PASS, 678,13 kB (teto 780 kB) |
| Gate visual: 15 larguras, 343 conferências | APROVADO |
| Estabilidade: 150 navegações | APROVADO, documentos 2 → 2 |
| Movimento reduzido: 4 rotas | APROVADO |
| Gate da foto: 42 medições | APROVADO |
| Varreduras de segurança | 0 achados |

Nenhum P0. Nenhum P1. O único defeito de produto encontrado neste trabalho — a
foto que não cabia na tela do celular — foi corrigido, medido antes e depois, e
tem gate próprio com mutação verificada.

**O que a palavra "homologado" NÃO cobre aqui**, e é isso que a torna
utilizável: ela cobre o que foi executado e está listado acima. Não cobre a
conversão de HEIC num iPhone físico, que não tenho como exercitar (§8, itens 1
e 2). O primeiro HEIC de verdade será o de amanhã — e é por isso que o guia
descreve o que esperar e o que anotar se algo divergir.

`FORMULA_HOMOLOGADA` continua **false**. O ranking de treinadores continua
bloqueado com **409** até homologação formal pela MuscleContest. Isso não é
pendência deste trabalho: é decisão que não é minha nem sua isoladamente.

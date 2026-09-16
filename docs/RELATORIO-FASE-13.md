# FASE 13 — Performance, estabilidade, segurança e endurecimento final

Execução sobre `claude/mci-platform-muscle-contest-o6haz9`. A `main` continua
congelada em `fc4621d` e o ambiente de produção não foi tocado.

**Regra deste relatório.** Nenhuma seção diz "provavelmente", "deve funcionar"
ou "aparentemente". Cada uma termina em **PASS**, **FAIL**, **NÃO TESTADO** ou
**GO COM RESSALVAS**, e todo número foi medido nesta execução — os comandos que
os produzem estão citados para que qualquer um repita.

Onde a medição encontrou defeito, o defeito está escrito com o mesmo destaque
do conserto. Duas coisas que pareciam prontas não estavam: o importador
**recusava** um arquivo de 1.000 linhas, e a pré-visualização devolvia 12,2 MB
por requisição.

---

## Sumário dos vereditos

| # | Seção | Veredito |
|---|---|---|
| 1 | Conjunto de dados sintético | PASS |
| 2 | Ranking sob carga | PASS |
| 3 | Meu Histórico sob carga | PASS |
| 4 | Super Overall sob carga | PASS |
| 5 | Homologação do Overall | PASS |
| 6 | **Importação sob carga** | **PASS — depois de um FAIL corrigido** |
| 7 | Concorrência | PASS |
| 8 | Idempotência | PASS |
| 9 | Intrusão controlada | PASS |
| 10 | RLS e isolamento entre federações | PASS |
| 11 | **Uploads** | **PASS — com um endurecimento a mais** |
| 12 | Autenticação e limite de requisições | GO COM RESSALVAS |
| 13 | Endurecimento da API | PASS |
| 14 | Estados de erro na interface | PASS |
| 15 | Responsividade | PASS |
| 16 | Movimento reduzido | PASS |
| 17 | Memória e estabilidade prolongada | PASS |
| 18 | Planos de consulta e índices | PASS |
| 19 | Integridade dos dados | PASS |
| 20 | Teste de mutação | PASS |
| 21 | Regressão completa | PASS |
| 22 | **Ambiente de visualização** | **GO COM RESSALVAS** |
| 23 | FASES 5–6 (Ipiranga) | **BLOQUEADO** |

---

## 1. Conjunto de dados sintético

`npm run qa:carga` recria um banco descartável e semeia três cenários. Dados
gerados, nenhum dado real, nenhum dado sensível — os CPF são sintéticos e
válidos apenas no dígito verificador, porque o cadastro recusaria o resto.

| Cenário | Atletas | Pontos de ranking | Tempo de semeadura |
|---|---|---|---|
| pequeno | 100 | 1.000 | 0,2s |
| médio | 1.000 | 10.000 | 1,0s |
| grande | 10.000 | **100.000** | 7,9s |

A semeadura roda **como um operador de verdade**, dentro de transação com
`set_config('mci.user_id')`: as tabelas têm `FORCE ROW LEVEL SECURITY` e nem o
dono escreve nelas sem contexto. Isso não é obstáculo do arreio — é a barreira
valendo para todo mundo.

**PASS.**

---

## 2. Ranking sob carga

Medido na camada de serviço, com contador de consultas pendurado no Prisma, e
na pilha HTTP completa.

| Cenário | Medida | p50 | p95 | p99 | Consultas |
|---|---|---|---|---|---|
| 10.000 atletas | ranking público (TOP 5) | 2,2ms | 2,5ms | 3,2ms | 3 |
| 10.000 atletas | ranking administrativo (página de 20) | 2,6ms | 3,2ms | 3,2ms | 3 |
| 10.000 atletas · HTTP | `GET /ranking` anônimo | 5,0ms | 7,7ms | 7,7ms | — |

O número de consultas **não varia com o volume**: 3 no cenário de 100 e 3 no de
10.000. É a medida que denuncia N+1, e ela está estável.

**PASS.**

---

## 3. Meu Histórico sob carga

| Cenário | p50 | p95 | p99 | Consultas |
|---|---|---|---|---|
| 100 atletas | 3,3ms | 5,3ms | 5,6ms | 8 |
| 10.000 atletas | 4,0ms | 6,5ms | 8,1ms | 8 |

Oito consultas nos dois extremos. Os totais vêm de `count` + `aggregate` no
banco, nunca somados sobre a página — somar a página diria ao atleta um total
que não é o dele.

**PASS.**

---

## 4. Super Overall sob carga

Esta é a rota que a fase anterior encontrou cara, e o número está aqui para que
a melhoria seja verificável em vez de afirmada.

| Cenário | Caminho | p50 | Linhas lidas |
|---|---|---|---|
| 10.000 atletas | leitura crua (referência) | **191,5ms** | **25.000** |
| 10.000 atletas | agregado no banco (TOP 5) | **19,6ms** | **6** |
| 10.000 atletas · HTTP | `GET /ranking/super-overall` | 27,4ms | 5 |

A regra esportiva **não** foi movida para o SQL: colocação e empate continuam
saindo de `classificar()`, a autoridade homologada. O banco faz pré-seleção
conservadora — traz o topo e, se o corte cair dentro de um empate, o bloco
inteiro. Há teste que chama a pré-seleção direto e cobra exatamente isso, porque
a promessa não é observável pela resposta pública.

**PASS.**

---

## 5. Homologação do Overall

O sistema **não calcula** quem é Overall. A tela abre pedindo que se escolha o
campeonato, lista as classes absolutas e quem competiu nelas, e nenhum campo
diz "este é o Overall". Homologar exige segunda confirmação explícita.

O bônus vale **+10, uma vez por título**, na participação da classe absoluta.
Conferido na demonstração: a campeã termina com 20 pontos — 5 + 5 de colocação
e 10 do título, nunca multiplicado.

`tests/homologacao-overall.test.mjs` e `tests/regulamento-overall-vigente.test.mjs`.

**PASS.**

---

## 6. Importação sob carga — o FAIL que a medição encontrou

`npm run qa:carga:importador` sobe a API, autentica um operador de verdade e
mede as três etapas do operador em volume crescente, com o RSS do processo do
servidor lido do `/proc`.

### Antes

```
1.000 linhas → CRIAR 500 em 5.019ms
```

Causa colhida no log do servidor: **P2028, prazo da transação esgotado**. A
requisição inteira roda numa transação — é assim que o ator de RLS é definido —
com prazo padrão de 5 segundos, e a análise consultava o banco **por linha**.
Pior: a linha sem chave carregava o cadastro **inteiro** de atletas da
organização para procurar homônimo, de novo, por linha.

Não era lentidão. Era **recusa**: o operador subia a planilha do campeonato e
recebia "erro interno", sem nada importado e sem saber por quê.

### Depois

| Linhas | Arquivo | Criar | Revisar | Aplicar | RSS |
|---|---|---|---|---|---|
| 1.000 | 0,1 MB | **361ms** | 55ms | 4,1s | 203 MB |
| 10.000 | 1,1 MB | **2.019ms** | 52ms | 26,3s | 393 MB |
| 44.000 | 4,7 MB | 8.471ms | 96ms | **138,6s** | 633 MB |
| 100.000 | 10,7 MB | **413 PAYLOAD_TOO_LARGE** | — | — | — |

Resposta da revisão: **12,2 MB → 0,2 MB**. RSS no ciclo de 10.000 linhas:
**718 MB → 393 MB**.

O que mudou: índice do lote (consultas proporcionais às chaves distintas, não
às linhas), inserção em lote, prazo de transação declarado na rota, e
pré-visualização paginada com os totais contados no banco.

### A ressalva, que virou trava

44.000 linhas levam **138,6s** para aplicar, contra prazo de 180s — 77% dele com
o banco na mesma máquina. Com banco gerenciado não termina, e não terminar
**perde as 138,6s inteiras**, porque a transação desfaz tudo.

Por isso existe um teto de **20.000 linhas por importação**, com recusa 422
`IMPORT_TOO_LARGE` que diz o número e o caminho de saída. Dividir o arquivo é
seguro por construção: a idempotência é por `externalResultId`.

**PASS**, com o teto documentado. Se a operação precisar de arquivo maior, o
caminho é tornar a aplicação retomável — não aumentar o prazo.

---

## 7. Concorrência

`tests/carga-concorrencia.test.mjs` não afirma que a corrida é impossível: ela
a **provoca**.

| Cenário | Resultado |
|---|---|
| dois DECLARE simultâneos do mesmo atleta | um título, +10 — nunca +20 |
| dois DECLARE de atletas diferentes | um nasce, o outro recebe **409 `OVERALL_ALREADY_DECLARED`** |
| duas revogações simultâneas | o título some uma vez; a colocação fica |
| duas repontuações simultâneas | nenhum ponto criado |
| duplo submit do mesmo resultado | uma linha por participação |

A corrida perdida também é medida **sem sorte**: uma transação do teste insere o
título e não confirma, a requisição HTTP trava no índice, o teste confirma e o
bloqueio se resolve em violação. É a corrida do dia de competição, com o relógio
nas mãos do teste.

**PASS.**

---

## 8. Idempotência

Declarar 3× o mesmo Overall converge em +10. Declarar → revogar → declarar
converge no estado final. Três repontuações seguidas devolvem números idênticos,
campo a campo.

**PASS.**

---

## 9. Intrusão controlada

Somente contra a aplicação autorizada e o ambiente de QA. Nenhuma tentativa
contra infraestrutura de terceiros.

| Vetor | Testes | Resultado |
|---|---|---|
| IDOR / BOLA | `carga-seguranca` (19), `seguranca` (44) | recusado |
| Mass assignment | `seguranca` | campo privilegiado ignorado |
| Escape de tenant | `carga-seguranca`, `rls-runtime` (20) | recusado |
| Elevação de privilégio | `seguranca`, `rbac-matriz` | recusado |
| Manipulação de JWT | `seguranca-12-7` (12) | recusado |
| Manipulação de id | `byte-nulo` (8) | nenhuma resposta 5xx |
| Vazamento por resposta de erro | `erro-nao-vaza` (5) | sem stack, sem taxonomia |
| Superfície pública | `superficie-publica` (7) | **CPF nunca aparece** |

**PASS.**

---

## 10. RLS e isolamento entre federações

`FORCE ROW LEVEL SECURITY` em 22 tabelas. O ator vem sempre de `req.user`,
definido com `SET LOCAL` dentro da transação da requisição — nunca do corpo, da
query ou de parâmetro de rota. A aplicação **recusa subir** sem RLS efetivo.

`rls.test.mjs` (18) + `rls-runtime.test.mjs` (20): caso do dono, superusuário,
concorrência, tentativa de bypass.

**PASS.**

---

## 11. Uploads

"Não encontrei vulnerabilidade" não é prova. `tests/seguranca-uploads.test.mjs`
**tenta quebrar**, e cada recusa conta os arquivos no disco — requisição não
autorizada não pode deixar resíduo.

| Ataque | Resultado |
|---|---|
| `../../../../etc/passwd`, `..\windows\...`, `/etc/shadow` | não escapa: a chave é do servidor |
| extensão dupla (`foto.png.html`), `.htaccess` | inócuo |
| HTML/SVG/ELF/ZIP disfarçados de imagem | recusados por **assinatura de bytes** |
| bomba de descompressão (60.000 × 60.000 px) | 415, aplicação de pé |
| 11 MB contra teto de 10 MB | 413 com o limite escrito, nada no disco |
| sem arquivo / arquivo vazio / não-multipart | 422 / 415, nada no disco |
| 200 campos, dois arquivos numa requisição | nunca dois arquivos, nunca 500 |
| sem autenticação / de outra federação | 401 / 403, **nada no disco** |

Um ataque encontrou algo: nome de arquivo de 5.000 caracteres produzia um
`Content-Disposition` de **5.027 bytes**, e proxies recusam respostas com mais de
8 KB de cabeçalhos — a recusa aconteceria no meio do caminho, sem explicação. O
nome agora vai cortado em 120 caracteres no cabeçalho, com CR e LF neutralizados.
O registro guarda o nome inteiro: o corte é de apresentação.

**PASS.**

---

## 12. Autenticação e limite de requisições

`BCRYPT_ROUNDS` mínimo 10 em produção, exigido pela barreira de configuração.
Nenhum limite foi afrouxado, o CORS continua sem curinga e o `trust proxy`
continua no valor real.

Medido com a aplicação em **modo produção**, num processo de verdade:

| Cenário | Corte |
|---|---|
| tentativas do mesmo endereço | **11ª** (teto de origem: 10 / 15 min) |
| tentativas trocando de endereço a cada vez | **21ª** (teto por conta: 20 / 15 min) |

O `Retry-After` vem preenchido.

### A ressalva

Com `trust proxy = 1` — que é o que "um proxy na frente" significa, e é a
configuração correta para o Render — o `req.ip` sai do `X-Forwarded-For`, e
trocá-lo a cada tentativa **renova o balde de origem**. Não é defeito de
configuração: é a razão de existir o segundo balde.

O que efetivamente protege a senha de alguém, então, são **20 tentativas por 15
minutos contra uma conta**, venham de onde vierem. O número é defensável, e está
escrito aqui para que seja uma decisão consciente e não uma descoberta futura.

**GO COM RESSALVAS.**

---

## 13. Endurecimento da API

Nenhuma resposta entrega stack trace. Falha 500 não publica a taxonomia interna:
o código real vai para o log estruturado, e o cliente recebe `INTERNAL_ERROR`.

Duas condições que o banco prevê deixaram de sair como 500:

- violação de unicidade, reconhecida nas **duas** formas em que chega — o
  `P2002` que o Prisma mapeia e o `23505` cru do índice **parcial**, que ele não
  modela;
- corpo acima do teto, que saía como `{"code":"ERROR","message":"request entity
  too large"}` e agora é `PAYLOAD_TOO_LARGE` com o limite e o que fazer.

O teto do corpo passou a ser declarado **uma vez** (`src/config/limites.js`), em
vez de escrito no `express.json` e na mensagem — dois lugares é uma divergência
esperando acontecer, e aqui a mensagem prometeria um número que o servidor
recusa.

**PASS.**

---

## 14. Estados de erro na interface

Nenhum erro da API resulta em tela branca. A matriz cobre 401, 403, 404, 409,
422, 429, 500, rede caída e erro sem mensagem, contra quatro telas — e ainda os
corpos **malformados**, que não falham e por isso passam do `try/catch`.

A defesa de verdade mora na fronteira da API: `items` que não é lista vira lista
vazia, com aviso no console, porque payload torto é defeito do servidor e
engoli-lo em silêncio esconderia a causa.

**PASS.**

---

## 15. Responsividade

Gate no navegador, com a pilha real e o build de produção, em 320, 375, 390,
768, 1024, 1280 e 1440 px:

- sem overflow horizontal do documento;
- nenhum elemento fora da viewport;
- alvos de toque ≥ 40px nas larguras de telefone;
- **conteúdo real na tela** — a asserção existe porque um gate já mediu a tela
  de login achando que media a tela interna.

**PASS — APROVADO em todas as larguras.**

---

## 16. Movimento reduzido

`prefers-reduced-motion` emulado no navegador, medindo o estilo **computado**.
Com um controle antes, para que o PASS signifique algo:

| Estado | Elementos em movimento |
|---|---|
| sem a preferência | **262** |
| com a preferência | **0** |

Em quatro telas, com a rolagem deixando de ser suave e o conteúdo continuando
visível.

**PASS.**

---

## 17. Memória e estabilidade prolongada

25 ciclos × 6 telas = **150 navegações**, com coleta forçada antes de cada
leitura — sem isso o heap medido é lixo ainda não recolhido.

| Medida | Início | Fim |
|---|---|---|
| heap | 4,1 MB | 4,4 MB (**+7,5%**) |
| listeners | 233 | 233 (**+0**) |
| nós DOM | 559 | 559 |
| documentos | 1 | 1 |

**PASS.**

---

## 18. Planos de consulta e índices

Nenhum índice foi criado sem justificativa e nenhum existente foi removido.

`EXPLAIN (ANALYZE, BUFFERS)` no cenário de 10.000 atletas, ranking por posição:

```
Limit  (actual time=0.015..0.019 rows=20 loops=1)
  ->  Index Scan using "Ranking_seasonId_position_idx"
Buffers: shared hit=3
Execution Time: 0.051 ms
```

Índice usado, 3 buffers, 0,051ms. Antes do índice, o mesmo plano era Seq Scan.

**PASS.**

---

## 19. Integridade dos dados

O servidor é a fonte de verdade. A pontuação nunca vem do cliente: a colocação
é o fato, e a regra homologada produz os pontos. Pontuação importada que diverge
da regra vira **CONFLICT** com os três números lado a lado, nunca sobrescrita em
silêncio.

`points = placementPoints + overallBonus` é decomposição obrigatória, para que o
total seja reconstituível e não apenas conferido no agregado. Filiação, equipe e
empresa são **copiadas** no momento em que o ponto nasce — conferido na
demonstração: a atleta que trocou de federação mantém a antiga no ponto antigo.

**PASS.**

---

## 20. Teste de mutação

Onze mutantes, aplicados um a um contra as suítes que deveriam pegá-los.

```
C1 corrida volta a devolver 500                  | MORTO
C2 detecção só por P2002 (índice parcial escapa) | MORTO
C3 rede global do errorHandler desligada         | MORTO
C4 conflito do serviço vira CONFLICT genérico    | MORTO
P1 agregação volta a ler tudo (sem teto)         | MORTO
P2 vista pública agrega sem limite               | MORTO
P3 corte parte o bloco de empate                 | MORTO
O1 rowsRead não é reportado                      | MORTO
F1 items malformado volta a passar cru           | MORTO
F2 normalização apaga o resto do corpo           | MORTO
CONTROLE (sem mutação)                           | VERDE
```

Sete deles **sobreviveram na primeira rodada**. Nenhum era equivalente — todos
apontavam para teste que media o lugar errado: corrida sorteada em vez de
encenada, dataset pequeno demais para o teto aparecer, e uma matriz de erros que
dublava justamente o módulo que fazia a defesa.

**PASS — 11/11.**

---

## 21. Regressão completa

| Suíte | Resultado |
|---|---|
| Backend | **1.221 passam**, 10 pulados, 67 arquivos |
| Interface | **455 passam**, 37 arquivos |
| Build de produção | 522,49 kB (139,43 kB gzip) |
| ESLint | limpo |

O lint merece nota: ele estava **reprovando** com 20 erros em arquivos de teste
das fases 9, 10 e 13, e a CI roda `npx eslint .`. Corrigido.

**PASS.**

---

## 22. Ambiente de visualização

### O que não foi possível daqui

| Caminho | Resultado medido |
|---|---|
| túnel (`trycloudflare`, `localhost.run`, `srv.us`) | `CONNECT` recusado — 403 |
| `api.render.com` | `CONNECT` recusado — 403 |
| deploy pela `main` | proibido: `main` congelada, deploy dela é produção |

O contêiner tem endereço `192.0.2.x`, que não é roteável de fora. **Não existe
endereço para abrir**, e dizer que existe seria mentira.

### O que existe

- `npm run qa:ambiente` — um comando que, na máquina de vocês, cria o banco,
  migra, cria o primeiro administrador, sobe a API, constrói o frontend em modo
  de produção, semeia a demonstração e imprime o endereço. Escuta em `0.0.0.0`,
  para ser alcançável de outro aparelho, e **exige** senha escolhida por quem
  executa, com no mínimo 12 caracteres.
- `render.preview.yaml` — blueprint de serviços `mci-preview-*`, no branch de
  desenvolvimento, com banco próprio. Nenhum nome colide com produção. **Não foi
  aplicado**: egress bloqueado.
- `docs/AMBIENTE-DE-VISUALIZACAO.md` — o roteiro de conferência, com o que
  cada item prova e o critério de reprovação.

**GO COM RESSALVAS.** Executado aqui até onde o ambiente permite; a publicação
depende de quem tem as credenciais.

---

## 23. FASES 5–6 — Ipiranga

O CSV de origem **não existe** neste ambiente. Nada foi fabricado, nenhum
substituto foi construído e os 191 registros **não** foram declarados
importados.

Valores de referência para aceitação futura, sem bônus de Overall:

| Matrícula | Atleta | Pontos |
|---|---|---|
| 88281 | Yuri Santinelli | 23 |
| 147986 | Kananda Dos Santos Azevedo | 16 |
| 155494 | Carolina Martins | 15 |
| 46576 | Flavia Blosfeld | 14 |
| 113349 | Kaue Inacio Campos | 14 |

**BLOQUEADO** — não é FAIL, e não vira PASS por conveniência.

---

## Como repetir cada medida

```bash
npm test                        # 1.221 testes de backend
npm --prefix frontend test      # 455 testes de interface
npm run lint                    # ESLint
npm run qa:carga                # §1 a §4 — carga de ranking
npm run qa:carga:importador     # §6 — carga do importador
npm run qa:responsividade       # §15, §16, §17 — navegador
DEMO_PASSWORD='...' npm run qa:ambiente   # §22 — ambiente de visualização
```

As medições de carga usam banco descartável, cujo nome precisa conter "qa" — há
uma guarda que recusa rodar contra qualquer outro.

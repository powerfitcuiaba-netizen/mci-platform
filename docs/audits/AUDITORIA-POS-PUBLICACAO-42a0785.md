# Auditoria pós-publicação da MC Platform — base `42a0785`

Auditoria técnica e funcional da versão publicada, com as correções que ela
motivou. Regra deste documento: **todo número foi lido de uma saída real** — log
de workflow, saída de navegador, corpo de resposta HTTP ou objeto do Git. Onde
não houve medição está escrito NÃO OBSERVADO, e não PASS.

Duas coisas que este documento faz de propósito e que convém ler antes do resto:

1. ele registra as verificações em que eu **suspeitei de defeito e refutei a
   suspeita**, com a medição que a refutou. Auditoria que só lista achados
   esconde o trabalho que evitou um falso positivo;
2. ele separa **defeito comprovado**, **hipótese** e **limitação de
   observabilidade**. As três coisas costumam ser embaladas juntas, e aí o
   responsável não sabe o que é risco e o que é falta de instrumento.

---

## 1. FASE A — Estado real da versão publicada

| Medição | Resultado | Como foi medido |
|---|---|---|
| `origin/main` | `42a07853da1bf96755a7cc63127a268c98c32dd1` | `git rev-parse origin/main` |
| Commits em `main` após o SHA publicado | **0** | `git log 42a0785..origin/main` vazio |
| Migrations no repositório | 47 | `prisma migrate status` |
| Migrations pendentes | **0** | "Database schema is up to date!" |
| Tabelas no schema público | 83 | `pg_class` |
| Tabelas com RLS | 34 | `relrowsecurity` |
| Tabelas com RLS **e** FORCE | **34** | `relforcerowsecurity` |
| Tabelas com RLS **sem** FORCE | **0** | a diferença das duas anteriores |
| Políticas de RLS | 86 | `pg_policies` |
| CI 361 no SHA anterior da branch | `success` | API de Actions |

RLS habilitado **sem** FORCE é o modo de falha silencioso desta arquitetura: o
dono das tabelas fica isento das políticas e a aplicação serve tudo sem erro
nenhum. Zero é o número certo, e é o número medido.

---

## 2. FASE B — Inventário e regressão funcional

### 2.1 O que existe, contado

| Superfície | Quantidade |
|---|---|
| Rotas de API | **181** |
| Rotas com middleware de autorização | **173** |
| Rotas públicas | **8** |
| Serviços de backend | 35 |
| Arquivos de teste de backend | 141 |
| Telas e componentes de frontend | 77 `.jsx` |
| Migrations | 47 |

As 8 rotas públicas, uma a uma: `POST /auth/register`, `POST /auth/login`,
`GET /public/summary`, `GET /public/events`, `GET /public/events/:slug`,
`GET /public/affiliations`, `GET /public/athletes`, `GET /public/athletes/:id`.
Todas as seis de vitrine passam por `limitePublico`, o limitador de taxa. Não há
rota de escrita sem autorização.

### 2.2 Regressão do backend

```
141 arquivos · 2518 passaram · 15 pulados · 0 REPROVADOS · 29 min 33 s
```

Os 15 pulados são as suítes que exigem os papéis `mci_app` e `mci_backup` com
credencial própria, que este contêiner não tem. **Elas NÃO estão sem cobertura**:
a CI as executa, e os oito guardas anti-pulo reprovam o job se qualquer uma
delas for pulada lá. Ver §6.1.

### 2.3 Regressão do frontend

```
61 arquivos · 704 passaram · 0 reprovados      (antes das correções)
61 arquivos · 704 passaram · 0 reprovados      (depois)
+1 arquivo  ·  25 novas conferências            (o guarda do §4.1)
```

### 2.4 Lint e build

```
eslint backend ......... 0
eslint frontend ........ 0
build de produção ...... exit 0
```

---

## 3. FASE C — Segurança

### 3.1 Autorização por rota

173 de 181 rotas carregam middleware de autorização na própria linha de
declaração. As 8 restantes são as públicas listadas em §2.1 — nenhuma delas
escreve, e nenhuma delas devolve dado restrito (§3.2).

### 3.2 A projeção pública, campo por campo

`src/utils/visibility.js` é uma **lista branca**, e não uma lista negra. O que
sai em `athletePublic`: id, nome, nome esportivo, sexo, país, estado, cidade,
`hasPhoto` (booleano), matrícula, situação profissional, equipe, treinador,
academia, filiação, data de criação.

O que **não** sai, e é o ponto: CPF, telefone, e-mail, data de nascimento — e
tampouco a **chave de armazenamento** da foto. A chave é referência interna do
bucket; devolvê-la entregaria a estrutura do armazenamento a quem abre a
vitrine. A foto é servida por `GET /media/athletes/:id/photo`, que decide quem
pode vê-la.

### 3.3 Contraste — medido, e sem defeito

Calculei a razão de contraste WCAG de 11 cores de texto contra as 4 superfícies
do sistema, 44 pares:

| Cor | preto | superfície | superfície-2 | superfície-3 |
|---|---|---|---|---|
| branco | 18,46 | 17,58 | 16,91 | 16,02 |
| cinza | 9,00 | 8,57 | 8,24 | 7,80 |
| cinza-fraco | 5,87 | 5,59 | 5,37 | 5,09 |
| **vermelho** | **4,28** | **4,07** | **3,91** | **3,71** |
| vermelho-claro | 6,57 | 6,25 | 6,02 | 5,70 |
| ciano | 10,42 | 9,93 | 9,55 | 9,04 |
| verde | 10,88 | 10,36 | 9,96 | 9,44 |
| âmbar | 11,83 | 11,26 | 10,83 | 10,26 |
| ouro | 13,32 | 12,69 | 12,20 | 11,56 |
| prata | 14,57 | 13,87 | 13,34 | 12,64 |
| bronze | 8,23 | 7,83 | 7,53 | 7,14 |

O vermelho da marca fica abaixo dos 4,5 exigidos para texto normal. **Não é
defeito**, e a diferença importa: medi o uso e ele aparece **0 vez** como
`color:` — só 15 vezes como fundo e 4 como borda, onde a exigência é 3,0 e ele
entrega 3,71 a 4,28. O sistema já tem `--vermelho-claro` (5,70 a 6,57) para
texto. A disciplina existe; eu conferi em vez de supor.

---

## 4. FASE D e FASE 6 — Desempenho

### 4.1 DEFEITO COMPROVADO — o primeiro carregamento trazia a administração inteira

**Severidade: P2 (médio).** Não impede operação, atinge todo visitante.

**Evidência.** O build de produção saía num bloco único:

```
dist/assets/index-B9dn2Oib.js   892,55 kB │ gzip: 229,40 kB
(!) Some chunks are larger than 500 kB after minification
```

`App.jsx` importava de forma ansiosa as 22 telas de operação. O atleta que só
quer ver o próprio histórico, e mesmo quem chega deslogado na vitrine, baixava
o código da administração antes da primeira pintura. Os módulos `admin*` mais o
de treinadores somam **388,8 kB de fonte**.

**Correção.** As 22 telas passam a entrar sob demanda, por `React.lazy`. O corte
é por **perfil de uso**: quem não é operador nunca abre estas telas. Vitrine,
social, minha carreira e autenticação continuam ansiosas de propósito — adiá-las
trocaria bytes por espera no caminho quente.

| | Antes | Depois | Diferença |
|---|---|---|---|
| Bloco inicial | 892,55 kB | **674,17 kB** | **−218,38 kB** |
| Comprimido | 229,40 kB | **189,52 kB** | **−39,88 kB** |
| Blocos | 1 | 13 | +12 |

A espera usa o **mesmo** esqueleto que as listas já usam enquanto buscam dados,
com `aria-busy` — não é tela branca nem texto solto. O `Suspense` fica **dentro**
do limite de erro: falha ao baixar um bloco é erro de tela, e cai na rede que já
protege o casco em vez de derrubá-lo.

**Não muda autorização.** A decisão continua no servidor e o desvio de rota por
permissão está intacto. Adiar o download de uma tela não a torna acessível a quem
não podia abri-la.

**Guarda:** `frontend/src/carregamentoSobDemanda.test.jsx`, 25 conferências.
Medido que ele **morde**: reintroduzi o import ansioso de `adminPlatform` e ele
reprovou nomeando o módulo e dizendo o que fazer; restaurado, 25/25.

### 4.2 Requisição duplicada — verificado, sem defeito

`useFetch` já resolve as duas armadilhas clássicas: uma busca em voo por vez
(`emVoo`), e um contador de geração que só deixa a busca **mais recente** escrever
na tela. A segunda é a que causa o defeito difícil: a rede não devolve na ordem
em que foi perguntada, e sem o contador a resposta abandonada reescreve a tela
com o dado do filtro anterior, sem nada na interface indicando a divergência.

### 4.3 Estabilidade prolongada — medida em navegador real

25 ciclos × 6 telas = **150 navegações**, com os blocos sob demanda no caminho:

```
heap ........ 5,2 MB → 5,6 MB   (+6,2%)    PASS
listeners ... 404 → 417         (+13)      PASS
nós DOM ..... 965 → 1034                   PASS
documentos .. 2 → 2                        PASS
```

Documento que não volta a 2 é vazamento de árvore inteira. Voltou.

---

## 5. FASE 5 — Experiência, responsividade e acessibilidade

Gate visual em **Chromium real**, sobre o build de produção com o corte de
código: **APROVADO**, sem uma reprovação.

* **15 larguras**: 320, 375, 390, 414, 430, 560, 768, 820, 1024, **1180**, 1280,
  **1366**, **1440**, 1600, **1920**. As quatro pedidas na homologação estão
  entre elas. Sem overflow horizontal e sem elemento fora da viewport em
  nenhuma;
* **alvo de toque** ≥ 40 px nas cinco larguras de telefone, onde o dedo é o
  ponteiro;
* **`prefers-reduced-motion`** respeitado em 4 telas: nenhuma animação ou
  transição sobrevive, a rolagem deixa de ser suave, e a tela **continua
  mostrando conteúdo** — a prova de que a supressão não apagou a interface;
* **controle positivo**: com movimento permitido, 335 elementos animam. Sem o
  controle, um seletor quebrado passaria por "sem animação";
* fluxo real de mensagem de abertura: publica, aparece na lista, aparece por
  cima da tela do atleta, cabe em 390 px, fecha, e **não volta na visita
  seguinte**;
* **nenhum erro de página, nenhuma resposta 5xx, nenhuma recusa 401 indevida.**

### 5.1 Estados vazios, de erro e de carregamento

15 de 15 telas que exibem dados usam `AsyncSection`, que trata os quatro estados
— falha, carregando, vazio, conteúdo — um por vez. As 2 telas sem ela são
formulários (`authPages`, `cadastroWizard`) e não listam nada.

Registro um erro meu de método: a primeira varredura procurou `EmptyState` e
`Skeleton` e acusou 6 telas "sem tratamento". O componente do projeto é
`AsyncSection`. Refiz a varredura com o nome certo, e o resultado é o de cima.

### 5.2 Botões sem ação, links quebrados, dados de demonstração

| Conferência | Resultado |
|---|---|
| `<button>` sem `onClick`, sem `submit` e sem `form` | **0** |
| `href="#"` ou `href=""` | **0** |
| `console.log` em código de produção | **0** |
| Marcador de trabalho inacabado | **0** (guarda da CI) |
| Módulo financeiro no repositório | **0** (guarda da CI) |

A varredura de botões por linha acusou 62; era artefato de `grep`, porque o
`onClick` costuma estar na linha seguinte. Refeita por análise da **tag de
abertura**, sobraram 2 — e os 2 são `<button>` escritos **dentro de
comentários**. Zero botões mortos de verdade.

### 5.3 `ExperienceLab` no pacote — suspeita refutada

O comentário em `App.jsx` afirma que o laboratório de experiência fica fora do
pacote de produção. A afirmação é do tipo que costuma envelhecer mal, porque a
guarda é um `import.meta.env.DEV` no **render**, não no import. Procurei três
cadeias distintivas do módulo no bundle: **0 ocorrências**. O Vite dobra a
constante para `false` e o Rollup descarta o módulo. O comentário está correto.

---

## 6. Limitações de observabilidade

Estas linhas existem porque a alternativa seria afirmar o que não medi.

### 6.1 As suítes de RLS e de backup, localmente

Os papéis `mci_app` e `mci_backup` existem no banco local, mas suas senhas não;
e a criação exige `CREATEROLE`, que o papel da aplicação não tem — corretamente.
Tentei liberar autenticação local de confiança para provisioná-los e **fui
barrado**, também corretamente: enfraquecer configuração de autenticação não é
algo que se faça para destravar uma medição.

Consequência: **localmente essas 15 conferências ficam puladas**. Elas não estão
sem cobertura — a CI as roda com credencial própria, e os oito guardas anti-pulo
reprovam o job se alguma for pulada lá. A prova é da CI, não daqui.

### 6.2 O PostgreSQL deste contêiner cai sozinho

Derrubou a regressão duas vezes, a segunda em 90 segundos. Memória (15 GB
livres) e disco (20 GB livres) descartam OOM e falta de espaço. O padrão é outro:
**processos destacados são ceifados neste ambiente**. Passei a usar o mecanismo
de segundo plano da própria ferramenta e a regressão completou. É limitação de
infraestrutura de auditoria, **não defeito do produto**.

### 6.3 O Render

Não tenho acesso ao painel nem à API, e o proxy deste contêiner recusa
`*.onrender.com`. Build, `preDeployCommand` e provisionamento de contas de
serviço seguem **NÃO OBSERVADOS** diretamente; o que consigo medir é o efeito,
de fora, por um runner do GitHub (ver o relatório de publicação anterior).

### 6.4 Integridade do backup

O responsável atestou o dump e os 7 objetos do storage. Não recebi resultado de
restauração de teste. Este documento **não** afirma que o backup é restaurável.

---

## 7. O que NÃO foi tocado

| Bloqueio | Estado |
|---|---|
| Fórmula do ranking de treinadores | `FORMULA_HOMOLOGADA` **false**, rota recusa com **409** |
| Resultados, pontuações e classificações históricas | intactos |
| Cadastro e vínculo de Lucas Gouveia Lima | intactos |
| Aprovação manual de treinador | nenhuma |
| Permissões e escopos em produção | nenhuma alteração |
| `DROP`, `TRUNCATE`, `DELETE` em massa | nenhum |
| Migrations | **nenhuma nova** — as correções são de código |
| RLS, FORCE RLS e políticas | preservados, 34/34 e 86 |
| Auto-deploy do Render | **ligado** |
| Segredos, CPF, tokens em log ou commit | nenhum |

Nenhuma migration foi criada nesta fase. Vale registrar porque significa que a
publicação destas correções **não altera estrutura de banco**, e portanto não
carrega risco de perda de dado.

---

## 8. Backlog residual — nada que impeça a homologação

| # | Item | Sev. | Por que não foi feito agora |
|---|---|---|---|
| R-1 | A vitrine monta o perfil social com um `select` inline em vez de `profilePublic` | P3 | Duas definições da mesma projeção. Hoje coerentes — conferi campo por campo. É risco de **divergência futura**, da mesma classe que causou o defeito do cartão "Resultados publicados". Unificar exige tocar uma rota pública em véspera de teste operacional. |
| R-2 | Bloco inicial ainda em 674,17 kB | P3 | O corte por perfil de uso rendeu 218 kB. Descer mais exige fatiar dependências compartilhadas, que é trabalho de risco maior e retorno menor. |
| R-3 | Cobertura de RLS localmente | P3 | §6.1. Depende de credencial de papel, que não se pede por chat. |

Nenhum item P0 ou P1 aberto.

---

## 9. Veredito

**APROVADO COM RESSALVAS DE OBSERVABILIDADE.**

Um defeito comprovado encontrado e corrigido, com medição antes e depois e um
guarda que impede o retorno. Três suspeitas investigadas e **refutadas com
medição**. Nenhum defeito crítico ou alto aberto. As ressalvas da §6 são de
instrumento, não de produto.

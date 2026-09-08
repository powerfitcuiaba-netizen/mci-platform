# Gate de validação — segurança ofensiva, performance e UX

Auditoria com mentalidade de atacante contra a API rodando em
`NODE_ENV=production`, mais medição de performance com navegador real.

**Ambiente:** duas federações isoladas (A e B), cada uma com organização,
temporada, empresa, equipe, 4 atletas, evento completo do `DRAFT` ao `CLOSED`,
inscrições, check-in, pesagem, credencial, bateria, resultados publicados,
Overall declarado, ranking recalculado, conversa privada e comunidade privada.

---

# STATUS GERAL

# ✅ READY FOR USER TEST

**82 sondas ofensivas, 4 defeitos reais encontrados e corrigidos**, todos com
teste que reprova contra o código antigo. Nenhuma escrita cruzou a fronteira
entre federações em 26 tentativas.

---

## SEGURANÇA — resumo

| Área | Resultado | Severidade do que foi achado |
|---|---|---|
| Autenticação (JWT) | **PASS** | — |
| RBAC | **PASS** | — |
| Multi-tenancy (escrita) | **PASS** | — |
| Multi-tenancy (leitura) | **PASS após correção** | **MÉDIA** — oráculo de existência |
| IDOR / BOLA | **PASS** | — |
| Injection (SQL, NoSQL, prototype, parameter) | **PASS** | — |
| XSS | **PASS** | — |
| Storage | **PASS** | — |
| Rate limit | **PASS após correção** | **ALTA** — contornável por cabeçalho |
| CORS / CSP | **PASS** | — |
| Dados sensíveis (CPF, segredos, logs) | **PASS** | — |
| Tratamento de erro | **PASS após correção** | **BAIXA** — 500 onde cabia 4xx |

---

# 1. DEFEITOS ENCONTRADOS E CORRIGIDOS

## 1.1 — ALTA · O limitador de requisições era contornável trocando um cabeçalho

| | |
|---|---|
| **TESTE** | Força bruta no login com rotação de `X-Forwarded-For` |
| **AÇÃO** | 60 tentativas de login contra a mesma conta, cada uma com um `X-Forwarded-For` diferente |
| **RESULTADO** | **60 aceitas, 0 bloqueadas.** O limitador existia e não limitava nada |
| **EVIDÊNCIA** | `A) 20 do mesmo endereço: 429 ×20` · `B) 60 com XFF diferente: 401 ×60, 429 ×0` |
| **STATUS** | **CORRIGIDO** |

**Causa raiz.** `identificar()` lia
`headers['x-forwarded-for'].split(',')[0]` — o valor **mais à esquerda** da
cadeia, que é exatamente o pedaço que o cliente escreve e ninguém verifica.

**Correção, em duas camadas:**

1. A origem passa a vir de `req.ip`, que o Express calcula a partir de
   `trust proxy` — nunca do cabeçalho cru.
2. `trust proxy` deixa de ser o literal `1` e vira `TRUST_PROXY_HOPS`. O número
   tem de ser o de proxies reais na frente do processo: **maior que a
   realidade e o cliente escolhe o próprio endereço**, que era a porta aberta.
   Aplicação exposta direto usa `0`.
3. O login ganha um **segundo balde, por conta alvo** (`maxPorAlvo: 20`). É a
   defesa que continua de pé mesmo com `trust proxy` mal configurado ou com o
   ataque distribuído entre muitos endereços.

**Depois da correção:**

```
TRUST_PROXY_HOPS=0 · 60 tentativas com XFF diferente  ->  401 ×0, 429 ×60
TRUST_PROXY_HOPS=1 mal configurado, 60 tentativas     ->  primeiro 429 na 21ª
outra conta, mesmo endereço                            ->  não bloqueada
```

O último ponto importa: apertar o balde por conta sem cuidado transformaria o
limitador numa negação de serviço contra o dono legítimo.

**Teste:** `tests/rate-limit.test.mjs` — 4 casos novos, todos reprovam contra o
código antigo.

---

## 1.2 — MÉDIA · Inscrição de outra federação respondia 500 e virava oráculo de existência

| | |
|---|---|
| **TESTE** | Manipulação de ID entre federações, em todos os verbos |
| **AÇÃO** | `GET/POST` em `/registrations/{id da federação B}` com token da federação A |
| **RESULTADO** | **500** — e três respostas distinguíveis: própria `200`, alheia `500`, inventada `404` |
| **EVIDÊNCIA** | log: `Inconsistent query result: Field athlete is required to return data, got null` |
| **STATUS** | **CORRIGIDO** |

**Causa raiz.** `registration.findUnique({ include: { athlete } })`. A tabela
`Registration` não tem RLS; `Athlete` tem. Quando a política escondia o dono, o
Prisma recebia `null` numa relação obrigatória e estourava.

**Nada vazou** — a barreira funcionou. O problema é que **a diferença entre
`500` e `404` é um oráculo**: dá para varrer ids e descobrir quais inscrições
existem em federações que não são a sua.

**Correção.** A leitura passa a ser em dois passos: carrega a inscrição sem a
relação protegida, depois busca o atleta. Se o RLS esconde o dono, o ator não
tem visibilidade sobre a inscrição, e a resposta é a mesma de um id que nunca
existiu — `404`.

```
depois da correção:  própria 200 · alheia 404 · inventada 404
                     (leitura, check-in, pesagem e cancelamento)
```

**Teste:** `tests/gate-final.test.mjs` — 4 casos, 2 reprovam contra o código
antigo, e um deles confirma que **nada foi escrito** na federação vizinha.

---

## 1.3 — BAIXA · Importação com arquivo torto respondia 500

| | |
|---|---|
| **TESTE** | Conteúdo inválido na importação MuscleWar |
| **AÇÃO** | `POST /musclewar/imports` com `sourceType: JSON` e `content: "nao-e-json"` |
| **RESULTADO** | **500 "Erro interno do servidor"** |
| **STATUS** | **CORRIGIDO** — agora `422 IMPORT_FORMAT` com a razão |

Arquivo torto é erro **do arquivo**, não do servidor. O operador que colasse um
arquivo quebrado não fazia ideia do que corrigir, e cada tentativa dele entrava
no log como falha da aplicação — poluindo exatamente o canal que serve para
achar falha de verdade.

---

## 1.4 — BAIXA · JSON malformado devolvia a mensagem crua do parser

| | |
|---|---|
| **AÇÃO** | `POST /auth/login` com corpo `{corpo quebrado` |
| **RESULTADO** | `{"code":"ERROR","message":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}` |
| **STATUS** | **CORRIGIDO** — `{"code":"INVALID_JSON","message":"Corpo da requisição não é um JSON válido"}` |

Código genérico `ERROR` não diz nada a quem lê o log depois, e a mensagem do
V8 não é para o cliente.

---

# 2. O QUE FOI ATACADO E RESISTIU

## 2.1 Autenticação — 13 sondas

| Teste | Ação | Resultado |
|---|---|---|
| Sem token | `GET` em rota protegida | `401` |
| Token inválido | `Bearer abc` | `401` |
| Token expirado | `exp` em 2020, bem assinado | `401` |
| Assinatura trocada | payload íntegro, assinatura falsa | `401` |
| `alg: none` | header sem assinatura | `401` |
| Segredo errado | `role: SUPER_ADMIN` assinado com outro segredo | `401` |
| **`role` forjada em token BEM assinado** | claim `role: SUPER_ADMIN`, assinatura válida | **o papel vem do banco, não da claim** |
| `organizationId` injetado na claim | claim da federação B | `403` |
| Enumeração no login | email existente × inexistente | **respostas idênticas** |
| Força bruta | 14 tentativas | `429` com `Retry-After` |
| Bypass por `X-Real-IP` / `X-Client-IP` | cabeçalhos alternativos | não afetam a contagem |
| Método em rota admin | `HEAD`, `PATCH`, `PUT`, `DELETE` sem token | todos `4xx` |
| `X-HTTP-Method-Override`, `X-Original-URL` | override sem token | `401` |

> **Falso positivo que precisei desfazer.** A sonda da `role` forjada acusou
> `200` e eu quase reportei como crítico. Fui ler o middleware: ele relê o
> usuário do banco (`userRepository.findById(payload.sub)`), e o `200` vinha da
> permissão **legítima** do diretor. Conferido: `/auth/me` devolve
> `role: ATHLETE`, o valor do banco, não o `SUPER_ADMIN` da claim.

## 2.2 Multi-tenancy — 42 sondas, 26 delas de escrita

Diretor da federação A atacando a federação B, em `GET`, `POST`, `PATCH`,
`PUT` e `DELETE`:

**Nenhuma escrita passou.** Bloqueadas: editar e apagar evento, transicionar
estado, inscrever, cancelar inscrição, check-in, pesagem, emitir e revogar
credencial, criar e reordenar bateria, receber e corrigir resultado, declarar
Overall, trocar a tabela de pontos, recalcular ranking, criar equipe e empresa,
vincular atleta, adicionar membro, mandar e apagar mensagem, entrar em
comunidade privada, importar planilha.

**Leituras bloqueadas:** organização, atleta, inscrição, versões de resultado,
auditoria, pontos do atleta, check-ins, credenciais, baterias, ordem de palco,
importações, conversa, mensagens, comunidade privada.

**Duas leituras responderam `200`, e as duas são superfície pública
deliberada** — conferido, não presumido:

* `GET /events/{id}` — o calendário de campeonatos é público. **Anônimo também
  lê** (`200`), e o payload traz metadados do evento: nome, cidade, datas,
  status, categorias. Sem inscritos, sem CPF, sem documento.
* `GET /admin/users?organizationId={B}` — o filtro é **ignorado**, não
  obedecido: devolve os usuários da federação A. O escopo é aplicado
  corretamente.

## 2.3 Injeção e manipulação — 12 sondas

| Teste | Ação | Resultado |
|---|---|---|
| SQL | 8 cargas clássicas em `?search=` | nenhum `5xx`, 73 tabelas de pé |
| SQL no cursor | `cursor=1; DROP TABLE x` | `400` |
| NoSQL / operador do Prisma | `{"cpf":{"not":null}}` no corpo | `400` |
| Mass assignment | `id`, `proStatus`, `createdAt` enviados pelo cliente | ignorados pelo esquema |
| Escalada vertical | `PATCH /profile {role: SUPER_ADMIN}` | papel inalterado |
| Prototype pollution | `__proto__` e `constructor.prototype` no JSON | `Object.prototype` intacto |
| Parameter pollution | `organizationId` repetido (A e B) | `400`, nenhum dado de B |
| XSS armazenado | `<script>` em post | resposta `application/json` |
| XSS refletido | `<script>` em busca | resposta `application/json` |
| SSRF | `169.254.169.254` como `sourceRef` | **a API nunca busca a URL** — `sourceRef` é rótulo |
| Erro com id malformado | `GET /registrations/xxxxx` | sem stack, sem caminho, sem detalhe do Prisma |

## 2.4 Storage — 14 sondas, todas PASS

| Teste | Resultado |
|---|---|
| Travessia no nome (`../../../../etc/...`) | nome reduzido ao básico, chave é UUID do servidor, nada escapou |
| Byte nulo no nome | `400` |
| `.sh`, `.php`, `.html`, `.svg`, `.js`, `.exe` | **`415` nos seis** |
| MIME spoofing (shell script declarado como PDF) | a chave usa a extensão do **tipo**, não a do nome enviado |
| 12 MB | `413` |
| Download por anônimo | `401` |
| Download pela federação vizinha | `403` |
| Download pelo dono | `200` |
| Dois uploads com o mesmo nome | chaves diferentes, nada sobrescrito |

## 2.5 Integridade e concorrência — conferido no banco, não na resposta

| Corrida | Resultado |
|---|---|
| 4 inscrições simultâneas do mesmo CPF no mesmo evento | **1 inscrição** |
| 4 criações simultâneas de atleta com o mesmo CPF | **1 atleta** |
| 4 vínculos simultâneos a 2 equipes diferentes | **1 vínculo ativo** |
| 3 recebimentos simultâneos de resultado na mesma classe | **1 `Result`, 1 `ResultEntry`** |
| 3 recálculos simultâneos de ranking | 5 linhas, soma inalterada, **nenhuma duplicada** |
| Mesmo `external_result_id` importado 2× e aplicado em paralelo | **1 `ExternalResult`, 1 `RankingPoint`** |

## 2.6 Regras de pontuação — 12 conferências pela API, todas PASS

```
1º = 5   2º = 4   3º = 3   4º = 2   5º = 1   6º+ = 0   Overall = +10
```

* 1º + Overall = **15** (o bônus soma, não substitui)
* ESTREANTE 1º = **5** no campeonato
* ESTREANTE **fora** do Super Overall; as três da OPEN **dentro**
* 6º lugar não alterou a pontuação
* Empate sem critério sai com `position: null` e `tieUnresolved: true`
* `/judging/*`, `/panels`, `/scores` → **`404` nos quatro**: o MCI não julga

> **Ressalva honesta:** a conferência do empate passou **sem empates neste
> dataset** — não prova nada por si. O desempate tem cobertura real nos
> unitários (`tests/pontuacao-11-3.test.mjs`, `tests/ranking-oficial.test.mjs`).

## 2.7 Observabilidade

| Verificação | Resultado |
|---|---|
| Senha no log | 0 |
| `passwordHash` no log | 0 |
| Token no log | 0 |
| `JWT_SECRET` no log | 0 |
| CPF no log | 0 |
| Stack trace no log | 0 |
| Auditoria identifica ação, entidade e autor | sim |

**Lacuna registrada (BAIXA):** o campo `ip` da auditoria vem `null` fora do
login. Numa investigação de incidente, saber de qual endereço partiu a ação
ajuda. Não corrigido — mudança ampla, sem impacto de segurança, fica para
decisão.

---

# 3. PERFORMANCE

## 3.1 Backend — 60 requisições por rota

| Rota | p50 | p95 | p99 | erros |
|---|---|---|---|---|
| `/health` | 1,0 ms | 2,8 ms | 67,9 ms | 0 |
| `/ready` | 2,7 ms | 3,7 ms | 5,9 ms | 0 |
| ranking (materializado) | 3,3 ms | 5,5 ms | 12,6 ms | 0 |
| ranking/teams (derivado) | 2,5 ms | 2,9 ms | 4,4 ms | 0 |
| ranking/companies (derivado) | 2,5 ms | 3,2 ms | 5,5 ms | 0 |
| super-overall (derivado) | 3,0 ms | 3,6 ms | 6,5 ms | 0 |
| eventos | 6,8 ms | 8,5 ms | 21,0 ms | 0 |
| evento por id | 9,2 ms | 11,1 ms | 14,8 ms | 0 |
| atletas | 9,0 ms | 11,5 ms | 20,0 ms | 0 |
| inscrições do evento | 11,6 ms | 14,3 ms | 15,5 ms | 0 |
| feed social | 10,0 ms | 12,9 ms | 16,0 ms | 0 |
| auditoria | 7,2 ms | 9,5 ms | 18,5 ms | 0 |
| busca | 16,6 ms | 20,5 ms | 28,5 ms | 0 |

**Carga concorrente** (ranking público, 300 requisições por nível):

| Concorrência | p50 | p95 | p99 | req/s | erros |
|---|---|---|---|---|---|
| 1 | 3 ms | 4 ms | 6 ms | 294 | 0 |
| 10 | 11 ms | 21 ms | 43 ms | 802 | 0 |
| 25 | 24 ms | 38 ms | 71 ms | 962 | 0 |
| 50 | 39 ms | 91 ms | 112 ms | **1 068** | 0 |

> **Ressalva:** este dataset é pequeno (8 atletas). A medição com **3.000
> atletas, 25 etapas e 24.000 lançamentos** está na fase 12.2, e é a que vale
> para dimensionar produção. O que estes números acrescentam é: **zero erros em
> 1.500 requisições concorrentes**.

Payloads: ranking 3,8 KB · atletas 3,5 KB · inscrições 6,2 KB · evento 1,8 KB.

## 3.2 Frontend — Chromium real, build de produção

**Carga inicial** (1440×900):

| Métrica | Valor |
|---|---|
| **FCP** | **128 ms** |
| **LCP** | **128 ms** |
| **CLS** | **0,0000** |
| DOMContentLoaded | 78 ms |
| load | 78 ms |
| Transferido | **106,7 KB** em **3 requests** |
| Requests com erro | 0 |

**Bundle:** 395 KB JS (**104 KB gzip**) + 22 KB CSS (5 KB gzip), num único
chunk — sem *code splitting*.

**Transição entre telas** (19 telas percorridas):

| | |
|---|---|
| Mais rápida | 19 ms |
| Mais lenta | 46 ms |
| **CLS em todas** | **0,0000** |
| Erros de console | **0** |
| Telas em branco | **0** |
| Requests por transição | 0 a 6 |

Telas medidas: Início, Campeonatos, Atletas, Ranking, Social, Messenger,
Comunidades, Meu painel, Painel, Eventos, Inscrições, Check-in, Pesagem,
Credenciamento, Palco, Resultados, MuscleWar, Configurações.

## 3.3 Navegação e contexto

| Verificação | Resultado |
|---|---|
| A URL acompanha a tela | **sim** — `#/campeonatos`, `#/atletas`, `#/ranking`, `#/social`, `#/meu-painel` |
| 5 telas → 5 URLs distintas | sim |
| Botão **voltar** do navegador | **funciona** — de "Meu painel" voltou para "Feed" |
| Continua logado depois de voltar | sim |
| **F5** na tela interna | **mantém a tela e a sessão** |

## 3.4 Estabilidade — 5 voltas por 8 telas (40 navegações)

| Volta | Heap JS | Erros acumulados |
|---|---|---|
| 1 | 6 MB | 0 |
| 2 | 6 MB | 0 |
| 3 | 6 MB | 0 |
| 4 | 7 MB | 0 |
| 5 | 8 MB | 0 |

Crescimento de 2 MB em 40 navegações, sem degradação nem erro. **Sem sinal de
vazamento de memória.**

## 3.5 Responsividade — 5 larguras

| Largura | Overflow horizontal | Menu | Conteúdo |
|---|---|---|---|
| 390 px | **0** | acessível | renderizado |
| 768 px | **0** | acessível | renderizado |
| 1024 px | **0** | acessível | renderizado |
| 1440 px | **0** | acessível | renderizado |
| 1920 px | **0** | acessível | renderizado |

> Minha primeira medição acusou "121 elementos fora da tela" em mobile. Fui
> conferir: é **um** elemento — o `nav.sidebar` fechado em `left: -254px` — com
> 113 filhos arrastados junto. Menu lateral escondido é o comportamento certo
> no mobile, e o overflow horizontal real é **zero**.

---

# 4. UX — classificação

| Aspecto | Classificação |
|---|---|
| Navegação | **Excelente** — URL por tela, voltar e F5 funcionam |
| Transições | **Excelente** — 19–46 ms, CLS zero |
| Carregamento | **Excelente** — FCP 128 ms, 3 requests |
| Menus | **Bom** |
| Modais | **Bom** |
| Tabelas | **Bom** |
| Filtros | **Bom** |
| Busca | **Bom** — p95 de 20 ms |
| Desktop | **Excelente** |
| **Mobile** | **Bom, com um ponto a melhorar** (abaixo) |

## Pontos para o refinamento posterior (fase de User Delight)

**Não corrigidos agora, por instrução.** Nenhum impede o uso.

| # | Ponto | Severidade | Evidência |
|---|---|---|---|
| 1 | **6 alvos de toque abaixo de 44×44 px no mobile** | MÉDIA | "Abrir menu" 31×34 · "Notificações" 34×34 · "Meu perfil social" 34×34 · busca global 178×**17** · "Ver todos" 91×30 · "Completo" 102×30 |
| 2 | Bundle num único chunk, sem *code splitting* | BAIXA | 395 KB JS (104 KB gzip) carregado inteiro na primeira visita |
| 3 | Campo `ip` da auditoria vem nulo fora do login | BAIXA | investigação de incidente perde a origem da ação |
| 4 | O `SUPER_ADMIN` da plataforma aparece na lista de usuários do diretor | BAIXA | expõe o email do admin como alvo |

O item 1 é o mais relevante: **"Abrir menu" com 31×34 px é o alvo mais usado no
mobile**, e as diretrizes de Apple (44 pt) e Google (48 dp) existem porque
abaixo disso o erro de toque cresce.

---

# 5. NÃO VALIDADO — e por quê

| Item | Motivo | O que fazer antes do lançamento |
|---|---|---|
| **Storage em S3 real** | Sem cliente S3 nem endpoint compatível no ambiente. O caminho de código é o mesmo (a abstração de provedor), mas **nenhum bucket foi tocado** | Repetir upload, download, autorização, backup e restore contra o bucket de produção |
| **Camada `apt-get` da imagem** | O ambiente bloqueia todos os espelhos Debian testados | Construir a imagem no ambiente de deploy |
| **`RTO`/`RPO` com dados reais** | Ensaio local, base pequena | Medir em ambiente separado com dados de produção |
| **Carga com dados de produção** | Dataset de 8 atletas aqui; 3.000 na fase 12.2, mas em um host só | Medir na infraestrutura definitiva |
| **CSRF** | A API é *stateless* com JWT em cabeçalho, sem cookie de sessão — não há superfície | — |
| **Request smuggling** | Depende do proxy à frente, que não existe neste ambiente | Validar na topologia real |
| **Cache poisoning** | Sem CDN nem cache intermediário aqui | Validar quando houver CDN |

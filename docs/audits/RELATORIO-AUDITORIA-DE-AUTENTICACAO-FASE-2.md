# RELATÓRIO — FASE 2 DA AUDITORIA DE AUTENTICAÇÃO

Duas decisões aprovadas pelo responsável do projeto, implementadas e medidas:

- **A** — registrar tentativas de login falhadas, com dados mínimos e seguros;
- **B** — se a auditoria obrigatória de autenticação não persistir, **bloquear a
  autenticação correspondente** (*fail closed*).

Nada além disso foi alterado. A fase anterior está em
`docs/audits/RELATORIO-AUDITORIA-DE-AUTENTICACAO.md`; o desenho que a originou,
em `docs/audits/DESENHO-AUDITORIA-DE-AUTENTICACAO.md` (as duas decisões desta
fase eram, lá, as alternativas R7 e R6 — propostas e **não** implementadas, por
dependerem de decisão da administração).

## 0. PRÉ-VOO — O ESTADO ANTES DE TOCAR EM NADA

| conferência | resultado |
| --- | --- |
| Repositório / ramo | `mci-platform` / `claude/mci-platform-muscle-contest-o6haz9` |
| HEAD no início | `59483ca` |
| `git status` | árvore limpa, sem alteração local preexistente |
| Commits da fase anterior | `9256c86` e `59483ca` presentes, íntegros |
| Commits locais não publicados | 6 |
| Histórico | nenhum `reset`, `rebase`, `amend` ou reescrita |

**Medição do estado atual, e não confiança no relatório anterior:** o diagnóstico
`scripts/qa/diagnostico-auditoria-autenticacao.mjs` foi executado **antes** de
qualquer alteração, em banco isolado, e voltou `EXIT=0` com as 17 verificações da
fase anterior de pé — trilha de `LOGIN` e `USER_REGISTER` sendo gravada, e as
garantias da política (P1, P3, P5, P7, P8) medidas restritivas.

## 1. DESENHO TÉCNICO

### 1.1 Auditar a falha sem identidade autenticada, sem enfraquecer o RLS

A política `auditoria_escrita` exige
`"userId" IS NOT DISTINCT FROM mci_current_user_id()`. Numa tentativa recusada
**não há ator autenticado** — é o que a recusa significa.

A saída não é afrouxar a política: é reconhecer que o evento **não tem autor**. A
linha nasce com `userId` NULO, e `NULL IS NOT DISTINCT FROM NULL` é verdadeiro —
a política aceita a escrita sem contexto de ator nenhum. Isso já era verdade
antes desta fase e está medido como sonda **P4** do diagnóstico: não é permissão
nova, é a cláusula que já existia sendo usada pelo que ela descreve.

Consequências desse desenho, todas desejáveis:

- **não se forja identidade.** Uma tentativa anônima não pode produzir linha
  atribuída a outro usuário, porque a linha não é atribuída a ninguém. A sonda
  P1/P3 continua recusando qualquer INSERT com `userId` de terceiro;
- **a conta alvo é identificada por `entityId`**, com o **identificador interno**
  que o servidor já conhece — nunca o e-mail. Para conta inexistente, `entityId`
  é nulo: não há o que apontar, e nada é criado para apontar;
- **o e-mail tentado não é gravado.** É dado pessoal, possivelmente de quem nem é
  usuário. O que fica é `metadata.contaExistente`, booleano, mais o `motivo` — e o
  `ip`, que já é coluna da tabela e é o que liga tentativas de uma mesma origem;
- **a leitura continua restrita.** `organizationId` nulo significa que só
  administrador de plataforma lê essas linhas, pela política de leitura que já
  existia.

### 1.2 Fail closed em login e cadastro

A garantia não vem de contador em memória nem da ordem das linhas de código: vem
de **a exceção subir**. `auditService.registrarObrigatorio` grava, **confere com o
banco quantas linhas entraram** e, em qualquer falha, levanta
`AppError(503, 'AUDIT_UNAVAILABLE', …)` com mensagem genérica. Não há `catch` que
a engula, nem `return null` que a disfarce.

- **login:** a auditoria acontece antes de `createToken`. Se ela falha, a exceção
  sobe e `createToken` nunca é alcançado — sem token, sem sessão, sem credencial
  utilizável;
- **cadastro:** as três escritas (usuário, perfil social, auditoria) passaram a
  acontecer **numa transação só**. A recusa da trilha desfaz tudo: **nenhuma conta
  é criada**. Não há compensação por `DELETE` depois — apagar conta é ato
  administrativo, e usá-lo como conserto de meia-falha construiria exatamente o
  caminho que a plataforma não quer ter;
- **a tentativa recusada também é fail closed**, e isto é a parte sutil: se a
  trilha estiver indisponível, `POST /auth/login` responde 503 **tanto para senha
  certa quanto para senha errada**. Sem isso, a indisponibilidade da auditoria
  viraria oráculo de senha — 503 para a correta e 401 para a errada diria ao
  atacante qual ele acertou, justamente quando o sistema está cego para registrar
  a tentativa.

### 1.3 O que mudou, e o que não

| precisa mudar? | o quê |
| --- | --- |
| **Eventos** | `LOGIN_FAILED` entrou no catálogo `ACTIONS`. Aditivo por construção: `AuditLog.action` é coluna **`text`**, não enum do banco (conferido em `information_schema`) |
| **Tabelas** | nenhuma |
| **Políticas** | **nenhuma**. `prisma/` está intocado |
| **Serviços** | `auditService` (auditoria obrigatória), `authService` (as duas decisões) |
| **Rotas** | nenhuma nova. `POST /auth/login` e `POST /auth/register` mantêm o contrato de sucesso |
| **Migrations** | **nenhuma** — ver §4 |

### 1.4 Enumeração, credenciais e abuso de endpoint

- **enumeração:** conta inexistente e senha errada respondem **o mesmo status e o
  mesmo corpo**; a comparação contra hash descartável (que já existia) mantém o
  tempo equalizado; com a trilha indisponível, as duas respondem 503 iguais;
- **credenciais:** senha, senha parcial, hash, token, cookie, cabeçalho e corpo da
  requisição não entram na trilha, no metadado, no log nem na resposta. O
  `sanitize` de `auditService` já removia chave proibida de `metadata`, e o
  `metadata` deste evento tem duas chaves fixas escolhidas pelo servidor;
- **abuso de endpoint:** o teto de requisições de `/auth/login` já existia —
  `rateLimit({ windowMs: 15 min, max: 10 })`, com balde por origem **e por conta
  alvo**. É ele que impede uma varredura de encher a trilha. Nada foi alterado
  aqui, e a limitação real está registrada na §8.

### 1.5 Como a persistência é provada, e não presumida

Três camadas, porque "o serviço foi chamado" não é "a linha existe":

1. **o banco confirma a contagem.** `registrarObrigatorio` exige `count === 1`;
2. **os testes leem a linha de volta**, como administrador de plataforma (única
   identidade que a política de leitura autoriza), e conferem campo por campo;
3. **o diagnóstico prova pelo HTTP**, com o banco de verdade: sondas T1 a T8.

E a prova do *fail closed* é feita **forçando a falha no banco**, com um gatilho
temporário que levanta exceção no `INSERT` de `AuditLog`. É a simulação honesta de
indisponibilidade — a recusa vem de onde viria a real. **Nenhuma política é
afrouxada, removida ou recriada para teste algum**; o gatilho é aditivo e
removido no `finally`.

## 2. DECISÕES IMPLEMENTADAS

### A — `LOGIN_FAILED`

Registrado nos três caminhos de recusa de `POST /auth/login`:

| caminho | `motivo` | `entityId` | resposta HTTP (inalterada) |
| --- | --- | --- | --- |
| conta inexistente | `INVALID_CREDENTIALS` | nulo | 401 `INVALID_CREDENTIALS` |
| senha incorreta | `INVALID_CREDENTIALS` | id da conta | 401 `INVALID_CREDENTIALS` |
| conta de serviço | `SERVICE_ACCOUNT` | id da conta | 401 `INVALID_CREDENTIALS` |
| conta inativa | `USER_INACTIVE` | id da conta | 403 `USER_INACTIVE` |

A linha: `userId` nulo, `userEmail` nulo, `organizationId` nulo, `entity` `'User'`,
`ip`, e `metadata` com exatamente `{ motivo, contaExistente }`.

### B — fail closed

| operação | com a trilha gravada | com a trilha indisponível |
| --- | --- | --- |
| login (senha certa) | 200 + token | **503, sem token, sem cookie** |
| login (senha errada) | 401 | **503** — idêntico ao caso acima |
| cadastro | 201 + token | **503, sem token, e nenhuma conta criada** |

## 3. ARQUIVOS ALTERADOS

| arquivo | o quê | por quê |
| --- | --- | --- |
| `src/services/auditService.js` | `ACTIONS.LOGIN_FAILED`; `montarEvento` extraído; `registrarObrigatorio`; `registrarComContextoDoAtor` retirado | o evento novo precisa de nome estável; a montagem precisa existir num lugar só para não divergir; a auditoria obrigatória é o mecanismo do fail closed; o ajudante anterior ficou **sem nenhum uso** depois que o obrigatório absorveu o papel — deixá-lo seria código morto num caminho de segurança |
| `src/services/authService.js` | `registrarTentativaRecusada`; as três recusas de login auditadas; login e cadastro usando a auditoria obrigatória; cadastro dentro de uma transação; `tentarCriarPerfil` com ponto de retorno | são as duas decisões. O ponto de retorno é **estritamente necessário**: o laço que descobre o handle livre tenta gravar e trata a violação de unicidade, e dentro de uma transação o primeiro erro abortaria tudo (25P02), derrubando o cadastro de quem tem prefixo de e-mail repetido |
| `tests/autenticacao-fail-closed.test.mjs` | 18 testes novos | §5 |
| `scripts/qa/mutantes-fail-closed.mjs` | 6 mutantes | §5.2 |
| `scripts/qa/diagnostico-auditoria-autenticacao.mjs` | sondas T1–T8 e `sqlObrigatorio` | a prova pelo HTTP das duas decisões; o executor que falha alto nasceu de um defeito do próprio instrumento (§5.4) |

`prisma/` e `frontend/` **intocados**.

## 4. MIGRATIONS

**Nenhuma migration foi criada, e nenhuma é necessária.** A verificação:

- `AuditLog.action` é `text` (`information_schema.columns`), não enum do banco —
  um nome de ação novo não exige alteração de esquema;
- nenhuma coluna, tabela, índice ou política mudou;
- `git status prisma/` não retorna nada.

O que foi testado em banco limpo, de todo modo: o diagnóstico **cria** o banco,
roda `npx prisma migrate deploy` e semeia a cada execução — duas vezes nesta fase
(antes e depois), ambas com `EXIT=0`. `npm test` faz o mesmo no banco de teste.

## 5. RESULTADOS MENSURADOS

Todos com comando, código de saída real e a separação pedida entre
passou / falhou / ignorado / não executado.

| gate | comando | exit | resultado |
| --- | --- | --- | --- |
| Diagnóstico ANTES | `node scripts/qa/diagnostico-auditoria-autenticacao.mjs` | **0** | 17 verificações, veredito "CORRIGIDO E SEM AFROUXAMENTO" |
| Suíte nova | `npx vitest run tests/autenticacao-fail-closed.test.mjs` | **0** | **18 passaram**, 0 falharam, 0 ignorados |
| Suíte da fase anterior | `npx vitest run tests/auditoria-de-autenticacao.test.mjs` | **0** | **17 passaram**, 0 falharam, 0 ignorados |
| Mutação | `node scripts/qa/mutantes-fail-closed.mjs` | **0** | **4/4 mortos** entre os não equivalentes, 6/6 conforme a expectativa, controle antes e depois verdes |
| Diagnóstico DEPOIS | `node scripts/qa/diagnostico-auditoria-autenticacao.mjs` | **0** | **26 verificações**, todas conforme; T1–T8 provam as duas decisões pelo HTTP |
| Regressão backend | `npm test` | **0** | **2173 passaram**, 0 falharam, **15 ignorados** condicionalmente (131 arquivos: 130 passaram, 1 ignorado) |
| Suíte frontend | `npx vitest run` em `frontend/` | **0** | **672 passaram** em 60 arquivos, 0 falharam, 0 ignorados (frontend intocado nesta fase; rodada como rede de segurança) |
| Build frontend | `npm run build` em `frontend/` | **0** | construído |
| ESLint (o equivalente a typecheck neste projeto) | `npm run lint` | **0** | limpo |

Crescimento da suíte de backend: de **130 arquivos / 2155 testes** (fase
anterior) para **131 / 2173** — exatamente o arquivo novo e os 18 testes dele.
Os 15 ignorados são condicionais e já estavam assim antes desta fase: **nenhum
teste foi removido, desativado ou marcado como pendente**.

**Nada foi reportado como aprovado sem execução.** Não há gate "não executado"
nesta fase.

### 5.1 O que cada exigência de teste virou

| exigência (FASE 3 da tarefa) | teste |
| --- | --- |
| A. login válido + trilha → normal | "cadastro normal segue devolvendo 201, token e trilha"; suíte anterior, "a entrada devolve token utilizável" |
| A. trilha falha → nenhuma sessão, resposta sem detalhe interno | "login com credencial VÁLIDA não emite token quando a trilha não persiste" |
| A. provar ausência de sessão, não só o status | o mesmo teste: corpo sem `token` e sem `user`, sem `Set-Cookie`, **e** `GET /auth/me` com o que veio devolve 401 |
| B. senha incorreta → evento persistido | "senha errada em conta existente grava LOGIN_FAILED com o mínimo necessário" |
| B. conta inexistente → sem enumeração | "conta inexistente responde IGUAL e grava o evento sem identificar ninguém" |
| B. banco/RLS indisponível ao gravar a falha | "com a trilha indisponível, senha certa e senha errada respondem IGUAL" |
| B. nenhum segredo em banco, log, resposta ou metadado | "nenhum segredo entra na trilha, no metadado ou na resposta" — procura a senha tentada, a senha válida, hash bcrypt e as palavras proibidas |
| B. cliente não atribui a falha a outro | "o cliente não consegue atribuir a falha a outro usuário, organização ou papel" |
| C. cadastro válido + trilha | "cadastro normal segue devolvendo 201, token e trilha" |
| C. trilha falha → nenhuma sessão nem sucesso | "cadastro não deixa conta nem sessão quando a trilha não persiste" |
| C. rollback sem apagar contas preexistentes | "o cadastro recusado não toca as contas que já existiam" |
| C. repetição e corrida | "nenhuma conta existe sem o seu evento de cadastro — nem sob repetição simultânea" |
| D. sondas P1/P3/P5 e leitura/append-only | quatro testes do bloco D, mais os da suíte anterior |
| D. texto das políticas, RLS e FORCE | "as políticas de AuditLog continuam duas, restritivas, e a tabela segue FORÇADA" |
| D. ausência de função privilegiada nova | "nenhuma função privilegiada nova apareceu para escrever na trilha" |
| E. instância real do app | o gatilho age no **banco**, então vale para qualquer instância; e as respostas medidas vêm da rota, via supertest |

### 5.2 Mutação — os testes prendem as decisões

| mutante | veredito | testes que reprovaram |
| --- | --- | --- |
| FC-M1 — a gravação da tentativa recusada desaparece | **MORREU** | 6 |
| FC-M2 — a auditoria obrigatória volta a engolir a falha | **MORREU** | 4 |
| FC-M3 — login usa a auditoria tolerante | **MORREU** | 6 |
| FC-M4 — cadastro usa a auditoria tolerante | **MORREU** | 6 |
| FC-M5 — token criado antes da auditoria | SOBREVIVEU (declarado equivalente) | — |
| FC-M6 — a conferência `count !== 1` cai | SOBREVIVEU (declarado equivalente) | — |

Os dois sobreviventes estão **declarados equivalentes no próprio script**, com a
razão escrita, porque o que eles ensinam importa:

- **FC-M5** mostra que o fail closed **não depende da ordem** das duas linhas:
  criar o objeto antes não emite nada, porque a exceção sobe antes do `return`.
  Quem for mexer nessa ordem no futuro precisa saber que a garantia está na
  exceção, não na posição;
- **FC-M6** mostra que a conferência de contagem defende um caso que nenhum teste
  consegue produzir sem adulterar o banco: o banco **aceitar** o comando e gravar
  zero linha. Com o gatilho, o INSERT levanta exceção, e a exceção sobe com ou sem
  a conferência. Ela fica como defesa em profundidade, não como linha morta.

### 5.3 Diagnóstico — as oito sondas novas, pelo HTTP

| sonda | resultado medido |
| --- | --- |
| T1 | senha errada responde 401 e a trilha vai de 0 para 1 linha `LOGIN_FAILED` |
| T2 | nenhuma linha de tentativa recusada tem `userId` — zero atribuições |
| T3 | conta inexistente responde **igual** à senha errada (401 vs 401, corpos idênticos) |
| T4 | nenhum e-mail em linha de `LOGIN_FAILED` |
| T4b | a indisponibilidade foi **realmente** simulada (1 gatilho ativo) |
| T5 | com a trilha indisponível, login responde **503** e **token=nenhum** |
| T6 | senha certa e errada respondem **503 vs 503**, corpos idênticos — sem oráculo |
| T7 | cadastro responde 503 e **contas com o e-mail = 0** |
| T8 | com a trilha de volta, login volta a 200 — o fechamento não é permanente |

### 5.4 Dois defeitos do próprio instrumento, medidos e corrigidos

Registrados porque um instrumento que erra conclui contra o produto:

1. **O gatilho não estava sendo criado.** O corpo da função ia em dólar-quoting
   (`$fn$ … $fn$`) e o comando passava pelo shell, que **expandiu `$fn`** para
   vazio. A função nunca nasceu, o gatilho nunca existiu, e T5/T6/T7 reportaram
   "NÃO" — acusando o produto de não fechar a porta que ele fechava. Corrigido com
   corpo entre apóstrofos, um executor que **estoura** em vez de seguir, e a sonda
   T4b, que confere que a simulação existe antes de concluir qualquer coisa a
   partir dela.
2. **A primeira versão de `registrarObrigatorio` quebrou todo cadastro.** Ela só
   abria contexto de ator quando não havia transação — regra copiada do ajudante
   anterior. Mas o cadastro atômico abre a transação com ator **vazio**, então a
   auditoria caía nela sem definir o ator, a política recusava, e **todo cadastro
   passou a responder 503**. Encontrado pela suíte existente no primeiro comando
   depois da mudança. Corrigido: o ator do evento manda no contexto, e
   `withUserContext` já sabe reaproveitar a transação em curso.

## 6. EVIDÊNCIAS DE QUE NENHUMA SESSÃO É EMITIDA QUANDO A AUDITORIA FALHA

Quatro provas, de naturezas diferentes:

1. **pelo HTTP, com falha real de banco** (diagnóstico T5 e T7): `HTTP 503`,
   `token=nenhum`, `contas com esse e-mail=0`;
2. **pela rota, no teste** ("login com credencial VÁLIDA não emite token…"):
   `body.token` ausente, `body.user` ausente, nenhum `Set-Cookie`, e o que veio na
   resposta **não abre** `GET /auth/me` — 401. Como a sessão desta plataforma **é**
   o token (não há sessão de servidor a invalidar), a ausência de credencial
   utilizável é a prova completa;
3. **pelo banco** ("cadastro não deixa conta nem sessão…"): `User` com aquele
   e-mail é nulo e nenhum `SocialProfile` foi criado — a transação voltou atrás
   inteira, e nada foi apagado por compensação porque nada chegou a existir;
4. **por mutação**: tolerar a falha (FC-M2, FC-M3, FC-M4) faz 4 a 6 testes
   reprovarem. A garantia é medida, não afirmada.

## 7. EVIDÊNCIAS DE QUE RLS E FORCE PERMANECEM RESTRITIVOS

| prova | resultado |
| --- | --- |
| `prisma/` intocado | nenhuma migration, nenhum `CREATE POLICY`, nenhum `ALTER TABLE` |
| Sondas do diagnóstico, depois da mudança | P1 RECUSADO, P3 RECUSADO, P5 RECUSADO, P7 IMPOSSÍVEL, P8 IMPOSSÍVEL |
| `AuditLog` | RLS ligado **e forçado** (`relrowsecurity/relforcerowsecurity = true/true`) |
| Texto das políticas (teste) | exatamente duas — `auditoria_escrita` (INSERT) e `auditoria_leitura` (SELECT); nenhuma de UPDATE ou DELETE; cláusula `mci_current_user_id()` intacta |
| Porta larga | `WITH CHECK` da escrita **não** é `true`; `USING` da leitura **não** é `true` (afirmado por teste) |
| Função privilegiada | nenhuma `SECURITY DEFINER` em `public` com prefixo `mci` (afirmado por teste) |
| Escrita anônima | continua recusada para linha **atribuída** a alguém (teste "anônimo continua sem conseguir gravar linha ATRIBUÍDA a alguém") |

Sobre a linha de `userId` nulo, para que não fique dúvida: a política **sempre**
aceitou esse caso — medido como P4 antes desta fase. O que mudou é que agora
existe um caminho do servidor que a usa. Nenhuma rota permite ao cliente escolher
ação, entidade, ator, organização ou metadado: os seis campos da linha são
escolhidos pelo servidor, e o teste de forja prova que campos inventados no corpo
do pedido não chegam à trilha.

## 8. LIMITAÇÕES, RISCOS RESIDUAIS E RECUPERAÇÃO

1. **Tentativa barrada pelo teto de requisições não é auditada.** O `rateLimit`
   responde 429 **antes** de o serviço rodar, então a 11ª tentativa no mesmo
   quarto de hora não deixa linha. Consequência prática: uma varredura aparece na
   trilha até o teto e depois só no log do limitador. Alterar isso significa
   auditar dentro do middleware — fora do escopo aprovado, e com o efeito colateral
   de transformar um ataque de volume em escrita de volume no banco.
2. **Fail closed é indisponibilidade por desenho.** Com a trilha inacessível,
   **ninguém entra e ninguém se cadastra** — inclusive administradores. É a
   decisão aprovada, e o efeito operacional precisa estar claro: a auditoria passou
   a ser dependência dura da autenticação. Mitigação existente: `GET /ready` já
   reprova quando o banco está inalcançável, e `GET /audit/integrity` mostra
   falhas de trilha para quem tem `audit.read`.
3. **Plano de recuperação de falha de auditoria**, na ordem: (a) `GET /ready` diz
   se banco e RLS estão de pé; (b) `GET /audit/integrity` diz quantas gravações
   falharam nesta instância e qual foi a última — ação, entidade, código e
   instante; (c) o log da aplicação traz a causa real com o código do PostgreSQL;
   (d) causas prováveis, em ordem de probabilidade: banco inalcançável, política de
   `AuditLog` alterada, papel do banco sem `INSERT` na tabela, disco cheio; (e)
   restabelecida a escrita, a autenticação volta **sozinha** — T8 mede isso, e
   nenhum estado precisa ser limpo à mão.
4. **Uma transação por cadastro.** O cadastro passou de três escritas soltas para
   uma transação curta (usuário, perfil, auditoria). O `bcrypt.hash` e o
   `createToken` ficaram **fora** dela de propósito. Custo medido irrelevante nos
   tempos da suíte, mas é uma conexão do pool retida por alguns milissegundos a
   mais por cadastro.
5. **Os eventos já perdidos não voltam**, e tentativas recusadas anteriores a esta
   fase não existem. Fabricá-las seria falsificar a trilha.
6. **Fluxos de autenticação inventariados**, para que a ausência seja explícita e
   não presumida: **não existe** recuperação de senha, **não existe** MFA, **não
   existe** sessão de servidor ou cookie de autenticação nesta plataforma. Os
   caminhos de autenticação são `POST /auth/register`, `POST /auth/login`,
   `GET /auth/me` e `POST /profile/password` (troca de senha autenticada). Os dois
   primeiros são os desta fase; `auth/me` é leitura; **`POST /profile/password`
   não audita nada até hoje** — é um achado, está fora do escopo aprovado, e fica
   registrado como pendência (§9).
7. **`LOGIN_FAILED` é legível só por administrador de plataforma.** Quem opera uma
   federação não vê tentativas contra contas dela. Foi decisão de manter a política
   de leitura como estava; se a administração quiser dar essa visão a operadores,
   é mudança de política e pede aprovação própria.

## 9. PENDÊNCIA REGISTRADA (FORA DO ESCOPO DESTA FASE)

**`POST /profile/password` — troca de senha autenticada — não deixa trilha.**
`authService.changePassword` confere a senha atual, grava o novo hash e devolve
`{ success: true }`, sem auditoria. Não é o defeito desta fase (não é rota de
autenticação nem sofre do contexto ausente: ela roda autenticada, com contexto de
RLS), mas é evento de credencial sem rastro. Recomendado como tarefa própria, com
a mesma auditoria obrigatória — e, se a administração quiser, com fail closed
igual.

## 10. RAMO E COMMITS

- Ramo: `claude/mci-platform-muscle-contest-o6haz9`
- HEAD antes desta fase: `59483ca`
- Commits preservados, sem reescrita: `8906cff`, `8536d29`, `95979aa`, `df66f83`,
  `9256c86`, `59483ca`
- Commit desta fase: **COMMIT_DESTA_FASE**

**Nada foi publicado:** sem `push`, sem PR, sem merge, sem release, sem deploy.
Nenhuma migration aplicada em produção — não existe migration nesta fase. Nenhum
dado real tocado: todo o trabalho rodou em bancos locais criados e destruídos
pelos próprios instrumentos, com dados sintéticos. Nenhuma credencial de produção
foi acessada, e nenhum valor sensível de ambiente aparece neste relatório.

## 11. VEREDITO

**PASS.**

Os seis gates de encerramento foram conferidos um a um, com evidência:

| gate | evidência |
| --- | --- |
| auditoria de login falhado persistida, mínima e sem segredos | T1/T2/T4 do diagnóstico; 5 testes do bloco A, incluindo a varredura por senha, hash e palavras proibidas |
| login e cadastro não emitem sessão quando a auditoria obrigatória falha | T5/T6/T7; 3 testes do bloco B do login e 3 do cadastro; `GET /auth/me` recusa o que veio na resposta; nenhuma conta criada |
| testes provam comportamento real na rota e em banco isolado | supertest contra a rota, falha forçada por gatilho **no banco**, e diagnóstico em banco próprio criado por `migrate deploy` |
| RLS e FORCE não enfraquecidos | `prisma/` intocado; P1/P3/P5/P7/P8 medidos restritivos; texto das políticas afirmado por teste; nenhuma `SECURITY DEFINER` nova |
| regressão pertinente passou, com resultado capturado | backend 2173/0/15 (`EXIT=0`), frontend 672/0/0 (`EXIT=0`), build e ESLint limpos, mutação 4/4 |
| nenhuma alteração não relacionada, nenhum arquivo temporário | diff em 3 arquivos de código mais 3 novos; `prisma/` e `frontend/` intocados; nenhum `.bak`/`.mutante`; nenhum gatilho de teste sobrando no banco |

**As duas ressalvas que acompanham o PASS** são limitações documentadas, e não
gates descumpridos:

1. **tentativa barrada pelo teto de requisições não entra na trilha** (§8.1) — o
   429 acontece antes do serviço. A decisão A pedia auditar as falhas "que possam
   ser registradas com segurança", e auditar dentro do limitador transformaria
   ataque de volume em escrita de volume. Fica para decisão própria;
2. **fail closed é indisponibilidade por desenho** (§8.2) — com a trilha
   inacessível ninguém entra, administradores inclusive. É o efeito pedido, e o
   plano de recuperação está na §8.3.

E uma pendência **fora do escopo aprovado**, registrada para não se perder:
`POST /profile/password` troca a senha sem deixar trilha (§9).

Aguardando decisão expressa. Nada publicado.

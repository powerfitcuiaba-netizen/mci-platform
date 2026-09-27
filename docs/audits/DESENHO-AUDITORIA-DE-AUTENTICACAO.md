# DESENHO — A TRILHA DE AUTENTICAÇÃO VOLTA A SER GRAVADA

Documento de decisão. Escrito **antes** da implementação, como a tarefa exige, e
mantido depois dela para que a escolha possa ser contestada com o mesmo material
com que foi feita.

## 1. A CAUSA-RAIZ, MEDIDA

Instrumento: `scripts/qa/diagnostico-auditoria-autenticacao.mjs`, em banco
isolado, com dados sintéticos. As 17 verificações estão na §2 do relatório.

O que a medição mostrou:

| id | fato medido |
| --- | --- |
| H1/H3 | `POST /auth/register` responde 201 e `POST /auth/login` responde 200 |
| H2/H4 | **nenhuma linha** de `USER_REGISTER` nem de `LOGIN` fica na trilha |
| H5 | a recusa existe e aparece no log do servidor |
| H6 | **não aparece para quem chama a API**: o cliente recebe 200 |
| H7 | CONTROLE — uma ação **autenticada** audita normalmente |
| P1 | `INSERT` com `userId` e **sem** contexto de RLS é **recusado** |
| P2 | o **mesmo** `INSERT` com o contexto do próprio ator é **aceito** |

A cadeia é esta, e cada elo foi conferido no código:

1. `src/utils/asyncHandler.js` só abre transação com contexto quando existe
   `req.user`. Em `/auth/login` e `/auth/register` não existe — por construção,
   porque é justamente aí que a identidade está sendo estabelecida.
2. Sem transação, `src/config/prisma.js` roteia para o cliente base, onde
   `mci.user_id` nunca foi definido.
3. `mci_current_user_id()` é `NULLIF(current_setting('mci.user_id', true), '')` —
   devolve **NULL**.
4. A política `auditoria_escrita` exige
   `"userId" IS NOT DISTINCT FROM mci_current_user_id()`. A linha carrega o id do
   usuário que acabou de entrar; a sessão carrega NULL. A comparação reprova e o
   `INSERT` volta 42501.
5. `auditService.record` trata a recusa (SAVEPOINT fora de transação não é
   preciso; o `try/catch` basta), **a autenticação segue** e o evento se perde.
   Só o log sabe.

**A política não está errada.** As três garantias que ela existe para dar
continuam valendo e foram medidas: ninguém assina no lugar de outro (P3), ninguém
escreve na trilha de federação alheia (P5), e a trilha não se adultera nem se
apaga — nem por administrador de plataforma (P7, P8).

O que está errado é o **caminho de autenticação escrever na trilha sem o contexto
de quem ele mesmo acabou de identificar**.

## 2. INVENTÁRIO DOS EVENTOS PRÉ-AUTENTICAÇÃO

Levantado por enumeração das rotas, e não por amostragem: das rotas servidas,
apenas **oito** dispensam autenticação — `POST /auth/register`,
`POST /auth/login` e seis `GET /public/*`.

| caminho | escreve auditoria? | tem o defeito? |
| --- | --- | --- |
| `POST /auth/register` | sim — `USER_REGISTER` | **SIM** |
| `POST /auth/login` | sim — `LOGIN` | **SIM** |
| `GET /public/*` (6 rotas) | não — `publicService` não audita | não se aplica |
| rotas `optionalAuth` com visitante | `userId` nulo, organização nula → a política aceita | não |
| rotas `optionalAuth` autenticadas | `asyncHandler` abre contexto | não |
| scripts de linha de comando | já usam `withUserContext` (ex.: `scripts/provisionar-contas-de-servico.js:302`) | não |

Ou seja: o conjunto afetado é exatamente `LOGIN` e `USER_REGISTER` — os dois que
a medição encontrou, e nenhum outro. A conta fecha com o QA visual: 11 `LOGIN` e
6 `USER_REGISTER`, nada mais.

### Dados disponíveis em cada fase

| fase | ator | origem | tenant | correlação |
| --- | --- | --- | --- | --- |
| antes de validar a credencial | desconhecido | IP do pedido | desconhecido | nenhuma |
| credencial validada (login) | **o usuário, resolvido no banco** | IP | nenhum (ação de plataforma) | id do usuário |
| usuário criado (cadastro) | **o usuário recém-criado** | IP | nenhum | id do usuário |

O ator sempre vem do **servidor** — do registro lido depois de conferir a senha,
ou da linha que ele acabou de criar. Em nenhuma das duas fases o cliente informa
quem é.

## 3. A ALTERNATIVA ESCOLHIDA

> **Dar ao registro do evento o contexto de RLS do ator que a própria
> autenticação acabou de estabelecer.**

Depois de conferir a senha (ou de criar o usuário), o servidor SABE quem é o
ator. A escrita da auditoria passa a acontecer dentro de
`withUserContext(actor.id, …)` — o mesmo mecanismo que toda requisição
autenticada já usa. A política então encontra `userId = mci_current_user_id()` e
aceita, **sem uma linha de RLS alterada**.

O ponto de entrada é um só, em `auditService`:
`registrarComContextoDoAtor({ actor, … })`. Um lugar só porque a próxima pessoa a
adicionar um evento pré-autenticação (recuperação de senha, segundo fator) vai
precisar da mesma coisa, e a explicação tem de estar onde ela vai olhar.

### Como cada exigência da tarefa é cumprida

| exigência | como |
| --- | --- |
| Preservar RLS e FORCE RLS | **nenhuma política muda**. Não há migration de RLS nesta correção |
| Anônimo não grava evento arbitrário | sem credencial válida não há ator, sem ator não há contexto, e a política recusa — exatamente como hoje (P1) |
| Não forjar `userId` | o id vem do registro conferido no banco, nunca do corpo do pedido; e a política ainda exige que a linha e a sessão coincidam (P3) |
| Não forjar organização ou papel | o evento de autenticação é de plataforma: `organizationId` nulo. A garantia (b) segue medida (P5) |
| Não expor segredo | o evento grava id, e-mail da conta, ação, entidade e IP. Senha e token nunca chegam a `record`; `sanitize` já remove chave proibida de `metadata` |
| Atribuição e origem confiáveis | `userId` + `userEmail` + `ip`, todos resolvidos no servidor |
| Transação | a escrita abre a própria transação curta, separada da autenticação: se ela falhar, o login já aconteceu e continua válido |
| Falha de rede e repetição | evento de auditoria é **fato**, não estado: duas entradas geram duas linhas, e é o registro correto de duas entradas. Não há idempotência a impor — nem chave para isso |
| Perda silenciosa | passa a haver contador de falhas no processo e rota de integridade para quem tem `audit.read` (§5) |
| Login e cadastro continuam funcionando | o contrato não muda: mesmos códigos, mesmos corpos, mesma latência fora de falha |
| Cliente não escolhe o tipo de evento | conferido: nenhuma rota aceita `action` de entrada. O único `action` em schema é **filtro de leitura** da trilha (`auditQuery`) |

## 4. AS ALTERNATIVAS REJEITADAS

### R1 — Política permissiva para eventos de autenticação

`WITH CHECK` extra aceitando `action IN ('LOGIN','USER_REGISTER')` quando não há
contexto.

**Rejeitada.** Seria uma porta para escrever a trilha **sem ator**: qualquer
caminho que alcançasse um `INSERT` poderia gravar "o usuário X entrou" com o
`userId` que quisesse. Destrói a garantia (a), que é a razão pela qual a política
de 20260921000000 nasceu. Troca uma perda de trilha por uma trilha que mente — e
trilha que mente é pior que trilha que falta, porque ninguém desconfia dela.

### R2 — Função `SECURITY DEFINER` para gravar o evento

**Rejeitada, e a tarefa já a desaconselhava.** Uma função privilegiada que
escreve na trilha é um primitivo de forja de auditoria, a menos que reimplemente
dentro dela todas as conferências que a política faz — e aí é a mesma regra
escrita duas vezes, em duas linguagens, com uma cópia destinada a divergir. Além
disso, a arquitetura deste projeto proíbe explicitamente `SECURITY DEFINER`
privilegiado usado para escapar do RLS.

### R3 — Gravar o evento com `userId` nulo e a identidade em `metadata`

A política aceitaria (NULL contra NULL, medido em P4).

**Rejeitada.** Joga a atribuição — a coisa que a trilha existe para ter — de uma
coluna conferida pelo banco para um JSON que o banco não confere. A consulta
"quem entrou nesta conta" deixaria de existir; `auditoria_leitura` continuaria
restrita a administrador de plataforma, então nem o ganho de visibilidade
apareceria. Perder a coluna para ganhar a linha é troca ruim.

### R4 — Tabela separada, com política própria, para eventos de autenticação

**Rejeitada.** Parte a trilha em duas, duplica a política de leitura e cria uma
segunda superfície para manter em sincronia — para resolver um problema que não é
de modelagem, e sim de contexto ausente. Só se justificaria se o evento de
autenticação precisasse de regra de acesso diferente, e ele não precisa.

### R5 — Abrir contexto no `asyncHandler` para rota não autenticada

**Rejeitada por impossibilidade.** Na entrada do handler o ator ainda não existe:
é dentro dele que a senha é conferida. Qualquer ator estabelecido antes disso
viria do cliente, que é precisamente o que `asyncHandler` documenta não fazer.

### R6 — Recusar o login quando a auditoria falha (fail closed)

> **APROVADA E IMPLEMENTADA depois**, numa fase própria. Ver
> `docs/audits/RELATORIO-AUDITORIA-DE-AUTENTICACAO-FASE-2.md`. O texto abaixo é o
> da decisão original desta fase, preservado para que a mudança de posição fique
> visível em vez de reescrita.

**Não implementada nesta fase, e registrada como decisão da administração.** Tem mérito de
segurança: sem trilha, sem entrada. Mas muda a disponibilidade do sistema — uma
falha de banco na escrita da trilha passaria a impedir qualquer login — e a tarefa
pede explicitamente preservar o funcionamento legítimo do login. Com a correção,
o único cenário de falha que resta é indisponibilidade de banco, que já derruba a
autenticação de todo modo. Fica proposto, não decidido por quem programa.

### R7 — Auditar tentativa de login FALHADA

> **APROVADA E IMPLEMENTADA depois**, na mesma fase de R6. A dúvida levantada
> abaixo — gravar o e-mail tentado — foi resolvida **não gravando o e-mail**: a
> linha carrega a conta alvo por identificador interno e, quando não há conta, não
> carrega identificação nenhuma. Ver
> `docs/audits/RELATORIO-AUDITORIA-DE-AUTENTICACAO-FASE-2.md` §1.1.

**Não implementada nesta fase, e recomendada como tarefa própria.** Hoje credencial inválida
não deixa rastro nenhum, e isso vale registrar. Mas é decisão com dois lados:
gravar o e-mail tentado significa gravar dado de quem talvez não seja usuário, e o
volume de um ataque de força bruta iria direto para a trilha. Exige regra de
retenção e limite — coisa de decisão, não de conserto.

## 5. DETECÇÃO — A FALHA NÃO PODE VOLTAR A SER SILENCIOSA

O defeito passou meses sem ser notado por um motivo simples: **nada além do log
sabia dele**. O log só é lido quando alguém já desconfia.

Três camadas, nesta correção:

1. **Contador no processo.** `auditService` passa a contar as falhas e a guardar
   um resumo da última — ação, entidade, código do erro e instante. Sem
   `metadata`, sem e-mail, sem nada que possa ser segredo ou dado pessoal.
2. **Superfície de leitura.** `GET /audit/integrity`, com `requireAuth` e a
   permissão `audit.read` que já existe — quem pode ler a trilha pode ver a saúde
   dela. Nenhuma permissão nova é criada, e a rota é somente leitura.
3. **Teste que reprova.** A suíte passa a afirmar que login e cadastro deixam
   evento, e que o contador fica em zero no caminho feliz. Um retrocesso quebra o
   gate em vez de sumir no log.

## 6. O QUE ESTA CORREÇÃO NÃO FAZ

> **Nota da fase seguinte:** a lista abaixo continua verdadeira para ESTA
> correção. A fase 2 (tentativa recusada na trilha + fail closed) também não
> alterou política, não criou função privilegiada e não criou migration — e
> tampouco recuperou eventos perdidos. O único item que ela mudou é o último: o
> contrato de `/auth/login` e `/auth/register` passou a poder responder
> indisponibilidade quando a trilha não persiste, que é a decisão aprovada.

- não altera política de RLS, nem `FORCE ROW LEVEL SECURITY`;
- não cria função privilegiada nem `SECURITY DEFINER`;
- não apaga, reescreve nem migra histórico de auditoria;
- não cria permissão nova;
- não muda contrato de `/auth/login` nem de `/auth/register`;
- não recupera os eventos já perdidos — eles não existem, e inventá-los seria
  falsificar a trilha.

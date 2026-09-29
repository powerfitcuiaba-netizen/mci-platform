# Correção F-04 — a federação passa a ter como autorizar a atuação do treinador

**Para:** Helder Falcão · **Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Data:** 2026-09-27 · **Origem:** passo **F4** da homologação manual do Perfil 3

---

## 1. O que estava errado

Na homologação manual do administrador de federação, o passo F4 reprovou: **o diretor não
conseguia autorizar treinador nenhum pela interface**.

A causa não era de autorização. Medido, separando os dois lados com chamadas diretas às rotas
reais, com a sessão do diretor:

| Rota | Resultado | Leitura |
| --- | --- | --- |
| `GET /coaches/review` | **403** | correto — analisar cadastro é da mesa central (R-03) |
| `POST /coaches/:id/organizations` | **200** | correto — autorizar atuação é da federação (R-04) |

O servidor estava certo nos dois casos. O problema era que **o único botão "Autorizar" da
interface vivia dentro da tabela da fila de análise**, e essa tabela só se preenche com
`GET /coaches/review`. Sem lista, não havia linha; sem linha, não havia botão. A tela do
diretor era composta de duas caixas de recusa e nada mais.

Na mesma tela aparecia ainda o botão **"Conceder delegação"**, que a API sempre recusaria:
delegação central é R-02 e exige `central.grant`, que o diretor não tem.

**A separação R-03 / R-04 estava correta no servidor e ausente na tela.**

---

## 2. O que foi feito

### 2.1 Uma rota de leitura própria da federação

`GET /coaches/authorizable?organizationId=<id>`

* **Escopo obrigatório.** `organizationId` é exigido pelo schema. Não é detalhe de validação:
  é o escopo contra o qual a rota (`perm('coaches.authorize_org', orgDaQuery)`) e o serviço
  (`assertCan`) conferem a permissão. Com escopo nulo, `effectivePermissions` soma as
  permissões de **todas** as federações do ator — exatamente o buraco que A-02 fechou na
  delegação central. Escopo ausente aqui seria escopo ausente lá.
* **Só cadastro APROVADO.** Quem está em análise, recusado, suspenso ou encerrado não aparece.
  A federação não descobre por esta rota o estado cadastral de ninguém — R-03 intacta.
* **Projeção mínima:** `id`, `name`, `registration`, `city`, `state` e `authorization`, onde
  `authorization` é a situação **daquela** federação (`status`, `grantedAt`, `revokedAt`) ou
  `null`. O diretor não fica sabendo onde mais o treinador atua.
* **`registration` entra** porque é a credencial profissional que a federação confere antes de
  autorizar — é o dado da decisão. `email`, `phone`, `bio`, `userId`, `rejectionReason`,
  `suspendedReason`, `reviewedById` e `reviewedAt` **não entram**.
* **Sem migration.** A RLS existente já resolve: `coach_org_leitura` permite ao operador da
  federação ler as linhas de `CoachOrganization` da própria organização
  (`mci_operator_of("organizationId")`). Nada de política nova, nada de `BYPASSRLS`, nada de
  `SECURITY DEFINER`.

### 2.2 A seção na tela

**Atuação na sua federação**, visível para quem tem `coaches.authorize_org`. Lista os
treinadores aprovados com nome, registro, cidade/estado e a situação **nesta** federação, e
oferece **Autorizar** ou **Revogar atuação** conforme o estado.

* **Autorizar** reaproveita `POST /coaches/:id/organizations`, que já existia e já recusa
  cadastro não aprovado com `422 COACH_NOT_APPROVED`. O diálogo recebe a federação **fixa** —
  a que está sendo olhada — e por isso não oferece seletor de outra. Não existe, em lugar
  nenhum, opção de autorizar "em todas as federações".
* **Revogar** reaproveita `POST /coaches/:id/organizations/revoke` e exige motivo, que vai
  para a trilha de auditoria junto de quem revogou.

### 2.3 As seções passam a respeitar a permissão efetiva

`AdminTreinadores` agora calcula `coaches.approve`, `coaches.authorize_org` e `central.grant`
a partir dos papéis da conta e **omite** a seção que a conta não pode usar. A mesa central
continua vendo as três.

Isto é **conveniência, não barreira**: quem decide continua sendo o servidor, em `perm(...)` na
rota e `assertCan(...)` no serviço. O frontend nunca é autoridade de privilégio. O que muda é
que a tela deixa de oferecer ação que seria recusada — e deixa de pedir dado que viria 403.

---

## 3. Arquivos alterados

| Arquivo | O que mudou |
| --- | --- |
| `src/utils/schemas.js` | `coachAuthorizableQuery` — `organizationId` obrigatório |
| `src/services/coachService.js` | `listarParaAutorizacao` + `SELECT_PARA_AUTORIZACAO` |
| `src/controllers/index.js` | `coaches.listarParaAutorizacao` |
| `src/routes/index.js` | `GET /coaches/authorizable` com `perm('coaches.authorize_org', orgDaQuery)` |
| `frontend/src/services/api.js` | `api.coaches.authorizable` |
| `frontend/src/pages/treinadores.jsx` | seção `AtuacaoNaFederacao`, `DialogoDeRevogacaoDeAtuacao`, federação fixa em `DialogoDeAutorizacao`, seções por permissão efetiva |
| `frontend/src/lib/idiomas/{ptBR,en,es}.js` | 11 chaves `atuacaoFederacao.*` nos três idiomas |
| `tests/hardening-auditoria-treinadores.test.mjs` | bloco **F-04**, 9 testes |
| `tests/matriz-de-leitura-treinadores.test.mjs` | a rota nova entra na matriz — 17 rotas × 11 perfis |
| `frontend/src/pages/treinadores.test.jsx` | 4 testes de tela + o ator passa a ser declarado |

**Nenhuma migration. Nenhuma alteração em fórmula de ranking, regra esportiva ou dado real.**

---

## 4. Testes

### 4.1 O bloco F-04 — 9 testes

| Teste | O que prova |
| --- | --- |
| lista e autoriza | o diretor vê o aprovado, autoriza, e a lista reflete na requisição seguinte |
| projeção exata | as chaves são exatamente `authorization, city, id, name, registration, state`; o motivo escrito pela mesa central não atravessa |
| pendente | cadastro em análise **não aparece** e a autorização recusa com `422 COACH_NOT_APPROVED` |
| R-03 | o diretor continua recebendo 403 em `review`, `:id/review`, `approve` e `reject` |
| R-04 | o diretor de A recebe 403 ao listar e ao autorizar em B; o diretor de B segue intacto |
| escopo | sem `organizationId` a rota nunca responde 200 |
| sem permissão | conta comum, treinador e atleta recusados; sem sessão é 401, não 403 |
| mesa central | todos os poderes dela continuam — inclusive ler a lista da federação |
| revogação | exige motivo, tem efeito na requisição seguinte, e o motivo fica na trilha |

### 4.2 Resultado medido dos gates

| Gate | Resultado |
| --- | --- |
| `hardening-auditoria-treinadores` (36 + 9 do F-04) | **45/45 PASS** |
| Matriz de leitura, gate de rota e suíte do módulo | **227/227 PASS** |
| **Regressão completa do backend** | **PASS — 2419 testes, 133 arquivos, 0 falhas, 1564 s** |
| Regressão do frontend | **PASS — 680/680, 60 arquivos** |
| Lint e build | **PASS** |

O total do backend subiu de 2219 para 2419, e a diferença fecha exatamente: **+180** da matriz
de leitura (que entrou depois daquela medição), **+9** do bloco F-04 e **+11** das células da
rota nova na matriz, uma por perfil.

### 4.3 A matriz de leitura aprendeu a rota nova

A rota entrou na matriz por perfil. Isso importa por um motivo já pago caro: **os achados A-01
e A-13 passaram despercebidos porque a matriz cobria só rotas MUTANTES.** Rota de leitura nova
que não entra na matriz é a próxima A-01.

---

## 5. Relatório de segurança

| Verificação | Resultado |
| --- | --- |
| Escopo obrigatório na rota e no serviço | **sim** — schema, `perm` e `assertCan`, os três |
| Autorização "para todas as federações" | **não existe** — nem na API, nem na tela |
| Autoconcessão | não se aplica: autorizar atuação é ato sobre OUTRA pessoa, e a rota não mudou |
| Cross-tenant | **403** para listar e para autorizar em federação alheia |
| R-03 preservada | **sim** — `coaches.approve` continua fora de `EVENT_DIRECTOR` |
| R-05 preservada | **sim** — a projeção é mínima e conferida chave a chave |
| RLS | **inalterada** — nenhuma policy nova, nenhum `BYPASSRLS`, nenhum `SECURITY DEFINER` |
| Auditoria | **preservada** — `COACH_ORG_AUTHORIZE` e `COACH_ORG_REVOKE` continuam gravando |
| Frontend como autoridade | **não** — a tela esconde por conveniência; a recusa é do servidor |
| Enumeração | a lista traz só aprovados, e os mesmos ids que `GET /coaches` já publica |

**Superfície acrescentada:** uma rota de leitura, com escopo obrigatório, restrita a quem já
podia escrever naquele mesmo escopo. Quem pode autorizar passa a poder ver quem autorizar — e
nada mais.

---

## 6. Revalidação de F1 a F4 no navegador

Executada no ambiente sintético, com a conta de diretor de federação:

| Passo | Observado | Veredito |
| --- | --- | --- |
| **F1** | o item Treinadores aparece no menu do diretor | **APROVA** |
| **F2** | nenhuma ação de aprovar ou não aprovar cadastro | **APROVA** |
| **F3** | a fila de análise e a delegação central **saem da tela** — ausência, e não caixa de recusa | **APROVA** |
| **F4** | a seção *Atuação na sua federação* lista o treinador aprovado com a ação da linha | **APROVA** |
| **F4b** | revogar exige motivo e leva a REVOGADO; autorizar leva a AUTORIZADO; o diálogo **não** oferece outra federação e nomeia a que está em uso | **APROVA** |
| **F4c** | a mesa central continua com as três seções: Cadastros, Atuação na sua federação e Delegação central | **APROVA** |

### Dois ajustes de texto feitos durante a revalidação

1. O botão da linha reusava **"Autorizar em federação"**, rótulo da fila central, onde a
   federação ainda precisa ser escolhida. Na seção da federação ela já está escolhida, e o par
   natural de "Revogar atuação" é **"Autorizar atuação"**. Trocado nos três idiomas, na linha e
   no diálogo.
2. O mesmo rótulo aparecia no botão de confirmação do diálogo quando a federação é fixa.
   Alinhado.

### Um erro do instrumento, declarado

A primeira tentativa do F4b falhou porque **eu** reconstruí o frontend sem `VITE_API_URL`, a
variável que o script de QA injeta — o pacote passou a apontar para outro endereço de API e a
tela abriu sem dados. Não era defeito do produto. Refeito pelo caminho correto.

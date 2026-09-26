# Módulo Treinadores & Equipes

Documentação operacional e de engenharia do módulo. O que está aqui descreve o que
**existe e foi medido**; o que não foi homologado aparece como bloqueio, não como
pendência de implementação.

---

## 1. O que o módulo faz, em uma frase por ator

| Ator | O que ele faz | O que ele **não** faz |
| --- | --- | --- |
| Pessoa qualquer | Cadastra-se como treinador. O cadastro nasce `PENDING`. | Não escolhe o próprio estado, não atua em federação nenhuma antes da aprovação. |
| Administração central (MuscleContest) | Aprova, rejeita, suspende, reativa e encerra cadastro de treinador. Lê a documentação da análise. | Não é ela quem decide em qual federação o treinador atua. |
| Federação (diretor de evento) | Autoriza e revoga a atuação do treinador nela. Indica o treinador responsável por uma equipe. | Não aprova cadastro de treinador — nem o dela. |
| Treinador aprovado e autorizado | Lê o próprio cadastro, as próprias equipes e os atletas vinculados. Localiza atleta por matrícula e **pede** vínculo. | Não vincula, não transfere, não desvincula, não vê documento nem CPF de ninguém. |
| Atleta | **Confirma ou recusa** o convite. É a confirmação dele que cria o vínculo. | Não encerra o próprio vínculo: sair de equipe é decisão central. |
| Administração central com delegação | Transfere, desvincula e aprova vínculo por decisão administrativa. | Nada disso vem por papel: depende de concessão registrada e viva. |

---

## 2. As cinco decisões aprovadas, e onde cada uma vive no código

| Decisão | Enunciado | Onde está | Medida por |
| --- | --- | --- | --- |
| **R-01** | O ponto pertence ao vínculo que existia na **data oficial** do evento. Sem retroatividade automática. | `rankingService.awardForResult` (`vinculoDaEpoca`), `muscleWarService.vinculoDoResultado`, `membershipService.vinculoNaData` | `tests/r01-equipe-da-epoca.test.mjs` |
| **R-02** | Transferência, desvínculo e correção que afetem atribuição de pontos: só `SUPER_ADMIN` ou administrador central **formalmente autorizado**. | `utils/permissions.js` (`PERMISSOES_CENTRAIS_DELEGADAS`), `centralAuthorizationService`, modelo `CentralAuthorization` | `tests/permissoes-delegacao.test.mjs`, `tests/vinculo-equipe.test.mjs` |
| **R-03** | Quem aprova ou rejeita treinador é a administração **central**. | permissão `coaches.approve`, `coachService.TRANSICOES` | `tests/modulo-treinadores-equipes.test.mjs` |
| **R-04** | Cadastro do treinador é **global**, não se duplica por federação, e não concede atuação. | `Coach` sem `organizationId`, modelo `CoachOrganization`, permissão `coaches.authorize_org` | idem |
| **R-05** | O treinador vê dado esportivo, de filiação e de resultado dos atletas vinculados. **Nunca** documento, CPF, financeiro, credencial ou médico. | `coachService.SELECT_ATLETA_ESPORTIVO`, políticas de `CoachDocument` | idem + `frontend/src/pages/treinadores.test.jsx` |

---

## 3. O bloqueio de §8.3 — a fórmula do ranking de treinadores

**A fórmula não está homologada pela MuscleContest.** Por isso:

- `GET /ranking/coaches` responde **409 `COACH_RANKING_NOT_HOMOLOGATED`**, com a
  mensagem dizendo que o bloqueio é de homologação e não de implementação. Um 404
  diria "esta rota não existe", que é outra coisa.
- `GET /coaches/:id/ranking/projection` devolve as equipes do treinador com os totais
  que o **ranking de equipes já publica**, `homologado: false`, o aviso
  "Ranking em homologação", e `totalDoTreinador: null` / `posicao: null` — os dois
  campos existem e são nulos de propósito, para que nenhum cliente futuro os procure
  e encontre `undefined`.
- `GET /coaches/:id/ranking/eligibility` devolve a **contagem** de lançamentos
  elegíveis por equipe. Contagem é fato; pontuação de treinador seria fórmula.

**Por que somar os totais das equipes não é neutro.** Somar pressupõe quatro decisões
esportivas que ninguém tomou: que cada equipe entra com peso 1; que todas as
categorias entram; que equipe de um atleta vale o mesmo que equipe de trinta; e que o
treinador de duas equipes concorre com o de uma somando as duas. Está escrito em
`src/services/coachRankingService.js`, junto da constante `FORMULA_HOMOLOGADA`, que é
o único ponto a mudar quando a homologação sair.

---

## 4. Modelo de dados

Duas migrations, ambas **aditivas**:

### `20260926020000_modulo_treinadores_equipes`

| Objeto | Papel |
| --- | --- |
| `CoachStatus` | `PENDING`, `APPROVED`, `REJECTED`, `SUSPENDED`, `CANCELLED`. Sem `RASCUNHO` nem `EM_ANALISE`: estado sem transição definida é estado morto. |
| `Coach.status` e campos de análise | `status` com `DEFAULT 'PENDING'`; as linhas **existentes** viram `APPROVED` na própria migration, para que os técnicos já cadastrados continuem operando. |
| `CoachDocument` | Documentação da análise. Espelha `AthleteDocument`, com `storageKey` único. |
| `CoachOrganization` | Onde o treinador pode atuar. `@@unique([coachId, organizationId])`: reautorizar **atualiza** a linha, não empilha outra. |
| `TeamMembershipRequest` | A solicitação de vínculo. `pendingAthleteId String? @unique` garante **um pedido pendente por atleta** no banco. |
| `CentralAuthorization` | A delegação de R-02. `activeKey String? @unique` garante **uma concessão viva** por usuário, permissão e escopo. |
| `Team.coachId` | O treinador responsável. Opcional: as equipes existentes não têm treinador. |

Três `CHECK` de coerência de estado: `TeamMembershipRequest` amarra
`status` ↔ `pendingAthleteId` e `status` ↔ `decidedAt`; `CentralAuthorization` amarra
revogação a autor e data.

### `20260926040000_treinador_como_ator_de_rls`

Cinco correções de política, todas **medidas** contra o comportamento real:

| O que foi corrigido | Sintoma medido antes |
| --- | --- |
| `Athlete` passa a ser legível pelo treinador autorizado na federação | painel do treinador com lista **vazia**; e um visitante anônimo lia mais que ele |
| `AthleteTeamMembership` passa a ser legível pelo treinador da equipe | idem |
| `CoachOrganization` passa a ser escrita pelo **operador da própria federação** | `POST /coaches/:id/organizations` = 500 com PostgresError **42501** |
| `AthleteTeamMembership` aceita `INSERT` do **próprio atleta** | `POST .../confirm` = 500 com **42501** — a confirmação não conseguia criar o vínculo |
| `AuditLog` aceita a trilha do treinador na federação em que atua | a busca por matrícula **não deixava rastro** |

O `FOR ALL` de `AthleteTeamMembership` foi partido em `INSERT` / `UPDATE` / `DELETE`
de propósito: o atleta cria o **próprio** vínculo e **não** o encerra. Se a cláusula
do dono tivesse entrado no `FOR ALL`, o atleta sairia da equipe sozinho, e a regra
"o treinador não perde o atleta sem decisão central" cairia pela porta oposta.

**Nada disso é contornar RLS**: não há `USING (true)`, `BYPASSRLS`,
`SECURITY DEFINER` nem política global para `anon`. Cada cláusula nova exige três
predicados simultâneos — cadastro aprovado, autorização viva naquela federação e
responsabilidade por aquela equipe.

---

## 5. A cadeia de autorização, camada por camada

```
requireAuth  →  perm(...)  →  validate(Zod)  →  serviço (assertCan / titularidade)  →  RLS do banco
```

Três observações que valem para operar e para revisar:

1. **O tenant do treinador é `CoachOrganization`, não `OrganizationMember`.** O
   treinador não é membro da federação: `assertCan` recusaria todo ato dele. Quem
   resolve é `coachService.assertPodeAtuarNaOrganizacao`, que aceita **qualquer** das
   duas vias — membro da federação ou treinador autorizado nela — e nunca dispensa a
   permissão nomeada.
2. **A delegação central concede permissão de aplicação, não visibilidade.** As duas
   camadas são independentes, e a interseção falha **fechada**: uma conta com
   concessão viva mas sem papel que a RLS reconheça recebe **404**, não 200 sobre
   dado que não devia ver. Está medido em `tests/vinculo-equipe.test.mjs`.
3. **O ator é carregado dentro do próprio contexto de RLS.** `loadUserFromHeader`
   passou a rodar dentro de `withUserContext`, porque a permissão efetiva passou a
   depender de `CentralAuthorization`, que tem RLS. Sem isso a concessão existia no
   banco e não chegava à autorização — medido: 403 para quem tinha o poder.

---

## 6. Rotas

| Método e caminho | Autorização | Observação |
| --- | --- | --- |
| `POST /coaches/self-register` | autenticado | Nasce `PENDING`. Teto de conteúdo contra criação em massa. |
| `GET` / `PATCH /coaches/me` | `coaches.read_own` | `status` não é campo aceito. |
| `GET /coaches/me/teams` | `teams.read_own` | |
| `GET /coaches/me/athletes` | `coaches.read_own` | Projeção esportiva explícita (R-05). |
| `GET /coaches/review` | `coaches.approve` | Fila da mesa central. |
| `GET /coaches/:id/review` | `coaches.approve` | Dossiê, **com** documentos. |
| `POST /coaches/:id/{approve,reject,suspend,reactivate,cancel}` | `coaches.approve` | Motivo obrigatório nas três decisões contra o interessado. |
| `POST /coaches/:id/organizations` | `coaches.authorize_org` (org do corpo) | Exige cadastro `APPROVED`. |
| `POST /coaches/:id/organizations/revoke` | `coaches.authorize_org` | Motivo obrigatório. |
| `POST /coaches/:id/documents` | dono **ou** `coaches.approve` | |
| `GET /coaches/:id/documents`, `GET /documents/coach/:id/download`, `DELETE /documents/coach/:id` | `coaches.approve` | Nem o autor do envio lista de volta — R-05. |
| `POST /teams/:id/coach` | `teams.manage` | Confere cadastro aprovado e autorização na federação. |
| `POST /athletes/lookup-affiliation` | `athletes.lookup_affiliation` | **POST** de propósito: matrícula fora de URL, log e Referer. |
| `POST /team-membership-requests` | `teams.request_membership` | |
| `GET /team-membership-requests` | `teams.read_own` ou `registrations.read` | Por equipe. |
| `GET /team-membership-requests/me` | autenticado | O que foi dirigido ao atleta desta conta. |
| `POST /team-membership-requests/:id/{confirm,reject}` | titularidade da conta do atleta | 404 para pedido de outra pessoa. |
| `POST /team-membership-requests/:id/cancel` | solicitante ou `athletes.update` | |
| `POST /team-membership-requests/:id/admin-approve` | `athletes.transfer` | Justificativa obrigatória, ação própria na trilha. |
| `GET`/`POST /central-authorizations` | leitura: `central.grant` ou `audit.read`; escrita: `central.grant` | Recusa autoconcessão. |
| `GET /central-authorizations/me` | autenticado | Ver a própria delegação não depende de poder conceder. |
| `POST /central-authorizations/:id/revoke` | `central.grant` | |
| `GET /coaches/:id/ranking/{eligibility,projection}` | autenticado | Sem classificação. |
| `GET /coaches/ranking/divergences` | `ranking.manage` | Diagnóstico de R-01, **somente leitura**. |
| `GET /ranking/coaches` | pública | **409**: fórmula não homologada. |

---

## 7. Antienumeração da busca por matrícula

A matrícula é curta e frequentemente sequencial, então a rota é varrível por
natureza. Três contenções, e nenhuma bastaria sozinha:

1. **Matrícula completa.** Não há busca por prefixo, por nome nem paginação: uma
   consulta, um resultado ou nada. O schema Zod não tem campo de nome.
2. **Auditoria de cada consulta**, com autor e se achou (`ATHLETE_LOOKUP_AFFILIATION`).
   É o que torna uma varredura visível **depois** do fato — e foi por isso que a
   política de `AuditLog` precisou reconhecer o treinador.
3. **Teto de requisições próprio** (o balde de busca, 120/min).

A resposta tem a **mesma forma** quando acha e quando não acha, e nunca distingue
"matrícula inexistente" de "matrícula de outra federação": as duas são
`{ found: false, athlete: null }`. Distingui-las transformaria a rota em oráculo de
pertencimento. Medido.

---

## 8. Notificações

| Tipo | Chega a quem | Quando |
| --- | --- | --- |
| `COACH_APPROVED` | treinador | aprovação e reativação |
| `COACH_REJECTED` | treinador | rejeição, com motivo |
| `COACH_SUSPENDED` | treinador | suspensão, com motivo |
| `COACH_ORG_AUTHORIZED` | treinador | autorização de federação |
| `MEMBERSHIP_REQUEST` | **atleta** | convite recebido |
| `MEMBERSHIP_CONFIRMED` | treinador (e ao atleta, na decisão administrativa) | vínculo criado |
| `MEMBERSHIP_REJECTED` | treinador | convite recusado |
| `CENTRAL_AUTHORIZATION` | delegado | concessão recebida |

Nenhum dos 16 tipos anteriores cobria estes fluxos. Tipo genérico deixaria a tela sem
saber para onde levar a pessoa — o `type` é o que decide o destino.

---

## 9. Trilha de auditoria

`COACH_REGISTER`, `COACH_UPDATE`, `COACH_APPROVE`, `COACH_REJECT`, `COACH_SUSPEND`,
`COACH_REACTIVATE`, `COACH_CANCEL`, `COACH_ORG_AUTHORIZE`, `COACH_ORG_REVOKE`,
`COACH_DOCUMENT_UPLOAD`, `COACH_DOCUMENT_DOWNLOAD`, `COACH_DOCUMENT_DELETE`,
`TEAM_COACH_SET`, `ATHLETE_LOOKUP_AFFILIATION`, `MEMBERSHIP_REQUEST_CREATE`,
`MEMBERSHIP_REQUEST_CONFIRM`, `MEMBERSHIP_REQUEST_REJECT`,
`MEMBERSHIP_REQUEST_CANCEL`, `MEMBERSHIP_REQUEST_ADMIN_APPROVE`, `CENTRAL_GRANT`,
`CENTRAL_REVOKE`.

Uma ação por **decisão**, não uma ação genérica com o estado no metadado: quem audita
distingue "a central aprovou" de "a central suspendeu" sem abrir o payload. E
`MEMBERSHIP_REQUEST_ADMIN_APPROVE` é separada de `MEMBERSHIP_REQUEST_CONFIRM` porque
a primeira **substitui a vontade do atleta** e a segunda é a vontade dele.

---

## 10. LGPD e minimização

- O que o treinador recebe do atleta: `id`, nome, nome de palco, sexo, situação,
  situação PRO, matrícula, entidade de filiação, equipe e organização. A projeção é
  **explícita** (`SELECT_ATLETA_ESPORTIVO`) e não um `include`: um `include` traria
  todo campo que a tabela ganhasse depois, que é exatamente como um dado sensível
  aparece num painel meses depois de ter sido proibido.
- CPF vive em `AthleteIdentity`, tabela separada com RLS própria, que nenhuma
  cláusula deste módulo alcança.
- Documento de análise do treinador não aparece no painel dele, **nem para quem o
  enviou** — a assimetria é a decisão R-05, e está medida.
- `storageKey` não volta na resposta do upload.

---

## 11. O que este módulo **não** fez

- **Não homologou fórmula de ranking de treinadores.** Ver §3.
- **Não criou um segundo motor de ranking.** A elegibilidade e a projeção leem o que
  o motor existente já grava.
- **Não criou tabela paralela de pontos manuais.**
- **Não alterou nenhum lançamento existente.** A correção de R-01 no caminho interno
  vale para lançamentos **novos**; `recomputarEm` preserva o `teamId` gravado, e há
  teste medindo isso.
- **Não deu `coaches.approve` a federação nenhuma**, nem `athletes.transfer` a papel
  nenhum.
- **Não aplicou migration em produção.**

---

## 12. Consequências operacionais a registrar

1. **`EVENT_DIRECTOR` e `ADMIN` deixaram de transferir e desvincular atleta por
   papel.** Passa a depender de concessão em `CentralAuthorization`. É restrição de
   comportamento existente, aprovada em R-02, e há teste medindo a recusa do diretor.
2. **A concessão só é efetiva para quem a RLS já reconhece** — administrador de
   plataforma ou operador da federação. Conceder a uma conta sem papel operacional
   produz 404, não 200. Ver §5, item 2.
3. **Técnicos já cadastrados continuam `APPROVED`**; os novos passam pela aprovação
   central.
4. **Equipe só aceita treinador aprovado e autorizado naquela federação.** Equipes
   existentes sem treinador seguem funcionando.

# Aprovação automática do cadastro de Treinador (Equipe) — R-03 revisada

**Decisão do responsável do produto**, registrada aqui porque **altera uma regra
de negócio antes homologada**. Nenhum trecho deste documento é conclusão técnica
minha sobre o que a MuscleContest deve fazer: é o registro do que foi decidido,
do que foi implementado e do que foi medido.

**Branch:** `claude/mci-platform-muscle-contest-o6haz9`

---

## 1. O que R-03 dizia, e o que passou a dizer

| | antes | depois |
|---|---|---|
| Cadastro **novo** de treinador | nasce `PENDING`; só a administração central aprova | nasce `APPROVED`; a pessoa entra na hora |
| **Atuar** numa federação | exige `CoachOrganization` concedida pela federação | **igual — R-04 intacta** |
| Suspender / reativar / encerrar | administração central | **igual** |
| Cadastros que já estavam `PENDING` | esperando análise | **continuam esperando** — nada foi aprovado retroativamente |

A metade que não mudou é a que importa: **aprovação de cadastro nunca foi
autorização para atuar.** São duas decisões, de duas autoridades. Só a primeira
ficou automática.

## 2. Por que uma coluna nova (`Coach.autoApprovedAt`)

Três estados passaram a existir, e sem a coluna dois deles ficam indistinguíveis:

| estado | `reviewedById` | `reviewedAt` | `autoApprovedAt` |
|---|---|---|---|
| aprovado **por pessoa** | preenchido | preenchido | nulo |
| aprovado **pela regra** | nulo | preenchido | **preenchido** |
| aprovado **pela migration** (legado A-05) | nulo | nulo | nulo |

O terceiro é o que a migration `20260927030000` devolve a `PENDING`, pelo
predicado `reviewedById IS NULL AND reviewedAt IS NULL`. **Se a aprovação
automática gravasse apenas `status`, ela cairia nesse mesmo predicado e a
próxima execução daquela migration derrubaria treinadores legítimos.** Por isso
a aprovação automática grava `reviewedAt` (tira a linha do predicado) **e**
`autoApprovedAt` (diz por que ela está fora).

`reviewedById` fica nulo porque **não houve pessoa**. Inventar um revisor seria
mentir na trilha.

Migration `20260927040000`, **aditiva**: coluna anulável + índice parcial.
Nenhuma linha existente é alterada.

## 3. Senha e confirmação

| o que | onde |
|---|---|
| Campo **Confirmar senha** | `cadastroWizard.jsx`, etapa 2 |
| **Mostrar/ocultar** nos dois campos, independentes | `BotaoDeSenha`, com `aria-pressed` |
| Divergência bloqueia o avanço com "As senhas não coincidem" | `formulario.js`, etapa 2 |
| Política existente (≥ 8) preservada | inalterada |
| A confirmação **nunca viaja** | `corpoDoCadastro` monta o corpo campo por campo e não a inclui |
| Armazenamento | inalterado — `bcrypt` pelo mecanismo de autenticação existente |
| Senhas antigas | **intocadas**; nada é redefinido |

Duas decisões de detalhe que não são cosméticas:

- **A ordem do erro.** Senha curta acusa a **política**, não a divergência:
  cobrar a confirmação de uma senha que a pessoa vai trocar é ruído.
- **O botão fica FORA do `Field`.** `Field` envolve o conteúdo num `<label>`, e
  `<button>` é elemento rotulável: dentro do label a associação fica ambígua e o
  clique no olho aciona o label. E `type="button"` é obrigatório — sem ele, o
  clique no olho **enviaria o formulário**.

## 4. O que foi medido

| suíte | resultado |
|---|---|
| `tests/aprovacao-automatica-de-treinador.test.mjs` (nova) | **15/15** |
| `frontend/src/pages/cadastroWizard.test.jsx` | **24/24** (8 novos de senha) |
| `tests/modulo-treinadores-equipes.test.mjs` | **25/25** |
| `tests/hardening-auditoria-treinadores.test.mjs` + matriz de leitura + unificação | corrigidas para a regra nova |
| Semeadura contra pilha real | **exit 0**, estado conferido no banco |

Estado conferido em PostgreSQL real depois da semeadura:

```
QA Treinadora Marta   | APPROVED  | aprovadoPelaRegra=t | temDataDeRevisao=t | temRevisorPessoa=f
QA Treinador Suspenso | SUSPENDED | aprovadoPelaRegra=t | temDataDeRevisao=t | temRevisorPessoa=t
```

A primeira: aprovada pela regra, sem pessoa. A segunda: aprovada pela regra e
**suspensa por pessoa** — e a trilha aponta quem.

### A fronteira, medida explicitamente

Quatro testes existem só para impedir a leitura preguiçosa ("foi aprovado, então
pode tudo"):

1. treinador aprovado nasce com **zero** autorizações de federação;
2. a federação **recusa** dar equipe a treinador sem autorização dela (422);
3. depois de autorizar pelo fluxo existente, a equipe passa;
4. as permissões do papel continuam as mesmas cinco — a fila de análise central
   segue fechada para ele (403).

## 5. O que mudou nas fixturas, e por quê

A aprovação deixou de ser um passo: chamá-la agora devolve **422
`COACH_STATUS_UNCHANGED`**. Nove chamadas de fixture saíram de
`hardening-auditoria-treinadores`, e o helper do módulo perdeu o passo.

Dois casos exigiram caminho novo, porque representam estados que **o produto não
produz mais**:

- o perfil "treinador pendente" da matriz de leitura;
- o bloco R-03 do módulo, que mede a máquina de estados a partir de `PENDING`.

Os dois montam o estado **escrevendo no banco**, com comentário dizendo que é
isso que está sendo feito. É a única forma honesta de testar um estado legado
que a regra nova não cria — e o comentário existe para ninguém confundir isso
com "montar cenário por fora das regras".

No ambiente de preview, a persona "Treinador em análise" virou **"Treinador
suspenso"**: não existe rota que devolva um `APPROVED` para análise, e suspender
é justamente uma das decisões que continuaram humanas.

## 6. Ressalvas

1. **Mutação não reexecutada** sobre esta mudança. Os mutantes do módulo cobrem
   R-03 na forma antiga (`TE-M1`, `TE-M2`) e precisam ser revistos: `TE-M2`
   ("a máquina de estados aceita qualquer transição") continua válido;
   `TE-M1` ("`coaches.approve` passa a ser permissão do diretor") também. Mas
   falta mutante para a barreira nova — *a aprovação automática passar a
   conceder autorização federativa*. Sem ele, essa fronteira tem teste e não
   tem prova de que o teste pega.
2. **Regressão backend completa em execução** no momento desta escrita. Nenhum
   PASS é declarado sobre ela aqui.
3. **Produção** segue bloqueada pelos mesmos três impedimentos: backup
   restaurável verificado, a migration `20260927030000` que altera cadastros
   reais, e as decisões D-1 a D-4.

# Relatório — Gestão completa do atleta

Fase: autocadastro, identidade, perfil administrativo, vínculo de histórico,
pontuação e mensagem de abertura.

Branch: `claude/mci-platform-muscle-contest-o6haz9`
Base: `f4aafb0` (main)

Vocabulário deste relatório: **PASS** (executado e verde), **FAIL**
(executado e vermelho), **NOT TESTED** (não executado), **GO COM RESSALVAS**
(entregue, com limite declarado).

---

## 1. O que foi entregue

| Bloco | Commit | O que |
|---|---|---|
| 1 | `87d9caa` | Interruptor do autocadastro da organização |
| 2 | `591d546` | Estado do atleta: suspender, reativar, arquivar, excluir |
| 3 | `bfde2cf` | Perfil administrativo, lista, busca e revelação do CPF |
| 4 | `51ad736` | Histórico importado do lado do atleta e vínculo manual |
| 5 | `1878f63` | Mensagem de abertura da federação |
| 6 | `02ebc70` | Portões: mutation, Chromium, concorrência, CI |

Quarenta arquivos, ~6.160 linhas. Nenhuma migration destrutiva. Nenhum dado
histórico apagado. Nenhuma reimportação do Ipiranga. Nenhum `RankingPoint`
duplicado.

---

## 2. Regras esportivas

**Nenhuma foi alterada.** A tabela de pontos, o desempate, o bônus de Overall,
a elegibilidade ao Super Overall e a apuração continuam exatamente como
homologados. Esta fase não toca o motor de pontuação.

O único ponto em que ela encosta no ledger é o **vínculo manual**, e ele
preenche ponteiro: não cria `RankingPoint`, não altera valor, não reescreve
súmula. O teste fotografa `RankingPoint` e `ExternalResult` campo a campo
antes e depois e exige igualdade.

---

## 3. Dado pessoal

| Regra | Onde é cumprida | Estado |
|---|---|---|
| CPF nunca em busca pública | `athleteService.list` exige `search.sensitive` e igualdade exata | PASS |
| CPF nunca na listagem administrativa | `adminAtletas.jsx` não desenha documento | PASS |
| CPF nunca em URL ou querystring | `POST /athletes/:id/cpf`, id no caminho, número no corpo | PASS |
| CPF integral só com autorização do backend | duas permissões, conferidas contra a organização do atleta | PASS |
| Toda leitura de CPF auditada | `ATHLETE_CPF_VIEW` gravado antes de responder | PASS |
| Recusa não deixa rastro de leitura | auditoria depois das conferências | PASS |

**Ressalva registrada:** na matriz atual, todo papel com
`athletes.read_sensitive` também tem `search.sensitive`. A segunda conferência
não recusa ninguém hoje; ela existe porque expressa a regra e passa a morder no
dia em que um papel separar as duas. O fato está fixado por teste, que reprova
nesse dia e diz o que fazer.

---

## 4. Histórico esportivo

| Regra | Estado |
|---|---|
| Nunca vincular automaticamente só por nome | PASS |
| Sugestão por nome marcada como exigindo confirmação humana | PASS |
| Homônimos sinalizados, não escolhidos pelo sistema | PASS |
| Nenhum CASCADE destrutivo sobre histórico | PASS |
| Exclusão recusada havendo histórico, com o que impede e quanto | PASS |
| Suspender/arquivar não toca resultado, ponto, inscrição ou título | PASS |
| Vínculo idempotente | PASS |
| Vínculo cross-tenant recusado | PASS |
| Identidade com dono não se revincula | PASS |

---

## 5. Isolamento e RLS

Duas tabelas novas, ambas com `ENABLE` + `FORCE ROW LEVEL SECURITY`:
`AthleteNotice` e `AthleteNoticeRead`.

Um predicado novo foi necessário — `mci_atleta_da_organizacao` —, porque
atleta **não é membro** da organização: ele tem cadastro nela, que é outra
relação.

Sem leitura anônima no recado. Sem política de `UPDATE` nem de `DELETE` na
marcação de leitura. A política de `INSERT` exige que o usuário da linha seja
o da sessão: **ninguém marca leitura no lugar de outro**, e há teste que tenta
por caminho direto e é recusado pelo banco.

Nada de BYPASSRLS, nada de `SECURITY DEFINER` privilegiado, nada de
`USING(true)`, nada de política global para `anon`, nada de remoção de `FORCE`.

---

## 6. O que os portões acharam

Três defeitos reais, nenhum deles visível para teste de unidade.

**1. A tela lia um nome que o contexto não tem.** `adminMensagens.jsx` fazia
`const { usuario } = useAuth()`; o contexto expõe `user`. Publicar um recado
respondia 400. A suíte daquela tela estava verde com quatorze casos, porque o
mock devolvia o mesmo nome errado. Corrigido na tela e nos seis mocks; e
`frontend/src/mocksNaoMentem.test.jsx` passou a ler as chaves reais do fonte e
reprovar qualquer mock que invente uma. Verificado que morde.

**2. Overflow horizontal em 320px.** No perfil, o selo de estado saía da
viewport (scrollWidth 340 > 320). `.panel-head` passou a quebrar linha abaixo
de 560px.

**3. O gate media o que não queria medir.** `innerText` devolve o texto já
transformado pelo CSS; e `goto` para o mesmo documento com outro hash não
remonta o React. Esta última revelou um fato de produto, não de teste: o
recado é buscado **quando a aplicação abre**, e quem já está com ela aberta o
recebe na próxima abertura.

---

## 7. Mutation testing

`scripts/qa/mutantes-atleta.mjs` — 19 mutantes.

* **18 mortos** entre os não equivalentes;
* **1 declarado equivalente**, com a investigação registrada no próprio script
  e o fato fixado por teste. O gate reprova se ele algum dia morrer.

---

## 8. Navegador real

`scripts/qa/responsividade.mjs` — **APROVADO**.

Fluxo atravessado com a pilha real (API + build de produção):

1. o operador acha o atleta na lista, que não mostra documento e não põe o
   termo buscado na URL;
2. abre o perfil, vê o CPF mascarado, pede o inteiro, e o recebe com o aviso
   de que a consulta ficou registrada;
3. abre a aba do histórico importado;
4. publica um recado;
5. o **atleta** abre a aplicação e recebe o recado por cima da tela, fecha, e
   ele não volta na abertura seguinte.

Doze larguras (320, 375, 390, 430, 560, 768, 1024, 1180, 1280, 1366, 1440,
1920) nas três telas novas, com alvo de toque mínimo de 40px nas larguras de
telefone.

---

## 9. Concorrência

| Cenário | Resultado |
|---|---|
| Dois operadores reivindicam a mesma carreira | uma passa; a outra encontra dono; nenhum lançamento fica partido |
| Três vínculos simultâneos do mesmo par | somam dois lançamentos, não seis |
| Três marcações de leitura simultâneas | uma linha só |

---

## 9-A. Regressão completa

```
Test Files  109 passed | 1 skipped (110)
Tests      1845 passed |  15 skipped (1860)
```

**PASS.**

Os 15 pulados são **condicionais de ambiente e anteriores a esta fase** —
`backup-restore`, `backup-storage` e `bypassrls-real` usam `describe.skipIf` /
`it.skipIf` e só rodam onde os papéis de backup e de BYPASSRLS estão
provisionados. Na CI eles **rodam**, porque o workflow os provisiona, e há
passos de guarda que reprovam se forem pulados lá. Nada foi desativado.

### O que a CI achou antes disso

Duas suítes reprovaram no commit do recado, e **nenhuma era defeito da
funcionalidade** — eram dois inventários fixados à mão, fazendo o que existem
para fazer:

| Guarda | Por que existe | O que mudou |
|---|---|---|
| lista de migrations homologadas | nenhuma migration entra de carona numa mudança que não é sobre schema | entrou a migration da fase, com a justificativa ao lado |
| contagem de tabelas com `FORCE RLS` | tabela protegida nova é decisão consciente; tabela que sai, idem | 28 → 30, com a razão de cada uma |

Nenhuma das duas foi afrouxada: a contagem continua exata e a lista continua
exigindo revisão.

---

## 10. Limites declarados

* **A varredura por nome tem teto de 500 identidades sem dono.** A resposta
  traz `varreduraTruncada` e a tela avisa. Para além disso, a revisão de
  importação continua sendo o caminho. **GO COM RESSALVAS.**
* **O recado é mensagem de abertura**, não alerta em tempo real. Quem está com
  a aplicação aberta o recebe na próxima abertura. **GO COM RESSALVAS.**
* **A segunda permissão do CPF não recusa ninguém hoje** (ver §3). **GO COM
  RESSALVAS.**

---

## 11. O que NÃO foi feito

* Nenhuma escrita contra a base de produção.
* Nenhuma reimportação do Ipiranga.
* Nenhuma alteração em `RankingPoint`, `Ranking` ou `PublicRankingEntry`
  existentes.
* Nenhuma alteração de regra esportiva homologada.
* Nenhuma refatoração ampla; nenhum segundo sistema paralelo de atletas.

---

## 12. Próximo passo

**Teste humano do operador.** O caminho está em
`docs/GESTAO-DO-ATLETA.md`.

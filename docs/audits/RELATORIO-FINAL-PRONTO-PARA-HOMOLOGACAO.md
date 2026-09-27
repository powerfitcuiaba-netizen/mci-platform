# Relatório final — módulo Treinadores & Equipes pronto para homologação

**Projeto:** MCI PLATFORM — Campeonato Brasileiro Muscle Contest International
**Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Data:** 2026-09-27
**Destinatário:** Helder Falcão

> **NADA FOI PUBLICADO.** Não houve `push`, pull request, merge, release, deploy, migração em
> banco de produção, seed, reset, truncate, limpeza de dados nem alteração de credencial. Todo
> o trabalho está em **commits locais** nesta branch, aguardando autorização expressa.

---

## A. O que foi pedido, e o que foi entregue

A tarefa era encerrar o módulo Treinadores & Equipes: corrigir os doze achados da auditoria
independente, verificar as regras de negócio aprovadas, atacar a superfície de segurança, medir
regressão e desempenho, preparar as migrações e montar o ambiente de homologação — com relatório.

| Fase | Entrega | Situação |
| --- | --- | --- |
| 0 | Pré-voo: branch, HEAD, árvore limpa, commits conferidos | **concluída** |
| 1 | A-01 a A-04 corrigidos com prova negativa | **concluída** (A-03 com resíduo reportado) |
| 2 | A-05: estratégia aditiva, auditável, com diagnóstico prévio | **concluída**, publicação bloqueada |
| 3 | A-06 a A-12 | **concluída** (A-09 com resíduo reportado) |
| 4 | Verificação das regras R-01 a R-05 e do bloqueio §8.3 | **concluída** |
| 5 | Segurança: autorização, IDOR, cross-tenant, RLS, segredos | **concluída** |
| 6 | Regressão, QA visual em 8 larguras, desempenho medido | **concluída** |
| 7 | Migrações: inspeção, `migrate deploy` do zero, plano | **concluída** |
| 8 | Ambiente de homologação e roteiro manual numerado | **concluída** |
| 9 | Os seis documentos em `docs/audits/` | **concluída** |
| 10 | Critérios de conclusão | ver **item J** |
| 11 | Este relatório | **concluída** |

### Os commits desta etapa

| Commit | Conteúdo |
| --- | --- |
| `bd27578` | A-01 e A-02 |
| `540b109` | A-04 |
| `374a317` | A-03, A-05 a A-12 |
| `871d9b6` | plano de migração, guia de homologação, relatório de segurança, script de desempenho |
| `f9aa85f` | correção de lint no script de desempenho |
| `173467b` | gate visual, desempenho medido, e as três correções que o gate encontrou |

Base: `f626f8b`. Nenhum `force push`, nenhum `squash`, nenhum `rebase` — o histórico está inteiro.

---

## B. Os doze achados, um a um

| # | Achado | Resultado |
| --- | --- | --- |
| A-01 | Rotas de ranking do treinador exigiam apenas sessão | **PASS** |
| A-02 | Delegação central aceitava escopo e prazo nulos | **PASS** |
| A-03 | `atleta_leitura` libera atleta de toda a federação ao treinador | **REPORTADO** — estreitado; resíduo depende de decisão |
| A-04 | `vinculo_criacao` sem predicado de `teamId` | **PASS** |
| A-05 | `UPDATE "Coach" SET status='APPROVED'` sem `WHERE` | **PASS** — publicação bloqueada até decisão |
| A-06 | Transação do cadastro com prazo padrão de 5 s | **PASS** (estouro em si: NOT TESTED, razão escrita) |
| A-07 | Gate visual apagava evidência commitada | **PASS** |
| A-08 | Credencial de desenvolvimento literal em 17 arquivos | **PASS** — controle criado e ligado na CI |
| A-09 | `POST /profile/password` sem trilha | **PASS** (tentativa recusada: **REPORTADO**) |
| A-10 | 429 decidido antes do serviço, sem trilha | **PASS** |
| A-11 | Tela administrativa transformava 403 em lista vazia | **PASS** |
| A-12 | Recomputo reescrevia atribuição histórica em silêncio | **PASS** |

O detalhamento de cada um — o código errado, a consequência no domínio, a correção, o que ela
deliberadamente não faz, e o mutante que a valida — está em
**`RELATORIO-CORRECOES-AUDITORIA-TREINADORES.md`**.

**Nenhum achado foi fechado com mecanismo proibido.** Não há `USING (true)` novo, `BYPASSRLS`,
`SECURITY DEFINER` privilegiado, política para `anon`, remoção de `FORCE ROW LEVEL SECURITY`,
teste desativado, cobertura reduzida nem dado real alterado.

---

## C. As regras aprovadas, verificadas

### R-01 — o ponto pertence ao vínculo da DATA OFICIAL do evento

| Verificação | Resultado |
| --- | --- |
| Transferência **depois** do evento não leva o ponto para a equipe nova | **PASS** |
| Vínculo que só **nasce** depois do evento não reivindica ponto anterior | **PASS** |
| Sem transferência, a equipe da época é a atual — o caso simples não muda | **PASS** |
| Atleta sem histórico de vínculo: o espelho responde, e isso não é retroatividade | **PASS** |
| Com histórico e nenhum vínculo na data, o espelho **não** é consultado | **PASS** |
| `POST /seasons/:id/recompute` **preserva** a equipe já registrada | **PASS** |
| A pergunta temporal tem uma resposta consultável (`vinculoNaData`) | **PASS** |
| A conferência de divergência existe e é **somente leitura** | **PASS** |
| Recomputo que **muda** a equipe deixa rastro com `de` e `para` (A-12) | **PASS** |

### R-02 — transferir, desvincular e corrigir atribuição é poder central

| Verificação | Resultado |
| --- | --- |
| Nenhum papel recebe `athletes.transfer` por construção (nem EVENT_DIRECTOR, nem ADMIN) | **PASS** |
| O treinador não transfere nem desvincula | **PASS** |
| Transferência exige motivo | **PASS** |
| Ninguém concede delegação para si mesmo — inclusive `SUPER_ADMIN` | **PASS** |
| Só `athletes.transfer` é delegável; `central.grant` nunca | **PASS** |
| **Escopo de federação obrigatório** (A-02) | **PASS** |
| **Prazo obrigatório**, conferido na hora da pergunta (A-02) | **PASS** |
| Linha gravada por fora do serviço não concede poder | **PASS** |
| Revogação tira o poder na requisição seguinte | **PASS** |

### R-03 — quem aprova treinador é a administração CENTRAL

| Verificação | Resultado |
| --- | --- |
| O cadastro nasce `PENDING` e o interessado não muda o próprio estado | **PASS** |
| O diretor da federação **não** aprova cadastro | **PASS** |
| A recusa e a suspensão exigem motivo | **PASS** |
| A máquina de estados recusa transição não prevista; `CANCELLED` é terminal | **PASS** |
| A decisão vai para a auditoria e chega ao treinador como notificação | **PASS** |
| Cadastro legado **não** fica aprovado por migration (A-05) | **PASS** |

### R-04 — cadastro global, atuação por federação

| Verificação | Resultado |
| --- | --- |
| Cadastro aprovado **não** basta: sem autorização da federação não há atuação | **PASS** |
| A federação B não autoriza atuação na federação A | **PASS** |
| Uma linha por par treinador/federação — reautorizar atualiza, não empilha | **PASS** |
| Não existe cadastro duplicado por federação | **PASS** |
| Revogar a autorização apaga a leitura imediatamente | **PASS** |

### R-05 — o treinador vê esporte, nunca documento nem CPF

| Verificação | Resultado |
| --- | --- |
| A lista de atletas não traz CPF, documento nem chave de arquivo | **PASS** |
| `AthleteIdentity` (onde vive o CPF) é ilegível no contexto do treinador | **PASS** |
| O documento da análise não aparece para o treinador, nem para quem o enviou | **PASS** |
| O treinador não alcança a equipe de outro treinador | **PASS** |
| A busca por matrícula devolve nome e filiação, nunca CPF, e registra quem procurou | **PASS** |
| A RLS é o **piso**; a projeção da aplicação é o **teto** — e o teto é lista explícita | **PASS**, com a ressalva de A-03 |

### §8.3 — a fórmula do ranking de treinadores NÃO está homologada

| Verificação | Resultado |
| --- | --- |
| A rota de classificação recusa com 409 e diz que o bloqueio é de homologação | **PASS** |
| Não existe apelido de rota em `/coaches/ranking` | **PASS** |
| A projeção avisa "Ranking em homologação" e **não** inventa total nem posição | **PASS** |
| Os totais de equipe são **copiados** do ranking homologado, sem recálculo | **PASS** |
| Nenhuma fórmula, peso, multiplicador, bônus ou desempate de treinador foi criado | **PASS** |

---

## D. Segurança

Resumo; o detalhamento está em **`RELATORIO-SEGURANCA-PENTEST-TREINADORES.md`**.

| Eixo | Resultado |
| --- | --- |
| Matriz de autorização por rota | 125 rotas mutantes com expectativa declarada; a lista e a superfície do Express são conferidas como o mesmo conjunto |
| IDOR e enumeração | 8 vetores atacados; a recusa de A-01 é 404 **idêntica** à de id inexistente |
| Cross-tenant | 5 tentativas, todas recusadas; zero linhas de outra federação |
| RLS — estado final | conferido em base criada do zero; zero `SECURITY DEFINER`, zero política para `anon`, `FORCE RLS` em 34 tabelas |
| Autoelevação na delegação central | 5 barreiras, medidas inclusive com linha gravada direto no banco |
| Autenticação | trilha de login, de tentativa recusada, de cadastro e de troca de senha; **fail closed** nas três primeiras e na quarta |
| Segredos | 470 arquivos versionados inspecionados, **0 a explicar**; nenhum valor impresso; controle ligado na CI |
| Observações pré-existentes | 5 nomeadas (O-1 a O-5), nenhuma criada por este trabalho |

**Conclusão de segurança: GO COM RESSALVAS**, com as ressalvas nomeadas no item I.

---

## E. Regressão, estabilidade e desempenho

Resumo; o detalhamento está em **`RELATORIO-REGRESSAO-E-PERFORMANCE-TREINADORES.md`**.

| Gate | Resultado |
| --- | --- |
| Regressão do backend | ver §1 daquele relatório |
| Regressão do frontend | **PASS** — 676 testes, 60 arquivos |
| Build do frontend | **PASS** |
| Lint (`eslint .`) | **PASS** |
| Migrations do zero + `migrate status` | **PASS** |
| QA visual em Chromium, 8 larguras | **PASS** — 218 PASS, 0 FAIL, 0 NOT TESTED |
| Desempenho das rotas do módulo | **PASS** — 13/13 no orçamento; p95 máximo 19 ms |
| Mutantes desta etapa | **PASS** — 11/11 mataram |
| Mutação pré-existente do módulo | **NÃO REEXECUTADA** — razão e recomendação registradas |

---

## F. Migrações

Três migrations novas, todas com o cabeçalho explicando o defeito, a correção e o que ela não faz:

| Migration | Escreve dado? |
| --- | --- |
| `20260927010000_vinculo_exige_pedido_pendente` | não — só política |
| `20260927020000_leitura_de_atleta_pelo_treinador` | não — política e uma função |
| `20260927030000_status_legado_de_treinador` | **sim** — `UPDATE` com `WHERE` estreito, idempotente |

As 44 migrations aplicam do zero numa base vazia, e `migrate status` fica em dia. O roteiro de
publicação, com o diagnóstico somente leitura **antes** e a conferência **depois**, está em
**`PLANO-MIGRACAO-RENDER-TREINADORES.md`**.

**Dois diagnósticos somente leitura** foram criados para serem rodados antes do deploy. Nenhum
imprime `DATABASE_URL`, e-mail ou telefone, e ambos saem com código 1 quando há decisão humana
pendente:

* `scripts/diagnostico-treinadores-legados.js` — quais cadastros voltam a `PENDING` e quais estão **em uso**;
* `scripts/diagnostico-delegacoes-inertes.js` — quais delegações vivas deixam de conceder.

---

## G. Ambiente de homologação

Um comando levanta a pilha completa em banco descartável, com seis contas sintéticas criadas
pelas **rotas reais**, escutando só em `127.0.0.1`:

```
node scripts/qa/visual-treinadores.mjs --manter
```

O roteiro manual numerado, em dez partes, com espaço para **APROVA / NÃO APROVA** em cada passo,
está em **`GUIA-HOMOLOGACAO-FALCAO.md`**. Ele cobre R-02, R-03, R-04, R-05, o vínculo por
confirmação, o bloqueio de §8.3, as oito larguras e a trilha de auditoria.

---

## H. O que este trabalho NÃO fez

* Não publicou nada — sem push, PR, merge, release ou deploy.
* Não aplicou migração em banco de produção, nem rodou seed, reset, truncate ou limpeza.
* Não alterou, apagou, recalculou nem corrigiu registro real de atleta, resultado, vínculo,
  ponto ou ranking.
* **Não tocou o cadastro nem o histórico de Lucas Gouveia Lima** — não foi lido, alterado nem
  desvinculado.
* Não criou, mudou nem ponderou fórmula de ranking. §8.3 continua bloqueado.
* Não inventou regra esportiva, categoria, data, local ou informação oficial.
* Não afrouxou RLS, autenticação ou autorização para fazer teste passar. Nenhum teste foi
  desativado ou marcado como pendente.
* Não pediu, imprimiu nem commitou segredo.
* Não executou teste contra produção.
* Não fez `force push`, `squash` nem `rebase`.

---

## I. As quatro decisões que dependem de Helder Falcão

| # | Decisão | Por que não foi tomada aqui | Onde está o detalhe |
| --- | --- | --- | --- |
| **D-1** | **A-03** — fechar a leitura de atleta de federação para equipe: propósito declarado na transação, ou mudança na forma de descobrir o atleta para convite | A primeira espalha uma marca de intenção por três serviços e **falha em silêncio** se esquecida — o defeito exato que este módulo já teve. A segunda é **regra de produto**, e este projeto não inventa regra | Correções §4; cabeçalho da migration `20260927020000` |
| **D-2** | **A-05** — o que fazer com os cadastros legados que voltam a `PENDING` e estão **em uso** | Aprovar cadastro é ato da administração central (R-03). O diagnóstico somente leitura precisa rodar em produção primeiro | Correções §6; plano de migração §4.2–4.3 |
| **D-3** | **A-09** — registrar a tentativa **recusada** de troca de senha | Exige escrever fora da transação da requisição: mudança de mecanismo, com desenho pronto | Correções §10 |
| **D-4** | **§8.3** — a fórmula do ranking de treinadores | Continua **não homologada**. Nada neste trabalho a inventa | Correções §14 |

---

## J. Critérios de conclusão — o que falta para publicar

| # | Critério | Situação |
| --- | --- | --- |
| 1 | Os doze achados corrigidos ou reportados com o resíduo nomeado | **cumprido** |
| 2 | Regressão do backend verde | ver §1 do relatório de regressão |
| 3 | Regressão do frontend verde | **cumprido** — 676/676 |
| 4 | Lint e build verdes | **cumprido** |
| 5 | QA visual em 8 larguras sem FAIL | **cumprido** — 218/0/0 |
| 6 | Desempenho medido, sem custo patológico | **cumprido** — 13/13 |
| 7 | Migrations aplicam do zero e `migrate status` em dia | **cumprido** |
| 8 | Prova negativa dos caminhos novos | **cumprido** — 11 mutantes |
| 9 | Inspeção de segredos sem achado a explicar | **cumprido** — e ligada na CI |
| 10 | **Homologação manual de Helder Falcão** pelo roteiro do guia | **PENDENTE** |
| 11 | **Decisões D-1 a D-4** | **PENDENTES** |
| 12 | **Diagnóstico somente leitura rodado em produção** (A-02 e A-05) | **PENDENTE** — exige acesso autorizado |
| 13 | **Backup verificado por restore** antes do deploy | **PENDENTE** — exige janela e responsável |
| 14 | Reexecutar `mutantes-treinadores.mjs` (16 mutantes do módulo) | **RECOMENDADO** antes da publicação |
| 15 | **Autorização expressa para publicar** | **PENDENTE** |

---

## K. Recomendação

**GO COM RESSALVAS para a homologação manual.** O módulo está funcional, medido e com a
superfície de autorização fechada nos pontos que a auditoria apontou. Os gates automatizados
estão verdes, e cada correção tem um mutante que a defende.

**NÃO recomendo publicar antes de:**

1. Helder Falcão percorrer o roteiro de `GUIA-HOMOLOGACAO-FALCAO.md` e registrar APROVA em cada parte;
2. as decisões **D-1** e **D-2** serem tomadas — a primeira porque define o alcance final de
   R-05, a segunda porque a migration que devolve cadastros a `PENDING` tem efeito operacional
   imediato sobre treinadores que podem estar atuando;
3. os dois diagnósticos somente leitura rodarem **em produção**, com as saídas guardadas;
4. o backup ser verificado por restore numa base descartável.

As três ressalvas técnicas que permanecem, sem eufemismo:

* **A leitura de atleta pelo treinador ainda é de federação, não de equipe.** Está estreitada,
  medida, limitada pela projeção da aplicação e provada como subconjunto do que uma requisição
  sem sessão já lê — mas não é o que R-05 descreve, e fechá-la é decisão de produto.
* **A tentativa recusada de troca de senha não deixa rastro.** O desenho está pronto.
* **O teto de requisições é por processo, não distribuído.** Com uma instância funciona como
  medido; com mais de uma, cada uma conta as próprias tentativas.

---

## Os seis documentos desta entrega

| Documento | Conteúdo |
| --- | --- |
| `RELATORIO-CORRECOES-AUDITORIA-TREINADORES.md` | os doze achados, um a um, com código, consequência, correção, mutante e resultado |
| `RELATORIO-SEGURANCA-PENTEST-TREINADORES.md` | escopo e limites, atores, IDOR, cross-tenant, RLS, delegação, autenticação, segredos |
| `RELATORIO-REGRESSAO-E-PERFORMANCE-TREINADORES.md` | regressão, QA visual em 8 larguras, desempenho medido, concorrência, mutantes |
| `GUIA-HOMOLOGACAO-FALCAO.md` | roteiro manual numerado, dez partes, com APROVA / NÃO APROVA |
| `PLANO-MIGRACAO-RENDER-TREINADORES.md` | inventário, ordem, roteiro de publicação, conferências e rollback |
| `RELATORIO-FINAL-PRONTO-PARA-HOMOLOGACAO.md` | este documento |

# Etapa A — fechamento técnico do módulo Treinadores & Equipes

**Autorizado por Helder Falcão:** Etapa A (gates técnicos) e a correção do documento
dos diagnósticos. **Não autorizado e não executado:** preview novo, diagnósticos em
produção, backup/restauração com dados reais, deploy, merge para `main`.

**Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Início real:** 2026-09-28 18:14:17 UTC · 15:14:17 Brasília
**Estimativa inicial:** 50:00

---

## 1. Os três estados, que não são equivalentes

| estado | situação |
|---|---|
| **CONCLUÍDO TECNICAMENTE** | **SIM** — todos os gates autorizados fecharam com resultado medido, e a CI está verde no remoto |
| **HOMOLOGADO PELA MUSCLECONTEST** | **NÃO** — a fórmula do ranking de treinadores segue sem homologação formal (§8.3). `FORMULA_HOMOLOGADA = false` não foi tocado |
| **PUBLICADO EM PRODUÇÃO** | **NÃO** — nenhuma migration, nenhum deploy, nenhum merge, nenhum dado real tocado. Os dois pré-requisitos de produção seguem pendentes |

---

## 2. Gates, com resultado medido

| # | gate | resultado |
|---|---|---|
| A1 | Branch, SHA, árvore e resíduo | **PASS** — árvore limpa; 0 `.mutante-bak`/`.orig`/`.rej`/`.bak`; 0 arquivo rastreado sob os sete diretórios de execução; 0 binário de QA fora de `design/` e `public/`; varredura de segredos com **0 achados a explicar** em 507 arquivos (35 permitidos, todos com razão escrita) |
| A2 | Migrations em banco isolado | **PASS** — 47 migrations aplicadas; **34 tabelas com RLS forçado**; `Coach.photoKey`, `CoachOrganization.autoGrantedAt`, a política `coach_org_autorizacao_automatica` e os 2 índices parciais presentes |
| A3 | Lint e build | **PASS** — eslint 0 problemas (é o typecheck do projeto, não há TS); build do frontend em 1,26 s |
| A4 | Frontend completo | **PASS** — 61 arquivos · **704/704** |
| A5 | Regressão completa do backend | **PASS** — 140 arquivos aprovados + 1 pulado (141) · **2516 aprovados · 15 pulados · 0 reprovados** · 1913,96 s |
| A6 | Mutação — 10 mutantes | **PASS** — **10 mortos, 0 sobreviventes**; controle antes 4/4; controle depois 4/4; política do banco íntegra; 0 resíduo · 5:59 |
| A7 | Documento dos diagnósticos | **PASS** — "os dois" virou "os três"; D3 documentado com o mesmo rigor; afirmações reconferidas contra o banco |
| A8 | CI vermelha — causa raiz e correção | **PASS** — achado fora do plano; ver §3 |
| A9 | CI verde em `e1a4fe3` | **PASS** — execução 354, `conclusion = success`, 25:48 |

### O que os 15 testes pulados são

Todos dependem de `BACKUP_DATABASE_URL` e do papel `mci_backup` provisionado: 6 de
`backup-storage` (o arquivo inteiro, por isso "1 arquivo pulado") e 4 de
`backup-restore`, mais os de BYPASSRLS quando os papéis não existem. Neste contêiner
não há como provisionar — `mci` tem `rolcreaterole = false`, e eu não pedi nem
procurei senha de superusuário. **A CI roda todos, e a execução 354 confirma que
nenhum foi pulado lá.**

---

## 3. O achado que não estava no plano

A reconciliação do "1 arquivo pulado" levou ao remoto, e **a CI da branch estava
vermelha** — não por causa de hoje, mas desde **26/09**.

**Causa raiz, medida no log da execução 36464706577:**

```
FALHA: campo "*Key" não classificado: CentralAuthorization.activeKey.
```

`scripts/backup-storage.js` monta a lista do que copiar a partir do schema e tem uma
guarda **fail closed**: todo campo terminado em `Key` precisa estar classificado —
aponta para o armazenamento, ou está na lista do que não aponta. Campo desconhecido
**interrompe a execução**, porque copiar "o que o banco referencia" sem saber o que é
referência seria adivinhar.

`CentralAuthorization.activeKey` chegou na migration `20260926020000`, com o próprio
módulo Treinadores & Equipes, e nunca foi classificada.

**O efeito era maior do que seis testes vermelhos.** Fail closed recusa **tudo**, não
uma parte: por ~50 horas o backup do storage **não produzia backup nenhum**. Num
desastre nessa janela, o dump do banco teria as referências e **os arquivos não
voltariam** — o cenário exato que a FASE 12.3 mediu e que esse script existe para
impedir.

**Por que só a CI via.** As seis conferências vivem em
`describe.skipIf(!URL_BACKUP)`. `BACKUP_DATABASE_URL` existe na CI e não na máquina de
quem desenvolve, então a regressão local fechava verde com "1 arquivo pulado" enquanto
a CI ficava vermelha com seis reprovações. Duas verdades ao mesmo tempo, com o defeito
morando na distância entre elas.

**Correção, medida:**

| | |
|---|---|
| Classificação | `CentralAuthorization.activeKey` em `NAO_SAO_ARQUIVO`, com o motivo escrito — chave de unicidade da delegação viva, não caminho de objeto |
| Levantamento completo | **11** campos `*Key` apontam para o armazenamento (entre eles `Coach.photoKey` e `Athlete.photoKey`), **5** não apontam, **0** sem classificação |
| Antes × depois | antes o script lançava a exceção da guarda; depois: `referenciados 1, copiados 1, ausentes 0, exit 0` |
| Teste novo, **sem `skipIf`** | lê o DMMF e a lista do script; reprova se qualquer campo `*Key` novo ficar sem classificação. Outro exige `Coach.photoKey` entre os copiados |
| Registro operacional | `docs/BACKUP-RESTORE.md` §9 passou a contar o incidente inteiro |

Nada foi pulado, desativado ou afrouxado. A guarda continua fail closed; o que mudou
foi **responder a ela** e passar a exercitá-la em todo ambiente.

---

## 4. Segurança, autorização e as barreiras do módulo

| barreira | como está coberta |
|---|---|
| Autorização automática na NPC | política de INSERT conjuntiva com 5 condições; `NF-P1` e `NF-P2` mortos na mutação; revogação não volta sozinha (medido) |
| R-04 fora da NPC | autorização continua sendo ato da federação; criar equipe em federação não autorizada é **403** (medido) |
| Foto obrigatória | recusa vem do serviço, com a frase do produto, nas **duas** formas de chamar a API; `NF-M5` morto |
| Chave do objeto não vai ao navegador | projeção devolve `hasPhoto`; `NF-M6` morto |
| Foto como requisito do ranking | `impedimentosDoRanking` é a função única; `NF-M7` morto; §8.3 intacto |
| `teams.create_own` não é `teams.manage` | `POST /teams` continua recusando o treinador; corpo não escolhe responsável nem empresa; `NF-M3` e `NF-M4` mortos |
| RLS | 34 tabelas com RLS forçado no banco isolado; suítes de RLS, BYPASSRLS real e matriz de autorização por rota na regressão e na CI |

---

## 5. O que NÃO mudou

- **Regras esportivas e fórmulas:** nenhuma linha. 1º=5, 2º=4, 3º=3, 4º=2, 5º=1,
  6º+=0, `NS`=0; bônus de Overall +10, uma vez por título, só em Open/Absoluta; só
  OPEN alimenta o Super Overall.
- **§8.3:** o ranking de treinadores continua sem classificação oficial.
- **Dados reais:** nenhum registro de atleta, resultado, vínculo, ponto ou ranking foi
  alterado, recalculado ou apagado.
- **Produção:** nada aplicado, nada publicado, nada mesclado.

---

## 6. Pendências que dependem de decisão humana

| # | pendência | quem decide |
|---|---|---|
| 1 | **Backup de produção com restauração confirmada** em ambiente isolado. O ensaio documentado é com base de teste; a CI ensaia a cada push. Falta o ensaio com **dados reais**, que exige credencial de produção — que eu não recebo por este canal | Helder Falcão |
| 2 | **D1, D2 e D3 em produção**, somente leitura, pelo Shell do serviço `mci-api`. Procedimento pronto em `PROCEDIMENTO-DIAGNOSTICOS-PRODUCAO.md`, agora com os três | Helder Falcão |
| 3 | **Homologação da fórmula do ranking de treinadores** | MuscleContest |
| 4 | **Deploy e merge para `main`** | Helder Falcão |
| 5 | **`design/referencias/`** — 48 imagens de WhatsApp (12 MB) commitadas em 24/08 num repositório **público**. Não é resíduo desta entrega e não foi tocado | Helder Falcão |


# Mutation testing — autorização automática na NPC e foto obrigatória

**Por que esta rodada existe:** as três barreiras novas (a política de INSERT da
autorização automática, a exigência da foto no autocadastro e a exigência da foto
no ranking) são *provas negativas* — elas existem para RECUSAR. Suíte verde não
mede recusa: mede que o caminho felizes passa. A pergunta que esta rodada responde
é outra: **se alguém retirar a barreira, algum teste reprova?**

**Arreio:** `scripts/qa/mutantes-npc-foto.mjs`
**Branch:** `claude/mci-platform-muscle-contest-o6haz9`

---

## 1. Como a rodada é lida

| parte | para que serve |
|---|---|
| o banco responde | uma consulta antes de tudo. O PostgreSQL deste contêiner cai sozinho, e quando cai a suíte é **pulada**, não reprovada — sem esta checagem o arreio leria infraestrutura fora do ar como "a suíte já está vermelha" |
| controle **antes** | as 4 suítes passam **sem** mutante. Sem isso, "morreu" pode ser vermelho que já existia |
| mutante | uma barreira é retirada. **MORREU** = algum teste reprovou. **SOBREVIVEU** = a barreira não é medida por teste nenhum |
| controle **depois** | as 4 suítes voltam a passar. Prova que a restauração funcionou |
| a política do banco é a do repositório? | consulta `pg_policy` e exige `autoGrantedAt`, `mci_current_user_id`, `upper(a.code) = 'NPC'` e `grantedById` no texto. É a conferência que os controles por suíte **não** fazem: política sem teste é justamente o caso em que o mutante sobrevive **e fica** |

A última linha é lição de uma rodada anterior (`TE-P1`, em
`mutantes-treinadores.mjs`), onde a restauração incompleta de uma política deixou
o banco **mais frouxo** do que o encontrou, e o controle depois passou — porque
não havia teste para reprovar.

---

## 2. Primeira rodada — 7 morreram, 3 sobreviveram

| id | barreira retirada | veredito |
|---|---|---|
| NF-M1 | a automática vira `upsert` e ressuscita a REVOGADA | **MORREU** — 15 testes |
| NF-M2 | a automática deixa de gravar `autoGrantedAt` | **MORREU** — 15 testes |
| NF-M3 | criar a equipe própria deixa de exigir autorização na federação | **MORREU** — 2 testes |
| NF-M4 | criar a equipe própria passa a obedecer o `coachId` do corpo | **SOBREVIVEU** |
| NF-M5 | a foto deixa de ser obrigatória no autocadastro | **MORREU** — 3 testes |
| NF-M6 | o serializador devolve a CHAVE do objeto ao navegador | **MORREU** — 1 teste |
| NF-M7 | o ranking oficial deixa de exigir foto | **MORREU** — 2 testes |
| NF-M8 | a federação oficial passa a ser "a primeira ativa", sem o código NPC | **SOBREVIVEU** |
| NF-P1 | a política perde a condição da federação OFICIAL | **MORREU** — 1 teste |
| NF-P2 | a política perde a condição do DONO: autoriza treinador alheio | **SOBREVIVEU** |

Controle depois: 4 PASS. Política íntegra: PASS. Nenhum resíduo `.mutante-bak`.

NF-M1 e NF-M2 derrubarem **15** testes cada um é o sinal de que a autorização
automática está no caminho de todos os cenários da suíte, e não num teste só.

---

## 3. Os três sobreviventes, um por um

### NF-M4 — mutante **equivalente**, e a prova disso

O mutante trocava `coachId: estado.id` por `coachId: data.coachId ?? estado.id`
no serviço. Ele sobreviveu **sem que faltasse teste**: existe um teste que manda
`coachId` alheio no corpo e exige que o responsável seja quem pediu. O que o
mutante não conseguiu foi mudar comportamento — **o Zod descarta `coachId` antes
de o serviço ver o corpo**:

```
coachTeamCreate.parse({ organizationId, name, coachId, companyId })
  → { organizationId, name }
```

`data.coachId` é sempre `undefined`, então `data.coachId ?? estado.id` **é**
`estado.id`. Mutante equivalente, não buraco de teste.

A correção não é escrever teste novo — é **medir a barreira real**, que são as
duas camadas juntas. NF-M4 virou **mutante composto**: o schema passa a aceitar
`coachId` **e** o serviço passa a obedecê-lo. O arreio ganhou suporte a mutante de
várias edições, em arquivos diferentes, com backup de todos antes da primeira
escrita.

### NF-M8 — buraco real: o cenário tinha uma filiação só

O mutante trocava o filtro do código oficial por "a primeira filiação ativa". Ele
sobreviveu porque no cenário montado a NPC era a **única** `Affiliation` — a
primeira ativa e a do código eram a mesma linha. Num ambiente real não são: cada
federação estadual tem a sua entidade, e várias são anteriores à NPC.

**Teste novo:** `a federação oficial é a do código NPC, e não a primeira da fila`
— cria uma entidade estadual em outra federação, fixa a `createdAt` dela em
2020-01-01 (para "anterior" não depender de quantos milissegundos separaram duas
requisições HTTP) e exige que a autorização automática caia **só** na NPC.

### NF-P2 — buraco real: a condição do dono não era medida por rota nenhuma

A política é conjuntiva, e uma das condições é que o treinador da linha seja **o
da conta que insere**. Nenhuma rota tenta o contrário — o serviço sempre usa o
cadastro do próprio autor —, então retirar essa condição não reprovava teste
algum. A barreira existia e **não era medida**: exatamente o caso que a mutação
serve para encontrar.

**Teste novo:** `o treinador NÃO consegue autorizar OUTRO treinador na oficial` —
escreve direto no banco, no contexto RLS do treinador, uma autorização no nome de
outro. Dois detalhes decidem o teste, e o segundo só apareceu porque o mutante
sobreviveu **duas vezes**:

1. **a vítima precisa não ter autorização na NPC.** Senão o índice único
   recusaria a linha pelo motivo errado, e o teste passaria sem medir a política.
   Ela é cadastrada com a entidade oficial desativada, que é o único estado em que
   um cadastro nasce sem autorização automática.

2. **a escrita precisa ser crua, sem `RETURNING`.** A primeira versão usava
   `tx.coachOrganization.create`, e o mutante sobreviveu de novo. O Prisma escreve
   `INSERT ... RETURNING`, e o `RETURNING` passa por `coach_org_leitura`:

   ```
   coach_org_leitura (SELECT) USING
     mci_is_platform_admin() OR mci_operator_of("organizationId")
     OR EXISTS (SELECT 1 FROM "Coach" c
                 WHERE c.id = "CoachOrganization"."coachId"
                   AND c."userId" = mci_current_user_id())
   ```

   Quem insere no nome de outro não é dono da linha e não consegue **ler** o que
   acabou de escrever, então a chamada falhava de qualquer jeito — pela política de
   LEITURA, não pela condição do dono na política de ESCRITA. O teste passava e não
   media nada. Com `$executeRawUnsafe` e um `INSERT` sem `RETURNING`, só o
   `WITH CHECK` decide.

**Esta é a lição da rodada:** um teste que recusa pelo motivo errado é
indistinguível de um teste que recusa pelo motivo certo — até que a mutação
retire a barreira certa e nada reprove.

---

## 4. Segunda rodada — os três corrigidos

| id | veredito | o que reprovou |
|---|---|---|
| NF-M4 (composto) | **MORREU** | 1 teste — `o corpo NÃO escolhe o responsável nem a empresa` |
| NF-M8 | **MORREU** | 1 teste — `uma entidade estadual ANTERIOR não recebe a autorização automática` |
| NF-P2 | **MORREU** | 1 teste — `o treinador NÃO consegue autorizar OUTRO treinador na oficial` |

NF-P2 precisou de **duas** correções para morrer, e a primeira tentativa está
registrada na seção 3 porque é o tipo de erro que se repete: o teste recusava, mas
pela política errada.

Controle antes: 4 suítes PASS. Controle depois: 4 suítes PASS. Política do banco
íntegra. Zero resíduo `.mutante-bak`.

**Placar final das três barreiras novas: 10 mutantes, 10 mortos, 0 sobreviventes.**

---

## 5. O que esta rodada NÃO diz

- **Não** mede a fórmula do ranking de treinadores: ela não está homologada
  (§8.3), `FORMULA_HOMOLOGADA` é falso e não há classificação para mutar. O que a
  rodada mede é o **gate** da foto, que é onde a classificação vai nascer.
- **Não** substitui a regressão completa. Os mutantes rodam 4 suítes, não 140.
- **Não** mede o frontend. O arreio de navegador (`scripts/qa/cadastro-treinador-navegador.mjs`)
  é outro gate, com outro resultado.
- **Não** foi executada contra produção, e nenhuma política de produção foi
  tocada. Toda a rodada vive no banco isolado `mci_test`.

## 6. Como reexecutar

```
# a rodada inteira
node scripts/qa/mutantes-npc-foto.mjs

# só um sobrevivente corrigido, mantendo os controles e a conferência da política
node scripts/qa/mutantes-npc-foto.mjs NF-P2
```

Exige o PostgreSQL local no ar. Se o banco não responder, o arreio **para antes de
qualquer conclusão** e sai com código 2 — infraestrutura fora do ar não é veredito
sobre suíte nenhuma.

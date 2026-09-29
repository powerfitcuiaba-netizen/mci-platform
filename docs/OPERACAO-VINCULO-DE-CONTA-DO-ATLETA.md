# Operação: vínculo de conta do atleta

Dois comandos de `scripts/operacao/`, para uma correção que não tem tela:

| Comando | O que faz |
| --- | --- |
| `scripts/operacao/desvincular-conta-do-atleta.js` | Tira a conta que está ligada a um atleta (`Athlete.userId` → `null`). |
| `scripts/operacao/vincular-conta-do-atleta.js` | Liga a conta do **próprio atleta** ao **mesmo** atleta que já existe. |

Os dois são cobertos por `tests/operacao-vinculo-de-conta-do-atleta.test.mjs`.

## Quando isto é necessário

O autocadastro grava, no atleta que cria, a conta que abriu o pedido
(`athleteRequestService`: `userId: pedido.userId`). Quem estiver **logado numa
conta administrativa** e preencher o autocadastro fica, para o sistema, sendo
aquele atleta: "Meu Histórico" da conta administrativa passa a mostrar o atleta
e o histórico importado dele.

`meService.atletaDoAtor` resolve o atleta da sessão por **uma** chave:

```js
prisma.athlete.findUnique({ where: { userId: actor.id } })
```

Não por CPF, não por `AthleteIdentity`, não por nome. Então desfazer é zerar
**uma** coluna, e devolver o atleta para a conta certa é escrever a mesma coluna
com outro id. Nada de apagar atleta, nada de mexer em histórico.

## Por que um comando, e não uma tela

A operação existe na API — `PATCH /athletes/:id` aceita `userId`, e
`athleteService.update` põe `userId` entre os campos restritos, que só um
operador com `athletes.update` pode escrever. O que **não** existe é interface:
varredura por `userId` em `adminAtleta.jsx` e `adminAtletas.jsx` não acha nada.
Usar a rota à mão exigiria token, DevTools ou `curl`.

Os comandos chamam o **serviço oficial** — `athleteService.update`, o mesmo que a
rota usa: mesma autorização, mesma auditoria (`ATHLETE_UPDATE`, com
`metadata.fields`), mesma transação. Não é `UPDATE` direto no banco, não é
caminho paralelo e não é funcionalidade nova no produto.

## Como rodar

No shell do ambiente, **dentro do diretório da aplicação** (no Render, `/app`).
A raiz é procurada, não assumida: vale `MCI_APP_ROOT`, senão o repositório acima
do arquivo, senão o diretório atual — o que existir com `src/config/prisma.js`.

Se a imagem em execução ainda **não** tem `scripts/operacao/` (ela chega na
imagem no próximo deploy, via `COPY scripts ./scripts`), dá para colar o arquivo
sem deploy nenhum:

```bash
cd /app && cat > /tmp/comando.js <<'FIM'
# …conteúdo integral do arquivo de scripts/operacao/…
FIM
```

O delimitador entre aspas simples (`<<'FIM'`) é o que faz o shell não tocar em
nada — inclusive nos backticks dos template literais. A receita é testada.

### Desvincular

```bash
# 1) SOMENTE LEITURA: mostra o estado e confere as pré-condições. Não escreve.
cd /app && ALVO_ATHLETE_ID='<id do atleta>' \
  ALVO_USER_ID='<id da conta que está ligada, e que executa>' \
  ALVO_NOME='<fullName exato do atleta>' \
  node scripts/operacao/desvincular-conta-do-atleta.js

# 2) APLICAR: só depois de a leitura aprovar todas as pré-condições.
cd /app && APLICAR=sim ALVO_ATHLETE_ID='…' ALVO_USER_ID='…' ALVO_NOME='…' \
  node scripts/operacao/desvincular-conta-do-atleta.js
```

Pré-condições (qualquer uma que falhe **aborta sem escrever**): o atleta é o
esperado; o `fullName` confere **exatamente**; o `userId` atual é o esperado; há
`AthleteIdentity`; o status é `ACTIVE`. O ator tem de ser `ADMIN` ou
`SUPER_ADMIN`. Se o atleta já estiver sem conta, o comando diz e sai — é
idempotente.

Depois da escrita, dez vereditos: `userId` é `null`; **somente** `userId` mudou
no atleta; `AthleteIdentity` intacta; `RankingPoint` intacto campo a campo;
`AthleteProfileRequest` intacto; status segue `ACTIVE`; matrícula, filiação e
organização inalteradas; auditoria `ATHLETE_UPDATE` registrada com `userId` em
`fields`.

### Vincular a conta do próprio atleta

**Antes disso, a conta tem de existir — e quem cria é o atleta.** Ele entra no
site, usa *Criar conta*, e define a senha dele. Ninguém mais pode fazer isso por
ele: este comando não cria conta e não define senha. Se o e-mail informado não
tiver conta, o comando aborta dizendo exatamente isso.

O autocadastro **não** resolve o caso: com o CPF já cadastrado na federação, a
conciliação devolve `PRECISA_REVISAO` e deixa um pedido pendente, em vez de ligar
a conta ao atleta que existe (é a recusa neutra do `athleteRequestService`, para
não virar oráculo de CPF). Aprovar esse pedido criaria um **segundo** atleta e
seria recusado pela unicidade do CPF. O caminho é este comando.

```bash
# 1) SOMENTE LEITURA.
cd /app && ALVO_ATHLETE_ID='<id do atleta>' \
  ADMIN_USER_ID='<id da conta administrativa que executa>' \
  ALVO_NOME='<fullName exato do atleta>' \
  ALVO_EMAIL='<e-mail da conta do atleta>' \
  node scripts/operacao/vincular-conta-do-atleta.js

# 2) APLICAR.
cd /app && APLICAR=sim ALVO_ATHLETE_ID='…' ADMIN_USER_ID='…' ALVO_NOME='…' \
  ALVO_EMAIL='…' node scripts/operacao/vincular-conta-do-atleta.js
```

Pré-condições: o atleta é o esperado; o `fullName` confere exatamente; o atleta
está **sem** conta; a conta existe, está `ACTIVE` e **não** é administrativa; a
conta não é de outro atleta; há `AthleteIdentity`; existe exatamente **um**
atleta com aquela matrícula; o status é `ACTIVE`.

Depois da escrita, onze vereditos — os cirúrgicos, mais: é o **mesmo** `Athlete`
(o id não mudou); **nenhum** atleta novo foi criado; nenhum ponto duplicado; e
"Meu Histórico" da conta do atleta resolve **este** atleta, com o histórico que
já existia.

## O que estes comandos não fazem

Não apagam, não arquivam e não suspendem atleta. Não criam atleta, identidade,
ponto de ranking, conta ou senha. Não tocam em `RankingPoint`. Não imprimem CPF
— o CPF é comparado, e o que sai é só uma marca (quantidade de dígitos, dois
últimos, e um prefixo de hash). Não imprimem `DATABASE_URL` nem segredo nenhum.
Não fazem `UPDATE` direto no banco, não contornam RLS e não contornam auditoria.
Sem `APLICAR=sim`, não escrevem nada.

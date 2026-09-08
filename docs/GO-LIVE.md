# Relatório final e certificado de go-live

Fases 12.3 a 12.9 e a fase 13, executadas em sequência sobre
`claude/mci-platform-muscle-contest-o6haz9`, partindo de `dcf9167`.

Tudo aqui foi **executado e medido**. Onde algo não pôde ser provado, está
escrito que não pôde, e por quê.

---

## Classificação

# ✅ READY FOR GO-LIVE

O bloqueio que segurava esta classificação — **backup do storage** — foi
fechado na fase 13: existe ferramenta, foi exercitada num desastre completo
(banco **e** arquivos destruídos e recuperados juntos), e roda na CI a cada
push.

O que resta são passos que **só existem no ambiente real** e nenhum depende de
mais código.

### Antes do primeiro campeonato

| # | Passo | Onde |
|---|---|---|
| 1 | Agendar o **par** `backup.sh` + `backup-storage.js` na mesma janela, com destino fora do servidor do banco | [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) §3, §3.5 |
| 2 | Ensaiar a recuperação **com dados reais**, em ambiente separado, e medir `RTO`/`RPO` de verdade | §6, §7 |
| 3 | Construir a imagem no ambiente de deploy (a camada `apt-get` nunca executou aqui) | [`DEPLOY.md`](DEPLOY.md) §6 |
| 4 | Definir o limitador de taxa da borda se houver mais de uma réplica | [`DEPLOY.md`](DEPLOY.md) §7.95 |
| 5 | Decidir se o `EVENT_DIRECTOR` lê a auditoria da própria organização — **decisão de produto, sem risco técnico** (abaixo) | — |

Nenhum desses cinco é defeito de software, e nenhum precisa de código novo.

## Regras esportivas: nada pendente

A versão anterior deste relatório listava duas "decisões que continuam com o
organizador". **Estava errado, e a moldura era minha** — as duas já haviam sido
decididas e estão implementadas. Corrigido na fase 13:

1. **Quem é o campeão Overall.** Vem do **julgamento externo**. O MCI recebe o
   fato oficial, registra com autor e data, e aplica o bônus homologado de +10.
   Não existe julgamento dentro do MCI e o sistema **não deve** inventar
   algoritmo para descobrir o campeão. Ratificado na fase 11.4 —
   [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md) §P1.
2. **Quais resultados contam para a equipe.** A equipe **segue a regra de
   pontuação já homologada**: sem descarte, sem teto, sem mínimo. Ratificado na
   fase 13 — §P2.

Nenhuma das duas bloqueia o go-live, e nenhuma exige código novo.

---

## A pergunta de permissão — respondida por experimento

**O `EVENT_DIRECTOR` deve enxergar a auditoria da própria organização?** Hoje
não enxerga: `audit.read` é de `SUPER_ADMIN`/`ADMIN`.

Antes de tratar isso como decisão de produto, era preciso saber se a restrição
atual **carrega peso de segurança**. Carrega ou não? Fui medir.

Primeiro achado, na leitura do código: `can(ator, permissão, null)` — sem
escopo — **une as permissões de todas as organizações** do usuário. Um usuário
que é `REGISTRATION_OPERATOR` numa federação e simples atleta em outra passa na
verificação sem escopo por causa do papel da primeira. Conferido:

```
search.sensitive na org A   : true
search.sensitive na org B   : false
search.sensitive SEM escopo : true   <- une os papéis das duas
```

Isso *pareceu* um vazamento de CPF entre federações. **Não é** — e a prova é
que a sonda por requisição real não encontra o atleta da outra federação. O que
contém é o **RLS do banco**: a política de `AthleteIdentity` exige ser
*operador* daquela organização, e um atleta comum não é. A camada de permissão
tem a folga; o banco não deixa passar.

O mesmo vale para a auditoria. A política de `AuditLog` é
`mci_is_platform_admin() OR mci_operator_of("organizationId")`, e
`EVENT_DIRECTOR` está na lista de operadores. Conferido com o contexto de ator
real: consultando **sem filtro nenhum**, um diretor da federação A recebe
apenas linhas da federação A.

**Conclusão, com evidência:** conceder `audit.read` ao `EVENT_DIRECTOR` daria a
ele a auditoria da **própria** organização e nada além — o limite entre
federações é do banco, não da permissão. A restrição atual é **política, não
barreira de segurança**, e a decisão é da federação sem risco técnico
associado. Não mudei nada: conceder permissão é decisão de produto.

> Fica registrado como dívida de robustez, não como falha: a folga do
> `can(..., null)` está contida pelo RLS hoje, mas depende dele. Uma tabela
> futura sem política equivalente não teria essa rede. Os testes de
> `tests/rbac-matriz.test.mjs` e `tests/rls*.test.mjs` cobrem o estado atual.

---

## O que este ciclo encontrou

Sete defeitos reais. Cinco eram **defesas que existiam e não funcionavam** —
o tipo que a leitura do código não pega, porque o código parece certo e o
comentário promete a coisa certa.

### 1. Não havia backup nenhum
Só uma linha não marcada num checklist. Entraram `scripts/backup.sh`,
`scripts/restore.sh` e `scripts/provision-backup-role.sql`, com ensaio completo
de recuperação de desastre e suíte automática que roda a cada push.

### 2. `pg_dump` do dono do schema **falha** sob `FORCE ROW LEVEL SECURITY`
```
ERROR: query would be affected by row-level security policy for table "Athlete"
```
Não é defeito: é a proteção funcionando. Mas significa que, com a configuração
de segurança correta, o backup pelo caminho óbvio **não funciona** — e quem
descobre isso durante um desastre descobre tarde. A saída não foi afrouxar o
RLS: foi um papel dedicado, somente-leitura, com `BYPASSRLS`, e uma checagem
que recusa **antes** de escrever, explicando o que fazer.

### 3. O restore trocava atletas empatados de lugar
O mesmo Super Overall, antes e depois do backup, devolvia dois empatados em
ordem diferente. Nenhum número mudava — ambos seguiam com `position: null` e
`tieUnresolved: true` —, mas a **sequência** era a ordem física das linhas no
PostgreSQL, que o `pg_restore` reescreve.

Duas consequências reais: relatório emitido antes e depois deixa de bater byte
a byte, e a paginação — que fatia a lista **já classificada** — podia repetir
ou perder um competidor entre duas requisições.

A correção fixa a sequência de leitura e **não desempata nada**: quem está no
bloco empatado continua sem colocação, como manda a regra homologada.

### 4. A defesa de tempo constante no login estava 3 ordens de grandeza fora
A comparação contra hash descartável existia, com o comentário certo do lado.
O literal era de custo **04**; os hashes reais nascem com **10 ou 12**. Medido:

| Comparação | Tempo |
|---|---|
| hash descartável (custo 04) | **0,03 ms** |
| hash real (custo 10) | **80 ms** |
| hash real (custo 12) | **313 ms** |

O relógio dizia em voz alta quais emails existem, com a defesa aparentemente
no lugar.

### 5. Origem de CORS não listada virava `500` — e enchia o log de erro
Qualquer pessoa na internet podia inundar o log em nível `error` mandando um
cabeçalho `Origin`. Erro de verdade some no meio do ruído.

### 6. A chave de armazenamento perdia a árvore de prefixos
`events/<id>` virava `events<id>`: a limpeza contra travessia apagava também a
barra que os próprios chamadores passam. Segurança não mudava; o que se perdia
era a chance de escrever regra de ciclo de vida ou política de acesso **por
prefixo** no bucket — que é o que o runbook recomenda.

### 7. As ferramentas de backup não estão na imagem
Os scripts são copiados para a imagem, mas `pg_dump`/`psql` não. É proposital
(a imagem serve a API e não deve carregar a credencial `BYPASSRLS`), mas
morria com `command not found`. Agora os scripts conferem e explicam.

---

## O que foi provado, fase a fase

### 12.3 — Backup, restore e desastre
Base de ensaio com 43 tabelas e 279 linhas.

* Backup: **270 634 bytes, 641 objetos, 163 ms**, com SHA-256 conferido.
* Restore em banco novo: **73 tabelas, 827 ms, 21 com `FORCE RLS`**.
* **`RTO_OBSERVED` = 1 720 ms**, do banco vazio ao primeiro login.
* `RPO_OBSERVED` = o intervalo entre backups. Sem WAL arquivado; registrado
  como limitação, não como item concluído.
* Os **quatro rankings** voltam com SHA-256 **idêntico** ao da origem.
* RLS, `FORCE RLS` e as **70 políticas** atravessam o restore. `AthleteIdentity`
  devolve **zero** sem contexto de ator e **zero** para a organização vizinha.
* Login, RBAC, cross-tenant, auditoria e os estados `CONFLICT` e
  `MATCH_PENDING` do MuscleWar sobrevivem; reaplicar continua idempotente.
* O dump **não** carrega segredo de ambiente; senhas seguem em bcrypt.
* **O storage não é protegido pelo dump** — provado nos dois sentidos.
* Guardas disparadas de propósito, todas recusando sem deixar estado parcial:
  papel sem `BYPASSRLS`, destino não vazio, dump adulterado em um byte, dump
  sem objeto algum.

### 12.4 — Prontidão de deploy
* **A imagem foi construída e executada** — em duas fases anteriores não tinha
  sido. `/ready` verdadeiro contra PostgreSQL real, processo como uid 1000,
  `HEALTHCHECK` saudável, `docker stop` saindo com **código 0** pelo caminho
  ordenado, `prisma migrate deploy` a partir da própria imagem.
* As guardas de partida funcionam **dentro da imagem**: sem configuração
  completa, com `JWT_SECRET` curto, ou contra papel **superusuário** — em que o
  RLS não teria efeito —, o processo recusa subir e diz por quê.
* `npm audit` em **zero**, com `overrides` de `deepmerge-ts` verificado
  (atualizar o Prisma não resolve; a única correção que o npm oferece é um
  *downgrade*, e `audit fix --force` é proibido neste projeto).

### 12.5 — Homologação operacional
Uma temporada inteira, do zero, pelo caminho do operador, com a API em
produção: **86 verificações, nenhuma falha**. Registrou o que o operador **não**
faz sozinho e a armadilha da planilha MuscleWar (a coluna de pontos é o total
**final**, com o bônus de Overall dentro).

### 12.6 — RBAC papel a papel
**14 papéis × 18 operações sensíveis**, mais 18 sondas anônimas: **270
verificações**. Provado que cada operação está atrás de um guarda — removendo
as duas camadas de `/audit`, 12 papéis reprovaram na hora. Descoberto de
quebra: a barreira é **dupla** (rota e serviço), e tirar só uma não abre nada.

### 12.7 — Portão de segurança
Cabeçalhos, CORS, JWT, enumeração, força bruta, injeção, IDOR, upload, log e
dependências — cada frente por requisição real. `alg: none` e assinatura
adulterada recusadas; mesma resposta para email existente e inexistente; 8
tentativas e `429` com `Retry-After`; injeção SQL sem efeito e as 73 tabelas de
pé; IDOR respondendo `404` e não `403`; upload com travessia contida, `.sh` e
`.php` em `415`, 12 MB em `413`; nenhum segredo nem CPF no log.

### 12.8 / 12.9 — Produção e fumaça
* **Do nada ao pronto: 4 545 ms**, com a imagem — banco, migrations, catálogo,
  papel de aplicação, primeiro administrador e contêiner de pé.
* **Fumaça limpa: 20 verificações, 951 ms**, do primeiro login ao ranking
  público lido **sem token**. A campeã Overall com `5 + 10 = 15`.
* Reinício do contêiner: ranking **idêntico**.
* Banco cai depois da partida: `/health` segue `200`, `/ready` vai a `503`, o
  contêiner **não morre** — e volta a `200` **sozinho** quando o banco retorna,
  com zero reinícios.
* `docker stop` com requisições em voo: **nenhuma cortada no meio**, saída `0`.

### 13 — Fechamento da infraestrutura de go-live

* **Backup dos arquivos** (`scripts/backup-storage.js`): a lista do que copiar
  vem do **banco**, não de uma varredura de diretório — funciona igual para
  disco e para bucket, e casa com o dump da mesma janela. Manifesto com
  checksum por objeto e a linha de origem de cada um.
* **Desastre completo ensaiado:** banco **e** storage destruídos, os dois
  recuperados. `RTO_OBSERVED` do par: **1 942 ms**. Os três documentos
  baixaram com **`HTTP 200` e SHA-256 idêntico ao original** — a diferença
  entre "o banco voltou" e "o sistema voltou".
* **Guardas conferidas disparando:** restaurar sobre storage não vazio; manifesto
  adulterado (0 arquivos gravados); um objeto adulterado entre três íntegros
  (**nada gravado**, nem os íntegros); referência apontando para arquivo sumido
  (copia o que existe e **relata**); campo `*Key` novo e não classificado no
  schema (**para o backup** em vez de deixar bytes de fora em silêncio).
* **Lacuna encontrada no procedimento:** o `pg_restore` recria as tabelas e com
  elas somem os `GRANT` do papel de backup — o **próximo backup falharia** com
  `permission denied for table "Athlete"`. Descoberto no ensaio, corrigido no
  runbook.
* **Documentação das regras esportivas corrigida:** as duas "decisões
  pendentes" que o relatório anterior listava **já estavam decididas**. A
  moldura errada era minha.

---

## Estado da suíte

**681 testes em 26 arquivos**, backend, mais **31 no frontend**, ESLint limpo,
13 migrations aplicadas do zero em banco novo com dono **não-superusuário**, e
21 tabelas com `FORCE ROW LEVEL SECURITY`. CI verde.

Toda correção deste ciclo entrou com teste que **reprova contra o código
antigo** — conferido um a um. Onde um teste passa nos dois lados, está dito
que ele é trava de comportamento e não guarda de regressão.

---

## O que continua NÃO provado

Registrado para não ser confundido com item resolvido:

* **O backup do storage contra um bucket S3 real.** O ensaio rodou com o
  driver `local`, que é o mesmo caminho de código através da mesma abstração de
  provedor — mas nenhum bucket foi tocado. Este ambiente não tem cliente S3 nem
  endpoint compatível.
* **A camada `apt-get` da imagem.** O ambiente bloqueia todos os espelhos
  Debian testados; o build usou `--build-arg BASE_IMAGE=node:22-bookworm`, base
  que já traz os pacotes.
* **Recuperação com dados reais, em ambiente separado, com cadência.** A CI
  ensaia a cada push com base de teste; o ensaio com dados de produção é
  responsabilidade operacional.
* **Desempenho sob carga de produção.** As medidas de 12.2 e deste ciclo são de
  um host só.
* **`RTO`/`RPO` de produção.** Ver condição 4.

---

## Onde ler o detalhe

| Assunto | Documento |
|---|---|
| Backup, restore, desastre | [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) |
| Runbook de deploy, imagem, prontidão | [`DEPLOY.md`](DEPLOY.md) |
| Varredura de segurança | [`SEGURANCA.md`](SEGURANCA.md) |
| Ensaio operacional de uma temporada | [`HOMOLOGACAO-OPERACIONAL.md`](HOMOLOGACAO-OPERACIONAL.md) |
| Regulamento do ranking | [`phase-11.4-regulamento-ranking.md`](phase-11.4-regulamento-ranking.md) |
| Homologação esportiva | [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md) |
| Registro datado da fase 10 | [`RELATORIO-FINAL.md`](RELATORIO-FINAL.md) |

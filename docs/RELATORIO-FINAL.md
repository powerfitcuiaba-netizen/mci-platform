# Relatório final — MCI Platform

Execução sobre `claude/mci-platform-muscle-contest-o6haz9`, partindo de
`a7d9a91`. Todos os números abaixo foram medidos, não estimados.

> ## ⚠️ Addendum de 8 de setembro de 2026 — leia antes do resto
>
> Este relatório é um **registro datado** da fase 10 e foi mantido como está,
> em vez de reescrito: apagar o que foi entregue naquele momento falsificaria o
> histórico. Duas coisas mudaram desde então e contradizem o que se lê abaixo.
>
> **1. O motor de julgamento interno não existe mais.** Por decisão do
> organizador (fase 11.5), o julgamento esportivo é **externo** ao MCI. Saíram
> `judgingService.js`, `tabulation.js`, as dez rotas de julgamento, as
> permissões `judging.*` e a tela correspondente — 2.254 linhas. No lugar entrou
> `POST /classes/:id/result`, que **recebe** a colocação já decidida fora e não
> a recalcula. Tudo o que este relatório descreve como painel de juízes, ficha,
> sessão, apuração determinística ou regra de descarte **não vale mais**.
>
> As tabelas de julgamento continuam no banco de propósito: removê-las exigiria
> migration destrutiva, proibida no projeto. Nenhum código as alcança, e uma
> trava em `tests/rotas.test.mjs` recusa a volta de qualquer rota de julgamento.
>
> **2. Os números de teste desta página estão desatualizados.** Eram 171 em 11
> arquivos; hoje são **355 em 19 arquivos**, mais 31 na interface. A suíte de
> homologação da apuração (23 testes) foi removida junto com o subsistema que
> ela documentava.
>
> O estado corrente está em [`../README.md`](../README.md) e em
> [`phase-11.4-regulamento-ranking.md`](phase-11.4-regulamento-ranking.md).

---

## 1. Implementado

**Removido**

- Camada financeira completa: `Order`, `OrderItem`, `Payment`, `PaymentEvent`,
  `Coupon`, `CouponRedemption`, `Refund`, campos monetários, serviços de
  pedido/pagamento/cupom/reembolso, provedor, webhook e variáveis `PAYMENT_*`.
- Domínio de confronto direto: `Match`, `Result(scoreA, scoreB, winner)` e
  `Standing(wins, losses, draws)`, incompatíveis com fisiculturismo.

**Construído**

Organizações e multi-tenancy · filiação esportiva · atleta com CPF como
identidade central · catálogo das onze categorias oficiais · evento com máquina
de estados · divisões e classes extensíveis · inscrição com reconhecimento por
CPF · check-in · pesagem · credenciamento com QR e leitura · ordem de palco ·
painéis e escalação de juízes · sessões e fichas de julgamento · motor de
apuração determinístico · resultados versionados · ranking e temporadas com
pontos rastreáveis · Atletas PRO com histórico · importação MuscleWar ·
equipes, coaches e academias · marcas, patrocinadores e parcerias · MCI Social ·
MCI Messenger · comunidades · notificações · busca global · RBAC granular ·
RLS · auditoria.

---

## 2. Campeonato

| Módulo | Situação | Verificado por |
| --- | --- | --- |
| Eventos e máquina de estados | Funcional | `unidade-dominio`, `e2e-campeonato`, `seguranca` |
| Categorias, divisões e classes | Funcional | `e2e-campeonato` |
| Inscrições com reconhecimento por CPF | Funcional | `e2e-campeonato`, `seguranca` |
| Elegibilidade (sexo e faixa etária) | Funcional | `seguranca` |
| Check-in | Funcional | `e2e-campeonato`, `seguranca` |
| Pesagem | Funcional | `e2e-campeonato` |
| Credenciamento e leitura | Funcional | `e2e-campeonato` |
| Ordem de palco | Funcional | `e2e-campeonato` |
| Julgamento | Funcional | `e2e-campeonato`, `seguranca` |
| Resultados e versionamento | Funcional | `e2e-campeonato` |
| Ranking e temporadas | Funcional | `e2e-campeonato`, `e2e-musclewar` |
| Atletas PRO | Funcional | coberto pelo serviço e pela auditoria de rotas |

Conferência de peso é informativa: aponta a classe fora de faixa e deixa a
reclassificação para a organização, como manda o regulamento.

---

## 3. MuscleWar

| Item | Situação |
| --- | --- |
| Adapter CSV / JSON / API com mapa de colunas | Funcional |
| Matching por CPF | Funcional |
| Conferência por filiação | Funcional |
| Categoria desconhecida → conflito | Funcional |
| Atleta não encontrado → `MATCH_PENDING`, nunca criado em silêncio | Funcional |
| Pré-visualização com todos os totais | Funcional |
| Idempotência entre lotes e dentro do arquivo | Funcional |
| Vinculação manual | Funcional |
| Aplicação com pontuação e origem `MUSCLEWAR` | Funcional |
| Auditoria de importação, revisão e aplicação | Funcional |

O formato definitivo do MuscleWar ainda não foi contratado. O adapter aceita
CSV e JSON com mapa de colunas configurável; ligar o formato real é registrar
um mapa, sem reescrever a importação. **Nada foi inventado sobre o contrato
deles.**

---

## 4. Social

Perfis por tipo · feed real paginado por cursor · publicações com visibilidade
`PUBLIC`/`FOLLOWERS`/`PRIVATE` · mídia · comentários em thread · curtidas ·
compartilhamentos · salvos · seguidores · stories com expiração aplicada na
consulta · bloqueio simétrico · denúncia e moderação com trilha.

Visibilidade decidida no servidor em toda leitura e escrita, incluindo as
interações: curtir, comentar e compartilhar passam pela mesma checagem.

---

## 5. Messenger

Conversa individual e em grupo · mídia · resposta · reação · marcação de lida ·
contador de não lidas · administração de grupo · saída de grupo.

`directKey` impede duas conversas 1:1 entre as mesmas pessoas. Não-participante
recebe **404** em leitura e escrita — e também no banco, pela política de RLS.

---

## 6. Marcas e patrocinadores

Marcas com perfil social próprio · patrocinadores · patrocínio de evento,
equipe ou atleta · parceria atleta ↔ marca com situação `PENDING` / `ACTIVE` /
`ENDED` e histórico.

**Nenhum campo de valor.** A relação é esportiva, institucional e de marketing.

---

## 7. Banco

| Métrica | Valor |
| --- | --- |
| Migrations | 2 (`mci_dominio_esportivo`, `rls`) |
| Tabelas | 67 (+ controle do Prisma) |
| Enums | 35 |
| Índices | 217 |
| Índices únicos | 137 |
| Chaves estrangeiras | 143 |
| Tabelas com RLS habilitado | 16 |
| Políticas de RLS | 16 |
| Colunas monetárias | **0** |

Tabelas sob RLS: `Athlete`, `AthleteDocument`, `AuditLog`, `Comment`,
`Conversation`, `ConversationMember`, `Message`, `MessageReaction`,
`MuscleWarImport`, `MuscleWarImportItem`, `Notification`, `Post`, `PostMedia`,
`Result`, `ResultEntry`, `Story`.

Constraints que sustentam regra de negócio, e não só integridade:

- `Athlete(organizationId, cpf)` — impede atleta duplicado.
- `JudgingScore(sessionId, judgeId, placing)` — o mesmo juiz não repete
  colocação.
- `JudgingScore(sessionId, judgeId, registrationItemId)` — uma colocação por
  atleta.
- `ExternalResult(source, externalId)` — idempotência da importação.
- `RankingPoint(seasonId, athleteId, resultId)` — o mesmo resultado não pontua
  duas vezes.
- `Conversation(directKey)` — uma conversa 1:1 por par.
- `StageOrder(batchId, position)` — sem posição repetida na bateria.

---

## 8. Segurança

| Camada | Situação |
| --- | --- |
| Autenticação JWT com expiração e conta inativa bloqueada | Funcional e testada |
| RBAC: 68 permissões, 21 papéis, autorização por permissão nomeada | Funcional e testada |
| Multi-tenancy: barreira na rota, no service e no banco | Funcional e testada |
| RLS executado contra o banco com papel sem `BYPASSRLS` | Funcional e testada |
| CPF fora de rota pública e de busca; consulta auditada | Funcional e testada |
| Resposta 404 para recurso restrito de terceiro | Funcional e testada |
| Escalada de papel bloqueada | Funcional e testada |
| Rate limit, CORS explícito, `helmet`, erro sem stack trace | Funcional |
| Log e auditoria com redação de senha, token e segredo | Funcional |

Testes negativos executados: CPF duplicado, CPF inválido, atleta inexistente,
filiação incompatível, resultado duplicado, importação duplicada, pontuação
duplicada, usuário sem permissão, juiz não escalado, acesso cross-tenant,
mensagem privada por terceiro, publicação privada por terceiro, documento
privado por terceiro, resultado não publicado, empate não resolvido, transição
inválida, conta suspensa, autopromoção de papel.

---

## 9. Testes

```
Unit          39  (CPF, estados, RBAC, apuração, adapter MuscleWar, BOM)
Integration   +   (todos os E2E rodam contra PostgreSQL real)
E2E           41  (campeonato 2, MuscleWar 10, social/messenger 21, mídia 8)
Security      28
RLS           12
Rotas          5  (173 endpoints percorridos)
Financeiro     8  (ausência verificada em schema, banco, arquivos e rotas)
Produção      15  (barreira de configuração da partida)
Homologação   23  (efeito de cada opção de apuração no pódio)
─────────────────
Backend      171  em 11 arquivos — todos passando
Frontend      25  em 3 arquivos — todos passando
```

Os 23 testes de homologação são documentação executável para o comitê técnico:
cada um monta um painel completo — todo juiz classifica toda a classe — e
mostra com números quem leva o título sob cada configuração de apuração. Ver
`docs/HOMOLOGACAO-ESPORTIVA.md`.

---

## 10. Build

```
Lint:       ESLint como gate real na CI, sem problema em backend, scripts,
            testes e frontend — passou
Typecheck:  N/A — JavaScript-only. Não há tipos para checar; converter a base
            só para preencher o item seria trocar risco real por selo. As
            validações estáticas que reprovam o job são `node --check` e ESLint
Build:      backend não tem etapa de bundling; frontend `vite build` — passou
Migrations: `prisma migrate deploy` + `migrate status` — sem pendência
```

---

## 11. Bugs encontrados

1. **Upload quebrado de ponta a ponta.** O middleware expunha o arquivo em
   `req.uploadedFile`, mas os controllers liam `req.file`: qualquer envio de
   mídia ou documento respondia 500.
2. **Lista de tipos errada para mídia.** O upload aplicava sempre a lista de
   documento, de modo que imagem e vídeo — o caso principal da rede social —
   seriam recusados mesmo com o handle correto.
3. **Juiz legítimo recusado no painel.** A checagem carregava o usuário sem os
   vínculos de organização e via apenas o papel global, recusando quem tinha o
   papel de juiz concedido pelo tenant.
4. **Colisão ao versionar resultado.** Publicar depois de uma correção
   colidia na constraint `(resultId, version)`.
5. **Identificador repetido no mesmo arquivo derrubava a importação.** A
   segunda ocorrência colidia na chave do item em vez de ser marcada como
   duplicada.
6. **Publicação privada vazava por 403.** Apagar publicação alheia respondia
   403, confirmando a existência de um post que o usuário não podia ver.
7. **Busca devolvia o CPF consultado.** O termo voltava no eco da resposta,
   reintroduzindo o número em log e histórico logo depois de tê-lo protegido.
8. **`/ready` mentia sobre o banco.** O processo não carregava o `.env`, então
   só o Prisma enxergava a URL e a sonda reportava banco "desconhecido".
9. **Descarte de colocação com guarda inventada.** O motor exigia sobrar ao
   menos três votos após o descarte — regra que não estava em regulamento
   nenhum e tornava a configuração do organizador inócua.
10. **Auditoria da rota de rotas passando por engano.** A primeira versão do
    teste presumia o prefixo `/api/v1` e percorria caminhos inexistentes.

Todos corrigidos, cada um com o teste que o teria pego.

---

## 12. Pendências

- **Realtime.** Mensagens e notificações são carregadas sob demanda, com
  paginação por cursor. Não há polling curto. A troca por um canal de tempo
  real é aditiva e não muda o modelo de dados.
- **RLS em runtime.** As políticas estão criadas, aplicadas e testadas contra o
  banco com papel sem `BYPASSRLS`, e `withUserContext` está disponível. O
  processo da API conecta como dono do schema: a autorização efetiva em runtime
  é a da camada de service, com o RLS como barreira de banco. Rodar a API sob
  `mci_app` exige passar cada consulta por `withUserContext`.
- **Limpeza de stories vencidos.** A expiração é aplicada na consulta — um
  story vencido nunca aparece —, mas o registro permanece no banco até que uma
  rotina de limpeza seja adicionada.
- **Analytics esportivo** limita-se aos painéis administrativo, operacional e
  do atleta. Não há relatório exportável.
- **`deepmerge-ts@7.1.5`** carrega advisory de esgotamento de pilha e chega por
  `@prisma/config`, que a fixa em versão exata. Nenhum release 6.x do Prisma a
  atualiza. Forçar por override mexeria por dentro do CLI de migration para
  mitigar um caminho que só roda em desenvolvimento, sobre configuração nossa,
  sem entrada de terceiros. Não alcança o runtime nem dado de usuário. Revisar
  quando o Prisma 7 for avaliado.
- **Publicações do evento não têm tela.** A rota pública passou a devolvê-las
  (a consulta existia e o resultado era descartado), mas a página do
  campeonato ainda não tem aba para exibi-las.
- **Imagem Docker nunca construída.** O `Dockerfile` e o `.dockerignore` estão
  escritos e comentados, mas o ambiente não tem daemon Docker: `docker build`
  não foi executado e a imagem não foi verificada. O comando do `HEALTHCHECK`
  esse sim foi testado contra um servidor real. Tratar o primeiro build como
  parte do trabalho de deploy, não como formalidade.

---

## 13. Blockers

**Nenhum.** O bloqueio anterior — acesso do Claude ao repositório no GitHub —
foi resolvido pelo titular. O push foi feito e a CI rodou verde.

Nenhum outro bloqueio. PostgreSQL foi encontrado no ambiente, iniciado e usado
de verdade: migrations aplicadas, RLS executado e testado, suíte inteira rodando
contra banco real.

---

## 14. Financeiro

```
ZERO MÓDULOS FINANCEIROS
ZERO PAGAMENTOS
ZERO CARTÃO
ZERO COBRANÇA
ZERO DADOS FINANCEIROS
```

Verificado por `tests/financeiro-ausente.test.mjs`, que confere o schema, o
**banco real** (tabelas e colunas), os arquivos de `src/`, as rotas
registradas, o `.env.example` e a configuração de ambiente. A CI repete a
checagem por nome de arquivo em `src/` e `frontend/src/`. A auditoria de rotas
confirma que nenhuma rota financeira está registrada entre os 173 endpoints.

---

## 15. Status

```
NOT PRODUCTION READY
```

O critério de PRODUCTION READY exige que as funcionalidades críticas estejam
verificadas em ambiente equivalente ao de produção. O que foi de fato
executado e comprovado nesta sessão:

- build do frontend, sintaxe do backend e migrations aplicadas: **sim**;
- 171 testes de backend e 25 de frontend passando contra PostgreSQL real:
  **sim**;
- RLS criado, aplicado, executado e testado: **sim**;
- segurança e testes negativos: **sim**;
- 173 rotas percorridas sem erro de servidor: **sim**;
- ausência de camada financeira: **sim**;
- nenhum blocker de código: **sim**.

O que falta para a declaração:

1. ~~Push e CI verde no repositório.~~ **Concluído.** O código está no GitHub e
   a pipeline rodou verde contra PostgreSQL 16.15 real, com ESLint como gate e
   as políticas de RLS executadas por um papel sem `BYPASSRLS`.
2. **Deploy em ambiente de produção real** — PostgreSQL gerenciado, storage de
   objetos no lugar do disco local, papel `mci_app` provisionado — com as
   migrations aplicadas ali. **Não executado:** depende de destino de
   hospedagem e de credenciais, que não são pedidas por chat.

   O que foi possível fazer sem o destino, foi feito: o runbook completo está
   em `docs/DEPLOY.md`, o `Dockerfile` está escrito (mas **não construído**), e
   a partida em produção deixou de aceitar disco efêmero em silêncio — hoje
   `STORAGE_DRIVER=local` exige assunção explícita do risco, sob pena de o
   processo recusar-se a subir.

3. **Homologação da regra esportiva** pela comissão técnica: método de
   apuração, uso ou não de descarte, painel mínimo para o descarte, ordem dos
   desempates, procedimento para empate irresoluto e tabela de pontos por
   temporada. O sistema não presume nenhum deles. **Não executado:** é decisão
   do comitê técnico do Muscle Contest, e inventar regra esportiva seria pior
   do que não ter nenhuma.

   O que foi possível fazer sem o comitê, foi feito: `docs/HOMOLOGACAO-ESPORTIVA.md`
   enumera as 7 decisões pendentes, e cada uma vem com a demonstração numérica
   do seu efeito — inclusive dois casos em que a mesma prova, com os mesmos
   votos dos mesmos juízes, entrega campeãs diferentes conforme a configuração.
   Ratificar passa a ser ler os casos e apontar qual comportamento é o do
   regulamento.

Nenhum desses dois é defeito de código. São etapas que dependem de acesso e de
decisão de regulamento; o que cabia ao software para recebê-las está pronto e
verificado.

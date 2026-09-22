# Gestão do atleta — perfil, documento, histórico importado e recado

Este documento descreve o que existe HOJE no sistema para administrar um
atleta: onde fica cada coisa, o que cada ação faz e — principalmente — o que
cada uma **não** faz.

Ele não inventa regra esportiva. As regras homologadas continuam em
`docs/HOMOLOGACAO-ESPORTIVA.md` e a apuração em
`docs/PONTUACAO-DA-TEMPORADA.md`.

---

## 1. Onde fica

| O que | Caminho na interface | Permissão |
|---|---|---|
| Lista de atletas | `Administração → Atletas` | `athletes.manage` |
| Perfil do atleta | `Administração → Atletas → Abrir` | `athletes.manage` |
| Recados aos atletas | `Administração → Mensagens` | `athletes.manage` |
| Autocadastro (abrir/fechar) | `Administração → Configurações → Organizações` | `organizations.manage` |

O recado que o atleta recebe aparece **por cima da tela**, na primeira vez que
ele abre o aplicativo depois de a mensagem ser publicada.

---

## 2. A lista de atletas

Busca por nome, nome esportivo e — para quem tem `search.sensitive` — por CPF,
sempre como **igualdade exata**, nunca como prefixo que permita varredura.

Três coisas que a lista deliberadamente **não** faz:

* **não mostra documento**, nem mascarado. Uma fila de duzentos nomes com CPF
  ao lado é um vazamento esperando um print;
* **não põe o termo buscado na URL.** Em URL ele ficaria no histórico do
  navegador, no cabeçalho `Referer` e no log de acesso do servidor — três
  lugares fora do alcance do RLS;
* **não filtra no cliente.** Estado e entidade de filiação são parâmetros da
  consulta; recortar no navegador traria a base inteira para a máquina do
  operador só para esconder metade dela.

---

## 3. O perfil

Quatro abas: **Resumo**, **Cadastro**, **Histórico esportivo**, **Histórico
importado** e **Pontuação**.

### 3.1 O CPF

Aparece **mascarado**, sempre. A tela mostra o que recebeu e nunca desmascara
por conta própria.

Para ver o número inteiro o operador **pede**: `POST /athletes/:id/cpf`.

* é `POST`, e não `GET`, porque o ato é auditável e porque `GET` convida
  cache, prefetch e registro em log intermediário para uma resposta que
  carrega documento;
* o id do atleta vai no **caminho**; o número volta no **corpo**. Nunca em URL
  nem em parâmetro de consulta;
* exige `athletes.read_sensitive` **e** `search.sensitive`, conferidas contra
  a organização **do atleta**;
* grava `ATHLETE_CPF_VIEW` na auditoria **antes** de responder. Recusa não
  grava nada, porque leitura não houve.

> **Nota sobre as duas permissões.** Na matriz atual, todo papel que tem
> `athletes.read_sensitive` também tem `search.sensitive` — e é coerente que
> tenha, porque quem opera inscrição, check-in e pesagem confere documento na
> porta do evento. A segunda conferência existe porque EXPRESSA a regra, e
> passa a morder no dia em que um papel separar as duas.
> `tests/revelar-cpf.test.mjs` fixa esse fato e reprova nesse dia, dizendo o
> que fazer.

### 3.2 Editar

Edita nome, nome esportivo, nascimento, cidade, estado, telefone, e-mail,
matrícula, número de atleta, sexo e entidade de filiação.

Só o que **mudou** é enviado, e campo esvaziado vai como `null`.

Dois campos **não** se editam por aqui:

* **CPF** — é a identidade pela qual o histórico oficial reconhece a pessoa;
  trocá-lo por formulário seria trocar de pessoa;
* **equipe** — o vínculo tem trava de unicidade e histórico próprios, e sai
  por `POST /athletes/:id/team` ou pela transferência, que exige outra
  permissão. O servidor **recusa** `teamId` com mensagem, em vez de
  descartá-lo em silêncio.

### 3.3 Estado: suspender, reativar, arquivar

| Ação | Exige motivo | O que muda |
|---|---|---|
| Suspender | sim | `status = SUSPENDED` |
| Arquivar | sim | `status = ARCHIVED` |
| Reativar | opcional | `status = ACTIVE` |

**Nada disso toca histórico esportivo.** Pontuação, resultado, inscrição e
título continuam inteiros nos três estados. O motivo, o autor e a data ficam
na auditoria.

A tela só oferece a ação que cabe no estado atual: atleta ativo não tem
"Reativar", arquivado não tem "Arquivar".

O estado é **dado restrito**, e não público: que um atleta está suspenso é
decisão interna da federação, e publicá-la na vitrine seria a plataforma
divulgando uma sanção que a organização não mandou divulgar.

### 3.4 Excluir

Só passa enquanto **não houver histórico esportivo**. O servidor confere sete
tabelas — lançamento de pontuação, ranking, projeção pública, resultado,
inscrição, resultado importado e título de Overall — e, havendo qualquer uma,
responde `409 ATHLETE_HAS_HISTORY` dizendo **o que** impede, **quanto**, e
apontando o arquivamento.

A tela não tenta adivinhar: ela chama, e mostra a recusa como ela vem.

---

## 4. O histórico importado

O MCI carrega resultado oficial **antes** de a pessoa se cadastrar — foi assim
com os 191 lançamentos do Ipiranga. Quando o atleta aparece, alguém precisa
responder "este histórico é seu?".

### 4.1 As três portas

| Porta | Quando | Chave |
|---|---|---|
| Automática | ao aprovar um cadastro | CPF, ou filiação + matrícula |
| Revisão de lote | linha a linha, na importação | decisão do operador |
| Perfil do atleta | `Administração → Atletas → Histórico importado` | decisão do operador |

### 4.2 O nome nunca reconhece

`GET /athletes/:id/imported-history` devolve as identidades já vinculadas e as
**candidatas**, cada uma com os resultados que carrega — evento, categoria,
classe, colocação e pontos. A pista vem classificada:

* `AFFILIATION_NUMBER` — a entidade e o número batem. É a chave pela qual o
  resultado oficial identifica o atleta;
* `NAME` — só o nome normalizado bate.

Toda sugestão vem com `exigeConfirmacaoHumana: true`, e quando mais de uma
identidade sem dono tem o mesmo nome, com `homonimos: true`. **Duas atletas
chamadas "Ana Silva" existem**, e fundir as duas numa carreira só é o erro que
aparece meses depois, quando a prejudicada vai ver o próprio histórico.

A confirmação é **lado a lado**: o cadastro do MCI contra a identidade
importada, com entidade, matrícula e a lista inteira de resultados. Confirmar
um nome é confirmar um homônimo.

### 4.3 O que o vínculo não faz

`POST /athletes/:id/imported-history/:externalAthleteId/link` **preenche
ponteiro**. Não cria `RankingPoint`, não altera valor, não reescreve a súmula.
O agregado da temporada é refeito porque aqueles pontos passaram a ter dono —
com o mesmo total.

Recusa:

* identidade de outra organização → `404`;
* identidade que já tem outro dono → `409 EXTERNAL_ATHLETE_ALREADY_LINKED`;
* sem `musclewar.review` → `403`;
* repetir o mesmo vínculo → `200` com `alreadyLinked`, zero efeito.

### 4.4 Um limite declarado

A comparação por nome exige trazer as linhas para a aplicação — o banco não
desacentua sem extensão. A varredura tem teto de **500 identidades sem dono**,
e a resposta traz `varreduraTruncada`. A tela avisa e aponta a revisão de
importação. Uma sugestão que não apareceu é melhor dita do que suposta.

---

## 5. O recado da federação

Não é notificação e não é publicação. Notificação nasce de um evento que
aconteceu com **uma** pessoa; publicação entra num feed que se rola. Isto é um
recado da organização para **todos** os seus atletas, que precisa ser visto
antes de o atleta fazer qualquer outra coisa.

### 5.1 Campos

| Campo | Padrão | O que faz |
|---|---|---|
| Título | — | obrigatório, até 140 caracteres |
| Texto | — | obrigatório, até 4.000 caracteres; linha em branco separa parágrafos |
| Começa a aparecer em | vazio = agora | fora da janela o recado não sai |
| Deixa de aparecer em | vazio = até ser desativado | idem |
| Repetição | uma vez por pessoa | ou toda vez que ela entrar |

### 5.2 Três decisões

* **A validade é do recado**, e não da memória de quem o publicou. Um aviso de
  setembro exibido em dezembro é ruído, e ninguém lembra de apagar.
* **"Uma vez" é o padrão.** Repetir o mesmo aviso a cada acesso ensina o
  atleta a fechá-lo sem ler — e aí o aviso seguinte, o que importava, morre
  junto.
* **A leitura é de quem leu.** A política de RLS exige que o usuário da linha
  seja o da sessão: ninguém marca leitura no lugar de outro. Numa federação,
  "eu não fui avisado" é disputa real.

### 5.3 Apagar

Só passa enquanto ninguém tiver lido. Depois da primeira leitura, a marcação é
o registro de que a pessoa foi comunicada — apagar o recado apagaria esse
registro. Quem quer tirar do ar **desativa**.

### 5.4 Quando ele aparece

O recado é buscado quando a **aplicação abre**. Quem já está com ela aberta o
recebe na próxima vez que abrir. É mensagem de abertura, e não alerta em tempo
real.

---

## 6. O autocadastro

`Organization.selfRegistrationOpen` nasce **falso**: a federação começa fechada
para cadastro espontâneo. Enquanto estiver fechada,
`GET /public/affiliations` não devolve nada, e a tela de solicitação do atleta
mostra o campo "Entidade de filiação" vazio.

O interruptor fica em `Administração → Configurações → Organizações`.

---

## 7. Onde isto é medido

| Suíte | O que tranca |
|---|---|
| `tests/estado-do-atleta.test.mjs` | suspender, reativar, arquivar, excluir com histórico |
| `tests/revelar-cpf.test.mjs` | quem revela CPF, auditoria, cross-tenant, a matriz de papéis |
| `tests/historico-importado-do-atleta.test.mjs` | sugestões, vínculo manual, não-regressão do ledger, concorrência |
| `tests/mensagem-de-abertura.test.mjs` | validade, `showOnce`, leitura, RLS, auditoria |
| `frontend/src/pages/perfilDoAtleta.test.jsx` | CPF nunca desmascarado pela tela, botões por estado |
| `frontend/src/pages/listaDeAtletas.test.jsx` | documento fora da listagem, termo fora da URL |
| `frontend/src/pages/historicoImportado.test.jsx` | confirmação lado a lado, aviso de homônimos |
| `frontend/src/pages/mensagemDeAbertura.test.jsx` | um recado de cada vez, fechar é ler, corpo é texto |
| `scripts/qa/mutantes-atleta.mjs` | 18 mutantes, 1 declarado equivalente com investigação |
| `scripts/qa/responsividade.mjs` | Chromium real: fluxo inteiro + doze larguras |

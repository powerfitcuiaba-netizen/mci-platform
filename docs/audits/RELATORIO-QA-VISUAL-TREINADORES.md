# QA VISUAL EM NAVEGADOR REAL — MÓDULO TREINADORES & EQUIPES

Fase executada antes de qualquer publicação, a pedido da administração do
projeto. O objetivo era único: **ver as telas funcionando num navegador de
verdade**, porque era a ressalva técnica expressamente aberta no relatório do
módulo. Nada foi publicado, promovido nem implantado.

## 1. IDENTIFICAÇÃO

| item | valor |
| --- | --- |
| Ramo | `claude/mci-platform-muscle-contest-o6haz9` |
| Commits do módulo (locais, já existentes) | `8906cff`, `8536d29` |
| Commit desta fase de QA visual (local) | `95979aa` |
| Commit anterior ao módulo | `13b8bc8` |
| Navegador | Chromium (Playwright), executado com `--no-sandbox` |
| Ambiente | API `http://127.0.0.1:4611/api/v1`, web `http://127.0.0.1:5611` |
| Banco | `mci_qa_treinadores` — banco LOCAL e isolado, criado e semeado pelo próprio gate |
| Dados | **sintéticos**, prefixados `QA`, gerados a cada execução |
| Produção | **não tocada**: nenhuma requisição, nenhuma conta, nenhuma migration |

Os dois commits do módulo **não foram alterados, refeitos nem descartados**. As
correções desta fase são um trabalho novo, em cima deles.

## 2. O QUE FOI EXECUTADO

O gate é versionado em `scripts/qa/visual-treinadores.mjs`. Ele sobe a API, o
banco de QA e o frontend construído, semeia os seis perfis, e conduz os quatro
fluxos obrigatórios num navegador real. Reaproveita o Playwright e o Chromium já
instalados no ambiente (`/opt/node22/lib/node_modules/playwright`,
`/opt/pw-browsers`), como o gate de responsividade já existente
(`scripts/qa/responsividade.mjs`) faz.

### A — Treinador (11 verificações de conteúdo + 59 de layout)

| id | verificação | veredito |
| --- | --- | --- |
| A1 | treinador entra e a barra lateral aparece | PASS |
| A2 | painel do treinador nas 8 larguras | PASS |
| A3 | aprovado **e autorizado** recebe o botão de convidar (R-04) | PASS |
| A4 | diálogo de convite nas 8 larguras | PASS |
| A5 | busca por matrícula devolve o atleta e **não** mostra CPF (R-05) | PASS |
| A6 | atleta com pedido pendente tem o convite bloqueado na tela | PASS |
| A7 | o painel mostra a equipe e os atletas vinculados | PASS |
| A8 | o painel **não** fala de CPF nem de documento (R-05) | PASS |
| A9 | o convite enviado aparece na lista de convites | PASS |
| A10 | o ranking avisa que está **em homologação** (§8.3) | PASS |
| A11 | o painel **não** apresenta posição de treinador (§8.3) | PASS |
| A12 | cadastro em análise mostra o estado e **não** oferece convidar (R-03) | PASS |
| A13 | painel em análise nas 8 larguras | PASS |
| A14 | o painel não provoca recusa na projeção do ranking | PASS |

### B — Atleta (9 verificações + 20 de layout)

| id | verificação | veredito |
| --- | --- | --- |
| B1 | tela Minha equipe nas 8 larguras | PASS |
| B2 | o convite mostra a equipe e o treinador solicitante | PASS |
| B3 | a **consequência** do vínculo é dita antes do botão | PASS |
| B4 | confirmar e recusar têm o mesmo peso visual | PASS |
| B5 | confirmar é alcançável por teclado | PASS |
| B6 | o foco é visível (sombra medida no elemento focado) | PASS |
| B7 | confirmar pedido de OUTRO atleta é recusado — HTTP 404 | PASS |
| B8 | depois de confirmar, a tela mostra o histórico e não o convite | PASS |
| B9 | o vínculo existe no banco depois da confirmação pela tela | PASS |

### C — Administração central (13 verificações + 79 de layout)

| id | verificação | veredito |
| --- | --- | --- |
| C1 | mesa central nas 8 larguras | PASS |
| C2 | a fila mostra o cadastro em análise | PASS |
| C3 | a fila oferece aprovar e não aprovar | PASS |
| C4 | a delegação central aparece com escopo e prazo (R-02) | PASS |
| C5 | a listagem mostra **contagem** de documentos, não o documento (R-05) | PASS |
| C6 | diálogo de decisão nas 8 larguras | PASS |
| C7 | aprovar pela tela muda o estado no banco — `status=APPROVED` | PASS |
| C8 | diálogo de delegação nas 8 larguras | PASS |
| C9 | o diálogo só oferece a permissão delegável (`athletes.transfer`) | PASS |
| C10 | diretor de evento **não** transfere — HTTP 403 (R-02) | PASS |
| C11 | delegado com concessão viva transfere — HTTP 200 (R-02) | PASS |
| C12 | a auditoria mostra as ações do módulo | PASS |
| C13 | auditoria nas 8 larguras | PASS |

### D — Ranking (4 verificações)

| id | verificação | veredito |
| --- | --- | --- |
| D1 | `GET /ranking/coaches` responde **409** | PASS |
| D2 | a recusa diz que a fórmula não foi homologada | PASS |
| D3 | a projeção não apresenta total nem posição de treinador | PASS |
| D4 | o apelido `/coaches/ranking` não existe — HTTP 404 | PASS |

### E — Idiomas

PT-BR, EN e ES conferidos com o painel do treinador carregado: `PASS` nos três.

### F — Console e rede, nos quatro perfis

`PASS` em todos: nenhum erro de console de mesma origem e nenhuma falha de rede
ou 5xx. As exclusões estão registradas na §7.

### G — Página de CONTROLE (atribuição)

`admin/atletas` — tela anterior a este módulo, mesmo sistema de componentes — foi
medida na **mesma execução**, no mesmo navegador e nas mesmas 8 larguras. Serve
para separar o que é regressão do módulo do que é dívida anterior do produto.

## 3. MATRIZ DE RESOLUÇÃO

Oito larguras, todas com altura 900: **360, 390, 430, 768, 1024, 1280, 1440,
1920**. Em cada largura e em cada tela o gate mede:

- rolagem horizontal do documento (`scrollWidth > innerWidth`);
- elementos cuja borda direita passa da viewport **e que não estão dentro de um
  contêiner rolável** (um `.table-wrap` rolando de lado é projeto, não defeito);
- alvo de toque mínimo de **40px** de altura em 360, 390 e 430 (onde o ponteiro é
  o dedo), sobre `button`, `a[href]`, `input`, `select`, `textarea` e
  `[role="button"]`;
- o conteúdo esperado da tela em 390, lido da região `<main>` e dos diálogos.

Resultado nas telas do módulo: **nenhuma rolagem lateral, nenhum estouro de
viewport e nenhum alvo de toque abaixo de 40px em nenhuma das 8 larguras.**

## 4. EVIDÊNCIAS

Em `docs/audits/qa-visual-treinadores/`:

- `evidencias.json` — as 229 linhas com rótulo, veredito e detalhe, mais ambiente,
  navegador, larguras e o instante da execução;
- 26 capturas de tela, em 390 e 1440, **todas com dados sintéticos**:
  `a2-painel-treinador`, `a4-modal-convite`, `a5-busca-matricula`,
  `a13-painel-em-analise`, `b1-minha-equipe`, `b6-foco-confirmar`,
  `b8-vinculo-confirmado`, `c1-mesa-central`, `c6-dialogo-decisao`, `c7-aprovado`,
  `c8-dialogo-delegacao`, `c9-delegacao`, `c13-auditoria`, `e1-idioma-{pt-BR,en,es}`,
  `g1-controle-admin-atletas-390`;
- `api.log` — a saída do servidor durante a execução. Conferido: **não contém
  token, senha nem segredo**.

Nenhuma captura contém dado pessoal real: os nomes são `QA Treinadora Marta`,
`QA Carla Souza`, `QA Marina Alves`, `QA Joana Ferreira`, e as contas são
`qa.*@mci.local`.

## 5. DEFEITOS ENCONTRADOS E CORRIGIDOS

Cinco defeitos, todos encontrados **no navegador** e nenhum deles visível aos
testes de unidade — porque quatro dependem de largura e layout, e o quinto
depende da ordem em que duas respostas chegam.

### D1 — Faixa de botões vazando do cartão (8 larguras)

`.modal-actions` carrega margem horizontal **negativa**, para cancelar o padding
do diálogo. Três usos dessa classe estavam **fora de diálogo**, dentro de
`.card`: a faixa ultrapassava o cartão em todas as 8 larguras.

Correção: classe própria `.acoes-do-cartao` — a mesma faixa, sem o deslocamento
negativo e sem o `sticky`, que só faz sentido em conteúdo que rola num diálogo.
No telefone os botões se esticam, como os do diálogo já fazem.

### D2 — Tabelas sem contêiner rolável (360, 390, 430)

Seis `<table class="table">` estavam sem o embrulho `.table-wrap`, que é quem
tem `overflow-x: auto`. Sem ele a tabela empurrava o documento inteiro para fora
da viewport nas três larguras de telefone.

Correção: as seis tabelas passaram a morar dentro de `.table-wrap`, como
`adminAtletas.jsx` já fazia.

### D3 — `select` com 23px de altura contra o piso de 40px

Dois `select` avulsos não tinham classe nenhuma, e o `select` cru mediu **23px**.
Correção: `.select-control`, a classe que o projeto já usa para isso (com
`min-height: 40px`, e 46px em ponteiro grosso).

**Atribuição:** o mesmo `select` cru de 23px aparece na tela de CONTROLE
`admin/atletas` (G3, nas três larguras de toque). Ou seja: **é padrão anterior ao
módulo, e continua lá.** Corrigi apenas as telas do módulo; a dívida da tela
antiga está na §9 e não foi mexida às escondidas nesta fase.

### D4 — 422 a cada carregamento do painel do treinador

O cartão de ranking chamava `GET /coaches/:id/ranking/projection` **sem
temporada** e engolia a recusa num `catch`. Duas consequências: a tabela de
equipes nunca aparecia, e o console acumulava um 422 por carregamento.

A recusa do servidor está **certa** — somar temporadas diferentes não significa
nada — e por isso o contrato `422 SEASON_REQUIRED` foi preservado. Quem errava
era a tela: ela agora resolve a temporada antes de perguntar, como a tela pública
de ranking faz, e oferece o seletor quando há mais de uma. A verificação A14 é a
trava dessa regressão.

### D5 — A lista de convites ficava vazia para sempre

`useState(equipes[0]?.id)` lê a lista **uma vez**. Quando
`GET /coaches/me/teams` responde depois de `GET /coaches/me` — ordem que o
navegador decide, não o código —, o estado nascia vazio e nunca se corrigia: o
painel dizia "Nenhum convite enviado" **sem uma única chamada** a
`GET /membership-requests`. O treinador não via os convites que acabara de enviar.

É o pior tipo de defeito: aparecia e desaparecia conforme o tempo de resposta —
passou numa execução do gate e falhou na seguinte, sem mudança de código no
caminho. Medido com sonda direta no navegador: `Convites enviados / Nenhum
convite enviado`, e a lista de requisições sem `GET /membership-requests`.

Correção: a equipe escolhida passou a ser **derivada** (`teamId || equipes[0]?.id`),
nos dois lugares que tinham o mesmo padrão — a lista de convites e o diálogo de
convite, onde a consequência seria pior ainda (o pedido sairia sem equipe).

### O que NÃO foi feito nas correções

- nenhum contrato de API mudou; nenhuma permissão foi afrouxada;
- nenhuma regra esportiva foi tocada;
- a fórmula do ranking de treinadores **continua não implementada** (§8.3);
- nenhum teste foi removido, marcado como pendente ou enfraquecido;
- nada no backend, no schema ou em migrations foi alterado — o diff desta fase é
  `frontend/src/pages/treinadores.jsx`, `frontend/src/pages/treinadores.test.jsx`,
  `frontend/src/styles.css` e o gate novo.

## 6. DEFEITOS DO PRÓPRIO INSTRUMENTO (corrigidos, e vale registrar)

Um gate que mede errado é pior que nenhum gate, porque produz confiança falsa nas
duas direções. Quatro erros meus, medidos e corrigidos:

1. **Conteúdo lido do `body`.** `body.innerText.slice(0, 600)` era barra superior
   e menu: toda afirmação de conteúdo passava ou falhava pelo MENU, não pela
   tela — inclusive a de idioma, que é o mesmo menu traduzido. Passou a ler a
   região `<main>` e os diálogos (que o `Modal` monta fora dela, no `body`).
2. **Idioma sem recarregar.** A preferência é lida na partida do provedor;
   navegar trocando só o `#` não remonta nada. Sem `reload`, a verificação media
   a tela em português e chamaria de falha de tradução o que era falha do teste.
3. **Uma aba por página, e não por contexto.** Páginas do mesmo contexto
   compartilham `localStorage` — e com ele o token. Cinco perfis entrando em
   sequência deixavam o token do último para todos; bastou uma recarga para a aba
   do treinador reabrir como administração central e `GET /coaches/me` devolver
   404. Agora cada perfil tem contexto próprio, que é o que corresponde à
   realidade: pessoas diferentes, navegadores diferentes.
4. **Espera por tempo em vez de por conteúdo.** A lista de convites chega depois
   do resto da tela; esperar 600 ms fixos fazia a verificação piscar. Agora
   espera-se pelo conteúdo, com teto — e o que reprova é a conferência, não a
   corrida. Foi essa troca que expôs o defeito D5 como defeito real.

## 7. CONSOLE E REDE

**Nenhum erro de console de mesma origem e nenhuma falha de rede ou 5xx** nos
quatro perfis (F1 e F2, `PASS` nos quatro).

Três classes de ocorrência ficaram **fora do cômputo**, cada uma com causa
verificada fora do módulo, e todas registradas nas evidências (F3) para que a
exclusão possa ser conferida em vez de aceita:

| ocorrência | causa | por que não é defeito do módulo |
| --- | --- | --- |
| `fonts.googleapis.com` — `ERR_CERT_AUTHORITY_INVALID` | o proxy de egresso deste ambiente intercepta TLS com CA própria | artefato da caixa; a fonte cai no fallback declarado e a tela continua legível |
| `fonts.googleapis.com` — `ERR_ABORTED` | a navegação cancela a requisição em voo | comportamento do navegador |
| `GET /auth/me` — `ERR_ABORTED` | idem, ao trocar de rota | comportamento do roteador |

A exclusão é por **origem**, não por mensagem: erro de certificado na própria API
seguiria sendo acusado. As recusas da API (4xx) continuam registradas linha por
linha (F4) e, nesta execução, deram **"nenhuma"** nos quatro perfis.

## 8. RESULTADO MEDIDO

| gate | resultado | como foi obtido |
| --- | --- | --- |
| Gate visual Chromium | **218 PASS, 0 FAIL, 0 NOT TESTED** (`EXIT=0`) | `node scripts/qa/visual-treinadores.mjs` |
| Achados na tela de CONTROLE | 3 (o `select` de 23px em 360/390/430 de `admin/atletas`) | mesma execução |
| Linhas informativas | 8 (exclusões e recusas observadas) | mesma execução |
| Suíte de frontend | **672 testes, 60 arquivos, 0 falhas** | `npx vitest run` em `frontend/` |
| Arquivo do módulo | **21 testes, 0 falhas** | `npx vitest run src/pages/treinadores.test.jsx` |
| Mutante de verificação (D5) | teste **reprova** com o defeito reposto e **passa** com a correção | mutação manual, revertida em seguida |
| ESLint (o equivalente a typecheck neste projeto) | limpo | `npm run lint` |
| Build do frontend | sucesso | `npm run build` em `frontend/` |
| Dicionários PT/EN/ES | 1564 = 1564 = 1564 chaves | contagem direta |
| Suíte de backend | **2138 passaram, 0 falharam, 15 ignorados** (128 arquivos, `EXIT=0`) | `npm test` |

Seis execuções completas do gate foram necessárias. A sequência está registrada
aqui porque cada número intermediário foi medido, e não estimado:

| execução | resultado | o que mudou |
| --- | --- | --- |
| 1 | 124 PASS, 76 FAIL | primeira medição; expôs D1, D2, D3, D4 |
| 2 | 215 PASS, 3 FAIL | correções D1–D4 aplicadas; restaram 3 falhas do instrumento |
| 3 | 213 PASS, 5 FAIL | instrumento corrigido (miolo, recarga) — e apareceu o token compartilhado |
| 4 | interrompida | a recarga derrubou a sessão: contexto compartilhado entre perfis |
| 5 | 217 PASS, 1 FAIL | contextos isolados; a única falha restante era **real** (D5) |
| 6 | **218 PASS, 0 FAIL** | D5 corrigido |

### 8.1 — Suíte de backend

O diff desta fase não toca `src/`, `prisma/` nem as migrations. A suíte foi
executada de todo modo, como rede de segurança: **128 arquivos, 2138 testes
passaram, 0 falharam, 15 ignorados condicionalmente** (`EXIT=0`) — os mesmos
números do relatório do módulo, o que era o esperado para um diff que não toca o
backend.

Os 15 ignorados são condicionais e já estavam assim antes desta fase: nenhum
teste foi desativado aqui.

## 9. PENDÊNCIAS DE HOMOLOGAÇÃO

### 9.1 — A fórmula do ranking de treinadores continua NÃO homologada

Nada mudou aqui, e não podia mudar. A tela diz "Ranking em homologação", não há
total do treinador, não há posição, e `GET /ranking/coaches` responde 409. As
verificações A10, A11, D1, D2 e D3 são a prova de que a ausência é comportamento,
e não pendência de implementação.

### 9.2 — ACHADO NOVO: a auditoria de LOGIN e de cadastro de usuário é recusada pelo RLS

Encontrado nesta fase, no log do servidor — e **não é defeito deste módulo**.

A política `auditoria_escrita` exige
`"userId" IS NOT DISTINCT FROM mci_current_user_id()`. No momento do login e do
cadastro **ainda não há contexto de usuário no banco**: `mci_current_user_id()`
é nulo e o `userId` da linha é o do usuário que acabou de entrar. O `INSERT` é
recusado; `auditService` desfaz o savepoint, **a operação segue** (o login
funciona) e o erro fica só no log da aplicação.

Medido nesta execução: **17 recusas — 11 `LOGIN` e 6 `USER_REGISTER`**. Nenhuma
recusa em ação do módulo Treinadores & Equipes, o que confirma que a política
ajustada na migration `20260926040000` está correta.

**Por que é anterior ao módulo:** a política nasceu em
`20260921000000_vinculo_privado_e_auditoria_inforjavel`, e a alteração desta
entrega apenas **acrescentou** um `OR mci_treinador_autorizado_de(...)` — uma
cláusula a mais numa disjunção não pode recusar o que antes era aceito. A
cláusula que recusa (`userId = mci_current_user_id()`) não foi tocada. Nenhum
teste do repositório afirma que a trilha de `LOGIN` existe, e é por isso que a
perda passou sem ser notada.

**Consequência:** não há trilha de auditoria de entrada no sistema. Para uma
plataforma com dado pessoal de atleta, isso merece decisão explícita.

**Não corrigi nesta fase**, e a razão era de escopo: consertar exige mexer em RLS
ou no caminho de autenticação, fora do módulo desta entrega e fora da autorização
de uma fase de QA visual.

> **Atualização.** Este achado virou tarefa própria e foi corrigido em seguida,
> por autorização expressa. O desenho está em
> `docs/audits/DESENHO-AUDITORIA-DE-AUTENTICACAO.md` e o resultado em
> `docs/audits/RELATORIO-AUDITORIA-DE-AUTENTICACAO.md`. **Nenhuma política de RLS
> foi alterada**: o registro do evento passou a acontecer dentro do contexto do
> ator que a própria autenticação estabelece.

### 9.3 — `select` cru de 23px em telas anteriores ao módulo

`admin/atletas` (G3) tem o mesmo `select` sem classe que eu corrigi nas telas do
módulo. Cabe uma varredura própria pelas telas antigas; não a fiz aqui para não
misturar dívida anterior com a verificação desta entrega.

### 9.4 — A delegação central só funciona para contas que o RLS reconhece

Pendência já registrada no relatório do módulo, reafirmada aqui: falta a decisão
de **quais administradores centrais** recebem o perfil e **como a concessão
formal é feita** (R-02). O gate mede que a concessão viva funciona (C11) e que
quem não a tem é recusado (C10) — mas quem concede, e sob qual ato, é decisão da
administração.

## 10. O QUE NÃO ACONTECEU

Declaração explícita, item por item:

- **Nenhum `git push`.** Os commits seguem apenas no repositório local.
- **Nenhum merge**, nenhuma promoção para `main`, nenhuma release.
- **Nenhum deploy**, nenhum acesso a produção, nenhuma conta ou dado criado lá.
- **Nenhuma migration aplicada em produção.**
- **Nenhum registro real alterado** — atleta, resultado, vínculo, ponto ou
  ranking. O banco usado nasceu e morreu nesta máquina.
- **Nenhum dado pessoal real** em tela, em captura ou em log.
- **Nenhum teste removido**, desativado ou enfraquecido; a suíte cresceu.
- **Nenhum segredo impresso ou versionado.**
- Os dois commits do módulo (`8906cff`, `8536d29`) **permanecem intactos**.

## 11. VEREDITO

**GO COM RESSALVAS** para a revisão final de publicação.

O que sustenta o GO: os quatro fluxos obrigatórios foram executados num navegador
real, nas oito larguras, com dados sintéticos; os cinco defeitos encontrados foram
corrigidos e têm teste de regressão; o gate fecha em `EXIT=0` com 218 PASS e
nenhuma verificação não executada.

As ressalvas são as da §9, e duas delas exigem decisão de quem administra, não de
quem programa: a fórmula do ranking de treinadores (§9.1) e a governança da
delegação central (§9.4). A terceira (§9.2) é um achado novo, anterior a este
módulo, que pede tarefa própria.

Aguardando autorização expressa para publicar.

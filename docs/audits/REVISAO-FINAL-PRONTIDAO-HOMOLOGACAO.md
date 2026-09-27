# Revisão final de prontidão para homologação manual — Treinadores & Equipes

**Para:** Helder Falcão · **Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Data:** 2026-09-27 · **Escopo:** módulo Treinadores & Equipes

Este documento fecha a etapa de mutação e da matriz de leitura e responde, item por item, aos
oito pontos pedidos. Nada aqui foi publicado, nada foi enviado ao repositório remoto, nenhuma
migração rodou em produção, nenhum dado real foi tocado.

Vocabulário desta revisão: **PASS** = executado e verde; **FAIL** = executado e vermelho;
**NÃO TESTADO** = não foi executado, e por isso nada se afirma; **PENDENTE** = depende de
decisão ou autorização sua.

---

## 1. Ponto de partida — SHA, branch e árvore

| O que | Valor |
| --- | --- |
| Branch de trabalho | `claude/mci-platform-muscle-contest-o6haz9` |
| Árvore de trabalho | limpa antes desta revisão (`git status --porcelain` vazio) |
| Commits desta missão | 12, a partir da base `f626f8b` |
| Estado remoto | **nada enviado** — os commits existem só na sua máquina/neste ambiente |

O SHA exato de cada etapa está no rodapé deste documento, escrito no commit que o acompanha.

---

## 2. Os números que os relatórios carregam

Verificado por leitura dos próprios arquivos, não de memória:

| Número | Onde aparece |
| --- | --- |
| `15 mortos, 1 equivalente, 16/16 conforme` (mutação do módulo) | `RELATORIO-FINAL-PRONTO-PARA-HOMOLOGACAO.md`, `RELATORIO-MODULO-TREINADORES-EQUIPES.md`, `RELATORIO-REGRESSAO-E-PERFORMANCE-TREINADORES.md`, `RELATORIO-SEGURANCA-PENTEST-TREINADORES.md` |
| `180 testes` (matriz de leitura: 16 rotas × 11 perfis + 4 invariantes) | `RELATORIO-FINAL…`, `RELATORIO-REGRESSAO…`, `RELATORIO-SEGURANCA…` |
| `28 células` (prova negativa da matriz: com os dois defeitos de volta, 28 células reprovam) | `RELATORIO-REGRESSAO…`, `RELATORIO-SEGURANCA…` |

O "1 equivalente" é o mutante **TE-P2**, declarado equivalente com a razão escrita: nenhuma
rota da aplicação permite ao atleta encerrar o próprio vínculo, então a folga daquela política
não tem caminho por onde ser observada. Matá-lo exigiria um teste de SQL cru, que mediria a
política e não o produto.

---

## 3. A-01 e A-13 — ainda corrigidos, e cobertos

### No código

* **A-01** — `src/services/coachRankingService.js:87` define `assertPodeConsultar`, chamada como
  **primeira linha** de `elegibilidade` (`:112`) e de `projecao` (`:159`). Ela aceita a mesa
  central (`coaches.approve`) e o dono do cadastro; qualquer outra sessão recebe **404**, o mesmo
  que um id inexistente — a recusa não serve de oráculo para descobrir quem é treinador.
* **A-13** — `src/services/partnerService.js:178` define `SELECT_CATALOGO_DE_TECNICOS` com
  exatamente quatro campos e a contagem de atletas, e `listCoaches` (`:183`) usa `select`, não
  `include`. O catálogo não publica mais `status`, motivo de recusa, telefone, e-mail, matrícula,
  revisor, data de revisão nem o elo com a conta de usuário.

### Nos testes — executado agora

```
npx vitest run tests/hardening-auditoria-treinadores.test.mjs tests/matriz-de-leitura-treinadores.test.mjs
 Test Files  2 passed (2)
      Tests  216 passed (216)
   Duration  32.69s
```

**PASS.** 36 testes de endurecimento (blocos A-01, A-02, A-03, A-04, A-05, A-13) + 180 células
da matriz de leitura = 216. A-01 tem 7 testes próprios, incluindo o que prova que o gestor de
ranking de **outra** federação recebe 404 nas duas rotas. A-13 tem 2: um que lista os campos
proibidos e outro que prova que o catálogo continua servindo para escolher um técnico.

### Uma falha encontrada nesta revisão, e corrigida

A primeira execução destas duas suítes **reprovou 5 testes** de A-03 e A-04. A causa não estava
no código do produto: estava no próprio medidor.

`scripts/qa/mutantes-treinadores.mjs`, ao terminar cada mutante, restaurava as políticas
reaplicando **apenas** a migration `20260926040000`. Essa migration cria `atleta_leitura` e
`vinculo_criacao` nas versões **anteriores** a A-03 e A-04, que as migrations `20260927010000`
e `20260927020000` substituíram. Resultado: ao fim da rodada de mutação, o banco de teste ficava
com duas políticas antigas, e as suítes de A-03/A-04 passavam a falhar sem que uma linha de
código tivesse mudado — falha com cara de regressão do produto, causada pela ferramenta.

Pior: o conferidor de políticas do mesmo script esperava que `atleta_leitura` contivesse
`mci_treinador_autorizado_de` — o trecho da versão **antiga**. Ele aprovava exatamente o estado
errado que a restauração incompleta produzia. As duas pontas do controle estavam cegas para o
mesmo desvio.

Duas correções, ambas no medidor, nenhuma no produto:

1. a restauração reaplica a **cadeia** `20260926040000 → 20260927010000 → 20260927020000`;
2. as expectativas de política passam a sair do repositório de hoje — `atleta_leitura` espera
   `mci_treinador_com_equipe_em`, e `vinculo_criacao` entrou na lista esperando
   `TeamMembershipRequest`.

Nenhum mutante toca `atleta_leitura` ou `vinculo_criacao` (eles mexem em `central_leitura` e
`vinculo_alteracao`), então os **vereditos 16/16 seguem válidos**: o defeito sujava o banco
*depois* de cada medição, não durante. O que estava inválido era a garantia de restauração.

**A rodada inteira foi reexecutada com o medidor corrigido.** Resultado real:

```
CONTROLE ANTES: as 6 suítes passam sem mutante.
15 morreram, 1 equivalente(s) declarado(s), 16/16 conforme a expectativa
CONTROLE DEPOIS: todas as suítes de controle voltam a passar — restauração íntegra.
```

E a prova que faltava, que é o estado do banco **depois** da rodada: `atleta_leitura` carrega
`mci_treinador_com_equipe_em` e `vinculo_criacao` carrega a cláusula de `TeamMembershipRequest`
— as versões do repositório, não as antigas. Reexecutando as duas suítes imediatamente após a
rodada: **216/216 PASS**. Antes da correção, era exatamente aí que os 5 testes reprovavam.

---

## 4. As quatro decisões — D-1 a D-4

Cada decisão abaixo está em linguagem comum, com as alternativas reais, o que cada uma custa e
uma **recomendação técnica não vinculante**. Nenhuma delas foi tomada aqui.

### D-1 — O treinador vê atletas da federação, não só da equipe dele

**O problema, em uma frase.** Hoje um treinador aprovado, autorizado na federação e responsável
por uma equipe consegue **ler** dados esportivos de atletas daquela federação, inclusive de
atletas que não são da equipe dele.

**Por que é assim.** Esse alcance não é enfeite: é o que faz funcionar o convite. Para convidar
um atleta, o treinador precisa encontrá-lo pela matrícula — e encontrar é ler. Se a leitura for
estreitada para "só os atletas já vinculados às minhas equipes", duas coisas param de funcionar:
o pedido de vínculo passa a responder 404, e a busca por matrícula passa a responder sempre
"não encontrado".

**O que já foi feito.** A leitura foi estreitada até onde não depende de decisão sua: antes,
bastava estar autorizado na federação; agora é preciso **também responder por uma equipe** dela.
Medido: o conjunto de atletas que o treinador lê é **subconjunto próprio** do que uma requisição
sem sessão já lê publicamente, e o que R-05 protege — CPF e documento — está fora do alcance dele
em qualquer cenário.

**Alternativa A — declarar o propósito na transação.** A requisição passa a dizer "estou aqui
para convidar", e a política de leitura larga só vale nesse caso.
*Impacto:* espalha uma marca de intenção por três serviços. Se alguém esquecer a marca num
caminho novo, a tela não dá erro: ela mostra **lista vazia**. É o defeito exato que este módulo
já teve e que a auditoria achou. Não usa nenhum mecanismo proibido.

**Alternativa B — mudar como o atleta é descoberto para convite.** Por exemplo: o atleta gera um
código de convite, ou o convite passa a ser pedido pelo atleta, ou a federação intermedeia.
*Impacto:* é **regra de produto**, não decisão técnica. Muda o fluxo que o treinador usa hoje.
Este projeto não inventa regra esportiva nem de processo.

**Alternativa C — manter como está, com o limite documentado.**
*Impacto:* o resíduo continua nomeado nos relatórios e medido por teste. Nenhum dado protegido
por R-05 vaza; o que vaza é a existência e os dados esportivos de atletas da mesma federação —
que já são públicos na superfície anônima.

**Recomendação técnica, não vinculante:** **C agora, B depois.** A alternativa A troca um limite
visível e medido por um risco silencioso, e falha em silêncio é pior que limite documentado. B é
a correção certa, mas é decisão sua sobre o produto, não minha.

### D-2 — Os cadastros de treinador que existiam antes do módulo

**O problema, em uma frase.** Antes deste módulo existir, cadastros de treinador podiam estar
gravados como `APROVADO` sem que ninguém da administração central tivesse aprovado — não há
revisor nem data de revisão neles.

**O que a correção faz.** A migration `20260927030000` devolve a `PENDENTE` exatamente os
cadastros aprovados **sem revisor e sem data**. Ela não toca em nenhum cadastro que uma pessoa
aprovou. É idempotente: rodar duas vezes não muda nada na segunda.

**O efeito operacional.** Um treinador em `PENDENTE` não atua: não convida, não acompanha
equipe. Se algum desses cadastros estiver em uso hoje, a pessoa perde acesso no instante em que
a migration roda — e o `preDeployCommand` do Render roda migrações **automaticamente** no próximo
deploy. Por isso este item não é teórico.

**Alternativa A — rodar o diagnóstico primeiro, decidir depois.**
`node scripts/diagnostico-treinadores-legados.js` é **somente leitura**: diz quais cadastros
voltariam a pendente e quais estão em uso. Com a lista na mão, a administração central aprova
formalmente os legítimos antes do deploy, e a migration não tira o acesso de ninguém.
*Impacto:* exige uma janela e acesso autorizado de leitura à produção. É o caminho mais lento e
o único que não surpreende ninguém.

**Alternativa B — deployar e aprovar depois.**
*Impacto:* treinadores legítimos ficam sem atuar entre o deploy e a aprovação. Se houver evento
em andamento, isso aparece como sistema quebrado.

**Alternativa C — não devolver a pendente, aceitar o legado como aprovado.**
*Impacto:* mantém cadastros aprovados por ninguém. Contraria R-03 — aprovar treinador é ato da
administração central — e deixa a trilha de auditoria sem o autor do ato.

**Recomendação técnica, não vinculante:** **A.** O diagnóstico é somente leitura, não altera
nada, e transforma uma surpresa operacional numa lista de aprovações a fazer. C compra paz hoje
ao preço de uma regra homologada.

### D-3 — A tentativa **recusada** de troca de senha não deixa rastro

**O problema, em uma frase.** Quando alguém troca a senha com sucesso, fica registrado. Quando
alguém tenta e **erra a senha atual**, não fica nada — e é justamente a tentativa errada que
interessa a quem investiga.

**Por que não foi corrigido aqui.** Toda requisição autenticada roda dentro de **uma** transação.
Quando a troca é recusada, a transação é desfeita — e o registro da tentativa iria junto. Gravar
esse rastro exige escrever **fora** da transação da requisição. Isso é mudança de mecanismo, não
de regra, e mudar mecanismo de auditoria sem sua autorização não é decisão minha. O desenho está
pronto e descrito em `RELATORIO-CORRECOES-AUDITORIA-TREINADORES.md`, §10.

**Alternativa A — escrever o rastro fora da transação.**
*Impacto:* a tentativa recusada passa a ficar registrada. Custa uma conexão extra no caminho de
erro. O rastro nunca guarda a senha, nem a tentada nem a atual.

**Alternativa B — manter como está.**
*Impacto:* o rastro de troca de senha continua contando só os sucessos. Quem investigar um
comprometimento não vê as tentativas.

**Recomendação técnica, não vinculante:** **A**, mas sem pressa: é melhoria de observabilidade,
não barreira de segurança. Nenhuma senha é aceita por engano hoje; o que falta é a anotação.

### D-4 — A fórmula do ranking de treinadores

**A situação, em uma frase.** Não existe fórmula homologada para pontuar treinadores, e este
trabalho não inventou nenhuma.

**O que o sistema faz hoje.** `FORMULA_HOMOLOGADA = false`. A tela mostra **"Ranking em
homologação"** e a frase que explica que a fórmula ainda não foi homologada pela Muscle Contest.
A rota de classificação **recusa** com 409 e o motivo. A projeção não produz total nem posição:
ela mostra as equipes do treinador e os pontos que essas equipes já têm no ranking de equipes,
que é oficial.

**Alternativa A — homologar uma fórmula.** Você define peso, bônus, quais categorias contam e
como se desempata; o sistema passa a calcular.
*Impacto:* é decisão esportiva da Muscle Contest, com efeito sobre classificação oficial. Fora
do alcance técnico, e eu não vou propor números.

**Alternativa B — manter bloqueado.**
*Impacto:* nenhum. A tela já diz a verdade ao treinador, e não existe número oficial inventado
em lugar nenhum.

**Recomendação técnica, não vinculante:** **B até haver homologação formal.** Enquanto §8.3
estiver bloqueado, qualquer fórmula que eu sugerisse seria invenção com aparência de regra. O
único risco de manter é estético; o de inventar é institucional.

---

## 5. Como subir o ambiente de homologação

Dados **exclusivamente sintéticos**, banco descartável, sem HTTPS, escutando só em `127.0.0.1`.

```
cd <o repositório>
node scripts/qa/visual-treinadores.mjs --manter
```

Se quiser escolher a senha das contas sintéticas:

```
QA_PASSWORD='uma senha só sua' node scripts/qa/visual-treinadores.mjs --manter
```

O que o comando faz, nesta ordem: cria o banco descartável `mci_qa_treinadores`, aplica as 44
migrações, semeia o catálogo oficial, sobe a API, constrói e serve o frontend, e cria as contas e
o estado do módulo **pelas rotas reais** — nada é inserido direto no banco. Ao terminar, ele
imprime o endereço e as seis contas, com a senha, e **fica no ar** até você dar `Ctrl+C`.

Requisitos na sua máquina: Node 22 e PostgreSQL 16 em `127.0.0.1:5432`. **Nenhuma credencial de
produção, nenhum token, nenhuma variável de produção.** Se algum passo pedir senha de produção,
não é este roteiro — pare.

As seis contas sintéticas e o papel de cada uma na homologação:

| Nº | Conta | Estado com que ela nasce |
| --- | --- | --- |
| 1 | **Treinador** | cadastro aprovado, autorizado na Federação QA, responsável pela Equipe QA Alfa |
| 2 | **Em análise** | cadastro de treinador `PENDENTE` — é a conta que prova R-03 |
| 3 | **Atleta** | tem conta e um **convite pendente** da Equipe QA Alfa |
| 4 | **Central** | administração central da Muscle Contest |
| 5 | **Diretor** | operador da Federação QA — quem autoriza atuação por federação |
| 6 | **Delegado** | administrador central com delegação de transferência de atleta |

`Ctrl+C` encerra tudo. O banco é descartado e recriado do zero na próxima execução.

### O comando foi executado, e ele funciona ponta a ponta

Executado neste ambiente de trabalho, para provar que sobe: banco de QA preparado, API no ar,
dados sintéticos semeados pelas rotas reais, frontend construído e servido, e o quadro das seis
contas impresso. Conferido depois de subir:

| Verificação | Resultado |
| --- | --- |
| Frontend responde | **200** |
| `GET /health` da API | **200** |
| Login com a conta sintética de treinador | **200** |

Os e-mails das contas têm um sufixo aleatório a cada execução, e a senha é a padrão de QA
(`QA_PASSWORD` troca ela). **O endereço é local de quem roda o comando**: o que subiu aqui está
dentro do ambiente de trabalho e não é alcançável pela sua máquina. Rode o mesmo comando no seu
computador e o quadro impresso será o seu — com os seus e-mails sintéticos e a sua senha.

Nenhuma das seis contas corresponde a pessoa real. Nenhum atleta, resultado, vínculo ou ponto
real aparece neste ambiente: o banco é o descartável `mci_qa_treinadores`, criado do zero.

---

## 6. Roteiro manual, separado por perfil

Cada passo tem **o que fazer**, **o que você deve observar** e um espaço para **APROVA / NÃO
APROVA**. Se um passo não fizer o que está escrito, **pare nele** e anote — é mais útil que
seguir e relatar tudo no fim.

O menu muda conforme quem está logado: isso é esperado. O que o menu **não** faz é decidir
privilégio — quem decide é o servidor. Por isso vários passos abaixo pedem que você digite a URL
à mão: é assim que se testa se a barreira é de verdade ou só de tela.

### Perfil 1 — Administrador central (conta **Central**)

| # | O que fazer | O que observar | APROVA / NÃO APROVA |
| --- | --- | --- | --- |
| C1 | Entrar e abrir **Treinadores** no menu (`/admin/treinadores`) | A fila de análise aparece com o cadastro **Em análise** | ______ |
| C2 | Aprovar o cadastro **Em análise** | Ele sai da fila e passa a **Aprovado**. A tela **não** pergunta federação: aprovar é nacional | ______ |
| C3 | Tentar recusar um cadastro **sem escrever motivo** | O botão não conclui: o motivo é obrigatório | ______ |
| C4 | Na aba de **delegação central**, abrir **Conceder delegação** | Os campos de **federação** e de **prazo** são obrigatórios. **Não existe** opção "todas as federações" | ______ |
| C5 | Tentar conceder sem escolher federação, ou sem prazo | O botão de confirmar fica indisponível. Não há como criar delegação sem escopo e sem validade | ______ |
| C6 | Conceder a delegação à conta **Delegado**, com federação e prazo | A concessão aparece na tabela com pessoa, permissão, escopo e prazo | ______ |
| C7 | Tentar conceder uma delegação **para si mesmo** | Recusado. Ninguém concede poder a si próprio | ______ |
| C8 | Revogar a delegação criada em C6 | Ela sai da lista de delegações em vigor. O efeito é imediato, não depende de rotina noturna | ______ |
| C9 | Abrir **Auditoria** (`/admin/auditoria`) | Aparecem os registros de aprovação, concessão e revogação, com autor, data e motivo | ______ |
| C10 | Abrir o cadastro de um treinador qualquer na fila (inclusive já aprovado) | A mesa central **vê** nome, registro, equipes, documentos e situação de qualquer treinador — é o trabalho dela (R-03) | ______ |

### Perfil 2 — Treinador (contas **Treinador** e **Em análise**)

| # | O que fazer | O que observar | APROVA / NÃO APROVA |
| --- | --- | --- | --- |
| T1 | Entrar com **Em análise** e abrir **Treinador** (`/treinador`) | A tela diz **"Em análise"** e avisa que, enquanto isso, você não atua em nenhuma federação | ______ |
| T2 | Com **Em análise**, procurar qualquer botão que aprove o próprio cadastro | Não existe. O interessado não muda o próprio estado | ______ |
| T3 | Entrar com **Treinador** e abrir **Treinador** | Aparecem: seus dados, a situação **Aprovado**, **Onde você pode atuar** (Federação QA) e **Minhas equipes** (Equipe QA Alfa) | ______ |
| T4 | Ler o texto de **Onde você pode atuar** | Ele explica que o cadastro é nacional e que atuar numa federação depende da autorização dela. Uma autorização não vale para as outras (R-04) | ______ |
| T5 | Convidar o **Atleta** pela matrícula | O convite é criado. O atleta **não** aparece vinculado ainda — vínculo só existe depois que ele confirmar | ______ |
| T6 | Olhar a lista **Atletas vinculados** | Só dado esportivo e de filiação: atleta, matrícula, equipe, data do vínculo. **Sem CPF, sem documento, sem telefone, sem e-mail** (R-05) | ______ |
| T7 | Abrir **Ranking de treinadores** no painel | Selo **"Ranking em homologação"** e a frase de que a fórmula não foi homologada. **Nenhum total, nenhuma posição oficial** (§8.3) | ______ |
| T8 | Tentar transferir ou desvincular um atleta | Não existe essa ação para o treinador. Transferir é poder central (R-02) | ______ |
| T9 | Procurar, em qualquer tela, uma forma de ver o ranking, as equipes ou os atletas de **outro** treinador | Não existe caminho nenhum na interface. A barreira no servidor (que responde 404 igual para "não existe" e "não é seu", para não servir de oráculo) **não é testável pelo navegador**, porque o token vai no cabeçalho e não na URL: ela está provada pelos 7 testes do bloco A-01 | ______ |
| T10 | Pedir ao **Diretor** que revogue sua autorização na federação, e recarregar | A federação sai de **Onde você pode atuar**, e a leitura dos atletas dela vai com ela — na requisição seguinte, sem esperar nada | ______ |

### Perfil 3 — Administrador de federação (conta **Diretor**)

| # | O que fazer | O que observar | APROVA / NÃO APROVA |
| --- | --- | --- | --- |
| F1 | Entrar e abrir **Treinadores** no menu | A tela abre com a seção **Atuação na sua federação** | ______ |
| F2 | Procurar como aprovar um cadastro de treinador | Não existe. Aprovar cadastro é da administração central (R-03) | ______ |
| F3 | Procurar na tela a fila de análise central e a delegação central | **Não aparecem** — nem como lista, nem como caixa de recusa. A tela do diretor mostra só o que é dele; quem recusa de verdade continua sendo o servidor | ______ |
| F4 | Na seção **Atuação na sua federação**, clicar em **Autorizar atuação** no treinador aprovado | O diálogo já vem com a sua federação, **sem oferecer outra**, e pede o motivo. Confirmado, a situação da linha passa a **AUTORIZADO** | ______ |
| F5 | Verificar se essa autorização valeu para outra federação | Não valeu. Cada federação autoriza a sua (R-04) | ______ |
| F6 | Clicar em **Revogar atuação** | O motivo é obrigatório. Confirmado, a situação vira **REVOGADO** na hora, e o treinador deixa de enxergar os atletas daquela federação | ______ |
| F7 | Tentar conceder delegação de transferência a alguém | Não existe para a federação. Delegação é ato central (R-02) | ______ |
| F8 | Abrir a lista de atletas da federação | O diretor vê os atletas da **sua** federação, e não os de outra | ______ |

### Perfil 4 — Atleta (conta **Atleta**)

| # | O que fazer | O que observar | APROVA / NÃO APROVA |
| --- | --- | --- | --- |
| A1 | Entrar e abrir **Minha equipe** (`/minha-equipe`) | O convite da Equipe QA Alfa aparece, dizendo de quem é o convite | ______ |
| A2 | Ler o aviso antes de confirmar | Ele diz que confirmar cria vínculo **exclusivo**, que enquanto durar nenhuma outra equipe pode incluir você, e que sair depende de decisão da administração central | ______ |
| A3 | Confirmar o vínculo | O vínculo passa a existir. Só agora o atleta aparece na lista do treinador | ______ |
| A4 | Peça ao diretor que crie uma segunda equipe e ao treinador que tente convidar você para ela | A busca por matrícula avisa **"já tem equipe"** antes do pedido, e o pedido é recusado com `ATHLETE_ALREADY_LINKED`. O vínculo é único | ______ |
| A5 | Procurar como sair do vínculo por conta própria | Não existe. Desvincular é ato central (R-02) | ______ |
| A6 | Sair da conta e procurar o seu nome na **lupa do topo** — a busca do cabeçalho, que responde sem sessão | A atleta é encontrada e o CPF **não aparece**, nem inteiro nem mascarado. O documento enviado para análise não é devolvido pela tela nem para quem o enviou | ______ |
| A7 | Recusar um convite (se houver outro pendente) | Ele vai para **Convites anteriores**, com a data da resposta. Recusar não cria vínculo nenhum | ______ |

### Fechamento do roteiro

| Item | Situação |
| --- | --- |
| Passos aprovados | ______ |
| Passos reprovados (liste os códigos) | ______ |
| Observações | ______ |

Quando terminar: `Ctrl+C`. O banco `mci_qa_treinadores` é descartável e recriado do zero na
próxima execução. Nenhum dado real foi tocado em nenhum momento.

---

## 7. O que ainda impede a publicação

### 7.1 Diagnósticos somente leitura — precisam rodar em produção, e ainda não rodaram

Os dois scripts abaixo **só leem**. Nenhum deles escreve, altera, apaga ou recalcula nada.
Nenhum deles imprime `DATABASE_URL`, senha, token ou e-mail. Nenhum deles rodou contra produção
neste trabalho, porque isso exige acesso autorizado — e eu não pedi nem usei credencial alguma.

| Script | Pergunta que ele responde | Situação |
| --- | --- | --- |
| `scripts/diagnostico-treinadores-legados.js` | Quais cadastros de treinador voltam a `PENDENTE` com a migration `20260927030000`, e quais deles estão **em uso** | **NÃO EXECUTADO em produção** |
| `scripts/diagnostico-delegacoes-inertes.js` | Quais delegações centrais hoje vivas **perdem efeito** com a exigência de escopo e prazo (A-02) | **NÃO EXECUTADO em produção** |

O segundo sai com código 1 quando existe decisão humana pendente — de propósito: ele não decide
por você, ele para e mostra.

**Por que isso bloqueia.** A migration `20260927030000` tem efeito operacional imediato sobre
treinadores que podem estar atuando, e o `preDeployCommand` do Render aplica migrações
pendentes **automaticamente** no próximo deploy. Sem a saída do primeiro diagnóstico guardada, o
deploy é uma aposta sobre quantas pessoas perdem acesso.

### 7.2 Backup com restore verificado — pendente

Não basta ter backup: é preciso ter restaurado um, numa base descartável, e conferido que os
dados voltam. Isso exige janela, base de destino e um responsável — e não foi feito aqui.
**PENDENTE.** O procedimento está em `PLANO-MIGRACAO-RENDER-TREINADORES.md`.

### 7.3 Autorizações necessárias — todas suas

| # | Autorização | Para quê |
| --- | --- | --- |
| 1 | **Enviar os commits ao repositório remoto** (`git push`) | Nada foi enviado. Os 12 commits desta missão existem só localmente |
| 2 | **Abrir ou atualizar pull request** | Não foi aberto nenhum |
| 3 | **Rodar os dois diagnósticos somente leitura em produção** | Item 7.1 |
| 4 | **Executar a migração em produção** (ou deployar, que a executa) | As três migrations novas, com atenção à `20260927030000` |
| 5 | **Deploy / publicação** | Nada foi publicado |
| 6 | **Decisões D-1 e D-2** | D-1 define o alcance final de R-05; D-2 tem efeito operacional imediato |

### 7.4 Quadro de critérios

| # | Critério | Situação |
| --- | --- | --- |
| 1 | Doze achados corrigidos, ou reportados com o resíduo nomeado | cumprido |
| 2 | Regressão do backend | **PASS** — 2219/2219, 132 arquivos, 0 falhas |
| 3 | Regressão do frontend | **PASS** — 676/676, 60 arquivos |
| 4 | Lint e build | **PASS** |
| 5 | QA visual em 8 larguras | **PASS** — 218 PASS / 0 FAIL / 0 NÃO TESTADO |
| 6 | Desempenho medido | **PASS** — 13/13 no orçamento deste gate (p95 máximo 19 ms) |
| 7 | Migrações aplicam do zero, `migrate status` em dia | **PASS** — 44 migrações |
| 8 | Prova negativa dos caminhos novos | **PASS** — 14 mutantes desta fase mortos |
| 9 | Mutação pré-existente do módulo | **PASS** — 15 mortos, 1 equivalente, 16/16 conforme |
| 10 | Matriz de leitura por perfil | **PASS** — 180/180, e 28 células reprovam com os defeitos de volta |
| 11 | Inspeção de segredos | **PASS** — 470 arquivos, 0 a explicar, ligada na CI |
| 12 | Restauração de políticas do medidor de mutação | corrigida e **reexecutada** — 16/16 conforme, banco íntegro, suítes 216/216 depois da rodada |
| 13 | **Sua homologação manual** pelo roteiro do item 6 | **PENDENTE** |
| 14 | **Decisões D-1 a D-4** | **PENDENTES** |
| 15 | **Diagnósticos somente leitura em produção** | **PENDENTE** |
| 16 | **Backup verificado por restore** | **PENDENTE** |
| 17 | **Autorização expressa para publicar** | **PENDENTE** |

---

## 8. O que este trabalho não fez

* Não fez `push`, não abriu nem atualizou pull request, não fez merge, não fez deploy.
* Não executou migração em produção, nem diagnóstico remoto, nem qualquer operação com dado real.
* Não alterou, apagou, recalculou nem corrigiu registro real de atleta, resultado, vínculo,
  ponto ou ranking. O cadastro e o histórico de Lucas Gouveia Lima não foram tocados.
* Não criou, mudou nem ponderou fórmula de ranking. §8.3 continua bloqueado.
* Não inventou regra esportiva, categoria, data, local ou informação oficial.
* Não afrouxou RLS, `FORCE ROW LEVEL SECURITY`, autenticação ou autorização para fazer teste
  passar. Nenhum teste foi desativado, marcado como pendente ou excluído.
* Não pediu, imprimiu nem commitou segredo.
* Não fez `force push`, `squash` nem `rebase`. O histórico está preservado.

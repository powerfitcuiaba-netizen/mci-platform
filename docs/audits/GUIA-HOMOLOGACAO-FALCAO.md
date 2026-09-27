# Guia de homologação manual — Treinadores & Equipes

**Para:** Helder Falcão · **Branch:** `claude/mci-platform-muscle-contest-o6haz9` · **HEAD:** `374a317`
**Data:** 2026-09-27

Este é o roteiro para **você** conferir o módulo com o navegador, na sua máquina, com dados
sintéticos. Nada aqui toca produção. Nenhuma senha real é usada, nenhum atleta real aparece.

Cada passo tem **o que fazer**, **o que deve acontecer** e um espaço para **APROVA / NÃO
APROVA**. Se um passo não fizer o que está escrito, **pare nele** e anote — é mais útil que
seguir e relatar tudo no fim.

---

## Parte 1 — Subir o ambiente

### 1.1 O que você precisa na máquina

* Node 22, PostgreSQL 16 rodando em `127.0.0.1:5432`, e o repositório clonado nesta branch.
* Nenhuma credencial, nenhum token, nenhuma variável de produção. Se algum passo pedir
  senha de produção, **não é este roteiro** — pare.

### 1.2 Um comando

```
cd <o repositório>
node scripts/qa/visual-treinadores.mjs --manter
```

Se preferir escolher a senha das contas sintéticas:

```
QA_PASSWORD='uma senha só sua' node scripts/qa/visual-treinadores.mjs --manter
```

O que o comando faz, nesta ordem: cria um banco **descartável** (`mci_qa_treinadores`),
aplica as 44 migrações, semeia o catálogo, sobe a API, constrói e serve o frontend, e cria
as contas e o estado do módulo pelas **rotas reais** — nada é inserido direto no banco.

Ele escuta **só em `127.0.0.1`**: não há HTTPS, e por isso o ambiente não deve receber dado
real nem ficar acessível de fora.

### 1.3 As contas

Quando terminar, a tela imprime o endereço e as seis contas. Use-as assim:

| Nº | Conta | Papel na homologação |
| --- | --- | --- |
| 1 | **Treinador** | cadastro aprovado, autorizado na federação, responsável pela Equipe QA Alfa |
| 2 | **Em análise** | cadastro de treinador `PENDING` — é o que prova R-03 |
| 3 | **Atleta** | tem conta e tem **convite pendente** da Equipe QA Alfa |
| 4 | **Central** | administração central da MuscleContest (`SUPER_ADMIN`) |
| 5 | **Diretor** | operador da Federação QA (autoriza atuação por federação) |
| 6 | **Delegado** | administrador central com delegação de `athletes.transfer` |

Todas usam a mesma senha, impressa junto. `Ctrl+C` encerra tudo; o banco é descartado na
próxima execução.

**APROVA / NÃO APROVA — o ambiente subiu:** ______

---

## Parte 2 — R-03: quem aprova treinador é a administração central

### 2.1 O cadastro nasce pendente e o interessado não muda o próprio estado

1. Entre como **Em análise** (nº 2).
2. Abra o painel do treinador.

**Deve acontecer:** o cadastro aparece como **Em análise**. Não existe campo, botão ou menu
para mudar a situação. Convidar atleta **não** está disponível.

**APROVA / NÃO APROVA:** ______

### 2.2 O diretor da federação NÃO aprova cadastro

1. Entre como **Diretor** (nº 5).
2. Procure a tela de análise de cadastros de treinador.

**Deve acontecer:** a tela **não** oferece aprovar/rejeitar cadastro. Se você chegar nela
por URL, deve ver uma mensagem dizendo que **esta conta não tem permissão para analisar
cadastros de treinador** — e **não** uma fila vazia. A distinção é o achado A-11: "vazio" e
"não é sua alçada" não podem ser a mesma tela.

**APROVA / NÃO APROVA:** ______

### 2.3 A administração central aprova, e a recusa exige motivo

1. Entre como **Central** (nº 4), abra a análise de cadastros.
2. Tente **Não aprovar** sem escrever motivo.
3. Escreva um motivo e conclua.

**Deve acontecer:** sem motivo, a recusa não é aceita — o campo é obrigatório e a tela diz
que o motivo vai para a trilha de auditoria. Com motivo, o cadastro muda de estado.

**APROVA / NÃO APROVA:** ______

---

## Parte 3 — R-04: o cadastro é global; atuar na federação é outra autorização

### 3.1 Aprovado não é autorizado

1. Como **Central** (nº 4), aprove o cadastro da conta nº 2 (se ainda não aprovou).
2. Entre como nº 2 e tente convidar um atleta.

**Deve acontecer:** o cadastro está aprovado e, ainda assim, **não** é possível atuar: falta
a autorização da federação. A mensagem deve dizer para solicitar a autorização à federação —
não um erro genérico.

**APROVA / NÃO APROVA:** ______

### 3.2 Quem autoriza a atuação é a federação

1. Entre como **Diretor** (nº 5) e autorize a conta nº 2 na Federação QA.
2. Volte como nº 2.

**Deve acontecer:** agora a atuação é possível **naquela federação**. Continua sem equipe —
quem atribui equipe é a federação.

**APROVA / NÃO APROVA:** ______

### 3.3 Revogar a autorização tem efeito imediato

1. Como **Diretor** (nº 5), revogue a autorização da conta nº 1 (**Treinador**), com motivo.
2. Entre como nº 1 e abra o painel.

**Deve acontecer:** a lista de atletas fica **vazia**, e a busca por matrícula deixa de
encontrar. Não há espera, não há cache: a revogação vale na requisição seguinte. Reautorize
antes de seguir.

**APROVA / NÃO APROVA:** ______

---

## Parte 4 — O vínculo nasce da confirmação do atleta

### 4.1 O convite

1. Entre como **Treinador** (nº 1).
2. Busque o atleta pela **matrícula completa** `5003` na Federação QA.
3. Envie o convite para a Equipe QA Alfa.

**Deve acontecer:** a busca exige a matrícula **completa** — não há busca por nome nem por
prefixo, e não há lista. Um resultado, ou nenhum. O convite é enviado, e o atleta **não**
fica vinculado por isso.

**APROVA / NÃO APROVA:** ______

### 4.2 A confirmação é do atleta, e a tela avisa a consequência

1. Entre como **Atleta** (nº 3) e abra "Minha equipe".
2. Leia o aviso **antes** de confirmar.

**Deve acontecer:** existe um convite pendente. A tela avisa, antes do botão, que depois de
confirmar **só a administração central da Muscle Contest** desfaz o vínculo — e essa é a
regra R-02, não uma ameaça de interface.

**APROVA / NÃO APROVA:** ______

### 4.3 Confirmar vincula

1. Confirme.

**Deve acontecer:** o vínculo aparece, com a equipe e a data. Entrando como **Treinador**
(nº 1), o atleta aparece na lista de atletas da equipe.

**APROVA / NÃO APROVA:** ______

### 4.4 A trava do vínculo único

1. Como **Treinador** (nº 1), tente convidar o **mesmo** atleta para a mesma equipe outra vez.

**Deve acontecer:** a recusa diz que o atleta **já está vinculado**, informa **qual** é a
equipe atual, e manda solicitar a alteração ao operador da Muscle Contest. Não é um erro
genérico.

**APROVA / NÃO APROVA:** ______

---

## Parte 5 — R-05: o que o treinador vê, e o que ele nunca vê

### 5.1 A lista de atletas é esportiva

1. Como **Treinador** (nº 1), abra a lista de atletas da equipe.

**Deve acontecer:** aparecem nome, nome de palco, sexo, situação, PRO, matrícula, filiação,
equipe e organização. **Não aparece** CPF, nem CPF mascarado, nem documento, nem telefone,
nem data de nascimento, nem e-mail. Não há coluna nem link de download de documento.

**APROVA / NÃO APROVA:** ______

### 5.2 O documento de análise não volta nem para quem enviou

1. Como **Treinador** (nº 1), envie um documento no seu cadastro.
2. Procure esse documento na sua própria tela.

**Deve acontecer:** o envio funciona e o documento **não aparece** para você. Listar e baixar
documento de análise é da mesa central — inclusive o que você mesmo enviou. É assimétrico de
propósito.

**APROVA / NÃO APROVA:** ______

### 5.3 A mesa central vê a contagem, não o documento, na listagem

1. Como **Central** (nº 4), abra a fila de análise.

**Deve acontecer:** a coluna de documentos mostra a **quantidade**. Não há link de download
na listagem — o download é uma ação deliberada, dentro do cadastro.

**APROVA / NÃO APROVA:** ______

---

## Parte 6 — R-02: transferir e desvincular são poder central

### 6.1 O treinador não transfere

1. Como **Treinador** (nº 1), procure alguma ação de transferir ou desvincular atleta.

**Deve acontecer:** não existe. Nem no menu, nem na linha do atleta.

**APROVA / NÃO APROVA:** ______

### 6.2 A delegação central tem escopo e prazo — os dois obrigatórios

1. Como **Central** (nº 4), abra a delegação central e clique em conceder.
2. Tente concluir **sem** escolher a federação.
3. Tente concluir **sem** informar o prazo.

**Deve acontecer:** **não existe** a opção "todas as federações" — o campo de federação é
obrigatório, e o de prazo também. O botão de confirmar só habilita com os dois preenchidos.
Isto é o achado A-02: antes, omitir os dois campos produzia um poder global e perpétuo.

**APROVA / NÃO APROVA:** ______

### 6.3 Ninguém concede para si mesmo

1. Como **Central** (nº 4), tente conceder a delegação para a **própria** conta.

**Deve acontecer:** recusa explícita — a concessão precisa de outra pessoa com essa
permissão. Vale inclusive para `SUPER_ADMIN`, que é o ator com mais poder do sistema.

**APROVA / NÃO APROVA:** ______

### 6.4 A delegação em vigor mostra escopo e prazo

1. Veja a lista de delegações.

**Deve acontecer:** cada linha mostra a pessoa, a permissão, a **federação** e o **prazo**.
Se aparecer alguma linha marcada como **"não concede nada — sem escopo ou sem prazo"**, é
uma concessão antiga que ficou inerte pela correção de A-02: ela **não foi apagada**, e
precisa ser reconcedida se ainda for necessária.

**APROVA / NÃO APROVA:** ______

---

## Parte 7 — §8.3: o ranking de treinadores NÃO está homologado

### 7.1 Não existe classificação

1. Como **Treinador** (nº 1), abra o cartão de ranking no seu painel.

**Deve acontecer:** a tela diz **"Ranking em homologação"** e explica que a fórmula de
pontuação de treinadores ainda não foi homologada pela MuscleContest. **Não há** posição,
**não há** total do treinador, **não há** pódio. O que aparece são os totais que o ranking de
**equipes** já publica — números oficiais, copiados, nenhum número novo.

**Se você vir uma posição ou um total de treinador em qualquer lugar, é FALHA.** É o bloqueio
de §8.3, e ele é a resposta correta, não uma pendência.

**APROVA / NÃO APROVA:** ______

### 7.2 A consulta de outro treinador é recusada

1. Como **Atleta** (nº 3), tente abrir o ranking de um treinador por URL — por exemplo
   `/#/treinador` com o id de outra pessoa, se a tela permitir.

**Deve acontecer:** não há como ver o cadastro nem as equipes de outro treinador. A recusa é
a mesma de "não existe" — de propósito, para que o id de um treinador real não possa ser
confirmado por tentativa. É o achado A-01.

**APROVA / NÃO APROVA:** ______

---

## Parte 8 — As telas em tamanhos diferentes

Reduza a janela do navegador (ou use o modo dispositivo) e confira nestas larguras: **360**,
**390**, **430**, **768**, **1024**, **1280**, **1440**, **1920**.

Em cada uma, nas telas do treinador, do atleta e da mesa central:

| O que conferir | Deve acontecer |
| --- | --- |
| rolagem lateral | a **página** não rola para o lado; tabela larga rola dentro da própria caixa |
| botões no telefone | o alvo de toque é confortável — nada de botão de 20px |
| modal de convite | cabe na tela, e o botão de confirmar é alcançável sem rolar fora |
| texto | nada cortado, nada sobreposto |

**APROVA / NÃO APROVA — 360:** ___ **390:** ___ **430:** ___ **768:** ___
**1024:** ___ **1280:** ___ **1440:** ___ **1920:** ___

---

## Parte 9 — A trilha de auditoria

1. Como **Central** (nº 4), abra a auditoria.

**Deve acontecer:** cada decisão que você tomou neste roteiro está lá, com autor, data e
motivo — aprovação e recusa de cadastro, autorização e revogação por federação, convite,
confirmação, concessão e revogação de delegação. A busca por matrícula que o treinador fez
também está.

**Nenhuma linha carrega senha, hash, token ou CPF completo.**

**APROVA / NÃO APROVA:** ______

---

## Parte 10 — Fechamento

| Item | Situação |
| --- | --- |
| Todos os passos aprovados | ______ |
| Passos reprovados (liste os números) | ______ |
| Observações | ______ |

### As quatro decisões que dependem de você, e que este roteiro não decide

1. **A-03** — a leitura de atleta pelo treinador ainda é de **federação**, não de equipe.
   Fechá-la exige escolher entre marcar a intenção na transação (com risco de lista vazia
   silenciosa se alguém esquecer a marca) ou mudar como o atleta é descoberto para convite
   (regra de produto). Detalhes em `RELATORIO-CORRECOES-AUDITORIA-TREINADORES.md`, §4.
2. **A-05** — cadastros de treinador que existiam antes do módulo voltam a **pendente**. O
   diagnóstico somente leitura diz quais estão em uso; aprová-los é ato da administração
   central.
3. **A-09** — a tentativa **recusada** de troca de senha ainda não deixa rastro. O desenho da
   correção está pronto e depende de autorização, porque muda mecanismo.
4. **§8.3** — a fórmula do ranking de treinadores. Enquanto não for homologada, nada no
   sistema a inventa.

### O que fazer com este ambiente quando terminar

`Ctrl+C`. O banco `mci_qa_treinadores` é descartável e é recriado do zero na próxima
execução. Nenhum dado real foi tocado em nenhum momento.

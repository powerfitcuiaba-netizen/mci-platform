# Teste com um treinador real — o que levar e o que esperar

Complemento do `ROTEIRO-DE-TESTE-REAL.md`, específico para o teste com um
treinador de verdade. Escrito a partir do código, não de memória: cada limite
abaixo foi lido no arquivo que o impõe.

**O contexto que torna este teste especial:** a produção tem **zero treinadores
cadastrados**. O treinador de amanhã será o **primeiro**, e a autorização
automática na federação oficial vai rodar de verdade em produção pela primeira
vez. Se algo estiver errado nessa engrenagem, é amanhã que aparece.

---

## 1. O que o treinador precisa ter em mãos

| Item | Exigência | De onde vem |
|---|---|---|
| **E-mail e senha** | conta própria na plataforma | ele cria antes, sozinho |
| **Nome** | 2 a 120 caracteres | `coachSelfRegister` |
| **Foto de perfil** | **obrigatória**, PNG, JPEG ou WebP, **até 5 MB** | `ALLOWED_AVATAR`, `AVATAR_MAX_BYTES` |
| Matrícula, bio, telefone, e-mail de contato | opcionais | `coachSelfRegister` |

### ⚠️ O risco prático: foto de iPhone

Os formatos aceitos são **PNG, JPEG e WebP**. **HEIC não entra** — e HEIC é o
padrão de câmera do iPhone. Se ele tirar a foto na hora com um iPhone em
configuração padrão, o envio será **recusado com 415**, e a recusa está correta.

**Como evitar a perda de tempo:** peça a ele para, antes de sair de casa,
mandar a foto para si mesmo pelo WhatsApp e salvar o arquivo recebido — o
WhatsApp converte para JPEG. Ou, no iPhone: Ajustes → Câmera → Formatos → **Mais
Compatível**.

Se acontecer, **não é defeito** — a mensagem deve dizer quais formatos são
aceitos. Se a mensagem *não* disser, isso sim é defeito: anote.

---

## 2. São DOIS passos, não um

O autocadastro de treinador exige estar autenticado (`requireAuth`). A ordem:

1. **Criar a conta** — e-mail e senha, como qualquer pessoa;
2. **entrar** e então **se cadastrar como treinador**, enviando nome + foto.

Se ele tentar se cadastrar como treinador antes de ter conta, não vai achar a
tela. Isso é o desenho, não um defeito.

---

## 3. O que deve acontecer, e quando é defeito

| # | Passo | Esperado | Seria defeito se |
|---|---|---|---|
| 3.1 | Concluir o cadastro **sem** foto | **recusa**, com a frase sobre foto obrigatória | o cadastro concluir sem foto |
| 3.2 | Concluir **com** foto válida | cadastro criado e **já aprovado** — sem fila, sem "em análise" | ficar aguardando aprovação |
| 3.3 | Abrir o painel do treinador | abre, e mostra a federação **NPC** como autorizada | não aparecer federação nenhuma |
| 3.4 | Criar a equipe dele | criada; dá para renomear | recusar sem explicar |
| 3.5 | Buscar um atleta já cadastrado | encontra pelo nome | não achar atleta que existe |
| 3.6 | Convidar esse atleta | fica **PENDENTE de confirmação do atleta** | vincular **na hora**, sem o atleta aceitar |
| 3.7 | Ver a foto dele no perfil | aparece | vir quebrada |
| 3.8 | Abrir a classificação de treinadores | **RECUSA**, dizendo que a fórmula não está homologada | aparecer classificação com números |

**O 3.2 e o 3.6 são os dois mais importantes.**

O 3.2 porque a aprovação automática é decisão recente: o cadastro nasce
`APPROVED`, com a trilha registrando que **foi a regra que decidiu**, não uma
pessoa. Se ele cair numa fila de análise, a regra não está valendo em produção.

O 3.6 porque é a regra homologada: **o treinador pede, o atleta confirma**. Se o
vínculo acontecer sozinho, pare o teste e me avise — isso é grave, e mexe com
vínculo de atleta real.

---

## 4. O que NÃO fazer neste teste

* **não** convide atleta em campeonato real para "ver o que acontece";
* **não** peça para a federação aprovar nada manualmente — a graça do teste é
  justamente a aprovação automática funcionar sozinha;
* **não** use o cadastro dele para alterar pontuação, resultado ou classificação
  de ninguém.

Se quiser testar o convite sem envolver um atleta real, use uma conta de atleta
de teste, criada por você, com nome prefixado por `TESTE`.

---

## 5. O que me mandar depois

Para cada item de §3, uma linha. O formato que eu consigo reproduzir:

```
3.6 — FALHOU
O treinador convidou o atleta TESTE Silva e o vínculo apareceu
como ativo na hora, sem o atleta confirmar nada.
```

E, se algo der erro de verdade, **a mensagem exata que apareceu na tela**. A
mensagem é o que me diz qual guarda disparou.

---

## 6. A NPC é a única federação — e por que isso faz o teste passar

Você reafirmou que a federação é a NPC e que ela é a única no sistema. O código é
construído **exatamente** sobre essa premissa, e vale mostrar como, porque é disso
que depende o cadastro de amanhã sair autorizado.

Quando o treinador conclui o cadastro, `autorizarNaFederacaoOficial` pergunta a
`organizacaoOficial()` qual é a federação oficial. Essa função tem **dois
caminhos**:

1. se `MCI_NPC_ORGANIZATION_ID` estiver configurada, usa aquela organização —
   desde que ativa;
2. **se não estiver**, procura a filiação de código `NPC` **ativa** (ignorando
   maiúscula, porque `npc` minúsculo cabe no índice único) e usa a organização
   dela — desde que a organização também esteja ativa.

O segundo caminho é o que torna isto robusto: **não depende de variável de
ambiente**. Basta a NPC existir ativa, que é o seu caso.

### A prova de que as duas condições estão satisfeitas em produção

A sonda mediu a vitrine pública de filiações e devolveu:

```
entidades na vitrine ......... 1
com o nome oficial ........... 1
códigos ...................... NPC
kind da oficial .............. ENTITY
```

E a consulta que alimenta essa vitrine (`publicService.listAffiliations`) filtra:

```js
where: {
  active: true,                                        // a filiação está ativa
  organization: { active: true, selfRegistrationOpen: true }   // a organização também
}
```

São **as mesmas duas condições** que o caminho 2 de `organizacaoOficial()` exige.
Aparecer na vitrine, portanto, **prova** que a resolução vai funcionar: filiação
NPC ativa, organização ativa.

**O que ainda pode dar errado, e como você reconhece:** se por algum motivo a
resolução falhar, o código **não derruba o cadastro** — ele cria o treinador e
registra na trilha que a federação oficial não estava provisionada. O sintoma na
tela é o item **3.3**: o painel abre e **não mostra federação nenhuma**. Se você
vir isso, o cadastro existe mas sem autorização, e é isso que me reportar.

Essa escolha de não derrubar é deliberada: recusar o cadastro por falha de
provisionamento puniria o treinador por um problema que não é dele.

---

## 7. O que eu já verifiquei, para você não testar às cegas

| Verificação | Resultado | Onde |
|---|---|---|
| Entidade oficial NPC ativa na produção | **1**, code `NPC`, kind `ENTITY` | sonda de produção |
| Foto do treinador não vaza a chave do storage | 404 e zero chave | sonda §18 |
| As 6 leituras do módulo recusam sem token | **401 em todas** | sonda §18 |
| Classificação de treinadores | **409**, fórmula não homologada | sonda §18 |
| Armazenamento gravável | `storage: true` | `/ready` |
| Fluxo do módulo em navegador real | aprovado em 15 larguras | gate visual |

O que eu **não** consigo verificar daqui, e por isso depende deste teste: o
comportamento com **uma pessoa real, uma foto real de celular e uma rede real**.
É exatamente onde os defeitos que sobram costumam estar.

# Como testar o MCI PLATFORM

Roteiro de teste em produção. Cada URL, número e comportamento aqui foi
**medido**, não suposto — as medições estão em `docs/AUDITORIA-FINAL-E2E.md`
§9 a §11, e podem ser refeitas pelo workflow **Sonda de produção**.

---

## 1. Onde entrar

| | URL | Medido em |
|---|---|---|
| **Site** | https://mci-platform-web.onrender.com | HTTP 200, título "MCI Platform — Campeonato Brasileiro Muscle Contest" |
| API | https://mci-platform-api.onrender.com | `/health` 200, `/ready` 200 com banco, armazenamento e RLS em pé |

> **Plano free do Render hiberna.** A primeira visita depois de um período
> parado demora para responder. Isso é o plano, não a aplicação.

---

## 2. Como entrar pela primeira vez

O cadastro aberto **recusa papel privilegiado**, e deve recusar. Numa
instalação nova ninguém vira administrador sozinho — daí o script de
bootstrap, que se roda **pelo Shell do serviço `mci-api` no Render**:

```sh
ADMIN_PASSWORD='...' node scripts/criar-admin.js "Seu Nome" voce@dominio
```

A senha **não** é aceita como argumento de linha de comando, de propósito:
argumento aparece no `ps` para qualquer usuário da máquina e fica no histórico
do shell. Vem por variável de ambiente ou pela entrada padrão.

> Se o primeiro administrador já existe, pule este passo e faça login normal.

---

## 3. Roteiro por perfil

### 3.1 Visitante — sem login nenhum

Abra o site sem entrar. O que **deve** acontecer:

| Onde | Esperado |
|---|---|
| Calendário | **47 campeonatos** |
| Ranking | as **5 primeiras** linhas, e só |
| Super Overall | as **5 primeiras** linhas, e só |
| Busca por nome de atleta | **não devolve atleta** |
| Busca por CPF | **não encontra ninguém** |

As duas últimas linhas não são defeito, são a regra: *"Sem autenticação,
atleta não entra na busca: é dado de pessoa física."* E CPF **nunca** aparece
em busca pública, nem mascarado.

### 3.2 Atleta — o caminho completo de quem chega de fora

1. **Criar conta** no site (cadastro aberto).
2. **Enviar a solicitação de atleta** — é aqui que entram os dados
   esportivos, a federação e a foto.
3. Entrar como operador e **aprovar** em **ADMINISTRAÇÃO → Solicitações**.
4. Voltar como o atleta e conferir:
   - **Minha Filiação** — a federação e o número;
   - **Meu Histórico** — e é aqui que está o teste que mais importa:
     se aquele atleta já competia nos campeonatos importados, o histórico
     **aparece sozinho**, sem ninguém vincular nada à mão.
   - o **recado da federação**, se houver um publicado na janela.

> O vínculo automático casa por **CPF exato**, e por CPF + filiação +
> matrícula. **Nome sozinho nunca vincula** — homônimo vira sugestão marcada
> para confirmação humana, não vínculo.

### 3.3 Operador da federação

Entre com um papel que tenha as permissões e percorra o menu:

| Tela | O que exercitar |
|---|---|
| **Atletas** | busca, filtros, perfil em abas, **revelar CPF** (é auditado), suspender / reativar / arquivar |
| **Solicitações** | aprovar e rejeitar |
| **Mensagens** | publicar o recado da federação, com janela de validade |
| **MuscleWare** | importar um lote, ver a **prévia** antes de aplicar |
| **Lançamentos** | corrigir e invalidar lançamento publicado, com motivo |
| **Overall** | homologar o campeão Overall de um evento |
| **Ranking** | recalcular a temporada, e a tela "por que estes pontos?" |
| **Configurações → Parceiros** | cadastrar empresa, **equipe**, academia, marca |
| **Configurações → Vínculo de equipe** | vincular, transferir e encerrar vínculo do atleta |
| **Auditoria** | conferir que tudo acima deixou rastro |

Autenticado **sem vínculo** com a organização dona da temporada vê o mesmo
que o visitante: privilégio vem do vínculo, nunca do fato de haver um token.

---

## 4. O que vai parecer vazio, e NÃO é defeito

**Ranking de equipes e de empresas: 0 linhas.** Não há **nenhuma equipe
cadastrada** — medido com 29 varreduras na busca pública, com controle vivo
(167 acertos de evento nos mesmos termos). As duas tabelas se enchem depois
que houver equipe cadastrada **e** lançamento que a referencie. Ver
`AUDITORIA-FINAL-E2E.md` §11.

**Super Overall com 5 linhas.** É o teto da vista pública, declarado no
cabeçalho `X-MCI-Public-View: top-5`. Atrás dele há **84 competidores** com
pontos elegíveis. Pedir `limit=50` continua entregando 5 — e é para continuar.

**Cadastrar equipes agora não preenche o histórico já importado.**
`RankingPoint.teamId` é gravado no momento em que o ponto nasce. Os
campeonatos já importados ficam sem equipe; o ranking de equipes passa a se
encher a partir das **próximas** importações e dos **próximos** eventos.

---

## 5. O que não existe de propósito

**Nada financeiro.** Sem pagamento, PIX, boleto, cartão, carrinho, cupom,
reembolso, fatura ou assinatura. Medido: sete rotas financeiras sondadas em
produção, **404 nas sete**. Se aparecer qualquer coisa parecida com cobrança,
é defeito grave — reporte.

**O MCI não julga.** A apuração é **externa**; a plataforma recebe o resultado
oficial, aplica a tabela homologada e publica. Nenhuma tela dá nota.

**Empate não se desempata por ordem de chegada.** Nem por id, nem por data de
inscrição, nem por nome. Quando a hierarquia de critérios se esgota, os
empatados saem **sem colocação**, marcados como empate não resolvido. Ver
`docs/HOMOLOGACAO-ESPORTIVA.md`.

---

## 6. Se algo quebrar

1. **Anote o caminho exato** — tela, ação, e o que você esperava ver.
2. Confira se a produção está de pé: Actions → **Sonda de produção** →
   *Run workflow*. Ela responde `/health`, `/ready`, o smoke test de leitura,
   o corte do Super Overall e a varredura de equipes, sem escrever nada.
3. Se `/ready` responder **503**, o corpo diz qual das três conferências caiu
   — `database`, `storage` ou `rls`. A aplicação **recusa subir sem RLS
   efetivo**, e isso é comportamento desejado: ver `docs/DEPLOY.md`.

## Gate E2E do autocadastro automático

Sobe a pilha real (API + build de produção do frontend), semeia uma federação
de QA com histórico importado e atravessa o fluxo num Chromium de verdade.

```bash
PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright \
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
node scripts/qa/autocadastro-automatico.mjs
```

Sai com código 1 e lista os problemas quando reprova. `--manter` deixa o
ambiente de pé, com as credenciais impressas, para inspeção humana.

**O que ele sabe dizer NÃO** (52 asserções):

- o cadastro não concluir sozinho;
- o histórico não ser vinculado quando o CPF confere;
- **a fila do operador receber o pedido do caminho normal** — a prova negativa
  que nenhum teste de unidade alcança, porque lá não existe ninguém para
  aprovar e "não houve aprovação humana" seria verdade por construção;
- a recusa por colisão devolver frase genérica em vez de instrução, ou dizer
  qual identificador colidiu;
- o formulário ser limpo numa recusa que a pessoa não pode resolver sozinha;
- a tela `minha-solicitacao` estourar a largura ou ter alvo de toque pequeno,
  em quinze larguras de 320 a 1920 — **ela nunca tinha sido medida**: o gate
  visual da FASE 9 cobre `minha-filiacao`, `meu-historico` e `ranking`.

Banco próprio (`mci_qa_auto`), recriado a cada execução. Portas 4601/5601, para
não colidir com o gate visual (4599/5599). Nada toca produção.

### Sobre o alvo de toque descartado

O gate imprime, a cada execução, quais elementos abaixo de 40px ele descartou
por estarem escondidos — hoje só o `input[type=file]` de 1×1 que vive atrás do
rótulo estilizado da foto. A exclusão foi acrescentada **depois** de o gate
reprovar, e mudar critério até a falha sumir é a pior coisa que se pode fazer
com um gate; então o descarte é declarado em vez de sumido, e `label.button`
entrou na medição — quem recebe o dedo é o rótulo, e ele passou a ser cobrado.

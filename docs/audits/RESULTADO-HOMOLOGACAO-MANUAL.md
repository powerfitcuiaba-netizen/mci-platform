# Resultado da homologação manual — Treinadores & Equipes

**Para:** Helder Falcão · **Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Data:** 2026-09-27 · **Ambiente:** sintético, banco descartável `mci_qa_treinadores`

Homologação conduzida pelos quatro perfis do roteiro, no navegador (Chromium) e, onde a
interface não podia provar a barreira, pelas rotas reais. Nenhum dado real foi tocado.

**Placar: 35 passos, 34 APROVA, 1 REPROVA corrigida e revalidada, 0 pendentes.**

---

## 1. Administrador central — 10 de 10 APROVA

| Passo | O que se mediu | Veredito |
| --- | --- | --- |
| C1 | a fila de análise abre com o cadastro em análise | APROVA |
| C2 | aprovar tira da fila e vira Aprovado, sem perguntar federação (R-03) | APROVA |
| C3 | recusar sem motivo não conclui | APROVA |
| C4 | federação e prazo obrigatórios; **não existe** "todas as federações" (A-02) | APROVA |
| C5 | confirmar indisponível sem preencher | APROVA |
| C6 | concessão aparece com pessoa, permissão, escopo e prazo | APROVA |
| C7 | autoconcessão recusada: *"Ninguém concede delegação central para si mesmo"* | APROVA |
| C8 | revogar tem efeito imediato | APROVA |
| C9 | trilha com `COACH_APPROVE`, `CENTRAL_GRANT`, `CENTRAL_REVOKE`, autor e motivo | APROVA |
| C10 | a mesa central lê qualquer cadastro | APROVA |

O diálogo de concessão **explica na própria tela** por que exige escopo e prazo: *"A concessão
vale SÓ na federação escolhida"* e *"O prazo é obrigatório: a concessão deixa de valer sozinha,
sem depender de ninguém lembrar de revogá-la."* A correção A-02 dita em voz alta para quem opera.

---

## 2. Treinador — 10 de 10 APROVA

| Passo | O que se mediu | Veredito |
| --- | --- | --- |
| T1 | a conta em análise vê "EM ANÁLISE" e o aviso de que não atua em federação nenhuma | APROVA |
| T2 | nenhum botão aprova o próprio cadastro (R-03) | APROVA |
| T3 | painel com situação, federação autorizada e equipe | APROVA |
| T4 | a tela explica R-04 por escrito | APROVA |
| T5 | convite criado; o atleta **não** vira vínculo antes de confirmar | APROVA |
| T6 | lista esportiva e de filiação, sem CPF, documento, telefone ou e-mail (R-05) | APROVA |
| T7 | selo "Ranking em homologação", nenhuma classificação oficial (§8.3) | APROVA |
| T8 | sem transferir nem desvincular (R-02) | APROVA |
| T9 | nenhum caminho para outro treinador; a rota direta responde **404 `COACH_NOT_FOUND`** (A-01) | APROVA |
| T10 | revogada a autorização, a leitura dos atletas cai **na requisição seguinte** (A-03) | APROVA |

**T10 é o passo mais forte do bloco.** O mesmo treinador, na mesma sessão, deixou de enxergar o
atleta que enxergava um segundo antes — e a tela não quebrou: passou a dizer *"Nenhum atleta
vinculado às suas equipes."* A leitura acompanha a autorização, sem rotina noturna e sem cache
que sobreviva.

**T9 recusa com 404, e não com 403.** Um 403 diria "existe um treinador com esse id, mas não é
seu", e serviria para mapear quem é treinador. O 404 é idêntico ao de um id inexistente.

---

## 3. Administrador de federação — 8 de 8 APROVA, depois de uma REPROVA corrigida

### 3.1 A reprovação do F4, na primeira passagem

**O diretor não conseguia autorizar treinador nenhum pela interface.** O servidor estava certo
nos dois lados — `GET /coaches/review` → **403** (R-03) e `POST /coaches/:id/organizations` →
**200** (R-04) — mas o único botão **Autorizar** da tela vivia dentro da fila de análise central,
que o diretor não pode carregar. Sem lista, não havia linha; sem linha, não havia botão. A tela
inteira dele eram duas caixas de recusa.

Parei no passo, registrei, e só depois corrigi — com sua autorização. O relatório da correção
está em `CORRECAO-F04-ATUACAO-NA-FEDERACAO.md`.

### 3.2 Depois da correção

| Passo | O que se mediu | Veredito |
| --- | --- | --- |
| F1 | o item Treinadores aparece no menu do diretor | APROVA |
| F2 | nenhuma ação de aprovar ou não aprovar cadastro (R-03) | APROVA |
| F3 | a fila central e a delegação **saem da tela** — ausência, não caixa de recusa | APROVA |
| F4 | a seção *Atuação na sua federação* lista o aprovado e oferece a ação | APROVA |
| F4b | autorizar pela tela leva a AUTORIZADO; o diálogo não oferece outra federação | APROVA |
| F4c | a mesa central continua com as três seções | APROVA |
| F5 | a autorização vale **só** na federação que a deu: listar e autorizar em outra → **403** | APROVA |
| F6 | revogar → **REVOGADO** na hora, e o treinador perde a leitura dos atletas | APROVA |
| F7 | conceder e listar delegação central → **403** (R-02) | APROVA |
| F8 | os atletas da própria federação vêm (3); os da federação alheia → **403** | APROVA |

---

## 4. Atleta — 7 de 7 APROVA

| Passo | O que se mediu | Veredito |
| --- | --- | --- |
| A1 | o convite aparece em Minha equipe, com equipe e treinadora | APROVA |
| A2 | a consequência é dita **antes** do botão: vínculo exclusivo, e sair depende da mesa central | APROVA |
| A3 | confirmar cria o vínculo, e só então o atleta aparece para o treinador | APROVA |
| A4 | com uma segunda equipe, a busca avisa *"já tem equipe"* e o pedido é recusado com **409 `ATHLETE_ALREADY_LINKED`** | APROVA |
| A5 | o atleta não sai do vínculo por conta própria (R-02) | APROVA |
| A6 | a lupa do topo, **sem sessão**, encontra a atleta e **não** devolve CPF em forma nenhuma | APROVA |
| A7 | os convites respondidos ficam em "Convites anteriores", com a data | APROVA |

---

## 5. O que foi preparado, e por quê

O ambiente sintético é econômico de propósito, e três passos pediam estado que ele não tem.
Cada preparação está declarada porque **altera o ambiente**:

| Preparação | Para qual passo | Por quê |
| --- | --- | --- |
| Um quarto atleta sintético (QA Beatriz Lopes, matrícula 5004) | T5 | a semente gasta os três atletas — uma vinculada e duas com convite pendente |
| Uma segunda federação (Federação QA Beta) | F5 e F8 | perguntar o que acontece com "outra federação" exige que ela exista |
| Uma segunda equipe na mesma federação | A4 | o vínculo único só se prova com uma segunda equipe convidando |

**Uma preparação falhou e está registrada:** o diretor e o atleta da segunda federação não foram
criados (o autocadastro exige campos que eu não mandei). F5 e F8 mediram a barreira mesmo assim,
e por um caminho mais forte: **403** ao listar e ao autorizar na federação alheia — recusa, e não
lista vazia.

---

## 6. Erros do instrumento, declarados

A condução automatizada errou seis vezes, e **nenhuma delas era defeito do produto**. Registro
porque a distinção é o que separa laudo de opinião:

1. **T1 e T3** comparavam "Em análise" e "Aprovado" com o texto da tela; os selos são exibidos
   em caixa alta por CSS.
2. **T5** procurava um botão "Enviar pedido"; o botão real é **"Enviar convite"**. E conferia o
   vínculo lendo a página com o diálogo ainda aberto, onde o nome obviamente aparecia.
3. **T9** chamava `/coaches/:id/ranking-projection`, que não existe — o 404 vinha de
   `ROUTE_NOT_FOUND`. Teria sido um **APROVA falso**, o pior tipo de erro aqui: eu daria por
   provada uma barreira que nem cheguei a tocar. A rota real é `/coaches/:id/ranking/projection`,
   e ela recusa com `COACH_NOT_FOUND`.
4. **T10** usava uma rota de revogação inventada.
5. **F4b** falhou porque reconstruí o frontend sem `VITE_API_URL`, a variável que o script de QA
   injeta — o pacote passou a apontar para outro endereço de API e a tela abriu sem dados.
6. **A6**, na primeira versão, media `GET /athletes`, que exige sessão e respondeu 401 — passar
   ali não provava nada sobre busca pública. A busca pública de verdade é a lupa do topo,
   `GET /search`, que responde sem sessão.

---

## 7. O que a homologação mudou no produto

| Mudança | Origem |
| --- | --- |
| `GET /coaches/authorizable` e a seção *Atuação na sua federação* | achado F4 |
| As seções da tela passam a respeitar a permissão efetiva da conta | observação do F4 |
| Rótulos próprios da seção: "Autorizar atuação" / "Revogar atuação" | revalidação do F4 |
| 9 testes do bloco F-04 + a rota na matriz de leitura + 4 testes de tela | prova da correção |
| 3 mutantes defendendo o filtro de aprovado, a guarda de escopo e a projeção | prova negativa |

---

## 8. O gate visual, e um defeito que ele escondia

Reexecutado depois da correção do F-04, porque a tela de administração mudou:
**218 PASS, 0 FAIL, 0 NOT TESTED**, nas oito larguras (360, 390, 430, 768, 1024,
1280, 1440, 1920). Os 3 achados de CONTROLE são dívida anterior ao módulo — um
`select` de 23 px na tela de atletas em 430 px —, e o gate os separa de propósito.

O caminho até esse número, porém, expôs um defeito no próprio gate:

1. **Ele terminava e não saía.** Os 218 checks corriam, o resumo era impresso, o
   `evidencias.json` era escrito — e o processo ficava vivo. Medido: 1h30 parado,
   com 2 segundos de CPU acumulados. Em CI isso é timeout.
2. **A causa:** `npx vite preview` é três processos (o `npm exec`, um `sh -c` e o
   node do vite). `encerrar()` matava só o primeiro; os outros dois seguiam vivos
   segurando o pipe herdado, e o event loop do Node não fecha com pipe aberto.
3. **O custo real:** os órfãos continuavam segurando o banco de QA e a porta do
   frontend. Foi isso que produziu, numa tentativa anterior, o
   `database is being accessed by other users` que abortou uma rodada — e foi
   isso que fez uma rodada medir contra um servidor de frontend **de outra
   execução**, ainda vivo na porta 5611.
4. **A correção:** cada filho nasce em grupo próprio (`detached: true`) e o
   encerramento mata o **grupo** (`kill(-pid)`), destrói os pipes e faz `unref`.
5. **A prova:** rodada limpa, um processo só do início ao fim — saiu sozinho com
   código 0, 218 PASS, e **zero** processos órfãos ao terminar.

O resultado anterior não era falso, mas era mal montado: um gate cujo ambiente foi
em parte fornecido por um zumbi de outra execução não é um gate limpo. O número
que vale é o da rodada limpa.

---

## 9. O que continua pendente, e não depende de mim

1. **Decisões D-1 a D-4** — nenhuma foi tocada pela homologação.
2. **Diagnósticos somente leitura em produção** — `diagnostico-treinadores-legados.js` e
   `diagnostico-delegacoes-inertes.js`, ambos ainda **não executados** contra produção.
3. **Backup com restore verificado** — pendente.
4. **Autorização para enviar ao repositório remoto, e depois publicar.**

O item 2 continua sendo o que mais pesa: a migration `20260927030000` devolve a `PENDENTE` os
cadastros aprovados sem revisor, e o `preDeployCommand` do Render aplica migrações pendentes
sozinho no próximo deploy.

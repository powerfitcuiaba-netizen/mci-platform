# MCI Cinema de Produto

Como o sistema conta, visualmente, a história de uma competição.

Este documento é **normativo** e complementa `mci-experience-engine.md`. Aquele
define *como* o sistema se move; este define *por que* ele se move mais aqui do
que ali.

---

## 1. A pergunta

> Como deve ser a sensação de operar uma competição internacional dentro do MCI?

A resposta **não** é "mais animação". É que a intensidade siga a competição. Um
check-in às sete da manhã e a declaração de um campeão geral não podem ter o
mesmo peso visual — e hoje a única coisa que os separava era o nível declarado
por evento. Faltava o arco.

---

## 2. Os quatro atos

O ato **não é um efeito**. É o estado narrativo da tela, derivado da rota, e ele
só serve para uma coisa: dizer quanta presença aquele momento merece.

| Ato | Onde | Sensação | O que o ato faz |
|---|---|---|---|
| **I — ENTRAR** | abertura, login | chegada | a abertura, uma vez por sessão |
| **II — OPERAR** | painel, eventos, inscrições, atletas, check-in, pesagem, credenciamento, social, messenger | rápido, preciso, sem cerimônia | **nada** — é o padrão |
| **III — COMPETIR** | palco, resultados | o piso do evento | luz de palco estática no topo do conteúdo |
| **IV — CONSAGRAR** | declaração do Overall | um nome só na tela | o Momento Campeão |

### A regra de segurança do ato

**O ato só pode BAIXAR a intensidade, nunca subir.** O teto do motor
(`tetoDeIntensidade`) continua sendo a autoridade: preferência de movimento e
capacidade do aparelho vencem o ato sempre. Um ato que pudesse elevar o nível
transformaria a narrativa numa porta lateral para burlar a acessibilidade.

O Ato III **não sobe o nível de efeito nenhum**. Ele acrescenta *profundidade* —
uma luz estática, que não se move e não consome quadro. A diferença entre operar
e competir se sente pelo ambiente, não por mais coisas piscando.

---

## 3. O fluxo real, medido

Auditado no código, não presumido. O barramento de eventos do motor
(`ouvirExperiencia` / `anunciar`) **já existia e já cobria tudo** — nenhum evento
novo foi criado nesta fase.

| Momento | Ação real | Evento do motor | Nível | Posição | Ato |
|---|---|---|---|---|---|
| Abrir o sistema | fim da abertura | — | 5 | tela | I |
| Entrar numa tela | navegação | — | 2 | — | II |
| Inscrever atleta | `POST /events/:id/registrations` | `SUCESSO` | 3 | linha | II |
| Cancelar inscrição | `POST …/cancel` | `AVISO` | 1 | linha | II |
| Check-in | `POST …/checkins` | `CHECKIN` | 3 | linha | II |
| Desfazer check-in | `POST …/checkins/cancel` | — | — | — | II |
| Pesagem | `POST …/weigh-ins` | `PESAGEM` | 3 | linha | II |
| Peso fora da faixa | mesma resposta, `outOfRange` | `AVISO` | 1 | linha | II |
| Credencial aceita | `POST …/credentials/scan` | `CREDENCIADO` | 3 | linha | II |
| Credencial recusada | mesma rota, `accepted: false` | `ERRO` | 1 | linha | II |
| Chamar bateria | `PATCH …/batches/:id` → `CALLED` | `NOVIDADE` | 1 | linha | III |
| Bateria no palco | → `ON_STAGE` | `AO_VIVO` | 1 | linha | III |
| Lançar resultado | `POST …/results` | `SUCESSO` | 3 | linha | III |
| Empate não resolvido | mesma resposta, `hasUnresolvedTie` | `AVISO` | 1 | linha | III |
| **Publicar resultado** | `POST …/results/publish` | `RESULTADO_PUBLICADO` | **4** | **centro** | III |
| **Declarar Overall** | `POST /events/:id/overall` | `CAMPEAO` | **5** | **tela** | **IV** |

O que a tabela mostra e vale dizer em voz alta: **a esmagadora maioria da
operação é nível 1 e 3, confirmando na linha.** Só dois momentos no produto
inteiro saem do canto da tela.

---

## 4. O Ato IV é o único que interrompe

O Momento Campeão é acionado por **um caminho só**:

```
resultado oficial recebido de fora
   ↓
a comissão decide o Overall (fora da plataforma)
   ↓
a organização DECLARA  →  POST /events/:id/overall
   ↓
permissão `ranking.manage` + auditoria OVERALL_DECLARE
   ↓
resultados publicados do evento são repontuados
   ↓
o frontend recebe a confirmação
   ↓
Momento Campeão
```

**O MCI não julga.** A plataforma registra um fato decidido por gente. É por
isso que o efeito pode ser raro de verdade: a raridade vem do fato, não de uma
regra de interface.

E o efeito só acontece **depois da confirmação do servidor**. Se a chamada
falhar, não há campeão nenhum — há um erro à vista, com o motivo. Há teste para
os dois lados.

---

## 5. Som

A trilha oficial toca **uma vez por sessão**, na abertura, pelo `AudioDirector`
que já existe. O Momento Campeão **não toca nada**: não há efeito sonoro curto no
repositório, e criar dependência de áudio nova para um momento que dura cinco
segundos não se paga. Silêncio, aqui, também é direção.

---

## 6. As sete perguntas

Antes de qualquer efeito novo, nesta fase e nas próximas:

1. Que problema resolve?
2. Que informação reforça?
3. Que nível é?
4. Quanto dura?
5. O que acontece no celular?
6. O que acontece com movimento reduzido?
7. Qual o custo de desempenho?

**Sem as sete respostas, o efeito não existe.** Nesta fase essa régua reprovou
mais coisa do que aprovou — e é esse o ponto.

---

## 7. O que foi deliberadamente NÃO feito

- **Transição cinematográfica entre telas comuns.** Navegação precisa parecer
  instantânea; 21 telas com entrada dramática deixariam o sistema lento.
- **Efeito sonoro no campeão.** Ver §5.
- **Partícula ou brilho no Ato III.** A luz de palco é estática. Bateria dura
  minutos e o operador fica com o telefone na mão.
- **Um segundo Champion Moment "mais forte".** Existe um, e ele basta.
- **Intensidade elevada pelo ato.** O ato só baixa. Ver §2.

---

## 8. Estabilidade, medida

Um sistema com efeito tem uma forma própria de apodrecer: o efeito sai da tela,
mas o que ele criou fica. Intervalo que continua batendo depois que a tela
morreu, ouvinte que se soma a cada volta, `<audio>` que nunca para, nó de DOM
que nunca é recolhido. Nada disso aparece na primeira volta — aparece na
enésima, no ginásio, seis horas depois da abertura dos portões.

Por isso o fluxo inteiro foi percorrido **seis vezes seguidas** — 13 telas por
volta, mais o Momento Campeão em cada uma — com o navegador instrumentado e o
coletor de lixo forçado antes de cada medição.

| O que se mede | Volta 1 | Volta 6 |
|---|---|---|
| nós de DOM | 528 | 528 |
| ouvintes de evento | 214 | 214 |
| heap depois do GC | 3,9 MB | 4,1 MB |
| intervalos vivos ao sair | 0 | 0 |
| efeitos presos na tela | 0 | 0 |
| elementos invisíveis esperando animação | 0 | 0 |
| `<audio>` criados / tocando | 0 / 0 | 0 / 0 |
| erros de página | 0 | 0 |

Os números do meio não oscilam: 528 e 214 se repetem nas seis voltas.

**O intervalo de recarga do Check-in é o caso que valia a medição.** Ele existe
(20 s), e sai junto com a tela: ao voltar ao Início, zero intervalos vivos. Se o
`clearInterval` do `useFetch` falhasse, esta linha cresceria de um em um.

### A chamada duplicada que NÃO era defeito

A primeira leitura acusou **61 pares de requisições duplicadas**: cada tela
pedia seus dados duas vezes, no mesmo milissegundo. A pilha de chamada apontava
para o efeito de montagem do `useFetch`.

Não era defeito do produto: é o `React.StrictMode`, que em **desenvolvimento**
invoca cada efeito duas vezes de propósito, justamente para expor efeito que não
se limpa. Duas medições fecham a questão:

- no **pacote de produção**, as 13 telas pedem seus dados **uma vez cada**;
- no servidor de desenvolvimento **com o StrictMode removido**, as duplicatas
  desaparecem — e voltam quando ele é recolocado.

Fica registrado porque a conclusão errada era plausível, e porque ela só caiu
depois de medir o pacote de produção de verdade. Na primeira tentativa o
`vite preview` não conseguiu a porta pedida, subiu noutra, e o que estava sendo
medido continuava sendo o servidor de desenvolvimento. **Número medido no alvo
errado é pior que número nenhum**: ele convence.

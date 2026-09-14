# Paginação de listas — do débito à correção

**Status:** RESOLVIDO — operação na FASE 2.4, auditoria na FASE 2.5
**Levantado em:** FASE 2.1 · **Documentado em:** FASE 2.2

> Este documento continua contando a história inteira, inclusive o que eu
> escrevi errado nele. Apagar o engano deixaria o texto mais limpo e o projeto
> mais burro.

Este documento existe para que a decisão seja tomada com dados, e não no meio de
uma competição. **Nada aqui foi resolvido em silêncio no frontend**: a correção
real exige backend em parte dos casos, e improvisar na interface esconderia o
problema em vez de resolvê-lo.

---

## 1. O que aconteceu

A API recusa `limit` acima de **100** com `400 VALIDATION_ERROR`. Quatro telas
pediam 200 desde a primeira versão da interface (`0f09a2b`) e por isso **não
listavam nada**. Corrigido na FASE 2.1 baixando para 100 — o que faz as telas
funcionarem, mas **não** resolve o problema de fundo: acima de 100 registros, a
lista simplesmente para.

## 2. O teto, onde ele vive

`src/utils/schemas.js`:

```js
const paginacao = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(60).optional()
});
```

O teto **não é arbitrário nem deve ser levantado**: ele protege o banco e o
tempo de resposta. A resposta certa é paginar, não pedir mais.

## 3. O levantamento — e ele divide o problema em dois

O esquema prevê `cursor`. Mas **nem todo endpoint devolve um**, e é isso que
separa o que dá para resolver no frontend do que exige backend.

### 3.1 Backend PRONTO — falta a interface usar

Estes serviços já devolvem `nextCursor`:

| Serviço | Alimenta |
|---|---|
| `registrationService` | Inscrições; listas de atleta em "emitir credencial" e "ordem de palco" |
| `athleteService` | Atletas |
| `eventService` | Eventos |
| `socialService` | Feed, comentários, seguidores |
| `messengerService` | Conversas e mensagens |
| `communityService` | Comunidades e membros |
| `rankingService` | Ranking |
| `publicService` | Superfícies públicas |
| `athleteRequestService` | Fila de solicitações |
| `adminService` | Usuários |

**Quem já usa o cursor, e quem ignora** — conferido arquivo a arquivo:

| Usa cursor | Ignora o cursor |
|---|---|
| `publicPages.jsx` (Atletas, Campeonatos, Ranking) | Inscrições |
| `socialPages.jsx` (feed, comentários, seguidores) | Emitir credencial |
| `adminSolicitacoes.jsx` (fila de solicitações) | Ordem de palco |
| | Lançar resultado |

A divisão não é aleatória: **a superfície pública pagina; a de operação não.**
Atletas, por exemplo, já carrega de 24 em 24 com "carregar mais". Quem está no
piso do evento, com a fila andando, é justamente quem ficou sem.

### 3.2 Backend AUSENTE — exige trabalho de servidor

| Serviço | Situação |
|---|---|
| `operationsService` | **zero** ocorrências de `nextCursor` |

`listCheckIns` faz `take: filtros.limit` e devolve `{ items, summary }`. Não há
cursor nenhum. **Check-in e Pesagem não têm como paginar sem mudança de
backend.**

~~Detalhe que importa: o `summary` (`total`, `checkedIn`, `pending`) é
calculado sobre o conjunto inteiro, não sobre a página.~~

**ISSO ESTAVA ERRADO, e o erro era grave.** O código era:

```js
take: filtros.limit
...
const total = registrations.length;   // o tamanho da PÁGINA
```

`registrations` já vem recortado pelo `take`. Então, num evento de 280
inscritos com limite 100:

- a tela anunciava **"Inscritos: 100"** — número operacional errado;
- e, pior, o aviso de corte que eu havia escrito na FASE 2.1 comparava
  `items.length < summary.total`, ou seja, `100 < 100`: **nunca aparecia**.

A lista cortava em silêncio — exatamente o comportamento que o §9 deste
documento chamava de pior caso — enquanto o documento afirmava o contrário.
Descoberto na FASE 2.4, lendo o código em vez de reler o documento.

## 4. Telas afetadas e impacto

| Tela | Endpoint | Corta em | Impacto |
|---|---|---|---|
| Check-in | `GET /events/:id/checkins` | 100 | **Alto.** Operação do dia. Atleta acima do 100º não aparece; hoje só é alcançável pela busca |
| Pesagem | `GET /events/:id/checkins` | 100 | **Alto.** Mesmo caso |
| Emitir credencial | `GET /events/:id/registrations` | 100 | Médio. Lista de vínculo incompleta |
| Ordem de palco | `GET /events/:id/registrations` | 100 | Médio. Coluna "Disponíveis" incompleta |
| Lançar resultado | `GET /events/:id/registrations` | 100 | Médio. Limitado por classe, raramente perto de 100 |
| Inscrições, Atletas, Eventos, Social, Messenger | vários | 100 | A avaliar por tela na FASE 2.2 |

## 5. Volume esperado

**Não inventado.** O calendário oficial de 2026 tem 47 etapas
(`data/campeonatos-2026.json`), mas o número de inscritos por etapa **não está
no repositório** e precisa vir da federação.

O que se sabe: o próprio uso citado pela operação fala em **280 atletas num
evento** — quase o triplo do teto. Enquanto o número oficial não é confirmado,
é esse o valor de trabalho.

## 6. Comportamento atual

- A lista traz os 100 primeiros.
- Em Check-in, a interface **avisa**: "Mostrando os primeiros 100 de 280
  inscritos" e orienta a usar a busca (implementado na FASE 2.1).
- Nas demais telas ainda **não há aviso** — é silencioso, que é a parte pior.

## 7. Comportamento desejado

1. Nenhuma lista corta em silêncio. Onde cortar, avisa — com o total.
2. Onde o backend já devolve `nextCursor`, a interface carrega as páginas
   seguintes (rolagem ou "carregar mais").
3. `listCheckIns` passa a devolver `nextCursor`, preservando o `summary` sobre o
   conjunto inteiro.
4. Telas de operação continuam com busca servidora — em 280 atletas, procurar
   pelo nome é mais rápido que rolar, mesmo com paginação.

## 8. O que foi feito (FASE 2.4)

### 8.1 Servidor

| Mudança | Onde |
|---|---|
| `summary` passou a ser contado no banco, sobre o conjunto inteiro | `operationsService.listCheckIns` |
| `nextCursor` no check-in, com desempate por `id` na ordenação | idem |
| `listCredentials` deixou de ser consulta **sem `take` nenhum** | `operationsService.listCredentials` |

A terceira linha é um achado próprio da auditoria: `listCredentials` devolvia
TODAS as credenciais do evento numa resposta só, cada uma com a contagem de
leituras. Não mentia — mas também não tinha tamanho, e o teto de 100 existe
para que o banco nunca receba pedido sem tamanho.

### 8.2 Interface

Um hook compartilhado, `useListaPaginada` (`frontend/src/lib/hooks.js`), e o
componente `Paginacao` que já existia. **Não** foi criada uma segunda
arquitetura de paginação: as telas públicas que já paginavam continuam como
estavam.

Telas convertidas: Inscrições, Check-in, Pesagem, Credenciamento,
Emitir credencial, Ordem de palco, Lançar resultado, Declarar Overall.

O hook existe por causa de três defeitos que só aparecem com lista grande:

1. **trocar o filtro sem zerar** — a página 1 do filtro novo era anexada ao
   resto do filtro velho;
2. **resposta atrasada de um filtro abandonado** — emendava o resultado errado
   no fim da lista certa;
3. **recarga que perde o lugar** — um check-in bem-sucedido jogava o operador
   de volta à página 1 no meio da fila.

Os três têm teste, e os três têm mutante morto.

### 8.3 O que foi medido

Servidor, com 101 inscritos reais: o total é 101 com qualquer limite; percorrer
com limite 1, 25 e 100 devolve 101 linhas distintas, sem repetir nem perder; a
ordem é igual entre execuções; a busca continua valendo em todas as páginas.

Navegador, pacote de produção, com 100 / 200 / 500 inscritos:

| volume | render | páginas | requisições | duplicadas | nós DOM | heap |
|---|---|---|---|---|---|---|
| 100 | 89 ms | 1 | 9 | 0 | 1.498 | 4,3 MB |
| 200 | 85 ms | 2 | 10 | 0 | 2.596 | 4,9 MB |
| 500 | 86 ms | 5 | 13 | 0 | 5.896 | 6,3 MB |

A lista chega **inteira** nos três volumes.

### 8.4 O que continua em aberto

`auditService.list` também devolve `total: items.length` — mesma classe de
engano. Impacto menor (a tela não exibe o total, e o limite de 200 é o próprio
teto), mas é dívida da mesma família e está registrada aqui para não se perder.

---

## 8.5 Auditoria: fechado na FASE 2.5

O último `total: items.length` do repositório morreu. Medido com 140 registros
reais e limite 100, a API devolvia **total 100**. Numa trilha de auditoria isso
é pior que numa lista comum: auditoria existe para responder "isto aconteceu
quantas vezes?", e um total que na verdade é o teto responde sempre a mesma
coisa.

| Mudança | Onde |
|---|---|
| `total` contado no banco, respeitando o filtro | `auditService.list` |
| `nextCursor`, com desempate por `id` na ordenação | idem |
| `cursor` declarado no esquema | `auditQuery` |
| tela passa a exibir "200 de 1430" e a continuar a trilha | `AdminAuditoria` |

O `cursor` faltando no esquema tinha um efeito próprio: o zod descarta campo
não declarado, então um cursor de 5.000 caracteres era **aceito e
silenciosamente ignorado**. Parecia validação e não era.

Sete mutantes, sete mortos (quatro no servidor, três na interface).

## 8.6 Inventário das consultas ainda sem `take`

Levantado na FASE 2.5 para que a decisão seja informada, e não omissão. Uma
consulta sem `take` só é aceitável quando o DOMÍNIO limita o conjunto; onde o
limite é "o usuário não costuma ter muitos", não é limite, é torcida.

| Consulta | O que limita | Veredito |
|---|---|---|
| `listWeighIns` | pesagens de UMA inscrição | limitado pelo domínio |
| `listStageOrder` | atletas de UMA bateria | limitado pelo domínio |
| `listBatches` | baterias de um evento (dezenas) | limitado pelo domínio |
| `setStageOrder` / `updateBatchStatus` | escrita, não listagem | não se aplica |
| `listAthleteDocuments` | documentos de UM atleta | limitado pelo domínio |
| `membershipService.history` | histórico de UM atleta | limitado pelo domínio |
| `organizationService.list` | organizações da federação | limitado pelo domínio |
| `usersOfProfiles` / `addMembers` / `createConversation` | conjunto já recebido como argumento | limitado pela entrada |

**Nenhuma dessas é lista de atleta de evento**, que era a família do problema.
Ficam registradas, não corrigidas: mexer em consulta que está correta, sem
evidência de que cresce, é trocar risco conhecido por risco novo.

---

## 8.7 O desempate por `id` — determinismo por contrato

Registrado aqui como decisão fechada, para não ser reaberto a cada fase.

**O que é.** Toda ordenação usada com `cursor` termina em `{ id }`:
`[{ athlete: { fullName: 'asc' } }, { id: 'asc' }]` no check-in,
`[{ createdAt: 'desc' }, { id: 'desc' }]` na auditoria.

**Por quê.** Para `cursor` o Prisma emite `campo >= (valor da linha do cursor)`
seguido de `OFFSET 1`. Com chaves empatadas, o `>=` traz todos os empatados e o
`OFFSET 1` descarta exatamente um — o que só está certo se os empatados
voltarem sempre na mesma ordem. O PostgreSQL não promete isso para chaves
iguais.

**O que foi medido.** Neste banco, com 101 inscrições e até com a chave de
ordenação IDÊNTICA nas 101 linhas, a travessia com limite 1, 3 e 25 devolveu
tudo certo **com e sem** o desempate. O plano do PostgreSQL é estável aqui.

**Classificação:**

> **DETERMINISMO POR CONTRATO** — o desempate garante a ordem por definição da
> consulta, e não pela estabilidade do plano.
>
> **MUTANTE NÃO SENSÍVEL AO DATASET UTILIZADO** — removê-lo não reprova a
> suíte, porque este conjunto de dados não expõe a diferença.

O desempate **fica**. Custa nada e troca uma garantia frágil por uma explícita.
E o mutante sobrevivente **fica registrado como sobrevivente** — não se fabrica
um dataset artificial só para exibir 15/15. Um número de mutação inflado vale
menos que um número honesto com a ressalva escrita ao lado.

---

## 9. Decisão original (FASE 2.2)

- **Exige backend:** sim, para `listCheckIns` (Check-in e Pesagem), que são
  justamente as de maior impacto.
- **Não exige backend:** o resto, que só precisa da interface usar o cursor que
  já existe.
- **Não improvisar no frontend:** buscar repetidamente com `limit` crescente, ou
  emendar páginas por conta própria, criaria uma segunda verdade sobre a ordem
  dos dados e quebraria na primeira mudança de ordenação.

## 10. Enquanto isso (texto da FASE 2.2, mantido como registro)

A interface **declara** o corte onde ele acontece. Uma lista incompleta que se
anuncia é um inconveniente; uma lista incompleta silenciosa é o operador
concluindo que um atleta inscrito não está inscrito.

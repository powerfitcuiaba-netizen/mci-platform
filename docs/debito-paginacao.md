# Débito operacional — paginação de listas

**Status:** aberto · **Prioridade:** alta · **Levantado em:** FASE 2.1 · **Documentado em:** FASE 2.2

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

Detalhe que importa: o `summary` (`total`, `checkedIn`, `pending`) é calculado
sobre o conjunto inteiro, não sobre a página. Ou seja, os contadores estão
certos mesmo com a lista cortada — é exatamente isso que permite à interface
saber que cortou, e avisar.

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

## 8. Decisão

- **Exige backend:** sim, para `listCheckIns` (Check-in e Pesagem), que são
  justamente as de maior impacto.
- **Não exige backend:** o resto, que só precisa da interface usar o cursor que
  já existe.
- **Não improvisar no frontend:** buscar repetidamente com `limit` crescente, ou
  emendar páginas por conta própria, criaria uma segunda verdade sobre a ordem
  dos dados e quebraria na primeira mudança de ordenação.

## 9. Enquanto isso

A interface **declara** o corte onde ele acontece. Uma lista incompleta que se
anuncia é um inconveniente; uma lista incompleta silenciosa é o operador
concluindo que um atleta inscrito não está inscrito.

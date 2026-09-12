# Calendário 2026 — o que entrou e o que falta

Fonte: `campeonatos_musclecontest_2026_evento_data_local_endereco.pdf`, recebido
do organizador. Transcrição literal em `data/campeonatos-2026.json`.

**47 eventos**, de 12/09/2026 a 12/12/2026.

## Como carregar

```bash
node scripts/importar-campeonatos.js --dry-run          # confere sem gravar
node scripts/importar-campeonatos.js                    # aplica
node scripts/importar-campeonatos.js --organizacao=<slug>
```

É **idempotente**: a chave é o slug, e rodar duas vezes não duplica evento. E o
`status` de um evento que já existe **nunca é rebaixado** — reimportar o
calendário não joga de volta para "planejado" uma etapa que já abriu inscrição
ou está em operação.

Os eventos entram como `PLANNED`, que é o primeiro estado visível ao público.
Abrir inscrição continua sendo ato do operador, na tela de Eventos.

## O que NÃO foi inventado

O documento marca vários campos como "a confirmar". Onde ele não informa, o
campo entra **vazio**. Cidade inventada em calendário de campeonato manda
atleta para o lugar errado — e ninguém descobre até o dia.

### Sem cidade nem UF — 10 eventos

| Nº | Evento | Data |
|---|---|---|
| 22 | Recife Naturals | 31/10/2026 |
| 31 | Iron Legends | 21/11/2026 |
| 33 | Sul Brasileiro | 21/11/2026 |
| 38 | Maradona Classic | 28/11/2026 |
| 41 | Copa Overall | 29/11/2026 |
| 42 | Masters Brasil | 05/12/2026 |
| 43 | Nacional | 06/12/2026 |
| 44 | Campeonato dos Titãs | 12/12/2026 |
| 45 | Noite dos Campeões | 12/12/2026 |
| 46 | Mercosul | 12/12/2026 |

O nome de alguns sugere a praça — "Recife Naturals" quase certamente é em
Recife —, mas o documento não diz, e sugestão não é dado.

### Sem local — 17 eventos

22, 27, 29, 31, 33, 34, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46.

### Sem endereço completo — 23 eventos

Os 17 acima, mais: 6 (Liga dos Campeões), 15 (Pantanal), 17 (Poços de Caldas),
23 (Classic Contest Rio Verde), 24 e 25 (Fit Pira e Fit Pira Naturals).

## Para completar

Edite `data/campeonatos-2026.json` preenchendo `cidade`, `uf`, `local` e
`endereco`, e rode o importador de novo. Ele atualiza o que mudou e deixa o
resto intacto.

## Decisões de mapeamento

| Dado do PDF | Campo do sistema | Por quê |
|---|---|---|
| Evento | `name` | — |
| Data | `startDate` / `endDate` | Meio-dia UTC: à meia-noite a data já virou no Brasil e 12/09 apareceria como 11/09 |
| Local | `venue` | — |
| Endereço | `description` | Não há campo de endereço no modelo; a descrição é o que a página pública exibe |
| — | `timezone` | Derivado da UF: Manaus e Cuiabá não estão no fuso de São Paulo, e bateria anunciada com uma hora de diferença é problema de operação |
| Fit Pira, Fit Pira Naturals | `startDate` ≠ `endDate` | Únicos de dois dias (07–08/11) |

## Pendente, e não é deste calendário

O **ranking** do fim de semana ainda não entrou. Quando chegar, o caminho é a
porta de recepção de resultado oficial (`POST /classes/:id/result`) ou a
importação MuscleWar — o MCI não julga, recebe o resultado decidido fora.

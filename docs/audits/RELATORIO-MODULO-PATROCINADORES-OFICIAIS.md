# Módulo oficial de patrocinadores — relatório final

**Branch:** `claude/patrocinador-no-banco-o6haz9` · **HEAD:** `0bb2567`
**Base:** `origin/main` em `bc3fdfe` · **Sem merge. Sem deploy. Sem alteração em produção.**
**Data:** 8 de outubro de 2026

---

## 1. O que foi pedido, e o que foi entregue

O pedido: tirar os patrocinadores do código e colocá-los no banco, com upload de
logo pelo super admin nas Configurações, em ordem de prioridade por tipo, e com
a possibilidade de retirar quem sai do circuito.

O entregue: um catálogo global novo (`OfficialSponsor`), com quatro níveis em
enum, ordem dentro do nível, logo armazenada pelo mesmo caminho de upload do
resto do produto, tela de administração só para SUPER_ADMIN, e a vitrine
inteira — tela de entrada, parede e faixa do rodapé — lendo do servidor. As 15
marcas que existiam no código foram migradas para o banco **com as artes**,
sem perder nenhuma e sem inventar nenhuma.

## 2. A decisão arquitetural: catálogo global novo

`Sponsor`, que já existia, é patrocínio **de um** evento, **de uma** equipe ou
**de um** atleta: tem `organizationId` e dono. O catálogo oficial é do
campeonato inteiro e não tem dono. Estendê-lo obrigaria a inventar uma
organização "a MCI" só para pendurar nela as marcas globais — e a partir daí
toda consulta de patrocínio de evento precisaria excluir essa organização
fantasma. O precedente certo no repositório é `Category`: catálogo global, sem
tenant.

Nenhuma tabela existente foi alterada. `Sponsor` e `Brand` continuam como
estavam.

## 3. O modelo de dados

```prisma
enum SponsorLevel { GLOBAL DIAMANTE GOLD SILVER }

model OfficialSponsor {
  id          String   @id @default(cuid())
  code        String   @unique
  name        String
  level       SponsorLevel
  sortOrder   Int      @default(0)
  active      Boolean  @default(true)
  logoKey     String
  siteUrl     String?
  createdById String?
  updatedById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([active, level, sortOrder])
}
```

`code` é o identificador estável e **não muda** depois de criado: é ele que
amarra a marca à arte já armazenada e ao provisionamento idempotente. O índice
é exatamente a consulta da vitrine: ativos, por nível, por ordem.

As duas relações com `User` (`createdBy`, `updatedBy`) são `onDelete: SetNull` —
apagar a conta de quem cadastrou não pode derrubar o patrocinador.

## 4. A migration

`prisma/migrations/20261008000000_patrocinadores_oficiais/migration.sql`,
escrita à mão: o enum, a tabela, o índice único de `code`, o índice composto,
as duas chaves estrangeiras, o predicado novo e as quatro políticas. Foi
escrita à mão porque a parte de RLS o `prisma migrate` não gera — e misturar
uma migration gerada com um bloco manual deixaria metade do arquivo
irreproduzível.

Medido no banco depois de aplicada:

| Conferência | Resultado |
|---|---|
| `relrowsecurity` / `relforcerowsecurity` | `RLS=true FORCE=true` |
| Políticas | **4** — comandos `r` (SELECT), `a` (INSERT), `w` (UPDATE), `d` (DELETE) |
| `mci_is_super_admin()` existe | sim |
| Enum `SponsorLevel` | `GLOBAL,DIAMANTE,GOLD,SILVER` |
| Tabelas com RLS forçada no banco | **35** |

## 5. RLS, e por que ela existe numa tabela global

`Category` é catálogo global e vive sem RLS, com razão: filtro de leitura em
catálogo lido por todo mundo não protege nada. Aqui a RLS foi ligada de todo
modo, e o que ela protege é **escrita**: quem entra na parede de patrocínio, em
que nível e em que ordem é contrato comercial do campeonato. A política existe
para que a mesa central seja a única mão que escreve, mesmo que uma rota futura
esqueça de conferir permissão.

`ENABLE ROW LEVEL SECURITY` não vale para o dono da tabela — e a aplicação
conecta como dono. Por isso `FORCE ROW LEVEL SECURITY`, que é a lição registrada
na migration `20260906180000_force_rls`.

A leitura tem o ramo que a vitrine precisa: `active = true` sai para qualquer
um, inclusive sem sessão, porque a parede aparece na tela de entrada.

## 6. O predicado novo, e o que NÃO foi tocado

```sql
CREATE OR REPLACE FUNCTION mci_is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "User" u
    WHERE u.id = mci_current_user_id() AND u.role = 'SUPER_ADMIN' AND u.status = 'ACTIVE')
$$;
```

`mci_is_platform_admin()` **não** foi alterado: ele aceita `ADMIN`, e esta mesa
é só do `SUPER_ADMIN`. Mudar o predicado existente para apertá-lo aqui
apertaria, de carona, todas as outras tabelas que o usam.

Nada de `BYPASSRLS`. Nada de `SECURITY DEFINER` privilegiado. Nenhuma política
`USING(true)`. Nenhuma política para `anon`. Nenhum `FORCE RLS` removido.

## 7. Permissão, e as três camadas de autorização

`sponsors.official` entrou em `PERMISSIONS` e está **fora** da lista do `ADMIN`.
Ela é distinta de `sponsors.manage`, que é o patrocínio de uma organização.

| Papel | `sponsors.official` |
|---|---|
| SUPER_ADMIN | ✅ |
| ADMIN | ❌ |
| EVENT_DIRECTOR | ❌ |
| ATHLETE | ❌ |
| JUDGE | ❌ |

São três barreiras para a mesma decisão, e cada uma tem teste:

1. **Rota** — `perm('sponsors.official')` nas quatro rotas de escrita.
2. **Serviço** — `assertPermission(ator, 'sponsors.official', null)`, escopo de
   plataforma.
3. **Banco** — a política. O caso 6 de `tests/patrocinadores-oficiais.test.mjs`
   escreve **direto pelo Prisma**, com ator sem privilégio, e prova que a
   terceira barreira recusa sozinha.

## 8. Os quatro níveis, em enum

Existem exatamente quatro: `GLOBAL`, `DIAMANTE`, `GOLD`, `SILVER`. Em enum do
banco e em `z.enum` na entrada — texto livre não é aceito em nenhum dos dois
lados. Nenhum nível adicional foi criado.

## 9. "APOIO E PARCEIROS" é apresentação, não nível

O rótulo do Silver é `Silver — apoio e parceiros`, e vive no dicionário de
idioma. Não existe nível `APOIO` em lugar nenhum: nem no enum, nem no banco, nem
na API.

## 10. O serviço

`src/services/officialSponsorService.js` expõe `paraAVitrine`, `paraOPainel`,
`criar`, `atualizar`, `trocarArte`, `arteParaEntrega` e `remover`.

A ordenação é uma só, e é a hierarquia: peso do nível → `sortOrder` → `name` →
`id`. O `id` entra apenas como desempate **final e determinístico de
apresentação** — não decide nada esportivo, nem ranking, nem colocação.

A vitrine pública não entrega `logoKey`: ela entrega `hasLogo`, e a arte sai por
rota própria. O QA mede isso (`a chave do armazenamento NÃO sai no corpo`), e
`tests/gate-superficie-publica.test.mjs` também.

## 11. Concorrência: a versão de origem

A edição envia `updatedAt` — a versão de onde partiu. Se outra pessoa salvou no
meio do caminho, a API responde **409 `SPONSOR_STALE`** em vez de sobrescrever
em silêncio. Duas mesas mexendo na mesma parede de patrocínio é cenário real.

## 12. Auditoria de toda escrita

Oito ações registradas: `OFFICIAL_SPONSOR_CREATE`, `UPDATE`, `CHANGE_LEVEL`,
`CHANGE_ORDER`, `CHANGE_LOGO`, `ACTIVATE`, `DEACTIVATE`, `DELETE` — mais
`OFFICIAL_SPONSOR_PROVISION` no provisionamento. A remoção exige **motivo**
(5 a 500 caracteres), e o motivo vai para a trilha.

## 13. Upload: MIME, assinatura de bytes e perfil de imagem

O arquivo passa pela mesma cadeia do resto do produto: lista de MIME aceitos,
**conferência da assinatura de bytes** (`motivoDeRecusaPorAssinatura`) e
normalização pelo `sharp`.

O perfil novo é `logo`: 1024×512, ajuste `inside`, qualidade 92. `inside`
significa que a arte **nunca é cortada** — ela encaixa na caixa do nível na
própria proporção. Um logotipo cortado é uma marca descaracterizada, e isso é
contrato comercial.

**SVG não entra.** A política de segurança do produto não aceita SVG em upload
— é documento executável, com script e referência externa possíveis. O motivo
está escrito no middleware, não implícito.

## 14. A chave do objeto é construída no servidor

`storage.buildKey('sponsors', mime)` devolve `sponsors/<uuid>.<ext>`. Nada do
cliente entra no caminho. Depois de gravar, o serviço confere
`storage.exists(chave)` — gravação que não pode ser lida de volta é falha, e
não sucesso silencioso.

## 15. A entrega da logo

`GET /api/v1/media/sponsors/:id/logo`, com `optionalAuth`. Está na lista de
rotas abertas de `tests/rotas.test.mjs`, **de propósito e com o motivo escrito**:
ela aparece na tela de entrada, onde por definição não existe sessão. Exigir
token para servir a arte de uma parede de patrocínio seria pedir senha para ver
um painel de patrocinador num ginásio.

O que a rota recebe é o `id`; a chave do objeto é resolvida no servidor. Não há
como pedir arquivo alheio por ela.

## 16. O defeito que teria quebrado produção

Em Chromium, **0 de 32** imagens de patrocinador decodificavam, enquanto o
`fetch` da mesma URL devolvia `200 image/webp`. A causa: o `helmet()` marca as
respostas com `Cross-Origin-Resource-Policy: same-origin`, e o navegador recusa
a imagem de outra origem **em silêncio**, sem erro de console e sem falha de
rede.

Em produção, web e API são hosts diferentes (`mci-platform-web` e
`mci-platform-api`). Isso significa que **todas** as logos apareceriam
quebradas, e nenhum teste de unidade veria. A correção é um cabeçalho
`Cross-Origin-Resource-Policy: cross-origin` aplicado só nesta resposta, por um
parâmetro `publico` em `enviarArquivo`.

Este achado é o argumento inteiro a favor do QA em navegador de verdade.

## 17. Logo de patrocinador desativado: 404, não 403

Quem administra o catálogo vê a arte de um patrocinador desativado. Para o resto
do mundo a rota responde **404** — e 404, não 403, para não confirmar a
existência do `id`. O QA mede os dois lados, e a suíte de backend também.

## 18. Desativar é o caminho normal; remover é a exceção

Desativar tira da vitrine e **preserva** o registro, o histórico e a
possibilidade de reativar. É um clique na linha. Remover é definitivo, apaga a
arte, exige motivo e tem diálogo próprio, com o texto dizendo em letras maiúsculas
que a remoção é definitiva e apontando o Desativar como alternativa.

Nada é excluído fisicamente por padrão.

## 19. Schemas de entrada

| Campo | Regra |
|---|---|
| `code` | `/^[A-Z0-9-]{2,40}$/`, só na criação |
| `level` | `z.enum` dos quatro |
| `sortOrder` | inteiro, 0 a 9999 |
| `siteUrl` | vazio → ausente; URL válida; máx. 300; **precisa começar com `https://`** |
| `motivo` (remoção) | texto de 5 a 500 |

A atualização tem todos os campos opcionais e um `.refine` que exige pelo menos
um campo além de `updatedAt` — `PATCH` vazio é erro de quem chamou, não um
no-op. `code` está deliberadamente **ausente** do schema de atualização.

## 20. As rotas

```
GET    /api/v1/public/sponsors                  (aberta, com limite de taxa)
GET    /api/v1/media/sponsors/:id/logo          (optionalAuth)
GET    /api/v1/official-sponsors                (sponsors.official)
POST   /api/v1/official-sponsors                (sponsors.official, upload)
PATCH  /api/v1/official-sponsors/:id            (sponsors.official)
DELETE /api/v1/official-sponsors/:id            (sponsors.official)
POST   /api/v1/official-sponsors/:id/logo       (sponsors.official, upload)
```

As quatro de escrita foram declaradas em `tests/matriz-de-autorizacao.mjs` com
escopo de plataforma e o `porQue` escrito, e o gate de contagem de rotas foi de
143 para 147.

## 21. O provisionamento das 15 marcas

`scripts/provisionar-patrocinadores-oficiais.js` importa a lista do frontend em
tempo de execução, deriva o `code` do nome do arquivo e sobe cada PNG pelo
**mesmo** caminho de upload da tela: normalização pelo perfil `logo`, gravação e
conferência de que o objeto existe.

É idempotente, e isso foi medido: primeira execução cria 15; segunda diz "nada a
fazer". Conferido agora, com `--conferir` (somente leitura):

```
na lista do frontend     15
já no banco              15
a provisionar            0
nada a fazer: as 15 marcas já estão no catálogo.
```

Nenhuma marca foi inventada, nenhum nome substituído, nenhuma das 15 removida.

## 22. Os PNGs do repositório

Continuam onde estavam: **15 arquivos** em `frontend/public/patrocinadores/`.
O diff da branch contra a `main` apaga **0** arquivos. `lib/patrocinadores.js`
continua existindo e passou a ser, declaradamente, a **fonte da migração** — a
lista `MARCAS` é consumida só pelo script de provisionamento. O que o arquivo
ainda possui é apresentação: caixas por nível, duração do ciclo, sentido da
faixa.

## 23. O deploy, quando for autorizado

`render.yaml` passou a terminar o `preDeployCommand` com o provisionamento:

```
preDeployCommand: npx prisma migrate deploy
  && node scripts/provisionar-contas-de-servico.js
  && node scripts/provisionar-patrocinadores-oficiais.js
```

Roda depois de o banco estar migrado e antes de o tráfego chegar. Como é
idempotente, deploys seguintes não fazem nada.

## 24. O catálogo no frontend

`frontend/src/lib/catalogoDePatrocinio.js` guarda **uma** promessa em nível de
módulo: a vitrine, a parede e a faixa compartilham a mesma leitura em vez de
pedirem três vezes. `invalidar()` derruba o cache depois de qualquer escrita no
painel.

Ele foi endurecido depois de um defeito real: um erro na chamada derrubava o
shell inteiro. Agora a cadeia começa com `Promise.resolve()`, o `catch` limpa a
promessa em voo, registra no console e devolve lista vazia. Catálogo
indisponível tem de deixar a tela de entrada em pé.

## 25. Vitrine, faixa e tela de entrada

As três leem do servidor. A parede agrupa pelos quatro níveis; a faixa do rodapé
respeita a ordem que o servidor já mandou, sem reordenar.

**Não existe lista de patrocinador escrita em tela nenhuma** — nem no Login, nem
no Ranking, nem na Home, nem na faixa, nem em página pública.

A logo vira link só quando há `siteUrl`, com `target="_blank"` e
`rel="noopener noreferrer"`, e com `aria-label` dizendo de quem é o site. Nas
cópias medidas da esteira o link não é repetido — leitor de tela não anuncia a
mesma marca seis vezes.

## 26. A tela do super admin

`Configurações → Patrocinadores`, agrupada pelos quatro níveis, na ordem da
hierarquia. Cada linha tem prévia da arte, nome, código, ordem, selo de
situação e três ações: Editar, Desativar/Reativar, Remover.

Adicionar é **um modal só**, com a logo junto — patrocinador sem arte não tem o
que mostrar. A prévia do arquivo escolhido sai de um `blob:` local: nada sobe
antes de enviar, e a URL é revogada na troca e na desmontagem.

Há um botão **"Visualizar como público"** que monta o MESMO componente do rodapé
público. Uma cópia divergiria do que o visitante vê, que é justamente o que uma
prévia existe para evitar.

Nada de arrastar para mudar de nível: hierarquia é contrato comercial, e arrasto
é acidente esperando acontecer.

A tela confere a permissão, mas essa conferência é **conveniência, não defesa**:
o menu Configurações é liberado por `users.read`, que o diretor de evento tem.
Quem autoriza é a API, e abaixo dela o banco.

## 27. Internacionalização

**61 chaves `patrocinadores.*` em cada um dos três idiomas** (pt-BR, en, es) —
conferido: 61 / 61 / 61. Não só as 13 que o gate apontou: a tela inteira passou
pelo dicionário, incluindo rótulos de campo, dicas, textos de confirmação,
textos alternativos das imagens e as cinco mensagens de notificação.

O que **não** se traduz: `GLOBAL`, `DIAMANTE`, `GOLD` e `SILVER` são o enum do
banco e os nomes comerciais dos níveis; continuam idênticos nos três idiomas.
O que se traduz é o rótulo ao lado deles.

`src/lib/idiomaCobertura.test.js` volta a zero.

## 28. Defeitos encontrados e corrigidos

Nenhum ficou registrado sem correção.

| # | Defeito | Como apareceu | Correção |
|---|---|---|---|
| 1 | `Cross-Origin-Resource-Policy` bloqueava **todas** as logos entre origens | 0 de 32 imagens decodificando no Chromium, com `fetch` em 200 | cabeçalho `cross-origin` só nesta resposta |
| 2 | O campo "Motivo" da remoção aceitava **só a primeira letra** | sonda medindo `focado=false` após a primeira tecla | `ConfirmarRemocao` extraído com estado próprio; teste 21a tranca |
| 3 | Erro no catálogo derrubava o shell inteiro | duas suítes de frontend caindo juntas | `Promise.resolve().then(...)` + `catch` que devolve lista vazia |
| 4 | Dois cabeçalhos empilhados na tela | leitura da própria tela | cabeçalho de seção, não um segundo `PageHead` |
| 5 | Ícone de "Desativar" era `Upload` | leitura da própria tela | `EyeOff` / `Eye` |
| 6 | Campos de texto sem `type` explícito | seletor do QA não casava | `type="text"` declarado |
| 7 | Tela inteira fora do dicionário | `idiomaCobertura` com teto 0 | 61 chaves nos três idiomas |

E dois defeitos **do roteiro de QA**, não do produto, corrigidos do mesmo modo:

| # | Defeito | Como apareceu | Correção |
|---|---|---|---|
| 8 | O roteiro engolia a recusa do `criar-admin.js` e seguia com senha errada | `Timeout 30000ms` esperando uma aba, 30s depois do verdadeiro `401` | senha da conta de QA redefinível (só o hash, no contexto da própria conta); papel e situação **conferidos**, não concedidos |
| 9 | A pasta de arquivos levava a hora no nome, trocando o armazenamento debaixo do banco | 0/15 prévias no painel e 2/32 na esteira | a pasta acompanha o banco |

O roteiro também passou a imprimir print, abas presentes e erros de página
**antes** da primeira conferência de tela: "a aba não apareceu" agora vem com o
motivo.

## 29. Os gates que reprovaram, e o que cada um protegia

Cinco travas do repositório reprovaram esta mudança. Todas por fazerem o próprio
trabalho, e todas respondidas com o motivo escrito — nenhuma relaxada, nenhuma
desativada.

| Gate | O que cobrou |
|---|---|
| `tests/rotas.test.mjs` | rota aberta precisa estar declarada como aberta, com a razão |
| `tests/gate-autorizacao-por-rota.test.mjs` | rota de escrita precisa estar na matriz; contagem 143 → 147 |
| `tests/rls-runtime.test.mjs` | tabela com RLS forçada precisa ser decisão consciente; 34 → 35 |
| `scripts/backup-storage.js` | todo campo `*Key` precisa estar classificado — e a guarda é *fail closed* |
| `tests/empacotamento-importador.test.mjs` | migration nova precisa entrar no inventário homologado |

A do backup merece nota: a guarda **interrompe a execução** diante de um campo
`*Key` desconhecido. O efeito de não responder a ela não seria um backup errado
— seria backup **nenhum**.

## 30. O backup do storage

`logoKey` aponta para o armazenamento, então entrou no padrão de campos de
arquivo de `scripts/backup-storage.js`. Um backup sem ela restauraria um
catálogo de quinze patrocinadores e nenhuma logo.

`logoKey` também entrou nas listas de campos proibidos de
`tests/vazamento-de-storage.test.mjs` e `tests/gate-superficie-publica.test.mjs`:
chave de objeto não sai em corpo de resposta.

## 31. Testes de backend

`tests/patrocinadores-oficiais.test.mjs` — **35 testes**, todos passando.
Cobrem: a vitrine anônima e o que ela não entrega; a ordenação pela hierarquia;
criação, edição, troca de nível, de ordem e de arte; o 409 de versão velha; o
404 da logo desativada para quem não administra e o 200 para quem administra; a
recusa de MIME e de assinatura de bytes; a remoção com motivo e a auditoria; e o
caso 6, que escreve **direto pelo Prisma** com atores sem privilégio para provar
que a política do banco recusa sozinha.

## 32. Testes de frontend

`frontend/src/pages/patrocinadoresOficiais.test.jsx` — **24 testes**, incluindo
o 21a, que tranca o defeito de foco do campo "Motivo".

Reescritas contra o catálogo do servidor: `faixaDePatrocinio.test.jsx` (22),
`telaDeEntrada.test.jsx` (21), `faixaNoRodape.test.jsx` (15). `App.test.jsx` e
`acessoPublicoSemLogin.test.jsx` ganharam o dublê de `publicApi.sponsors`.

**Suíte inteira: 72 arquivos, 953 testes — todos passando.**

Uma limitação registrada, não escondida: no jsdom, `userEvent.upload` preenche
`files` mas não `value`, então um `input[type=file] required` reprova
`checkValidity()` e o `submit` não dispara. O teste 14 usa
`fireEvent.submit(form)` com a limitação escrita no próprio teste; **o clique no
botão está coberto pelo QA em Chromium**, que é navegador de verdade.

## 33. QA em Chromium

`scripts/qa/patrocinadores-navegador.mjs` — **36 conferências, 0 falhas**, em
Chromium de verdade, com API e frontend construídos e servidos.

```
✓ as 15 marcas migradas estão na vitrine pública (achei 15)
✓ a vitrine vem na ordem da hierarquia (GLOBAL … SILVER)
✓ a chave do armazenamento NÃO sai no corpo
✓ a aba "Patrocinadores" existe em Configurações
✓ os quatro níveis, na ordem da hierarquia (Global | Diamante | Gold | Silver — apoio e parceiros)
✓ as 15 marcas aparecem no painel (achei 15)
✓ as 15 prévias DECODIFICARAM de verdade (achei 15 de 15)
✓ a prévia da logo escolhida aparece ANTES de salvar, sem subir nada
✓ o patrocinador novo aparece na VITRINE PÚBLICA, sem sessão
✓ e no nível escolhido (SILVER) · ✓ e com logo
✓ a logo é servida ao anônimo (200 image/webp)
✓ o nível mudou para GLOBAL · ✓ e ele subiu para o topo da vitrine (posição 2 de 16)
✓ a confirmação explica que o registro é preservado
✓ desativado, ele SUMIU da vitrine pública · ✓ e a logo dele também (404)
✓ mas ele CONTINUA no painel administrativo, para ser reativado
✓ reativado, ele VOLTOU para a vitrine
✓ a tela de edição mostra a LOGO ATUAL
✓ a logo servida MUDOU — os bytes são outros · ✓ e a nova não veio vazia
✓ a hierarquia de tamanho NÃO inverte (global 6336 > diamante 4592 > gold 3360 > silver 2924)
✓ a faixa mostra as 16 marcas do catálogo · ✓ todas as artes decodificaram (32/32)
✓ sem rolagem horizontal (sobra 0px)
✓ a TELA DE ENTRADA monta a parede a partir do catálogo
✓ com as quatro faixas (achei 4) · ✓ e as 16 marcas (achei 16)
✓ com as artes decodificando
✓ 390px: sem rolagem horizontal (sobra 0px)
✓ 390px: as 16 linhas continuam legíveis (achei 16)
✓ o patrocinador de teste saiu da vitrine
✓ e o catálogo voltou às 15 marcas reais (achei 15)
✓ nenhum lixo de teste ficou para trás
✓ nenhum erro vindo da aplicação (achados: 0)
```

O roteiro **remove o patrocinador que criou** e confere que o catálogo voltou às
15 marcas reais. Ele não deixa lixo.

## 34. Regressão, CI, estado do Git e veredito

**Regressão de backend completa, local**, em PostgreSQL 16 com RLS ligada e a
aplicação conectando como dono (não superusuário):

```
Test Files  155 passed (155)
     Tests  2791 passed (2791)
```

**Suíte de frontend completa:** `72 passed (72)` · `953 passed (953)`.

**CI — run `37817472376`, no commit `0bb2567`:**

| Job | Resultado |
|---|---|
| Higiene do repositório | **success** |
| Frontend — testes e build | **success** |
| Backend — migrations, RLS e testes | **success** |

**Git:** branch `claude/patrocinador-no-banco-o6haz9`, HEAD `0bb2567`, árvore de
trabalho limpa, 5 commits, histórico preservado. Sem squash, sem rebase, sem
force push. `origin/main` intocada.

### O que NÃO foi feito, por determinação explícita

- **Nenhum merge na `main`.**
- **Nenhum deploy.**
- **Nenhuma alteração em dado de produção**, nem estrutural nem de conteúdo.
- Nenhum PNG do repositório apagado.
- Nenhum teste removido, desativado ou simplificado para ficar verde.
- Nenhuma cobertura reduzida. Nenhuma RLS removida.
- Nada de pagamento, cobrança, PIX, boleto ou checkout — **este aplicativo não é
  um sistema financeiro**.
- Nada de apuração interna: **o MCI não julga**.
- Nenhum registro real de atleta, resultado, vínculo, ponto ou ranking foi
  alterado. O cadastro de Lucas Gouveia Lima não foi tocado.
- A fórmula de ranking de treinadores continua **não homologada**
  (`FORMULA_HOMOLOGADA = false`, HTTP 409).

### O que está NOT TESTED, e por quê

**Produção.** O contêiner desta sessão alcança apenas `api.github.com`;
`*.onrender.com` e `api.render.com` respondem **403 CONNECT**. Nenhuma
afirmação sobre o ambiente de produção foi feita neste relatório, e nenhuma pode
ser feita daqui.

O que está provado é o caminho de deploy, não o deploy: a migration aplica em
banco limpo, o provisionamento é idempotente, e a `preDeployCommand` executa os
dois na ordem certa.

---

## VEREDITO

# PASS

Todo item verificável desta tarefa foi verificado com execução real: 2791 testes
de backend, 953 de frontend, 36 conferências em navegador e a CI em 3/3 no
commit que é o HEAD da branch. Os nove defeitos encontrados — incluindo um que
teria quebrado **todas** as logos em produção — foram corrigidos, e cada um tem
teste ou medição que o tranca.

A branch está pronta para você testar. O merge e o deploy continuam seus.

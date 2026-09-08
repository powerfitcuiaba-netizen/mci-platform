# Portão final de segurança

Varredura da fase 12.7, executada contra a API rodando em
`NODE_ENV=production` e contra o código. O que está aqui foi **provado por
requisição ou por medição**, não inferido da leitura.

Três achados. Dois eram defesas que existiam e **não funcionavam**; o terceiro
era uma limpeza rígida demais que atrapalhava a operação sem proteger mais.

---

## Achado 1 — origem de CORS não listada virava erro 500

`app.js` devolvia `new Error('Origem não permitida pelo CORS')` no callback do
`cors`. O pacote propagava esse erro para o tratador, e **toda** requisição com
um `Origin` desconhecido produzia:

* `HTTP 500 INTERNAL_ERROR` — status errado: origem não listada é política do
  navegador, não falha do servidor;
* uma linha de log em **nível `error`**, numa rota **anônima**.

O segundo item é o que importa: qualquer pessoa na internet podia encher o log
de erro mandando um cabeçalho `Origin`. Erro de verdade some no meio do ruído,
e o volume de log vira custo.

**Correção:** origem não listada responde normalmente, **sem** os cabeçalhos de
CORS. É o navegador que barra a leitura — que é como o mecanismo funciona.

> **CORS não é barreira de autorização.** Ele protege o navegador da vítima,
> não o servidor: um `curl` ignora CORS por completo. Quem impede acesso
> indevido aqui é autenticação, RBAC e RLS — e é isso que os testes exercitam.

Conferido depois da correção: `GET` e preflight de origem estranha respondem
`200` sem `Access-Control-Allow-Origin`, e **zero** linhas de erro no log.

---

## Achado 2 — a defesa de tempo constante no login era 3 ordens de grandeza fora

`authService.login` já comparava a senha contra um hash descartável quando o
email não existia, com o comentário certo ao lado: *"para que o tempo de
resposta não revele quais emails existem"*.

Só que o hash descartável era um literal de **custo 04**, enquanto os hashes
reais nascem com o custo configurado — 10 ou 12. Medido:

| Comparação | Tempo |
|---|---|
| contra o hash descartável (custo 04) | **0,03 ms** |
| contra hash real de custo 10 | **80 ms** |
| contra hash real de custo 12 | **313 ms** |

Ou seja: a comparação acontecia, o comentário prometia, e o relógio continuava
dizendo em voz alta quais emails existem. O limitador de tentativas
(10 por 15 minutos) reduz o alcance prático, mas defesa não se apoia só nele —
e uma defesa que não faz o que diz é pior do que uma ausente, porque ninguém
volta a olhar.

**Correção:** o hash descartável passa a ser gerado uma vez, na carga do
módulo, com **o mesmo custo** dos hashes reais.

**O teste que guarda:** varredura do código atrás de hash bcrypt escrito à mão
(`$2a$NN$...`). Aferir o custo em tempo de execução não serviria — na suíte
`BCRYPT_ROUNDS` é 4, o mesmo do literal que existia, e a asserção passaria com
o defeito de pé. Medir tempo em CI seria teste instável. O que causa o
problema é o **custo congelado dentro de um literal**, e é isso que o teste
proíbe.

---

## Achado 3 — a chave de armazenamento perdia a árvore de prefixos

`storageService.buildKey` limpava o escopo com
`String(scope).replace(/[^a-zA-Z0-9_-]/g, '')` — sobre a string inteira. Isso
apagava também a barra que os próprios chamadores passam de propósito:
`events/<id>` virava `events<id>`.

Segurança não mudava (nada do cliente compõe o caminho, e a travessia já era
impossível). O que se perdia era a organização do bucket: em vez das árvores
`events/` e `athletes/`, uma pasta por recurso no nível raiz — e com isso a
possibilidade de escrever regra de ciclo de vida ou política de acesso **por
prefixo** no provedor de objetos, que é justamente o que o runbook recomenda.

**Correção:** a limpeza passa a ser **por segmento**. Cada segmento perde tudo
que não seja letra, dígito, `_` ou `-`, então `..` e `.` viram vazio e somem no
filtro. Testado com dez entradas hostis (`../../etc/passwd`, `a/../../b`,
`\..\..\x`, byte nulo, `%2e%2e`, barras duplas): nenhuma produz `..`, nem
caminho absoluto, nem barra dupla.

> As asserções de travessia **passam também no código antigo** — a proteção já
> existia. Elas ficam como trava do comportamento; a asserção nova de fato é a
> da árvore de prefixos.

---

## O que foi sondado e estava certo

Tudo abaixo por requisição real contra a API em produção.

| Frente | Resultado |
|---|---|
| **Cabeçalhos** | CSP restritiva (`default-src 'self'`, `object-src 'none'`), HSTS com `includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options`, COOP/CORP `same-origin`, sem `X-Powered-By` |
| **CORS** | origem listada é autorizada; origem estranha não recebe cabeçalho; sem curinga; `Origin: null` não é ecoado |
| **JWT** | `HS256`, validade de 12 h; `alg: none` recusado (401); assinatura adulterada recusada (401) |
| **Enumeração** | login com email existente e inexistente devolve **a mesma resposta**; o registro não confirma email já cadastrado |
| **Força bruta** | limitador ativo em produção: 8 tentativas e então `429` com `Retry-After` |
| **SQL** | `' OR 1=1--`, `"; DROP TABLE "Athlete";--` e `%` como termo de busca: `200`, nada executado, as 73 tabelas de pé. O Prisma parametriza; `limit` malformado é recusado na validação (`400`) |
| **Operador do Prisma via JSON** | `{"cpf":{"not":null}}` no corpo é recusado pelo esquema |
| **IDOR** | atleta de outra organização responde `404` na leitura e na escrita — não `403`, para não confirmar existência |
| **Upload — travessia** | nome `../../../../etc/mci-invadido.txt` é reduzido ao nome-base; a chave é UUID gerado pelo servidor; nada escapou do diretório |
| **Upload — tipo** | `.sh` e `.php` recusados com `415` |
| **Upload — tamanho** | 12 MB recusado com `413` |
| **Log** | nenhuma senha, token, hash ou CPF nas linhas geradas — `cpf` está na lista de chaves redigidas |
| **Dependências** | `npm audit` em zero, backend e frontend (ver `DEPLOY.md` §7.9) |
| **RLS** | `AthleteIdentity` devolve zero sem contexto de ator e zero para organização vizinha; `FORCE RLS` em 21 tabelas; a aplicação recusa subir com papel superusuário |

---

## Observação registrada, sem mudança

**A validação de corpo roda antes da verificação de permissão** em parte das
rotas — as que verificam no serviço, e não no middleware `perm(...)`. Efeito
prático: um usuário autenticado sem permissão recebe `400` com os valores
válidos do enum antes de receber `403`.

Não foi alterado. O que vaza é o formato do próprio esquema, que é público de
qualquer jeito, e **nada é executado** antes da autorização — só a checagem de
forma. Inverter a ordem em todas as rotas é refatoração ampla, com risco de
regressão maior do que o ganho. Fica anotado para quem quiser padronizar.

Repare que o visitante **anônimo** não vê nem isso: `requireAuth` vem antes da
validação, então sem token a resposta é `401` — conferido nas 18 sondas
anônimas de `tests/rbac-matriz.test.mjs`.

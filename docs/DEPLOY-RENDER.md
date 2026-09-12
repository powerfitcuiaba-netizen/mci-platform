# Subir o MCI Platform no Render + Cloudflare R2

Roteiro operacional. Os **valores** das variáveis vêm do código e são exatos —
`src/config/environment.js` recusa a partida se algum estiver errado. A
**navegação do painel** do Render é descrita de forma aproximada, porque a
interface muda; procure pelo nome do campo, não pela posição na tela.

> **Estado de verificação.** Este roteiro não foi executado contra o Render: o
> ambiente onde foi escrito tem egress bloqueado para `render.com`. O que está
> verificado é o outro lado — a imagem Docker foi construída e executada, a API
> subiu com `NODE_ENV=production`, `/ready` respondeu com database, storage e
> RLS verdadeiros, e as guardas de partida recusaram configuração incompleta.
> Ver o cabeçalho do `Dockerfile`.

---

## Por que três serviços

O backend **não serve arquivo estático** (`src/app.js` não tem `express.static`).
Isso é decisão de arquitetura, não esquecimento: o bundle do Vite vai para um
host estático, que é mais barato e mais rápido que passar por Node.

```
mci-web  (estático)  ──HTTPS──▶  mci-api  (Docker)  ──▶  mci-db (PostgreSQL)
                                     │
                                     └──▶  Cloudflare R2  (uploads)
```

---

## Passo 1 — Cloudflare R2

Sem armazenamento a aplicação **recusa subir**, e com disco local no Render
todo upload desaparece no primeiro redeploy. Por isso o R2 vem antes.

1. Painel da Cloudflare → **R2** → criar bucket, por exemplo `mci-uploads`.
2. **R2 → Manage API Tokens** → criar token com permissão de leitura e escrita
   **apenas nesse bucket**. Não use um token de conta inteira.
3. Anote os quatro valores:

| Variável | Onde encontrar |
|---|---|
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | o nome do bucket |
| `S3_ACCESS_KEY_ID` | do token |
| `S3_SECRET_ACCESS_KEY` | do token — aparece **uma vez só** |

`S3_REGION` é `auto` e `S3_FORCE_PATH_STYLE` é `true` no R2. Ambos já estão
fixados no `render.yaml`.

---

## Passo 2 — Banco

Render → **New → PostgreSQL**.

- **Version:** 16
- **Plan:** o gratuito **expira sozinho** depois de um período. Para campeonato
  de verdade, escolha um plano pago antes de cadastrar o primeiro atleta.

Guarde a **Internal Database URL** (a interna, não a externa — é mais rápida e
não sai da rede do Render).

**Por que o Render serve para este sistema:** a aplicação exige uma conexão que
**não seja superusuário** e que todas as tabelas com RLS tenham `FORCE`
(`src/config/rlsGuard.js`). O papel que o Render entrega não é superusuário, e
o `FORCE` vem das próprias migrations. Se por qualquer motivo isso não valer, a
API **não sobe** e diz exatamente qual é o problema — você descobre na hora, não
depois de vazar dado.

---

## Passo 3 — API

Render → **New → Web Service** → conectar `powerfitcuiaba-netizen/mci-platform`,
branch `main`.

- **Runtime:** Docker (o `Dockerfile` da raiz)
- **Health Check Path:** `/health`
- **Plan:** no gratuito o serviço **hiberna** sem tráfego e a primeira
  requisição depois disso leva perto de um minuto. Em dia de evento isso é
  inaceitável — suba para um plano pago antes da competição.

Variáveis:

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | a Internal Database URL do passo 2 |
| `JWT_SECRET` | **gere agora**: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `BCRYPT_ROUNDS` | `12` |
| `RATE_LIMIT_ENABLED` | `true` |
| `TRUST_PROXY_HOPS` | `1` |
| `LOG_LEVEL` | `info` |
| `DEFAULT_TIMEZONE` | `America/Sao_Paulo` |
| `STORAGE_DRIVER` | `s3` |
| `S3_*` | os quatro valores do passo 1, mais `S3_REGION=auto` e `S3_FORCE_PATH_STYLE=true` |
| `CORS_ORIGINS` | **ainda não** — só no passo 5 |

`JWT_SECRET` precisa ter 32+ caracteres e não pode ser valor de exemplo; a
validação verifica as duas coisas. Trocá-lo depois desloga todo mundo.

### Migrations

Se o plano oferecer **Pre-Deploy Command**, use `npx prisma migrate deploy` — as
migrations rodam antes de a nova versão receber tráfego. Se não oferecer, abra o
**Shell** do serviço e rode uma vez:

```bash
npx prisma migrate deploy
```

Nunca `migrate dev` e nunca `db push` em produção: os dois podem reescrever
schema sem registro.

---

## Passo 4 — Frontend

Render → **New → Static Site** → mesmo repositório, branch `main`.

- **Build Command:** `npm --prefix frontend ci && npm --prefix frontend run build`
- **Publish Directory:** `frontend/dist`
- **Rewrite:** origem `/*` → destino `/index.html`, tipo **Rewrite**

Sem esse rewrite, recarregar a página em `/ranking` devolve 404 — a interface é
uma SPA e o roteamento é do navegador.

---

## Passo 5 — Amarrar as duas pontas

As duas URLs só existem agora. Preencha:

- No **mci-api** → `CORS_ORIGINS` = a URL completa do site, com `https://` e
  **sem barra no final**. Ex.: `https://mci-web-a1b2.onrender.com`
- No **mci-web** → `VITE_API_URL` = a URL da API **com o caminho da versão**.
  Ex.: `https://mci-api-a1b2.onrender.com/api/v1`

Depois: **redeploy dos dois**.

> `VITE_API_URL` é lido em tempo de **build** — o Vite grava o valor dentro do
> bundle. Salvar a variável não basta: o site precisa ser **reconstruído**.
> Se um dia a URL da API mudar, reconstrua o frontend.

---

## Passo 6 — Primeiro administrador

Pelo **Shell** do `mci-api`:

```bash
ADMIN_PASSWORD='<senha forte, que você escolhe>' \
  node scripts/criar-admin.js "Nome Completo" voce@dominio.com
```

Os argumentos são **posicionais**. A ferramenta recusa senha por argumento (ela
ficaria no histórico) e **só cria o primeiro** administrador — depois disso,
conceder o papel é operação de administração, com auditoria. Ou seja: você tem
uma tentativa. Confira o comando antes de apertar enter.

---

## Quando `/ready` disser `storage: false`

A sonda agora explica a própria reprovação, como o RLS sempre fez:

```json
{"ready": false,
 "checks": {"database": true, "storage": false, "rls": true},
 "storage": ["o armazenamento respondeu 403: credencial recusada ou sem permissão no bucket — confira o par de chaves e o escopo do token"]}
```

O que sai é **status HTTP e o `<Code>` do serviço** — nunca o corpo bruto da
resposta. Erro de credencial em S3 devolve a Access Key dentro do XML, e
`/ready` é público.

Para o diagnóstico completo, rode **no shell do serviço**, onde as variáveis já
existem:

```bash
node scripts/diagnostico-r2.js
```

Ele exercita o ciclo inteiro — HEAD, PUT, HEAD, STAT, GET, DELETE, HEAD — e diz
onde parou. Nenhum segredo é impresso: a Access Key aparece só com os quatro
últimos caracteres, o Secret nunca. O objeto de teste tem chave própria
(`.mci-qa/r2-healthcheck-<timestamp>`) e é removido no fim; nada mais no bucket
é tocado.

Por que o script e não só o `/ready`: o `healthCheck` usa **HEAD**, e resposta a
HEAD não tem corpo — por essa porta só o status está disponível. O script usa
verbos que devolvem corpo, então alcança também o `<Code>`, que é o que separa
`InvalidAccessKeyId` de `AccessDenied` de `NoSuchBucket`.

As causas mais comuns, na ordem em que vale conferir:

| `<Code>` | O que costuma ser |
|---|---|
| `InvalidAccessKeyId` | usou um **Account API Token** em vez das credenciais do **token de R2** (que geram Access Key + Secret) |
| `SignatureDoesNotMatch` | Secret não corresponde à Access Key, ou sobrou **espaço/quebra de linha** no valor colado |
| `AccessDenied` | credencial válida, mas o token não tem permissão **neste** bucket |
| `NoSuchBucket` | `S3_BUCKET` errado, ou endpoint de outra conta |

O script também acusa espaço ou quebra de linha sobrando em qualquer variável —
é o defeito de configuração mais comum e o mais difícil de enxergar no painel.

---

## Passo 7 — Smoke test

```bash
curl -s https://SUA-API/health          # 200
curl -s https://SUA-API/ready           # database, storage e rls verdadeiros
```

Depois, no navegador: entrar, abrir **Ranking**, abrir um resultado publicado,
enviar um arquivo e confirmar que ele aparece.

**E um teste específico, que existe por causa de um defeito real corrigido no
gate:** abra `/ranking` **deslogado**, depois **logado**. As duas respostas
precisam ser iguais. Durante o QA, quem estava autenticado e não era membro da
federação recebia **500** onde o visitante anônimo recebia 200 — autenticar-se
entregava menos. Está corrigido e travado por teste, mas é o primeiro lugar onde
eu olharia em produção.

---

## O que observar nas primeiras horas

| Sinal | O que significa |
|---|---|
| taxa de 5xx | a linha de base medida no gate é **zero** nessas rotas |
| `25P02` no log | a corrida de vínculo atleta↔equipe voltando |
| `P2003` no log | chave estrangeira sem tratamento — hoje só deve aparecer no log, nunca na resposta |
| 401/403 por IP | tentativa de acesso indevido |
| latência de `/ranking` | é a tela mais visitada |

---

## Rollback

As migrations desta versão são **aditivas** — nenhuma `DROP`. Reverter é
apontar o deploy para o commit anterior; o banco continua compatível. O release
candidate validado é **`838f81e`**, preservado como ancestral de `main`.

---

## O que este roteiro não resolve

**Domínio próprio.** Enquanto for `*.onrender.com`, é endereço de teste. Para
`mci.com.br` ou similar: apontar o DNS, configurar o domínio nos dois serviços
e **atualizar `CORS_ORIGINS` e `VITE_API_URL`** — com rebuild do frontend.

**Backup.** O Render faz backup do banco conforme o plano, mas os scripts
próprios (`scripts/backup.sh`, com os 11 ensaios cobertos na suíte) exigem um
papel com `BYPASSRLS` e um destino de armazenamento. Configure antes do primeiro
evento real, não depois.

**Homologação esportiva.** Independente disto tudo, e pendente do comitê: o
critério de campeão Overall não está homologado. O MCI **não julga** — recebe o
resultado oficial decidido externamente.

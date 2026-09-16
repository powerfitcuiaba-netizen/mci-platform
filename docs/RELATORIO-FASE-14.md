# FASE 14 — Ambiente de preview para teste humano

Publicado a partir de `claude/mci-platform-muscle-contest-o6haz9`. A `main`
continua congelada em `fc4621d`, nenhum merge foi feito e o ambiente de
produção não foi tocado.

---

## URL

| | |
|---|---|
| **PREVIEW URL** | https://experienced-implied-acid-streaming.trycloudflare.com |
| **API URL** | https://added-ram-studio-frankfurt.trycloudflare.com |
| **BRANCH** | `claude/mci-platform-muscle-contest-o6haz9` |
| **SHA** | `a7773910fae077d1f7ecb5edef4fe1a4eed7f496` |
| **AMBIENTE** | QA/PREVIEW |
| **STATUS** | ONLINE |
| **Subiu em** | 2026-09-16 03:26 UTC |
| **Janela** | 330 minutos |

O endereço vigente fica sempre em
[`preview-estado/PREVIEW-ATUAL.md`](https://github.com/powerfitcuiaba-netizen/mci-platform/blob/preview-estado/PREVIEW-ATUAL.md).
Cada execução sorteia um endereço novo.

## Por que o preview nasce no runner do GitHub

Auditado host a host, desta rede: o `CONNECT` para `render.com`, `vercel`,
`netlify`, `fly.io`, `railway`, `deno`, `ngrok`, `cloudflare`, `localhost.run`,
`srv.us` e `bore.pub` volta **403 por política**. Só o GitHub responde.

O runner do Actions tem internet. Ele é o único lugar de onde este projeto
consegue publicar, e é de lá que o ambiente sobe: PostgreSQL, API, frontend e
dois túneis da Cloudflare, tudo dentro do job.

## Ambiente

| Peça | O que é |
|---|---|
| Banco | PostgreSQL 16 de QA, criado e destruído com o job |
| Papel da aplicação | `mci_owner`, **sem superusuário** — senão o RLS não valeria nada |
| API | modo **produção**: bcrypt 12, rate limit ligado, trust proxy 1 |
| Storage | disco do runner, efêmero, com `ALLOW_LOCAL_STORAGE` assumido |
| Frontend | build de produção do Vite, servido por `scripts/qa/servir-estatico.mjs` |
| CORS | só a origem do preview; curinga recusado |

Nada de produção é reutilizado: banco, storage, API e frontend são todos do
ambiente de QA, e morrem com ele.

## Health e Ready

Medidos **pela URL pública**, atravessando o túnel:

```
/health   status ok
/ready    200 · database ok · storage ok · rls ok
```

## CORS

```
preflight com a origem do preview   →  liberada, e devolvida por extenso
curinga                             →  não usado
origem desconhecida                 →  não liberada
```

## Dados de demonstração

Tudo fictício, tudo marcado `QA · DEMO`. Construído **pela API**, nunca
escrevendo no banco: se uma regra recusasse, a semeadura falharia alto.

Uma federação, duas filiações (NPC-MT e NPC-SP), temporada 2026, três etapas
encerradas e uma com inscrições abertas, oito atletas, três classes por etapa
(Open absoluta, Novice e Master), um Overall homologado, um empate sem
desempate e uma atleta que **trocou de filiação entre etapas**.

Nenhum CPF real, nenhum telefone real, nenhum dado pessoal real.

## Usuário operador

`demo.diretora.mu3jeol6@mci.local` — **direção de evento + gerência de
ranking**, que é o mínimo que `ranking.manage` exige. **Não é SUPER_ADMIN.**

A conta administrativa usada só para semear recebeu senha aleatória que **não
foi impressa em lugar nenhum**: depois da semeadura ninguém consegue usá-la.

## Usuário atleta

`demo.atleta.mu3jeol6@mci.local` — sem nenhuma permissão administrativa.
Vinculada à atleta que trocou de filiação, para que Meu Histórico tenha o que
mostrar.

## Fluxo testado

A verificação (`scripts/qa/preview-verificacao.mjs`) roda **contra a URL
pública**, com navegador de verdade. Resultado da execução: **APROVADO**.

| Teste | O que foi conferido |
|---|---|
| 1 | login do operador e dashboard com conteúdo |
| 2 | tela de Overall abre **sem escolher campeonato sozinha** |
| 3 | o seletor lista os campeonatos |
| 4 | candidatos com a colocação como fato, **nenhum destacado como campeão** |
| 5 | a prévia abre antes de qualquer escrita, e **colocação + 10 = total** na tela |
| 6 | confirmação explícita e estado **HOMOLOGADO** |
| 7 | o ranking administrativo mostra o Overall |
| 8 | login do atleta |
| 9 | Minha Filiação mostra a filiação **atual** e a matrícula |
| 10 | Meu Histórico mostra a filiação e a matrícula **da época**, por linha, e a coluna de Overall; o atleta não vê o menu de administração |
| 11 | ranking público — ver a ressalva abaixo |

## Segurança

Seis tentativas de acesso indevido, todas recusadas:

| Tentativa | Resposta |
|---|---|
| atleta lendo a auditoria | 404 |
| atleta listando usuários | 404 |
| atleta homologando Overall | 403 |
| atleta abrindo candidatos pela API | 403 |
| atleta lendo o histórico de outro atleta | 404 |
| atleta pedindo o cadastro (e o CPF) de outro atleta | 404 |
| atleta criando organização | 403 |
| atleta criando temporada | 403 |
| token adulterado | 401 |

O ranking público não traz CPF, telefone nem e-mail.

## QA visual

Sete larguras — 320, 375, 390, 768, 1024, 1280 e 1440 — em cinco telas
(Início, Ranking, Campeonatos, Minha Filiação, Meu Histórico):

- sem overflow horizontal do documento;
- nenhuma tela branca;
- nenhum erro de página e nenhuma resposta 5xx em todo o percurso.

## NOT TESTED

- **Ranking público pelo navegador, sem login.** Ver a ressalva.
- **Upload sob carga no preview.** O disco do runner é efêmero e o arreio de
  carga não roda aqui; ele roda em `npm run qa:carga:importador`.
- **Comportamento com muitos usuários simultâneos.** O túnel é um caminho só,
  e medir vazão através dele mediria o túnel, não a aplicação.

## Riscos e ressalvas

**1. O ranking público não é alcançável pela interface sem login.**
`App.jsx` devolve a tela de entrada quando não há sessão, **antes** de olhar a
rota; a marca `publico: true` da navegação só decide o que aparece no menu de
quem já entrou. O ranking público **existe e responde sem autenticação** — é a
API, e ela foi medida: TOP 5, sem CPF, sem telefone, sem e-mail. O que não
existe é o caminho do visitante até ele pelo navegador. Abrir esse caminho é
implementar funcionalidade, e esta fase é de publicação — fica para decisão.

**2. O ambiente é público, e as credenciais também.**
O repositório é público, e log de Actions de repositório público é público.
Qualquer pessoa com o endereço pode entrar. Por isso: dados fictícios, contas
de menor privilégio, e **nada de dado real deve ser inserido**.

**3. Não há HTTPS próprio nem domínio estável.**
O certificado é da Cloudflare, o endereço é sorteado a cada execução e o
ambiente vive 330 minutos. É ambiente de conferência, não de operação.

**4. A janela acaba.**
Quando o job terminar, o banco, os uploads e o endereço desaparecem. Para
levantar de novo, basta um push que toque `.github/preview.trigger`.

**5. FASES 5–6 seguem BLOQUEADAS.** O CSV do Ipiranga não existe neste
ambiente e nada foi fabricado.

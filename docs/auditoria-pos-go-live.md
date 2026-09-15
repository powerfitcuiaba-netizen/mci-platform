# MCI PLATFORM
# AUDITORIA PÓS-GO-LIVE

**Release auditada:** `fc4621d6db0f6be6700acd6b3752ab05aaa4d405`
**Data:** 2026-09-15 · **Documento NÃO commitado** (a fase proíbe alterar a `main`)

---

## AVISO QUE MUDA A LEITURA DE TUDO ABAIXO

Esta auditoria **não teve produção como alvo**.

Os endereços de produção são inalcançáveis deste ambiente. Medido três vezes,
em dois contêineres diferentes:

```
api.github.com                          → 200   (controle)
registry.npmjs.org                      → 200   (controle)
mci-platform-api.onrender.com/health    → 000
mci-platform-web.onrender.com           → 000
api.render.com / dashboard.render.com   → 000
onrender.com / render.com               → 000

CONNECT tunnel failed, response 403
```

Todo domínio do Render está fora da allowlist do proxy. O bloqueio é por host
e é política de infraestrutura, não instabilidade.

**O que foi auditado, então:** o **CÓDIGO** da release `fc4621d` — idêntico,
byte a byte, ao que está publicado — executando em **modo produção**
(`NODE_ENV=production`, rate limit ligado, máscara de erro ativa, RLS FORCE
ativo) contra PostgreSQL 16 real, com duas federações completas montadas para
provar isolamento.

**Consequência honesta:** um defeito encontrado aqui **é** um defeito em
produção, porque é o mesmo código. Mas nada aqui prova o comportamento da
**instância** de produção: configuração real do Render, valores reais de
`CORS_ORIGINS`, cabeçalhos do proxy do Render, TLS, credenciais do R2, e os
dados reais dos 47 campeonatos permanecem **NOT TESTED**.

---

## 1. Release

| | |
|---|---|
| SHA auditado | `fc4621d` |
| `origin/main` | `fc4621d` |
| árvore local | limpa, 0 commits não publicados |
| CI em `fc4621d` | 3 check-runs, todos `success` |

## 2. Produção

| item | resultado |
|---|---|
| alcance da API de produção | **NOT TESTED** — 403 no CONNECT |
| alcance do Web de produção | **NOT TESTED** — 403 no CONNECT |
| SHA rodando em produção | **NOT TESTED** — sem acesso ao Render; GitHub registra 0 deployments |
| `/health` e `/ready` reais | **NOT TESTED** |

## 3. Baseline do alvo auditado

```
/health → {"status":"ok","env":"production","uptimeSeconds":12}
/ready  → {"ready":true,"checks":{"database":true,"storage":true,"rls":true},
           "databaseKind":"postgresql","storageDriver":"local"}
```

`storageDriver: local` porque **este** ambiente não tem R2. Em produção o
esperado é `s3` — e é o item que o operador precisa confirmar.

Bundle da release: **505,23 kB** (135,64 kB gzip) · CSS 57,02 kB (11,36 kB).

## 4. Segurança — resumo

**63 testes controlados · 62 PASS · 1 FAIL.**
Nenhum teste destrutivo. Nada de flood, DROP, TRUNCATE, DELETE em dado real,
nem declaração de Overall.

## 5. Teste de invasão controlado (A–K)

### A — Autenticação · 6/6 PASS
| ataque | resposta |
|---|---|
| sem token | 401 |
| token lixo | 401 |
| token malformado (`a.b.c`) | 401 |
| assinatura adulterada | 401 |
| **`alg: none` forjado com papel SUPER_ADMIN** | **401** |
| token válido com `exp` no passado | 401 |

### B — RBAC · 9/9 PASS
Usuário comum recusado em: auditoria (403), usuários (404), declarar Overall
(403), receber resultado (403), inscrições (403), check-ins (403),
credenciais (403). Operador de check-in recusado em Overall (403) e em
resultado (403).

### C/D — IDOR e cross-tenant · 11/11 PASS
Diretor da federação A contra recursos da B: inscrições 403, check-ins 403,
credenciais 403, atleta 404, inscrição 404, overall e resultados devolvem
lista vazia. **Escrita** cross-tenant: check-in em inscrição alheia 404,
Overall em evento alheio 403. IDs inexistentes, de outro tipo e vazios: 404.

### E — Mass assignment · 2/2 PASS
`PATCH /profile` com `role: SUPER_ADMIN`, `id` de outro usuário e
`organizationId` alheio → **o papel permaneceu `ATHLETE`**. Criar atleta em
organização alheia → 403.

### F — Validação de entrada · 13/13 PASS · **nenhum 500**
`limit` negativo/gigante/texto/duplicado, cursor de 9.000 caracteres, cursor
com byte nulo, enum inválido, busca de 5.000 caracteres, array onde é texto,
prototype pollution, objeto onde é texto, campo desconhecido, JSON quebrado →
todos 400 (ou 200 legítimo). Método TRACE recusado.

### G — Path traversal · 4/4 PASS
`../`, `%2e%2e`, caminho absoluto e chave inventada → 404. Nenhum arquivo do
sistema lido.

### H — Storage e dados sensíveis · 3/3 PASS
Nenhum CPF completo, nenhum `photoKey`/`storageKey` em superfície pública.
Atleta consultado por usuário comum → 404, sem CPF.

### I — CORS · 4/4 PASS
Origem configurada liberada; `localhost:9999`, origem maliciosa e `null`
recusadas **sem cabeçalho** — sem curinga `*`, sem eco da origem.

### J — Cabeçalhos · 8/9 PASS
| cabeçalho | valor |
|---|---|
| Content-Security-Policy | `default-src 'self'; base-uri 'self'; …` |
| Strict-Transport-Security | `max-age=31536000; includeSubDomains` |
| X-Content-Type-Options | `nosniff` |
| Referrer-Policy | `no-referrer` |
| X-Frame-Options | `SAMEORIGIN` |
| Cross-Origin-Opener-Policy | `same-origin` |
| Cross-Origin-Resource-Policy | `same-origin` |
| X-Powered-By | **ausente** (correto) |
| **Permissions-Policy** | **AUSENTE** → BUG-03 |

### K — Rate limit · PASS com ressalva operacional
Medido: a **11ª** requisição do mesmo IP é recusada com 429 e espera de
**15 minutos**. Balde de **10 requisições / 15 min por IP**, compartilhado por
`/auth/register`, `/auth/login` **e** `/profile/password`. Ver BUG-02.

## 6. RBAC
GO. Ver §5-B.

## 7. RLS
GO. Verificado por efeito, não por leitura de SQL: inserir atleta sem ator é
recusado pela política; a tabela de CPF devolve **0 linhas sem contexto** e
60 com contexto. A auditoria só é legível pela rota, com ator — uma consulta
direta ao banco não a enxerga.

## 8. Cross-tenant
GO. Ver §5-C/D.

## 9. IDOR
GO. Ver §5-C/D.

## 10. Storage
**GO no código · NOT TESTED em produção.** Path traversal barrado, chaves não
expostas. O R2 real não foi tocado: credenciais, persistência após redeploy e
`storageDriver: s3` continuam por conferir no ambiente real.

## 11. CORS
GO no código. O valor real de `CORS_ORIGINS` em produção é **NOT TESTED**.

## 12. Headers
GO COM RESSALVAS — falta `Permissions-Policy` (BUG-03). Os cabeçalhos que o
proxy do Render acrescenta ou remove são **NOT TESTED**.

## 13. Rate limit
GO COM RESSALVAS — funciona, e é rígido demais para o dia de competição
(BUG-02).

## 14. Concorrência

| operação | disparos | respostas | estado final |
|---|---|---|---|
| **check-in, primeira vez** | 6 | `[201, 409, 500, 500, 500, 500]` | **1 linha** — íntegro |
| check-in após cancelar | 4 | `[201, 201, 201, 409]` | 1 linha — íntegro |
| credencial | 5 | `[201 ×5]` | 5 linhas, **5 códigos distintos** |
| cancelar + refazer juntos | 2 | `[200, 409]` | coerente |

**O dado nunca corrompeu.** O contrato HTTP, sim — ver BUG-01.
O corpo do 500 **não vaza**: `{"error":{"code":"INTERNAL_ERROR","message":"Erro interno do servidor"}}`.

## 15. Performance
Medida em FASE 2.5 sobre **este mesmo bundle**, pacote de produção:
100/200/500 inscritos → render 86–119 ms, 9/10/13 requisições, **0 duplicadas**,
DOM 1.498/2.596/5.896, heap 4,3/4,9/6,3 MB. A lista chega **inteira** nos três
volumes. Latência de produção real: **NOT TESTED**.

## 16. Estabilidade — 10 ciclos

| | volta 1 | volta 5 | volta 10 |
|---|---|---|---|
| nós DOM | 449 | 449 | **449** |
| ouvintes | 213 | 213 | **213** |
| heap após GC | 4,1 MB | 4,5 MB | 4,7 MB |
| intervalos órfãos | 0 | 0 | **0** |
| efeitos presos | 0 | 0 | **0** |
| áudio órfão | 0 | 0 | **0** |
| chamadas duplicadas | 0 | 0 | **0** |
| erros de página | 0 | 0 | **0** |

**Sem memory leak.** Nós e ouvintes idênticos após 10 voltas completas.

## 17. UX operacional
GO com ressalva. Loading, vazio, erro, retry, paginação, filtro, busca, modal
com Escape, foco e feedback não bloqueante foram exercitados nas FASES 2.1–2.5
sobre este código. **O que esta auditoria acrescenta:** BUG-01 faz o operador
ver "erro interno" ao tocar duas vezes no botão de check-in em condição de
corrida real — o pior lugar possível para uma mensagem dessas.

## 18. Mobile / responsividade — 10 larguras

320 · 360 · 390 · 430 · 768 · 1024 · 1280 · 1440 · 1920 · 2560

Todas: **rolagem horizontal 0**, tabela contida, nenhum botão abaixo de 24 px,
nenhum texto cortado, **0 erros de página**.

## 19. Acessibilidade
GO. `prefers-reduced-motion: reduce` medido: o ato continua valendo, a luz de
palco permanece estática, o Momento Campeão **não** sobe ao palco e o feedback
simples continua existindo. Contraste, foco e nomes acessíveis foram tratados
nas fases anteriores; **auditoria formal com leitor de tela: NOT TESTED**.

## 20. Compatibilidade entre navegadores

| motor | situação |
|---|---|
| Chromium 141.0.7390.37 | **PASS** |
| Firefox | **NOT TESTED** — binário ausente |
| WebKit / Safari | **NOT TESTED** — binário ausente |
| Safari iOS real | **NOT TESTED** |

`npx playwright install` é barrado: `403 request blocked: no rule or allowlist
entry allows host "cdn.playwright.dev"`. Procedimento para fechar em máquina
real: `docs/compatibilidade-navegadores.md`.

## 21. Campeonato ponta a ponta
Auditado sem alterar dado esportivo: evento → categoria → divisão → classe →
inscrição → check-in → pesagem → credencial. Cada etapa recebeu o dado da
anterior. **Nenhum Overall real foi declarado.** A plataforma continua
registrando declaração externa, não decidindo campeão — provado por 17 testes
negativos na FASE 2.4, incluindo as duas travas estruturais (só o
`rankingService` escreve em `EventOverallTitle`; só `adminResults.jsx` anuncia
o nível 5, e depois da resposta do servidor).

## 22. Auditoria
GO. Lida pela rota com ator: a ação de check-in gravou `action=CHECKIN`,
`entity=CheckIn`, ator nominal, organização e timestamp. **Não vaza CPF nem
chave de storage.**

## 23. LGPD — onde cada dado pessoal aparece

| superfície | CPF completo | CPF mascarado | telefone | WhatsApp | endereço | CEP | nascimento | chave storage |
|---|---|---|---|---|---|---|---|---|
| pública `/public/athletes` | — | — | — | — | — | — | — | — |
| pública `/public/events` | — | — | — | — | — | — | — | — |
| pública ranking | — | — | — | — | — | — | — | — |
| pública busca | — | — | — | — | — | — | — | — |
| usuário comum `/athletes` | — | — | — | — | — | — | — | — |
| usuário comum `/auth/me` | — | — | — | — | — | — | — | — |
| operador check-ins | — | — | — | — | — | — | — | — |
| **diretor** `/athletes` | — | **SIM** | — | — | — | — | **SIM** | — |
| **diretor** inscrições | — | **SIM** | — | — | — | — | **SIM** | — |

**CPF completo não apareceu em nenhuma superfície** — nem para o diretor, que
vê apenas a versão mascarada. Busca por CPF como usuário comum não devolve
atleta. Telefone, WhatsApp, endereço e CEP não vazaram em nenhuma resposta.

## 24. Bugs

### BUG-01 — check-in concorrente devolve 500 · **P1**
- **Tela/fluxo:** Check-in, portaria do evento.
- **Reprodução:** 6 `POST /registrations/:id/checkin` simultâneos, sem linha
  prévia. Determinístico.
- **Evidência:** `[201, 409, 500, 500, 500, 500]`.
- **Causa:** `operationsService.checkIn` faz *check-then-act* —
  `findUnique` → decide → `create`. Sob concorrência todos leem `null`, todos
  chamam `create`, e a violação de unicidade (`registrationId @unique`) vira
  Prisma **P2002**. O `errorHandler` **não mapeia P2002**, então sai 500.
- **Impacto:** o operador vê "erro interno" onde deveria ver "check-in já
  realizado". A trava de interface da FASE 2.4 cobre o duplo clique de UM
  operador; não cobre dois guichês lendo o mesmo atleta, nem retentativa de
  rede.
- **Risco:** operacional, não de segurança. **Dado permanece íntegro** (1 linha).
- **Correção proposta:** mapear P2002 → 409 no `errorHandler` (corrige a
  classe inteira de uma vez) e/ou trocar o check-then-act por `create` com
  captura de P2002. Menor alteração possível, sem tocar em regra esportiva.

### BUG-02 — rate limit de autenticação inviabiliza o dia de competição · **P1**
- **Reprodução:** 11 requisições a `/auth/login` do mesmo IP → 429 com espera
  de 832 s.
- **Causa:** `limiteAutenticacao` = 10 req / 15 min **por IP**, balde
  compartilhado entre `register`, `login` e `password`.
- **Impacto:** num ginásio, staff e atletas saem pelo **mesmo IP público**
  (NAT). Dez tentativas somadas — cinco autocadastros, ou dez logins —
  bloqueiam **todo mundo** por até 15 minutos, na abertura dos portões.
- **Risco:** o limite protege contra força bruta (bom) e derruba a operação
  legítima (ruim). É rigidez, não brecha.
- **Correção proposta:** manter o balde por CONTA ALVO (que é o que de fato
  segura força bruta, e já existe: `maxPorAlvo: 20`) e afrouxar o balde por
  IP para login bem-sucedido, ou permitir teto configurável por ambiente.
  **Decisão de produto, não minha** — envolve trocar proteção por
  disponibilidade.

### BUG-03 — `Permissions-Policy` ausente · **P3**
- **Evidência:** cabeçalho não presente em nenhuma resposta.
- **Impacto:** sem negar explicitamente câmera, microfone e geolocalização a
  iframes/subrecursos. Baixo: CSP, COOP e CORP já estão no lugar.
- **Correção proposta:** uma linha no Helmet.

### BUG-04 — check-in repetido após cancelamento devolve vários 201 · **P2**
- **Evidência:** `[201, 201, 201, 409]` quando existe linha CANCELLED.
- **Causa:** mesma raiz do BUG-01 — o ramo `update` não viola unicidade, então
  todas as chamadas "têm sucesso".
- **Impacto:** vários clientes acreditam ter criado o check-in; a interface
  pode anunciar o momento mais de uma vez. Dado íntegro (1 linha).

**Nenhum P0.**

## 25. Correções
**Nenhuma aplicada.** A fase manda auditar antes de corrigir, e a release está
congelada. As correções propostas estão em §24 e aguardam autorização.

## 26. Regressão
Não executada nesta fase — nenhum código foi alterado. A regressão de
`fc4621d` está registrada: frontend 348, backend 1032 (10 pulados), lint
limpo, schema válido, build 505,23 kB, CI verde.

## 27. Débitos
1. Firefox / Safari / iOS — NOT TESTED (ambiente).
2. Verificação da **instância** de produção — NOT TESTED (egresso bloqueado).
3. `render.yaml` versionado não descreve a infraestrutura real (nomeia
   `mci-api`/`mci-web`; produção é `mci-platform-api`/`mci-platform-web`).
4. Auditoria formal de acessibilidade com leitor de tela.

## 28. Riscos
| risco | severidade |
|---|---|
| BUG-02 bloquear a portaria no dia do evento | **alto, operacional** |
| BUG-01 mostrar "erro interno" na operação | médio |
| Produção nunca verificada por terceiro independente | médio |
| Safari iOS não testado (abertura, tela cheia, safe-area) | médio |
| BUG-04 anunciar check-in mais de uma vez | baixo |
| BUG-03 | baixo |

## 29. Evidências
Todas as saídas brutas estão no diretório de trabalho da sessão:
cenário de duas federações, bateria A–K, concorrência, LGPD, estabilidade de
10 ciclos e varredura de 10 larguras. Nenhum número neste documento foi
estimado; onde não houve medição, está escrito **NOT TESTED**.

## 30. Classificação final

| área | classificação |
|---|---|
| SECURITY | **GO COM RESSALVAS** (BUG-03) |
| PERFORMANCE | **GO** (código) · produção NOT TESTED |
| STABILITY | **GO** — 10 ciclos sem vazamento |
| UX | **GO COM RESSALVAS** (BUG-01) |
| RESPONSIVENESS | **GO** — 10 larguras limpas |
| ACCESSIBILITY | **GO COM RESSALVAS** — leitor de tela NOT TESTED |
| BROWSER | **NOT TESTED** (Firefox, Safari, iOS) |
| OPERATION | **CORRIGIR** — BUG-01 e BUG-02 |
| DATABASE | **GO** (código) · banco de produção NOT TESTED |
| STORAGE | **GO** (código) · R2 real NOT TESTED |
| AUDIT | **GO** |
| PRIVACY | **GO** — CPF completo não aparece em lugar nenhum |

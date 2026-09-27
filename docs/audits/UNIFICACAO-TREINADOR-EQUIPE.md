# Unificação de Treinador e Equipe — o que mudou, o que NÃO mudou e o que foi medido

**Decisão atendida:** remover "Coach" e "Equipe" como opções independentes de
cadastro e oferecer uma única opção — **Treinador (Equipe)** — em cadastro,
entrada, seleção de perfil, formulários, menus, permissões e telas
administrativas, preservando os demais perfis.

**Branch:** `claude/mci-platform-muscle-contest-o6haz9`

---

## 1. O achado que definiu o desenho

Antes de mudar qualquer coisa, medi o que cada um dos dois perfis dava a quem o
escolhia. O resultado decidiu tudo o que vem depois:

| papel | permissões (medidas em `src/utils/permissions.js`) |
|---|---|
| `COACH` | `BASE_AUTENTICADO` (14) **+ 5 de treinador**: `registrations.read`, `coaches.read_own`, `teams.read_own`, `athletes.lookup_affiliation`, `teams.request_membership` |
| `TEAM` | `BASE_AUTENTICADO` (14) e **nada mais** — idêntico a `ATHLETE`, `GYM`, `BRAND`, `SPONSOR` e `MEDIA` |

`BASE_AUTENTICADO` são as leituras e ações de social que **toda** conta
autenticada tem (`events.read`, `ranking.read`, `social.write`, `messenger.use`
e outras onze).

**Consequência:** quem se cadastrava como "Equipe" recebia uma conta sem
`coaches.read_own` e sem `teams.read_own` — sem área de treinador, sem poder
vincular atleta, sem poder ver equipe. Uma das duas opções levava a lugar
nenhum, e a pessoa só descobria depois de criar a conta.

> Registro de honestidade: a primeira versão desta análise afirmava que `TEAM`
> tinha **zero** permissões. Estava errada, e foi o teste que pegou —
> `operacional()` sem argumento não é conjunto vazio, é `BASE_AUTENTICADO`. A
> afirmação errada já estava escrita em cinco comentários antes de a medição
> acontecer. Todos foram corrigidos, e o teste passou a derivar a linha de base de
> `ATHLETE` em vez de supô-la.

---

## 2. O que mudou

### 2.1 Servidor — a autoridade

| arquivo | mudança |
|---|---|
| `src/utils/roles.js` | `PAPEIS_DE_CADASTRO_ABERTO` passa de 7 para 6 perfis: `TEAM` sai. Novo `PAPEIS_LEGADOS = ['TEAM']` e `isLegacyRole`. `USER_ROLES` **mantém** `TEAM`. |
| `src/utils/permissions.js` | `TEAM` continua `operacional()` — nenhuma permissão nova. Comentário registra por que o conjunto é esse e por que não pode crescer. |
| `src/services/coachService.js` | `autocadastro` passa a exigir `coaches.read_own`. |

A recusa de `role: 'TEAM'` no cadastro aberto é **400 `VALIDATION_ERROR`**, vinda
de `z.enum(PAPEIS_DE_CADASTRO_ABERTO)` em `authRegister` e `cadastroCompleto` —
antes de o serviço existir. Recusa mais cedo é recusa melhor.

### 2.2 Um defeito real, encontrado durante a auditoria de acesso

`POST /coaches/self-register` exigia apenas sessão. Medido: uma conta `ATHLETE`
criava o próprio `Coach` com **201** e, na releitura, `GET /coaches/me`
respondia **403** — porque `meuCadastro` exige `coaches.read_own`. O painel do
treinador trata a falha como "ainda não há cadastro" (`catch(() => null)`) e
devolve o formulário. A pessoa cadastrava de novo, recebia **409
`COACH_ALREADY_EXISTS`**, e nunca via o próprio pedido. Ficava no banco um
cadastro que ninguém abre, esperando análise central de uma conta que não tem
área de treinador.

A correção é fail closed e **não amplia nada**: quem já podia se cadastrar
continua podendo; quem não tem a área deixa de criar registro que não pode ler.
A guarda é de **permissão**, e não de `role === 'COACH'` — o papel é um jeito de
ter a permissão, não a permissão.

### 2.3 Interface

| arquivo | mudança |
|---|---|
| `frontend/src/lib/formulario.js` | `PAPEIS_ABERTOS` passa a 6 perfis, espelhando o servidor. |
| `frontend/src/lib/idiomas/{ptBR,en,es}.js` | `papel.COACH` → **Treinador (Equipe)** / Coach (Team) / Entrenador (Equipo), com descrição que fala da equipe. `papel.TEAM` → "Equipe (perfil antigo)". `nav.treinador` e `nav.admin/treinadores` renomeados. |
| `frontend/src/lib/format.js` | `PAPEL.COACH` → "Treinador (Equipe)". `PAPEL.TEAM` → "Equipe (perfil antigo)", tom `alerta`. |
| `frontend/src/lib/permissoes.js` | comentário corrigido: o espelho só reflete o que a interface usa para decidir menu e botão. |
| `frontend/src/App.jsx` | rótulos de recuo do menu. |
| `frontend/src/pages/adminPlatform.jsx` | `PAPEIS` sem `TEAM` + `papeisParaConta`. |

**`papeisParaConta` existe por um defeito que a remoção criaria.** Sem ela,
abrir a conta de alguém com papel legado mostraria um `<select>` cujo `value`
não casa com nenhuma `<option>`: o campo aparece vazio e quem administra lê
"esta conta está sem papel" — que é falso. Com ela, a verdade aparece, a troca
do papel legado para o atual fica a um clique, e o caminho de volta não existe.

### 2.4 O que NÃO mudou, e por quê

| não mudou | motivo |
|---|---|
| `enum UserRole` no banco | Reescrever essas linhas é alterar conta real. `TEAM` fica. |
| `TEAM` em `USER_ROLES` | Sem ele, `adminUserUpdate` (`z.enum(USER_ROLES)`) recusaria **qualquer** corpo para uma conta `TEAM`: nem suspender, nem corrigir, nem tirá-la do papel legado. A conta ficaria administrativamente congelada. |
| Permissões de `TEAM` | Copiar as cinco de `COACH` concederia área de treinador a contas que nunca passaram pela aprovação central — **R-03**. |
| Contas, vínculos, históricos, resultados, pontuações | Nenhuma linha de dado foi alterada. Não há migration nesta entrega. |
| `TIPO_DE_PERFIL` (perfil social) e `TIPO_DE_FILIACAO` | Domínios diferentes: um perfil social de equipe e uma entidade de filiação do tipo equipe não são o papel de conta. |
| Fórmula de ranking, resultados históricos, regras esportivas | Fora do escopo e intocados. |

**Nenhuma migration foi criada nesta entrega.** A unificação é de oferta, e
oferta vive em código.

---

## 3. A decisão que NÃO é minha

Converter as contas `TEAM` existentes em `COACH` **ampliaria privilégio** de
contas reais (de 14 permissões para 19), sem aprovação central, sem motivo
registrado e sem trilha de quem decidiu. Isso é decisão da administração central
da MuscleContest, conta por conta.

Para ela ser tomada com número na mão, entreguei um diagnóstico **somente
leitura**:

```
node scripts/diagnostico-papel-legado-equipe.js
```

Ele imprime `banco consultado: <nome>`, o total de contas com papel legado, e
separa duas listas — porque os dois grupos têm caminhos administrativos
diferentes:

| grupo | caminho |
|---|---|
| **já tem** cadastro de treinador | a decisão cadastral já existe: a administração central troca o papel em `PATCH /admin/users/:id`, uma a uma, e a trilha registra quem decidiu |
| **não tem** cadastro | a pessoa pede o cadastro na própria área e a administração central analisa — o fluxo normal, sem atalho |

Códigos de saída: **0** nenhuma conta legada · **1** há decisão humana pendente
· **2** recusou (sem `DATABASE_URL` no ambiente). A saída 1 **não** impede
publicar a unificação; impede considerar essas contas como "já resolvidas".

---

## 4. O que foi medido

### 4.1 Suítes novas

| arquivo | testes | o que trava |
|---|---|---|
| `tests/unificacao-treinador-equipe.test.mjs` | 17 | a oferta tem 6 perfis sem duplicata; `TEAM` fora da oferta e dentro de `USER_ROLES`; `COACH` = base + exatamente as 5; `TEAM` = base e nada mais; autocadastro aceito para Treinador (Equipe) **e legível depois**; recusado (403, sem registro órfão) para `ATHLETE`, `GYM`, `BRAND`, `SPONSOR`, `MEDIA` e `TEAM`; 401 sem sessão; conta legada entra, mantém papel e segue sem área |
| `tests/diagnostico-papel-legado-equipe.test.mjs` | 7 | separa quem tem de quem não tem cadastro; não conta quem não é legado; não sugere conversão automática; diz o banco; recusa sem `DATABASE_URL`; não imprime e-mail nem credencial |

### 4.2 Suítes estendidas

| arquivo | acrescentado |
|---|---|
| `tests/cadastro-publico.test.mjs` | bloco "papel legado de equipe": `role=TEAM` recusado com 400 e sem conta meio-criada; conta `TEAM` existente **entra, mantém o papel e não é reescrita**; um administrador ainda consegue suspendê-la e tirá-la do papel legado |
| `frontend/src/pages/cadastroWizard.test.jsx` | bloco "seletor de perfil unificado": oferece "Treinador (Equipe)" e não oferece "Equipe"; nem pelo rótulo, nem pelo código; 6 opções sem duplicata; a descrição fala da equipe; o envio chega com `role: 'COACH'` |

### 4.3 Mutantes acrescentados ao gate

`scripts/qa/mutantes-treinadores.mjs` passou de 24 para **29** mutantes, e de 9
para **12** suítes de controle:

| id | o que desfaz |
|---|---|
| `TE-U1` | "Equipe" volta a ser opção independente no cadastro aberto |
| `TE-U2` | o papel legado ganha as cinco permissões de treinador — privilégio ampliado sem R-03 |
| `TE-U3` | o autocadastro volta a aceitar qualquer conta autenticada |
| `TE-U4` | o papel legado sai do enum e congela as contas que o têm |
| `TE-U5` | o diagnóstico deixa de separar quem tem cadastro de quem não tem |

`TE-U2` é o mais importante da bateria, porque é o refator que parece óbvio:
"já que unificamos, `TEAM` devia poder o que `COACH` pode".

---

## 5. Preservação de dados — o que posso afirmar

| afirmação | como foi verificada |
|---|---|
| Nenhuma conta apagada | Nenhuma migration nesta entrega; nenhum `DELETE` em código novo. |
| Nenhum papel reescrito | Teste: conta `TEAM` criada, lida no banco, `role` segue `TEAM` e `status` segue `ACTIVE`. |
| Nenhuma conta congelada | Teste: `PATCH /admin/users/:id` responde 200 para suspender e 200 para migrar o papel de uma conta `TEAM`. |
| Nenhum vínculo, histórico, resultado ou ponto tocado | Nenhum arquivo de `rankingService`, `resultService`, `membershipService` ou migration foi alterado. |
| Nenhum privilégio ampliado | Teste: `TEAM` = base de conta comum; a diferença de `COACH` são exatamente as cinco homologadas. |

---

## 6. Produção — o que continua bloqueado

Esta seção não é ressalva de estilo: é o que impede a etapa 5 do pedido de ser
concluída por mim.

1. **Backup com restauração verificada.** Exige acesso ao ambiente real e à
   verificação da restauração. Não executei.
2. **Diagnóstico 1** (`diagnostico-treinadores-legados.js`) e **diagnóstico 2**
   (`diagnostico-delegacoes-inertes.js`) em produção, mais o **diagnóstico 3**
   deste documento. Procedimento em
   `docs/audits/PROCEDIMENTO-DIAGNOSTICOS-PRODUCAO.md`.
3. **A migration `20260927030000`** ainda está pendente no ambiente real e
   devolve a `PENDING` os cadastros de treinador aprovados sem revisor. É
   mudança com efeito operacional imediato: quem depende de um desses cadastros
   para de atuar até a aprovação formal. O diagnóstico 1 existe para quantificar
   isso **antes** do deploy — e o `preDeployCommand` do Render aplica migrations
   automaticamente.
4. **Decisões D-1 a D-4** registradas no relatório final de prontidão.

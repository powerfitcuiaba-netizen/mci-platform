# RELATÓRIO — CORREÇÃO DA AUDITORIA DE AUTENTICAÇÃO

Tarefa: auditar e corrigir a perda de eventos de auditoria de autenticação,
sem enfraquecer RLS e sem expor dado sensível.

O desenho da solução, com as alternativas rejeitadas e os riscos de cada uma,
está em `docs/audits/DESENHO-AUDITORIA-DE-AUTENTICACAO.md`. Este relatório diz o
que foi medido, o que foi mudado e o que sobrou.

## 1. CAUSA-RAIZ COMPROVADA

Instrumento: `scripts/qa/diagnostico-auditoria-autenticacao.mjs` (alias
`npm run qa:diagnostico:auditoria`), em banco isolado com dados sintéticos.

**A cadeia, elo por elo:**

1. `src/utils/asyncHandler.js:63` só abre transação com contexto quando existe
   `req.user`. Em `/auth/login` e `/auth/register` não existe — por construção,
   porque é dentro deles que a identidade está sendo estabelecida.
2. Sem transação, o proxy de `src/config/prisma.js` roteia para o cliente base,
   onde `mci.user_id` nunca foi definido.
3. `mci_current_user_id()` é `NULLIF(current_setting('mci.user_id', true), '')`
   (migration `20260906130000_rls`) — devolve **NULL**.
4. A política `auditoria_escrita`
   (migration `20260921000000_vinculo_privado_e_auditoria_inforjavel:106`) exige
   `"userId" IS NOT DISTINCT FROM mci_current_user_id()`. A linha carrega o id de
   quem acabou de entrar; a sessão carrega NULL. Reprova, e o `INSERT` volta
   **42501**.
5. `src/services/auditService.js::record` trata a recusa e **a autenticação
   segue**. Só o log sabia.

**Medição, antes da correção:**

| id | verificação | resultado |
| --- | --- | --- |
| H1 | `POST /auth/register` responde 201 | SIM |
| H2 | o cadastro deixou `USER_REGISTER` na trilha | **NÃO — PERDIDO** (linhas=0) |
| H3 | `POST /auth/login` responde 200 | SIM |
| H4 | a entrada deixou `LOGIN` na trilha | **NÃO — PERDIDO** (linhas=0) |
| H5 | houve recusa de auditoria no log | SIM — 4 ocorrências |
| H6 | a perda seria visível para quem chama a API | **NÃO** |
| H7 | CONTROLE: ação autenticada audita normalmente | SIM (0 → 1) |
| P1 | `INSERT` com `userId` e **sem** contexto | **RECUSADO** |
| P2 | o **mesmo** `INSERT` **com** o contexto do ator | **ACEITO** |

H7 é a linha que separa duas explicações possíveis: a auditoria não está
quebrada, o **caminho de autenticação** está. P1 com P2 fecham a causa: a mesma
política que recusa sem contexto aceita com ele.

### O que este defeito NÃO era

- não era política errada — as três garantias dela foram medidas de pé (§6);
- não era o `RETURNING` do `create` do Prisma batendo na política de leitura —
  `record` já usa `createMany` exatamente por isso;
- não era papel insuficiente nem organização sem vínculo — `organizationId` é
  nulo nos dois eventos, e a cláusula de organização aceita nulo.

### Inventário dos caminhos pré-autenticação

Por enumeração das rotas, não por amostragem: das rotas servidas, **oito**
dispensam autenticação — `POST /auth/register`, `POST /auth/login` e seis
`GET /public/*`. As públicas **não escrevem auditoria** (`publicService` não a
importa). Visitante em rota `optionalAuth` grava com `userId` nulo, que a política
aceita. Scripts de linha de comando já usam `withUserContext`.

Conjunto afetado: **`LOGIN` e `USER_REGISTER`, e nada mais** — o que fecha com o
achado do QA visual (11 + 6 = 17 recusas numa execução).

## 2. ARQUIVOS E POLÍTICAS ENVOLVIDOS

| arquivo | papel |
| --- | --- |
| `prisma/migrations/20260921000000_.../migration.sql:106` | define `auditoria_escrita` — a política que recusa. **Não alterada** |
| `prisma/migrations/20260906130000_rls/migration.sql:22` | `mci_current_user_id()`. **Não alterada** |
| `prisma/migrations/20260906180000_force_rls/migration.sql` | `FORCE ROW LEVEL SECURITY`. **Não alterada** |
| `prisma/migrations/20260926040000_.../migration.sql:336` | a única alteração anterior de `auditoria_escrita`: **acrescentou** um `OR` à disjunção, e por isso não pode ter causado a perda |
| `src/utils/asyncHandler.js` | onde o contexto é (e não é) aberto. **Não alterado** |
| `src/services/auditService.js` | `record`, e agora `registrarComContextoDoAtor` e o contador. **Alterado** |
| `src/services/authService.js` | `login` e `register`. **Alterado** |
| `src/controllers/index.js`, `src/routes/index.js` | rota de integridade da trilha. **Alterados** |

## 3. A SOLUÇÃO, E POR QUE ESTA

> **Dar ao registro do evento o contexto de RLS do ator que a própria
> autenticação acabou de estabelecer.**

Depois de conferir a senha — ou de criar o usuário —, o servidor sabe quem é o
ator. A escrita passa a acontecer dentro de `withUserContext(actor.id, …)`, o
mesmo mecanismo de toda requisição autenticada. A política encontra
`userId = mci_current_user_id()` e aceita. **Nenhuma linha de RLS mudou.**

Ponto único: `auditService.registrarComContextoDoAtor`. Um lugar só porque a
próxima pessoa a adicionar um evento pré-autenticação (recuperação de senha,
segundo fator) vai precisar da mesma coisa, e a explicação tem de estar onde ela
vai olhar.

Três propriedades que sustentam a escolha:

- **o ator vem do servidor.** `actor.id` é o registro lido do banco depois de
  conferir a credencial, ou a linha recém-criada. Nunca do corpo, da query ou de
  cabeçalho;
- **a política continua sendo a autoridade.** Nada foi afrouxado para isto
  funcionar — e o §6 mede isso, em vez de afirmar;
- **sem credencial válida não há ator**, e sem ator a função não inventa um: cai
  para `record`, que a política recusa. Que é o comportamento certo para
  visitante.

As alternativas rejeitadas — política permissiva, `SECURITY DEFINER`, `userId`
nulo com identidade em metadado, tabela separada, contexto antes da credencial,
recusar o login quando a auditoria falha e auditar tentativa falhada — estão no
documento de desenho, cada uma com o risco que a reprovou.

### Detecção: a falha não pode voltar a ser silenciosa

O defeito passou meses sem ser notado porque **só o log sabia dele**, e log só é
lido por quem já desconfia. Foi um gate de QA visual olhando o log por outro
motivo que o encontrou — por acaso. Três camadas agora:

1. **contador no processo** (`auditService`): quantas gravações falharam e um
   resumo da última — ação, entidade, código e instante. **Sem `metadata`, sem
   e-mail, sem IP, sem id de pessoa**;
2. **superfície de leitura**: `GET /audit/integrity`, com `requireAuth` e a
   permissão `audit.read` que já existia. Nenhuma permissão nova foi criada;
3. **teste que reprova**: cadastrar e entrar não podem acrescentar falha, e o
   teste mede o delta **pela rota** — ver a armadilha na §5.

## 4. MIGRATIONS E ALTERAÇÕES

**Nenhuma migration foi criada.** `prisma/` está intocado, e isso é verificável
por `git status prisma/`. A correção é de caminho de execução, não de esquema nem
de política — e este é o resultado mais importante do relatório, porque a
alternativa fácil era afrouxar a política.

| arquivo | mudança |
| --- | --- |
| `src/services/auditService.js` | `registrarComContextoDoAtor`; contador de falhas com resumo sem dado sensível; `estadoDaTrilha`; `integridade` (guardada por `audit.read`); `USER_REGISTER` entrou no catálogo `ACTIONS` |
| `src/services/authService.js` | `login` e `register` passam a usar o ponto único, com o porquê escrito no lugar |
| `src/controllers/index.js` | `audit.integrity` |
| `src/routes/index.js` | `GET /audit/integrity`, autenticada e permissionada |
| `tests/auditoria-de-autenticacao.test.mjs` | 17 testes (§5) |
| `scripts/qa/diagnostico-auditoria-autenticacao.mjs` | o instrumento, versionado — lê certo com e sem o defeito |
| `docs/audits/DESENHO-AUDITORIA-DE-AUTENTICACAO.md` | o desenho e as alternativas rejeitadas |
| `package.json` | alias `qa:diagnostico:auditoria` |

Nada foi apagado da trilha. Nenhum registro de atleta, resultado, ranking ou
vínculo esportivo foi tocado. Nenhum dado real, nenhuma credencial de produção.

## 5. TESTES EXECUTADOS, COM RESULTADO REAL

`tests/auditoria-de-autenticacao.test.mjs` — **17 testes, 17 passaram**.

| exigência da tarefa | teste |
| --- | --- |
| LOGIN válido gera evento | "a entrada deixa LOGIN, e uma segunda entrada deixa um SEGUNDO evento" |
| USER_REGISTER válido gera evento | "o cadastro deixa USER_REGISTER com o ator, o e-mail e a entidade certos" |
| anônimo não grava evento arbitrário | "visitante anônimo não grava evento nenhum" |
| não forja identidade | "ninguém assina no lugar de outro usuário" |
| não forja organização | "ator comum não escreve na trilha de federação de que não participa" |
| falha é detectável | "a recusa é contada, e o resumo diz a ação sem expor dado sensível" + "cadastrar e entrar não acrescentam NENHUMA falha" |
| falha não expõe segredo | mesmo teste: o resumo é conferido chave por chave, e `password`/`token` são procurados e não encontrados |
| RLS bloqueia leitura e escrita indevidas | "quem não pode ler a trilha continua não lendo — pela rota e pelo banco"; "a trilha não se adultera nem se apaga — nem por administrador de plataforma" |
| auditoria e permissões existentes seguem funcionando | "ação autenticada de administração segue deixando trilha com o ator certo"; "a superfície HTTP da auditoria não ganhou rota sem autenticação" |
| migration aplica em banco limpo | o diagnóstico **cria** o banco, roda `prisma migrate deploy` e semeia a cada execução; `npm test` faz o mesmo no banco de teste. E o texto das políticas vivas é conferido: "o TEXTO das políticas vivas continua exigindo ator e vínculo" |
| autenticação permanece compatível | "o cadastro devolve token e usuário, e o e-mail repetido continua 409"; "a entrada devolve token utilizável na rota autenticada" |
| a operação não é derrubada pela falha | "a operação principal NÃO é derrubada pela falha de auditoria" (o SAVEPOINT) |
| credencial inválida não gera evento | "credencial inválida não deixa evento de entrada" |

### Os testes matam o defeito — verificado por mutação

Teste que passa sem o defeito não prova nada; o que prova é reprovar **com** ele.

| mutante | testes que reprovaram |
| --- | --- |
| `registrarComContextoDoAtor` → `record` em `login` e `register` (o defeito original, reposto) | **3**: USER_REGISTER, LOGIN, e o delta de falhas pela rota |
| `falhas += 1` → `falhas += 0` (contador cego) | **2**: a recusa contada e a operação não derrubada |

Os dois mutantes foram revertidos e a árvore conferida limpa depois.

### A ARMADILHA QUE QUASE ENTROU NA SUÍTE, e vale registrar

A primeira versão do teste afirmava `audit.estadoDaTrilha().falhas === 0` depois
de um cadastro por HTTP. **Isso passava com o defeito e sem ele.** Medido com
sonda: a instância de módulo que o arquivo de teste importa NÃO é a que
`src/app.js` carrega — depois do mesmo cadastro, a importada marcava `falhas: 0` e
a do app marcava `falhas: 3`.

Era um teste cego, do tipo que tranquiliza sem medir. A correção: o que acontece
dentro do processo de teste é medido na instância importada; o que acontece pelo
HTTP é medido **pela rota** `GET /audit/integrity`, que necessariamente lê o
contador do app. A explicação ficou escrita no arquivo de teste.

### Regressão, lint e diagnóstico

| gate | resultado |
| --- | --- |
| Suíte de backend completa (`npm test`) | **130 arquivos, 2155 testes passaram, 0 falharam, 15 ignorados condicionalmente** (`EXIT=0`) |
| Arquivo novo isolado | 17 testes, 0 falhas |
| Crescimento da suíte | de 128 arquivos / 2138 testes para 130 / 2155 — o arquivo novo e os 17 testes dele. Nenhum teste foi removido, desativado ou marcado como pendente |
| ESLint | limpo |
| Diagnóstico depois da correção | H2 e H4 **SIM** (1 linha cada), H5 **NENHUMA** recusa no log, veredito "CORRIGIDO E SEM AFROUXAMENTO", `EXIT=0` |

## 6. EVIDÊNCIAS DE QUE O RLS NÃO FOI ENFRAQUECIDO

Quatro provas independentes, todas verificáveis por quem revisar:

1. **`prisma/` está intocado.** Nenhuma migration nova, nenhum `CREATE POLICY`,
   nenhum `ALTER TABLE`. `git status prisma/` não retorna nada.
2. **As políticas vivas foram medidas depois da correção** (diagnóstico §2 e §3):

   | sonda | resultado |
   | --- | --- |
   | P1 — `INSERT` sem contexto | **RECUSADO** |
   | P3 — assinar no lugar de outro | **RECUSADO** |
   | P5 — escrever na trilha de federação alheia | **RECUSADO** |
   | P7 — ator comum adultera ou apaga | **IMPOSSÍVEL** |
   | P8 — administrador de plataforma adultera ou apaga | **IMPOSSÍVEL** |
   | R1 — `AuditLog` com RLS ligado e **forçado** | **SIM** (`true/true`) |

3. **O texto das políticas é afirmado por teste.** O caso "o TEXTO das políticas
   vivas continua exigindo ator e vínculo" confere que existem exatamente duas
   políticas (`auditoria_escrita` INSERT, `auditoria_leitura` SELECT) — nenhuma de
   UPDATE ou DELETE —, que a cláusula `userId`/`mci_current_user_id()` continua
   na de escrita, que a de leitura continua exigindo administrador de plataforma
   ou operador, e que `relforcerowsecurity` segue verdadeiro. Um afrouxamento
   futuro feito "para o teste passar" reprova aqui.
4. **Nenhuma função privilegiada foi criada.** Sem `SECURITY DEFINER`, sem
   `BYPASSRLS`, sem `USING (true)`, sem política global para anônimo.

## 7. RISCOS RESIDUAIS

1. **Os eventos já perdidos não voltam.** Eles não existem, e fabricá-los seria
   falsificar a trilha. O que existe é o marco temporal: a partir desta correção,
   entrada e cadastro deixam rastro.
2. **A trilha de autenticação não distingue tentativa falhada.** Credencial
   inválida continua sem registro (confirmado por teste). Ver R7 no documento de
   desenho: é decisão com dois lados — gravar o e-mail tentado é gravar dado de
   quem talvez não seja usuário, e força bruta iria direto para a trilha. Exige
   regra de retenção e limite.
3. **A auditoria continua não derrubando a operação.** Se a gravação falhar, o
   login segue válido. Com a correção, o único cenário de falha que resta é
   indisponibilidade de banco — que já derruba a autenticação de todo modo. O
   modo "fail closed" está proposto como R6 e é decisão da administração, não de
   quem programa.
4. **O contador é do processo, não do banco.** Reinicia a cada partida e é por
   instância. É o que se quer saber ("esta instância está gravando auditoria?"),
   mas um painel com várias instâncias precisa somar as respostas de cada uma.
5. **Uma transação a mais por login e por cadastro.** Custo medido como
   irrelevante nos tempos da suíte, mas é uma conexão do pool retida por alguns
   milissegundos a mais em cada entrada. Vale saber antes de um pico.
6. **`GET /audit/integrity` é superfície nova.** Autenticada, permissionada por
   `audit.read`, somente leitura, sem parâmetro e sem dado sensível no corpo — e
   o teste de superfície confere que nenhuma rota de auditoria responde sem
   token. Ainda assim, é uma rota que antes não existia.

## 8. RAMO E COMMITS LOCAIS

- Ramo: `claude/mci-platform-muscle-contest-o6haz9`
- Commits locais anteriores, preservados: `8906cff`, `8536d29` (módulo
  Treinadores & Equipes), `95979aa`, `df66f83` (QA visual)
- Commit desta correção: **`9256c86`**

**Nada foi publicado.** Sem `push`, sem PR, sem merge, sem release, sem deploy.
Nenhuma migration aplicada em produção — nem existe migration nesta correção.
Nenhum dado real alterado: todo o trabalho rodou em bancos locais criados e
destruídos pelos próprios instrumentos.

## 9. VEREDITO

**PASS** para a correção, com as ressalvas da §7 registradas.

A perda de trilha de autenticação existia, foi medida, a causa foi provada, e a
correção foi feita **sem tocar em uma linha de RLS**. As garantias da política
continuam medidas de pé, a falha deixou de ser silenciosa, e os testes reprovam
quando o defeito é reposto.

O que depende de decisão da administração, e não de programação: auditar
tentativa de login falhada (§7.2) e adotar ou não o modo "fail closed" (§7.3).

Aguardando decisão para publicar.

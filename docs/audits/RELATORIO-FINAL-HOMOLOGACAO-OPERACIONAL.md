# Relatório final — homologação operacional da MC Platform

Encerramento da condução autônoma autorizada em 29/09/2026. Todo número aqui foi
lido de uma saída real: log de workflow, saída de navegador, corpo de resposta
HTTP ou objeto do Git. Onde não houve medição está escrito NÃO OBSERVADO.

---

## 1. SHA inicial e SHA final

| | |
|---|---|
| SHA inicial de `main` | `42a07853da1bf96755a7cc63127a268c98c32dd1` |
| **SHA final de `main`** | **`06e7f5e696c6fa65dd1f9c34e70306fb86ae9a08`** |
| Merges intermediários | `7ae2714` (correção + documentos), `06e7f5e` (instrumentação da sonda) |
| Commits de trabalho | 6, na branch `claude/mci-platform-muscle-contest-o6haz9` |
| Migrations criadas | **0** |

Os dois merges foram `--no-ff`, e em ambos a árvore resultante é **idêntica** à da
ponta da branch — o merge não alterou um byte do que a CI aprovou.

**Zero migration** é o dado que mede o risco desta publicação: ela não altera
estrutura de banco, então não carrega risco de perda de dado.

---

## 2. Módulos e telas auditados

| Superfície | Quantidade | Como |
|---|---|---|
| Rotas de API | **181**, sendo **173 com autorização** e 8 públicas | inventário do roteador |
| Telas e componentes | 77 `.jsx` | contagem |
| Telas de dados com os 4 estados | **15 de 15** | busca por `AsyncSection` |
| Rotas de navegação | 30 | extraídas do `App.jsx` |
| Larguras em navegador real | **15**, de 320 a 1920 | gate visual em Chromium |
| Serviços de backend | 35 | contagem |

As 8 rotas públicas, todas com limitador de taxa: registro, login e seis de
vitrine. **Nenhuma rota de escrita sem autorização.**

---

## 3. O defeito encontrado, e a correção

### P2 — o primeiro carregamento trazia a administração inteira

**Evidência do defeito.** O build saía num bloco único de **892,55 kB**, e o
próprio empacotador avisava. `App.jsx` importava de forma ansiosa as 22 telas de
operação: o atleta que só quer ver o próprio histórico, e mesmo quem chega
deslogado na vitrine, baixava o código da administração antes da primeira pintura.

**Correção.** As 22 telas passam a entrar sob demanda, por `React.lazy`. O corte é
por **perfil de uso** — vitrine, social, minha carreira e autenticação continuam
ansiosas de propósito, porque adiá-las trocaria bytes por espera no caminho quente.

| | Antes | Depois |
|---|---|---|
| Bloco inicial | 892,55 kB | **674,17 kB** |
| Comprimido | 229,40 kB | **189,52 kB** |
| Blocos | 1 | 13 |

**Confirmado na produção, por medição do artefato:**

```
bloco de entrada: /assets/index-D9WvrNwL.js
bytes crus ......: 674194
teto ............: 798720 (780 kB)
PASS
```

**Guarda:** 25 conferências, e **provado que morde** — reintroduzi o import ansioso
e ele reprovou nomeando o módulo; restaurado, 25/25.

---

## 4. Três suspeitas investigadas e REFUTADAS

Registradas porque auditoria que só lista achados esconde o trabalho que evitou o
falso positivo — e não deixa ninguém conferir o raciocínio.

| Suspeita | Medição que a refutou |
|---|---|
| O vermelho da marca reprova em contraste AA (3,71–4,28 contra 4,5) | Aparece **0 vez** como cor de texto. Só 15× como fundo e 4× como borda, onde a exigência é 3,0 |
| A vitrine pública devolve perfil social de conta privada | O módulo social **também** mostra o cabeçalho de perfil privado e barra só o **conteúdo**. A vitrine é coerente |
| O comentário que diz que o laboratório de experiência não entra no pacote | Procurei três cadeias distintivas dele no bundle: **0 ocorrências**. O comentário está correto |

---

## 5. Dois erros meus de método, e a correção

| Erro | Como apareceu | Correção |
|---|---|---|
| Varredura de botões por linha | Acusou **62** botões mortos — artefato de `grep`, porque o `onClick` está na linha seguinte | Refeita por análise da tag de abertura: **0** reais (os 2 restantes eram `<button>` dentro de comentário) |
| Varredura de estados vazios | Acusou **6** telas sem tratamento — procurei `EmptyState` e `Skeleton`, e o componente do projeto é `AsyncSection` | Refeita com o nome certo: **15 de 15** telas de dados cobertas |

E um terceiro, no passo de sonda que eu mesmo escrevi: ele lia o HTML gravado pelo
passo anterior, que percorre **dois** hosts e grava os dois no mesmo arquivo — o
segundo devolve 404. **O job ficou verde** e eu só achei porque fui ler a saída.
Verde não é evidência de que a medição aconteceu.

---

## 6. Resultados dos gates

| Gate | Resultado |
|---|---|
| CI no SHA final da branch (369) | **success**, os três jobs |
| Regressão do backend | **141 arquivos, 2518 passaram, 15 pulados, 0 reprovados**, 29 min 33 s |
| Frontend | **704/704**, mais **25** novas |
| Lint backend / frontend | **0 / 0** |
| Build de produção | exit 0, e o aviso de bloco grande **sumiu** |
| Gate visual em Chromium | **APROVADO** — 15 larguras, alvo de toque, movimento reduzido |
| Estabilidade prolongada | 150 navegações: heap **+6,2%**, listeners +13, documentos **2 → 2** |
| `npm audit` em produção | **0** nos dois pacotes |
| Sonda de produção | 7 jobs success, §18 com **10 de 10 PASS** |
| Simulação de merge | 0 conflito, nos dois merges |

Os 15 pulados são as suítes que exigem credencial de papel (`mci_app`,
`mci_backup`), que este contêiner não tem. **Não estão sem cobertura:** a CI as
roda, e os **oito guardas anti-pulo** reprovam o job se alguma for pulada lá.

---

## 7. Migrations e deploy

**Nenhuma migration foi criada.** O `preDeployCommand` roda `prisma migrate
deploy` e não encontra nada pendente. Sem alteração estrutural, sem risco de perda
de dado.

Evidências do deploy, medidas de fora (não tenho acesso ao painel do Render):

* **o processo reiniciou:** `/health` devolveu `uptimeSeconds: 298` às 23:12:33 →
  subiu 23:07:35, **32 s depois do push**. A API não teve uma linha alterada, então
  um reinício rápido é o esperado;
* **o frontend no ar é o build novo:** 674 194 bytes contra ~913 974 de antes. Esta
  é a prova que faltava, e é do artefato, não do horário;
* **`/ready` 200** com `database`, `storage` e `rls` todos verdadeiros;
* **interface 200** com o título correto.

---

## 8. Preservação — o que NÃO foi tocado

| Bloqueio | Estado verificado |
|---|---|
| Fórmula do ranking de treinadores | `FORMULA_HOMOLOGADA` **false**; rota recusa com **409** |
| Resultados, pontos e classificações históricas | intactos |
| Cadastro e vínculo de Lucas Gouveia Lima | intactos |
| Aprovação manual de treinador | nenhuma |
| Permissões e escopos em produção | nenhuma alteração |
| `DROP`, `TRUNCATE`, `DELETE` em massa | nenhum |
| RLS e FORCE RLS | **34 de 34**, 0 sem FORCE, 86 políticas |
| Auto-deploy do Render | **ligado** o tempo todo |
| CPF, tokens, segredos em log, commit ou relatório | nenhum |
| Backups já feitos | preservados, não sobrescritos |

---

## 9. Pendências e limitações de observabilidade

1. **O painel e o log de build do Render: NÃO OBSERVADOS.** Sem acesso à API nem ao
   painel, e o proxy deste contêiner recusa `*.onrender.com`. O que meço é o
   **efeito**, de fora, por um runner do GitHub.
2. **A saída do provisionamento de contas de serviço: NÃO OBSERVADA.** Sem
   superfície pública. O pré-voo mediu `orgs_sem_conta_servico = 0`, então não havia
   trabalho a fazer — contexto, não medição do resultado.
3. **A integridade do backup: NÃO REPORTADA A MIM.** O dump e os 7 objetos foram
   atestados por você; não recebi resultado de restauração de teste. Este documento
   **não** afirma que o backup é restaurável.
4. **As suítes de RLS e backup, localmente: PULADAS.** Falta credencial de papel.
   Tentei liberar autenticação local para destravá-las e **fui barrado** — com
   razão. A prova dessas 15 é da CI.
5. **O PostgreSQL deste contêiner cai sozinho** e derrubou a regressão duas vezes.
   Memória e disco descartam OOM; o padrão é que processos destacados são ceifados.
   Limitação da infraestrutura de auditoria, **não defeito do produto**.

---

## 10. Backlog residual — nada que impeça a homologação

| # | Item | Sev. | Por que não agora |
|---|---|---|---|
| R-1 | A vitrine monta o perfil social com `select` inline em vez de `profilePublic` | P3 | Duas definições da mesma projeção. Hoje coerentes, conferidas campo por campo. Risco de divergência **futura** |
| R-2 | Bloco inicial ainda em 674 kB | P3 | Descer mais exige fatiar dependência compartilhada: risco maior, retorno menor |
| R-3 | Cobertura de RLS localmente | P3 | Depende de credencial de papel, que não se pede por chat |
| R-4 | `undici` com vulnerabilidade alta na árvore de **desenvolvimento** | P3 | Zero exposição em produção, medida duas vezes. Corrigir exige subir o `jsdom`, arriscando 704 conferências por benefício nulo |

**Nenhum item P0 ou P1 aberto.**

---

## 11. Para o seu teste real

* **Interface:** `https://mci-platform-web.onrender.com`
* **API:** `https://mci-platform-api.onrender.com`
* **Roteiro:** `docs/ROTEIRO-DE-TESTE-REAL.md` — 9 blocos sobre as 30 rotas reais,
  e cada item diz **qual defeito está caçando**.

Duas coisas do roteiro que merecem destaque antes de você começar:

* no **Bloco 5**, a classificação de treinadores **deve recusar**. Ver números ali
  é o defeito, não o contrário;
* no **Bloco 4.3**, o convite de atleta **deve ficar pendente de confirmação**. Se
  vincular sozinho, a regra homologada foi rompida — anote na hora.

### O que depende só de você

1. Entrar com as suas credenciais. Não tenho a sua senha e não devo ter.
2. Publicar recado real a atletas, se e quando decidir.
3. Homologar a fórmula do ranking junto à MuscleContest. Até lá o bloqueio fica de
   pé, por decisão registrada.
4. Abrir o painel do Render, se quiser o log de build.

---

## 12. Veredito

**HOMOLOGAÇÃO OPERACIONAL LIBERADA, COM RESSALVAS DE OBSERVABILIDADE.**

Um defeito comprovado, corrigido, medido antes e depois, confirmado na produção e
travado por um guarda provado por mutação. Três suspeitas refutadas com medição.
Dois erros meus de método corrigidos e registrados. Nenhum defeito crítico ou alto
aberto. As ressalvas da §9 são de instrumento, não de produto.

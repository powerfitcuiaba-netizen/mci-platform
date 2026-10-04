# PREVIEW ONLINE — MCI Platform

| | |
|---|---|
| **PREVIEW URL** | https://dts-quote-patio-integrity.trycloudflare.com |
| **API URL** | https://prerequisite-boutique-quad-belkin.trycloudflare.com |
| **BRANCH** | claude/mci-platform-muscle-contest-o6haz9 |
| **SHA** | 4dcd4c1a545afd9341e9d3dbc04e4009cc4aea26 |
| **AMBIENTE** | QA/PREVIEW |
| **VERIFICAÇÃO** | success |
| **Subiu em** | 2026-10-04 16:10 UTC |
| **Vive por** | 330 minutos |
| **Expira em** | 2026-10-04 21:40 UTC · 04/10 18:40 (Brasília) |
| **Verificação do cadastro** | success |
| **Execução** | https://github.com/powerfitcuiaba-netizen/mci-platform/actions/runs/37215427766 |

## TESTE DA CONSOLIDAÇÃO POR MATRÍCULA — CASO 2932

Dados **fictícios**. O atleta nasce **sem filiação**, e o histórico dele
já está no ranking **sem dono**, repartido em três competidores chamados
"Lucas Lima".

**Abra o perfil:** https://dts-quote-patio-integrity.trycloudflare.com/#/admin/atletas/cmuu0lbwe00kh1o8ndp11zxh3

1. confira que diz **Sem entidade de filiação**, , ;
2. **Editar cadastro** → **Entidade de filiação** =  → **Matrícula** =  → **Salvar**;
3. recarregue a página.

**Esperado:** 3 resultados vinculados e **250 pontos** — 240 de colocação
(80 + 100 + 60) mais **10** de bônus de Overall. Nenhum lançamento novo.

**No ranking** (temporada ): **uma única linha** para a
filiação + 2932, com o nome do cadastro.

**NÃO deve acontecer:** a linha sem matrícula entrar; a matrícula 2932 da
outra federação entrar; o homônimo de matrícula  receber nada.
Essas três continuam separadas de propósito.

## Credenciais de QA

| Papel | Usuário | Senha |
|---|---|---|
| Operador (direção de evento + gerência de ranking) | demo.diretora.muu0l7jj@mci.local | preview-mci-1b4ff29a21d3 |
| Atleta | demo.atleta.muu0l7jj@mci.local | preview-mci-1b4ff29a21d3 |

### Módulo Treinadores & Equipes

| Perfil | Usuário | Senha |
|---|---|---|
| Administração Central | central@mci.local | preview-mci-1b4ff29a21d3 |
| Diretor de Federação | diretor@mci.local | preview-mci-1b4ff29a21d3 |
| Treinador (Equipe) — cadastro **aprovado**, atuação autorizada | treinador@mci.local | preview-mci-1b4ff29a21d3 |
| Treinador suspenso — para a central **reativar** | treinador.suspenso@mci.local | preview-mci-1b4ff29a21d3 |
| Atleta com **convite pendente** | atleta@mci.local | preview-mci-1b4ff29a21d3 |
| Delegado central (delegação viva, com escopo e prazo) | delegado@mci.local | preview-mci-1b4ff29a21d3 |

Telas do módulo: `/#/treinador` · `/#/minha-equipe` ·
`/#/admin/treinadores` · `/#/admin/auditoria`

Federação: **Federação QA Treinadores** · Equipe: **Equipe QA Alfa**

Ambiente **público e efêmero**, com dados **fictícios**. Nenhuma destas
contas existe em produção, e nenhuma senha de produção foi usada.
Não insira dado real aqui.

**Quando expirar**, o túnel morre junto com a execução e a tela passa a
dizer "Não foi possível conectar à API." — não é defeito do sistema, é a
janela fechada. Para levantar outro: Actions › Preview QA › Run workflow.

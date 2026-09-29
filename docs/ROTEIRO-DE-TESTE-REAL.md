# Roteiro de teste real — MC Platform

Para Helder Falcão. Serve para você percorrer a plataforma publicada com as suas
credenciais normais e dizer, item por item, se passa ou não.

**Onde**
* Interface: `https://mci-platform-web.onrender.com`
* API: `https://mci-platform-api.onrender.com`

**Como navegar.** A interface usa rota por `#`. Você pode ir direto a qualquer
tela colando o endereço, por exemplo `…/#admin/eventos`. Isso é útil para testar
o desvio por permissão: uma rota que o seu perfil não pode abrir **deve** voltar
ao início em vez de mostrar tela vazia ou erro.

**Duas regras que valem para tudo abaixo.**

1. **Não crie inscrição em campeonato real, não altere resultado oficial e não
   envie recado a atleta de verdade.** Onde o roteiro pede escrita, use nome com
   prefixo `TESTE`, e apague depois quando a tela permitir.
2. Se algo falhar, anote **a tela, o que você fez e o que apareceu**. "Não
   funcionou" não é reproduzível; "abri `#admin/inscricoes`, filtrei por X e a
   lista ficou vazia mesmo tendo inscrição" é.

---

## Bloco 1 — Entrada e sessão

| # | O que fazer | O que deve acontecer |
|---|---|---|
| 1.1 | Abrir a interface deslogado | A vitrine aparece: campeonatos, atletas, ranking |
| 1.2 | Entrar com as suas credenciais | Cai no painel; o menu mostra **só** o que o seu perfil pode |
| 1.3 | Recarregar a página | Continua logado, na mesma tela |
| 1.4 | Sair | Volta à tela de entrada |
| 1.5 | Errar a senha de propósito uma vez | Recusa **sem dizer se o e-mail existe** — não deve diferenciar "usuário não encontrado" de "senha errada" |
| 1.6 | Entrar de novo | Funciona normalmente |

O item 1.5 é de segurança: mensagem diferente para e-mail inexistente permite
descobrir quem tem conta na plataforma.

---

## Bloco 2 — Vitrine pública

| # | Rota | O que conferir |
|---|---|---|
| 2.1 | `#inicio` | Os cartões de resumo trazem número, não travessão |
| 2.2 | `#campeonatos` | Lista com os campeonatos; abrir um leva à página dele |
| 2.3 | `#atletas` | Lista de atletas; **nenhum CPF à vista**, nem mascarado |
| 2.4 | `#ranking` | Tabela do Super Overall responde |
| 2.5 | Buscar um nome na busca do topo | Resultados aparecem, **sem CPF** |

O 2.3 e o 2.5 são os que mais importam. CPF em vitrine é o defeito que a
plataforma foi desenhada para nunca ter.

---

## Bloco 3 — Minha carreira (perfil de atleta)

| # | Rota | O que conferir |
|---|---|---|
| 3.1 | `#meu-painel` | Abre com os seus números |
| 3.2 | `#minha-filiacao` | Mostra a entidade de filiação — deve estar **preenchida**, não vazia |
| 3.3 | `#meu-historico` | Histórico de resultados e pontos |
| 3.4 | `#minha-conta` | Dá para trocar a foto e a senha |
| 3.5 | Trocar a foto por uma imagem sua | Sobe e aparece nas telas; recarregue para confirmar |

O 3.2 já foi defeito: o campo aparecia vazio e travava o autocadastro. Se
aparecer vazio de novo, é regressão — anote.

---

## Bloco 4 — Treinador e equipe

| # | Rota | O que conferir |
|---|---|---|
| 4.1 | `#treinador` | Painel do treinador abre (se o seu perfil for treinador) |
| 4.2 | `#minha-equipe` | A equipe aparece; dá para renomear |
| 4.3 | Buscar um atleta e convidar | O convite fica **pendente de confirmação do atleta** — não vincula sozinho |
| 4.4 | `#admin/treinadores` | A federação vê a lista de treinadores |

O 4.3 é regra homologada: o treinador pede, **o atleta confirma**. Se o vínculo
acontecer sem a confirmação, é defeito grave — anote na hora.

---

## Bloco 5 — Ranking de treinadores: o bloqueio deve estar de pé

| # | O que fazer | O que deve acontecer |
|---|---|---|
| 5.1 | Abrir a classificação de treinadores | **Deve RECUSAR**, com a mensagem de que a fórmula não está homologada |

Isto não é falha: é o §8.3. A fórmula do ranking de treinadores **não** foi
homologada pela MuscleContest, e a plataforma recusa classificar em vez de
inventar pontuação. Se aparecer uma classificação com números, **isso** é o
defeito.

---

## Bloco 6 — Operação de evento (perfil de federação)

| # | Rota | O que conferir |
|---|---|---|
| 6.1 | `#admin` | Painel administrativo com os cartões |
| 6.2 | `#admin/eventos` | Lista de campeonatos; abrir um mostra o detalhe |
| 6.3 | `#admin/inscricoes` | Lista responde; filtros funcionam |
| 6.4 | `#admin/checkin` | Tela abre |
| 6.5 | `#admin/pesagem` | Tela abre |
| 6.6 | `#admin/credenciamento` | Tela abre |
| 6.7 | `#admin/palco` | Tela abre |
| 6.8 | `#admin/resultados` | Recepção de apuração abre |

**Sobre o 6.8:** a MCI **não julga**. O julgamento é externo, e esta tela é a
porta de recepção do resultado apurado. Não espere ver notas de jurado.

---

## Bloco 7 — Atletas e pontuação (perfil de federação)

| # | Rota | O que conferir |
|---|---|---|
| 7.1 | `#admin/atletas` | Lista com filtros por estado e por filiação |
| 7.2 | Abrir um atleta | Perfil administrativo completo |
| 7.3 | `#admin/ranking` | Ranking com origem dos pontos |
| 7.4 | `#admin/overall` | Overall por categoria |
| 7.5 | `#admin/lancamentos` | Lançamentos de pontos |
| 7.6 | `#admin/musclewar` | Importação |
| 7.7 | `#admin/solicitacoes` | Fila de solicitações |
| 7.8 | `#admin/mensagens` | Recados; **não publique um recado real** |
| 7.9 | `#admin/auditoria` | Trilha de auditoria responde |
| 7.10 | `#admin/configuracoes` | Configurações abrem |

**Não altere pontuação, resultado ou classificação de atleta real** em nenhuma
destas telas. São registros oficiais.

---

## Bloco 8 — Social e mensagens

| # | Rota | O que conferir |
|---|---|---|
| 8.1 | `#social` | Feed carrega |
| 8.2 | `#comunidades` | Lista de comunidades |
| 8.3 | `#messenger` | Conversas abrem |
| 8.4 | `#notificacoes` | Notificações listam e marcam como lida |

---

## Bloco 9 — O que olhar em TODAS as telas

Isto é o que separa "funciona" de "está pronto".

| # | O que conferir |
|---|---|
| 9.1 | Nenhum botão que você clica e **nada acontece** |
| 9.2 | Nenhuma lista vazia **sem explicação** — deve dizer que não há nada, não ficar em branco |
| 9.3 | Todo erro traz mensagem em português que diz **o que fazer** |
| 9.4 | Toda ação que salva dá **confirmação visível** |
| 9.5 | Enquanto carrega, aparece **esqueleto**, não tela branca |
| 9.6 | Nenhum dado de demonstração apresentado como real |
| 9.7 | Nada de CPF, token ou e-mail alheio à vista |

### 9.8 No telefone

Abra no seu celular e percorra os blocos 2, 3 e 4. Confira:

* nada **corta** na horizontal — a página não deve rolar para o lado;
* os botões têm tamanho de dedo;
* o menu abre e fecha.

*Medido aqui:* 15 larguras de 320 a 1920 px, em Chromium real, sem overflow e
sem elemento fora da viewport. Se você encontrar um corte, é num caminho que o
gate não percorre — e é exatamente o que queremos saber.

---

## O que depende só de você

1. **Entrar com as suas credenciais.** Não tenho a sua senha e não devo ter.
2. **Publicar recado real a atletas**, se e quando decidir.
3. **Homologar a fórmula do ranking de treinadores** junto à MuscleContest. Até
   lá o bloqueio do Bloco 5 fica de pé, por decisão registrada.
4. **Conferir o painel do Render**, se quiser ver o log de build. Não tenho
   acesso a ele.

---

## Como me devolver o resultado

O formato mais útil:

```
Bloco 6.3 — FALHOU
Abri #admin/inscricoes, filtrei por "Etapa Cuiabá",
a lista ficou vazia mas o evento tem 12 inscrições.
```

Tela, ação, esperado, obtido. Com isso eu reproduzo; sem isso eu chuto.

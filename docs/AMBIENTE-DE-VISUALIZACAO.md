# Ambiente de visualização — FASE 13.25 a 13.27

Este documento responde a três perguntas, nesta ordem:

1. **Onde eu abro o sistema?** (§13.25)
2. **O que vou encontrar lá dentro?** (§13.26)
3. **O que eu confiro, tela por tela?** (§13.27)

---

## 0. O que NÃO foi possível fazer daqui, e por quê

Isto vem primeiro de propósito. A fase pede um endereço que abra num navegador
comum. **Eu não consigo entregar esse endereço a partir do ambiente onde
trabalhei**, e as razões são verificáveis, não impressões:

| Caminho | Resultado medido |
|---|---|
| Publicar num túnel (`trycloudflare`, `localhost.run`, `srv.us`) | `CONNECT` recusado pela política de rede — 403 |
| Chamar a API do Render para criar um serviço de visualização | `api.render.com:443` — `CONNECT` recusado, 403 |
| Fazer deploy pela `main` | **Proibido.** A `main` está congelada e o deploy dela é produção |

O contêiner onde o sistema roda tem endereço `192.0.2.x`, que não é roteável de
fora. Dizer "está no ar em tal endereço" seria mentira, e a regra de relatório
desta fase é explícita sobre isso.

**O que existe, então, é o caminho completo pronto para ser executado por quem
tem as credenciais** — em um comando na máquina de vocês, ou em um blueprint que
o Render aplica. Os dois estão abaixo, e os dois foram executados aqui até onde
o ambiente permite.

---

## 1. Abrir o sistema

### 1.1 Na máquina de vocês — um comando

Requisitos: Node 22, PostgreSQL 16 acessível e `psql` no PATH.

```bash
git clone <repositório> && cd mci-platform
git checkout claude/mci-platform-muscle-contest-o6haz9
npm ci && npm --prefix frontend ci

DEMO_PASSWORD='escolha-uma-senha-longa' node scripts/qa/ambiente.mjs
```

O script faz tudo: cria o banco descartável, aplica as migrations, semeia o
catálogo, cria o primeiro administrador, sobe a API, constrói o frontend **em
modo de produção** e semeia o conjunto de demonstração. No fim ele imprime o
endereço:

```
  Abra no navegador:  http://<ip-da-máquina>:5700
```

Ele escuta em `0.0.0.0` de propósito: um ambiente que só responde em
`127.0.0.1` só serve para quem está sentado na mesma máquina. Para prendê-lo à
máquina local, use `--host 127.0.0.1`.

**A senha é escolhida por vocês.** O script recusa iniciar sem `DEMO_PASSWORD`,
e recusa senha com menos de 12 caracteres — ele abre uma porta na rede, e senha
curta ali é convite. A senha vem por variável de ambiente, nunca por argumento:
argumento aparece em `ps` para qualquer usuário da máquina e fica no histórico
do shell. **Nunca use aqui uma senha que exista em produção.**

### 1.2 Na nuvem — blueprint separado de produção

`render.preview.yaml` cria `mci-preview-api`, `mci-preview-web` e
`mci-preview-db`, apontados para o branch de desenvolvimento. Nenhum nome
colide com produção e nada nele pode sobrescrever o ambiente existente.

Depois de aplicado, pelo shell do serviço da API, uma vez:

```bash
ADMIN_PASSWORD='<escolha>' node scripts/criar-admin.js "Nome" email@dominio
DEMO_PASSWORD='<escolha>' node scripts/qa/demo.mjs \
    --api https://<url-da-api-de-preview>/api/v1 \
    --admin-email email@dominio
```

O blueprint **não foi aplicado** daqui: o egress para `render.com` está
bloqueado nesta rede. Trate um erro de validação de schema como esperado.

---

## 2. O que existe lá dentro (§13.26)

Tudo é fictício e **tudo é marcado**: cada nome visível começa com `QA · DEMO`.
Um atleta de demonstração que se parece com um atleta de verdade é um passivo —
aparece em busca, entra em relatório, e um dia alguém o trata como real.

O conjunto é construído **pela API**, nunca escrevendo no banco. Se uma regra de
negócio recusasse, a semeadura falharia alto. Uma demonstração que contorna a
aplicação demonstra um sistema que não existe.

| Peça | Por que está lá |
|---|---|
| 1 federação, 2 filiações (NPC-MT e NPC-SP) | a troca de filiação precisa ser real |
| 1 temporada 2026, 3 etapas encerradas + 1 com inscrições abertas | sem a futura, a primeira tela diz "nenhum campeonato agendado" |
| 8 atletas | o suficiente para o corte público de TOP 5 existir |
| 3 classes por etapa: Open (absoluta), Novice, Master | sem as não absolutas, a diferença entre pontuação do campeonato e Super Overall fica invisível |
| **Atleta Que Trocou de Filiação** | compete pela NPC-MT na 1ª etapa e pela NPC-SP na 3ª |
| **Atleta Campeã Overall** | título homologado pelo operador, +10 uma vez |
| **Atleta Empatada A / B** | mesmo total e mesmos contadores: nenhuma recebe colocação |

Números conferidos na execução:

```
ranking da temporada: 8 atletas
histórico da atleta migrante: 2 participações
filiações no histórico dela: DEMO-NPC-SP-…, DEMO-NPC-MT-…
atletas com título Overall: 1
linhas sem colocação (empate não resolvido): 2
```

A campeã termina com **20 pontos**: 5 + 5 de colocação e **+10 de Overall, uma
única vez**.

---

## 3. Roteiro de conferência (§13.27)

Entre com a conta de **atleta** (o e-mail é impresso ao final da semeadura).

### 3.1 Meu histórico — a imutabilidade do passado

Abra **Meu histórico**. A coluna **FILIAÇÃO NA ÉPOCA** precisa mostrar:

| Campeonato | Filiação na época |
|---|---|
| Etapa Rondonópolis | QA · DEMO — NPC São Paulo · nº SP-2001 |
| Etapa Cuiabá | QA · DEMO — NPC Mato Grosso · nº MT-1001 |

E **Minha filiação** mostra só a atual: NPC São Paulo.

> **O que isso prova.** A atleta trocou de federação. O ponto antigo continua
> dizendo a federação antiga, porque a filiação é copiada no momento em que o
> ponto nasce. Se as duas linhas mostrarem São Paulo, o sistema reescreveu o
> passado — e isso é reprovação, não detalhe.

### 3.2 Ranking público — o corte e o empate

Abra **Ranking**, sem estar autenticado (janela anônima).

- A lista pública mostra **no máximo 5** por recorte.
- **Atleta Empatada A** e **Atleta Empatada B** aparecem **sem colocação**.

> **O que isso prova.** A hierarquia oficial não separa as duas, e o sistema
> **não inventa desempate**. Se uma delas aparecer em 2º e a outra em 3º,
> alguém acrescentou um critério que a regra não tem.

### 3.3 Homologação do Overall — quem decide é gente

Entre com a conta de **direção de evento** e abra **Administração → Overall**.

- A tela pede que se escolha o campeonato: ela **não** abre com um vencedor.
- Escolhido o campeonato, aparecem as classes **absolutas** e quem competiu
  nelas, com a colocação como fato.
- **Nenhum campo diz "este é o Overall".**
- Homologar exige **segunda confirmação explícita**.

> **O que isso prova.** O sistema não calcula nem sugere o campeão Overall.
> Se a tela destacar alguém sozinha, ela está decidindo no lugar da
> organização.

### 3.4 Campeonatos e resultados

- **Campeonatos** lista as 3 etapas encerradas e a **Etapa Sinop** com
  inscrições abertas.
- Abrindo uma etapa encerrada, o resultado publicado aparece por classe.

### 3.5 No celular

Abra o mesmo endereço no telefone (mesma rede). Confira em **Meu histórico**:

- nada sai da tela para o lado;
- a tabela vira cartões, com cada valor rotulado;
- os botões são grandes o bastante para o dedo.

### 3.6 Movimento reduzido

Ligue "reduzir movimento" no sistema operacional e recarregue. As animações
somem e o conteúdo continua. (Conferido automaticamente: sem a preferência,
262 elementos se movem; com ela, zero.)

---

## 4. O que NÃO está no ambiente de visualização

Honestidade sobre o escopo, para que ninguém conclua o que não foi mostrado:

- **Não há HTTPS.** É ambiente de conferência de dado fictício, não de dado
  real.
- **A API sobe em modo `development`.** A barreira de produção exige
  armazenamento de objetos e credenciais que a visualização não tem. Afrouxar a
  barreira para poder visualizar seria desligar o alarme para testar a porta.
  O que se está vendo é a **aplicação**; o que não se está vendo é a
  **configuração de produção**.
- **Os uploads são efêmeros.** Some tudo no reinício, por escolha.
- **As FASES 5–6 (importação Ipiranga) seguem BLOQUEADAS.** O arquivo de origem
  não existe neste ambiente, e nada foi fabricado para preencher o buraco.

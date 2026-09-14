# Gate de estabilidade

**Script:** `scripts/qa/estabilidade.mjs` · **Atalho:** `npm run qa:estabilidade`
**Criado em:** FASE 2.4 · **Origem:** sonda da FASE 2.3, que vivia fora do repositório

---

## 1. Por que ele existe

Um sistema com efeito visual tem uma forma própria de apodrecer: o efeito sai
da tela, mas o que ele criou fica. Intervalo que continua batendo depois que a
tela morreu; ouvinte que se soma a cada volta; `<audio>` que nunca para; nó de
DOM que nunca é recolhido.

Nada disso aparece na primeira volta. Aparece na enésima — no ginásio, seis
horas depois da abertura dos portões, quando o operador já não tem como
reiniciar nada.

Na FASE 2.3 essa verificação foi feita uma vez, por um script que não estava
versionado. **Verificação boa que não é versionada é verificação que acontece
uma vez só.**

## 2. O que ele mede

Tudo vem de duas fontes, e nenhuma delas é estimativa:

| Fonte | O que dá |
|---|---|
| CDP `Performance.getMetrics` | `Nodes`, `JSEventListeners`, `JSHeapUsedSize` |
| Contagem no DOM | efeitos na tela, elementos parados em `opacity: 0` |
| Instrumentação de teste | intervalos vivos, instâncias de `Audio` e quais tocam |

A instrumentação envolve `setInterval` e `Audio` **no navegador de teste**,
antes do produto carregar. Nada disso entra no pacote.

Antes de cada leitura o script força `HeapProfiler.collectGarbage`. Sem isso o
heap medido é lixo ainda não recolhido — e um número desses prova o que você
quiser.

## 3. Critérios de aprovação

```
efeito preso na tela .......... 0        (absoluto)
áudio tocando ................. 0        (absoluto)
erro de página ................ 0        (absoluto)
intervalo vivo ao sair ........ ≤ 1      (o dev server mantém o dele, do HMR)
chamada de API duplicada ...... 0        (ver §5)
nós DOM ....................... +15% + 50
ouvintes ...................... +15% + 20
heap após coleta .............. +30% + 3 MB
```

Crescimento zero é o alvo. A folga existe onde o número não depende só do
produto — heap depende também do que o coletor decide manter.

## 4. Como rodar

```sh
SENHA_QA='…' npm run qa:estabilidade -- \
  --base http://127.0.0.1:5412 \
  --ciclos 6
```

Meça o **pacote de produção** (`vite build` + `vite preview`), não o servidor de
desenvolvimento. A senha vem de variável de ambiente e **não** é aceita por
argumento: argumento aparece em `ps` e no histórico do shell.

Em ambientes onde o Playwright não está no `node_modules` do projeto:

```sh
--playwright /caminho/para/playwright/index.mjs --chromium /caminho/para/chromium
```

Saída `0` aprova, `1` reprova com a lista de critérios, `2` é problema de
ambiente (sem senha, sem login).

## 5. A armadilha do StrictMode

Em **desenvolvimento**, o `React.StrictMode` invoca cada efeito duas vezes de
propósito — justamente para expor efeito que não se limpa. Isso faz cada tela
pedir seus dados duas vezes, e o gate acusa "chamada duplicada".

Não é defeito do produto. Medido no pacote de produção, cada tela pede seus
dados uma vez. O script imprime esse aviso junto do resultado sempre que
encontra duplicata, para ninguém perseguir o fantasma de novo.

## 6. O ponto cego que este gate já teve

A primeira versão percorria as 13 telas e **aprovava um produto com a limpeza
do polling do Check-in quebrada**.

Motivo: sem evento escolhido, `recarregarACada` vale 0 e o intervalo nunca
chega a existir. O gate media uma tela que não estava ligada.

A correção foi passar a **escolher o evento** em cada tela que oferece o
seletor. Com ela, o mesmo defeito plantado de propósito passou a ser pego: os
intervalos vivos foram a 1, 2, 3 — um por volta — e o gate reprovou.

Fica registrado porque a lição vale mais que a correção: **um mutante que
sobrevive não é um mutante inofensivo, é um buraco no gate.** Toda vez que este
script for ampliado, plante o defeito antes de confiar no PASS.

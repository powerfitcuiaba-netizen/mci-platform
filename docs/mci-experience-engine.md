# MCI Experience Engine

Como o sistema se move, e por quê.

Este documento é normativo. **Todo módulo novo e toda implementação nova
respeitam o que está aqui.** Quem precisar de um efeito que este documento não
prevê acrescenta o efeito *aqui primeiro* — e aí a revisão discute o efeito, não
o commit que já o espalhou por cinco telas.

---

## 1. A regra de ouro

> Se o efeito chama mais atenção que a informação, o efeito está errado.

O MCI é ferramenta de trabalho. Alguém está pesando atleta às sete da manhã com
fila esperando. A interface tem de parecer rápida, precisa e cara — e nunca
custar um segundo do tempo dessa pessoa.

Três consequências práticas:

- **Animação nunca disfarça lentidão.** Para espera existe esqueleto de
  carregamento. Encher o vazio com movimento é mentir sobre o desempenho.
- **Animação nunca é o único sinal.** Se o efeito não aparecer — preferência do
  sistema, aparelho fraco, navegador antigo —, a informação continua inteira. O
  toast funcional nunca é substituído por celebração.
- **Animação nunca pulsa à toa.** Pulso é reservado a dado realmente ao vivo.
  Fingir tempo real com animação é mentir para quem decide olhando o número.

---

## 2. Por que não há biblioteca de animação

Medido no baseline da FASE 2, não suposto:

| | |
|---|---|
| Bibliotecas de motion no projeto | **nenhuma** |
| `@keyframes` que já existiam | 9 |
| Escala de tokens de tempo que já existia | `--t-rapido/base/calmo/amplo` |
| Bundle no início da fase | 485,11 kB |
| Custo estimado do GSAP | ~70 kB |
| Custo estimado do Framer Motion | ~110 kB |

Numa fase cujo objetivo é **percepção de velocidade**, pagar 70–110 kB para
fazer o que `transform` e `opacity` já fazem na GPU seria trabalhar contra o
próprio objetivo.

**O motor orquestra; o CSS anima.** O custo real do motor inteiro foi de
**+3,37 kB**.

---

## 3. Os seis níveis

Cada efeito declara quanto vale. É isso que impede "tudo brilhando ao mesmo
tempo", que é como um sistema animado vira um sistema cansativo.

| Nível | Nome | Onde |
|---|---|---|
| 0 | `ESTATICO` | a maioria da interface |
| 1 | `MICRO` | hover, foco, press — resposta ao dedo |
| 2 | `TRANSICAO` | troca de tela, abrir painel, revelação em sequência |
| 3 | `EVENTO` | salvou, credenciou, deu check-in, pesou |
| 4 | `MOMENTO` | resultado publicado |
| 5 | `CINEMATOGRAFICO` | abertura e campeão geral — **raríssimo** |

**O nível 5 é o mais fácil de estragar.** Se o momento campeão aparecer a cada
resultado, ele deixa de significar *campeão* e passa a significar *salvou*. Há
teste garantindo que `CAMPEAO` é o único evento de nível 5 e que nenhuma
operação rotineira passa de `EVENTO`.

**O nível decide também ONDE o gesto acontece.** A regra é derivada, nunca
escrita à mão, para não existir evento de nível 3 marcado "centro" num descuido:

| Posição | Níveis | O que significa |
|---|---|---|
| `linha` | até `EVENTO` | confirma **onde a ação aconteceu** |
| `centro` | `MOMENTO` | ocupa o meio da tela por alguns segundos |
| `tela` | `CINEMATOGRAFICO` | toma a tela inteira |

O centro da tela é espaço caro: quem o ocupa **interrompe**. Operação repetida
nunca interrompe — confirma ao lado do dedo e segue. A regra nasceu de um
defeito real: o check-in desenhava uma caixa no centro, e numa competição de
280 atletas essa caixa apareceria 280 vezes por cima da lista que o operador
está usando — inclusive por cima do contador que ela mesma comemorava.

Confirmar "na linha" não é confirmar menos. É o destaque na linha afetada, o
selo de estado, o contador que muda e o toast de sempre — tudo junto, e nada no
caminho de quem está trabalhando.

---

## 4. O teto de intensidade

`tetoDeIntensidade()` responde: *quanto este aparelho e esta pessoa aceitam
agora?* Todo efeito pergunta antes de acontecer.

- `prefers-reduced-motion: reduce` → teto **MICRO**. Partículas e deslocamentos
  somem; a informação fica. Não é funcionalidade desligada, é a mesma tela sem o
  teatro.
- `deviceMemory ≤ 2` ou `hardwareConcurrency ≤ 2` → teto **TRANSICAO**. Sem
  partícula. Ausência dessas dicas **não** é sinal de fraqueza: o padrão permite.
- Caso contrário → teto **CINEMATOGRAFICO**.

A preferência é lida **na hora**, nunca em cache: a pessoa pode mudar a
configuração com a aba aberta.

---

## 5. A escala de tempo

A escala **estende** a que o sistema já tinha. Criar um segundo vocabulário em
paralelo deixaria duas verdades sobre a mesma coisa.

| Token | Valor | Papel |
|---|---|---|
| `--t-rapido` | 120ms | instantâneo — já existia |
| `--t-base` | 180ms | micro — já existia |
| `--t-calmo` | 240ms | rápido — já existia |
| `--t-amplo` | 320ms | padrão — já existia |
| `--t-enfase` | 460ms | **novo** — confirmação que importa |
| `--t-cinema` | 760ms | **novo** — só nível 5 |

Curvas: `--curva-entrada` (algo chega), `--curva-saida` (algo vai embora),
`--curva-impacto` (algo aterrissa). `--mola` já existia e continua valendo.

`--ouro-luz` é **exclusivo de conquista**. Ouro em botão comum queima a moeda.

---

## 6. Sequência (stagger)

`atrasoDaSequencia(indice)` → `45ms` por item, **com teto de 360ms**.

O teto não é detalhe: sem ele, uma lista de 600 atletas faria o último aparecer
27 segundos depois. É assim que uma animação bonita vira uma tela travada.

`estiloDaSequencia` devolve `{}` quando não deve animar — o elemento nasce **no
lugar**, nunca invisível esperando efeito.

---

## 7. O anúncio

Quem **executa** a ação anuncia; quem **desenha** decide como mostrar.

```js
import { anunciar, MCIEvento } from '../lib/experiencia';

anunciar(MCIEvento.CREDENCIADO, { titulo: 'Atleta credenciado' });
```

`anunciar` devolve `false` quando o nível não passa do teto — e aí quem chamou
já tem o feedback de sempre, que nunca foi removido.

Há **um único** `<PalcoDaExperiencia />` no aplicativo inteiro, montado no casco.
Dois palcos desenhariam a mesma celebração duas vezes.

Efeito novo entra em `MCIEvento` e `ASSINATURA`. É isso que impede "cada tela
inventa o seu".

---

## 8. Os componentes

| Componente | Nível | Para quê |
|---|---|---|
| `Revelacao` | 2 | blocos de uma tela entrando em sequência |
| `VarreduraDeEnergia` | 1 | uma passada de luz no que é **novo** — nunca em laço |
| `PulsoAoVivo` | 1 | só dado **realmente** em tempo real |
| `ImpactoDeSucesso` | 4 | reconhecimento por cima do toast, não no lugar dele |
| `useRecemAfetado` | 1 | destaque curto na linha que a pessoa acabou de mexer |
| `ContadorVivo` | 1 | lampejo no número que mudou — nunca contagem de 0 até ele |
| `MomentoCampeao` | 5 | campeão geral, e nada mais |

As partículas do momento campeão são **14 e finitas**. Partícula em laço numa
tela de trabalho é bateria indo embora durante a pesagem.

---

## 9. O casco

Navegação, barra lateral e cabeçalho ficam no nível mais baixo que ainda
comunica: **MICRO no toque, TRANSIÇÃO na troca de seção**. Nada no casco chega a
`EVENTO` — um menu que comemora a própria abertura cansa na terceira vez.

---

## 10. Armadilhas conhecidas

Cada uma custou um defeito real nesta fase.

**`animation` é atalho, e atalho apaga.** Duas regras que alcançam o mesmo
elemento e declaram `animation` não se somam — a de maior especificidade apaga a
outra, sem erro de build e sem falha de teste. O efeito perdido vira código morto
com aparência de vivo. `frontend/src/styles.animacao.test.js` varre o CSS atrás
desse par e acusa pelo nome.

**`overflow: hidden` corta informação em silêncio.** O card de métrica escondia
qualquer valor longo pela borda — `CINEMATOGRÁFICO` virava `CINEMATOGRÁ`. Valor
quebra em duas linhas; valor nunca é cortado.

**Entrelinha apertada rapa acento.** Com a fonte de display, `1.0` de
entrelinha fazia o acento de `Á` passar da caixa e ser raspado. Corte de texto se
**mede** com `scrollWidth`/`scrollHeight`, não se olha.

**`animation` some quando o `style` vem de fora.** `Revelacao` espalhava
`{...resto}` depois de `style`: passar estilo inline sobrescrevia o atraso da
sequência e desligava o efeito **em silêncio** — o componente parecia funcionar
e não funcionava. Estilos são mesclados, nunca substituídos.

**Classe de animação escrita à mão passa por cima do teto.** Fixar `"revela"`
no `className` faz o elemento animar mesmo com `prefers-reduced-motion`. Quem
revela é o componente `Revelacao`, justamente para essa decisão não ser repetida
— e repetida errado — em cada tela.

**CSS de uma classe que não existe é efeito que não existe e parece existir.**
`.chat-body .bubble` foi escrito para um elemento cuja classe real é
`.chat-msg`. A varredura `styles.animacao.test.js` confere que toda classe com
`animation` aparece de fato em algum componente — e na primeira execução achou
`.progress-bar`, inexistente no código, com uma animação em **laço infinito**.

**Enum cru na tela.** Apareceu em onze lugares: `CONFIRMED` na tabela de
inscrições, `ON_STAGE` na página pública do evento, `CALLED` no painel do
próprio atleta, `TIE_UNRESOLVED` na apuração oficial, `SUPER_ADMIN` na lista de
usuários. Todo enum passa por um mapa em `lib/format.js`, todo mapa tem recuo
para o código, e `lib/rotulos.test.js` confere duas coisas: que nenhuma tela
renderiza um campo de enum direto, e que **os mapas batem com o schema** — sem
valor faltando e sem valor inventado.

**Véu claro no centro é véu ao contrário.** O momento campeão nascia com o
gradiente mais claro justo onde o nome fica — o texto da página lia-se através do
nome do campeão. O véu é opaco embaixo; o dourado é camada por cima.

---

## 11. O laboratório

`frontend/src/pages/experienceLab.jsx`, rota `#/experience-lab`.

Existe **só em desenvolvimento** (`import.meta.env.DEV`) e é verificado ausente
do bundle de produção a cada build. É onde os efeitos se calibram num lugar só,
antes de se espalharem.

---

## 12. O que o motor não pode fazer

- Não enfraquece segurança para obter efeito.
- Não expõe chave de armazenamento em nome de pré-visualização.
- Não guarda dado privado em `localStorage` (lá vive só preferência: som ligado,
  abertura já vista).
- Não inventa estado: nada pulsa como "ao vivo" sem estar ao vivo.

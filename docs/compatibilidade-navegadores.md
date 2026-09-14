# Compatibilidade entre navegadores — estado e procedimento

**Levantado em:** FASE 2.4 · **Reconferido em:** FASE 2.5 · **Status:** gate ABERTO

---

## 1. O que foi medido, e onde

| Motor | Situação | Evidência |
|---|---|---|
| **Chromium 141.0.7390.37** | TESTADO | fluxo completo percorrido neste ambiente |
| **Firefox** | **NÃO EXECUTADO — ambiente indisponível** | ver §2 |
| **WebKit (Safari)** | **NÃO EXECUTADO — ambiente indisponível** | ver §2 |

**Firefox e Safari não estão declarados como funcionando.** Não há medição, e
sem medição não há declaração — nem positiva, nem negativa. O risco continua
aberto e registrado.

## 2. Por que não foi executado

O ambiente de desenvolvimento traz apenas o Chromium:

```
$ ls /opt/pw-browsers/
chromium  chromium-1194  chromium_headless_shell-1194  ffmpeg-1011
```

O Playwright *anuncia* caminhos para os três motores, mas `executablePath()`
apenas calcula o caminho — não confere se o arquivo existe. A tentativa real de
abrir cada um mostra a diferença:

```
chromium ABRIU — versão 141.0.7390.37
firefox  FALHOU: Executable doesn't exist at /opt/pw-browsers/firefox-1495/firefox/firefox
webkit   FALHOU: Executable doesn't exist at /opt/pw-browsers/webkit-2215/pw_run.sh
```

E a instalação é barrada pela política de rede do ambiente. Reconferido na
FASE 2.5, agora com o motivo exato:

```
$ npx playwright install firefox webkit
Error: Download failed: server returned code 403 body 'request blocked:
  no rule or allowlist entry allows host "cdn.playwright.dev"'
Error: Download failed: server returned code 403 body 'request blocked:
  no rule or allowlist entry allows host "playwright.download.prss.microsoft.com"'
```

Não é falta de espaço, nem versão errada, nem rede instável: os dois hosts de
distribuição do Playwright estão fora da lista permitida deste ambiente. É uma
decisão de infraestrutura, e não algo que se contorne de dentro da sessão.

Fica o registro do método, porque ele vale para qualquer gate futuro:
**confira o motor abrindo o motor.** Um caminho anunciado não é um binário
instalado, e um teste que só pergunta o caminho passa sem nunca ter rodado.

## 3. Procedimento para fechar o gate em máquina real

Numa máquina com rede liberada (macOS é obrigatório para o Safari de verdade):

```sh
npx playwright install firefox webkit
npm --prefix frontend run build
npm --prefix frontend exec vite preview -- --port 5412 --strictPort --host 127.0.0.1
```

Depois, para cada motor, percorrer a lista do §4. O gate de estabilidade já
aceita motor por parâmetro:

```sh
SENHA_QA='…' npm run qa:estabilidade -- --base http://127.0.0.1:5412
```

O Safari de verdade (não o WebKit do Playwright) precisa de macOS com
Safari Technology Preview ou de um serviço de dispositivos reais. O WebKit do
Playwright cobre o motor, **não** cobre as particularidades do Safari em iOS
(barra de endereço que muda de altura, `100vh`, política de autoplay de áudio,
gesto de voltar). Onde isso importa aqui: a **abertura com trilha** e o
**Momento Campeão em tela cheia**.

## 4. Roteiro a percorrer em cada motor

Funcional:

1. login
2. Dashboard
3. Eventos
4. Inscrições
5. Atletas
6. Check-in
7. Pesagem
8. Credenciamento
9. Palco
10. Resultados
11. Overall
12. Momento Campeão
13. Social
14. Messenger

Transversal:

15. abertura
16. áudio (incluindo recusa de autoplay)
17. silenciar o som e a preferência sobreviver à recarga
18. `prefers-reduced-motion: reduce`
19. diálogos (abrir, Escape, foco, empilhamento)
20. navegação (gaveta no celular, barra lateral no desktop)
21. toque: alvo mínimo, rolagem, sem atraso de 300 ms
22. viewport e `safe-area` (entalhe e barra inferior)
23. tela cheia do Momento Campeão
24. paginação: “Carregar mais” em lista longa
25. larguras 320 / 390 / 768 / 1024 / 1440 / 2560

## 4.1 Atenção especial no Safari iOS

Estes são os pontos onde o Safari iOS diverge dos outros motores de forma que
importa para ESTE produto. Nenhum deles é coberto pelo WebKit do Playwright:

| Ponto | Onde bate no MCI | O que conferir |
|---|---|---|
| **autoplay** | trilha da abertura | a recusa não pode travar a abertura; o convite para ativar som precisa aparecer |
| **AudioContext** | não usado de propósito | confirmar que continua sem `AudioContext` — a trilha é um `<audio>` só |
| **abertura** | primeira impressão | sequência completa sem salto nem tela preta |
| **tela cheia** | Momento Campeão | o véu cobre a tela inteira, inclusive sob a barra de endereço |
| **`safe-area`** | entalhe e barra inferior | nada de conteúdo sob o entalhe nem sob a barra |
| **viewport mobile** | altura que muda ao rolar | `100vh` cresce e encolhe no iOS; conferir o véu do campeão e os diálogos |
| **scroll** | listas longas paginadas | rolagem elástica não pode disparar “carregar mais” sozinha |
| **touch** | operação de check-in | alvo de toque, duplo toque, e o gesto de voltar não pode fechar diálogo aberto |

**NÃO declarar Safari PASS sem Safari real.** O WebKit do Playwright cobre o
motor; ele não cobre o navegador, e é o navegador que o operador usa.

## 5. O que se sabe de risco, sem medir

Não é medição — é leitura do código, e está aqui para orientar o teste, não
para substituí-lo:

| Recurso usado | Onde | Risco conhecido |
|---|---|---|
| `backdrop-filter` | véu do Momento Campeão | suporte antigo do Firefox exigia ativação manual |
| `<picture>` + WebP | marca | WebP é suportado em todos os alvos atuais; o PNG continua como reserva |
| `prefers-reduced-motion` | motor de experiência | suportado nos três motores |
| `aspect-ratio` | plaqueta da marca | suportado nos três motores desde 2021 |
| política de autoplay | abertura | **diverge entre motores**; o produto já trata recusa sem travar |
| `dvh`/`vh` | tela cheia do campeão | Safari iOS muda a altura da barra; conferir |

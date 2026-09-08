# Roteiro de teste manual — MCI

Para o teste de aceitação. Cada etapa diz **o que fazer**, **o que deve
acontecer** e **o que não pode acontecer**. Se alguma linha de "não pode"
acontecer, anote o passo e a tela.

---

## Preparar o ambiente

```bash
# 1. Banco limpo
createdb mci_uat
DATABASE_URL='postgresql://.../mci_uat' npx prisma migrate deploy
DATABASE_URL='postgresql://.../mci_uat' node prisma/seed.js
psql -d mci_uat -v senha="'<senha do app>'" -f scripts/provision-app-role.sql

# 2. Primeiro administrador (a senha NÃO vai por argumento)
DATABASE_URL='postgresql://.../mci_uat' ADMIN_PASSWORD='<sua senha>' \
  node scripts/criar-admin.js --email <seu email> --name 'Seu Nome'

# 3. API
NODE_ENV=production PORT=3000 \
DATABASE_URL='postgresql://.../mci_uat' \
JWT_SECRET='<32+ caracteres aleatórios>' \
CORS_ORIGINS='http://localhost:5173' \
ALLOW_LOCAL_STORAGE=true STORAGE_DIR=./uploads \
TRUST_PROXY_HOPS=0 \
  node server.js

# 4. Interface
cd frontend && npm run build && npx vite preview --port 5173
```

Confira antes de começar: `GET /ready` tem de responder
`{"ready":true,...,"rls":true}`. Se `rls` vier falso, **pare** — o sistema
serviria dado restrito.

---

## 1. Entrar no sistema

**O que fazer:** abrir a interface, clicar em Entrar, usar o email e a senha do
administrador criado.

**O que deve acontecer:** entra e cai numa tela com menu lateral. A URL muda
para algo como `#/inicio`.

**O que NÃO pode acontecer:** tela branca; erro no console; entrar com senha
errada; a mensagem de erro dizer se o email existe ou não.

> **Teste junto:** erre a senha 11 vezes seguidas. Da 11ª em diante tem de vir
> "Muitas tentativas" com um tempo de espera.

---

## 2. Criar a organização e a temporada

**O que fazer:** criar uma organização (federação). Criar uma temporada com
ano. Gravar a tabela de pontos: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1.

**O que deve acontecer:** as três aparecem listadas logo após salvar.

**O que NÃO pode acontecer:** salvar sem nome; a temporada aceitar ano fora de
faixa; a tabela aceitar colocação repetida.

---

## 3. Criar equipe e empresa

**O que fazer:** criar uma empresa e uma equipe vinculada a ela.

**O que deve acontecer:** a equipe mostra a empresa a que pertence.

**O que NÃO pode acontecer:** equipe de uma federação aparecer em outra.

---

## 4. Cadastrar atleta

**O que fazer:** cadastrar 4 atletas com CPF válido, sexo, data de nascimento,
estado e cidade. Vincular à equipe.

**O que deve acontecer:** aparecem na listagem. O CPF aparece para você
(operador com permissão).

**O que NÃO pode acontecer:** aceitar CPF inválido; aceitar **o mesmo CPF duas
vezes** na mesma federação; CPF aparecer em tela pública.

> **Teste junto:** abra `/#/atletas` numa **janela anônima**, sem login. A
> vitrine pública não pode mostrar CPF de ninguém.

---

## 5. Criar o evento

**O que fazer:** criar evento com nome, data, cidade e temporada. Adicionar
categoria, divisão e duas classes (OPEN e ESTREANTE).

**O que deve acontecer:** o evento nasce em `DRAFT`.

**O que NÃO pode acontecer:** pular direto de `DRAFT` para `CLOSED`. A
transição fora de ordem tem de ser recusada com motivo.

---

## 6. Abrir inscrições e inscrever

**O que fazer:** mover para `PLANNED`, depois `REGISTRATIONS_OPEN`. Inscrever
os 4 atletas — 3 na OPEN, 1 na ESTREANTE. Depois fechar
(`REGISTRATIONS_CLOSED`).

**O que deve acontecer:** as inscrições aparecem confirmadas.

**O que NÃO pode acontecer:** inscrever **o mesmo atleta duas vezes** no mesmo
evento; inscrever depois de fechado.

---

## 7. Check-in

**O que fazer:** fazer check-in dos 4. Depois **desfazer** o de um.

**O que deve acontecer:** o estado muda na hora; o desfeito volta a pendente.

**O que NÃO pode acontecer:** check-in repetido criar dois registros; check-in
funcionar com o evento ainda em `REGISTRATIONS_OPEN`.

---

## 8. Credencial

**O que fazer:** emitir credencial para um atleta. Validar o código na entrada.
**Revogar**. Validar o mesmo código de novo.

**O que deve acontecer:** a primeira validação aceita; depois da revogação a
resposta é recusa com o motivo "Credencial revogada".

**O que NÃO pode acontecer:** credencial revogada continuar passando.

---

## 9. Pesagem

**O que fazer:** registrar peso e altura de um atleta.

**O que deve acontecer:** grava e mostra a última pesagem na inscrição.

**O que NÃO pode acontecer:** aceitar peso absurdo (abaixo de 20 kg ou acima de
400 kg).

---

## 10. Bateria e ordem de palco

**O que fazer:** criar uma bateria na classe OPEN, definir a ordem dos 3
atletas, mudar a situação para "Chamada".

**O que deve acontecer:** a ordem gravada aparece na leitura, na sequência 1, 2, 3.

**O que NÃO pode acontecer:** a ordem voltar embaralhada; aceitar posição
duplicada.

---

## 11. Receber o resultado (o MCI não julga)

**O que fazer:** mover o evento para `IN_OPERATION` e depois `IN_JUDGING`.
Lançar o resultado da OPEN: 1º, 2º, 3º.

**O que deve acontecer:** o resultado entra como rascunho.

**O que NÃO pode acontecer:** aceitar **duas colocações iguais**; aceitar
atleta que **não está inscrito naquela classe**; existir qualquer tela de
"dar nota" ou "ficha de juiz" — o julgamento é externo.

---

## 12. Publicar e corrigir

**O que fazer:** publicar o resultado. Tentar lançar de novo. Depois corrigir
trocando o 1º com o 2º, com justificativa.

**O que deve acontecer:** depois de publicado, novo lançamento é recusado. A
correção cria uma **nova versão** e a anterior continua guardada, com a
justificativa.

**O que NÃO pode acontecer:** a versão original sumir; a correção passar sem
justificativa.

> **Ponto que vale conhecer:** o **diretor de evento não corrige resultado já
> publicado**. Isso é de administrador da plataforma, de propósito. Se você
> testar com um usuário que é só diretor, o `403` é o comportamento certo.

---

## 13. Overall e ranking

**O que fazer:** declarar a campeã Overall do evento. Fechar o evento
(`RESULTS_IN_REVIEW` → `RESULTS_PUBLISHED` → `CLOSED`). Recalcular o ranking.

**O que deve acontecer:**
* 1º lugar **com** Overall = **15 pontos** (5 da colocação **+ 10** do bônus)
* 2º = 4 · 3º = 3
* 1º da ESTREANTE = **5** no campeonato

**O que NÃO pode acontecer:** o Overall **substituir** os pontos da colocação
em vez de somar.

---

## 14. Super Overall

**O que fazer:** abrir o Super Overall da temporada.

**O que deve acontecer:** aparecem os atletas da **OPEN**.

**O que NÃO pode acontecer:** o 1º da **ESTREANTE** aparecer ali. Ele pontua o
campeonato, mas **não** alimenta o Super Overall.

---

## 15. Equipes e empresas

**O que fazer:** abrir o ranking de equipes e o de empresas.

**O que deve acontecer:** a equipe soma os pontos dos seus atletas; a empresa
soma os das suas equipes.

**O que NÃO pode acontecer:** peso ou multiplicador diferente do individual.

---

## 16. Importar do MuscleWar

**O que fazer:** montar um CSV com estas colunas e importar:

```
external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,equipe,evento,overall
MW-1,<CPF de um atleta seu>,Nome,BIKINI,OPEN,1,15,Equipe,2a Etapa,SIM
MW-2,<outro CPF seu>,Nome,BIKINI,OPEN,2,99,Equipe,2a Etapa,NAO
MW-3,12345678909,Desconhecida,BIKINI,OPEN,3,3,Equipe,2a Etapa,NAO
```

**O que deve acontecer na pré-visualização:**
* MW-1 **reconhecida** — repare no **15**: a coluna de pontos é o total
  **final**, colocação (5) **+ Overall** (10). Informar 5 aqui daria conflito
* MW-2 em **CONFLITO** — 99 não bate com a regra, e a mensagem mostra a conta
* MW-3 **pendente** — CPF não existe no cadastro

**O que fazer depois:** ligar a linha pendente a um atleta seu. Aplicar a
importação. **Aplicar de novo.**

**O que deve acontecer:** o vínculo resolve o pendente e **não** resolve o
conflito. Aplicar leva só as válidas. Aplicar a segunda vez **não soma ponto
nenhum**.

**O que NÃO pode acontecer:** a linha em conflito entrar; os pontos dobrarem na
segunda aplicação.

---

## 17. Social

**O que fazer:** publicar um post, curtir, comentar, salvar, seguir um perfil.

**O que deve acontecer:** tudo aparece no feed sem recarregar a página.

**O que NÃO pode acontecer:** post de uma federação aparecer para quem não
deveria vê-lo; HTML digitado no post ser **executado** na tela.

---

## 18. Messenger

**O que fazer:** abrir conversa com outro usuário, mandar mensagem, reagir,
apagar uma mensagem.

**O que deve acontecer:** a mensagem aparece para os dois lados.

**O que NÃO pode acontecer:** ver conversa de que você não participa.

---

## 19. Comunidades, busca e notificações

**O que fazer:** entrar numa comunidade, buscar por nome de atleta, abrir as
notificações.

**O que deve acontecer:** a busca responde rápido e só com o que você pode ver.

**O que NÃO pode acontecer:** a busca por **CPF** encontrar alguém quando você
não tem permissão de dado sensível; comunidade privada de outra federação
aparecer.

---

## 20. Auditoria

**O que fazer:** com o **administrador da plataforma**, abrir a auditoria.

**O que deve acontecer:** aparecem as ações do dia — recebimento e publicação
de resultado, declaração de Overall, recálculo de ranking, importação —, cada
uma com autor e horário.

**O que NÃO pode acontecer:** **CPF aparecer na trilha**; um diretor de evento
conseguir abrir a auditoria (hoje é `403`, de propósito — veja a nota no
relatório).

---

## 21. O que testar na sua mão, além do roteiro

**Celular de verdade.** Abra no seu telefone. Repare especialmente no botão de
abrir o menu: ele tem 31×34 px e está na lista de ajustes do refinamento
visual. Diga se incomodou.

**Voltar e recarregar.** Navegue até uma tela interna, aperte **voltar** e
depois **F5**. Nos dois casos você tem de continuar logado e no lugar certo.

**Duas abas.** Abra duas abas e faça a mesma operação nas duas ao mesmo tempo —
duas inscrições do mesmo atleta, por exemplo. Só uma pode valer.

**Duas federações.** Se puder, crie uma segunda federação com outro usuário e
tente alcançar os dados da primeira pela URL. Nada pode passar.

---

## Como reportar

Para cada problema, anote:

```
TELA:        onde estava
PASSO:       o que fez
ESPERADO:    o que achou que ia acontecer
ACONTECEU:   o que aconteceu
CONSOLE:     erro no console do navegador, se houver (F12)
```

Erro de comportamento e incômodo visual são coisas diferentes — o segundo entra
na lista do refinamento, e é bom anotar do mesmo jeito.

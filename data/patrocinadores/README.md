# A semente do catálogo de patrocinadores oficiais

O que mora aqui é a **origem da migração** das 15 marcas que estavam no código
para o catálogo `OfficialSponsor` do banco. `scripts/provisionar-patrocinadores-oficiais.js`
lê esta pasta e nada mais.

## Por que aqui, e não em `frontend/`

Porque o provisionamento roda **de dentro da imagem da API**, no
`preDeployCommand`, e a imagem não carrega o frontend: o `.dockerignore`
exclui `frontend` e o `Dockerfile` copia `prisma`, `src`, `scripts`, `data` e
`server.js`.

Isso não foi previsto na primeira versão, e o resultado foi exatamente o que
`tests/empacotamento-importador.test.mjs` já existia para impedir: o script
foi para produção sem o dado que ele lê. O catálogo subiu **vazio**, a vitrine
ficou sem patrocinador, e nada acusou — porque, no repositório, `frontend/`
está lá e o roteiro de QA encontrava tudo.

`data/` é o lugar que este repositório já usa para dado que o script precisa
em produção (`data/campeonatos-2026.json` chegou aqui pela mesma lição), e é o
único diretório de dados que entra na imagem.

## O que é cada coisa

- `catalogo.json` — as 15 marcas: `code`, `name`, `level`, `sortOrder` e o nome
  do arquivo da arte. O `code` sai do nome do arquivo, que é a identidade
  estável: o nome comercial pode ser corrigido sem que a marca mude.
- `*.png` — as artes, byte a byte iguais às de `frontend/public/patrocinadores/`.

## As duas cópias não podem divergir

Elas são cobradas por teste: `tests/empacotamento-importador.test.mjs` compara
este `catalogo.json` com `marcasNaOrdemDaHierarquia()` de
`frontend/src/lib/patrocinadores.js` e confere que cada PNG daqui é idêntico
ao de lá. Corrigir um lado e esquecer o outro reprova.

A duplicação é **transitória**: depois que o catálogo do banco for a única
fonte em produção, as cópias do frontend saem — em tarefa própria, porque
apagá-las junto com esta correção misturaria uma limpeza com um conserto.

## Depois da migração, quem manda é o banco

O script só faz `INSERT`, e só do que falta. Ele **não** sobrescreve marca que
já exista, mesmo que o nome tenha mudado aqui: edição feita pela tela de
Configurações é a verdade, e um provisionamento não tem autoridade para
desfazê-la.

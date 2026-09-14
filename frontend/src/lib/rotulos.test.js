import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  estadoDaEntrada, tipoDeCredencial, papel, estadoDoUsuario,
  tipoDeFiliacao, estadoDaImportacao, estadoDaBateria, estadoDaInscricao, estadoPro,
  ESTADO_DA_ENTRADA, TIPO_DE_CREDENCIAL, PAPEL, ESTADO_DO_USUARIO, TIPO_DE_FILIACAO,
  ESTADO_DA_IMPORTACAO, ESTADO_BATERIA, ESTADO_INSCRICAO, ESTADO_PRO, TIPO_DE_PERFIL
} from './format';

// ==========================================================================
// ENUM CRU NA TELA — a classe de defeito que mais se repetiu nesta fase.
//
// Apareceu em SEIS lugares diferentes: "CONFIRMED" na tabela de inscrições,
// "ON_STAGE" na página PÚBLICA do evento, "CALLED" no painel do próprio
// atleta, "TIE_UNRESOLVED" na apuração oficial, "SUPER_ADMIN" na lista de
// usuários, "APPLIED" na importação.
//
// Corrigir seis lugares não impede o sétimo. Esta varredura impede.
// ==========================================================================

const TELAS = resolve(process.cwd(), 'src/pages');
const fontes = readdirSync(TELAS)
  .filter(nome => /\.jsx$/.test(nome) && !nome.includes('.test.'))
  .map(nome => ({ nome, texto: readFileSync(resolve(TELAS, nome), 'utf8') }));

// Campos cujo valor é um enum do banco. Renderizá-los direto mostra o código.
const CAMPOS_DE_ENUM = ['status', 'role', 'proStatus', 'kind'];

describe('nenhum enum chega cru à tela', () => {
  it('a varredura enxerga as telas de verdade', () => {
    expect(fontes.length).toBeGreaterThan(5);
    expect(fontes.some(f => f.nome === 'adminEvent.jsx')).toBe(true);
  });

  it('a varredura RECONHECE um enum cru — controle contra padrão quebrado', () => {
    const exemplo = '<Badge tom="ok">{usuario.status}</Badge>';
    const padrao = new RegExp('>\\s*\\{\\s*[A-Za-z_$][\\w$.?]*\\.status\\s*\\}', 'g');
    expect(exemplo.match(padrao)).toHaveLength(1);
    // E não pode acusar o que é legítimo: comparação e prop continuam válidas.
    expect('{item.status === "ACTIVE" && <X />}'.match(padrao)).toBeNull();
    expect('<Badge tom={estadoDoUsuario(u.status).tom}>'.match(padrao)).toBeNull();
  });

  it('nenhuma tela renderiza um campo de enum diretamente', () => {
    const achados = [];
    for (const { nome, texto } of fontes) {
      for (const campo of CAMPOS_DE_ENUM) {
        // `{algo.status}` renderizado como conteúdo JSX — ou seja, logo depois
        // de um `>`, e não dentro de uma comparação, de uma prop ou de um
        // atributo `value`.
        //
        // Este padrão JÁ NASCEU QUEBRADO uma vez: escrito com escapes demais,
        // virou `>\\s*` (barra literal) e não casava com nada. O teste passava
        // sem provar coisa alguma, e só o teste de mutação mostrou isso — por
        // isso existe o caso de controle logo abaixo.
        const padrao = new RegExp('>\\s*\\{\\s*[A-Za-z_$][\\w$.?]*\\.' + campo + '\\s*\\}', 'g');
        for (const achado of texto.match(padrao) || []) {
          achados.push(`${nome}: ${achado.trim()}`);
        }
      }
    }
    expect(achados).toEqual([]);
  });
});

describe('todo rótulo tem recuo', () => {
  const mapas = [
    ['estadoDaEntrada', estadoDaEntrada], ['tipoDeCredencial', tipoDeCredencial],
    ['papel', papel], ['estadoDoUsuario', estadoDoUsuario],
    ['tipoDeFiliacao', tipoDeFiliacao], ['estadoDaImportacao', estadoDaImportacao],
    ['estadoDaBateria', estadoDaBateria], ['estadoDaInscricao', estadoDaInscricao],
    ['estadoPro', estadoPro]
  ];

  it('um código desconhecido devolve o próprio código, e não quebra', () => {
    for (const [nome, fn] of mapas) {
      const saida = fn('VALOR_QUE_NAO_EXISTE');
      expect(saida, nome).toBeTruthy();
      expect(saida.rotulo, nome).toBe('VALOR_QUE_NAO_EXISTE');
      expect(typeof saida.tom, nome).toBe('string');
    }
  });

  it('nulo e indefinido não viram "undefined" na tela', () => {
    for (const [nome, fn] of mapas) {
      for (const vazio of [null, undefined, '']) {
        const saida = fn(vazio);
        expect(saida.rotulo, `${nome} com ${String(vazio)}`).toBe('—');
      }
    }
  });

  it('todo rótulo conhecido está em português e sem underscore', () => {
    for (const [nome, fn] of mapas) {
      for (const codigo of ['ACTIVE', 'CONFIRMED', 'CALLED', 'RANKED', 'ATHLETE', 'SUPER_ADMIN', 'APPLIED', 'FEDERATION', 'NONE']) {
        const { rotulo } = fn(codigo);
        // Se o mapa conhece o código, o rótulo não pode ser o próprio código.
        if (rotulo !== codigo) {
          expect(rotulo, `${nome}.${codigo}`).not.toMatch(/_/);
          expect(rotulo, `${nome}.${codigo}`).not.toMatch(/^[A-Z]+$/);
        }
      }
    }
  });
});

// ==========================================================================
// OS MAPAS PRECISAM BATER COM O SCHEMA.
//
// Escrevi `ORGANIZATION` e `USER` em TIPO_DE_PERFIL. Nenhum dos dois existe em
// `ProfileKind` — o enum real tem `FAN`, que eu tinha deixado de fora. Inventar
// valor não quebra nada na hora: só cria um rótulo que nunca aparece e um
// estado real que aparece cru.
// ==========================================================================
import { readFileSync as lerArquivo } from 'node:fs';

const schema = lerArquivo(resolve(process.cwd(), '../prisma/schema.prisma'), 'utf8');

const valoresDoEnum = nome => {
  const bloco = schema.match(new RegExp(`enum ${nome} \\{([^}]*)\\}`));
  if (!bloco) return null;
  return bloco[1].split('\n').map(l => l.trim()).filter(l => /^[A-Z_]+$/.test(l));
};

describe('os mapas batem com os enums do schema', () => {
  const pares = [
    ['ResultEntryStatus', ESTADO_DA_ENTRADA], ['CredentialType', TIPO_DE_CREDENCIAL],
    ['UserRole', PAPEL], ['UserStatus', ESTADO_DO_USUARIO],
    ['AffiliationKind', TIPO_DE_FILIACAO], ['ImportStatus', ESTADO_DA_IMPORTACAO],
    ['BatchStatus', ESTADO_BATERIA], ['RegistrationStatus', ESTADO_INSCRICAO],
    ['ProStatus', ESTADO_PRO], ['ProfileKind', TIPO_DE_PERFIL]
  ];

  it('o schema foi mesmo lido', () => {
    expect(schema.length).toBeGreaterThan(1000);
    expect(valoresDoEnum('UserStatus')).toEqual(['ACTIVE', 'SUSPENDED', 'DISABLED']);
  });

  it('nenhum valor do enum fica sem rótulo, e nenhum rótulo é inventado', () => {
    const problemas = [];
    for (const [nomeDoEnum, mapa] of pares) {
      const valores = valoresDoEnum(nomeDoEnum);
      if (!valores) { problemas.push(`enum ${nomeDoEnum} não existe no schema`); continue; }
      for (const valor of valores) {
        if (!mapa[valor]) problemas.push(`${nomeDoEnum}.${valor} sem rótulo`);
      }
      for (const chave of Object.keys(mapa)) {
        if (!valores.includes(chave)) problemas.push(`${nomeDoEnum}: "${chave}" não existe no enum`);
      }
    }
    expect(problemas).toEqual([]);
  });
});

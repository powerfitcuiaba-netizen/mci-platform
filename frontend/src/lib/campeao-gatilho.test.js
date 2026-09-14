import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSINATURA, MCIEvento, NIVEL } from './experiencia';

// ==========================================================================
// O GATILHO DO NÍVEL 5, TRAVADO NA FONTE.
//
// O Momento Campeão é o único efeito de nível 5 do produto. Sua força vem de
// ser raro — e "raro" não é uma intenção, é uma propriedade que precisa de
// guarda. Basta alguém anunciar `MCIEvento.CAMPEAO` numa tela de sucesso
// qualquer para o efeito máximo virar confete de rotina, e nada no sistema
// reclamaria.
//
// A prova do lado do servidor (só o rankingService escreve em
// `EventOverallTitle`) está em tests/overall-prova-negativa.test.mjs. Esta
// aqui é a metade de cá.
// ==========================================================================

const PASTAS = ['src/pages', 'src/components'];
const fontes = PASTAS.flatMap(pasta => {
  const base = resolve(process.cwd(), pasta);
  return readdirSync(base)
    .filter(nome => /\.jsx$/.test(nome) && !nome.includes('.test.'))
    .map(nome => ({ arquivo: `${pasta}/${nome}`, texto: readFileSync(resolve(base, nome), 'utf8') }));
});

// O laboratório é a exceção declarada: ele existe para DEMONSTRAR os momentos
// e só é compilado em desenvolvimento. Se um dia ele for para produção, esta
// lista é o lugar onde a decisão aparece.
const SO_EM_DESENVOLVIMENTO = ['src/pages/experienceLab.jsx'];

describe('o Momento Campeão tem um gatilho, e só um', () => {
  it('a varredura enxerga arquivos de verdade', () => {
    expect(fontes.length).toBeGreaterThan(8);
    expect(fontes.some(f => f.arquivo.endsWith('adminResults.jsx'))).toBe(true);
  });

  // ANUNCIAR é diferente de LER. `experiencia.jsx` cita o evento para decidir
  // o que desenhar quando ele chega — isso é o palco, não o gatilho. A busca
  // precisa mirar a chamada, não a menção; o contrário reprovaria o palco e
  // ensinaria a próxima pessoa a afrouxar a regra.
  const ANUNCIA_CAMPEAO = /anunciar\s*\(\s*MCIEvento\.CAMPEAO/;

  it('a busca mira a CHAMADA, não a menção', () => {
    // Controle: sem isto, um padrão que não casa com nada passaria como
    // "ninguém anuncia" — que é o jeito mais silencioso de um guarda mentir.
    expect(ANUNCIA_CAMPEAO.test("anunciar(MCIEvento.CAMPEAO, { nome: 'x' })")).toBe(true);
    expect(ANUNCIA_CAMPEAO.test('if (evento === MCIEvento.CAMPEAO) return null;')).toBe(false);
  });

  it('só a declaração de título Overall anuncia o nível 5', () => {
    const quemAnuncia = fontes
      .filter(({ arquivo }) => !SO_EM_DESENVOLVIMENTO.includes(arquivo))
      .filter(({ texto }) => ANUNCIA_CAMPEAO.test(texto))
      .map(({ arquivo }) => arquivo);

    expect(quemAnuncia, `o nível 5 ganhou gatilho novo em: ${quemAnuncia.join(', ')}`)
      .toEqual(['src/pages/adminResults.jsx']);
  });

  it('e nesse arquivo o anúncio fica DEPOIS da resposta do servidor', () => {
    const fonte = fontes.find(f => f.arquivo.endsWith('adminResults.jsx')).texto;
    const chamada = fonte.indexOf('api.ranking.declararOverall(');
    const anuncio = fonte.indexOf('MCIEvento.CAMPEAO');
    expect(chamada, 'a declaração sumiu do arquivo').toBeGreaterThan(0);
    // Anunciar antes da resposta faria a tela celebrar um título que o
    // servidor ainda pode recusar — e o efeito de campeão não tem desfazer.
    expect(anuncio, 'o campeão é anunciado antes de o servidor confirmar').toBeGreaterThan(chamada);
  });

  it('e continua sendo o ÚNICO nível 5 declarado no motor', () => {
    const cinco = Object.entries(ASSINATURA)
      .filter(([, assinatura]) => assinatura.nivel === NIVEL.CINEMATOGRAFICO)
      .map(([evento]) => evento);
    expect(cinco).toEqual([MCIEvento.CAMPEAO]);
  });
});

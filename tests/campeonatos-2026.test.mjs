import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as s from '../src/utils/schemas.js';

// ==========================================================================
// O calendário oficial é DADO, e dado entra no repositório com conferência.
//
// Este arquivo existe para que uma edição manual de data/campeonatos-2026.json
// — preencher uma cidade que era "a confirmar", corrigir um endereço — não
// possa introduzir data impossível, slug duplicado ou UF inventada sem a suíte
// acusar. O importador roda uma vez; o arquivo é editado muitas.
// ==========================================================================

const dados = JSON.parse(readFileSync('data/campeonatos-2026.json', 'utf8'));
const { eventos } = dados;

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];

const gerarSlug = (nome, ano) => `${nome.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${ano}`.slice(0, 80);

describe('calendário 2026', () => {
  it('traz os 47 eventos do documento, numerados sem furo', () => {
    expect(eventos).toHaveLength(47);
    expect(eventos.map(e => e.n)).toEqual(Array.from({ length: 47 }, (_, i) => i + 1));
  });

  it('nenhum nome repetido — nome repetido vira slug repetido, e slug é único no banco', () => {
    const nomes = eventos.map(e => e.nome);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('todo slug gerado é aceito pelo schema da API e é único', () => {
    const slugs = eventos.map(e => gerarSlug(e.nome, dados.ano));
    for (const slug of slugs) expect(slug, slug).toMatch(/^[a-z0-9-]{3,80}$/);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('toda data é real e cai dentro da temporada declarada', () => {
    for (const e of eventos) {
      const inicio = new Date(`${e.inicio}T12:00:00.000Z`);
      expect(Number.isNaN(inicio.getTime()), `${e.nome}: data inválida`).toBe(false);
      expect(inicio.getUTCFullYear(), `${e.nome}`).toBe(dados.ano);
      if (e.fim) {
        const fim = new Date(`${e.fim}T12:00:00.000Z`);
        expect(fim.getTime(), `${e.nome}: fim antes do início`).toBeGreaterThanOrEqual(inicio.getTime());
      }
    }
  });

  it('a data é meio-dia UTC, e não meia-noite — senão o dia vira no Brasil', () => {
    // 12/09 à meia-noite UTC é 11/09 às 21h em São Paulo. Ao meio-dia, todo
    // fuso brasileiro ainda está no mesmo dia.
    const formatar = (iso, fuso) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' })
      .format(new Date(`${iso}T12:00:00.000Z`));
    for (const fuso of ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco']) {
      expect(formatar('2026-09-12', fuso), fuso).toBe('12/09');
    }
  });

  it('toda UF informada existe, e cidade e UF andam juntas', () => {
    for (const e of eventos) {
      if (e.uf) expect(UFS, `${e.nome}: UF "${e.uf}"`).toContain(e.uf);
      // Cidade sem UF, ou UF sem cidade, é transcrição pela metade.
      expect(Boolean(e.cidade), `${e.nome}: cidade e UF precisam vir juntas`).toBe(Boolean(e.uf));
    }
  });

  it('cada evento passa no MESMO schema que a rota de criação usa', () => {
    for (const e of eventos) {
      const resultado = s.eventCreate.safeParse({
        organizationId: 'organizacao-de-teste',
        name: e.nome,
        slug: gerarSlug(e.nome, dados.ano),
        description: e.endereco || undefined,
        venue: e.local || undefined,
        city: e.cidade || undefined,
        state: e.uf || undefined,
        startDate: `${e.inicio}T12:00:00.000Z`,
        endDate: `${e.fim || e.inicio}T12:00:00.000Z`
      });
      expect(resultado.success, `${e.nome}: ${JSON.stringify(resultado.error?.issues?.[0])}`).toBe(true);
    }
  });

  it('o que o documento não informou continua vazio — nada foi inferido', () => {
    // Trava contra "completar" o calendário com suposição numa edição futura.
    // Se um destes ganhar cidade, que seja com a fonte atualizada e este
    // número corrigido de propósito.
    expect(eventos.filter(e => !e.cidade).map(e => e.n)).toEqual([22, 31, 33, 38, 41, 42, 43, 44, 45, 46]);
  });
});

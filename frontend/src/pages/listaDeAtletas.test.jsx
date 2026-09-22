import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// ADMINISTRAÇÃO → ATLETAS, a lista.
//
// O que esta suíte protege:
//
//   * O CPF NÃO APARECE NA LISTAGEM — nem inteiro, nem mascarado. Uma fila de
//     duzentos nomes com documento ao lado é um vazamento esperando um print,
//     e o operador que precisa do número tem o caminho auditado no perfil.
//
//   * O TERMO DE BUSCA NÃO ENTRA NA URL. Ele vai no corpo da consulta que o
//     cliente monta; em URL ficaria no histórico do navegador, no Referer e
//     no log de acesso — três lugares fora do alcance do RLS. Vale
//     especialmente porque o servidor ACEITA CPF como termo (igualdade exata,
//     e só para quem tem `search.sensitive`).
//
//   * O FILTRO DE ESTADO CHEGA AO SERVIDOR. Filtrar no cliente traria a lista
//     inteira para a máquina do operador só para esconder metade dela.
// ==========================================================================

const api = {
  athletes: { list: vi.fn() },
  affiliations: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ usuario: { id: 'u1', role: 'ADMIN' } }) }));

const { AdminAtletas } = await import('./adminAtletas');

const CPF_INTEIRO = '529.982.247-25';

const atleta = (sobrescreve = {}) => ({
  id: 'a1', fullName: 'Joana Pereira', stageName: 'Jô', hasPhoto: false,
  status: 'ACTIVE', affiliation: { id: 'f1', name: 'Federação Mato-grossense' },
  affiliationNumber: 'NPC-123',
  // O servidor pode mandar o campo — a LISTA é que não o desenha.
  cpf: CPF_INTEIRO, cpfMasked: '***.982.247-**',
  ...sobrescreve
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.athletes.list.mockReset();
  api.affiliations.list.mockReset();
  api.affiliations.list.mockResolvedValue({ items: [{ id: 'f1', name: 'Federação Mato-grossense' }] });
  api.athletes.list.mockResolvedValue({ items: [atleta()], nextCursor: null });
});
afterEach(cleanup);

const abrir = async () => {
  render(<AdminAtletas navegar={vi.fn()} />);
  await screen.findByText('Joana Pereira');
};

describe('a listagem não exibe documento', () => {
  it('nem o CPF inteiro, nem o mascarado', async () => {
    await abrir();
    expect(document.body.textContent).not.toContain(CPF_INTEIRO);
    expect(document.body.textContent).not.toContain('***.982.247-**');
    expect(document.body.textContent).not.toContain('52998224725');
  });
});

describe('a busca vai para o servidor, e não para a URL', () => {
  it('o termo entra na consulta e o hash da página não muda', async () => {
    const hashAntes = window.location.hash;
    await abrir();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '529.982.247-25' } });

    await waitFor(
      () => expect(api.athletes.list).toHaveBeenCalledWith(expect.objectContaining({ search: '529.982.247-25' })),
      { timeout: 2000 }
    );
    expect(window.location.hash).toBe(hashAntes);
    expect(window.location.search).not.toContain('529');
  });
});

describe('os filtros chegam ao servidor', () => {
  it('o estado vira parâmetro da consulta, e não recorte no cliente', async () => {
    await abrir();
    const chamadasAntes = api.athletes.list.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Suspenso' }));

    await waitFor(() => expect(api.athletes.list.mock.calls.length).toBeGreaterThan(chamadasAntes));
    const ultima = api.athletes.list.mock.calls.at(-1)[0];
    expect(ultima.status).toBe('SUSPENDED');
  });

  it('"Todos" não manda estado nenhum — não manda string vazia', async () => {
    await abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Suspenso' }));
    await waitFor(() => expect(api.athletes.list.mock.calls.at(-1)[0].status).toBe('SUSPENDED'));

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(api.athletes.list.mock.calls.at(-1)[0].status).toBeUndefined());
  });

  it('a entidade de filiação também é filtro do servidor', async () => {
    await abrir();
    const seletor = await screen.findByLabelText(/Filtrar por entidade/i);
    fireEvent.change(seletor, { target: { value: 'f1' } });

    await waitFor(() => expect(api.athletes.list.mock.calls.at(-1)[0].affiliationId).toBe('f1'));
  });
});

describe('a lista leva ao perfil administrativo', () => {
  it('o botão navega para admin/atletas/:id, e não para a vitrine pública', async () => {
    const navegar = vi.fn();
    render(<AdminAtletas navegar={navegar} />);
    await screen.findByText('Joana Pereira');

    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(navegar).toHaveBeenCalledWith('admin/atletas/a1');
  });
});

describe('o estado do atleta é visível na lista', () => {
  it('cada linha carrega o selo do seu estado', async () => {
    api.athletes.list.mockResolvedValue({
      items: [atleta(), atleta({ id: 'a2', fullName: 'Marcos Lima', status: 'SUSPENDED' })],
      nextCursor: null
    });
    render(<AdminAtletas navegar={vi.fn()} />);
    await screen.findByText('Marcos Lima');

    // Cada rótulo aparece duas vezes: no chip do filtro e no selo da linha.
    expect(screen.getAllByText('Ativo').length).toBe(2);
    expect(screen.getAllByText('Suspenso').length).toBe(2);
    // E "Arquivado" só no chip: ninguém na lista está arquivado.
    expect(screen.getAllByText('Arquivado').length).toBe(1);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// Editar um campeonato já criado.
//
// `api.events.update` existia no cliente e NENHUMA tela o chamava: dava para
// criar a etapa e movê-la pela máquina de estados, mas não para corrigir o
// nome, a data ou o ginásio depois. Errou ao cadastrar, errado ficava.
//
// O que estes testes fixam, além de a tela existir:
//
//  - o formulário abre PREENCHIDO com o que está no servidor (um editor que
//    abre vazio apaga os campos que o operador não tocar);
//  - a data ISO que a API devolve vira YYYY-MM-DD, que é o único formato que
//    `<input type="date">` aceita — com o ISO completo o campo abre em branco
//    e a data se perde no primeiro salvamento;
//  - slug, organização e ESTADO do evento não aparecem como campo editável.
//    Estado só muda pela rota auditada de transição; virar campo comum de
//    formulário contornaria a máquina de estados.
// ==========================================================================

const espioes = vi.hoisted(() => ({ update: null, seasons: null }));

vi.mock('../services/api', () => {
  const update = vi.fn(() => Promise.resolve({ id: 'ev1' }));
  const seasons = vi.fn(() => Promise.resolve({ items: [{ id: 't1', name: 'Temporada', year: 2026 }] }));
  espioes.update = update;
  espioes.seasons = seasons;
  return {
    default: { events: { update }, ranking: { seasons } },
    refreshData: vi.fn()
  };
});

const EVENTO = {
  id: 'ev1',
  name: 'Etapa Ipiranga',
  slug: 'etapa-ipiranga-2026',
  status: 'PLANNED',
  organizationId: 'org1',
  description: 'Etapa oficial',
  startDate: '2026-09-12T12:00:00.000Z',
  endDate: '2026-09-13T12:00:00.000Z',
  venue: 'Ginásio Central',
  city: 'Cuiabá',
  state: 'MT',
  season: { id: 't1', name: 'Temporada', year: 2026 }
};

const { EditarEvento } = await import('./adminEvent');

const abrir = (props = {}) => render(
  <EditarEvento evento={EVENTO} notificar={() => {}} onClose={() => {}} onSalvo={() => {}} {...props} />
);

afterEach(() => { cleanup(); espioes.update.mockClear(); espioes.seasons.mockClear(); });

describe('editor de campeonato', () => {
  it('abre preenchido com o que veio do servidor', async () => {
    abrir();
    await waitFor(() => expect(screen.getByLabelText(/Nome/i).value).toBe('Etapa Ipiranga'));
    expect(screen.getByLabelText(/Cidade/i).value).toBe('Cuiabá');
    expect(screen.getByLabelText(/^UF/i).value).toBe('MT');
    expect(screen.getByLabelText(/Local/i).value).toBe('Ginásio Central');
  });

  it('converte a data ISO da API para o formato que o campo de data aceita', async () => {
    abrir();
    // Com o ISO completo ('2026-09-12T12:00:00.000Z') o navegador rejeita o
    // valor e o campo abre VAZIO — o salvamento seguinte apagaria a data.
    await waitFor(() => expect(screen.getByLabelText(/Início/i).value).toBe('2026-09-12'));
    expect(screen.getByLabelText(/Término/i).value).toBe('2026-09-13');
  });

  it('envia só os campos editáveis — nunca slug, organização ou status', async () => {
    abrir();
    const nome = await screen.findByLabelText(/Nome/i);
    await userEvent.clear(nome);
    await userEvent.type(nome, 'Etapa Ipiranga — corrigida');
    await userEvent.click(screen.getByRole('button', { name: /Salvar alterações/i }));

    await waitFor(() => expect(espioes.update).toHaveBeenCalledTimes(1));
    const [id, corpo] = espioes.update.mock.calls[0];
    expect(id).toBe('ev1');
    expect(corpo.name).toBe('Etapa Ipiranga — corrigida');
    expect(corpo).not.toHaveProperty('slug');
    expect(corpo).not.toHaveProperty('organizationId');
    expect(corpo).not.toHaveProperty('status');
  });

  it('não oferece controle de estado do evento dentro do editor', async () => {
    abrir();
    await screen.findByLabelText(/Nome/i);

    // Procura o CONTROLE, não a palavra: a descrição do modal fala em estado
    // justamente para dizer que ele não muda ali, e um teste que buscasse
    // texto acusaria a própria explicação.
    expect(screen.queryByLabelText(/Situação|Estado|Status/i)).toBeNull();
    expect(screen.queryByLabelText(/Endereço na URL|Slug/i)).toBeNull();
    expect(screen.queryByLabelText(/Federação|Organiza/i)).toBeNull();

    const opcoes = [...document.querySelectorAll('option')].map(o => o.value);
    expect(opcoes).not.toContain('REGISTRATIONS_OPEN');
    expect(opcoes).not.toContain('RESULTS_PUBLISHED');
  });

  // O que esta verificação PEGA está dito com precisão de propósito: o botão
  // fica `disabled` enquanto o PATCH está em voo, e é isso que impede o
  // segundo clique. O `if (salvando) return` dentro de `salvar` é uma segunda
  // camada, redundante por este caminho — removê-lo NÃO derruba este teste, o
  // que foi confirmado por mutação. Não afirmo aqui cobrir aquela linha.
  it('enquanto o PATCH está em voo o botão fica desabilitado — dois cliques não viram dois PATCH', async () => {
    let liberar;
    espioes.update.mockImplementationOnce(() => new Promise(resolve => { liberar = () => resolve({ id: 'ev1' }); }));
    abrir();

    const botao = await screen.findByRole('button', { name: /Salvar alterações/i });
    await userEvent.click(botao);

    await waitFor(() => expect(botao.disabled).toBe(true));
    await userEvent.click(botao);

    expect(espioes.update).toHaveBeenCalledTimes(1);
    liberar();
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// MESSENGER — a identidade do módulo é CONFIABILIDADE.
//
// O que uma tela de mensagem não pode fazer é perder o que a pessoa escreveu.
// Um toast que some não serve para um erro que exige decisão: o texto precisa
// continuar no campo, a razão precisa ficar à vista, e o caminho de volta
// precisa estar ao lado.
// ==========================================================================

const api = {
  messenger: { conversation: vi.fn(), messages: vi.fn(), send: vi.fn(), sendMedia: vi.fn(), markRead: vi.fn() }
};
vi.mock('../services/api', () => ({
  default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn()
}));

const { Conversa } = await import('./messengerPage');

beforeEach(() => {
  window.matchMedia = c => ({ matches: false, media: c, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  api.messenger.conversation.mockResolvedValue({ id: 'c1', kind: 'DIRECT', title: 'Ana Prado', participants: [], members: [] });
  api.messenger.messages.mockResolvedValue({ items: [{ id: 'm1', body: 'Oi', isMine: false, deleted: false, sender: { displayName: 'Ana Prado' }, createdAt: new Date().toISOString() }] });
  api.messenger.markRead.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const montar = () => render(
  <Conversa conversationId="c1" notificar={() => {}} onMudou={() => {}} navegar={() => {}} onVoltar={() => {}} />
);

async function escrever(texto) {
  montar();
  const campo = await screen.findByRole('textbox');
  fireEvent.change(campo, { target: { value: texto } });
  return campo;
}

describe('enviar mensagem', () => {
  it('em caso de falha, o texto NÃO é perdido', async () => {
    api.messenger.send.mockRejectedValue(new Error('Sem conexão'));
    const campo = await escrever('Три parágrafos de texto importante');
    fireEvent.click(screen.getByRole('button', { name: /Enviar mensagem/i }));
    await waitFor(() => expect(api.messenger.send).toHaveBeenCalled());
    // O que a pessoa escreveu continua ali.
    expect(campo.value).toBe('Три parágrafos de texto importante');
  });

  it('a falha fica À VISTA, com o motivo e o caminho de volta', async () => {
    api.messenger.send.mockRejectedValue(new Error('Sem conexão'));
    await escrever('oi');
    fireEvent.click(screen.getByRole('button', { name: /Enviar mensagem/i }));
    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('Não foi possível enviar');
    expect(aviso.textContent).toContain('Sem conexão');
    expect(screen.getByRole('button', { name: /Tentar de novo/i })).toBeTruthy();
  });

  it('"Tentar de novo" reenvia a mesma mensagem', async () => {
    api.messenger.send.mockRejectedValueOnce(new Error('Sem conexão')).mockResolvedValueOnce({});
    await escrever('mensagem importante');
    fireEvent.click(screen.getByRole('button', { name: /Enviar mensagem/i }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/i }));
    await waitFor(() => expect(api.messenger.send).toHaveBeenCalledTimes(2));
    expect(api.messenger.send.mock.calls[1][1]).toEqual({ body: 'mensagem importante' });
  });

  it('envio bem-sucedido limpa o campo e some com o aviso', async () => {
    api.messenger.send.mockRejectedValueOnce(new Error('Sem conexão')).mockResolvedValue({});
    const campo = await escrever('oi');
    fireEvent.click(screen.getByRole('button', { name: /Enviar mensagem/i }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/i }));
    await waitFor(() => expect(campo.value).toBe(''));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('campo vazio não envia nada', async () => {
    montar();
    await screen.findByRole('textbox');
    const botao = screen.getByRole('button', { name: /Enviar mensagem/i });
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    expect(api.messenger.send).not.toHaveBeenCalled();
  });

  it('dois cliques em "Tentar de novo" mandam UMA mensagem', async () => {
    // Este é o caminho que importa: o botão de enviar fica `disabled` durante
    // o envio, mas "Tentar de novo" NÃO — é a trava dentro do handler que
    // segura o segundo clique. Descoberto por mutação: remover a trava não
    // quebrava nada, porque o teste só exercitava o botão desabilitado.
    let liberar;
    api.messenger.send
      .mockRejectedValueOnce(new Error('Sem conexão'))
      .mockReturnValueOnce(new Promise(r => { liberar = r; }));
    await escrever('mensagem importante');
    fireEvent.click(screen.getByRole('button', { name: /^Enviar mensagem$/i }));
    await screen.findByRole('alert');

    const tentar = screen.getByRole('button', { name: /Tentar de novo/i });
    fireEvent.click(tentar);
    fireEvent.click(tentar);
    fireEvent.click(tentar);
    expect(api.messenger.send).toHaveBeenCalledTimes(2);
    liberar({});
  });

  it('dois cliques seguidos mandam UMA mensagem', async () => {
    let liberar;
    api.messenger.send.mockReturnValue(new Promise(r => { liberar = r; }));
    await escrever('oi');
    const botao = screen.getByRole('button', { name: /^Enviar mensagem$|^Enviando mensagem$/i });
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(api.messenger.send).toHaveBeenCalledTimes(1);
    liberar({});
  });
});

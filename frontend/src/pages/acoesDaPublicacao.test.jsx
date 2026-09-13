import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ==========================================================================
// Os botões de ação da publicação são ícone + contagem, sem texto.
//
// Sem aria-label, o nome acessível de cada um é literalmente o número: um
// leitor de tela anuncia "0, botão", quatro vezes seguidas, e a pessoa não
// tem como saber qual curte, qual comenta, qual compartilha e qual salva.
//
// Medido no navegador, antes da correção, os quatro vinham com aria-label
// nulo e innerText "0". Não dava erro nenhum, não aparecia em inspeção
// visual, e passava por qualquer varredura que só procure "botão sem texto"
// — porque texto eles têm; o texto é que não significa nada.
// ==========================================================================

vi.mock('../services/api', () => ({
  default: { social: {} },
  fetchMediaObjectUrl: vi.fn(() => Promise.resolve('blob:teste')),
  releaseMediaObjectUrl: vi.fn()
}));

const { Post } = await import('./socialPages');

const publicacao = {
  id: 'p1',
  content: 'Treino de hoje',
  visibility: 'PUBLIC',
  createdAt: new Date().toISOString(),
  author: { id: 'a1', handle: 'atleta', displayName: 'Atleta', kind: 'ATHLETE', avatarKey: null },
  media: [],
  counts: { likes: 3, comments: 2, shares: 1, saves: 0 },
  likedByMe: false,
  savedByMe: false,
  canDelete: false
};

const montar = extra => render(
  <Post post={{ ...publicacao, ...extra }} notificar={() => {}} onMudou={() => {}} navegar={() => {}} />
);

afterEach(cleanup);

describe('nome acessível dos botões de ação', () => {
  it('cada ação diz o que faz, e não só a contagem', () => {
    montar();
    expect(screen.getByRole('button', { name: /Curtir publicação \(3\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Abrir comentários \(2\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Compartilhar publicação \(1\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Salvar publicação \(0\)/ })).toBeTruthy();
  });

  it('nenhum botão da barra de ações se chama apenas por um número', () => {
    const { container } = montar();
    const acoes = [...container.querySelectorAll('.post-action')];
    expect(acoes.length).toBe(4);
    const soNumero = acoes.filter(b => /^\d+$/.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    expect(soNumero.map(b => b.textContent.trim())).toEqual([]);
  });

  it('o rótulo acompanha o estado: curtido vira Descurtir, salvo vira Remover dos salvos', () => {
    montar({ likedByMe: true, savedByMe: true });
    expect(screen.getByRole('button', { name: /Descurtir publicação/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remover publicação dos salvos/ })).toBeTruthy();
  });

  it('o que alterna é anunciado como alternável, e o de comentários como expansível', () => {
    const { container } = montar({ likedByMe: true });
    const acoes = [...container.querySelectorAll('.post-action')];
    expect(acoes[0].getAttribute('aria-pressed')).toBe('true');
    expect(acoes[1].getAttribute('aria-expanded')).toBe('false');
    expect(acoes[3].getAttribute('aria-pressed')).toBe('false');
  });
});

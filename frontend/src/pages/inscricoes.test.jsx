import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// INSCRIÇÕES — a identidade do módulo é ORGANIZAÇÃO.
//
// O que esta tela precisa transmitir não é festa: é que o operador sabe
// exatamente o que está vendo. Por isso os testes aqui olham para três coisas
// que mentem com facilidade:
//
//  - o estado da inscrição escrito em enum técnico;
//  - uma lista cortada que não diz que foi cortada;
//  - um filtro ativo que não se anuncia, fazendo a lista parecer curta.
// ==========================================================================

const api = {
  events: { list: vi.fn(), findOne: vi.fn() },
  registrations: { listByEvent: vi.fn(), create: vi.fn(), cancel: vi.fn() },
  affiliations: { list: vi.fn() },
  athletes: { lookup: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminInscricoes } = await import('./adminEvent');
const { PalcoDaExperiencia } = await import('../components/experiencia');

function aparelho({ movimentoReduzido = false } = {}) {
  window.matchMedia = consulta => ({
    matches: consulta.includes('prefers-reduced-motion') ? movimentoReduzido : false,
    media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
}

const EVENTO = { id: 'e1', name: 'Muscle Contest Curitiba', status: 'IN_OPERATION', organizationId: 'org1' };
const INSCRICAO = (extra = {}) => ({
  id: 'r1',
  status: 'CONFIRMED',
  athlete: { id: 'at1', fullName: 'Carlos Mendes', cpf: '123.***.***-00', affiliation: null },
  affiliation: { code: 'MCI-PR' },
  items: [{ id: 'ri1', competitionClass: { id: 'c1', name: 'Até 172cm', division: { category: { name: 'Men’s Physique' } } } }],
  checkIn: null,
  ...extra
});

beforeEach(() => {
  aparelho();
  api.events.list.mockResolvedValue({ items: [EVENTO] });
  api.events.findOne.mockResolvedValue(EVENTO);
  api.affiliations.list.mockResolvedValue({ items: [] });
  api.registrations.listByEvent.mockResolvedValue({ items: [INSCRICAO()], nextCursor: null });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function abrir() {
  render(<><AdminInscricoes notificar={() => {}} /><PalcoDaExperiencia /></>);
  const seletor = await screen.findByLabelText('Selecionar evento');
  await waitFor(() => expect(seletor.querySelector('option[value="e1"]')).toBeTruthy());
  await act(async () => { fireEvent.change(seletor, { target: { value: 'e1' } }); });
}

describe('o operador lê português, não enum', () => {
  it('a situação da inscrição aparece traduzida', async () => {
    await abrir();
    expect(await screen.findByText('Confirmada')).toBeTruthy();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
  });

  it('cada estado tem seu nome', async () => {
    for (const [codigo, rotulo] of [['PENDING', 'Pendente'], ['CANCELLED', 'Cancelada'], ['REJECTED', 'Recusada']]) {
      cleanup();
      // Check-in FEITO de propósito: a coluna de check-in também usa a palavra
      // "Pendente", e com ela na tela o teste não saberia qual das duas achou.
      api.registrations.listByEvent.mockResolvedValue({
        items: [INSCRICAO({ status: codigo, checkIn: { status: 'CHECKED_IN' } })], nextCursor: null
      });
      await abrir();
      expect(await screen.findByText(rotulo)).toBeTruthy();
      expect(screen.queryByText(codigo)).toBeNull();
    }
  });

  it('estado desconhecido mostra o código em vez de sumir com a informação', async () => {
    api.registrations.listByEvent.mockResolvedValue({ items: [INSCRICAO({ status: 'ESTADO_NOVO' })], nextCursor: null });
    await abrir();
    expect(await screen.findByText('ESTADO_NOVO')).toBeTruthy();
  });
});

describe('a lista nunca corta em silêncio', () => {
  it('com mais registros adiante, avisa E oferece a página seguinte', async () => {
    api.registrations.listByEvent.mockResolvedValue({
      items: Array.from({ length: 100 }, (_, i) => INSCRICAO({ id: `r${i}`, athlete: { id: `a${i}`, fullName: `Atleta ${i}`, cpf: null, affiliation: null } })),
      nextCursor: 'r99'
    });
    await abrir();
    expect(await screen.findByText(/Mostrando as primeiras 100 inscrições/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Carregar mais/i })).toBeTruthy();
  });

  it('sem mais registros, nenhum aviso', async () => {
    await abrir();
    await screen.findByText('Carlos Mendes');
    expect(screen.queryByText(/Mostrando as primeiras/i)).toBeNull();
  });
});

describe('o filtro se declara', () => {
  it('buscar mostra o que está filtrado e quantos sobraram', async () => {
    await abrir();
    await screen.findByText('Carlos Mendes');
    fireEvent.change(screen.getByLabelText('Buscar inscrito'), { target: { value: 'Carlos' } });
    expect(await screen.findByText(/Filtrando por/i)).toBeTruthy();
    expect(screen.getByText(/1 resultado/i)).toBeTruthy();
  });

  it('limpar o filtro é um clique', async () => {
    await abrir();
    await screen.findByText('Carlos Mendes');
    fireEvent.change(screen.getByLabelText('Buscar inscrito'), { target: { value: 'Carlos' } });
    await screen.findByText(/Filtrando por/i);
    fireEvent.click(screen.getByRole('button', { name: /Limpar filtro/i }));
    await waitFor(() => expect(screen.queryByText(/Filtrando por/i)).toBeNull());
  });

  it('lista vazia COM filtro diz que é o filtro, não que não há inscrição', async () => {
    await abrir();
    await screen.findByText('Carlos Mendes');
    api.registrations.listByEvent.mockResolvedValue({ items: [], nextCursor: null });
    fireEvent.change(screen.getByLabelText('Buscar inscrito'), { target: { value: 'Zzz' } });
    // A diferença importa: "não há inscrição" faria o operador achar que o
    // evento está vazio quando ele só digitou um nome errado.
    expect(await screen.findByText(/Nada encontrado/i)).toBeTruthy();
    expect(screen.queryByText(/Use “Nova inscrição” para registrar o primeiro/i)).toBeNull();
  });
});

describe('o que a tela de inscrições celebra', () => {
  it('cancelar NÃO comemora — o atleta acabou de sair da competição', async () => {
    api.registrations.cancel.mockResolvedValue({});
    await abrir();
    fireEvent.click(await screen.findByRole('button', { name: /^Cancelar$/i }));
    fireEvent.change(await screen.findByLabelText(/Motivo/i), { target: { value: 'Desistência do atleta' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancelar inscrição/i }));
    await waitFor(() => expect(api.registrations.cancel).toHaveBeenCalled());
    expect(document.querySelector('.impacto')).toBeNull();
    expect(document.querySelector('.campeao')).toBeNull();
  });

  it('inscrever confirma sem tomar o centro da tela', async () => {
    api.registrations.create.mockResolvedValue({ id: 'r2', athleteRecognized: true });
    api.athletes.lookup.mockResolvedValue({ found: true, athlete: { id: 'at9', fullName: 'Ana Prado', sex: 'FEMALE', affiliation: null } });
    await abrir();
    await screen.findByText('Carlos Mendes');
    // Numa abertura de inscrições isto se repete o dia inteiro.
    expect(document.querySelector('.impacto')).toBeNull();
    expect(document.querySelector('.campeao')).toBeNull();
  });
});

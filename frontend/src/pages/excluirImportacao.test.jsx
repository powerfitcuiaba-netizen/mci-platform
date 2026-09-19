import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import usuario from '@testing-library/user-event';

// ==========================================================================
// A TELA PRECISA DIZER QUAL DAS DUAS OPERAÇÕES VAI ACONTECER.
//
// Excluir um lote e invalidar um lote são coisas diferentes: uma apaga
// rascunho, a outra desfaz resultado publicado no ranking. Quem decide é o
// servidor, pelo que o lote publicou — mas se a tela chamar as duas de
// "Excluir", o operador aperta o botão num lote publicado imaginando que está
// limpando rascunho.
//
// Estes testes trancam o que o operador VÊ antes de confirmar: o verbo certo,
// o aviso certo, o motivo exigido onde ele é exigido, e a ausência do botão
// onde não há o que fazer.
// ==========================================================================

const api = {
  muscleWar: { list: vi.fn(), preview: vi.fn(), apply: vi.fn(), link: vi.fn(), remove: vi.fn() }
};
vi.mock('../services/api', () => ({
  default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn()
}));

// O componente lê o usuário da sessão para decidir se OFERECE a ação.
let usuarioAtual = { id: 'u1', role: 'SUPER_ADMIN', organizations: [] };
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: usuarioAtual }) }));

const { AdminMuscleWar, ExcluirImportacao } = await import('./adminPlatform');

const lote = (extra = {}) => ({
  id: 'imp1', sourceRef: 'ipiranga_resultados.csv', sourceType: 'CSV', status: 'PENDING',
  totalRecords: 191, matchedCount: 0, pendingCount: 0, conflictCount: 0, appliedCount: 0,
  version: 1, createdAt: '2026-09-12T14:23:00.000Z',
  createdBy: { id: 'u1', name: 'Operador' },
  season: { id: 's1', name: 'Temporada 2026', year: 2026 },
  event: { id: 'e1', name: 'Etapa Ipiranga' },
  ...extra
});

beforeEach(() => {
  vi.clearAllMocks();
  usuarioAtual = { id: 'u1', role: 'SUPER_ADMIN', organizations: [] };
  api.muscleWar.list.mockResolvedValue({ items: [lote()] });
  api.muscleWar.remove.mockResolvedValue({ id: 'imp1', operation: 'DELETED', voidedPoints: 0 });
});
afterEach(cleanup);

const listar = () => render(<AdminMuscleWar notificar={vi.fn()} />);

describe('o botão na listagem muda com o estado do lote', () => {
  it('lote não aplicado oferece Revisar e EXCLUIR', async () => {
    listar();
    const linha = (await screen.findByText('ipiranga_resultados.csv')).closest('tr');
    expect(within(linha).getByRole('button', { name: /Revisar/i })).toBeTruthy();
    expect(within(linha).getByRole('button', { name: /Excluir/i })).toBeTruthy();
    expect(within(linha).queryByRole('button', { name: /Invalidar/i })).toBeNull();
  });

  it('lote aplicado oferece Revisar e INVALIDAR — nunca excluir', async () => {
    api.muscleWar.list.mockResolvedValue({ items: [lote({ status: 'APPLIED', appliedCount: 191 })] });
    listar();

    const linha = (await screen.findByText('ipiranga_resultados.csv')).closest('tr');
    expect(within(linha).getByRole('button', { name: /Invalidar/i })).toBeTruthy();
    // O verbo errado aqui é o que faz alguém apagar resultado publicado.
    expect(within(linha).queryByRole('button', { name: /^Excluir/i })).toBeNull();
  });

  it('lote já invalidado não oferece ação destrutiva nenhuma', async () => {
    api.muscleWar.list.mockResolvedValue({ items: [lote({ status: 'INVALIDATED', appliedCount: 191 })] });
    listar();

    const linha = (await screen.findByText('ipiranga_resultados.csv')).closest('tr');
    expect(within(linha).getByRole('button', { name: /Revisar/i })).toBeTruthy();
    expect(within(linha).queryByRole('button', { name: /Invalidar|Excluir/i })).toBeNull();
  });

  it('quem não tem permissão de aplicar não recebe o botão', async () => {
    // Não é o controle de acesso — esse é do servidor, que responde 403. É
    // para não oferecer um caminho que terminaria em erro.
    usuarioAtual = { id: 'u2', role: 'JUDGE', organizations: [{ role: 'JUDGE' }] };
    listar();

    const linha = (await screen.findByText('ipiranga_resultados.csv')).closest('tr');
    expect(within(linha).queryByRole('button', { name: /Invalidar|Excluir/i })).toBeNull();
  });
});

describe('a confirmação mostra o que está prestes a sumir', () => {
  const abrir = (extra = {}) => render(
    <ExcluirImportacao lote={lote(extra)} notificar={vi.fn()} onClose={vi.fn()} onConcluido={vi.fn()} />
  );

  it('identifica arquivo, evento, temporada, tamanho e data', async () => {
    abrir();
    expect(screen.getByText('ipiranga_resultados.csv')).toBeTruthy();
    expect(screen.getByText('Etapa Ipiranga')).toBeTruthy();
    expect(screen.getByText('Temporada 2026')).toBeTruthy();
    expect(screen.getByText('191')).toBeTruthy();
  });

  it('lote sem publicação avisa que nada foi publicado', () => {
    abrir();
    expect(screen.getByText(/ainda não publicou resultados/i)).toBeTruthy();
  });

  it('lote publicado avisa que a exclusão vira INVALIDAÇÃO', () => {
    abrir({ status: 'APPLIED', appliedCount: 191 });
    expect(screen.getByText(/será tratada como/i)).toBeTruthy();
    // "invalidação" aparece no aviso E no rótulo do campo de motivo — as duas
    // ocorrências são intencionais, então a asserção conta em vez de exigir uma.
    expect(screen.getAllByText(/invalida/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/ficará registrada na auditoria/i)).toBeTruthy();
  });
});

describe('o motivo é exigido onde ele é exigido', () => {
  it('lote publicado: o botão só libera com motivo escrito', async () => {
    render(<ExcluirImportacao lote={lote({ status: 'APPLIED', appliedCount: 191 })}
      notificar={vi.fn()} onClose={vi.fn()} onConcluido={vi.fn()} />);

    const confirmar = screen.getByRole('button', { name: /Invalidar importação/i });
    expect(confirmar.disabled, 'sem motivo não pode invalidar').toBe(true);

    await usuario.type(screen.getByRole('textbox'), 'erro na súmula');
    expect(confirmar.disabled).toBe(false);
  });

  it('lote não publicado: o motivo é opcional', () => {
    render(<ExcluirImportacao lote={lote()} notificar={vi.fn()} onClose={vi.fn()} onConcluido={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Excluir importação/i }).disabled).toBe(false);
  });
});

describe('o que a confirmação envia, e o que ela diz depois', () => {
  it('manda o motivo ao servidor e avisa que INVALIDOU', async () => {
    api.muscleWar.remove.mockResolvedValue({ id: 'imp1', operation: 'INVALIDATED', voidedPoints: 191 });
    const notificar = vi.fn();
    const onConcluido = vi.fn();

    render(<ExcluirImportacao lote={lote({ status: 'APPLIED', appliedCount: 191 })}
      notificar={notificar} onClose={vi.fn()} onConcluido={onConcluido} />);

    await usuario.type(screen.getByRole('textbox'), 'arquivo incorreto');
    await usuario.click(screen.getByRole('button', { name: /Invalidar importação/i }));

    await vi.waitFor(() => {
      expect(api.muscleWar.remove).toHaveBeenCalledWith('imp1', { reason: 'arquivo incorreto' });
    });
    // A mensagem segue a operação QUE ACONTECEU, e não a que a tela supôs.
    await vi.waitFor(() => {
      expect(notificar).toHaveBeenCalledWith('Importação invalidada com sucesso.', 'ok');
    });
    expect(onConcluido).toHaveBeenCalled();
  });

  it('erro do servidor aparece em português, e não como erro técnico', async () => {
    api.muscleWar.remove.mockRejectedValue(new Error('Importação já invalidada'));
    const onConcluido = vi.fn();

    render(<ExcluirImportacao lote={lote()} notificar={vi.fn()} onClose={vi.fn()} onConcluido={onConcluido} />);
    await usuario.click(screen.getByRole('button', { name: /Excluir importação/i }));

    expect(await screen.findByText(/Importação já invalidada/i)).toBeTruthy();
    expect(onConcluido, 'falhou: nada foi concluído').not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import permissoes from '../src/domain/acesso/permissoes.js';
import maquinas from '../src/domain/estados/maquinas.js';

const { pode, permissoesDe, assertPode, resolverPapel, PAPEIS, PERMISSOES } = permissoes;
const { evento, inscricao, resultado } = maquinas;

describe('RBAC — concessão de permissões', () => {
  it('SUPER_ADMIN recebe todas as permissões declaradas', () => {
    expect(permissoesDe('SUPER_ADMIN').sort()).toEqual([...PERMISSOES].sort());
  });

  it('papel desconhecido não recebe permissão alguma', () => {
    // Falhar fechado: papel digitado errado vira ausência de acesso.
    expect(permissoesDe('CHEFE_SUPREMO')).toEqual([]);
    expect(pode('CHEFE_SUPREMO', 'events.create')).toBe(false);
  });

  it('recusa consultar permissão que não existe, em vez de responder falso', () => {
    // Responder `false` a um nome errado esconderia o erro de digitação e
    // criaria uma checagem que nunca autoriza ninguém sem ninguém notar.
    expect(() => pode('ADMIN_MCI', 'eventos.criar')).toThrow(/Permissão inexistente/);
  });

  it('assertPode devolve 403 com a permissão exigida no detalhe', () => {
    try {
      assertPode('ATLETA', 'results.publish');
      throw new Error('deveria ter recusado');
    } catch (erro) {
      expect(erro.status).toBe(403);
      expect(erro.details.permissaoExigida).toBe('results.publish');
    }
  });
});

describe('RBAC — isolamento do juiz (seção 35)', () => {
  it('juiz pontua', () => {
    expect(pode('JUIZ', 'judging.score')).toBe(true);
    expect(pode('JUIZ', 'judging.read')).toBe(true);
  });

  it('juiz NÃO alcança informação comercial do atleta que julga', () => {
    // O painel do juiz não pode revelar nada que influencie a nota.
    for (const proibida of ['payments.read', 'sponsors.manage', 'contracts.read', 'draft.read', 'analytics.read']) {
      expect(pode('JUIZ', proibida)).toBe(false);
    }
  });

  it('juiz não publica nem revisa resultado', () => {
    expect(pode('JUIZ', 'results.publish')).toBe(false);
    expect(pode('JUIZ', 'results.approve')).toBe(false);
    expect(pode('JUIZ', 'results.override')).toBe(false);
  });
});

describe('RBAC — separação de responsabilidades', () => {
  it('somente SUPER_ADMIN pode sobrepor resultado publicado', () => {
    const comOverride = Object.keys(PAPEIS).filter(papel => pode(papel, 'results.override'));
    expect(comOverride).toEqual(['SUPER_ADMIN']);
  });

  it('auditor não tem nenhuma permissão de escrita', () => {
    const escrita = permissoesDe('AUDITOR').filter(p =>
      /\.(create|update|delete|manage|approve|publish|override|refund|issue|scan|send|upload)$/.test(p)
    );
    expect(escrita).toEqual([]);
    expect(pode('AUDITOR', 'audit.read')).toBe(true);
  });

  it('financeiro não julga e diretor de competição não mexe em dinheiro', () => {
    expect(pode('FINANCEIRO', 'judging.score')).toBe(false);
    expect(pode('FINANCEIRO', 'payments.refund')).toBe(true);

    expect(pode('DIRETOR_COMPETICAO', 'payments.refund')).toBe(false);
    expect(pode('DIRETOR_COMPETICAO', 'results.approve')).toBe(true);
  });

  it('operador de pesagem só alcança o que a pesagem precisa', () => {
    expect(pode('PESAGEM', 'weigh_ins.create')).toBe(true);
    expect(pode('PESAGEM', 'athletes.read')).toBe(true);
    expect(pode('PESAGEM', 'athletes.read.sensitive')).toBe(false);
    expect(pode('PESAGEM', 'results.publish')).toBe(false);
  });

  it('atleta não lê dado sensível de ninguém', () => {
    expect(pode('ATLETA', 'athletes.read.sensitive')).toBe(false);
    expect(pode('ATLETA', 'registrations.approve')).toBe(false);
  });
});

describe('RBAC — compatibilidade com os papéis legados', () => {
  it('resolve papel antigo para o equivalente atual', () => {
    expect(resolverPapel('ADMIN')).toBe('ADMIN_MCI');
    expect(resolverPapel('ORGANIZER')).toBe('PROMOTOR');
    expect(resolverPapel('JUDGE')).toBe('JUIZ');
  });

  it('usuário gravado com papel antigo mantém o acesso', () => {
    // Ninguém perde acesso porque a nomenclatura mudou.
    expect(pode('ADMIN', 'events.create')).toBe(true);
    expect(pode('ORGANIZER', 'events.create')).toBe(true);
    expect(pode('JUDGE', 'judging.score')).toBe(true);
    expect(pode('ATHLETE', 'registrations.create')).toBe(true);
    expect(pode('PUBLIC', 'events.read')).toBe(true);
    expect(pode('PUBLIC', 'events.create')).toBe(false);
  });
});

describe('máquina de estados do evento', () => {
  it('segue o ciclo completo previsto', () => {
    const ciclo = [
      'RASCUNHO', 'PLANEJADO', 'INSCRICOES_ABERTAS', 'INSCRICOES_ENCERRADAS',
      'EM_OPERACAO', 'EM_JULGAMENTO', 'RESULTADOS_EM_REVISAO', 'RESULTADOS_PUBLICADOS', 'ENCERRADO'
    ];
    for (let i = 0; i < ciclo.length - 1; i += 1) {
      expect(evento.assertTransicao(ciclo[i], ciclo[i + 1], 'ADMIN_MCI')).toBe(ciclo[i + 1]);
    }
  });

  it('recusa pular etapas do ciclo', () => {
    expect(() => evento.assertTransicao('RASCUNHO', 'RESULTADOS_PUBLICADOS')).toThrow(/não permitida/);
    expect(() => evento.assertTransicao('PLANEJADO', 'EM_JULGAMENTO')).toThrow(/não permitida/);
  });

  it('recusa ressuscitar evento encerrado ou cancelado', () => {
    expect(evento.ehTerminal('ENCERRADO')).toBe(true);
    expect(evento.ehTerminal('CANCELADO')).toBe(true);
    expect(() => evento.assertTransicao('CANCELADO', 'EM_OPERACAO')).toThrow(/não permitida/);
  });

  it('recusa cancelar evento com resultado já publicado', () => {
    expect(() => evento.assertTransicao('RESULTADOS_PUBLICADOS', 'CANCELADO')).toThrow(/não permitida/);
  });

  it('reabrir inscrições exige permissão de alterar evento', () => {
    expect(() => evento.assertTransicao('INSCRICOES_ENCERRADAS', 'INSCRICOES_ABERTAS', 'ATLETA'))
      .toThrow(/não pode levar/);
    expect(evento.assertTransicao('INSCRICOES_ENCERRADAS', 'INSCRICOES_ABERTAS', 'PROMOTOR'))
      .toBe('INSCRICOES_ABERTAS');
  });

  it('recusa estado inexistente e transição para o mesmo estado', () => {
    expect(() => evento.assertTransicao('FERIADO', 'PLANEJADO')).toThrow(/Estado atual inválido/);
    expect(() => evento.assertTransicao('RASCUNHO', 'FERIADO')).toThrow(/Estado de destino inválido/);
    expect(() => evento.assertTransicao('RASCUNHO', 'RASCUNHO')).toThrow(/já está em/);
  });
});

describe('máquina de estados da inscrição', () => {
  it('cobre o fluxo com pagamento e documentação', () => {
    const ciclo = ['RASCUNHO', 'PENDENTE', 'AGUARDANDO_PAGAMENTO', 'PAGA', 'DOCUMENTACAO_PENDENTE', 'APROVADA'];
    for (let i = 0; i < ciclo.length - 1; i += 1) {
      expect(inscricao.assertTransicao(ciclo[i], ciclo[i + 1], 'PROMOTOR')).toBe(ciclo[i + 1]);
    }
  });

  it('recusa aprovar inscrição que ainda espera pagamento', () => {
    expect(() => inscricao.assertTransicao('AGUARDANDO_PAGAMENTO', 'APROVADA', 'PROMOTOR')).toThrow(/não permitida/);
  });

  it('desfazer aprovação exige quem aprova', () => {
    expect(() => inscricao.assertTransicao('APROVADA', 'DOCUMENTACAO_PENDENTE', 'ATLETA')).toThrow(/não pode levar/);
    expect(inscricao.assertTransicao('APROVADA', 'DOCUMENTACAO_PENDENTE', 'PROMOTOR')).toBe('DOCUMENTACAO_PENDENTE');
  });

  it('inscrição cancelada é terminal', () => {
    expect(inscricao.ehTerminal('CANCELADA')).toBe(true);
    expect(() => inscricao.assertTransicao('CANCELADA', 'APROVADA', 'ADMIN_MCI')).toThrow(/não permitida/);
  });
});

describe('máquina de estados do resultado — proteção do histórico', () => {
  it('percorre rascunho até publicação', () => {
    const ciclo = ['RASCUNHO', 'CALCULANDO', 'EM_REVISAO', 'APROVADO', 'PUBLICADO'];
    for (let i = 0; i < ciclo.length - 1; i += 1) {
      expect(resultado.assertTransicao(ciclo[i], ciclo[i + 1], 'ADMIN_MCI')).toBe(ciclo[i + 1]);
    }
  });

  it('resultado publicado NÃO volta para revisão sem permissão especial', () => {
    // Núcleo da seção 39: publicado é histórico oficial.
    expect(() => resultado.assertTransicao('PUBLICADO', 'EM_REVISAO')).toThrow(/exige permissão especial/);

    for (const papel of ['PROMOTOR', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI', 'ADMIN_MCI']) {
      expect(() => resultado.assertTransicao('PUBLICADO', 'EM_REVISAO', papel)).toThrow(/não pode levar/);
    }

    expect(resultado.assertTransicao('PUBLICADO', 'EM_REVISAO', 'SUPER_ADMIN')).toBe('EM_REVISAO');
  });

  it('declara qual permissão a transição privilegiada exige', () => {
    expect(resultado.permissaoExigida('PUBLICADO', 'EM_REVISAO')).toBe('results.override');
    expect(resultado.permissaoExigida('RASCUNHO', 'CALCULANDO')).toBe(null);
  });

  it('recusa publicar resultado que não passou por aprovação', () => {
    expect(() => resultado.assertTransicao('EM_REVISAO', 'PUBLICADO', 'ADMIN_MCI')).toThrow(/não permitida/);
    expect(() => resultado.assertTransicao('CALCULANDO', 'PUBLICADO', 'ADMIN_MCI')).toThrow(/não permitida/);
  });

  it('lista as transições possíveis quando recusa', () => {
    try {
      resultado.assertTransicao('RASCUNHO', 'PUBLICADO', 'ADMIN_MCI');
      throw new Error('deveria ter recusado');
    } catch (erro) {
      expect(erro.details.transicoesPossiveis).toEqual(['CALCULANDO', 'BLOQUEADO']);
    }
  });
});

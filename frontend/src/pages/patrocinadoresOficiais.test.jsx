import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ==========================================================================
// CONFIGURAÇÕES → PATROCINADORES OFICIAIS.
//
// A tela onde o campeonato administra a própria vitrine. O que este arquivo
// mede é o COMPORTAMENTO dela — o que ela envia para a API, o que ela esconde
// de quem não pode, e o que ela avisa antes de uma ação que tira marca do ar.
//
// A AUTORIZAÇÃO DE VERDADE NÃO ESTÁ AQUI, e o teste não finge que está: a
// conferência de permissão na tela é conveniência (o menu "Configurações" é
// liberado por `users.read`, que o diretor de evento tem). Quem decide é a
// API, e abaixo dela a política do banco — medidas em
// `tests/patrocinadores-oficiais.test.mjs`.
// ==========================================================================

const chamadas = vi.hoisted(() => ({}));
const estado = vi.hoisted(() => ({ items: [] }));

vi.mock('../services/api', () => {
  const officialSponsors = {
    list: vi.fn(() => Promise.resolve({ items: estado.items })),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
    changeLogo: vi.fn(() => Promise.resolve({})),
    remove: vi.fn(() => Promise.resolve({}))
  };
  chamadas.officialSponsors = officialSponsors;
  const api = { officialSponsors, publicApi: { sponsors: vi.fn(() => Promise.resolve({ items: [] })) } };
  return { default: api, api, urlDeMidiaPublica: caminho => `http://api.test${caminho}` };
});

const usuario = vi.hoisted(() => ({ atual: null }));
vi.mock('../AuthContext', () => ({ useAuth: () => ({ user: usuario.atual }) }));

const { default: PatrocinadoresOficiais } = await import('./patrocinadoresOficiais');

const SUPER_ADMIN = { id: 'u1', name: 'Diretoria', role: 'SUPER_ADMIN', status: 'ACTIVE', organizations: [] };
const DIRETOR = {
  id: 'u2', name: 'Diretor', role: 'ATHLETE', status: 'ACTIVE',
  organizations: [{ organizationId: 'org1', role: 'EVENT_DIRECTOR', name: 'Fed', slug: 'fed' }]
};

const patrocinador = (id, name, level, extra = {}) => ({
  id, code: id.toUpperCase(), name, level, sortOrder: 0, active: true,
  siteUrl: null, hasLogo: true, updatedAt: '2026-10-08T12:00:00.000Z', ...extra
});

const CATALOGO = [
  patrocinador('s1', 'Max Titanium', 'GLOBAL'),
  patrocinador('s2', 'Soldiers Nutrition', 'DIAMANTE'),
  patrocinador('s3', 'Black Skull', 'GOLD'),
  patrocinador('s4', 'Fora do Ar', 'GOLD', { active: false }),
  patrocinador('s5', 'Tan Masters', 'SILVER')
];

const notificar = vi.fn();

beforeEach(() => {
  usuario.atual = SUPER_ADMIN;
  estado.items = CATALOGO;
  notificar.mockClear();
  for (const fn of Object.values(chamadas.officialSponsors)) fn.mockClear();
  chamadas.officialSponsors.list.mockResolvedValue({ items: estado.items });
});
afterEach(cleanup);

const montar = async () => {
  const resultado = render(<PatrocinadoresOficiais notificar={notificar} />);
  await screen.findByText('Max Titanium');
  return resultado;
};

/**
 * O diálogo aberto.
 *
 * Os botões da linha e os do diálogo têm o MESMO rótulo de propósito —
 * "Desativar" na linha abre a confirmação, "Desativar" na confirmação executa.
 * Procurar no documento inteiro acharia os dois; a consulta precisa do escopo.
 */
const noDialogo = () => within(screen.getByRole('dialog'));

/**
 * O campo de arquivo, pelo elemento.
 *
 * `Field` envolve rótulo, controle e dica num `<label>` só, então o nome
 * acessível do campo é "Logo *PNG, JPG ou WebP…". Consultar por rótulo exato
 * aqui mediria a redação da dica, não o campo.
 */
const campoDeArquivo = () => screen.getByRole('dialog').querySelector('input[type="file"]');

describe('quem enxerga a tela', () => {
  it('1. o SUPER_ADMIN vê o catálogo', async () => {
    await montar();
    expect(screen.getByRole('button', { name: /Adicionar patrocinador/i })).toBeTruthy();
  });

  it('2. quem NÃO tem a permissão não vê catálogo nem botões', async () => {
    // O diretor de evento tem `sponsors.manage` — o patrocinador DA FEDERAÇÃO
    // dele — e chega a esta aba pelo menu. Sem esta conferência ele veria
    // botões que só responderiam 403.
    usuario.atual = DIRETOR;
    render(<PatrocinadoresOficiais notificar={notificar} />);
    expect(await screen.findByText(/Sem acesso a esta seção/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Adicionar patrocinador/i })).toBeNull();
    // E nem sequer pede o catálogo: a tela não bate numa porta que vai fechar.
    expect(chamadas.officialSponsors.list).not.toHaveBeenCalled();
  });
});

describe('o catálogo na tela', () => {
  it('3. agrupa por nível, na ordem da hierarquia', async () => {
    const { container } = await montar();
    const titulos = [...container.querySelectorAll('.panel-head h2')].map(h => h.textContent);
    expect(titulos).toEqual(['Global', 'Diamante', 'Gold', 'Silver — apoio e parceiros']);
  });

  it('4. "Silver — apoio e parceiros" é rótulo, não um quinto nível', async () => {
    const { container } = await montar();
    const titulos = [...container.querySelectorAll('.panel-head h2')].map(h => h.textContent);
    expect(titulos).toHaveLength(4);
    expect(titulos.join(' ')).not.toMatch(/\bApoio\b(?!.*parceiros)/);
  });

  it('5. mostra prévia, nome, identificador, ordem e situação', async () => {
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    expect(within(linha).getByAltText('Logo Max Titanium')).toBeTruthy();
    expect(linha.textContent).toMatch(/S1/);
    expect(linha.textContent).toMatch(/ordem 0/);
    expect(within(linha).getByText('Ativo')).toBeTruthy();
  });

  it('6. o INATIVO aparece no painel, marcado — é de lá que se reativa', async () => {
    await montar();
    const linha = screen.getByText('Fora do Ar').closest('.list-row');
    expect(within(linha).getByText('Inativo')).toBeTruthy();
    expect(linha.classList.contains('patro-inativo')).toBe(true);
    expect(within(linha).getByRole('button', { name: /Reativar/i })).toBeTruthy();
  });

  it('7. a prévia aponta para a rota de logo, por ID', async () => {
    await montar();
    expect(screen.getByAltText('Logo Max Titanium').getAttribute('src'))
      .toMatch(/\/media\/sponsors\/s1\/logo$/);
  });
});

describe('desativar e reativar', () => {
  it('8. desativar PERGUNTA antes, e explica o que acontece', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Desativar/i }));

    expect(await screen.findByText(/Desativar este patrocinador\?/i)).toBeTruthy();
    // A confirmação diz o que se perde E o que se preserva.
    expect(screen.getByText(/deixará de aparecer nas áreas públicas/i)).toBeTruthy();
    expect(screen.getByText(/permanecerá no catálogo/i)).toBeTruthy();
    // E nada foi enviado enquanto a pergunta está aberta.
    expect(chamadas.officialSponsors.update).not.toHaveBeenCalled();
  });

  it('9. confirmando, envia `active: false` com a versão de onde partiu', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Desativar/i }));
    await screen.findByRole('dialog');
    await pessoa.click(noDialogo().getByRole('button', { name: /^Desativar$/i }));

    await waitFor(() => expect(chamadas.officialSponsors.update).toHaveBeenCalledWith('s1', {
      active: false, updatedAt: '2026-10-08T12:00:00.000Z'
    }));
  });

  it('10. REATIVAR não pergunta: devolver marca ao ar não destrói nada', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Fora do Ar').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Reativar/i }));

    expect(screen.queryByText(/Desativar este patrocinador\?/i)).toBeNull();
    await waitFor(() => expect(chamadas.officialSponsors.update).toHaveBeenCalledWith('s4', {
      active: true, updatedAt: '2026-10-08T12:00:00.000Z'
    }));
  });
});

describe('adicionar', () => {
  it('11. o formulário exige nome, nível e LOGO', async () => {
    const pessoa = userEvent.setup();
    await montar();
    await pessoa.click(screen.getByRole('button', { name: /Adicionar patrocinador/i }));

    await screen.findByRole('dialog');
    expect(screen.getByLabelText(/Nome do patrocinador/i)).toBeRequired();
    expect(campoDeArquivo()).toBeRequired();
    expect(screen.getByLabelText(/Identificador/i)).toBeRequired();
  });

  it('12. o identificador é sugerido a partir do nome, e continua editável', async () => {
    const pessoa = userEvent.setup();
    await montar();
    await pessoa.click(screen.getByRole('button', { name: /Adicionar patrocinador/i }));
    await pessoa.type(await screen.findByLabelText(/Nome do patrocinador/i), 'Nutrição Café');

    // Acento sai, espaço vira hífen, tudo em caixa alta.
    expect(screen.getByLabelText(/Identificador/i)).toHaveValue('NUTRICAO-CAFE');
  });

  it('13. o nível oferece exatamente os quatro, e nenhum texto livre', async () => {
    const pessoa = userEvent.setup();
    await montar();
    await pessoa.click(screen.getByRole('button', { name: /Adicionar patrocinador/i }));

    await screen.findByRole('dialog');
    const select = noDialogo().getByRole('combobox');
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map(o => o.value)).toEqual(['GLOBAL', 'DIAMANTE', 'GOLD', 'SILVER']);
  });

  it('14. envia o arquivo junto dos campos, numa requisição só', async () => {
    // O ENVIO É DISPARADO PELO FORMULÁRIO, e não pelo clique no botão, por uma
    // limitação do jsdom: `userEvent.upload` preenche `files` mas NÃO `value`,
    // e a validação de `required` de um campo de arquivo olha `value`. O
    // formulário fica inválido só aqui — num navegador de verdade escolher o
    // arquivo preenche os dois, e o clique passa.
    //
    // Medido: `formValido=false`, com o campo de arquivo como único inválido,
    // tendo 1 arquivo carregado. O clique continua coberto em
    // `scripts/qa/patrocinadores-navegador.mjs`, que roda num Chromium real.
    const pessoa = userEvent.setup();
    await montar();
    await pessoa.click(screen.getByRole('button', { name: /Adicionar patrocinador/i }));

    await screen.findByRole('dialog');
    await pessoa.type(screen.getByLabelText(/Nome do patrocinador/i), 'Marca Nova');
    const arquivo = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' });
    await pessoa.upload(campoDeArquivo(), arquivo);

    fireEvent.submit(campoDeArquivo().form);

    await waitFor(() => expect(chamadas.officialSponsors.create).toHaveBeenCalled());
    const [enviado, campos] = chamadas.officialSponsors.create.mock.calls[0];
    expect(enviado).toBe(arquivo);
    expect(campos).toMatchObject({ name: 'Marca Nova', code: 'MARCA-NOVA', level: 'GOLD' });
  });

  it('15. o campo de arquivo aceita só PNG, JPG e WebP', async () => {
    const pessoa = userEvent.setup();
    await montar();
    await pessoa.click(screen.getByRole('button', { name: /Adicionar patrocinador/i }));
    await screen.findByRole('dialog');
    expect(campoDeArquivo().getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
  });
});

describe('editar', () => {
  it('16. o identificador NÃO é editável — ele amarra a linha à arte', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Editar/i }));

    await screen.findByText(/Editar Max Titanium/i);
    expect(screen.queryByLabelText(/Identificador/i)).toBeNull();
  });

  it('17. a logo atual aparece, e trocá-la é opcional', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Editar/i }));

    expect(await screen.findByAltText(/Logo atual de Max Titanium/i)).toBeTruthy();
    expect(campoDeArquivo()).not.toBeRequired();
  });

  it('18. salvar sem trocar a logo NÃO chama a rota de logo', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Editar/i }));

    const ordem = await screen.findByLabelText(/Ordem dentro do nível/i);
    await pessoa.clear(ordem);
    await pessoa.type(ordem, '3');
    await pessoa.click(noDialogo().getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(chamadas.officialSponsors.update).toHaveBeenCalled());
    expect(chamadas.officialSponsors.update.mock.calls[0][1]).toMatchObject({ sortOrder: 3 });
    expect(chamadas.officialSponsors.changeLogo).not.toHaveBeenCalled();
  });

  it('19. a edição manda a VERSÃO de onde partiu — é a guarda de concorrência', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Editar/i }));
    await screen.findByRole('dialog');
    await pessoa.click(noDialogo().getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(chamadas.officialSponsors.update).toHaveBeenCalled());
    expect(chamadas.officialSponsors.update.mock.calls[0][1].updatedAt).toBe('2026-10-08T12:00:00.000Z');
  });
});

describe('remover de vez', () => {
  it('20. exige motivo e avisa que a remoção é definitiva', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Remover/i }));

    expect(await screen.findByText(/Remover Max Titanium do catálogo\?/i)).toBeTruthy();
    // A tela aponta o caminho menos destrutivo antes de o destrutivo acontecer.
    expect(screen.getByText(/use Desativar/i)).toBeTruthy();
    expect(screen.getByLabelText(/Motivo/i)).toBeRequired();
  });

  it('21a. o campo de motivo aceita o texto INTEIRO — ele não perde o foco a cada tecla', async () => {
    // O `motivo` morava no estado da PÁGINA, e cada tecla re-renderizava o
    // diálogo; o `Modal` devolvia o foco à caixa e só a primeira letra entrava.
    // Medido assim, e corrigido movendo o estado para o próprio formulário.
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Remover/i }));

    await screen.findByRole('dialog');
    const campo = noDialogo().getByRole('textbox');
    await pessoa.type(campo, 'motivo com muitas letras');
    expect(campo).toHaveValue('motivo com muitas letras');
  });

  it('21. com o motivo preenchido, envia os dois', async () => {
    const pessoa = userEvent.setup();
    await montar();
    const linha = screen.getByText('Max Titanium').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Remover/i }));

    await screen.findByRole('dialog');
    await pessoa.type(noDialogo().getByRole('textbox'), 'contrato encerrado e cadastro duplicado');
    await pessoa.click(noDialogo().getByRole('button', { name: /Remover definitivamente/i }));

    await waitFor(() => expect(chamadas.officialSponsors.remove)
      .toHaveBeenCalledWith('s1', 'contrato encerrado e cadastro duplicado'));
  });
});

describe('prévia pública', () => {
  it('22. a prévia usa o MESMO componente da vitrine, não uma cópia', async () => {
    const pessoa = userEvent.setup();
    const { container } = await montar();
    await pessoa.click(screen.getByRole('button', { name: /Visualizar como público/i }));

    // `.rodape-patro` é a classe do componente público. Se a prévia fosse uma
    // reimplementação, ela divergiria do que o visitante vê — que é o que uma
    // prévia existe para evitar.
    await waitFor(() => expect(container.querySelector('.patro-previa-publica')).toBeTruthy());
    const { api } = await import('../services/api');
    expect(api.publicApi.sponsors).toHaveBeenCalled();
  });
});

describe('erros', () => {
  it('23. a falha da API vira aviso legível, nunca stack trace', async () => {
    const pessoa = userEvent.setup();
    chamadas.officialSponsors.update.mockRejectedValueOnce(new Error('Você não tem permissão para realizar esta ação.'));
    await montar();

    const linha = screen.getByText('Fora do Ar').closest('.list-row');
    await pessoa.click(within(linha).getByRole('button', { name: /Reativar/i }));

    await waitFor(() => expect(notificar).toHaveBeenCalledWith(
      'Você não tem permissão para realizar esta ação.', 'erro'
    ));
  });
});

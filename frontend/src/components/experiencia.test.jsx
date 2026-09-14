import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  Revelacao, VarreduraDeEnergia, PulsoAoVivo, PalcoDaExperiencia,
  ImpactoDeSucesso, MomentoCampeao
} from './experiencia';
import { MCIEvento, NIVEL, anunciar } from '../lib/experiencia';

// O teto de intensidade é lido do navegador, então cada teste declara em que
// aparelho ele está. Sem isto os testes passariam ou falhariam conforme o
// jsdom do dia — que é a forma mais silenciosa de um teste não valer nada.
function aparelho({ movimentoReduzido = false, memoria, nucleos } = {}) {
  // jsdom não traz `matchMedia`. Definir em vez de espionar é o que torna o
  // teste honesto: o motor lê a preferência do navegador de verdade, então o
  // teste precisa dar a ele um navegador de verdade para ler.
  window.matchMedia = consulta => ({
    matches: consulta.includes('prefers-reduced-motion') ? movimentoReduzido : false,
    media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
  Object.defineProperty(navigator, 'deviceMemory', { value: memoria, configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: nucleos, configurable: true });
}

const matchMediaOriginal = window.matchMedia;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = matchMediaOriginal;
  delete navigator.deviceMemory;
  delete navigator.hardwareConcurrency;
});

describe('Revelacao', () => {
  it('anima em sequência quando o aparelho permite', () => {
    aparelho();
    render(<Revelacao indice={3}><p>bloco</p></Revelacao>);
    const alvo = screen.getByText('bloco').parentElement;
    expect(alvo.className).toContain('revela');
    expect(alvo.style.animationDelay).toBe('135ms');
  });

  it('respeita o teto do atraso para a lista não terminar depois do usuário', () => {
    aparelho();
    render(<Revelacao indice={600}><p>último</p></Revelacao>);
    expect(screen.getByText('último').parentElement.style.animationDelay).toBe('360ms');
  });

  it('com movimento reduzido o bloco nasce PRONTO, sem classe e sem atraso', () => {
    aparelho({ movimentoReduzido: true });
    render(<Revelacao indice={3}><p>bloco</p></Revelacao>);
    const alvo = screen.getByText('bloco').parentElement;
    expect(alvo.className).not.toContain('revela');
    expect(alvo.style.animationDelay).toBe('');
    // O que importa de verdade: a informação continua na tela.
    expect(screen.getByText('bloco')).toBeTruthy();
  });
});

describe('VarreduraDeEnergia', () => {
  it('varre quando ativa', () => {
    aparelho();
    render(<VarreduraDeEnergia><p>painel</p></VarreduraDeEnergia>);
    expect(screen.getByText('painel').parentElement.className).toContain('varredura');
  });

  it('não varre quando desativada, mas mantém o conteúdo', () => {
    aparelho();
    render(<VarreduraDeEnergia ativa={false}><p>painel</p></VarreduraDeEnergia>);
    expect(screen.getByText('painel').parentElement.className).not.toContain('varredura');
    expect(screen.getByText('painel')).toBeTruthy();
  });

  it('não varre com movimento reduzido', () => {
    aparelho({ movimentoReduzido: true });
    render(<VarreduraDeEnergia><p>painel</p></VarreduraDeEnergia>);
    expect(screen.getByText('painel').parentElement.className).not.toContain('varredura');
  });
});

describe('PulsoAoVivo', () => {
  it('anuncia o estado para leitor de tela, e não só visualmente', () => {
    aparelho();
    render(<PulsoAoVivo />);
    const alvo = screen.getByRole('status');
    expect(alvo.textContent).toContain('AO VIVO');
    // O ponto que pulsa é decoração: quem lê a tela não deve ouvir nada dele.
    expect(alvo.querySelector('.pulso-ponto').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('PalcoDaExperiencia', () => {
  it('desenha o que o motor anuncia e sai de cena sozinho', () => {
    aparelho();
    render(<PalcoDaExperiencia />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => { anunciar(MCIEvento.CREDENCIADO, { titulo: 'Atleta credenciado' }); });
    expect(screen.getByText('Atleta credenciado')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(2300); });
    expect(screen.queryByText('Atleta credenciado')).toBeNull();
  });

  it('um momento novo SUBSTITUI o anterior em vez de empilhar', () => {
    aparelho();
    render(<PalcoDaExperiencia />);

    act(() => { anunciar(MCIEvento.CHECKIN, { titulo: 'Check-in feito' }); });
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { anunciar(MCIEvento.PESAGEM, { titulo: 'Pesagem registrada' }); });

    expect(screen.queryByText('Check-in feito')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);

    // E o relógio do primeiro não pode derrubar o segundo antes da hora dele.
    act(() => { vi.advanceTimersByTime(1800); });
    expect(screen.getByText('Pesagem registrada')).toBeTruthy();
  });

  it('com movimento reduzido o palco fica vazio — o toast funcional é que informa', () => {
    aparelho({ movimentoReduzido: true });
    render(<PalcoDaExperiencia />);
    act(() => { anunciar(MCIEvento.CREDENCIADO, { titulo: 'Atleta credenciado' }); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('CAMPEÃO leva ao momento campeão; os demais eventos NÃO', () => {
    aparelho();
    render(<PalcoDaExperiencia />);

    act(() => { anunciar(MCIEvento.SUCESSO, { titulo: 'Salvo' }); });
    expect(document.querySelector('.campeao')).toBeNull();

    act(() => { anunciar(MCIEvento.CAMPEAO, { nome: 'Ana Prado' }); });
    expect(document.querySelector('.campeao')).toBeTruthy();
    expect(screen.getByText('Ana Prado')).toBeTruthy();
  });
});

describe('MomentoCampeao', () => {
  it('as partículas são finitas e poucas', () => {
    aparelho();
    render(<MomentoCampeao momento={{ nome: 'Ana Prado' }} />);
    const faiscas = document.querySelectorAll('.campeao-particulas span');
    expect(faiscas).toHaveLength(14);
    // Nenhuma pode nascer sem o índice que escalona a subida — sem ele as 14
    // partiriam no mesmo instante e viraria um flash.
    faiscas.forEach((faisca, i) => expect(faisca.style.getPropertyValue('--i')).toBe(String(i)));
  });

  it('aparelho fraco recebe o nome do campeão, mas NÃO as partículas', () => {
    aparelho({ memoria: 2 });
    render(<MomentoCampeao momento={{ nome: 'Ana Prado' }} />);
    expect(document.querySelector('.campeao-particulas')).toBeNull();
    expect(screen.getByText('Ana Prado')).toBeTruthy();
  });
});

describe('ImpactoDeSucesso', () => {
  it('leva o tom declarado na assinatura do evento para a classe', () => {
    aparelho();
    render(<ImpactoDeSucesso momento={{ tom: 'ciano', titulo: 'Resultado publicado' }} />);
    expect(document.querySelector('.impacto-ciano')).toBeTruthy();
  });

  it('sem título, ainda diz alguma coisa — nunca uma caixa vazia', () => {
    aparelho();
    render(<ImpactoDeSucesso momento={{ tom: 'sucesso' }} />);
    expect(screen.getByRole('status').textContent.trim()).not.toBe('');
  });
});

describe('o contrato de raridade', () => {
  it('nenhum evento de operação rotineira chega ao nível cinematográfico', () => {
    const rotineiros = [
      MCIEvento.SUCESSO, MCIEvento.AVISO, MCIEvento.ERRO, MCIEvento.CHECKIN,
      MCIEvento.PESAGEM, MCIEvento.CREDENCIADO, MCIEvento.AO_VIVO, MCIEvento.NOVIDADE
    ];
    aparelho();
    for (const evento of rotineiros) {
      cleanup();
      render(<PalcoDaExperiencia />);
      act(() => { anunciar(evento, { titulo: 'x' }); });
      expect(document.querySelector('.campeao')).toBeNull();
      act(() => { vi.advanceTimersByTime(6000); });
    }
  });

  it('o palco não deixa nenhuma celebração presa na tela', () => {
    aparelho();
    render(<PalcoDaExperiencia />);
    act(() => { anunciar(MCIEvento.CAMPEAO, { nome: 'Ana Prado' }); });
    act(() => { vi.advanceTimersByTime(5300); });
    expect(document.querySelector('.campeao')).toBeNull();
  });
});

describe('níveis', () => {
  it('a escala é ordenada, que é o que faz o teto significar alguma coisa', () => {
    const ordem = [NIVEL.ESTATICO, NIVEL.MICRO, NIVEL.TRANSICAO, NIVEL.EVENTO, NIVEL.MOMENTO, NIVEL.CINEMATOGRAFICO];
    expect(ordem).toEqual([...ordem].sort((a, b) => a - b));
    expect(new Set(ordem).size).toBe(ordem.length);
  });
});

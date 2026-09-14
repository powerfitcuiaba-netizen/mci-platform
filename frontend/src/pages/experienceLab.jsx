import { useState } from 'react';
import { PageHead, Badge, Metric, Skeleton, Modal, ModalActions } from '../components/ui';
import { Revelacao, VarreduraDeEnergia, PulsoAoVivo } from '../components/experiencia';
import {
  anunciar, MCIEvento, tetoDeIntensidade, prefereMenosMovimento, atrasoDaSequencia
} from '../lib/experiencia';

// ============================================================================
// MCI EXPERIENCE LAB.
//
// Existe para calibrar os efeitos NUM LUGAR SÓ, antes de espalhá-los pelas
// telas. Ajustar uma curva aqui e ver o resultado ao lado é a diferença entre
// afinar a linguagem e sair mexendo em 23 arquivos.
//
// NÃO É TELA DE USUÁRIO: a rota só existe em desenvolvimento
// (`import.meta.env.DEV` em App.jsx), e por isso não entra no pacote de
// produção nem aparece em menu nenhum.
// ============================================================================

const NOME_DO_NIVEL = ['ESTÁTICO', 'MICRO', 'TRANSIÇÃO', 'EVENTO', 'MOMENTO', 'CINEMATOGRÁFICO'];

export default function ExperienceLab() {
  const [modal, setModal] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const teto = tetoDeIntensidade();

  const disparar = (evento, detalhe) => {
    const foi = anunciar(evento, detalhe);
    if (!foi) window.alert('O motor recusou: o nível deste evento está acima do teto atual.');
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="Desenvolvimento"
        title="MCI Experience Lab"
        description="Calibração dos efeitos num lugar só. Esta rota não existe em produção."
      />

      {/* O estado do motor em tempo real: sem isto, "por que o efeito não
          aconteceu?" vira adivinhação. */}
      <section className="card">
        <h2>Estado do motor</h2>
        <div className="grid grid-4" style={{ marginTop: 12 }}>
          <Metric label="Teto de intensidade" value={NOME_DO_NIVEL[teto]} hint={`nível ${teto}`} />
          <Metric label="Movimento reduzido" value={prefereMenosMovimento() ? 'SIM' : 'não'} hint="preferência do sistema" />
          <Metric label="Atraso do 3º item" value={`${atrasoDaSequencia(2)}ms`} hint="sequência" />
          <Metric label="Teto do atraso" value={`${atrasoDaSequencia(99)}ms`} hint="lista longa não empilha" />
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Com movimento reduzido o teto cai para MICRO: partículas e deslocamentos somem, a
          informação continua inteira. Para testar, ligue a preferência no sistema operacional e
          recarregue.
        </p>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Níveis</h2>
        <p className="muted">
          Cada efeito declara quanto vale. O que vale pouco fica discreto — é o que impede tudo de
          brilhar ao mesmo tempo.
        </p>
        <ul className="lista-simples">
          {NOME_DO_NIVEL.map((nome, indice) => (
            <li key={nome}>
              <Badge tom={indice > teto ? 'neutro' : indice >= 4 ? 'atencao' : 'sucesso'}>
                {indice} · {nome}
              </Badge>
              <span className="muted">
                {[
                  'não se move — a maioria da interface',
                  'hover, foco, press',
                  'troca de tela, abrir painel',
                  'salvou, credenciou, confirmou',
                  'resultado publicado',
                  'abertura, campeão geral'
                ][indice]}
                {indice > teto && ' — BLOQUEADO pelo teto atual'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Revelação em sequência</h2>
        <div className="grid grid-4" style={{ marginTop: 12 }}>
          {['Campeonatos', 'Atletas', 'Inscrições', 'Resultados'].map((rotulo, i) => (
            <Revelacao key={rotulo} indice={i}>
              <Metric label={rotulo} value={(i + 1) * 47} onClick={() => {}} destino="o módulo" />
            </Revelacao>
          ))}
        </div>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Varredura de energia e pulso ao vivo</h2>
        <p className="muted">
          A varredura passa UMA vez, para marcar o que é novo. O pulso só entra em dado realmente
          em tempo real — usá-lo para fingir tempo real é mentir com animação.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
          <VarreduraDeEnergia>
            <div className="card" style={{ minWidth: 220 }}>
              <Badge tom="ciano">Novo</Badge>
              <strong className="bloco">Muscle Contest Curitiba</strong>
              <span className="muted">20 – 22 mar 2026</span>
            </div>
          </VarreduraDeEnergia>
          <PulsoAoVivo />
          <PulsoAoVivo rotulo="Check-in acontecendo" />
        </div>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Momentos</h2>
        <p className="muted">
          O momento campeão é o único nível 5 da operação. Se aparecer a cada resultado, deixa de
          significar campeão e passa a significar “salvou”.
        </p>
        <div className="chips" style={{ marginTop: 12 }}>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.CREDENCIADO, { titulo: 'Atleta credenciado', descricao: 'João Silva — Muscle Contest Brasil 2026' })}>
            Credenciado (nível 3)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.CHECKIN, { titulo: 'Check-in confirmado', descricao: '142 de 280 atletas' })}>
            Check-in (nível 3)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.PESAGEM, { titulo: 'Pesagem registrada', descricao: '84,20 kg — dentro da classe' })}>
            Pesagem (nível 3)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.RESULTADO_PUBLICADO, { titulo: 'Resultado oficial publicado', descricao: 'Bikini Open — resultado recebido da federação' })}>
            Resultado (nível 4)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.NOVIDADE, { titulo: 'Bateria chamada', descricao: 'Bateria 1 · 6 atleta(s) notificado(s)' })}>
            Bateria chamada (nível 1)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.AO_VIVO, { titulo: 'No palco', descricao: 'Bateria 1' })}>
            Atleta no palco (nível 1)
          </button>
          {/* Os dois casos que a operação NÃO comemora. Estão aqui de propósito:
              é preciso conseguir ver, lado a lado, que eles saem diferentes do
              gesto de êxito — senão a regra existe só no texto. */}
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.ERRO, { titulo: 'Acesso recusado', descricao: 'Credencial revogada' })}>
            Acesso recusado (nível 1)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.AVISO, { titulo: 'Peso fora da faixa', descricao: 'A reclassificação é decisão da organização.' })}>
            Peso fora da faixa (nível 1)
          </button>
          <button type="button" className="chip" onClick={() => disparar(MCIEvento.CAMPEAO, { titulo: 'Campeão geral', nome: 'Carlos Mendes', descricao: 'Muscle Contest Brasil 2026' })}>
            Campeão geral (nível 5)
          </button>
        </div>
      </section>

      <section className="card" style={{ marginTop: 18 }}>
        <h2>Carregamento e modal</h2>
        <div className="chips" style={{ marginTop: 12 }}>
          <button type="button" className="chip" onClick={() => { setCarregando(true); setTimeout(() => setCarregando(false), 2200); }}>
            Mostrar esqueleto
          </button>
          <button type="button" className="chip" onClick={() => setModal(true)}>Abrir modal</button>
        </div>
        {carregando && <div style={{ marginTop: 12 }}><Skeleton linhas={3} /></div>}
      </section>

      {modal && (
        <Modal title="Modal do sistema" description="Entrada suave, foco preso, Escape fecha." onClose={() => setModal(false)}>
          <p className="muted">
            A escala é sutil de propósito: 0,965 → 1. Zoom exagerado faz a interface parecer um
            aplicativo de celular genérico.
          </p>
          <ModalActions onClose={() => setModal(false)} confirmLabel="Entendi" />
        </Modal>
      )}
    </div>
  );
}

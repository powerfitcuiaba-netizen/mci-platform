import { useState } from 'react';
import { Megaphone } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { Modal } from './ui';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// O RECADO DA FEDERAÇÃO, POR CIMA DA TELA.
//
// QUEM DECIDE SE ABRE É O SERVIDOR. A resposta de `GET /me/notices` traz
// `deveExibir` pronto — já com a janela de validade conferida e com o
// `showOnce` cruzado contra a leitura desta pessoa. A tela não recalcula
// nada: um segundo lugar decidindo quando mostrar um recado oficial é um
// segundo lugar para ela divergir do primeiro.
//
// FECHAR É LER. Não há "fechar sem marcar": quem viu o recado foi comunicado,
// e a marcação é o registro disso. Numa federação, "eu não fui avisado" é uma
// disputa real.
//
// UM DE CADA VEZ. Dois modais empilhados viram um só borrão que a pessoa
// fecha no reflexo — e o segundo recado, que podia ser o importante, morre
// junto com o primeiro. O seguinte aparece depois que este fecha.
// ==========================================================================

export default function MensagemDaFederacao() {
  const { t } = useIdioma();
  const [fechados, setFechados] = useState([]);

  const estado = useFetch(() => api.me.notices(), []);

  const fila = (estado.data?.items || []).filter(aviso => aviso.deveExibir && !fechados.includes(aviso.id));
  const aviso = fila[0];

  if (!aviso) return null;

  const fechar = async () => {
    // A marcação é gravada; a tela não espera por ela para fechar. Se a
    // gravação falhar, o recado reaparece no próximo acesso — que é o erro
    // certo: repetir um aviso custa um clique, perdê-lo custa a informação.
    api.me.readNotice(aviso.id).catch(() => {});
    setFechados(atual => [...atual, aviso.id]);
  };

  return (
    <Modal title={aviso.title} onClose={fechar}>
      <div className="recado-da-federacao">
        <p className="recado-remetente">
          <Megaphone size={14} aria-hidden="true" />
          {aviso.organization?.name || t('recado.suaFederacao')}
        </p>
        {/* O corpo é TEXTO, e cada parágrafo é um nó. Nada de HTML vindo do
            servidor: o recado é escrito por um operador, e operador enganado
            também digita o que lhe mandaram digitar. */}
        {String(aviso.body).split(/\n{2,}/).map((paragrafo, indice) => (
          <p key={indice}>{paragrafo}</p>
        ))}
      </div>

      <div className="modal-actions">
        <button type="button" className="button button-primary" onClick={fechar}>
          {t(aviso.showOnce ? 'recado.entendi' : 'acao.fechar')}
        </button>
      </div>
    </Modal>
  );
}

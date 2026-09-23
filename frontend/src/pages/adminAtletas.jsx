import { useState } from 'react';
import { Search } from 'lucide-react';
import api from '../services/api';
import { useDebounce, useFetch, useListaPaginada } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, Paginacao, PageHead } from '../components/ui';
import { useIdioma } from '../lib/idioma';

// ==========================================================================
// ADMINISTRAÇÃO → ATLETAS — a lista por onde o operador chega ao perfil.
//
// Duas decisões que têm teste:
//
//   * A BUSCA POR CPF NÃO PASSA PELA URL. O termo vai no corpo da consulta
//     que o cliente monta, e o servidor só aceita CPF como IGUALDADE EXATA e
//     só para quem tem `search.sensitive` (athleteService.list). Esta tela
//     não monta link com o termo dentro, não guarda o termo no hash e não
//     mostra CPF na listagem — nem mascarado. Uma fila de duzentos nomes na
//     tela com documento ao lado é um vazamento esperando um print.
//
//   * O ESTADO É FILTRO DE PRIMEIRA CLASSE. Uma federação grande mistura, na
//     mesma lista, quem está em circulação com quem foi suspenso e com quem
//     foi arquivado. Sem separar, o operador não consegue nem contar.
// ==========================================================================

const FILTROS_DE_ESTADO = [
  ['', 'atletas.todos'],
  ['ACTIVE', 'atleta.estadoAtivo'],
  ['SUSPENDED', 'atleta.estadoSuspenso'],
  ['ARCHIVED', 'atleta.estadoArquivado']
];

const TOM = { ACTIVE: 'ok', SUSPENDED: 'alerta', ARCHIVED: 'neutro' };
const ROTULO = { ACTIVE: 'atleta.estadoAtivo', SUSPENDED: 'atleta.estadoSuspenso', ARCHIVED: 'atleta.estadoArquivado' };

export function AdminAtletas({ navegar }) {
  const { t } = useIdioma();
  const [termo, setTermo] = useState('');
  const [status, setStatus] = useState('');
  const [affiliationId, setAffiliationId] = useState('');
  const busca = useDebounce(termo, 400);

  const filiacoes = useFetch(() => api.affiliations.list({ limit: 100 }), []);

  const lista = useListaPaginada(
    cursor => api.athletes.list({
      search: busca || undefined,
      status: status || undefined,
      affiliationId: affiliationId || undefined,
      cursor: cursor || undefined,
      limit: 25
    }),
    [busca, status, affiliationId]
  );

  return (
    <div className="page">
      <PageHead
        eyebrow={t('atleta.administracao')}
        title={t('atletas.titulo')}
        description={t('atletas.descricao')}
      />

      <div className="toolbar">
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={termo}
            onChange={evento => setTermo(evento.target.value)}
            placeholder={t('atletas.buscarPlaceholder')}
            aria-label={t('atletas.buscar')}
          />
        </label>

        <select
          value={affiliationId}
          onChange={evento => setAffiliationId(evento.target.value)}
          aria-label={t('atletas.filtrarPorFiliacao')}
        >
          <option value="">{t('atletas.todasAsFiliacoes')}</option>
          {(filiacoes.data?.items || []).map(entidade => (
            <option key={entidade.id} value={entidade.id}>{entidade.name}</option>
          ))}
        </select>
      </div>

      <div className="chips" role="group" aria-label={t('atletas.filtrarPorEstado')}>
        {FILTROS_DE_ESTADO.map(([valor, chave]) => (
          <button
            key={chave}
            type="button"
            className={`chip${status === valor ? ' is-on' : ''}`}
            aria-pressed={status === valor}
            onClick={() => setStatus(valor)}
          >
            {t(chave)}
          </button>
        ))}
      </div>


      <AsyncSection state={lista} empty={dados => !dados.items?.length}>
        {dados => (
          <>
            <section className="panel" style={{ marginTop: 18 }}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('atleta.nomeCompleto')}</th>
                      <th>{t('atleta.filiacao')}</th>
                      <th>{t('atleta.matricula')}</th>
                      <th>{t('atletas.situacao')}</th>
                      <th className="num" aria-label={t('atletas.abrir')} />
                    </tr>
                  </thead>
                  <tbody>
                    {dados.items.map(atleta => (
                      <tr key={atleta.id}>
                        <td data-rotulo={t('atleta.nomeCompleto')}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <Avatar name={atleta.fullName} mediaPath={atleta.hasPhoto ? `/media/athletes/${atleta.id}/photo` : null} size="avatar-sm" />
                            <div>
                              <strong>{atleta.fullName}</strong>
                              {atleta.stageName && <div><small>{atleta.stageName}</small></div>}
                            </div>
                          </div>
                        </td>
                        <td data-rotulo={t('atleta.filiacao')}>{atleta.affiliation?.name || '—'}</td>
                        <td data-rotulo={t('atleta.matricula')}>{atleta.affiliationNumber || '—'}</td>
                        <td data-rotulo={t('atletas.situacao')}>
                          <Badge tom={TOM[atleta.status] || 'neutro'}>{t(ROTULO[atleta.status] || 'atleta.estadoAtivo')}</Badge>
                        </td>
                        <td className="num">
                          <button
                            type="button"
                            className="button button-secondary button-sm"
                            onClick={() => navegar(`admin/atletas/${atleta.id}`)}
                          >
                            {t('atletas.abrir')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <Paginacao nextCursor={lista.nextCursor} onMore={lista.carregarMais} loading={lista.carregandoMais} />
          </>
        )}
      </AsyncSection>
    </div>
  );
}

export default AdminAtletas;

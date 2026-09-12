import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

// ==========================================================================
// Limite de erro.
//
// Sem ele, uma exceção de renderização em UMA tela desmonta a árvore inteira:
// o React remove tudo e o que fica é uma página em branco. No meio de um
// evento isso é o pior desfecho possível — o operador perde o menu, não recebe
// aviso nenhum e não tem caminho de volta, porque recarregar traz de novo a
// mesma rota quebrada.
//
// Precisa ser classe: é a única forma de capturar erro de renderização no
// React. `getDerivedStateFromError` troca a árvore pela tela de recuperação, e
// o limite se rearma quando a rota muda — senão a aplicação ficaria presa no
// erro para sempre.
// ==========================================================================
export default class LimiteDeErro extends Component {
  constructor(props) {
    super(props);
    this.state = { erro: null };
    this.aoMudarRota = () => { if (this.state.erro) this.setState({ erro: null }); };
    this.voltarAoInicio = () => {
      window.location.hash = '#/inicio';
      this.setState({ erro: null });
    };
  }

  static getDerivedStateFromError(erro) {
    return { erro };
  }

  componentDidMount() {
    window.addEventListener('hashchange', this.aoMudarRota);
  }

  componentWillUnmount() {
    window.removeEventListener('hashchange', this.aoMudarRota);
  }

  componentDidCatch(erro) {
    // A regra `no-console` da interface existe contra depuração esquecida —
    // e este não é o caso: é o ÚNICO lugar do sistema onde uma exceção de
    // renderização pode ser registrada. Engolir a falha em silêncio deixaria
    // um incidente de produção sem nenhum rastro, e um toast não carrega
    // pilha. O rastro não vai para a tela: a pilha de um bundle minificado
    // não ajuda o operador e pode conter trecho de dado.
    // eslint-disable-next-line no-console
    console.error('[MCI] erro de renderização', erro);
  }

  render() {
    if (!this.state.erro) return this.props.children;

    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <div className="alert alert-erro" role="alert" style={{ maxWidth: 560 }}>
          <AlertTriangle size={18} />
          <div style={{ flex: 1 }}>
            <strong>Esta tela parou de responder</strong>
            <p>
              O restante do sistema continua funcionando. Volte ao início e
              tente de novo; se acontecer outra vez, avise o suporte técnico
              informando em qual tela ocorreu.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="button button-primary" onClick={this.voltarAoInicio}>
                Voltar ao início
              </button>
              <button type="button" className="button button-secondary" onClick={() => window.location.reload()}>
                Recarregar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

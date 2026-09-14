import { digitos } from './formulario';

// Busca de endereço por CEP.
//
// REGRA QUE MANDA AQUI: o serviço externo é uma CONVENIÊNCIA, nunca uma
// dependência. Se ele cair, demorar ou responder besteira, o cadastro continua
// — a pessoa preenche à mão. Um formulário que trava porque um serviço de
// terceiro está fora é um formulário quebrado.
//
// Por isso nada nesta função "lança" para cima: ela devolve um resultado
// descrito, e a tela decide o que mostrar.
//
// `buscador` é injetável para o teste não depender de rede. Em produção é o
// `fetch` do navegador.

const ENDERECO = cep => `https://viacep.com.br/ws/${cep}/json/`;

// 6 segundos: acima disso a pessoa já desistiu de esperar e começou a digitar.
const TEMPO_LIMITE = 6000;

export async function buscarCep(valorBruto, { buscador = fetch, tempoLimite = TEMPO_LIMITE } = {}) {
  const cep = digitos(valorBruto);
  if (cep.length !== 8) return { situacao: 'invalido' };

  // O timeout é nosso: sem ele, uma rede pendurada deixa o campo em
  // "buscando…" para sempre e a pessoa não sabe se pode digitar.
  const cancelador = new AbortController();
  const relogio = setTimeout(() => cancelador.abort(), tempoLimite);

  try {
    const resposta = await buscador(ENDERECO(cep), { signal: cancelador.signal });
    if (!resposta.ok) return { situacao: 'indisponivel' };

    const dados = await resposta.json();
    // O ViaCEP responde 200 com `{ erro: true }` para CEP que não existe —
    // tratar só o status HTTP daria "encontrado" para um CEP inexistente.
    if (dados?.erro) return { situacao: 'nao_encontrado' };

    return {
      situacao: 'encontrado',
      endereco: {
        addressLine: dados.logradouro || '',
        bairro: dados.bairro || '',
        city: dados.localidade || '',
        state: (dados.uf || '').toUpperCase()
      }
    };
  } catch {
    // Rede fora, DNS, CORS, timeout, JSON quebrado: para a pessoa que está
    // preenchendo, é tudo a mesma coisa — "não deu, preencha à mão".
    return { situacao: 'indisponivel' };
  } finally {
    clearTimeout(relogio);
  }
}

export const MENSAGEM_DO_CEP = Object.freeze({
  invalido: 'CEP incompleto.',
  nao_encontrado: 'CEP não encontrado. Confira ou preencha o endereço manualmente.',
  indisponivel: 'Não conseguimos consultar o CEP agora. Preencha o endereço manualmente.',
  encontrado: null
});

// ============================================================================
// ENTRAR NA PLATAFORMA, PELA PORTA, NUM ARREIO DE NAVEGADOR.
//
// POR QUE ISTO EXISTE
//
// Os arreios faziam `goto(BASE_WEB)` e preenchiam o campo de e-mail na
// sequência, porque o casco devolvia a tela de acesso para qualquer rota. Isso
// mudou: as telas marcadas `publico: true` abrem SEM sessão, e o hash vazio cai
// em `inicio`, que é uma delas. O que aparece ali agora é a vitrine — e o campo
// de e-mail nunca chega.
//
// Duas coisas, portanto, passaram a ficar entre o arreio e o formulário:
//
//   1. a ABERTURA DA MARCA, que roda uma vez por sessão do navegador e dura
//      7,2s. Ela sai sozinha pelo tempo, mas esperar o tempo em cada arreio é
//      desperdício; Escape a dispensa, que é o caminho que ela própria oferece;
//   2. a VITRINE, que é a tela pública. A entrada se pede pelo convite
//      "Entrar agora" da barra lateral.
//
// Um lugar só, porque nove arreios faziam a mesma coisa e divergiriam.
//
// NÃO injeta token, NÃO escreve no armazenamento e NÃO atalha o formulário: o
// que se mede nos arreios é a tela, e um atalho aqui mediria o atalho.
// ============================================================================

import { setTimeout as esperar } from 'node:timers/promises';

/** A abertura da marca está na frente? O texto do controle de som a denuncia. */
const naAbertura = async pagina =>
  /experiência sonora|experiencia sonora|sound experience|experiencia sonora/i.test(await pagina.content());

/**
 * Dispensa a abertura da marca, se ela estiver na tela.
 *
 * Tolera não estar: quem já a viu nesta sessão do navegador não a vê de novo.
 */
export async function dispensarAbertura(pagina, { tentativas = 4 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    if (!await naAbertura(pagina)) return;
    await pagina.keyboard.press('Escape');
    await esperar(1200);
  }
}

/** O formulário de entrada está na tela? O campo de senha é o sinal. */
export const naTelaDeEntrada = async pagina =>
  (await pagina.locator('input[type="password"]').count()) > 0;

/**
 * Leva a página até o FORMULÁRIO de entrada, venha de onde vier.
 *
 * Dispensa a abertura, e — se tiver caído na vitrine — pede a entrada pelo
 * convite da barra lateral. Devolve quando o campo de senha existe.
 */
export async function abrirTelaDeEntrada(pagina, baseWeb, { espera = 2000 } = {}) {
  await pagina.goto(baseWeb, { waitUntil: 'networkidle' });
  await esperar(1500);
  await dispensarAbertura(pagina);

  if (await naTelaDeEntrada(pagina)) return;

  const convite = pagina.locator('nav').first().getByRole('button', { name: /Entrar agora|Enter now|Entrar ahora/i });
  if (await convite.count()) {
    await convite.first().click();
    await esperar(espera);
  }

  if (!await naTelaDeEntrada(pagina)) {
    const visivel = (await pagina.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`não cheguei ao formulário de entrada. A tela mostrava: "${visivel}"`);
  }
}

/**
 * Entra com e-mail e senha, pela tela de verdade.
 *
 * `aposEntrar` é o tempo de folga para a sessão assentar antes de o arreio
 * seguir — cada um tem o seu, e o padrão serve à maioria.
 */
export async function entrar(pagina, baseWeb, { email, senha, aposEntrar = 2500 }) {
  await abrirTelaDeEntrada(pagina, baseWeb);
  await pagina.locator('input[type="email"]').first().fill(email);
  await pagina.locator('input[type="password"]').first().fill(senha);
  await pagina.locator('form button[type="submit"]').first().click();
  await esperar(aposEntrar);
}

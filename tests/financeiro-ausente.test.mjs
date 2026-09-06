import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from './helpers.mjs';

// Esta plataforma NÃO é um sistema financeiro. A ausência é requisito, não
// omissão — e requisito só é requisito se estiver verificado. Este arquivo
// falha se qualquer módulo, tabela, coluna ou rota financeira reaparecer.

const RAIZ = new URL('..', import.meta.url).pathname;

function arquivosDe(diretorio, extensoes) {
  const saida = [];
  for (const nome of readdirSync(diretorio)) {
    if (nome === 'node_modules' || nome === '.git' || nome === 'dist') continue;
    const caminho = join(diretorio, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosDe(caminho, extensoes));
    else if (extensoes.some(ext => nome.endsWith(ext))) saida.push(caminho);
  }
  return saida;
}

describe('nenhum módulo financeiro', () => {
  it('o schema não declara modelo financeiro', () => {
    const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8');
    const proibidos = [
      'model Order', 'model OrderItem', 'model Payment', 'model PaymentEvent',
      'model Coupon', 'model CouponRedemption', 'model Refund', 'model Invoice',
      'model Wallet', 'model Transaction', 'model Subscription', 'model Billing'
    ];

    for (const modelo of proibidos) {
      expect(schema.includes(modelo), `schema declara ${modelo}`).toBe(false);
    }
  });

  it('o schema não declara campo monetário', () => {
    const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8');
    const proibidos = [
      /entryFeeCents/, /amountCents/, /totalCents/, /subtotalCents/, /discountCents/,
      /unitPriceCents/, /priceCents/, /balanceCents/, /paymentStatus/, /\bcvv\b/i,
      /cardNumber/i, /\bcurrency\b/
    ];

    for (const padrao of proibidos) {
      expect(padrao.test(schema), `schema contém ${padrao}`).toBe(false);
    }
  });

  it('o banco real não tem tabela financeira', async () => {
    const tabelas = await prisma.$queryRawUnsafe(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const nomes = tabelas.map(linha => linha.tablename.toLowerCase());

    for (const proibida of ['order', 'orderitem', 'payment', 'paymentevent', 'coupon', 'couponredemption', 'refund', 'invoice', 'wallet', 'transaction', 'subscription', 'billing']) {
      expect(nomes.includes(proibida), `banco tem a tabela ${proibida}`).toBe(false);
    }
  });

  it('o banco real não tem coluna monetária', async () => {
    const colunas = await prisma.$queryRawUnsafe(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ILIKE '%cents%' OR column_name ILIKE '%price%'
             OR column_name ILIKE '%amount%' OR column_name ILIKE '%currency%'
             OR column_name ILIKE '%cvv%' OR column_name ILIKE '%card%')
    `);
    expect(colunas, JSON.stringify(colunas)).toHaveLength(0);
  });

  it('não existe service, controller nem utilitário financeiro', () => {
    const arquivos = arquivosDe(join(RAIZ, 'src'), ['.js']).map(caminho => caminho.replace(RAIZ, ''));
    const proibidos = ['payment', 'order', 'coupon', 'refund', 'invoice', 'billing', 'money', 'pricing', 'wallet', 'checkout'];

    for (const termo of proibidos) {
      const encontrados = arquivos.filter(caminho => caminho.toLowerCase().includes(termo));
      expect(encontrados, `arquivo financeiro: ${encontrados.join(', ')}`).toHaveLength(0);
    }
  });

  it('nenhuma rota financeira está registrada', () => {
    const rotas = readFileSync(join(RAIZ, 'src/routes/index.js'), 'utf8');
    for (const termo of ['/orders', '/payments', '/coupons', '/refunds', '/checkout', '/webhooks/payments', '/billing', '/invoices']) {
      expect(rotas.includes(termo), `rota financeira registrada: ${termo}`).toBe(false);
    }
  });

  it('o código não menciona meio de pagamento', () => {
    const arquivos = arquivosDe(join(RAIZ, 'src'), ['.js']);
    const padrao = /\b(pix|boleto|checkout|gateway de pagamento|cart[ãa]o de cr[ée]dito|stripe|mercadopago|pagseguro|paypal)\b/i;

    const ofensores = arquivos.filter(caminho => padrao.test(readFileSync(caminho, 'utf8')));
    expect(ofensores.map(c => c.replace(RAIZ, ''))).toHaveLength(0);
  });

  it('o ambiente não define variável financeira', () => {
    const exemplo = readFileSync(join(RAIZ, '.env.example'), 'utf8');
    const ambiente = readFileSync(join(RAIZ, 'src/config/environment.js'), 'utf8');

    for (const chave of ['PAYMENT_PROVIDER', 'PAYMENT_WEBHOOK_SECRET', 'ALLOW_SANDBOX_PAYMENTS', 'ORDER_EXPIRATION', 'STRIPE', 'PIX_']) {
      expect(exemplo.includes(chave), `.env.example define ${chave}`).toBe(false);
      expect(ambiente.includes(chave), `environment.js lê ${chave}`).toBe(false);
    }
  });
});

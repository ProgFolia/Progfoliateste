/**
 * functions/api/create-preference.js
 * Cloudflare Pages Function - Integração Mercado Pago + Google Sheets
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// Rota GET de diagnóstico: abra /api/create-preference no navegador para testar
export async function onRequestGet(context) {
  const { env } = context;
  const mpConfigurado = Boolean(env.MP_ACCESS_TOKEN);
  const sheetsConfigurado = Boolean(env.GOOGLE_SHEET_WEBHOOK_URL);

  return new Response(JSON.stringify({
    status: 'online',
    mercado_pago_ativo: mpConfigurado,
    google_sheets_ativo: sheetsConfigurado,
    mensagem: mpConfigurado 
      ? 'Configuração pronta para processar vendas.' 
      : 'Defina a variável MP_ACCESS_TOKEN nas configurações da Cloudflare.'
  }, null, 2), {
    status: 200,
    headers: corsHeaders
  });
}

// Rota POST: Cria preferência no Mercado Pago e grava na Planilha
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const token = env.MP_ACCESS_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({
        error: 'Chave de acesso do Mercado Pago não configurada (MP_ACCESS_TOKEN ausente).'
      }), { status: 500, headers: corsHeaders });
    }

    const body = await request.json();
    const buyer = body.buyer || {};

    // Normalização dos itens recebidos (compatível com lista ou campos avulsos)
    let rawItems = [];
    if (Array.isArray(body.items) && body.items.length > 0) {
      rawItems = body.items;
    } else if (Array.isArray(body.carrinho) && body.carrinho.length > 0) {
      rawItems = body.carrinho;
    } else if (body.title && (body.price || body.unit_price)) {
      rawItems = [{
        title: body.title,
        unit_price: Number(body.price || body.unit_price),
        quantity: Number(body.quantity) || 1,
        size: buyer.size || 'M'
      }];
    }

    if (rawItems.length === 0) {
      return new Response(JSON.stringify({
        error: 'Nenhum abadá informado no carrinho.'
      }), { status: 400, headers: corsHeaders });
    }

    // Formatação dos itens para o Mercado Pago
    const mpItems = rawItems.map(item => ({
      title: item.title || 'Abadá Prog Folia 2027',
      quantity: Number(item.quantity) || 1,
      unit_price: Number(item.unit_price || item.price || 1),
      currency_id: 'BRL',
      description: item.description || `Abadá Prog Folia - Tamanho ${item.size || buyer.size || 'M'}`
    }));

    // Dados do comprador
    const payer = {
      name: buyer.name || 'Folião Prog Folia',
      email: buyer.email || 'contato@progfolia.com.br'
    };

    if (buyer.cpf) {
      payer.identification = {
        type: 'CPF',
        number: String(buyer.cpf).replace(/\D/g, '')
      };
    }

    if (buyer.phone) {
      const foneLimpo = String(buyer.phone).replace(/\D/g, '');
      if (foneLimpo.length >= 10) {
        payer.phone = {
          area_code: foneLimpo.slice(0, 2),
          number: foneLimpo.slice(2)
        };
      }
    }

    const url = new URL(request.url);
    const origin = url.origin;

    // Payload de criação da Preferência no Mercado Pago Checkout Pro
    const preferencePayload = {
      items: mpItems,
      payer: payer,
      back_urls: {
        success: `${origin}/`,
        failure: `${origin}/`,
        pending: `${origin}/`
      },
      auto_return: 'approved',
      statement_descriptor: 'PROGFOLIA',
      external_reference: `PF-${Date.now()}`
    };

    // Chamada à API do Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferencePayload)
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok || !mpData.init_point) {
      return new Response(JSON.stringify({
        error: mpData.message || mpData.error || 'Erro ao emitir cobrança no Mercado Pago.',
        detalhes: mpData
      }), { status: 400, headers: corsHeaders });
    }

    // Envio automático para a Planilha do Google Sheets (se a variável estiver configurada)
    if (env.GOOGLE_SHEET_WEBHOOK_URL) {
      try {
        const totalCalculado = mpItems.reduce((acc, curr) => acc + (curr.unit_price * curr.quantity), 0);
        const qtdTotal = mpItems.reduce((acc, curr) => acc + curr.quantity, 0);
        const nomesItens = mpItems.map(i => i.title).join(' + ');

        await fetch(env.GOOGLE_SHEET_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nome: buyer.name || 'Não informado',
            whatsapp: buyer.phone || 'Não informado',
            cpf: buyer.cpf || 'Não informado',
            tamanho: buyer.size || 'M',
            quantidade: qtdTotal,
            item: nomesItens,
            valor: totalCalculado.toFixed(2),
            transacao_id: mpData.id || 'Checkout Aberto',
            status: 'Aguardando Pagamento',
            observacoes: `Checkout gerado via site. Ref: ${preferencePayload.external_reference}`
          })
        });
      } catch (sheetErr) {
        // Falha no Google Sheets não bloqueia o comprador de ir pagar no Mercado Pago
        console.error('Falha de envio para a planilha:', sheetErr);
      }
    }

    return new Response(JSON.stringify({
      id: mpData.id,
      init_point: mpData.init_point
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Erro interno ao processar pedido.',
      detalhes: err.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

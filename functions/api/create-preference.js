// functions/api/create-preference.js
// Cloudflare Pages Function • Mercado Pago Checkout Pro (PIX & Cartão em até 12x)

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// ROTA DE DIAGNÓSTICO (Acesse no navegador: /api/create-preference)
export async function onRequestGet(context) {
  const token = (context.env.MP_ACCESS_TOKEN || "").trim();

  let mpStatus = "Token não configurado nas variáveis do Cloudflare";

  if (token) {
    try {
      // Testa conexão com a API do Mercado Pago
      const testRes = await fetch("https://api.mercadopago.com/users/me", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (testRes.ok) {
        const userData = await testRes.json();
        mpStatus = {
          status: "CONECTADO_COM_SUCESSO",
          usuario: userData.nickname || userData.first_name || "Lojista Mercado Pago",
          email: userData.email,
          pais: userData.country_id
        };
      } else {
        mpStatus = {
          status: "ERRO_DE_TOKEN",
          detalhe: "O Access Token fornecido é inválido ou expirou."
        };
      }
    } catch (e) {
      mpStatus = { status: "ERRO_DE_REDE", mensagem: e.message };
    }
  }

  return new Response(
    JSON.stringify({
      gateway: "Mercado Pago Checkout Pro",
      servidor: "Cloudflare Pages Function (Edge)",
      variavel_detectada: token ? `APP_USR-...${token.slice(-6)} (Ativa)` : "FALTANDO: MP_ACCESS_TOKEN",
      diagnostico_conexao: mpStatus,
      instrucao: token 
        ? "Tudo pronto! Seus foliões já podem comprar abadás com PIX ou Cartão em até 12x." 
        : "Adicione a variável MP_ACCESS_TOKEN nas configurações do Cloudflare Pages e faça o Redeploy."
    }, null, 2),
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}

// CRIAÇÃO DA PREFERÊNCIA DE PAGAMENTO DINÂMICA (POST)
export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
  };

  try {
    const { buyer, items } = await context.request.json().catch(() => ({}));

    if (!items || !items.length) {
      return new Response(
        JSON.stringify({ error: "Nenhum abadá informado no carrinho." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const accessToken = (context.env.MP_ACCESS_TOKEN || "").trim();

    if (!accessToken) {
      return new Response(
        JSON.stringify({ 
          error: "MP_ACCESS_TOKEN não configurado no Cloudflare Pages.",
          details: "Acesse o painel do Cloudflare > Settings > Environment variables e adicione a chave."
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Formata os itens do carrinho para o padrão exigido pelo Mercado Pago
    const mpItems = items.map((item, idx) => ({
      id: item.id || `abada_${idx}`,
      title: `Abadá Prog Folia 2027 [${item.isCustom ? item.customLabel : item.size}]`,
      quantity: Number(item.quantity),
      unit_price: Number(item.unitPrice),
      currency_id: "BRL",
      description: "Abadá Oficial Dry Fit - Bloco Prog Folia Memento Vivere Vitória/ES"
    }));

    // Cria a preferência de pagamento no Mercado Pago
    const mpResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        items: mpItems,
        payer: {
          name: buyer?.name || "Folião Prog Folia",
          email: buyer?.email || "contato@progfolia.com.br",
          phone: {
            number: buyer?.phone ? buyer.phone.replace(/\D/g, "") : ""
          }
        },
        back_urls: {
          success: "https://progfolia-2027.pages.dev/#sucesso",
          failure: "https://progfolia-2027.pages.dev/#erro",
          pending: "https://progfolia-2027.pages.dev/#pendente"
        },
        auto_return: "approved",
        statement_descriptor: "PROGFOLIA27",
        payment_methods: {
          installments: 12 // Permite parcelamento em até 12x
        }
      })
    });

    if (!mpResponse.ok) {
      const errorText = await mpResponse.text();
      console.error("Erro Mercado Pago API:", errorText);
      return new Response(
        JSON.stringify({ 
          error: "O Mercado Pago recusou a criação do pagamento.", 
          details: errorText 
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const prefData = await mpResponse.json();

    // Retorna o link oficial (init_point) gerado com a soma exata dos itens
    return new Response(
      JSON.stringify({
        id: prefData.id,
        init_point: prefData.init_point
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ 
        error: "Falha interna no servidor Cloudflare.", 
        details: err.message 
      }),
      { status: 500, headers: corsHeaders }
    );
  }
}
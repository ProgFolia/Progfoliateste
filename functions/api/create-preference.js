// functions/api/create-preference.js
// Cloudflare Pages Function • Integração Oficial PicPay OAuth 2.0 (API V2)

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// ROTA DE DIAGNÓSTICO (Permite testar se as chaves estão ativas abrindo no navegador)
export async function onRequestGet(context) {
  const hasClientId = Boolean(context.env.PICPAY_CLIENT_ID);
  const hasClientSecret = Boolean(context.env.PICPAY_CLIENT_SECRET);
  const legacyToken = Boolean(context.env.PICPAY_TOKEN);

  return new Response(
    JSON.stringify({
      status: "online",
      message: "API do PicPay no Cloudflare Pages está operacional",
      config: {
        PICPAY_CLIENT_ID: hasClientId ? "Configurado com sucesso" : "Ausente / Não cadastrado",
        PICPAY_CLIENT_SECRET: hasClientSecret ? "Configurado com sucesso" : "Ausente / Não cadastrado",
        PICPAY_TOKEN_LEGADO: legacyToken ? "Configurado" : "Não utilizado"
      }
    }, null, 2),
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    }
  );
}

export async function onRequestPost(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const { buyer, items } = await context.request.json();

    if (!items || !items.length) {
      return new Response(
        JSON.stringify({ error: "Nenhum abadá informado no carrinho." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Variáveis de ambiente configuradas no Cloudflare Pages (com limpeza de espaços)
    const clientId = (context.env.PICPAY_CLIENT_ID || "").trim();
    const clientSecret = (context.env.PICPAY_CLIENT_SECRET || "").trim();
    const sellerToken = (context.env.PICPAY_SELLER_TOKEN || "").trim();

    // Fallback de compatibilidade caso ainda use o token estático legado
    const legacyToken = (context.env.PICPAY_TOKEN || "").trim();

    let accessToken = "";

    // FLUXO MODERNO: OAuth 2.0 com Client ID e Client Secret
    if (clientId && clientSecret) {
      const authResponse = await fetch("https://api.picpay.com/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (!authResponse.ok) {
        const authErr = await authResponse.text();
        console.error("Erro na autenticação PicPay OAuth:", authErr);
        return new Response(
          JSON.stringify({ 
            error: "Falha na autenticação com o PicPay. Verifique o PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET no Cloudflare.", 
            details: authErr 
          }),
          { status: 401, headers: corsHeaders }
        );
      }

      const authData = await authResponse.json();
      accessToken = authData.access_token;
    } else if (legacyToken) {
      // Uso do token estático direto
      accessToken = legacyToken;
    } else {
      return new Response(
        JSON.stringify({ 
          error: "Credenciais do PicPay não configuradas. Adicione PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET no painel da Cloudflare." 
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Soma exata de todos os abadás e opções sob encomenda
    const totalAmount = items.reduce((sum, item) => {
      return sum + (Number(item.unitPrice) * Number(item.quantity));
    }, 0);

    // Divisão do nome para o formato exigido pelo PicPay
    const rawName = (buyer?.name || "Folião Prog Folia").trim();
    const nameParts = rawName.split(" ");
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "Capixaba";

    // Formatação de documento (CPF) e telefone
    const rawDocument = (buyer?.document || "").replace(/\D/g, "");
    const formattedCpf = rawDocument.length === 11
      ? rawDocument.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
      : rawDocument;
    const rawPhone = (buyer?.phone || "").replace(/\D/g, "");
    const formattedPhone = rawPhone.startsWith("55") ? `+${rawPhone}` : `+55${rawPhone}`;

    // Identificador único da transação
    const referenceId = `PROG-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // Tempo de expiração da cobrança (24 horas) formatado no padrão ISO 8601 sem milissegundos (-03:00)
    const expDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const expiresAt = `${expDate.getFullYear()}-${pad(expDate.getMonth() + 1)}-${pad(expDate.getDate())}T${pad(expDate.getHours())}:${pad(expDate.getMinutes())}:${pad(expDate.getSeconds())}-03:00`;

    // Payload oficial para a criação do pedido na API PicPay V2 (buyer estrito)
    const paymentPayload = {
      referenceId: referenceId,
      callbackUrl: "https://progfolia-2027.pages.dev/api/callback",
      returnUrl: "https://progfolia-2027.pages.dev/#sucesso",
      value: Number(totalAmount.toFixed(2)),
      expiresAt: expiresAt,
      buyer: {
        firstName: firstName,
        lastName: lastName,
        document: formattedCpf
      }
    };

    // Montagem dos cabeçalhos da requisição
    const paymentHeaders = {
      "Content-Type": "application/json"
    };

    if (clientId && clientSecret) {
      // Padrão OAuth 2.0 oficial PicPay V2: requer unicamente o Bearer Token
      paymentHeaders["Authorization"] = `Bearer ${accessToken}`;
    } else {
      // Compatibilidade legada V1
      paymentHeaders["x-picpay-token"] = accessToken;
      if (sellerToken) {
        paymentHeaders["x-seller-token"] = sellerToken;
      }
    }

    // Chamada à API de pagamento do PicPay
    const paymentEndpoint = (clientId && clientSecret)
      ? "https://api.picpay.com/ecommerce/v2/payments"
      : "https://appws.picpay.com/ecommerce/public/payments";

    const paymentResponse = await fetch(paymentEndpoint, {
      method: "POST",
      headers: paymentHeaders,
      body: JSON.stringify(paymentPayload)
    });

    if (!paymentResponse.ok) {
      const errorText = await paymentResponse.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch (_) {}

      const cleanMsg = errorJson?.message 
        || (Array.isArray(errorJson?.errors) ? errorJson.errors.map(e => e.message || `${e.field}: inválido`).join(', ') : null)
        || errorText;

      console.error("Erro PicPay ao gerar cobrança:", cleanMsg);
      return new Response(
        JSON.stringify({ 
          error: cleanMsg, 
          details: errorJson || errorText 
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const paymentData = await paymentResponse.json();

    // Retorna a URL de pagamento do PicPay para o navegador abrir
    return new Response(
      JSON.stringify({
        id: paymentData.referenceId,
        init_point: paymentData.paymentUrl,
        qrcode: paymentData.qrcode,
        expiresAt: paymentData.expiresAt
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    console.error("Falha interna na função do Cloudflare Pages:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno no servidor Cloudflare.", details: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
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
  const clientId = (
    context.env.PICPAY_CLIENT_ID ||
    context.env.CLIENT_ID ||
    context.env.PICPAY_TOKEN ||
    ""
  ).trim();

  const hasClientSecret = Boolean(
    context.env.PICPAY_CLIENT_SECRET || context.env.CLIENT_SECRET
  );

  const sellerToken = (context.env.PICPAY_SELLER_TOKEN || "").trim();

  return new Response(
    JSON.stringify({
      status: "online",
      message: "Diagnóstico da API PicPay no Cloudflare Pages",
      config: {
        CLIENT_ID_DETECTADO: clientId ? `${clientId.slice(0, 8)}... (OK)` : "AUSENTE",
        CLIENT_SECRET_DETECTADO: hasClientSecret ? "Configurado com sucesso (OK)" : "FALTANDO (Cadastre PICPAY_CLIENT_SECRET no Cloudflare)",
        SELLER_TOKEN: sellerToken ? "Configurado (Opcional)" : "Não informado"
      },
      instrucao: hasClientSecret 
        ? "Tudo pronto! Se você acabou de salvar as variáveis, lembre-se de ir na aba Implantações e clicar em Reimplantar." 
        : "ATENÇÃO: Você precisa cadastrar a variável PICPAY_CLIENT_SECRET no Cloudflare Pages e fazer o Redeploy."
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

    // Identificação flexível das credenciais nas variáveis de ambiente da Cloudflare
    const clientId = (
      context.env.PICPAY_CLIENT_ID ||
      context.env.CLIENT_ID ||
      context.env.PICPAY_CLIENTID ||
      // Se PICPAY_TOKEN foi preenchido com o Client ID:
      context.env.PICPAY_TOKEN ||
      ""
    ).trim();

    const clientSecret = (
      context.env.PICPAY_CLIENT_SECRET ||
      context.env.CLIENT_SECRET ||
      context.env.PICPAY_CLIENTSECRET ||
      ""
    ).trim();

    const sellerToken = (context.env.PICPAY_SELLER_TOKEN || "").trim();

    // Verificação preventiva contra o erro de token legado:
    if (!clientSecret) {
      return new Response(
        JSON.stringify({ 
          error: `A variável PICPAY_CLIENT_SECRET está ausente ou vazia no Cloudflare Pages! O código '${clientId}' é o seu Client ID, mas o PicPay exige obrigatoriamente o Client Secret para autenticar via OAuth 2.0.` 
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!clientId) {
      return new Response(
        JSON.stringify({ 
          error: "A variável PICPAY_CLIENT_ID não foi encontrada no painel da Cloudflare Pages." 
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    let accessToken = "";

    // Autenticação oficial OAuth 2.0 (PicPay V2)
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
          error: "Falha ao autenticar Client ID e Client Secret no PicPay. Verifique se o segredo não expirou ou foi digitado com erro.", 
          details: authErr 
        }),
        { status: 401, headers: corsHeaders }
      );
    }

    const authData = await authResponse.json();
    accessToken = authData.access_token;

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

    // Montagem dos cabeçalhos da requisição oficial PicPay V2
    const paymentHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`
    };

    if (sellerToken) {
      paymentHeaders["x-seller-token"] = sellerToken;
    }

    // Chamada à API oficial V2 do PicPay
    const paymentResponse = await fetch("https://api.picpay.com/ecommerce/v2/payments", {
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
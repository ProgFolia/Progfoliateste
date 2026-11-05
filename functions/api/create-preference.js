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

  const clientSecret = (
    context.env.PICPAY_CLIENT_SECRET ||
    context.env.CLIENT_SECRET ||
    ""
  ).trim();

  let testResult = "Não testado (credenciais incompletas)";

  if (clientId && clientSecret) {
    try {
      const authTest = await fetch("https://ecommerce-api.svc.picpay.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret
        })
      });

      if (authTest.ok) {
        testResult = "CONECTADO COM SUCESSO! Token gerado no PicPay.";
      } else {
        const errDetail = await authTest.text();
        testResult = `Falha na autenticação com o PicPay: ${errDetail}`;
      }
    } catch (e) {
      testResult = `Erro de rede ao conectar: ${e.message}`;
    }
  }

  return new Response(
    JSON.stringify({
      status: "online",
      message: "Diagnóstico da Conexão PicPay no Cloudflare Pages",
      diagnostico_conexao: testResult,
      configuracao: {
        CLIENT_ID: clientId ? `${clientId.slice(0, 8)}... (Detectado)` : "NÃO CONFIGURADO",
        CLIENT_SECRET: clientSecret ? "Detectado com sucesso" : "NÃO CONFIGURADO"
      },
      instrucao: testResult.includes("CONECTADO") 
        ? "Sua API está 100% pronta para processar vendas de abadás!" 
        : "Cadastre PICPAY_CLIENT_ID e PICPAY_CLIENT_SECRET no Cloudflare Pages e execute um Redeploy."
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
      context.env.PICPAY_TOKEN ||
      ""
    ).trim();

    const clientSecret = (
      context.env.PICPAY_CLIENT_SECRET ||
      context.env.CLIENT_SECRET ||
      ""
    ).trim();

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ 
          error: "Credenciais PICPAY_CLIENT_ID ou PICPAY_CLIENT_SECRET não configuradas no Cloudflare Pages." 
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    let accessToken = "";

    // 1. Autenticação OAuth 2.0 (tenta primeiro o gateway ecommerce-api oficial)
    let authResponse = await fetch("https://ecommerce-api.svc.picpay.com/oauth2/token", {
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

    // Fallback de autorização caso a credencial seja da raiz api.picpay.com
    if (!authResponse.ok) {
      authResponse = await fetch("https://api.picpay.com/oauth2/token", {
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
    }

    if (!authResponse.ok) {
      const authErr = await authResponse.text();
      console.error("Erro na autenticação PicPay OAuth:", authErr);
      return new Response(
        JSON.stringify({ 
          error: "Falha ao autenticar credenciais no PicPay. Verifique Client ID e Client Secret.", 
          details: authErr 
        }),
        { status: 401, headers: corsHeaders }
      );
    }

    const authData = await authResponse.json();
    accessToken = authData.access_token;

    // Cálculo do valor total somando itens e sob encomenda
    const totalAmount = items.reduce((sum, item) => {
      return sum + (Number(item.unitPrice) * Number(item.quantity));
    }, 0);

    // Número do pedido único com até 15 caracteres (exigência do PicPay)
    const referenceId = `PF${Date.now().toString().slice(-10)}`;

    // Data de expiração (7 dias) no formato YYYY-MM-DD
    const expDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expDateYMD = expDate.toISOString().split("T")[0];

    // =========================================================================
    // API OFICIAL DE LINK DE PAGAMENTO / GATEWAY PICPAY
    // Aceita exatamente Client ID + Client Secret e gera a tela com PIX e Cartão
    // =========================================================================
    const paymentLinkPayload = {
      charge: {
        name: "Abadá Prog Folia 2027",
        description: `Prog Folia 2027 • Memento Vivere (${items.map(i => `${i.quantity}x ${i.size}`).join(', ')})`,
        order_number: referenceId,
        redirect_url: "https://progfolia-2027.pages.dev/#sucesso",
        payment: {
          methods: ["BRCODE", "CREDIT_CARD"],
          brcode_arrangements: ["PICPAY", "PIX"]
        },
        amounts: {
          product: Math.round(totalAmount * 100), // Valor em centavos (ex: R$ 45,00 = 4500)
          delivery: 0
        }
      },
      options: {
        allow_create_pix_key: true,
        card_max_installment_number: 12,
        expired_at: expDateYMD
      }
    };

    let paymentUrl = "";
    let qrcodeData = null;

    // Chamada ao endpoint de Link de Pagamento (resolve o erro de Missing required scope)
    const linkResponse = await fetch("https://ecommerce-api.svc.picpay.com/v1/paymentlink/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify(paymentLinkPayload)
    });

    if (linkResponse.ok) {
      const linkData = await linkResponse.json();
      paymentUrl = linkData.link || linkData.deeplink;
      qrcodeData = linkData.brcode ? { content: linkData.brcode } : null;
    } else {
      // Fallback para caso a credencial pertença à Carteira V2 antiga
      const pad = (n) => String(n).padStart(2, '0');
      const expiresAtV2 = `${expDate.getFullYear()}-${pad(expDate.getMonth() + 1)}-${pad(expDate.getDate())}T${pad(expDate.getHours())}:${pad(expDate.getMinutes())}:${pad(expDate.getSeconds())}-03:00`;

      const rawDocument = (buyer?.document || "").replace(/\D/g, "");
      const formattedCpf = rawDocument.length === 11
        ? rawDocument.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
        : rawDocument;

      const rawName = (buyer?.name || "Folião Prog Folia").trim();
      const nameParts = rawName.split(" ");

      const v2Payload = {
        referenceId: referenceId,
        callbackUrl: "https://progfolia-2027.pages.dev/api/callback",
        returnUrl: "https://progfolia-2027.pages.dev/#sucesso",
        value: Number(totalAmount.toFixed(2)),
        expiresAt: expiresAtV2,
        buyer: {
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(" ") || "Capixaba",
          document: formattedCpf
        }
      };

      const v2Response = await fetch("https://api.picpay.com/ecommerce/v2/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify(v2Payload)
      });

      if (!v2Response.ok) {
        const linkErrText = await linkResponse.text();
        const v2ErrText = await v2Response.text();

        let parsedError = null;
        try { parsedError = JSON.parse(linkErrText); } catch (_) {}
        try { if (!parsedError) parsedError = JSON.parse(v2ErrText); } catch (_) {}

        const cleanMsg = parsedError?.errors?.message 
          || parsedError?.message 
          || parsedError?.error 
          || "O PicPay recusou a emissão da cobrança.";

        return new Response(
          JSON.stringify({
            error: cleanMsg,
            details: parsedError || { linkError: linkErrText, v2Error: v2ErrText }
          }),
          { status: 502, headers: corsHeaders }
        );
      }

      const v2Data = await v2Response.json();
      paymentUrl = v2Data.paymentUrl;
      qrcodeData = v2Data.qrcode;
    }

    return new Response(
      JSON.stringify({
        id: referenceId,
        init_point: paymentUrl,
        qrcode: qrcodeData
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
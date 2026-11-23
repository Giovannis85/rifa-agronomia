require('dotenv').config();

const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

/**
 * Cria uma cobrança PIX no Mercado Pago
 */
async function createPixPayment({ orderId, amount, description, buyer, notificationUrl }) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado no .env');
  }

  // Gera um email seguro caso o comprador não informe
  const cleanPhone = (buyer.phone || '').replace(/\D/g, '') || '9999999999';
  const email = (buyer.email && buyer.email.includes('@')) 
    ? buyer.email.trim() 
    : `rifa_${cleanPhone}@agronomiaufpa.com.br`;

  const firstName = (buyer.name || 'Participante').trim().split(' ')[0];
  const lastName = (buyer.name || '').trim().split(' ').slice(1).join(' ') || 'Agronomia';

  const payload = {
    transaction_amount: Number(amount.toFixed(2)),
    description: description || `Rifa 25 Anos Agronomia UFPA - Pedido #${orderId}`,
    payment_method_id: 'pix',
    payer: {
      email,
      first_name: firstName,
      last_name: lastName
    },
    external_reference: orderId
  };

  if (notificationUrl && notificationUrl.startsWith('http')) {
    payload.notification_url = notificationUrl;
  }

  console.log(`[Mercado Pago] Criando PIX de R$ ${amount.toFixed(2)} para ${buyer.name}...`);

  const response = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      'X-Idempotency-Key': `${orderId}-${Date.now()}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Mercado Pago] Erro ao criar PIX:', data);
    throw new Error(data.message || 'Falha ao gerar cobrança PIX no Mercado Pago');
  }

  const transactionData = data.point_of_interaction?.transaction_data;
  const qrCode = transactionData?.qr_code;
  const qrCodeBase64 = transactionData?.qr_code_base64;

  return {
    paymentId: data.id,
    status: data.status,
    statusDetail: data.status_detail,
    qrCode,
    qrCodeBase64,
    ticketUrl: transactionData?.ticket_url
  };
}

/**
 * Consulta o status de um pagamento diretamente no Mercado Pago
 */
async function getPaymentStatus(paymentId) {
  if (!MP_ACCESS_TOKEN) return null;

  try {
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`
      }
    });

    if (!response.ok) {
      console.warn(`[Mercado Pago] Não foi possível consultar pagamento ${paymentId}`);
      return null;
    }

    const data = await response.json();
    return {
      id: data.id,
      status: data.status, // approved, pending, rejected, cancelled
      statusDetail: data.status_detail,
      externalReference: data.external_reference,
      dateApproved: data.date_approved
    };
  } catch (err) {
    console.error('[Mercado Pago] Erro na consulta:', err.message);
    return null;
  }
}

module.exports = {
  createPixPayment,
  getPaymentStatus
};

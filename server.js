require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const mpService = require('./services/mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'agronomia25';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Intervalo a cada 30 segundos para liberar reservas expiradas
setInterval(() => {
  db.cleanupExpiredReservations();
}, 30000);

// --- ROTAS PÚBLICAS ---

// Obter todos os 1000 bilhetes
app.get('/api/tickets', (req, res) => {
  try {
    const tickets = db.getTickets();
    res.json(tickets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter estatísticas gerais
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar pedido, reservar números e gerar PIX
app.post('/api/orders/create', async (req, res) => {
  try {
    const { numbers, buyer } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Nenhum número selecionado' });
    }

    if (!buyer || !buyer.name || !buyer.phone) {
      return res.status(400).json({ error: 'Nome e WhatsApp são obrigatórios' });
    }

    // 1. Reserva os números no banco por 15 minutos
    const reservationMinutes = parseInt(process.env.RESERVATION_MINUTES || '15', 10);
    const reservation = db.reserveTickets(numbers, buyer, reservationMinutes);

    if (!reservation.success) {
      return res.status(400).json({ error: reservation.error });
    }

    const order = reservation.order;

    // 2. Cria o PIX no Mercado Pago
    try {
      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      const notificationUrl = `${baseUrl}/api/webhook/mercadopago`;

      const pixResult = await mpService.createPixPayment({
        orderId: order.id,
        amount: order.total,
        description: `Rifa 25 Anos Agronomia UFPA - ${numbers.length} números: ${numbers.slice(0, 5).join(', ')}${numbers.length > 5 ? '...' : ''}`,
        buyer,
        notificationUrl
      });

      // 3. Salva os dados do PIX no pedido
      db.attachPaymentInfo(order.id, pixResult);

      res.json({
        success: true,
        orderId: order.id,
        numbers: order.numbers,
        total: order.total,
        expiresAt: order.expiresAt,
        payment: {
          paymentId: pixResult.paymentId,
          qrCode: pixResult.qrCode,
          qrCodeBase64: pixResult.qrCodeBase64,
          ticketUrl: pixResult.ticketUrl
        }
      });
    } catch (mpError) {
      console.error('Erro ao integrar com Mercado Pago:', mpError);
      // Se falhar o PIX, cancela a reserva para não prender os números
      db.cancelOrder(order.id);
      return res.status(502).json({
        error: `Não foi possível gerar a cobrança PIX no Mercado Pago: ${mpError.message}. Tente novamente.`
      });
    }
  } catch (err) {
    console.error('Erro geral ao criar pedido:', err);
    res.status(500).json({ error: err.message });
  }
});

// Consultar status do pedido (com verificação automática no Mercado Pago)
app.get('/api/orders/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = db.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    // Se estiver pendente e tiver ID do pagamento, consulta diretamente no Mercado Pago
    if (order.status === 'pending' && order.mpPaymentId) {
      const mpStatus = await mpService.getPaymentStatus(order.mpPaymentId);

      if (mpStatus && mpStatus.status === 'approved') {
        db.confirmPayment(orderId);
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
      }
    }

    res.json({
      orderId: order.id,
      status: order.status, // pending, paid, expired, cancelled
      numbers: order.numbers,
      total: order.total,
      expiresAt: order.expiresAt,
      paidAt: order.paidAt,
      buyer: order.buyer
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook do Mercado Pago (para confirmação instantânea em segundo plano)
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.status(200).send('OK'); // Responde 200 rápido ao Mercado Pago

  try {
    const { type, data, action } = req.body;
    const paymentId = (data && data.id) || req.query['data.id'] || req.query.id;

    if ((type === 'payment' || action === 'payment.updated') && paymentId) {
      console.log(`[Webhook] Recebida atualização do pagamento #${paymentId}`);
      const mpStatus = await mpService.getPaymentStatus(paymentId);

      if (mpStatus && mpStatus.status === 'approved') {
        const orderId = mpStatus.externalReference;
        if (orderId) {
          db.confirmPayment(orderId);
          console.log(`[Webhook] Pagamento do pedido ${orderId} aprovado com sucesso!`);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Erro no processamento:', err.message);
  }
});

// --- ROTAS DO PAINEL ADMIN ---

// Middleware de autenticação admin
function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (!adminKey || adminKey !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha de administrador inválida' });
  }
  next();
}

// Login admin
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Senha incorreta' });
  }
});

// Listar todos os pedidos
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.getAllOrders();
  res.json(orders);
});

// Confirmar pedido manualmente (dinheiro no campus / churrasco)
app.post('/api/admin/orders/:orderId/confirm', requireAdmin, (req, res) => {
  const { orderId } = req.params;
  const result = db.confirmPayment(orderId);
  if (result.success) {
    res.json({ success: true, message: 'Pedido confirmado com sucesso!' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Cancelar pedido e liberar números
app.post('/api/admin/orders/:orderId/cancel', requireAdmin, (req, res) => {
  const { orderId } = req.params;
  const result = db.cancelOrder(orderId);
  if (result.success) {
    res.json({ success: true, message: 'Pedido cancelado e números liberados.' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Exportar compradores para CSV
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const tickets = db.getTickets();
  const paidTickets = tickets.filter(t => t.status === 'paid');

  let csv = 'Numero,Status,Comprador,Telefone_WhatsApp,Data_Pagamento,ID_Pedido\n';
  paidTickets.forEach(t => {
    csv += `"${t.number}","${t.status}","${t.buyerName || ''}","${t.buyerPhone || ''}","${t.paidAt || ''}","${t.orderId || ''}"\n`;
  });

  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('compradores-rifa-agronomia.csv');
  res.send('\uFEFF' + csv);
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🌱 Sistema da Rifa 25 Anos de Agronomia UFPA online!`);
  console.log(`👉 Acesse a Rifa: http://localhost:${PORT}`);
  console.log(`👉 Painel Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Senha do Admin padrão: ${ADMIN_PASSWORD}`);
  console.log(`====================================================`);
});

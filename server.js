require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// Carrega o serviço do Mercado Pago (suporta 'services' ou 'serviços')
let mpService;
if (fs.existsSync(path.join(__dirname, 'services', 'mercadopago.js'))) {
  mpService = require('./services/mercadopago');
} else if (fs.existsSync(path.join(__dirname, 'serviços', 'mercadopago.js'))) {
  mpService = require('./serviços/mercadopago');
} else {
  console.warn('Pasta do mercadopago não encontrada diretamente.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'agronomia25';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Suporta pasta 'public' ou 'público'
const publicPath = fs.existsSync(path.join(__dirname, 'public')) 
  ? path.join(__dirname, 'public') 
  : path.join(__dirname, 'público');
app.use(express.static(publicPath));

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

    const reservationMinutes = parseInt(process.env.RESERVATION_MINUTES || '15', 10);
    const reservation = db.reserveTickets(numbers, buyer, reservationMinutes);

    if (!reservation.success) {
      return res.status(400).json({ error: reservation.error });
    }

    const order = reservation.order;

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

// Consultar status do pedido
app.get('/api/orders/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = db.getOrder(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    if (order.status === 'pending' && order.mpPaymentId && mpService) {
      const mpStatus = await mpService.getPaymentStatus(order.mpPaymentId);

      if (mpStatus && mpStatus.status === 'approved') {
        db.confirmPayment(orderId);
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
      }
    }

    res.json({
      orderId: order.id,
      status: order.status,
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

// Webhook do Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { type, data, action } = req.body;
    const paymentId = (data && data.id) || req.query['data.id'] || req.query.id;

    if ((type === 'payment' || action === 'payment.updated') && paymentId && mpService) {
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

// --- ADMIN ---

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.key;
  if (!adminKey || adminKey !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha de administrador inválida' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Senha incorreta' });
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.getAllOrders();
  res.json(orders);
});

app.post('/api/admin/orders/:orderId/confirm', requireAdmin, (req, res) => {
  const { orderId } = req.params;
  const result = db.confirmPayment(orderId);
  if (result.success) {
    res.json({ success: true, message: 'Pedido confirmado com sucesso!' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post('/api/admin/orders/:orderId/cancel', requireAdmin, (req, res) => {
  const { orderId } = req.params;
  const result = db.cancelOrder(orderId);
  if (result.success) {
    res.json({ success: true, message: 'Pedido cancelado e números liberados.' });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

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

app.listen(PORT, () => {
  console.log(`🌱 Sistema da Rifa 25 Anos de Agronomia UFPA online na porta ${PORT}!`);
});

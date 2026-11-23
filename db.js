const fs = require('fs');
const path = require('path');

const dataDirName = fs.existsSync(path.join(__dirname, 'dados')) ? 'dados' : 'data';
const DB_FILE = path.join(__dirname, dataDirName, 'database.json');

// Garante que o diretório data existe
if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

// Inicializa o banco de dados se não existir
function initDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const tickets = {};
    for (let i = 1; i <= 1000; i++) {
      const numStr = String(i).padStart(3, '0');
      tickets[numStr] = {
        number: numStr,
        status: 'available', // available, reserved, paid
        orderId: null,
        buyerName: null,
        buyerPhone: null,
        reservedAt: null,
        paidAt: null
      };
    }

    const defaultData = {
      tickets,
      orders: {},
      settings: {
        pricePerTicket: 5.00,
        reservationMinutes: 15,
        title: "25 Anos do Curso de Agronomia - UFPA Altamira",
        drawDate: "Sábado, 28/11",
        prizes: [
          { name: "Chaveiro Comemorativo 25 Anos", icon: "🔑" },
          { name: "Bota", icon: "👢" },
          { name: "Chapéu da Agronomia", icon: "🤠" },
          { name: "Canivete", icon: "🔪" },
          { name: "Tesoura de Poda", icon: "✂️" }
        ]
      }
    };

    saveDatabase(defaultData);
    return defaultData;
  }

  return loadDatabase();
}

function loadDatabase() {
  try {
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Erro ao ler banco de dados:', err);
    return initDatabase();
  }
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar banco de dados:', err);
  }
}

// Limpa reservas expiradas automaticamente
function cleanupExpiredReservations() {
  const data = loadDatabase();
  const now = new Date();
  let changed = false;

  for (const [orderId, order] of Object.entries(data.orders)) {
    if (order.status === 'pending' && order.expiresAt) {
      const expireTime = new Date(order.expiresAt);
      if (now > expireTime) {
        order.status = 'expired';
        changed = true;

        // Libera os números associados a este pedido
        order.numbers.forEach(num => {
          if (data.tickets[num] && data.tickets[num].status === 'reserved' && data.tickets[num].orderId === orderId) {
            data.tickets[num] = {
              number: num,
              status: 'available',
              orderId: null,
              buyerName: null,
              buyerPhone: null,
              reservedAt: null,
              paidAt: null
            };
          }
        });
      }
    }
  }

  if (changed) {
    saveDatabase(data);
    console.log('Reservas expiradas foram liberadas automaticamente.');
  }
}

// Obter todos os bilhetes
function getTickets() {
  cleanupExpiredReservations();
  const data = loadDatabase();
  return Object.values(data.tickets).sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));
}

// Obter resumo das estatísticas
function getStats() {
  cleanupExpiredReservations();
  const data = loadDatabase();
  let available = 0;
  let reserved = 0;
  let paid = 0;

  for (const ticket of Object.values(data.tickets)) {
    if (ticket.status === 'available') available++;
    else if (ticket.status === 'reserved') reserved++;
    else if (ticket.status === 'paid') paid++;
  }

  const totalAmountRaised = paid * (data.settings.pricePerTicket || 5.00);

  return {
    total: 1000,
    available,
    reserved,
    paid,
    pricePerTicket: data.settings.pricePerTicket || 5.00,
    totalAmountRaised
  };
}

// Reservar números para um pedido
function reserveTickets(numbers, buyer, minutes = 15) {
  cleanupExpiredReservations();
  const data = loadDatabase();

  // Verifica se todos os números estão disponíveis
  const unavailable = [];
  for (const num of numbers) {
    if (!data.tickets[num] || data.tickets[num].status !== 'available') {
      unavailable.push(num);
    }
  }

  if (unavailable.length > 0) {
    return {
      success: false,
      error: `Os seguintes números não estão mais disponíveis: ${unavailable.join(', ')}`
    };
  }

  const orderId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + minutes * 60000);

  // Reserva cada bilhete
  for (const num of numbers) {
    data.tickets[num] = {
      number: num,
      status: 'reserved',
      orderId,
      buyerName: buyer.name,
      buyerPhone: buyer.phone,
      reservedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      paidAt: null
    };
  }

  const total = numbers.length * (data.settings.pricePerTicket || 5.00);

  data.orders[orderId] = {
    id: orderId,
    numbers,
    total,
    status: 'pending', // pending, paid, expired, cancelled
    buyer,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    paidAt: null,
    mpPaymentId: null,
    qrCode: null,
    qrCodeBase64: null
  };

  saveDatabase(data);

  return {
    success: true,
    order: data.orders[orderId]
  };
}

// Atualizar informações de pagamento do Mercado Pago no pedido
function attachPaymentInfo(orderId, paymentData) {
  const data = loadDatabase();
  if (data.orders[orderId]) {
    data.orders[orderId].mpPaymentId = paymentData.paymentId;
    data.orders[orderId].qrCode = paymentData.qrCode;
    data.orders[orderId].qrCodeBase64 = paymentData.qrCodeBase64;
    saveDatabase(data);
  }
}

// Confirmar pagamento (marcar como PAGO)
function confirmPayment(orderId) {
  const data = loadDatabase();
  const order = data.orders[orderId];

  if (!order) return { success: false, error: 'Pedido não encontrado' };
  if (order.status === 'paid') return { success: true, order, alreadyPaid: true };

  const now = new Date().toISOString();
  order.status = 'paid';
  order.paidAt = now;

  // Atualiza todos os bilhetes para pago
  for (const num of order.numbers) {
    if (data.tickets[num]) {
      data.tickets[num].status = 'paid';
      data.tickets[num].paidAt = now;
      data.tickets[num].buyerName = order.buyer.name;
      data.tickets[num].buyerPhone = order.buyer.phone;
    }
  }

  saveDatabase(data);
  console.log(`✅ Pagamento confirmado para o pedido ${orderId}! Bilhetes: ${order.numbers.join(', ')}`);

  return { success: true, order };
}

// Cancelar pedido manualmente ou liberar
function cancelOrder(orderId) {
  const data = loadDatabase();
  const order = data.orders[orderId];

  if (!order) return { success: false, error: 'Pedido não encontrado' };

  order.status = 'cancelled';

  for (const num of order.numbers) {
    if (data.tickets[num] && data.tickets[num].orderId === orderId) {
      data.tickets[num] = {
        number: num,
        status: 'available',
        orderId: null,
        buyerName: null,
        buyerPhone: null,
        reservedAt: null,
        paidAt: null
      };
    }
  }

  saveDatabase(data);
  return { success: true };
}

// Buscar pedido por ID
function getOrder(orderId) {
  cleanupExpiredReservations();
  const data = loadDatabase();
  return data.orders[orderId] || null;
}

// Buscar todos os pedidos para o painel admin
function getAllOrders() {
  cleanupExpiredReservations();
  const data = loadDatabase();
  return Object.values(data.orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Inicializa no carregamento
initDatabase();

module.exports = {
  getTickets,
  getStats,
  reserveTickets,
  attachPaymentInfo,
  confirmPayment,
  cancelOrder,
  getOrder,
  getAllOrders,
  cleanupExpiredReservations
};

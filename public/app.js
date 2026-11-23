const app = {
  tickets: [],
  selectedNumbers: new Set(),
  activeFilter: 'all',
  searchQuery: '',
  stats: null,
  activeOrder: null,
  pollInterval: null,
  timerInterval: null,

  async init() {
    await this.loadStats();
    await this.loadTickets();
    this.setupAutoRefresh();
  },

  // Busca estatísticas
  async loadStats() {
    try {
      const res = await fetch('/api/stats');
      this.stats = await res.json();
      
      document.getElementById('stat-total').textContent = this.stats.total.toLocaleString();
      document.getElementById('stat-available').textContent = this.stats.available.toLocaleString();
      document.getElementById('stat-reserved').textContent = this.stats.reserved.toLocaleString();
      document.getElementById('stat-paid').textContent = this.stats.paid.toLocaleString();
    } catch (err) {
      console.error('Erro ao carregar estatísticas:', err);
    }
  },

  // Busca todos os bilhetes
  async loadTickets() {
    try {
      const res = await fetch('/api/tickets');
      this.tickets = await res.json();
      this.renderGrid();
    } catch (err) {
      console.error('Erro ao carregar bilhetes:', err);
      document.getElementById('tickets-grid').innerHTML = 
        `<div style="grid-column: 1/-1; text-align: center; color: red; padding: 20px;">
          Falha ao carregar números. Verifique a conexão com o servidor.
        </div>`;
    }
  },

  // Atualização em segundo plano da grade a cada 15 segundos
  setupAutoRefresh() {
    setInterval(() => {
      // Apenas recarrega se não estiver no meio do pagamento do checkout
      if (!this.activeOrder) {
        this.loadStats();
        this.loadTickets();
      }
    }, 15000);
  },

  // Renderiza a grade de números
  renderGrid() {
    const grid = document.getElementById('tickets-grid');
    grid.innerHTML = '';

    const filtered = this.tickets.filter(t => {
      // Filtro de busca
      if (this.searchQuery) {
        if (!t.number.includes(this.searchQuery)) return false;
      }

      // Filtro de status
      if (this.activeFilter === 'available') {
        return t.status === 'available';
      }
      if (this.activeFilter === 'selected') {
        return this.selectedNumbers.has(t.number);
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 30px; color: #6b7280;">Nenhum número encontrado com esse filtro.</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(t => {
      const cell = document.createElement('div');
      cell.className = `ticket-cell ${t.status}`;
      
      if (this.selectedNumbers.has(t.number)) {
        cell.classList.remove('available');
        cell.classList.add('selected');
      }

      cell.textContent = t.number;
      cell.title = `Número ${t.number} - Status: ${this.translateStatus(t.status)}`;

      if (t.status === 'available') {
        cell.onclick = () => this.toggleNumber(t.number);
      }

      fragment.appendChild(cell);
    });

    grid.appendChild(fragment);
    this.updateCheckoutBar();
  },

  translateStatus(status) {
    switch (status) {
      case 'available': return 'Disponível (Livre)';
      case 'reserved': return 'Reservado (Aguardando Pagamento)';
      case 'paid': return 'Pago (Confirmado)';
      default: return status;
    }
  },

  // Alterna seleção de um número
  toggleNumber(num) {
    if (this.selectedNumbers.has(num)) {
      this.selectedNumbers.delete(num);
    } else {
      this.selectedNumbers.add(num);
    }
    this.renderGrid();
  },

  // Escolha Rápida (Surpresinha)
  quickPick(quantity) {
    const availableTickets = this.tickets.filter(t => t.status === 'available' && !this.selectedNumbers.has(t.number));
    
    if (availableTickets.length === 0) {
      this.showToast('Não há mais números livres disponíveis!');
      return;
    }

    // Embaralha
    const shuffled = [...availableTickets].sort(() => 0.5 - Math.random());
    const toPick = shuffled.slice(0, Math.min(quantity, shuffled.length));

    toPick.forEach(t => this.selectedNumbers.add(t.number));
    this.showToast(`✨ ${toPick.length} números da sorte foram selecionados!`);
    this.renderGrid();
  },

  // Limpar seleção
  clearSelection() {
    this.selectedNumbers.clear();
    this.renderGrid();
  },

  // Filtros
  setFilter(filter) {
    this.activeFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    this.renderGrid();
  },

  // Busca
  handleSearch(query) {
    this.searchQuery = query.trim();
    this.renderGrid();
  },

  // Atualiza barra inferior fixa
  updateCheckoutBar() {
    const bar = document.getElementById('checkout-bar');
    const count = this.selectedNumbers.size;
    const price = (this.stats && this.stats.pricePerTicket) || 5.00;
    const total = count * price;

    document.getElementById('filter-selected-count').textContent = count;

    if (count > 0) {
      bar.classList.remove('hidden');
      document.getElementById('bar-selected-count').textContent = count;
      document.getElementById('bar-total-amount').textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
    } else {
      bar.classList.add('hidden');
    }
  },

  // Abre Modal de Checkout
  openCheckoutModal() {
    const count = this.selectedNumbers.size;
    if (count === 0) return;

    const price = (this.stats && this.stats.pricePerTicket) || 5.00;
    const total = count * price;

    document.getElementById('modal-summary-count').textContent = count;
    document.getElementById('modal-summary-total').textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;

    const tagsContainer = document.getElementById('modal-selected-tags');
    tagsContainer.innerHTML = '';
    
    Array.from(this.selectedNumbers).sort().forEach(num => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = num;
      tagsContainer.appendChild(tag);
    });

    document.getElementById('modal-checkout').classList.remove('hidden');
  },

  closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
  },

  // Máscara de telefone
  maskPhone(input) {
    let v = input.value.replace(/\D/g, '');
    if (v.length > 11) v = v.substring(0, 11);
    if (v.length > 10) {
      input.value = `(${v.substring(0,2)}) ${v.substring(2,7)}-${v.substring(7)}`;
    } else if (v.length > 6) {
      input.value = `(${v.substring(0,2)}) ${v.substring(2,6)}-${v.substring(6)}`;
    } else if (v.length > 2) {
      input.value = `(${v.substring(0,2)}) ${v.substring(2)}`;
    } else {
      input.value = v;
    }
  },

  // Submeter pedido e gerar PIX
  async submitOrder(e) {
    e.preventDefault();

    const name = document.getElementById('buyer-name').value.trim();
    const phone = document.getElementById('buyer-phone').value.trim();
    const email = document.getElementById('buyer-email').value.trim();

    if (!name || phone.length < 14) {
      this.showToast('Por favor, informe seu nome completo e WhatsApp com DDD!');
      return;
    }

    const btnSubmit = document.getElementById('btn-submit-order');
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<span>Gerando cobrança PIX...</span> <div class="pulsing-spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;"></div>`;

    try {
      const payload = {
        numbers: Array.from(this.selectedNumbers),
        buyer: { name, phone, email }
      };

      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Erro ao processar reserva');
      }

      this.activeOrder = data;
      this.closeModal('modal-checkout');
      this.openPixModal(data);
      this.loadTickets();
      this.loadStats();

    } catch (err) {
      alert(`Atenção: ${err.message}`);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = `<span>Gerar PIX Mercado Pago</span> <span class="btn-icon">⚡</span>`;
    }
  },

  // Abre tela de PIX com QR Code
  openPixModal(orderData) {
    const modal = document.getElementById('modal-pix');
    document.getElementById('pix-total-amount').textContent = `R$ ${orderData.total.toFixed(2).replace('.', ',')}`;

    // Renderiza QR Code
    const qrContainer = document.getElementById('qrcode-container');
    if (orderData.payment.qrCodeBase64) {
      qrContainer.innerHTML = `<img src="data:image/png;base64,${orderData.payment.qrCodeBase64}" alt="QR Code PIX Mercado Pago">`;
    } else {
      qrContainer.innerHTML = `<p style="padding: 20px;">Use o código Copia e Cola abaixo.</p>`;
    }

    // Código Copia e Cola
    document.getElementById('pix-code-input').value = orderData.payment.qrCode || '';

    // Inicia Cronômetro de 15 minutos
    this.startCountdown(orderData.expiresAt);

    // Inicia verificação automática (polling a cada 3 segundos)
    this.startPaymentPolling(orderData.orderId);

    modal.classList.remove('hidden');
  },

  // Cronômetro regressivo
  startCountdown(expiresAt) {
    if (this.timerInterval) clearInterval(this.timerInterval);

    const target = new Date(expiresAt).getTime();

    const update = () => {
      const now = new Date().getTime();
      const diff = target - now;

      if (diff <= 0) {
        clearInterval(this.timerInterval);
        document.getElementById('pix-timer').textContent = 'Expirado';
        this.closePixModal();
        alert('O tempo de reserva de 15 minutos expirou. Por favor, selecione os números novamente.');
        this.loadTickets();
        return;
      }

      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      document.getElementById('pix-timer').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    update();
    this.timerInterval = setInterval(update, 1000);
  },

  // Consulta status do PIX a cada 3 segundos
  startPaymentPolling(orderId) {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/status`);
        if (!res.ok) return;

        const data = await res.json();

        // Se foi aprovado!
        if (data.status === 'paid') {
          clearInterval(this.pollInterval);
          if (this.timerInterval) clearInterval(this.timerInterval);

          this.closePixModal();
          this.openSuccessModal(data);
          this.selectedNumbers.clear();
          this.loadTickets();
          this.loadStats();
        }
      } catch (err) {
        console.error('Erro na verificação do pagamento:', err);
      }
    }, 3000);
  },

  closePixModal() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.activeOrder = null;
    document.getElementById('modal-pix').classList.add('hidden');
  },

  // Copiar código Copia e Cola
  copyPixCode() {
    const input = document.getElementById('pix-code-input');
    input.select();
    input.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(input.value).then(() => {
      const btnText = document.getElementById('copy-btn-text');
      btnText.textContent = '✅ Copiado!';
      this.showToast('Código PIX Copiado com Sucesso!');
      setTimeout(() => {
        btnText.textContent = 'Copiar Código PIX';
      }, 3000);
    });
  },

  // Abre Modal de Sucesso
  openSuccessModal(orderData) {
    document.getElementById('success-buyer-name').textContent = (orderData.buyer && orderData.buyer.name) || 'Amigo da Agronomia';
    
    const tagsContainer = document.getElementById('success-numbers-list');
    tagsContainer.innerHTML = '';

    orderData.numbers.forEach(num => {
      const tag = document.createElement('span');
      tag.className = 'success-tag';
      tag.textContent = num;
      tagsContainer.appendChild(tag);
    });

    document.getElementById('modal-success').classList.remove('hidden');
  },

  shareWhatsApp() {
    if (!this.activeOrder) return;
    const nums = this.activeOrder.numbers.join(', ');
    const text = encodeURIComponent(`🌱 Olá! Participei da Rifa dos 25 Anos do Curso de Agronomia da UFPA Campus Altamira!\nMeus números da sorte: ${nums}\nParticipe você também!`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  },

  finishSuccess() {
    document.getElementById('modal-success').classList.add('hidden');
    this.activeOrder = null;
    this.selectedNumbers.clear();
    this.loadTickets();
    this.loadStats();
  },

  showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 3500);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  app.init();
});

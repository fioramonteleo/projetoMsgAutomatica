const state = {
  dashboard: null,
  campaigns: [],
  panelKey: sessionStorage.getItem('negao_panel_key') || '',
  serverClockOffsetMs: 0,
};

const $ = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const area = $('toastArea');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' toast-error' : ''}`;
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

async function api(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.panelKey) {
    headers['x-panel-key'] = state.panelKey;
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    $('authGate').classList.remove('hidden');
    throw new Error(data.error || 'Autenticação necessária.');
  }
  if (!res.ok) {
    throw new Error(data.error || 'Erro ao comunicar com o servidor.');
  }
  return data;
}

function switchTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  if (tabName === 'campaigns') loadCampaigns();
  if (tabName === 'history') loadHistory();
  if (tabName === 'optouts') loadOptOuts();
}

function getWhatsAppBadgeClass(status) {
  if (status === 'Conectado') return 'badge-success';
  if (status === 'Aguardando leitura do QR Code') return 'badge-info';
  if (status === 'Conectando' || status === 'Reconectando') return 'badge-warn';
  if (status === 'Erro de conexão') return 'badge-danger';
  return 'badge-neutral';
}

function getHistoryBadgeClass(status) {
  if (status === 'RESPONDIDO') return 'badge-success';
  if (status === 'ERRO') return 'badge-danger';
  if (status === 'AGUARDANDO') return 'badge-info';
  if (status && status.includes('HORÁRIO')) return 'badge-warn';
  return 'badge-neutral';
}

function renderDashboard(data) {
  state.dashboard = data;
  const { whatsapp, bot, stats, time, historyStatuses } = data;

  // Header indicators
  $('headerClock').textContent = time.currentTime;
  const headerBotPill = $('headerBotPill');
  headerBotPill.textContent = `Bot: ${bot.ativo ? 'Ativado' : 'Desativado'}`;
  headerBotPill.className = `status-pill ${bot.ativo ? 'status-success' : 'status-danger'}`;

  const headerWaPill = $('headerWaPill');
  headerWaPill.textContent = `WhatsApp: ${whatsapp.status}`;
  headerWaPill.className = `status-pill ${getWhatsAppBadgeClass(whatsapp.status).replace('badge-', 'status-')}`;

  // Dashboard Connection Card
  const waBadgeClass = getWhatsAppBadgeClass(whatsapp.status);
  $('dashWaBadge').textContent = whatsapp.status;
  $('dashWaBadge').className = `badge ${waBadgeClass}`;
  $('dashWaStatus').textContent = whatsapp.status;
  $('dashWaPhone').textContent = whatsapp.connectedPhoneFormatted || 'Nenhum número conectado';
  $('dashWaLastConn').textContent = whatsapp.lastConnectedAt || 'Nunca conectado';
  $('dashCurrentTime').textContent = time.currentDateTimeBr;

  // Dashboard Bot Card
  $('dashBotBadge').textContent = bot.ativo ? 'Ativado' : 'Desativado';
  $('dashBotBadge').className = `badge ${bot.ativo ? 'badge-success' : 'badge-danger'}`;
  $('dashBotStatus').textContent = bot.ativo ? 'Ativado (Monitorando mensagens)' : 'Desativado';
  $('dashActiveCampaign').textContent = bot.campanhaAtiva ? bot.campanhaAtiva.nome : 'Nenhuma campanha ativa';
  $('dashAllowedHours').textContent = `${bot.horarioPermitido} (${time.timezone})`;
  $('dashNextWindow').textContent = bot.proximaAbertura;

  // Dashboard Buttons enable/disable
  $('btnActivateBot').disabled = bot.ativo;
  $('btnDeactivateBot').disabled = !bot.ativo;

  // Dashboard Stats
  $('statsRefDate').textContent = stats.dataReferencia;
  $('statRepliesToday').textContent = stats.totalRespostasHoje;
  $('statPhonesToday').textContent = stats.totalNumerosRespondidosHoje;
  $('statTotalReceived').textContent = stats.totalMensagensRecebidas;
  $('statIgnoredLimit').textContent = stats.totalIgnoradasLimiteDiario;
  $('statIgnoredHours').textContent = stats.totalIgnoradasHorario;
  $('statErrors').textContent = stats.totalErros;

  // Message preview on dashboard
  $('dashMessagePreview').textContent = bot.campanhaAtiva
    ? bot.campanhaAtiva.mensagem
    : 'Nenhuma campanha ativa. Crie ou ative uma campanha na aba Campanhas.';

  // WhatsApp Connection Screen
  renderWhatsAppScreen(whatsapp);

  // Populate history status dropdown once
  const statusSelect = $('filterStatus');
  if (statusSelect && statusSelect.options.length <= 1 && Array.isArray(historyStatuses)) {
    for (const st of historyStatuses) {
      const opt = document.createElement('option');
      opt.value = st;
      opt.textContent = st;
      statusSelect.appendChild(opt);
    }
  }
}

function renderWhatsAppScreen(whatsapp) {
  const badgeClass = getWhatsAppBadgeClass(whatsapp.status);
  $('waScreenBadge').textContent = whatsapp.status;
  $('waScreenBadge').className = `badge ${badgeClass}`;
  $('waScreenStatus').textContent = whatsapp.status;
  $('waScreenPhone').textContent = whatsapp.connectedPhoneFormatted || 'Nenhum número conectado';
  $('waScreenLastConn').textContent = whatsapp.lastConnectedAt || 'Nunca conectado';
  $('waScreenSavedSession').textContent = whatsapp.hasSavedSession ? 'Sim (armazenada com segurança no servidor)' : 'Não';

  const errBox = $('waErrorBox');
  if (whatsapp.lastError) {
    errBox.textContent = whatsapp.lastError;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }

  const qrBox = $('qrBox');
  if (whatsapp.status === 'Aguardando leitura do QR Code' && whatsapp.qrDataUrl) {
    qrBox.innerHTML = `<img src="${whatsapp.qrDataUrl}" alt="QR Code WhatsApp Negão Lanches" />`;
  } else if (whatsapp.status === 'Conectado') {
    qrBox.innerHTML = `<div><p><strong>WhatsApp conectado com sucesso!</strong></p><p class="muted">Número: ${escapeHtml(whatsapp.connectedPhoneFormatted || '')}</p></div>`;
  } else if (whatsapp.status === 'Conectando' || whatsapp.status === 'Reconectando') {
    qrBox.innerHTML = `<p class="muted">${escapeHtml(whatsapp.status)}... Aguarde alguns segundos.</p>`;
  } else {
    qrBox.innerHTML = `<p class="muted">Clique em <strong>Gerar QR / Conectar</strong> para iniciar a conexão e exibir o QR Code.</p>`;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  renderDashboard(data);
}

async function loadCampaigns() {
  const { campaigns } = await api('/api/campaigns');
  state.campaigns = campaigns;

  // Also refresh campaign filter select in History tab
  const select = $('filterCampaign');
  const currentVal = select.value;
  select.innerHTML = '<option value="">Todas as campanhas</option>';
  for (const c of campaigns) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = `${c.nome} (${c.status})`;
    select.appendChild(opt);
  }
  select.value = currentVal;

  const container = $('campaignsList');
  if (!campaigns.length) {
    container.innerHTML = '<p class="muted">Nenhuma campanha cadastrada.</p>';
    return;
  }

  container.innerHTML = campaigns
    .map((c) => {
      const isActive = c.status === 'ATIVA';
      return `
        <article class="campaign-card ${isActive ? 'is-active' : ''}">
          <div class="campaign-title-row">
            <h4>${escapeHtml(c.nome)}</h4>
            <span class="badge ${isActive ? 'badge-success' : 'badge-neutral'}">${escapeHtml(c.status)}</span>
          </div>
          <div class="campaign-meta">
            <span><strong>Horário:</strong> ${escapeHtml(c.horario_inicio)} às ${escapeHtml(c.horario_fim)}</span>
            <span><strong>Criação:</strong> ${escapeHtml(c.data_criacao || '-')}</span>
            <span><strong>Ativação:</strong> ${escapeHtml(c.data_ativacao || 'Nunca ativada')}</span>
            <span><strong>Números respondidos:</strong> ${c.total_numeros_respondidos || 0} (total envios: ${c.total_respostas || 0})</span>
          </div>
          <div class="campaign-msg-snippet">${escapeHtml(c.mensagem)}</div>
          <div class="campaign-actions">
            <button class="btn btn-sm btn-outline" data-action="preview" data-id="${c.id}">Visualizar</button>
            <button class="btn btn-sm btn-brown" data-action="edit" data-id="${c.id}">Editar</button>
            ${
              isActive
                ? `<button class="btn btn-sm btn-danger" data-action="deactivate" data-id="${c.id}">Desativar</button>`
                : `<button class="btn btn-sm btn-success" data-action="activate" data-id="${c.id}">Ativar</button>`
            }
          </div>
        </article>
      `;
    })
    .join('');
}

async function loadHistory() {
  const params = new URLSearchParams();
  if ($('filterDate').value) params.set('data', $('filterDate').value);
  if ($('filterPhone').value.trim()) params.set('telefone', $('filterPhone').value.trim());
  if ($('filterCampaign').value) params.set('campanhaId', $('filterCampaign').value);
  if ($('filterStatus').value) params.set('status', $('filterStatus').value);

  const { items } = await api(`/api/history?${params.toString()}`);
  const tbody = $('historyTableBody');

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted center">Nenhum registro encontrado para os filtros selecionados.</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.telefone_formatado)}</strong></td>
        <td>${escapeHtml(item.data_mensagem || '-')}</td>
        <td>${escapeHtml(item.horario_mensagem || '-')}</td>
        <td>${escapeHtml(item.data_resposta_dia || '-')}</td>
        <td>${escapeHtml(item.horario_resposta || '-')}</td>
        <td>${escapeHtml(item.campanha_nome || '-')}</td>
        <td><span class="badge ${getHistoryBadgeClass(item.status)}">${escapeHtml(item.status)}</span></td>
        <td class="muted">${escapeHtml(item.descricao || '')}</td>
      </tr>
    `)
    .join('');
}

async function loadOptOuts() {
  const { items } = await api('/api/opt-outs');
  const tbody = $('optOutTableBody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted center">Nenhum contato bloqueado.</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.telefone)}</strong></td>
        <td>${escapeHtml(item.motivo || '-')}</td>
        <td>${escapeHtml(item.criado_em || '-')}</td>
        <td>
          <button class="btn btn-sm btn-outline" data-remove-optout="${escapeHtml(item.telefone)}">Desbloquear</button>
        </td>
      </tr>
    `)
    .join('');
}

function openCampaignModal(campaign = null) {
  const isNew = !campaign;
  $('campaignModalTitle').textContent = isNew ? 'Nova Campanha' : 'Editar Campanha e Mensagem';
  $('campaignIdInput').value = isNew ? '' : String(campaign.id);
  $('campaignNameInput').value = isNew ? '' : campaign.nome;
  $('campaignStartInput').value = isNew ? '17:00' : campaign.horario_inicio;
  $('campaignEndInput').value = isNew ? '00:00' : campaign.horario_fim;
  $('campaignMessageInput').value = isNew
    ? 'Olá! Aqui é do Negão Lanches!\n\n'
    : campaign.mensagem;
  $('campaignModalPreview').textContent = $('campaignMessageInput').value;

  const activateRow = $('activateOnCreateRow');
  if (isNew) {
    activateRow.classList.remove('hidden');
    $('campaignActivateCheckbox').checked = true;
  } else {
    activateRow.classList.add('hidden');
  }

  $('campaignModal').classList.remove('hidden');
}

function openPreviewModal(campaign) {
  if (!campaign) {
    showToast('Nenhuma campanha ativa encontrada para visualizar.', true);
    return;
  }
  $('previewModalTitle').textContent = `Pré-visualização — ${campaign.nome}`;
  $('previewModalMeta').textContent = `Horário permitido: ${campaign.horario_inicio} às ${campaign.horario_fim} (America/Sao_Paulo)`;
  $('previewModalBubble').textContent = campaign.mensagem;
  $('previewModal').classList.remove('hidden');
}

function setupModalClosers() {
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $(btn.dataset.closeModal).classList.add('hidden');
    });
  });
}

function connectSSE() {
  const query = state.panelKey ? `?panelKey=${encodeURIComponent(state.panelKey)}` : '';
  const es = new EventSource(`/api/events${query}`);

  es.addEventListener('whatsapp_status', (ev) => {
    const whatsapp = JSON.parse(ev.data);
    if (state.dashboard) {
      state.dashboard.whatsapp = whatsapp;
      renderDashboard(state.dashboard);
    } else {
      renderWhatsAppScreen(whatsapp);
    }
  });

  es.addEventListener('dashboard_update', () => {
    loadDashboard().catch(() => {});
    const activeTab = document.querySelector('.nav-tab.active')?.dataset?.tab;
    if (activeTab === 'history') loadHistory().catch(() => {});
    if (activeTab === 'campaigns') loadCampaigns().catch(() => {});
  });
}

function bindEvents() {
  // Tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Dashboard Action Buttons
  $('btnConnectWa').addEventListener('click', async () => {
    switchTab('whatsapp');
    try {
      const wa = await api('/api/whatsapp/connect', { method: 'POST' });
      renderWhatsAppScreen(wa);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btnActivateBot').addEventListener('click', async () => {
    try {
      const data = await api('/api/bot/activate', { method: 'POST' });
      renderDashboard(data);
      showToast('Bot ativado! Monitorando mensagens recebidas.');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btnDeactivateBot').addEventListener('click', async () => {
    try {
      const data = await api('/api/bot/deactivate', { method: 'POST' });
      renderDashboard(data);
      showToast('Bot desativado. Nenhuma resposta automática será enviada.');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  const editActiveHandler = () => {
    const active = state.dashboard?.bot?.campanhaAtiva;
    if (active) {
      openCampaignModal(active);
    } else {
      showToast('Nenhuma campanha ativa. Crie ou ative uma campanha.', true);
      switchTab('campaigns');
    }
  };
  $('btnEditMessage').addEventListener('click', editActiveHandler);
  $('btnDashEditMsgInline').addEventListener('click', editActiveHandler);

  $('btnPreviewMessage').addEventListener('click', () => {
    openPreviewModal(state.dashboard?.bot?.campanhaAtiva);
  });

  $('btnManageCampaigns').addEventListener('click', () => switchTab('campaigns'));
  $('btnConsultHistory').addEventListener('click', () => switchTab('history'));

  // WhatsApp tab buttons
  $('waBtnConnect').addEventListener('click', async () => {
    try {
      const wa = await api('/api/whatsapp/connect', { method: 'POST' });
      renderWhatsAppScreen(wa);
      showToast('Conexão com WhatsApp iniciada.');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('waBtnDisconnect').addEventListener('click', async () => {
    try {
      const wa = await api('/api/whatsapp/disconnect', {
        method: 'POST',
        body: JSON.stringify({ logout: false }),
      });
      renderWhatsAppScreen(wa);
      showToast('WhatsApp desconectado (sessão preservada).');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('waBtnLogout').addEventListener('click', async () => {
    if (!confirm('Deseja encerrar a sessão salva e exigir um novo QR Code na próxima conexão?')) {
      return;
    }
    try {
      const wa = await api('/api/whatsapp/disconnect', {
        method: 'POST',
        body: JSON.stringify({ logout: true }),
      });
      renderWhatsAppScreen(wa);
      showToast('Sessão encerrada com segurança.');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Campaigns
  $('btnNewCampaign').addEventListener('click', () => openCampaignModal(null));
  $('campaignMessageInput').addEventListener('input', (e) => {
    $('campaignModalPreview').textContent = e.target.value;
  });

  $('campaignForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('campaignIdInput').value;
    const payload = {
      nome: $('campaignNameInput').value,
      horario_inicio: $('campaignStartInput').value,
      horario_fim: $('campaignEndInput').value,
      mensagem: $('campaignMessageInput').value,
      ativar: $('campaignActivateCheckbox').checked,
    };

    try {
      if (id) {
        await api(`/api/campaigns/${id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showToast('Campanha atualizada com sucesso.');
      } else {
        await api('/api/campaigns', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast('Campanha criada com sucesso.');
      }
      $('campaignModal').classList.add('hidden');
      await Promise.all([loadDashboard(), loadCampaigns()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('campaignsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const campaign = state.campaigns.find((c) => c.id === id);
    const action = btn.dataset.action;

    try {
      if (action === 'preview') {
        openPreviewModal(campaign);
      } else if (action === 'edit') {
        openCampaignModal(campaign);
      } else if (action === 'activate') {
        await api(`/api/campaigns/${id}/activate`, { method: 'POST' });
        showToast('Campanha ativada!');
        await Promise.all([loadDashboard(), loadCampaigns()]);
      } else if (action === 'deactivate') {
        await api(`/api/campaigns/${id}/deactivate`, { method: 'POST' });
        showToast('Campanha desativada.');
        await Promise.all([loadDashboard(), loadCampaigns()]);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // History filters
  $('historyFilterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loadHistory().catch((err) => showToast(err.message, true));
  });

  $('btnClearFilters').addEventListener('click', () => {
    $('filterDate').value = '';
    $('filterPhone').value = '';
    $('filterCampaign').value = '';
    $('filterStatus').value = '';
    loadHistory().catch((err) => showToast(err.message, true));
  });

  $('btnRefreshHistory').addEventListener('click', () => {
    loadHistory().catch((err) => showToast(err.message, true));
  });

  // Opt-outs
  $('optOutForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/opt-outs', {
        method: 'POST',
        body: JSON.stringify({
          telefone: $('optOutPhoneInput').value,
          motivo: $('optOutReasonInput').value || 'Bloqueado manualmente no painel',
        }),
      });
      $('optOutPhoneInput').value = '';
      $('optOutReasonInput').value = '';
      showToast('Número bloqueado.');
      await loadOptOuts();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('optOutTableBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-remove-optout]');
    if (!btn) return;
    try {
      await api(`/api/opt-outs/${encodeURIComponent(btn.dataset.removeOptout)}`, {
        method: 'DELETE',
      });
      showToast('Número desbloqueado.');
      await loadOptOuts();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Panel Auth Gate
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('authKeyInput').value.trim();
    try {
      await api('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      state.panelKey = key;
      sessionStorage.setItem('negao_panel_key', key);
      $('authGate').classList.add('hidden');
      $('authError').classList.add('hidden');
      await initPanel();
    } catch (err) {
      $('authError').textContent = err.message;
      $('authError').classList.remove('hidden');
    }
  });
}

async function initPanel() {
  await Promise.all([loadDashboard(), loadCampaigns()]);
  connectSSE();
  // Keep backend Sao Paulo clock and window status synced every 15s
  setInterval(() => {
    loadDashboard().catch(() => {});
  }, 15000);
}

async function bootstrap() {
  setupModalClosers();
  bindEvents();

  const authStatus = await fetch('/api/auth/status').then((r) => r.json());
  if (authStatus.requiresKey && !state.panelKey) {
    $('authGate').classList.remove('hidden');
    return;
  }

  try {
    await initPanel();
  } catch (err) {
    if (!$('authGate').classList.contains('hidden')) return;
    showToast(err.message, true);
  }
}

bootstrap();

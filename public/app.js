// ==========================================================================
// CLIENT CONTROLLER & HASH ROUTER (SPHINX PORTAL)
// ==========================================================================

const API_BASE = '/api';
let token = localStorage.getItem('sphinx-token');
let currentUser = JSON.parse(localStorage.getItem('sphinx-user') || 'null');

// DOM Elements
const authPage = document.getElementById('auth-page');
const appLayout = document.getElementById('app-layout');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginErrorBanner = document.getElementById('login-error-banner');
const profileMenuTrigger = document.getElementById('profile-menu-trigger');
const profileMenu = document.getElementById('profile-menu');
const profileInitials = document.getElementById('profile-initials');
const profileMenuName = document.getElementById('profile-menu-name');
const profileMenuEmail = document.getElementById('profile-menu-email');
const logoutBtn = document.getElementById('logout-btn');

// Status banners
const apiSuccessBanner = document.getElementById('api-success-banner');
const apiErrorBanner = document.getElementById('api-error-banner');
const hitCaughtBanner = document.getElementById('hit-caught-banner');
const hitCaughtText = document.getElementById('hit-caught-text');

// State Variables
let taskTypesList = [];
let voiceAlertsActive = true;
let socket = null;
let reconnectInterval = null;
let currentRdpStats = {};
let alertsCount = 0;

// Speech synthesis alert
function playVoiceAlert(text) {
  if (!voiceAlertsActive) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find(voice => voice.lang.startsWith('en-') && voice.name.includes('Google'));
    if (englishVoice) utterance.voice = englishVoice;
    
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.error('Failed to play speech synthesized alert:', error);
  }
}

// Chime Audio alert (Web Audio API)
function playChime() {
  if (!voiceAlertsActive) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, startTime, duration) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(0.08, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    
    const now = audioCtx.currentTime;
    playTone(523.25, now, 0.4);       // C5
    playTone(659.25, now + 0.1, 0.4); // E5
    playTone(783.99, now + 0.2, 0.6); // G5
  } catch (e) {
    console.error(e);
  }
}

// Trigger initial voice load
window.speechSynthesis?.getVoices();

// ==========================================================================
// REST API CLIENT UTILITY (V MODULE REPLICATION)
// ==========================================================================
async function fetchAPI(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const config = {
    ...options,
    headers: {
      ...headers,
      ...options.headers
    }
  };
  
  try {
    const response = await fetch(url, config);
    if (response.status === 204) return null;
    
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || 'API request failed');
    }
    return data;
  } catch (error) {
    console.error(`[API Error] ${endpoint}:`, error);
    showBanner(apiErrorBanner, error.message);
    throw error;
  }
}

function showBanner(bannerElement, message, duration = 4000) {
  bannerElement.textContent = message;
  bannerElement.style.display = 'block';
  setTimeout(() => {
    bannerElement.style.display = 'none';
  }, duration);
}

// ==========================================================================
// ROUTER & MENU NAVIGATION CONTROLLER
// ==========================================================================
const routes = {
  '#/home': viewHome,
  '#/dashboard-status': viewDashboardStatus,
  '#/accounts': viewAccountsList,
  '#/accounts/add': viewAccountAdd,
  '#/accounts/edit': viewAccountEdit,
  '#/tasktypes': viewTaskTypesList,
  '#/tasktypes/add': viewTaskTypeAdd,
  '#/taskgroup': viewTaskGroupSettings,
  '#/my-hits': viewHitsList,
  '#/users/list': viewUsersList,
  '#/users/add': viewUserAdd,
  '#/users/edit': viewUserEdit,
  '#/accounts-status': viewAccountsStatusList,
  '#/delete-by-date': viewDeleteByDate
};

function router() {
  const hash = window.location.hash || '#/home';
  console.log('[Router] Active Hash:', hash);
  
  // 1. Session check: redirect to login if no token
  if (!token) {
    authPage.style.display = 'grid';
    appLayout.style.display = 'none';
    return;
  }
  
  authPage.style.display = 'none';
  appLayout.style.display = 'flex';
  
  // Update Profile details
  if (currentUser) {
    profileInitials.textContent = currentUser.name.charAt(0).toUpperCase();
    profileMenuName.textContent = currentUser.name;
    profileMenuEmail.textContent = currentUser.email;
  }

  // 2. Hide all tab views
  document.querySelectorAll('.tab-view').forEach(view => {
    view.style.display = 'none';
  });

  // 3. Highlight active nav menu
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    link.classList.remove('active');
    
    // Exact path matching
    const href = link.getAttribute('href');
    if (hash === href) {
      link.classList.add('active');
    }
    // Sub-item group highlights
    else if (href && hash.startsWith(href) && href !== '#/home' && href !== '#/accounts' && href !== '#/tasktypes' && href !== '#/users/list') {
      link.classList.add('active');
    }
  });

  // Specific parent links highlights
  if (hash.startsWith('#/accounts')) {
    document.getElementById('nav-accounts').classList.add('active');
  } else if (hash.startsWith('#/tasktypes')) {
    document.getElementById('nav-tasktypes').classList.add('active');
  } else if (hash.startsWith('#/users')) {
    document.getElementById('nav-users').classList.add('active');
  }

  // 4. Load matching view function
  // Strip out query params / IDs for routing checks (e.g. #/accounts/edit/123)
  let routeKey = hash;
  if (hash.includes('/edit/')) {
    routeKey = hash.split('/edit/')[0] + '/edit';
  }
  
  const viewFn = routes[routeKey];
  if (viewFn) {
    viewFn();
  } else {
    // Default fallback
    viewHome();
  }
}

// Listen to Hash Changes
window.addEventListener('hashchange', router);

// ==========================================================================
// WEBSOCKET LOGIC (FOR REAL-TIME UPDATES & VOICE NOTIFICATIONS)
// ==========================================================================
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}?type=dashboard`;

  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    console.log('[Socket] Connected to Live Feed WebSocket');
    const srvDot = document.getElementById('server-status-dot');
    const srvText = document.getElementById('server-status-text');
    if (srvDot) {
      srvDot.className = 'status-indicator-dot online';
      srvText.textContent = 'Synchronized with database';
    }
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[Socket Message]:', data);

      if (data.type === 'refresh') {
        // Trigger reload on active tab view
        router();
      } 
      
      else if (data.type === 'worker_status' || data.type === 'worker_update') {
        // Cache stats updates
        currentRdpStats[data.worker.rdpName] = data.worker;
        
        // Auto-refresh Home or Dashboard views if they are open
        const hash = window.location.hash;
        if (hash === '#/home' || hash === '#/dashboard-status' || hash === '#/accounts-status') {
          router();
        }
      } 
      
      else if (data.type === 'hit_alert') {
        // Live banner notification
        const msg = `${data.rdpName} caught a HIT paying ${data.notification.payout}!`;
        hitCaughtText.textContent = msg;
        hitCaughtBanner.style.display = 'block';
        
        // Sound and TTS Alerts
        playChime();
        setTimeout(() => playVoiceAlert(`${data.rdpName.replace('-', ' ')} caught a HIT paying ${data.notification.payout}`), 550);
        
        setTimeout(() => {
          hitCaughtBanner.style.display = 'none';
        }, 5000);

        // If All Hits tab is open, reload it
        if (window.location.hash === '#/my-hits' || window.location.hash === '#/home') {
          router();
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket socket message:', err);
    }
  };

  socket.onclose = () => {
    console.warn('[Socket] Disconnected from server. Reconnecting in 3s...');
    const srvDot = document.getElementById('server-status-dot');
    const srvText = document.getElementById('server-status-text');
    if (srvDot) {
      srvDot.className = 'status-indicator-dot offline';
      srvText.textContent = 'Connection lost. Reconnecting...';
    }
    setTimeout(connectWebSocket, 3000);
  };
}

// Toggle Sound preference
const soundToggle = document.getElementById('sound-toggle');
if (soundToggle) {
  soundToggle.addEventListener('change', (e) => {
    voiceAlertsActive = e.target.checked;
  });
}

// ==========================================================================
// VIEW LOADER FUNCTIONS (REST API BINDINGS)
// ==========================================================================

// 1. Home Dashboard View loader
async function viewHome() {
  document.getElementById('view-home').style.display = 'block';
  
  try {
    const data = await fetchAPI('/home');
    const activeStreams = data.processingWorkerIds || [];
    const inactiveStreams = data.expiredWorkerIds || [];
    
    const procEl = document.getElementById('home-processing-text');
    const expEl = document.getElementById('home-expired-text');
    const emailEl = document.getElementById('home-user-email');
    
    if (activeStreams.length === 0) {
      procEl.textContent = 'No processing workers';
      procEl.style.color = '#9e9e9e';
    } else {
      procEl.textContent = activeStreams.join(', ');
      procEl.style.color = '#7465f4';
    }
    
    if (inactiveStreams.length === 0) {
      expEl.textContent = 'No expired workers';
      expEl.style.color = '#9e9e9e';
    } else {
      expEl.textContent = inactiveStreams.join(', ');
      expEl.style.color = '#ef4444';
    }
    
    if (data.email) {
      emailEl.textContent = data.email;
    }
  } catch (err) {
    console.error(err);
  }
}

// 2. Dashboard Status View Loader
async function viewDashboardStatus() {
  document.getElementById('view-dashboard-status').style.display = 'block';
  
  const searchInput = document.getElementById('search-dashboard');
  const query = searchInput.value;
  const tbody = document.getElementById('table-body-dashboard');
  
  try {
    const res = await fetchAPI(`/dashboard?search=${encodeURIComponent(query)}`);
    
    if (!res.items || res.items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="17">No matching worker statistics records found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = res.items.map(item => `
      <tr>
        <td>${item.sNo}</td>
        <td style="font-weight:600; color:var(--heading);">${item.workerName}</td>
        <td>${item.nextPayment}</td>
        <td>${item.lastPayment}</td>
        <td>$${parseFloat(item.paymentAmount).toFixed(2)}</td>
        <td>
          <span style="color: ${item.status.endsWith('-live') ? '#10b981' : '#ef4444'}; font-weight: 600; font-size: 14px; text-transform: lowercase;">
            ${item.status}
          </span>
        </td>
        <td>${item.date}</td>
        <td>${item.subtd}</td>
        <td style="font-weight:600; color:#2fd67a;">${item.apprd}</td>
        <td>${item.rejtd}</td>
        <td>${item.pndng}</td>
        <td>$${item.rewrd}</td>
        <td>$${item.bonus}</td>
        <td style="font-weight:600; color:#7465f4;">$${item.total}</td>
        <td>$${item.erngs}</td>
        <td>${item.ttlAprvd}</td>
        <td class="queue-badge" style="background:#ece9ff; color:#7f7de4; border-color:#dcd8fa;">${item.aprvdRate}</td>
      </tr>
    `).join('');

  } catch (err) {
    console.error(err);
  }
}

// Dashboard search bindings
document.getElementById('search-dashboard').addEventListener('input', viewDashboardStatus);

// 3. Accounts List View Loader
async function viewAccountsList() {
  document.getElementById('view-accounts').style.display = 'block';
  
  const query = document.getElementById('search-accounts').value;
  const tbody = document.getElementById('table-body-accounts');
  
  try {
    const res = await fetchAPI(`/accounts?search=${encodeURIComponent(query)}`);
    
    if (!res.items || res.items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="9">No registered MTurk accounts found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = res.items.map((acc, index) => {
      const activeClass = acc.status === 'Active' ? 'online' : 'offline';
      
      return `
        <tr>
          <td>${index + 1}</td>
          <td style="font-family:monospace; color:#7465f4; font-weight:600;">${acc.workerId}</td>
          <td style="font-weight:600; color:var(--heading);">${acc.workerName}</td>
          <td>${acc.email}</td>
          <td>${acc.nextPayment || '-'}</td>
          <td>${acc.lastPayment || '-'}</td>
          <td>$${parseFloat(acc.paymentAmount || 0).toFixed(2)}</td>
          <td>
            <span class="status-pill ${activeClass}" style="cursor:pointer;" onclick="toggleAccountStatus('${acc._id || acc.id}')">
              <span class="status-dot"></span>${acc.status}
            </span>
          </td>
          <td>
            <div class="action-icons">
              <button class="icon-button edit" onclick="editAccount('${acc._id || acc.id}')">Edit</button>
              <button class="icon-button trash" onclick="deleteAccount('${acc._id || acc.id}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
  }
}
document.getElementById('search-accounts').addEventListener('input', viewAccountsList);

// Toggle account Active/Inactive status
async function toggleAccountStatus(id) {
  try {
    const accountsRes = await fetchAPI('/accounts');
    const account = accountsRes.items.find(a => (a._id === id || a.id === id));
    if (!account) return;
    
    const newStatus = account.status === 'Active' ? 'Inactive' : 'Active';
    await fetchAPI(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...account, status: newStatus })
    });
    
    showBanner(apiSuccessBanner, 'Status updated successfully');
    viewAccountsList();
  } catch (err) {
    console.error(err);
  }
}

// Delete Account
async function deleteAccount(id) {
  if (!confirm('Are you sure you want to delete this MTurk account?')) return;
  try {
    await fetchAPI(`/accounts/${id}`, { method: 'DELETE' });
    showBanner(apiSuccessBanner, 'Account deleted');
    viewAccountsList();
  } catch (err) {
    console.error(err);
  }
}

// Edit Account router trigger
function editAccount(id) {
  window.location.hash = `#/accounts/edit/${id}`;
}

// 4. Add/Edit Account Form view
async function viewAccountAdd() {
  document.getElementById('view-accounts-add').style.display = 'block';
  document.getElementById('account-form-title').textContent = 'Add Account';
  document.getElementById('account-submit-btn').textContent = 'Create';
  document.getElementById('account-form').reset();
  document.getElementById('account-form-id').value = '';
}

async function viewAccountEdit() {
  document.getElementById('view-accounts-add').style.display = 'block';
  document.getElementById('account-form-title').textContent = 'Edit Account';
  document.getElementById('account-submit-btn').textContent = 'Update';
  
  const hash = window.location.hash;
  const id = hash.split('#/accounts/edit/')[1];
  
  try {
    const res = await fetchAPI('/accounts');
    const acc = res.items.find(a => (a._id === id || a.id === id));
    if (!acc) return;
    
    document.getElementById('account-form-id').value = id;
    document.getElementById('acc-workerId').value = acc.workerId;
    document.getElementById('acc-workerName').value = acc.workerName;
    document.getElementById('acc-email').value = acc.email;
    document.getElementById('acc-paymentAmount').value = acc.paymentAmount || 0;
    
    if (acc.lastPayment) document.getElementById('acc-lastPayment').value = acc.lastPayment;
    if (acc.nextPayment) document.getElementById('acc-nextPayment').value = acc.nextPayment;
    
    document.getElementById('acc-status').value = acc.status || 'Active';

  } catch (err) {
    console.error(err);
  }
}

// Account Form submission handler
document.getElementById('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('account-form-id').value;
  
  const payload = {
    workerId: document.getElementById('acc-workerId').value.trim(),
    workerName: document.getElementById('acc-workerName').value.trim(),
    email: document.getElementById('acc-email').value.trim(),
    paymentAmount: parseFloat(document.getElementById('acc-paymentAmount').value) || 0,
    lastPayment: document.getElementById('acc-lastPayment').value,
    nextPayment: document.getElementById('acc-nextPayment').value,
    status: document.getElementById('acc-status').value
  };

  try {
    if (id) {
      // Edit mode
      await fetchAPI(`/accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showBanner(apiSuccessBanner, 'Account updated');
    } else {
      // Add mode
      await fetchAPI('/accounts', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showBanner(apiSuccessBanner, 'Account registered');
    }
    
    window.location.hash = '#/accounts';
  } catch (err) {
    console.error(err);
  }
});

// 5. TaskTypes List View Loader
async function viewTaskTypesList() {
  document.getElementById('view-tasktypes').style.display = 'block';
  const tbody = document.getElementById('table-body-tasktypes');
  
  try {
    const res = await fetchAPI('/tasktypes');
    taskTypesList = res.items || [];
    
    if (taskTypesList.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">No task type categories added.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = taskTypesList.map((type) => {
      const isActive = type.status === 'Active';
      return `
        <tr>
          <td>${type.id}</td>
          <td style="font-weight:600; color:var(--heading);">${type.title}</td>
          <td style="font-family:monospace; color:#5f6368; font-size:13px;">${type.taskUrl || '-'}</td>
          <td>
            <span style="color: ${isActive ? '#10b981' : '#ef4444'}; font-weight:600; font-size:13px;">
              ${type.status || 'Active'}
            </span>
          </td>
          <td>
            <a href="javascript:void(0)" onclick="deleteTaskType(${type.id})" style="color:#ef4444; text-decoration:underline; font-weight:500; font-size:13px;">Delete</a>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
  }
}

// Delete Task Type
async function deleteTaskType(id) {
  if (!confirm(`Are you sure you want to delete this TaskType?`)) return;
  try {
    await fetchAPI(`/tasktypes/${id}`, { method: 'DELETE' });
    showBanner(apiSuccessBanner, 'TaskType deleted');
    viewTaskTypesList();
  } catch (err) {
    console.error(err);
  }
}

// 6. Add TaskType View Loader
function viewTaskTypeAdd() {
  document.getElementById('view-tasktypes-add').style.display = 'block';
  document.getElementById('tasktype-form').reset();
}

document.getElementById('tasktype-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('tasktype-title').value.trim();
  const taskUrl = document.getElementById('tasktype-url').value.trim();
  const status = document.getElementById('tasktype-status').value.trim();
  
  try {
    await fetchAPI('/tasktypes', {
      method: 'POST',
      body: JSON.stringify({ title, taskUrl, status })
    });
    showBanner(apiSuccessBanner, 'TaskType created');
    window.location.hash = '#/tasktypes';
  } catch (err) {
    console.error(err);
  }
});

// 7. TaskGroup Configuration Settings Loader
async function viewTaskGroupSettings() {
  document.getElementById('view-taskgroup').style.display = 'block';
  
  // Fill dropdown select elements first
  try {
    const typesRes = await fetchAPI('/tasktypes');
    taskTypesList = typesRes.items || [];
    
    const selects = ['taskgroup-url1Name', 'taskgroup-url2Name', 'taskgroup-url3Name', 'taskgroup-url4Name'];
    selects.forEach(id => {
      const el = document.getElementById(id);
      el.innerHTML = '<option value="">Select TaskType</option>' + taskTypesList.map(t => `
        <option value="${t.title}">${t.title}</option>
      `).join('');
    });

    // Fetch active taskgroup config
    const config = await fetchAPI('/taskgroup');
    
    document.getElementById('taskgroup-status-toggle').checked = config.status || false;
    document.getElementById('taskgroup-url1').value = config.url1 || '';
    document.getElementById('taskgroup-url1Name').value = config.url1Name || '';
    document.getElementById('taskgroup-url2').value = config.url2 || '';
    document.getElementById('taskgroup-url2Name').value = config.url2Name || '';
    document.getElementById('taskgroup-url3').value = config.url3 || '';
    document.getElementById('taskgroup-url3Name').value = config.url3Name || '';
    document.getElementById('taskgroup-url4').value = config.url4 || '';
    document.getElementById('taskgroup-url4Name').value = config.url4Name || '';
    document.getElementById('taskgroup-minReward').value = config.minReward || '0.01';
    document.getElementById('taskgroup-interval').value = config.interval || 60;
    document.getElementById('taskgroup-bannedRequesters').value = config.bannedRequesters || '';

  } catch (err) {
    console.error(err);
  }
}

// Taskgroup settings submission handler
document.getElementById('taskgroup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const payload = {
    status: document.getElementById('taskgroup-status-toggle').checked,
    url1: document.getElementById('taskgroup-url1').value.trim(),
    url1Name: document.getElementById('taskgroup-url1Name').value,
    url2: document.getElementById('taskgroup-url2').value.trim(),
    url2Name: document.getElementById('taskgroup-url2Name').value,
    url3: document.getElementById('taskgroup-url3').value.trim(),
    url3Name: document.getElementById('taskgroup-url3Name').value,
    url4: document.getElementById('taskgroup-url4').value.trim(),
    url4Name: document.getElementById('taskgroup-url4Name').value,
    minReward: document.getElementById('taskgroup-minReward').value || '0.01',
    interval: parseInt(document.getElementById('taskgroup-interval').value) || 60,
    bannedRequesters: document.getElementById('taskgroup-bannedRequesters').value.trim()
  };

  try {
    await fetchAPI('/taskgroup', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showBanner(apiSuccessBanner, 'Settings updated successfully');
  } catch (err) {
    console.error(err);
  }
});

// 8. All Hits Caught View Loader
async function viewHitsList() {
  document.getElementById('view-my-hits').style.display = 'block';
  
  const query = document.getElementById('search-hits').value;
  const tbody = document.getElementById('table-body-hits');
  
  try {
    const res = await fetchAPI(`/hits?search=${encodeURIComponent(query)}`);
    
    // Update alert stat counter in Home page cache
    alertsCount = res.items ? res.items.length : 0;
    const homeAlerts = document.getElementById('home-stat-alerts');
    if (homeAlerts) homeAlerts.textContent = alertsCount;

    if (!res.items || res.items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">No caught HITs matching the criteria.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = res.items.map((h, index) => {
      const isComplete = h.status === 'Complete';
      const completeLink = isComplete 
        ? '<span style="color:#10b981; font-weight:600;">Set as Complete</span>'
        : `<a href="javascript:void(0)" onclick="markHitComplete('${h._id || h.id}')" style="color:#10b981; text-decoration:underline; font-weight:500;">Set as Complete</a>`;
      
      const timeStr = h.timeRemaining 
        ? (h.timeRemaining.toLowerCase().includes('remaining') || h.timeRemaining.toLowerCase().includes('complete') ? h.timeRemaining : `${h.timeRemaining} remaining`) 
        : '60 Min remaining';

      return `
        <tr>
          <td>${index + 1}</td>
          <td style="color:#5f6368; font-weight:500;">${h.workerName}</td>
          <td style="font-family:monospace; font-size:13px; color:#3c4043;">${h.task}</td>
          <td>${h.requester}</td>
          <td>${parseFloat(h.reward || 0).toFixed(2)}</td>
          <td>${timeStr}</td>
          <td>
            <div style="display:flex; gap:12px; align-items:center;">
              <a href="${h.task.startsWith('http') ? h.task : 'https://worker.mturk.com/projects'}" target="_blank" style="color:#7465f4; text-decoration:underline; font-weight:500;">Click Here</a>
              ${completeLink}
              <a href="javascript:void(0)" onclick="deleteHit('${h._id || h.id}')" style="color:#ef4444; text-decoration:underline; font-weight:500; font-size:12px; margin-left:8px;">Delete</a>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
  }
}
document.getElementById('search-hits').addEventListener('input', viewHitsList);

function viewHitTask(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  window.open(target, '_blank', 'noopener,noreferrer');
}

async function markHitComplete(id) {
  if (!confirm('Mark this HIT as completed?')) return;
  try {
    await fetchAPI(`/hits/${id}/complete`, { method: 'PATCH' });
    showBanner(apiSuccessBanner, 'HIT status complete');
    viewHitsList();
  } catch (err) {
    console.error(err);
  }
}

async function deleteHit(id) {
  if (!confirm('Are you sure you want to remove this caught HIT record?')) return;
  try {
    await fetchAPI(`/hits/${id}`, { method: 'DELETE' });
    showBanner(apiSuccessBanner, 'HIT record deleted');
    viewHitsList();
  } catch (err) {
    console.error(err);
  }
}

// 9. Users (Employees) List View Loader
async function viewUsersList() {
  document.getElementById('view-users-list').style.display = 'block';
  
  const query = document.getElementById('search-users').value;
  const tbody = document.getElementById('table-body-users');
  
  try {
    const res = await fetchAPI(`/users?search=${encodeURIComponent(query)}`);
    
    if (!res.items || res.items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">No system users found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = res.items.map((u, index) => {
      const isActive = u.status === 'Active';
      
      return `
        <tr>
          <td><input type="checkbox"></td>
          <td style="font-weight:600; color:var(--heading);">${u.name}</td>
          <td>${u.email}</td>
          <td>${u.mobileNumber || '-'}</td>
          <td>
            <span style="color: ${isActive ? '#10b981' : '#ef4444'}; font-weight: 600; font-size: 13px; cursor: pointer;" onclick="toggleUserStatus('${u._id || u.id}')">
              ${u.status || 'Active'}
            </span>
          </td>
          <td>
            <div style="display:flex; gap:12px;">
              <a href="javascript:void(0)" onclick="editUser('${u._id || u.id}')" style="color:#7465f4; text-decoration:underline; font-weight:500; font-size:13px;">Edit</a>
              <a href="javascript:void(0)" onclick="deleteUser('${u._id || u.id}')" style="color:#ef4444; text-decoration:underline; font-weight:500; font-size:13px;">Delete</a>
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
  }
}
document.getElementById('search-users').addEventListener('input', viewUsersList);

// Toggle user status
async function toggleUserStatus(id) {
  try {
    const usersRes = await fetchAPI('/users');
    const user = usersRes.items.find(u => (u._id === id || u.id === id));
    if (!user) return;
    
    const newStatus = user.status === 'Active' ? 'Inactive' : 'Active';
    await fetchAPI(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...user, status: newStatus })
    });
    
    showBanner(apiSuccessBanner, 'User status changed');
    viewUsersList();
  } catch (err) {
    console.error(err);
  }
}

// Delete User
async function deleteUser(id) {
  if (id === currentUser.id || id === currentUser._id) {
    alert('Cannot delete your own logged-in user profile!');
    return;
  }
  if (!confirm('Are you sure you want to delete this user profile?')) return;
  try {
    await fetchAPI(`/users/${id}`, { method: 'DELETE' });
    showBanner(apiSuccessBanner, 'User profile deleted');
    viewUsersList();
  } catch (err) {
    console.error(err);
  }
}

function editUser(id) {
  window.location.hash = `#/users/edit/${id}`;
}

// 10. Add/Edit User View Loader
function viewUserAdd() {
  document.getElementById('view-users-add').style.display = 'block';
  document.getElementById('user-form-title').textContent = 'Add User';
  document.getElementById('user-submit-btn').textContent = 'Create';
  document.getElementById('user-form').reset();
  document.getElementById('user-form-id').value = '';
  document.getElementById('usr-password').required = true;
}

async function viewUserEdit() {
  document.getElementById('view-users-add').style.display = 'block';
  document.getElementById('user-form-title').textContent = 'Edit User';
  document.getElementById('user-submit-btn').textContent = 'Update';
  document.getElementById('usr-password').required = false;
  
  const hash = window.location.hash;
  const id = hash.split('#/users/edit/')[1];
  
  try {
    const res = await fetchAPI('/users');
    const usr = res.items.find(u => (u._id === id || u.id === id));
    if (!usr) return;
    
    document.getElementById('user-form-id').value = id;
    document.getElementById('usr-name').value = usr.name;
    document.getElementById('usr-email').value = usr.email;
    document.getElementById('usr-password').value = ''; // keep empty unless updating
    document.getElementById('usr-mobile').value = usr.mobileNumber || '';
    document.getElementById('usr-address').value = usr.address || '';

  } catch (err) {
    console.error(err);
  }
}

// User Form submission handler
document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('user-form-id').value;
  
  const payload = {
    name: document.getElementById('usr-name').value.trim(),
    email: document.getElementById('usr-email').value.trim(),
    mobileNumber: document.getElementById('usr-mobile').value.trim(),
    address: document.getElementById('usr-address').value.trim(),
    status: 'Active'
  };
  
  const pwd = document.getElementById('usr-password').value;
  if (pwd) {
    payload.password = pwd;
  }

  try {
    if (id) {
      await fetchAPI(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showBanner(apiSuccessBanner, 'User profile updated');
    } else {
      await fetchAPI('/users', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showBanner(apiSuccessBanner, 'User profile created');
    }
    
    window.location.hash = '#/users/list';
  } catch (err) {
    console.error(err);
  }
});

// 11. Accounts Status View Loader (Heartbeats log)
async function viewAccountsStatusList() {
  document.getElementById('view-accounts-status').style.display = 'block';
  
  const query = document.getElementById('search-accounts-status').value;
  const tbody = document.getElementById('table-body-accounts-status');
  
  try {
    const res = await fetchAPI(`/accounts-status?search=${encodeURIComponent(query)}`);
    
    if (!res.items || res.items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="2">No worker connections found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = res.items.map(item => {
      const isOnline = item.status === 'online' || item.status === 'live';
      
      return `
        <tr>
          <td style="font-size: 14px; color: #5f6368; font-weight: 500;">${item.workerId}</td>
          <td>
            <span style="color: ${isOnline ? '#10b981' : '#ef4444'}; font-weight: 600; font-size: 14px; text-transform: lowercase;">
              ${isOnline ? 'live' : 'hacked'}
            </span>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
  }
}
document.getElementById('search-accounts-status').addEventListener('input', viewAccountsStatusList);

// 12. Delete Data by Date View
function viewDeleteByDate() {
  document.getElementById('view-delete-by-date').style.display = 'block';
  document.getElementById('delete-date-form').reset();
}

document.getElementById('delete-date-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = document.getElementById('delete-target-date').value;
  
  if (!confirm(`WARNING: Are you sure you want to permanently delete all logs for ${date}?`)) return;
  
  try {
    const res = await fetchAPI('/delete-by-date', {
      method: 'DELETE',
      body: JSON.stringify({ date })
    });
    
    showBanner(apiSuccessBanner, res.message || 'Records purged');
  } catch (err) {
    console.error(err);
  }
});

// ==========================================================================
// LOGIN & LOGOUT OPERATIONS
// ==========================================================================
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  
  loginErrorBanner.style.display = 'none';

  try {
    const data = await fetchAPI('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    
    // Save Token & User profile
    token = data.token;
    currentUser = data.user;
    
    localStorage.setItem('sphinx-token', token);
    localStorage.setItem('sphinx-user', JSON.stringify(currentUser));
    
    // Clear forms and load router dashboard
    loginForm.reset();
    window.location.hash = '#/home';
    router();
    
    // Connect live alert feed WebSockets
    connectWebSocket();

  } catch (error) {
    loginErrorBanner.textContent = error.message || 'Login failed';
    loginErrorBanner.style.display = 'block';
  }
});

// Profile drop menu toggling
profileMenuTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = profileMenu.style.display === 'none';
  profileMenu.style.display = isHidden ? 'block' : 'none';
});

document.addEventListener('click', () => {
  profileMenu.style.display = 'none';
});

// Logout
logoutBtn.addEventListener('click', () => {
  token = null;
  currentUser = null;
  localStorage.removeItem('sphinx-token');
  localStorage.removeItem('sphinx-user');
  
  // Close socket connection
  if (socket) {
    socket.close();
  }
  
  window.location.hash = '#/login';
  router();
});

// Initial startup script
document.addEventListener('DOMContentLoaded', () => {
  router();
  if (token) {
    connectWebSocket();
  }
});

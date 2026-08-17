const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3010;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Enable CORS for testing
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logger to help debug localtunnel API issues
app.use((req, res, next) => {
  console.log(`[HTTP Request] ${req.method} ${req.path}`);
  next();
});

// Helper to filter caught hits based on active TaskGroup configurations
function shouldRegisterHit(groupId, requester, reward) {
  if (!db.taskgroup) return false;

  // 1. Banned Requesters check (runs first in all cases)
  if (db.taskgroup.bannedRequesters) {
    const bannedList = db.taskgroup.bannedRequesters
      .toLowerCase()
      .split(',')
      .map(r => r.trim())
      .filter(Boolean);
      
    const reqLower = (requester || '').toLowerCase();
    const isBanned = bannedList.some(banned => 
      reqLower === banned || reqLower.includes(banned) || banned.includes(reqLower)
    );
    if (isBanned) {
      console.log(`[WebSocket] Skipping caught HIT (Requester "${requester}" is in banned list)`);
      return false;
    }
  }

  // 2. Pathway 1: Unconditional Target URL/Group ID match
  const targetUrls = [
    db.taskgroup.url1,
    db.taskgroup.url2,
    db.taskgroup.url3,
    db.taskgroup.url4
  ].filter(Boolean).map(u => u.trim());

  const isTargetUrl = targetUrls.some(url => {
    return url === groupId || url.includes(groupId) || groupId.includes(url);
  });

  if (isTargetUrl) {
    return true; // Match unconditionally ("under no objection")
  }

  // Also check if matches target names configured in TaskGroup
  const targetNames = [
    db.taskgroup.url1Name,
    db.taskgroup.url2Name,
    db.taskgroup.url3Name,
    db.taskgroup.url4Name
  ].filter(Boolean).map(n => n.trim().toLowerCase());
  
  const isTargetName = targetNames.some(name => {
    const reqLower = (requester || '').toLowerCase();
    return name === reqLower || reqLower.includes(name) || name.includes(reqLower);
  });

  if (isTargetName) {
    return true;
  }

  // 3. Pathway 2: General Catcher (Satisfies minReward)
  const rewardVal = parseFloat(reward) || 0;
  const minReward = parseFloat(db.taskgroup.minReward || 0);
  
  return rewardVal >= minReward;
}

// ==========================================================================
// LOCAL DATABASE ENGINE (db.json)
// ==========================================================================
let db = {
  users: [
    {
      id: "usr_1",
      _id: "usr_1",
      name: "Administrator",
      email: "testcompany@gmail.com",
      password: "MayohnSphinx2026!",
      mobileNumber: "9988776655",
      address: "Mayohn Command Center, Chennai, India",
      status: "Active"
    }
  ],
  accounts: [
    {
      id: "acc_1",
      _id: "acc_1",
      workerId: "A3ABC123XYZ456",
      workerName: "RDP-Worker-01",
      email: "worker1@mayohn.com",
      nextPayment: new Date(Date.now() + 86400000 * 7).toISOString().split('T')[0], // 7 days later
      lastPayment: new Date().toISOString().split('T')[0],
      paymentAmount: 50.00,
      status: "Active"
    }
  ],
  tasktypes: [],
  taskgroup: {
    status: false,
    url1: "",
    url1Name: "",
    url2: "",
    url2Name: "",
    url3: "",
    url3Name: "",
    url4: "",
    url4Name: "",
    minReward: "0.01",
    interval: 60,
    bannedRequesters: ""
  },
  hits: [],
  accountsStatus: [
    {
      workerId: "A3ABC123XYZ456",
      status: "online",
      lastSeen: Date.now()
    }
  ]
};

let mongoCollection = null;

// Connect to MongoDB if MONGODB_URI is provided
async function connectMongoDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('[DB] No MONGODB_URI environment variable detected. Running with local db.json.');
    loadDB();
    return;
  }

  try {
    console.log('[MongoDB] Connecting to cluster...');
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    
    const mongoDb = client.db('mayohn');
    mongoCollection = mongoDb.collection('store');
    console.log('[MongoDB] Connected successfully');

    // Load database document
    const doc = await mongoCollection.findOne({ _id: 'main_db' });
    if (doc && doc.data) {
      db = { ...db, ...doc.data };
      console.log('[MongoDB] Loaded database state successfully from Atlas');
    } else {
      console.log('[MongoDB] No existing state found, saving initial default database');
      await mongoCollection.updateOne(
        { _id: 'main_db' },
        { $set: { data: db } },
        { upsert: true }
      );
    }
  } catch (err) {
    console.error('[MongoDB] Connection failed, falling back to local db.json:', err);
    loadDB();
  }
}

// Load database from file if exists
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const fileData = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(fileData);
      db = { ...db, ...parsed };
      console.log('[DB] Database loaded successfully from db.json');
    } else {
      saveDB();
    }
  } catch (err) {
    console.error('[DB] Error loading database, using default in-memory db:', err);
  }
}

// Save database to file & MongoDB
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    
    if (mongoCollection) {
      mongoCollection.updateOne(
        { _id: 'main_db' },
        { $set: { data: db } },
        { upsert: true }
      ).catch(err => {
        console.error('[MongoDB] Background sync failed:', err);
      });
    }
  } catch (err) {
    console.error('[DB] Error saving database:', err);
  }
}

connectMongoDB();

// ==========================================================================
// AUTHENTICATION MIDDLEWARE
// ==========================================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ message: 'Authorization token required' });
  
  // Simple token matching: token is "<userId>-token-key"
  const userId = token.split('-')[0];
  const user = db.users.find(u => (u.id === userId || u._id === userId));
  
  if (!user || user.status === 'Inactive') {
    return res.status(403).json({ message: 'Invalid or deactivated user token' });
  }
  
  req.user = user;
  next();
}

// ==========================================================================
// REST API ENDPOINTS
// ==========================================================================

// 1. Auth Endpoints
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  console.log(`[Auth] Login attempt for: ${email}`);
  
  const user = db.users.find(u => u.email === email && u.password === password);
  
  if (!user) {
    return res.status(400).json({ message: 'Invalid email or password' });
  }
  
  if (user.status === 'Inactive') {
    return res.status(403).json({ message: 'Your account is deactivated' });
  }

  // Generate a simple token
  const token = `${user._id || user.id}-token-${Math.random().toString(36).substr(2, 8)}`;
  res.json({
    token,
    user: {
      id: user.id || user._id,
      _id: user._id || user.id,
      name: user.name,
      email: user.email
    }
  });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.id || req.user._id,
      _id: req.user._id || req.user.id,
      name: req.user.name,
      email: req.user.email
    }
  });
});

// 2. Home Dashboard Stats Endpoint
app.get('/api/home', authenticateToken, (req, res) => {
  // Find accounts that are currently online
  const onlineWorkerIds = db.accountsStatus
    .filter(s => s.status === 'online')
    .map(s => s.workerId);
    
  const processingWorkerIds = [];
  const expiredWorkerIds = [];
  
  db.accounts.forEach(acc => {
    if (onlineWorkerIds.includes(acc.workerId)) {
      processingWorkerIds.push(acc.workerId);
    } else {
      expiredWorkerIds.push(acc.workerId);
    }
  });

  res.json({
    processingWorkerIds,
    expiredWorkerIds,
    email: req.user.email
  });
});

// 3. Dashboard Detailed Status Endpoint
app.get('/api/dashboard', authenticateToken, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  
  // Generate mock statistics compiled from accounts and caught hits
  const statsList = db.accounts.map((acc, index) => {
    const onlineStatusObj = db.accountsStatus.find(s => s.workerId === acc.workerId);
    
    let timeStatus = '1h-hacked';
    if (onlineStatusObj) {
      const elapsedMs = Date.now() - onlineStatusObj.lastSeen;
      const minutes = Math.floor(elapsedMs / 60000);
      let timeStr = `${minutes}m`;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        timeStr = `${hours}h`;
      }
      const isOnline = onlineStatusObj.status === 'online' || onlineStatusObj.status === 'live';
      timeStatus = `${timeStr}-${isOnline ? 'live' : 'hacked'}`;
    } else {
      // If never seen but registered, fall back to hacked/offline
      timeStatus = '1h-hacked';
    }
    
    // Calculate compiled hit counts
    const accountHits = db.hits.filter(h => h.workerName === acc.workerName);
    const completedCount = accountHits.filter(h => h.status === 'Complete').length;
    const submittedCount = accountHits.length;
    
    const rewardSum = accountHits.reduce((sum, h) => sum + parseFloat(h.reward || 0), 0);
    const bonusSum = submittedCount > 0 ? (rewardSum * 0.1) : 0;
    
    return {
      sNo: index + 1,
      workerName: acc.workerName,
      nextPayment: acc.nextPayment || '-',
      lastPayment: acc.lastPayment || '-',
      paymentAmount: acc.paymentAmount || 0,
      status: timeStatus,
      date: new Date().toLocaleDateString(),
      subtd: submittedCount,
      apprd: completedCount,
      rejtd: 0,
      pndng: submittedCount - completedCount,
      rewrd: rewardSum.toFixed(2),
      bonus: bonusSum.toFixed(2),
      total: (rewardSum + bonusSum).toFixed(2),
      erngs: (rewardSum + bonusSum).toFixed(2),
      ttlAprvd: completedCount,
      aprvdRate: submittedCount > 0 ? `${Math.round((completedCount / submittedCount) * 100)}%` : '0%'
    };
  });

  // Filter based on search query
  const filtered = statsList.filter(item => 
    item.workerName.toLowerCase().includes(search)
  );

  res.json({ items: filtered });
});

// 4. Accounts CRUD
app.get('/api/accounts', authenticateToken, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const filtered = db.accounts.filter(acc => 
    acc.workerName.toLowerCase().includes(search) || 
    acc.workerId.toLowerCase().includes(search) || 
    acc.email.toLowerCase().includes(search)
  );
  res.json({ items: filtered });
});

app.post('/api/accounts', authenticateToken, (req, res) => {
  const newAccount = {
    ...req.body,
    id: `acc_${Date.now()}`,
    _id: `acc_${Date.now()}`
  };
  
  db.accounts.push(newAccount);
  saveDB();
  res.status(201).json(newAccount);
});

app.put('/api/accounts/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const idx = db.accounts.findIndex(acc => (acc.id === id || acc._id === id));
  
  if (idx === -1) return res.status(404).json({ message: 'Account not found' });
  
  db.accounts[idx] = {
    ...db.accounts[idx],
    ...req.body
  };
  saveDB();
  res.json(db.accounts[idx]);
});

app.delete('/api/accounts/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.accounts = db.accounts.filter(acc => (acc.id !== id && acc._id !== id));
  saveDB();
  res.sendStatus(204);
});

// 5. TaskTypes CRUD
app.get('/api/tasktypes', authenticateToken, (req, res) => {
  res.json({ items: db.tasktypes || [] });
});

app.post('/api/tasktypes', authenticateToken, (req, res) => {
  const { title, taskUrl, status } = req.body;
  if (!title || !taskUrl) {
    return res.status(400).json({ message: 'Title and Task URL are required' });
  }
  
  db.tasktypes = db.tasktypes || [];
  const id = db.tasktypes.length > 0 
    ? Math.max(...db.tasktypes.map(t => t.id || 0)) + 1 
    : 1;

  const newTaskType = {
    id,
    title,
    taskUrl,
    status: status || 'Active'
  };

  db.tasktypes.push(newTaskType);
  saveDB();
  res.status(201).json(newTaskType);
});

app.delete('/api/tasktypes/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  db.tasktypes = (db.tasktypes || []).filter(t => t.id !== id);
  saveDB();
  res.sendStatus(204);
});

app.post('/api/tasktypes/:id/toggle', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const type = (db.tasktypes || []).find(t => t.id === id);
  if (type) {
    type.status = type.status === 'Active' ? 'Inactive' : 'Active';
    saveDB();
    res.json(type);
  } else {
    res.status(404).json({ message: 'TaskType not found' });
  }
});

// 6. TaskGroup Settings
app.get('/api/taskgroup', authenticateToken, (req, res) => {
  res.json(db.taskgroup);
});

app.post('/api/taskgroup', authenticateToken, (req, res) => {
  db.taskgroup = {
    ...db.taskgroup,
    ...req.body
  };
  saveDB();
  
  // Broadcast update to all connected extensions
  const updatePayload = JSON.stringify({
    type: 'taskgroup_update',
    taskgroup: db.taskgroup
  });
  
  wss.clients.forEach(client => {
    if (client.isExtension && client.readyState === WebSocket.OPEN) {
      try {
        client.send(updatePayload);
      } catch (err) {
        console.error('Failed to broadcast taskgroup update to client:', err);
      }
    }
  });

  res.json(db.taskgroup);
});

// 7. Caught Hits CRUD
app.get('/api/hits', authenticateToken, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  
  // Sort hits by newest first
  const sortedHits = [...db.hits].sort((a, b) => b.timestamp - a.timestamp);
  
  const filtered = sortedHits.filter(h => 
    (h.workerName || '').toLowerCase().includes(search) || 
    (h.requester || '').toLowerCase().includes(search)
  );
  
  res.json({ items: filtered, serverTime: Date.now() });
});

app.post('/api/hits', authenticateToken, (req, res) => {
  const newHit = {
    ...req.body,
    id: `hit_${Date.now()}`,
    _id: `hit_${Date.now()}`,
    timestamp: Date.now()
  };
  db.hits.push(newHit);
  saveDB();
  res.status(201).json(newHit);
});

app.patch('/api/hits/:id/complete', authenticateToken, (req, res) => {
  const { id } = req.params;
  const idx = db.hits.findIndex(h => (h.id === id || h._id === id));
  
  if (idx === -1) return res.status(404).json({ message: 'HIT not found' });
  
  db.hits[idx].status = 'Complete';
  saveDB();
  res.json(db.hits[idx]);
});

app.delete('/api/hits/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.hits = db.hits.filter(h => (h.id !== id && h._id !== id));
  saveDB();
  res.sendStatus(204);
});

// 8. Users (Employees) CRUD
app.get('/api/users', authenticateToken, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const filtered = db.users.filter(u => 
    u.name.toLowerCase().includes(search) || 
    u.email.toLowerCase().includes(search)
  );
  res.json({ items: filtered });
});

app.post('/api/users', authenticateToken, (req, res) => {
  const newUser = {
    ...req.body,
    id: `usr_${Date.now()}`,
    _id: `usr_${Date.now()}`
  };
  
  db.users.push(newUser);
  saveDB();
  res.status(201).json(newUser);
});

app.put('/api/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const idx = db.users.findIndex(u => (u.id === id || u._id === id));
  
  if (idx === -1) return res.status(404).json({ message: 'User not found' });
  
  db.users[idx] = {
    ...db.users[idx],
    ...req.body
  };
  saveDB();
  res.json(db.users[idx]);
});

app.delete('/api/users/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.users = db.users.filter(u => (u.id !== id && u._id !== id));
  saveDB();
  res.sendStatus(204);
});

// 9. Accounts Status (Extensions Heartbeats list)
app.get('/api/accounts-status', authenticateToken, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  
  const list = db.accountsStatus.map(s => {
    const acc = db.accounts.find(a => a.workerId === s.workerId);
    return {
      workerId: s.workerId,
      workerName: acc ? acc.workerName : 'Unknown',
      status: (s.status === 'online' || s.status === 'live') ? 'live' : 'hacked'
    };
  });

  const filtered = list.filter(item => 
    (item.workerId || '').toLowerCase().includes(search) ||
    (item.workerName || '').toLowerCase().includes(search)
  );

  res.json({ items: filtered });
});

// 10. Delete by Date
app.delete('/api/delete-by-date', authenticateToken, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ message: 'Date is required' });
  
  const targetDate = new Date(date).toDateString();
  
  // Filter out hits created on the specified date
  const prevCount = db.hits.length;
  db.hits = db.hits.filter(h => {
    const hitDate = new Date(h.timestamp).toDateString();
    return hitDate !== targetDate;
  });
  
  saveDB();
  res.json({ message: `Purged ${prevCount - db.hits.length} records for ${date}` });
});

// ==========================================================================
// REMOTE USER SCRIPTS ENDPOINTS (API LOG LOOPS & AUTOLIMIT HANDLERS)
// ==========================================================================
app.get('/api/auto-login', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  const { workerId } = req.query;
  const acc = db.accounts.find(a => a.workerId === workerId);
  if (!acc || !acc.email || !acc.password) {
    return res.send(`console.warn('Auto-login: Credentials not found for workerId: ${workerId}');`);
  }

  const jsCode = `
(function() {
  console.log('Running Auto-Login script...');
  const emailInput = document.getElementById('ap_email');
  const passwordInput = document.getElementById('ap_password');
  const submitButton = document.getElementById('signInSubmit');
  
  if (emailInput && !emailInput.value) {
    emailInput.value = "${acc.email}";
    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    emailInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  if (passwordInput && !passwordInput.value) {
    passwordInput.value = "${acc.password}";
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  
  if (emailInput && passwordInput && emailInput.value && passwordInput.value && submitButton) {
    setTimeout(() => {
      submitButton.click();
    }, 1000);
  }
})();
  `;
  res.send(jsCode);
});

app.get('/api/auto-fill', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
console.log('HIT Iframe Listener - Remote Autofill Script Loaded');
  `);
});

app.get('/api/mturk-script', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
console.log('MTurk Auto Checker - Script Loaded for workerId: ${req.query.workerId}');
  `);
});

app.get('/api/tab-manager', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
console.log('MTurk Auto Close Script Loaded');
(function() {
  if (window.location.href.includes('submitted=true') || document.body.innerText.includes('Your HIT has been submitted')) {
    setTimeout(() => {
      window.close();
    }, 5000);
  }
})();
  `);
});

app.get('/api/hit-fetch', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
console.log('MTurk HIT Fetch Script Loaded for workerId: ${req.query.workerId}');
  `);
});

app.get('/api/puzzle-detection', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
console.log('Puzzle/Captcha Detection Active for workerId: ${req.query.workerId}');
(function() {
  setInterval(() => {
    if (document.querySelector('#cvf-page-content, .captcha, iframe[src*="captcha"]')) {
      console.warn('Puzzle detected on page!');
      fetch('/api/check-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: "${req.query.workerId}", status: "hacked" })
      });
    }
  }, 5000);
})();
  `);
});

app.post('/api/check-worker', (req, res) => {
  const { workerId, status } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId is required' });

  const targetStatus = status || 'online';

  let statusObj = db.accountsStatus.find(s => s.workerId === workerId);
  if (!statusObj) {
    statusObj = { workerId, status: targetStatus, lastSeen: Date.now() };
    db.accountsStatus.push(statusObj);
  } else {
    statusObj.status = targetStatus;
    statusObj.lastSeen = Date.now();
  }
  saveDB();
  
  broadcastToDashboards({
    type: 'worker_status',
    worker: { workerId, status: targetStatus }
  });

  res.json({ success: true, message: 'Worker status updated', status: statusObj.status });
});

app.post('/api/worker-dashboard-detail', (req, res) => {
  const { workerId, available_earnings } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId is required' });

  const acc = db.accounts.find(a => a.workerId === workerId);
  if (acc) {
    acc.availableEarnings = available_earnings ? available_earnings.amount_in_dollars : 0;
    saveDB();
  }
  
  res.json({ success: true });
});


// ==========================================================================
// WEBSOCKET CONNECTIONS (FOR MULTIPLE RDPS EXTENSIONS & LIVE DASHBOARDS)
// ==========================================================================
const dashboards = new Set();

function broadcastToDashboards(data) {
  const payload = JSON.stringify(data);
  dashboards.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const type = urlParams.get('type');
  
  if (type === 'dashboard') {
    ws.isDashboard = true;
    dashboards.add(ws);
    ws.on('close', () => dashboards.delete(ws));
  } 
  
  else if (type === 'extension') {
    ws.isExtension = true;
    const rdpName = urlParams.get('rdp') || 'Unknown-RDP';
    const workerId = urlParams.get('workerId') || 'Unknown-ID';
    
    console.log(`[Extension Connected] RDP/Worker: ${rdpName} (${workerId})`);

    // Register active worker status
    const existingIndex = db.accountsStatus.findIndex(s => s.workerId === workerId);
    if (existingIndex !== -1) {
      db.accountsStatus[existingIndex].status = 'online';
      db.accountsStatus[existingIndex].lastSeen = Date.now();
    } else {
      db.accountsStatus.push({
        workerId,
        status: 'online',
        lastSeen: Date.now()
      });
    }
    
    // Auto-create account record if it doesn't exist
    const accExists = db.accounts.some(a => a.workerId === workerId);
    if (!accExists && workerId !== 'Unknown-ID') {
      db.accounts.push({
        id: `acc_${Date.now()}`,
        _id: `acc_${Date.now()}`,
        workerId,
        workerName: rdpName,
        email: `${rdpName.toLowerCase()}@mayohn-rdp.com`,
        nextPayment: '-',
        lastPayment: '-',
        paymentAmount: 0,
        status: "Active"
      });
    }
    
    saveDB();
    
    // Send initial taskgroup settings to the extension
    try {
      ws.send(JSON.stringify({
        type: 'taskgroup_update',
        taskgroup: db.taskgroup
      }));
    } catch (err) {
      console.error('Failed to send initial taskgroup settings to extension:', err);
    }
    
    // Broadcast status to active dashboards
    broadcastToDashboards({
      type: 'worker_status',
      worker: { rdpName, workerId, status: 'online' }
    });

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        if (data.type === 'stats_update') {
          const idx = db.accountsStatus.findIndex(s => s.workerId === workerId);
          if (idx !== -1) {
            db.accountsStatus[idx].lastSeen = Date.now();
            db.accountsStatus[idx].status = 'online';
          }
          
          // Save stats update in accounts if needed
          const accIdx = db.accounts.findIndex(a => a.workerId === workerId);
          if (accIdx !== -1) {
            // Can update payment info dynamically if needed
          }
          
          broadcastToDashboards({
            type: 'worker_update',
            worker: { rdpName, workerId, status: 'online', earningsToday: data.earningsToday, queueSize: data.queueSize }
          });
        } 
        
        else if (data.type === 'notification') {
          // Retrieve worker name matching this connection
          const acc = db.accounts.find(a => a.workerId === workerId) || { workerName: rdpName };
          
          // Parse payout value
          const payoutVal = parseFloat((data.notification.payout || '$0.00').replace(/[^0-9.]/g, '')) || 0.00;
          const groupId = data.notification.message;
          const requester = data.notification.requester || 'Targeted Catcher';

          if (!shouldRegisterHit(groupId, requester)) {
            console.log(`[WebSocket] Skipping caught HIT (does not match TaskGroup criteria): ${groupId}`);
            return;
          }

          // Find matching TaskType to get the configured URL/Group ID
          const matchedType = (db.tasktypes || []).find(t => 
            t.title && (
              t.title.toLowerCase() === requester.toLowerCase() ||
              (t.taskUrl && (t.taskUrl === groupId || t.taskUrl.includes(groupId) || groupId.includes(t.taskUrl)))
            )
          );

          // Use the configured Group ID from the task types list
          const finalTask = matchedType ? (matchedType.taskUrl || groupId) : groupId;

          // Check if a placeholder hit already exists (to avoid duplicate notification triggers)
          const placeholderExists = db.hits.some(h => 
            h.task === finalTask && 
            h.workerName === acc.workerName && 
            (h.taskUrl === 'Calculating...' || !h.taskUrl)
          );
          if (!placeholderExists) {
            const newHit = {
              id: `hit_${Date.now()}`,
              _id: `hit_${Date.now()}`,
              workerName: acc.workerName,
              task: finalTask,
              taskUrl: 'Calculating...',
              requester: requester,
              reward: payoutVal,
              status: 'Active',
              timeRemaining: 'Calculating...',
              timestamp: Date.now()
            };
            
            db.hits.push(newHit);
            saveDB();

            // Broadcast live alert to admin dashboards
            broadcastToDashboards({
              type: 'hit_alert',
              rdpName: acc.workerName,
              workerId: workerId,
              notification: {
                time: new Date().toLocaleTimeString(),
                message: finalTask,
                payout: `$${payoutVal.toFixed(2)}`
              }
            });
          }
        }
        
        else if (data.type === 'queue_hits') {
          const acc = db.accounts.find(a => a.workerId === workerId) || { workerName: rdpName };
          let changed = false;
          const activeScrapedUrls = new Set();
          
          data.hits.forEach(qHit => {
            const payoutVal = parseFloat(qHit.reward.replace(/[^0-9.]/g, '')) || 0.00;
            
            if (!shouldRegisterHit(qHit.groupId, qHit.requester, payoutVal)) {
              return;
            }

            // Find matching TaskType to get the configured URL/Group ID
            const matchedType = (db.tasktypes || []).find(t => 
              t.title && (
                t.title.toLowerCase() === qHit.requester.toLowerCase() ||
                (t.taskUrl && (t.taskUrl === qHit.groupId || t.taskUrl.includes(qHit.groupId) || qHit.groupId.includes(t.taskUrl)))
              )
            );

            // Use the configured Group ID from the task types list
            const finalTask = matchedType ? (matchedType.taskUrl || qHit.groupId) : qHit.groupId;
            const targetTaskUrl = qHit.taskUrl || `https://worker.mturk.com/projects/${finalTask}/tasks/accept_random`;
            activeScrapedUrls.add(targetTaskUrl);

            // 1. Find if this exact assignment already exists by its unique taskUrl
            let existingHit = db.hits.find(h => h.taskUrl === targetTaskUrl && h.workerName === acc.workerName);
            
            // 2. If not, check if there is an unassociated notification placeholder hit for this task
            if (!existingHit) {
              existingHit = db.hits.find(h => 
                h.task === finalTask && 
                h.workerName === acc.workerName && 
                (!h.taskUrl || h.taskUrl === 'Calculating...' || h.taskUrl.includes('accept_random'))
              );
            }

            if (!existingHit) {
              const newHit = {
                id: `hit_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                _id: `hit_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                workerName: acc.workerName,
                task: finalTask,
                taskUrl: targetTaskUrl,
                requester: qHit.requester,
                reward: payoutVal,
                status: 'Active',
                timeRemaining: qHit.timeRemaining,
                timestamp: Date.now()
              };
              db.hits.push(newHit);
              changed = true;
              
              broadcastToDashboards({
                type: 'hit_alert',
                rdpName: acc.workerName,
                workerId: workerId,
                notification: {
                  time: new Date().toLocaleTimeString(),
                  message: finalTask,
                  payout: `$${payoutVal.toFixed(2)}`
                }
              });
            } else {
              // Update details of the existing hit dynamically
              let hitChanged = false;
              if (existingHit.timeRemaining !== qHit.timeRemaining) {
                existingHit.timeRemaining = qHit.timeRemaining;
                existingHit.timestamp = Date.now(); // Reset timestamp for live countdown sync
                hitChanged = true;
              }
              if (existingHit.taskUrl !== targetTaskUrl) {
                existingHit.taskUrl = targetTaskUrl;
                hitChanged = true;
              }
              if (existingHit.reward !== payoutVal) {
                existingHit.reward = payoutVal;
                hitChanged = true;
              }
              if (existingHit.requester !== qHit.requester) {
                existingHit.requester = qHit.requester;
                hitChanged = true;
              }
              if (hitChanged) {
                changed = true;
              }
            }
          });

          // Sync cleanup: Mark any active hits not found in the scraped queue as Complete or delete them
          if (data.hits.length > 0) {
            const initialCount = db.hits.length;
            db.hits = db.hits.filter(h => {
              if (h.workerName !== acc.workerName) return true;
              if (h.status === 'Complete') return true;
              return activeScrapedUrls.has(h.taskUrl);
            });
            if (db.hits.length !== initialCount) {
              changed = true;
            }
          }
          
          if (changed) {
            saveDB();
            broadcastToDashboards({ type: 'hits_update' });
          }
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`[Extension Disconnected] RDP/Worker: ${rdpName}`);
      const idx = db.accountsStatus.findIndex(s => s.workerId === workerId);
      if (idx !== -1) {
        db.accountsStatus[idx].status = 'offline';
        db.accountsStatus[idx].lastSeen = Date.now();
      }
      saveDB();
      
      broadcastToDashboards({
        type: 'worker_status',
        worker: { rdpName, workerId, status: 'offline' }
      });
    });
  }
});

// Periodic status timeouts
setInterval(() => {
  const now = Date.now();
  let changed = false;
  
  db.accountsStatus.forEach(s => {
    if (s.status === 'online' && (now - s.lastSeen > 300000)) {
      s.status = 'offline';
      changed = true;
      console.log(`[Status Timeout] Worker ID: ${s.workerId} marked offline`);
    }
  });
  
  if (changed) {
    saveDB();
    broadcastToDashboards({ type: 'refresh' });
  }
}, 30000);

// Root fallback to serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`  Sphinx Multi-RDP System Running on Port ${PORT}`);
  console.log(`  Log in at: http://localhost:${PORT}`);
  console.log(`  Default Username: testcompany@gmail.com`);
  console.log(`  Default Password: MayohnSphinx2026!`);
  console.log(`===================================================`);
});

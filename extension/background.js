let ws = null;
let rdpName = 'Unknown-RDP';
let serverUrl = 'ws://10.41.156.34:3010';
let currentWorkerId = 'Unknown-ID';
let isConnecting = false;

// Cached stats
let lastStats = {
  earningsToday: 0.00,
  balance: 0.00,
  queueSize: 0
};

// Retrieve settings from Chrome Storage
function loadSettings(callback) {
  chrome.storage.local.get(['rdpName', 'serverUrl'], (items) => {
    if (items.rdpName) rdpName = items.rdpName;
    if (items.serverUrl) serverUrl = items.serverUrl;
    console.log(`Settings loaded: RDP=${rdpName}, Server=${serverUrl}`);
    if (callback) callback();
  });
}

// Establish/re-establish connection to Central Dashboard Server
function connectToServer() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;

  isConnecting = true;
  console.log(`Attempting to connect to server: ${serverUrl}`);

  // Query parameters: let the server know who this connection is
  const wsUrl = `${serverUrl}?type=extension&rdp=${encodeURIComponent(rdpName)}&workerId=${encodeURIComponent(currentWorkerId)}`;
  
  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to Central Dashboard Server');
      isConnecting = false;
      // Send initial cached stats
      sendStatsToServer();
    };

    ws.onmessage = (event) => {
      console.log('Received message from server:', event.data);
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'taskgroup_update') {
          activeTaskgroupConfig = data.taskgroup;
          chrome.tabs.query({ url: '*://worker.mturk.com/*' }, (tabs) => {
            tabs.forEach(tab => {
              try {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'taskgroup_config',
                  taskgroup: activeTaskgroupConfig
                });
              } catch (e) {}
            });
          });
          startAutoAcceptLoop();
        }
      } catch (err) {
        console.error('Error handling server message:', err);
      }
    };

    ws.onclose = () => {
      console.warn('Socket closed. Retrying in 5 seconds...');
      ws = null;
      isConnecting = false;
      setTimeout(connectToServer, 5000);
    };

    ws.onerror = (err) => {
      console.error('Socket error:', err);
      ws.close();
    };
  } catch (error) {
    console.error('Connection setup failed:', error);
    isConnecting = false;
    setTimeout(connectToServer, 5000);
  }
}

// Send current stats to server
function sendStatsToServer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stats_update',
      workerId: currentWorkerId,
      earningsToday: lastStats.earningsToday,
      balance: lastStats.balance,
      queueSize: lastStats.queueSize
    }));
  }
}

// Listen to messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scrape_data') {
    const data = message.data;
    let changed = false;

    if (data.workerId && data.workerId !== currentWorkerId) {
      currentWorkerId = data.workerId;
      changed = true;
      // Re-trigger connection to register correct Worker ID on server
      if (ws) ws.close();
    }

    if (
      data.earningsToday !== lastStats.earningsToday ||
      data.queueSize !== lastStats.queueSize
    ) {
      lastStats.earningsToday = data.earningsToday;
      lastStats.queueSize = data.queueSize;
      changed = true;
    }

    if (changed) {
      console.log('Stats updated via Content Script:', lastStats);
      sendStatsToServer();
    }
  } 
  
  else if (message.type === 'new_hit_notification') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Find payout if possible from notification text
      const payoutMatch = message.message.match(/\$[0-9.]+/);
      const payout = payoutMatch ? payoutMatch[0] : '$0.00';

      ws.send(JSON.stringify({
        type: 'notification',
        notification: {
          message: message.message,
          payout: payout
        }
      }));
    }
  } 
  
  else if (message.type === 'queue_hits_discovered') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'queue_hits',
        hits: message.hits
      }));
    }
  } 
  
  else if (message.type === 'settings_updated') {
    loadSettings(() => {
      // Close active socket to reconnect with new settings/RDP Name
      if (ws) ws.close();
      else connectToServer();
    });
  } 
  
  else if (message.type === 'get_taskgroup_config') {
    sendResponse({ taskgroup: activeTaskgroupConfig });
  }
  
  else if (message.type === 'get_status') {
    sendResponse({
      rdpName,
      serverUrl,
      workerId: currentWorkerId,
      connected: ws && ws.readyState === WebSocket.OPEN,
      stats: lastStats
    });
  }
  return true;
});

// Periodic background check of MTurk dashboard (failsafe if no tab open)
async function performBackgroundScrape() {
  console.log('Running background scrape checks...');
  try {
    const response = await fetch('https://worker.mturk.com/dashboard');
    if (!response.ok) return;

    const html = await response.text();

    // Look for data-react-props attribute
    const reactMatch = html.match(/data-react-props="([^"]+)"/);
    if (reactMatch) {
      // Decode HTML entities
      const decodedProps = reactMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      
      const props = JSON.parse(decodedProps);

      let workerId = currentWorkerId;
      let earningsToday = lastStats.earningsToday;

      if (props.contactInfo && props.contactInfo.workerId) {
        workerId = props.contactInfo.workerId;
      }

      if (props.dailyEarningsSummary) {
        // Today is usually the first item or matches today's date
        const todayDateStr = new Date().toISOString().split('T')[0];
        const todayEarnings = props.dailyEarningsSummary.find(
          d => d.isToday || d.date === todayDateStr
        );
        if (todayEarnings) {
          earningsToday = todayEarnings.amount.toString();
        }
      }

      // Read queue count via regex search of navigation in the HTML
      let queueSize = lastStats.queueSize;
      const navQueueMatch = html.match(/(?:Tasks|Queue|Your Queue)\s*\((\d+)\)/i);
      if (navQueueMatch && navQueueMatch[1]) {
        queueSize = parseInt(navQueueMatch[1], 10);
      }

      // Update state
      let changed = false;
      if (workerId !== currentWorkerId) {
        currentWorkerId = workerId;
        changed = true;
        if (ws) ws.close(); // reconnect with new workerId
      }

      if (earningsToday !== lastStats.earningsToday || queueSize !== lastStats.queueSize) {
        lastStats.earningsToday = earningsToday;
        lastStats.queueSize = queueSize;
        changed = true;
      }

      if (changed) {
        console.log('Background Stats Refreshed:', lastStats);
        sendStatsToServer();
      }
    }
  } catch (err) {
    console.error('Background scrape check failed (user likely logged out):', err);
  }
}

// Set up Chrome Alarm for background scrape (every 2 minutes)
chrome.alarms.create('bg_scrape_alarm', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bg_scrape_alarm') {
    performBackgroundScrape();
  }
});

// Initial startup sequence
loadSettings(() => {
  connectToServer();
  performBackgroundScrape();
});

// ==========================================================================
// CATCHER AUTO-ACCEPT CRAWLER LOOP
// ==========================================================================
let activeTaskgroupConfig = null;
let autoAcceptIntervalId = null;
let currentlyAccepting = false;

function getAcceptUrl(inputUrlOrGroupId) {
  if (!inputUrlOrGroupId) return null;
  const trimmed = inputUrlOrGroupId.trim();
  if (trimmed.includes('accept_random')) {
    return trimmed;
  }
  if (trimmed.includes('projects/')) {
    const match = trimmed.match(/projects\/([A-Z0-9]+)/i);
    if (match) {
      return `https://worker.mturk.com/projects/${match[1]}/tasks/accept_random`;
    }
  }
  if (/^[A-Z0-9]+$/i.test(trimmed)) {
    return `https://worker.mturk.com/projects/${trimmed}/tasks/accept_random`;
  }
  return null;
}

function triggerQueueScrapeInOpenTabs() {
  chrome.tabs.query({ url: '*://worker.mturk.com/*' }, (tabs) => {
    tabs.forEach(tab => {
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'trigger_queue_scrape' });
      } catch (e) {
        // Safe check if content script is loaded
      }
    });
  });
}

function startAutoAcceptLoop() {
  if (autoAcceptIntervalId) {
    clearInterval(autoAcceptIntervalId);
    autoAcceptIntervalId = null;
  }

  if (!activeTaskgroupConfig || !activeTaskgroupConfig.status) {
    console.log('[Auto-Acceptor] Catcher status is disabled.');
    return;
  }

  const targets = [
    activeTaskgroupConfig.url1,
    activeTaskgroupConfig.url2,
    activeTaskgroupConfig.url3,
    activeTaskgroupConfig.url4
  ].filter(Boolean).map(url => getAcceptUrl(url)).filter(Boolean);

  if (targets.length === 0) {
    console.log('[Auto-Acceptor] No valid target URLs to accept.');
    return;
  }

  const intervalMs = parseInt(activeTaskgroupConfig.interval, 10) || 1000;
  console.log(`[Auto-Acceptor] Starting loop for targets:`, targets, `at interval: ${intervalMs}ms`);

  autoAcceptIntervalId = setInterval(async () => {
    if (currentlyAccepting) return;
    currentlyAccepting = true;

    for (const acceptUrl of targets) {
      try {
        console.log(`[Auto-Acceptor] Checking/Accepting target: ${acceptUrl}`);
        const response = await fetch(acceptUrl, { credentials: 'include' });
        const text = await response.text();

        const isAccepted = text.includes('assigned_to_user') || 
                           text.includes('Time Elapsed') || 
                           text.includes('time_elapsed') ||
                           text.includes('Submit') ||
                           (response.url.includes('/tasks/') && !response.url.includes('accept_random'));

        if (isAccepted) {
          console.log(`[Auto-Acceptor] SUCCESS! Caught HIT for accept URL: ${acceptUrl}`);
          
          const groupIdMatch = acceptUrl.match(/projects\/([A-Z0-9]+)\/tasks/i);
          const groupId = groupIdMatch ? groupIdMatch[1] : 'Unknown-HIT';

          // Instantly send hit caught message to backend
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'notification',
              notification: {
                message: groupId,
                payout: '$0.00',
                requester: 'Targeted Catcher'
              }
            }));
          }

          // Force an immediate queue scrape to update all stats and remaining time
          triggerQueueScrapeInOpenTabs();
        }
      } catch (err) {
        console.error(`[Auto-Acceptor] Fetch failed for ${acceptUrl}:`, err);
      }
    }

    currentlyAccepting = false;
  }, intervalMs);
}

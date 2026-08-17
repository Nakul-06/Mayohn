// Scrapes the current page for MTurk stats and reports to the background script.
function scrapeMTurkPage() {
  console.log('[MTurk Agent] Scraping page for stats...');
  try {
    let workerId = '';
    let earningsToday = '0.00';
    let queueSize = 0;

    // 1. Try to find Worker ID
    const navText = document.body.innerText;
    console.log('[MTurk Agent] InnerText preview (first 200 chars):', navText.substring(0, 200).replace(/\n/g, ' '));
    
    // Regular expression: matches "Worker ID: A..." or "Worker ID: COPIED A..."
    const idRegex = /Worker\s*ID[\s\n:]*(?:COPIED|COPY)?[\s\n]*([A-Z0-9]{12,20})/i;
    const idMatch = navText.match(idRegex);
    if (idMatch && idMatch[1]) {
      workerId = idMatch[1].trim();
      console.log('[MTurk Agent] Found Worker ID via main regex:', workerId);
    }

    // Secondary Worker ID check: scan links in document
    if (!workerId) {
      const links = Array.from(document.querySelectorAll('a'));
      for (let link of links) {
        const href = link.getAttribute('href') || '';
        const text = link.innerText || '';
        
        // Match worker id format starting with A
        const match = text.match(/([A-Z0-9]{13,16})/i);
        if (match && match[1] && match[1].toUpperCase().startsWith('A')) {
          if (href.includes('dashboard') || text.includes('Worker ID')) {
            workerId = match[1].trim();
            console.log('[MTurk Agent] Found Worker ID via profile link:', workerId);
            break;
          }
        }
      }
    }

    // 2. Try to find Today's Earnings
    // Look for dashboard elements or text with "Today's Earnings"
    const earningsRegex = /Today's Earnings[\s\n]*\$([0-9.,]+)/i;
    const earningsMatch = navText.match(earningsRegex);
    if (earningsMatch && earningsMatch[1]) {
      earningsToday = earningsMatch[1].trim();
    }

    // 3. Try to find Queue size from the navigation header (e.g., "Tasks (2)" or "Queue (0)")
    const queueRegex = /(?:Tasks|Queue|Your Queue)\s*\((\d+)\)/i;
    const queueMatch = navText.match(queueRegex);
    if (queueMatch && queueMatch[1]) {
      queueSize = parseInt(queueMatch[1].trim(), 10);
    }

    // 4. Try to parse from React Props (data-react-props) if available on the page
    const reactElements = document.querySelectorAll('[data-react-props]');
    reactElements.forEach(el => {
      try {
        const props = JSON.parse(el.getAttribute('data-react-props'));
        
        // Check if this is the dashboard layout props containing earnings/worker info
        if (props.contactInfo && props.contactInfo.workerId) {
          workerId = props.contactInfo.workerId;
        }
        if (props.dailyEarningsSummary) {
          // Today is usually the first item or index in daily earnings
          const todayEarnings = props.dailyEarningsSummary.find(d => d.isToday || d.date === new Date().toISOString().split('T')[0]);
          if (todayEarnings) {
            earningsToday = todayEarnings.amount.toString();
          }
        }
      } catch (e) {
        // Silent catch for parsing individual elements
      }
    });

    // If we gathered useful data, send it to the background script
    if (workerId) {
      console.log('[MTurk Agent] Sending scraped data to background:', { workerId, earningsToday, queueSize });
      chrome.runtime.sendMessage({
        type: 'scrape_data',
        data: {
          workerId,
          earningsToday,
          queueSize
        }
      });
    } else {
      console.warn('[MTurk Agent] Worker ID not detected on page yet.');
    }

    // 5. Intercept notification alerts
    // Check if the page is currently notifying the worker about a HIT
    checkForNewHitNotification();

  } catch (err) {
    console.error('Error scraping MTurk page:', err);
  }
}

// Check for live notifications on the current page
function checkForNewHitNotification() {
  // If there's an alert notification or a success message about catching a HIT
  const successAlerts = document.querySelectorAll('.alert-success, .message-success');
  successAlerts.forEach(alert => {
    const text = alert.innerText;
    if (text.includes('assigned') || text.includes('accepted') || text.includes('successful')) {
      chrome.runtime.sendMessage({
        type: 'new_hit_notification',
        message: text
      });
    }
  });
}

// Scrape and cleanup on load
scrapeMTurkPage();
scrapeHitsQueue();
scrapeActiveHitDetails();
cleanupMTurkCookies();

// Periodic tasks while page is open
setInterval(scrapeMTurkPage, 10000);
setInterval(scrapeHitsQueue, 10000);
setInterval(scrapeActiveHitDetails, 5000);
setInterval(cleanupMTurkCookies, 30000);

// Automatically clears non-essential Amazon tracking/ad cookies to prevent header/cookie bloat (400 Bad Request)
function cleanupMTurkCookies() {
  try {
    const cookies = document.cookie.split(";");
    const allowedPrefixes = ['session-', 'ubid-', 'x-', 'at-', 'mst', 'security-'];
    let deletedCount = 0;
    
    cookies.forEach(cookie => {
      const parts = cookie.trim().split("=");
      const name = parts[0];
      if (!name) return;
      
      const isAllowed = allowedPrefixes.some(prefix => name.startsWith(prefix));
      if (!isAllowed) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.mturk.com`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=worker.mturk.com`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        deletedCount++;
      }
    });
    
    if (deletedCount > 0) {
      console.log(`[MTurk Agent] Automatically cleared ${deletedCount} bloated non-essential cookies.`);
    }
  } catch (err) {
    console.error('[MTurk Agent] Cookie cleanup failed:', err);
  }
}

// Scrapes the details of the active HIT work page (e.g. projects/{groupId}/tasks/{hitId})
function scrapeActiveHitDetails() {
  try {
    const path = window.location.pathname;
    const match = path.match(/\/projects\/([A-Z0-9]+)\/tasks\/([A-Z0-9]+)/i);
    if (!match) return;
    const groupId = match[1];
    
    let reward = '$0.00';
    const rewardEl = document.querySelector('.reward-value, [data-reward], .hit-reward');
    if (rewardEl) {
      reward = rewardEl.innerText.trim();
    } else {
      const rewardMatch = document.body.innerText.match(/Reward[\s\n]*\$([0-9.]+)/i);
      if (rewardMatch) reward = `$${rewardMatch[1]}`;
    }

    let requester = 'Targeted Catcher';
    const requesterEl = document.querySelector('.requester-name, .requester-value');
    if (requesterEl) {
      requester = requesterEl.innerText.trim();
    } else {
      const reqMatch = document.body.innerText.match(/Requester[\s\n]+([A-Za-z0-9\s]+)(?:HITs|$)/i);
      if (reqMatch) requester = reqMatch[1].trim();
    }

    let timeRemainingStr = 'Calculating...';
    
    // Check countdown timer element first
    const timerEl = document.querySelector('.countdown-timer, .timer, [class*="timer"]');
    if (timerEl && timerEl.innerText.match(/\d+:\d+/)) {
      timeRemainingStr = timerEl.innerText.trim();
    } else {
      // Fallback: parse elapsed time header
      const elapsedMatch = document.body.innerText.match(/Time\s*Elapsed[\s\n]*([0-9:]+)[\s\n]*of[\s\n]*(\d+)[\s\n]*Min/i);
      if (elapsedMatch) {
        const elapsedStr = elapsedMatch[1];
        const totalMin = parseInt(elapsedMatch[2], 10);
        
        const elapsedParts = elapsedStr.split(':').map(Number);
        let elapsedSec = 0;
        if (elapsedParts.length === 2) {
          elapsedSec = elapsedParts[0] * 60 + elapsedParts[1];
        } else if (elapsedParts.length === 3) {
          elapsedSec = elapsedParts[0] * 3600 + elapsedParts[1] * 60 + elapsedParts[2];
        }
        
        const totalSec = totalMin * 60;
        const remainingSec = Math.max(0, totalSec - elapsedSec);
        
        const hours = Math.floor(remainingSec / 3600);
        const minutes = Math.floor((remainingSec % 3600) / 60);
        const seconds = remainingSec % 60;
        
        if (hours > 0) {
          timeRemainingStr = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
          timeRemainingStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
      }
    }

    chrome.runtime.sendMessage({
      type: 'queue_hits_discovered',
      hits: [{
        groupId,
        taskUrl: window.location.href,
        requester,
        reward,
        timeRemaining: timeRemainingStr
      }]
    });
  } catch (err) {
    console.error('[MTurk Agent] Error in scrapeActiveHitDetails:', err);
  }
}

// Scrapes the active queue list on worker.mturk.com/tasks
function scrapeHitsQueue() {
  try {
    const path = window.location.pathname;
    if (!path.includes('/tasks') && !path.includes('/my_tasks') && !path.includes('/projects')) {
      return;
    }
    
    // Find all links containing /projects/ and /tasks
    const links = Array.from(document.querySelectorAll('a')).filter(a => {
      const href = a.getAttribute('href') || '';
      return href.includes('/projects/') && href.includes('/tasks');
    });

    const discoveredHits = [];

    links.forEach(link => {
      try {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/projects\/([A-Z0-9]{12,45})\/tasks/i);
        if (!match) return;
        const groupId = match[1];

        // Traverse up to find parent container card or table row
        let row = link.parentElement;
        let depth = 0;
        while (row && depth < 10) {
          if (row.innerText.includes('$') && (row.innerText.toLowerCase().includes('remaining') || row.innerText.toLowerCase().includes('min'))) {
            break;
          }
          row = row.parentElement;
          depth++;
        }

        if (!row) return;
        const text = row.innerText;

        // Parse reward (e.g. $0.05)
        const rewardMatch = text.match(/\$[0-9.]+/);
        const reward = rewardMatch ? rewardMatch[0] : '$0.00';

        // Parse requester
        let requester = 'Unknown Requester';
        const reqLink = Array.from(row.querySelectorAll('a')).find(a => {
          const h = a.getAttribute('href') || '';
          return h.includes('requester_id') || h.includes('requesters');
        });
        if (reqLink) {
          requester = reqLink.innerText.trim();
        } else {
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length > 0) requester = lines[0];
        }

        // Parse time remaining
        let timeRemaining = '60 Min';
        const timeMatch = text.match(/\d+\s*m(in)?s?\s*\d*\s*s?(ec)?s?|\d+\s*h(our)?s?\s*\d*\s*m(in)?s?/i);
        if (timeMatch) {
          timeRemaining = timeMatch[0].trim();
        }

        discoveredHits.push({
          groupId,
          taskUrl: href.startsWith('http') ? href : 'https://worker.mturk.com' + href,
          requester,
          reward,
          timeRemaining
        });
      } catch (e) {
        // Safe skip
      }
    });

    if (discoveredHits.length > 0) {
      chrome.runtime.sendMessage({
        type: 'queue_hits_discovered',
        hits: discoveredHits
      });
    }
  } catch (err) {
    console.error('[MTurk Agent] Error in scrapeHitsQueue:', err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'trigger_queue_scrape') {
    console.log('[MTurk Agent] Triggered immediate queue scrape...');
    scrapeHitsQueue();
  } else if (message.type === 'taskgroup_config') {
    console.log('[MTurk Agent] Received updated TaskGroup config:', message.taskgroup);
    updateTaskgroupConfig(message.taskgroup);
  }
});

// ==========================================================================
// TAB-LEVEL AUTO-ACCEPTOR LOOP (RUNS IN LOGGED-IN SESSION CONTEXT)
// ==========================================================================
let activeTaskgroup = null;
let targetIntervalId = null;
let searchIntervalId = null;
let currentlyFetchingTargets = false;
let currentlySearchingGeneral = false;

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

// Scans available HITs matching minReward and attempts to auto-accept them if not banned
async function runGeneralCatcherSearch() {
  if (!activeTaskgroup || !activeTaskgroup.status || currentlySearchingGeneral) return;
  currentlySearchingGeneral = true;

  try {
    const minReward = parseFloat(activeTaskgroup.minReward) || 0.01;
    const searchUrl = `https://worker.mturk.com/projects?format=json&sort=updated_desc&filters[min_reward]=${minReward}`;
    
    console.log(`[MTurk Agent] Scanning available HITs for minReward >= $${minReward}...`);
    const response = await fetch(searchUrl);
    const data = await response.json();
    
    if (!data || !data.results || data.results.length === 0) {
      currentlySearchingGeneral = false;
      return;
    }
    
    // Parse banned list
    let bannedList = [];
    if (activeTaskgroup.bannedRequesters) {
      bannedList = activeTaskgroup.bannedRequesters
        .toLowerCase()
        .split(',')
        .map(r => r.trim())
        .filter(Boolean);
    }
    
    for (const hit of data.results) {
      const groupId = hit.hit_set_id;
      const requester = hit.requester_name || '';
      const rewardVal = hit.monetary_reward ? hit.monetary_reward.amount_in_dollars : 0;
      
      // 1. Skip if requester is banned
      const reqLower = requester.toLowerCase();
      const isBanned = bannedList.some(banned => 
        reqLower === banned || reqLower.includes(banned) || banned.includes(reqLower)
      );
      if (isBanned) {
        console.log(`[MTurk Agent] Skipping general HIT (banned requester: "${requester}")`);
        continue;
      }
      
      // 2. Skip if it is already in our 4 targets
      const targetGroupIds = [
        activeTaskgroup.url1,
        activeTaskgroup.url2,
        activeTaskgroup.url3,
        activeTaskgroup.url4
      ].filter(Boolean).map(url => {
        const m = url.match(/projects\/([A-Z0-9]+)/i);
        return m ? m[1] : url.trim();
      });
      
      if (targetGroupIds.includes(groupId)) {
        continue;
      }
      
      // 3. Auto-accept the general HIT
      const acceptUrl = `https://worker.mturk.com/projects/${groupId}/tasks/accept_random`;
      console.log(`[MTurk Agent] Auto-accepting general HIT matching minReward: ${requester} ($${rewardVal})`);
      
      const acceptRes = await fetch(acceptUrl);
      const text = await acceptRes.text();
      
      const isAccepted = text.includes('assigned_to_user') || 
                         text.includes('Time Elapsed') || 
                         text.includes('time_elapsed') ||
                         text.includes('Submit') ||
                         (acceptRes.url.includes('/tasks/') && !acceptRes.url.includes('accept_random'));
                         
      if (isAccepted) {
        console.log(`[MTurk Agent] SUCCESS! Auto-accepted general HIT: ${groupId}`);
        
        chrome.runtime.sendMessage({
          type: 'new_hit_notification',
          message: `Successfully accepted general HIT: ${requester} ($${rewardVal.toFixed(2)})`
        });
        
        scrapeHitsQueue();
        break; // Accept one general HIT per scan loop
      }
    }
  } catch (err) {
    console.error('[MTurk Agent] General catcher search failed:', err);
  }
  
  currentlySearchingGeneral = false;
}

function updateTaskgroupConfig(config) {
  activeTaskgroup = config;
  
  // Clear any existing intervals
  if (targetIntervalId) {
    clearInterval(targetIntervalId);
    targetIntervalId = null;
  }
  if (searchIntervalId) {
    clearInterval(searchIntervalId);
    searchIntervalId = null;
  }

  if (!activeTaskgroup || !activeTaskgroup.status) {
    console.log('[MTurk Agent] Auto-accept is disabled in settings.');
    return;
  }

  const targets = [
    activeTaskgroup.url1,
    activeTaskgroup.url2,
    activeTaskgroup.url3,
    activeTaskgroup.url4
  ].filter(Boolean).map(url => getAcceptUrl(url)).filter(Boolean);

  // 1. Loop 1: High frequency target catcher (runs every 2 seconds continuously)
  if (targets.length > 0) {
    console.log(`[MTurk Agent] Starting continuous high-frequency target catcher for:`, targets);
    targetIntervalId = setInterval(async () => {
      if (currentlyFetchingTargets) return;
      currentlyFetchingTargets = true;

      for (const acceptUrl of targets) {
        try {
          console.log(`[MTurk Agent] Checking/Accepting target URL: ${acceptUrl}`);
          const response = await fetch(acceptUrl);
          const text = await response.text();

          const isAccepted = text.includes('assigned_to_user') || 
                             text.includes('Time Elapsed') || 
                             text.includes('time_elapsed') ||
                             text.includes('Submit') ||
                             (response.url.includes('/tasks/') && !response.url.includes('accept_random'));

          if (isAccepted) {
            console.log(`[MTurk Agent] SUCCESS! Auto-accepted target HIT: ${acceptUrl}`);
            
            const groupIdMatch = acceptUrl.match(/projects\/([A-Z0-9]+)\/tasks/i);
            const groupId = groupIdMatch ? groupIdMatch[1] : 'Unknown-HIT';

            chrome.runtime.sendMessage({
              type: 'new_hit_notification',
              message: `Successfully accepted target HIT Group: ${groupId}`
            });

            scrapeHitsQueue();
          }
        } catch (err) {
          console.error('[MTurk Agent] Target auto-accept failed:', err);
        }
      }

      currentlyFetchingTargets = false;
    }, 2000);
  }

  // 2. Loop 2: General minReward search catcher (runs at configured search interval)
  const intervalSeconds = parseInt(activeTaskgroup.interval, 10) || 60;
  const intervalMs = intervalSeconds * 1000;
  console.log(`[MTurk Agent] Starting general minReward ($${activeTaskgroup.minReward}) catcher scan every ${intervalSeconds} seconds.`);
  
  // Run once immediately on config update
  runGeneralCatcherSearch();
  
  searchIntervalId = setInterval(() => {
    runGeneralCatcherSearch();
  }, intervalMs);
}

// Request initial taskgroup config on load
try {
  chrome.runtime.sendMessage({ type: 'get_taskgroup_config' }, (response) => {
    if (response && response.taskgroup) {
      console.log('[MTurk Agent] Loaded initial TaskGroup config:', response.taskgroup);
      updateTaskgroupConfig(response.taskgroup);
    }
  });
} catch (e) {
  console.warn('[MTurk Agent] Failed to query initial config from background script.');
}

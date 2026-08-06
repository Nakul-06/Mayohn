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

// Scrape on load
scrapeMTurkPage();

// Periodic scrape while page is open (every 10 seconds)
setInterval(scrapeMTurkPage, 10000);

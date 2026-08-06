const rdpNameInput = document.getElementById('rdpName');
const serverUrlInput = document.getElementById('serverUrl');
const saveBtn = document.getElementById('saveBtn');
const srvStatus = document.getElementById('srv-status');
const workerIdVal = document.getElementById('worker-id-val');
const statEarn = document.getElementById('stat-earn');
const statQueue = document.getElementById('stat-queue');

// Load settings and fetch status
function initPopup() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
    if (response) {
      rdpNameInput.value = response.rdpName || '';
      serverUrlInput.value = response.serverUrl || '';
      
      // Update Server Connection Status
      if (response.connected) {
        srvStatus.textContent = 'Connected';
        srvStatus.className = 'status-val connected';
      } else {
        srvStatus.textContent = 'Disconnected';
        srvStatus.className = 'status-val disconnected';
      }

      // Update Worker ID
      if (response.workerId && response.workerId !== 'Unknown-ID') {
        workerIdVal.textContent = response.workerId;
        workerIdVal.style.color = '#3b82f6';
      } else {
        workerIdVal.textContent = 'Not Logged In';
        workerIdVal.style.color = '#ef4444';
      }

      // Update Statistics
      if (response.stats) {
        statEarn.textContent = `$${parseFloat(response.stats.earningsToday || 0).toFixed(2)}`;
        statQueue.textContent = response.stats.queueSize || 0;
      }
    }
  });
}

// Save Configuration
saveBtn.addEventListener('click', () => {
  const rdpName = rdpNameInput.value.trim() || 'Unknown-RDP';
  const serverUrl = serverUrlInput.value.trim() || 'ws://10.41.156.34:3010';

  chrome.storage.local.set({ rdpName, serverUrl }, () => {
    // Notify background script that settings have changed
    chrome.runtime.sendMessage({ type: 'settings_updated' }, () => {
      saveBtn.textContent = 'Saved!';
      saveBtn.style.backgroundColor = '#10b981';
      
      setTimeout(() => {
        saveBtn.textContent = 'Save & Connect';
        saveBtn.style.backgroundColor = '#2563eb';
        initPopup(); // Refresh status indicators
      }, 1000);
    });
  });
});

// Run on popup load
document.addEventListener('DOMContentLoaded', initPopup);

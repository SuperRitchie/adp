// popup script for the shift schedule to icalendar extension (safari version).
// this script interacts with the active tab to collect shift data from the content
// script and provides user feedback via the popup and, when supported, system
// notifications. safari does not support the notifications api, so when
// notifications are unavailable the script falls back to using alert() for
// important messages.

document.addEventListener('DOMContentLoaded', () => {
  const exportButton = document.getElementById('exportButton');
  const statusDiv = document.getElementById('status');
  // choose the appropriate extension api (chrome or browser) at runtime.
  const extApi = typeof chrome !== 'undefined' && chrome.tabs ? chrome : (typeof browser !== 'undefined' ? browser : null);

  exportButton.addEventListener('click', () => {
    statusDiv.textContent = '';
    exportButton.disabled = true;
    if (!extApi || !extApi.tabs) {
      const msg = 'Extension APIs are unavailable.';
      statusDiv.textContent = msg;
      alert(msg);
      exportButton.disabled = false;
      return;
    }
    // query the active tab to determine whether the user is on the schedule page.
    extApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs.length > 0 ? tabs[0] : null;
      if (!tab) {
        const msg = 'No active tab.';
        statusDiv.textContent = msg;
        // safari does not support notifications api, so use alert for emphasis.
        alert(msg);
        exportButton.disabled = false;
        return;
      }
      // basic check for the schedule page; adjust the regex if your schedule url differs.
      const url = tab.url || '';
      if (!/\/wfd\//.test(url)) {
        const msg = 'Please navigate to your schedule page before exporting.';
        statusDiv.textContent = msg;
        alert(msg);
        exportButton.disabled = false;
        return;
      }
      statusDiv.textContent = 'Collecting shifts…';
      // send a message to the content script to initiate shift collection.
      extApi.tabs.sendMessage(tab.id, { action: 'collectShifts' }, (response) => {
        // handle runtime errors (e.g., content script not found).
        if (extApi.runtime && extApi.runtime.lastError) {
          console.error(extApi.runtime.lastError);
          const msg = 'Failed to communicate with the schedule page.';
          statusDiv.textContent = msg;
          alert(msg);
          exportButton.disabled = false;
          return;
        }
        if (!response || !response.success) {
          const msg = response && response.message ? response.message : 'No shift information found.';
          statusDiv.textContent = msg;
          alert(msg);
          exportButton.disabled = false;
          return;
        }
        // the content script has already initiated download of the .ics file.
        const successMsg = 'File generated. Check your downloads.';
        statusDiv.textContent = successMsg;
        // without notification support, we rely on the status text and optionally alert.
        alert(successMsg);
        exportButton.disabled = false;
      });
    });
  });
});
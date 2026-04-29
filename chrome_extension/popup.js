document.addEventListener('DOMContentLoaded', () => {
  const exportButton = document.getElementById('exportButton');
  const statusDiv = document.getElementById('status');

    exportButton.addEventListener('click', () => {
      statusDiv.textContent = '';
      exportButton.disabled = true;
      // query the active tab to determine whether the user is on the schedule page. we
      // only attempt to contact the content script if the url contains the expected
      // path segment ("/wfd/"). otherwise, we display a helpful message and
      // re‑enable the export button.
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const tab = tabs[0];
        if (!tab) {
          const msg = 'No active tab.';
          statusDiv.textContent = msg;
          // show a notification so the user notices immediately
          if (chrome.notifications) {
            chrome.notifications.create('', {
              type: 'basic',
              iconUrl: 'icons/icon-48.png',
              title: 'Shift Export',
              message: msg
            });
          }
          exportButton.disabled = false;
          return;
        }
        // basic check for the schedule page; adjust the regex if your schedule url differs.
        const url = tab.url || '';
        if (!/\/wfd\//.test(url)) {
          const msg = 'Please navigate to your schedule page before exporting.';
          statusDiv.textContent = msg;
          if (chrome.notifications) {
            chrome.notifications.create('', {
              type: 'basic',
              iconUrl: 'icons/icon-48.png',
              title: 'Shift Export',
              message: msg
            });
          }
          exportButton.disabled = false;
          return;
        }
        statusDiv.textContent = 'Collecting shifts…';
        // send a message to the content script to initiate shift collection.
        chrome.tabs.sendMessage(tab.id, { action: 'collectShifts' }, function (response) {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError);
            const msg = 'Failed to communicate with the schedule page.';
            statusDiv.textContent = msg;
            if (chrome.notifications) {
              chrome.notifications.create('', {
                type: 'basic',
                iconUrl: 'icons/icon-48.png',
                title: 'Shift Export',
                message: msg
              });
            }
            exportButton.disabled = false;
            return;
          }
          if (!response || !response.success) {
            const msg = response && response.message ? response.message : 'No shift information found.';
            statusDiv.textContent = msg;
            if (chrome.notifications) {
              chrome.notifications.create('', {
                type: 'basic',
                iconUrl: 'icons/icon-48.png',
                title: 'Shift Export',
                message: msg
              });
            }
            exportButton.disabled = false;
            return;
          }
          // the content script has already initiated download of the .ics file.
          const successMsg = 'File generated. Check your downloads.';
          statusDiv.textContent = successMsg;
          if (chrome.notifications) {
            chrome.notifications.create('', {
              type: 'basic',
              iconUrl: 'icons/icon-48.png',
              title: 'Shift Export',
              message: successMsg
            });
          }
          exportButton.disabled = false;
        });
      });
    });
});
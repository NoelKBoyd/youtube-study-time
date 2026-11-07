// YouTube Study Time - settings page

const keyInput = document.getElementById('api-key');
const status = document.getElementById('status');
const cacheStatus = document.getElementById('cache-status');

const TEST_ERRORS = {
  badkey: 'This API key is not valid.',
  disabled: 'YouTube Data API v3 is not enabled for this key\'s project.',
  quota: 'The key works, but today\'s search limit is used up.',
  network: 'Could not reach the YouTube API. Check your connection.',
  api: 'The YouTube API returned an error. Check the key and its restrictions.'
};

function showStatus(element, text, type) {
  element.textContent = text;
  element.className = 'status ' + (type || '');
}

chrome.storage.local.get('apiKey').then(({ apiKey }) => {
  keyInput.value = apiKey || '';
});

document.getElementById('save').addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (apiKey) {
    await chrome.storage.local.set({ apiKey });
    showStatus(status, 'Saved.', 'ok');
  } else {
    await chrome.storage.local.remove('apiKey');
    showStatus(status, 'Key removed.', 'ok');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) return showStatus(status, 'Paste a key first.', 'error');

  showStatus(status, 'Testing…');
  const result = await chrome.runtime.sendMessage({ type: 'testKey', apiKey });
  if (result.error) {
    showStatus(status, TEST_ERRORS[result.error] || TEST_ERRORS.api, 'error');
  } else {
    showStatus(status, 'The key works. Remember to click Save.', 'ok');
  }
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const everything = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(everything).filter((key) => key.startsWith('cache:'));
  await chrome.storage.local.remove(cacheKeys);
  showStatus(cacheStatus, `Cleared ${cacheKeys.length} saved result page(s).`, 'ok');
});

// Study Time for YouTube - settings page

fillIcons();

const keyInput = document.getElementById('api-key');
const toggleKey = document.getElementById('toggle-key');
const status = document.getElementById('status');

const TEST_ERRORS = {
  badkey: 'This API key is not valid.',
  disabled: 'YouTube Data API v3 is not enabled for this key\'s project.',
  quota: 'The key works, but today\'s search limit is used up.',
  network: 'Could not reach the YouTube API. Check your connection.',
  api: 'The YouTube API returned an error. Check the key and its restrictions.'
};

const BANNER_ICONS = { success: 'check_circle', error: 'error', info: 'schedule' };

// The inline result of "Test key": type is 'success', 'error' or 'info' (in progress).
function showStatus(text, type) {
  status.className = 'yst-banner' + (type === 'info' ? '' : ` yst-${type}`);
  status.replaceChildren(makeIcon(BANNER_ICONS[type]), document.createTextNode(text));
  status.hidden = false;
}

chrome.storage.local.get('apiKey').then(({ apiKey }) => {
  keyInput.value = apiKey || '';
});

toggleKey.addEventListener('click', () => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  const label = show ? 'Hide key' : 'Show key';
  toggleKey.setAttribute('aria-pressed', String(show));
  toggleKey.setAttribute('aria-label', label);
  toggleKey.dataset.tooltip = label;
});

document.getElementById('save').addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  status.hidden = true;
  if (apiKey) {
    await chrome.storage.local.set({ apiKey });
    showSnackbar('Key saved.');
  } else {
    await chrome.storage.local.remove('apiKey');
    showSnackbar('Key removed.');
  }
});

document.getElementById('test').addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) return showStatus('Paste a key first.', 'error');

  showStatus('Testing…', 'info');
  const result = await chrome.runtime.sendMessage({ type: 'testKey', apiKey });
  if (result.error) {
    showStatus(TEST_ERRORS[result.error] || TEST_ERRORS.api, 'error');
  } else {
    showStatus('The key works. Remember to click Save.', 'success');
  }
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const everything = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(everything).filter((key) => key.startsWith('cache:'));
  await chrome.storage.local.remove(cacheKeys);
  showSnackbar(`Cleared ${cacheKeys.length} saved result page(s).`);
});

// Popup: the compact control surface (decision #11) - open the reader for
// the active tab, pick the target language, and links out to vocab/options.
import { getSettings, saveSettings } from '../storage/settings';
import { sendTypedMessage } from '../core/messages';

async function main(): Promise<void> {
  const openBtn = document.getElementById('open-reader-btn') as HTMLButtonElement | null;
  const langSelect = document.getElementById('target-lang') as HTMLSelectElement | null;
  const statusEl = document.getElementById('status');
  if (!openBtn || !langSelect || !statusEl) throw new Error('popup.html markup out of sync.');

  const settings = await getSettings();
  langSelect.value = settings.targetLang;
  langSelect.addEventListener('change', () => {
    void saveSettings({ targetLang: langSelect.value });
  });

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    statusEl.textContent = 'Dang mo reader...';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Khong tim thay tab hien tai.');
      const response = await sendTypedMessage({ type: 'OPEN_READER_REQUEST', tabId: tab.id });
      if (!response.ok) {
        statusEl.textContent = response.error;
        openBtn.disabled = false;
      }
      // On success the tab navigates to reader.html and this popup closes on its own.
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : 'Loi khong xac dinh.';
      openBtn.disabled = false;
    }
  });
}

main().catch((err: unknown) => {
  console.error('Popup init failed', err);
});

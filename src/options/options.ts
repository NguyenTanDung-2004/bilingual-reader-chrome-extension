// Options page (decision #11 + #13): target language, font size, cache
// folder picker (decision #7 - always optional, never blocks reading),
// clear-cache, and the R10 privacy blocklist editor.
import { getSettings, saveSettings } from '../storage/settings';
import {
  chooseCacheFolder,
  clearAllCache,
  forgetCacheFolder,
  getActiveBackend,
  hasUserFolderConfigured,
  type CacheBackend,
} from '../storage/fs-cache';

const BACKEND_LABELS: Record<CacheBackend, string> = {
  'user-folder': 'Thu muc ban da chon',
  opfs: 'Bo nho noi bo trinh duyet (OPFS) - tu dong, khong can quyen',
  memory: 'Chi trong bo nho trang (khong ben vung giua cac phien)',
};

async function main(): Promise<void> {
  const targetLang = document.getElementById('opt-target-lang') as HTMLSelectElement | null;
  const fontSize = document.getElementById('opt-font-size') as HTMLInputElement | null;
  const fontSizeLabel = document.getElementById('opt-font-size-label');
  const blockedDomains = document.getElementById('opt-blocked-domains') as HTMLTextAreaElement | null;
  const saveBtn = document.getElementById('opt-save-btn') as HTMLButtonElement | null;
  const savedMsg = document.getElementById('opt-saved-msg');
  const chooseFolderBtn = document.getElementById('opt-choose-folder-btn') as HTMLButtonElement | null;
  const forgetFolderBtn = document.getElementById('opt-forget-folder-btn') as HTMLButtonElement | null;
  const clearCacheBtn = document.getElementById('opt-clear-cache-btn') as HTMLButtonElement | null;
  const backendLabel = document.getElementById('opt-backend-label');
  const privacyAck = document.getElementById('opt-privacy-ack') as HTMLInputElement | null;

  if (
    !targetLang ||
    !fontSize ||
    !fontSizeLabel ||
    !blockedDomains ||
    !saveBtn ||
    !savedMsg ||
    !chooseFolderBtn ||
    !forgetFolderBtn ||
    !clearCacheBtn ||
    !backendLabel ||
    !privacyAck
  ) {
    throw new Error('options.html markup out of sync.');
  }

  const settings = await getSettings();
  targetLang.value = settings.targetLang;
  fontSize.value = String(settings.fontSizePx);
  fontSizeLabel.textContent = `${settings.fontSizePx}px`;
  blockedDomains.value = settings.blockedDomains.join('\n');
  privacyAck.checked = settings.privacyNoticeAcknowledged;

  fontSize.addEventListener('input', () => {
    fontSizeLabel.textContent = `${fontSize.value}px`;
  });

  async function refreshBackendUi(): Promise<void> {
    const backend = await getActiveBackend();
    backendLabel!.textContent = BACKEND_LABELS[backend];
    forgetFolderBtn!.hidden = !(await hasUserFolderConfigured());
  }
  await refreshBackendUi();

  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      targetLang: targetLang.value,
      fontSizePx: Number(fontSize.value),
      blockedDomains: blockedDomains.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      privacyNoticeAcknowledged: privacyAck.checked,
    });
    savedMsg.textContent = 'Da luu.';
    setTimeout(() => {
      savedMsg.textContent = '';
    }, 1500);
  });

  chooseFolderBtn.addEventListener('click', async () => {
    const ok = await chooseCacheFolder(); // must run inside this click handler - needs a user gesture
    if (ok) {
      await saveSettings({ cacheFolderConfigured: true });
    } else {
      backendLabel.textContent = 'Khong chon duoc thu muc (da huy, hoac trinh duyet khong ho tro File System Access).';
    }
    await refreshBackendUi();
  });

  forgetFolderBtn.addEventListener('click', async () => {
    await forgetCacheFolder();
    await saveSettings({ cacheFolderConfigured: false });
    await refreshBackendUi();
  });

  clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('Xoa toan bo cache ban dich da luu? Hanh dong nay khong the hoan tac.')) return;
    await clearAllCache();
    alert('Da xoa cache.');
  });
}

main().catch((err: unknown) => {
  console.error('Options page failed to initialize', err);
});

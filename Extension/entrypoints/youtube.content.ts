import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';

function getChannelIdFromUrl(): string | null {
  const m = location.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  return m ? m[1] : null;
}

function findSubscribeButton(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>(
    'ytd-subscribe-button-renderer button, yt-button-shape button, #subscribe-button button',
  );
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() ?? '';
    if (text.includes('subscribe') && !text.includes('subscribed')) return btn;
  }
  return null;
}

function createOverlayButton(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'feedtube-sub-overlay';
  overlay.style.cssText = `
    position: absolute; inset: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  `;
  const btn = document.createElement('button');
  btn.textContent = '+ FeedTube';
  btn.style.cssText = `
    background: #f0484a; color: #fff; border: none; border-radius: 20px;
    padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: system-ui, -apple-system, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
    transition: background .15s;
  `;
  btn.onmouseenter = () => (btn.style.background = '#d93c3e');
  btn.onmouseleave = () => (btn.style.background = '#f0484a');
  overlay.appendChild(btn);
  return overlay;
}

async function showDialog(channelId: string, channelName: string): Promise<string[] | null> {
  const tags = await browser.runtime.sendMessage({ type: 'yt/get-tags' });
  const tagDefs: { name: string; color: string }[] = tags ?? [];

  return new Promise<string[] | null>((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.id = 'feedtube-dialog-backdrop';
    backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    const selected = new Set<string>();

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #1a1d24; color: #e9ecf1; border: 1px solid #333;
      border-radius: 14px; padding: 24px; min-width: 320px; max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5);
    `;

    dialog.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:4px">Subscribe to ${channelName}</div>
      <div style="font-size:12px;color:#98a2b3;margin-bottom:16px">Assign tags to this channel</div>
      <div id="ft-tag-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px"></div>
      <div id="ft-msg" style="font-size:12px;color:#6b7484;margin-bottom:12px"></div>
      <div style="display:flex;gap:8;justify-content:flex-end">
        <button id="ft-cancel" style="
          padding:7px 16px;border-radius:8px;border:1px solid #333;
          background:transparent;color:#98a2b3;font-size:13px;font-weight:500;cursor:pointer
        ">Cancel</button>
        <button id="ft-subscribe" style="
          padding:7px 16px;border-radius:8px;border:none;
          background:#f0484a;color:#fff;font-size:13px;font-weight:600;cursor:pointer
        ">Subscribe</button>
      </div>
    `;

    const tagList = dialog.querySelector('#ft-tag-list')!;
    const msg = dialog.querySelector('#ft-msg')!;

    if (tagDefs.length === 0) {
      msg.textContent = 'No tags yet. Channel will be added without tags.';
    }

    for (const t of tagDefs) {
      const row = document.createElement('label');
      row.style.cssText = `
        display:flex;align-items:center;gap:8px;padding:6px 8px;
        border-radius:8px;cursor:pointer;font-size:13px;
      `;
      row.onmouseenter = () => (row.style.background = '#22262e');
      row.onmouseleave = () => (row.style.background = 'transparent');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = `accent-color:${t.color};width:15px;height:15px`;
      cb.onchange = () => {
        if (cb.checked) selected.add(t.name);
        else selected.delete(t.name);
      };

      const dot = document.createElement('span');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${t.color};flex-shrink:0`;

      const label = document.createElement('span');
      label.textContent = t.name;

      row.append(cb, dot, label);
      tagList.appendChild(row);
    }

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const close = (result: string[] | null) => {
      backdrop.remove();
      resolve(result);
    };

    dialog.querySelector('#ft-cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
    dialog.querySelector('#ft-subscribe')!.addEventListener('click', () =>
      close(Array.from(selected)),
    );
  });
}

let running = false;

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await browser.runtime.sendMessage({ type: 'yt/get-settings' });
    if (!settings?.replaceSubscribeButton) return;

    const channelId = getChannelIdFromUrl();
    if (!channelId) return;

    const subBtn = findSubscribeButton();
    if (!subBtn) return;

    const container = subBtn.closest('ytd-subscribe-button-renderer, yt-button-shape');
    if (!container) return;

    const existing = document.getElementById('feedtube-sub-overlay');
    if (existing) return;

    const channelName =
      document.querySelector('#channel-name yt-formatted-string, #channel-name a')?.textContent?.trim() ??
      channelId;

    const overlay = createOverlayButton();
    (container as HTMLElement).style.position = 'relative';
    (container as HTMLElement).appendChild(overlay);

    overlay.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const selectedTags = await showDialog(channelId, channelName);
      if (selectedTags === null) return;

      await browser.runtime.sendMessage({
        type: 'yt/subscribe',
        channelId,
        channelName,
        tags: selectedTags,
      });

      overlay.remove();
    });
  } finally {
    running = false;
  }
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const observer = new MutationObserver(() => void run());
    observer.observe(document.body, { childList: true, subtree: true });
    void run();
  },
});

// Two-way sentence highlight sync (hover/click, via data-sid + event
// delegation - decision #9 explicitly rules out scroll-sync JS, but this
// per-sentence highlight is the separate "Đồng bộ Highlight Câu" feature)
// and the text-selection-to-vocab flow (bôi đen -> "Lưu" -> vocab-repo).
import type { RenderedSentenceRefs } from './render';

const HIGHLIGHT_CLASS = 'br-highlight';
const SENTENCE_SELECTOR = '.br-sentence';

function closestSentence(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof Element)) return null;
  return el.closest<HTMLElement>(SENTENCE_SELECTOR);
}

/** Wires hover + click highlight sync between the orig/trans span for the same sentence id. Click "pins" a sentence until it (or nothing) is clicked again. */
export function wireHighlightSync(root: HTMLElement, sentenceRefs: Map<string, RenderedSentenceRefs>): void {
  let pinnedSid: string | null = null;

  function setHighlight(sid: string, on: boolean): void {
    const refs = sentenceRefs.get(sid);
    if (!refs) return;
    refs.origEl.classList.toggle(HIGHLIGHT_CLASS, on);
    refs.transEl.classList.toggle(HIGHLIGHT_CLASS, on);
  }

  root.addEventListener('mouseover', (e) => {
    const sid = closestSentence(e.target)?.dataset.sid;
    if (sid && sid !== pinnedSid) setHighlight(sid, true);
  });
  root.addEventListener('mouseout', (e) => {
    const sid = closestSentence(e.target)?.dataset.sid;
    if (sid && sid !== pinnedSid) setHighlight(sid, false);
  });
  root.addEventListener('click', (e) => {
    const sid = closestSentence(e.target)?.dataset.sid;
    if (pinnedSid) setHighlight(pinnedSid, false);
    pinnedSid = sid && sid !== pinnedSid ? sid : null;
    if (pinnedSid) setHighlight(pinnedSid, true);
  });
}

/** Returns the plain-text offset of (node, offset) relative to the start of `container`, via the standard Range-length trick. */
function offsetWithin(container: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

export interface SelectionContext {
  term: string;
  contextText: string;
  contextStart: number;
  contextEnd: number;
}

/** Inspects the current window selection; returns null unless it's a non-empty selection fully inside one original-column sentence span. */
function resolveSelectionContext(root: HTMLElement): SelectionContext | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);

  const anchorSentence = closestSentence(range.startContainer.parentElement);
  const focusSentence = closestSentence(range.endContainer.parentElement);
  if (!anchorSentence || anchorSentence !== focusSentence) return null; // v1: single-sentence selections only
  if (!root.contains(anchorSentence)) return null;
  if (!anchorSentence.closest('.br-cell--left')) return null; // only save from the original column

  const contextText = anchorSentence.textContent ?? '';
  let start = offsetWithin(anchorSentence, range.startContainer, range.startOffset);
  let end = offsetWithin(anchorSentence, range.endContainer, range.endOffset);
  if (start > end) [start, end] = [end, start];

  const raw = contextText.slice(start, end);
  const term = raw.trim();
  if (term.length === 0) return null;
  start += raw.indexOf(term);
  end = start + term.length;

  return { term, contextText, contextStart: start, contextEnd: end };
}

export interface SaveVocabDeps {
  /** Translates a single term/phrase (a small ad-hoc request through the same TRANSLATE_BATCH channel as the sentence pipeline). */
  translateTerm(text: string): Promise<string>;
  saveEntry(input: {
    term: string;
    translation: string;
    contextText: string;
    contextStart: number;
    contextEnd: number;
  }): Promise<void>;
  /** Appends "<term>:<translation>" as a new line to this article's plain-text vocab file, if popup.ts got a folder for this tab. Returns false (never throws) when there is no file to write to - the caller only reports it, chrome.storage via saveEntry is what actually counts. */
  saveToFile(term: string, translation: string): Promise<boolean>;
}

/**
 * Builds the "edit before saving" card: English/Vietnamese fields (both
 * editable - the user may select a term whose auto-translation is
 * imperfect, or want to save extra context) with a Save button that fires
 * both deps.saveEntry (chrome.storage - backs the Vocab page/CSV export)
 * and deps.saveToFile (this article's plain-text file), in parallel.
 */
function buildSaveModal(deps: SaveVocabDeps): { el: HTMLElement; open: (ctx: SelectionContext) => void } {
  const el = document.createElement('div');
  el.className = 'br-save-modal';
  el.hidden = true;
  // Click on the dimmed backdrop (not the card itself) cancels, like any modal.
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) close();
  });

  const card = document.createElement('div');
  card.className = 'br-save-modal-card';
  el.appendChild(card);

  function addField(labelText: string): HTMLInputElement {
    const label = document.createElement('label');
    label.className = 'br-save-field';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    label.appendChild(input);
    card.appendChild(label);
    return input;
  }

  const enInput = addField('English');
  const viInput = addField('Vietnamese');

  const status = document.createElement('div');
  status.className = 'br-save-modal-status';
  card.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'br-save-modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Huy';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'br-save-modal-confirm';
  saveBtn.textContent = 'Luu';
  actions.append(cancelBtn, saveBtn);
  card.appendChild(actions);

  function close(): void {
    el.hidden = true;
  }
  cancelBtn.addEventListener('click', close);

  let currentCtx: SelectionContext | null = null;
  // Bumped on every open() so a translation response for a since-abandoned
  // selection can never land in the input for whatever is open now.
  let openToken = 0;

  saveBtn.addEventListener('click', () => {
    const term = enInput.value.trim();
    const translation = viInput.value.trim();
    if (!term || !translation || !currentCtx) return;
    const ctx = currentCtx;
    saveBtn.disabled = true;
    status.textContent = 'Dang luu...';
    Promise.all([
      deps.saveEntry({
        term,
        translation,
        contextText: ctx.contextText,
        contextStart: ctx.contextStart,
        contextEnd: ctx.contextEnd,
      }),
      deps.saveToFile(term, translation),
    ])
      .then(([, wroteToFile]) => {
        status.textContent = wroteToFile ? 'Da luu (vocab + file).' : 'Da luu (vocab).';
        setTimeout(close, 700);
      })
      .catch(() => {
        status.textContent = 'Loi, thu lai.';
        saveBtn.disabled = false;
      });
  });

  return {
    el,
    open(ctx: SelectionContext): void {
      currentCtx = ctx;
      const myToken = ++openToken;
      el.hidden = false;
      enInput.value = ctx.term;
      viInput.value = '';
      saveBtn.disabled = true;
      status.textContent = 'Dang dich...';
      deps
        .translateTerm(ctx.term)
        .then((translation) => {
          if (myToken !== openToken) return; // superseded by a newer open() before this resolved
          viInput.value = translation;
          status.textContent = '';
        })
        .catch(() => {
          if (myToken !== openToken) return;
          status.textContent = 'Khong dich duoc - ban co the tu nhap.';
        })
        .finally(() => {
          if (myToken === openToken) saveBtn.disabled = false;
        });
      enInput.focus();
    },
  };
}

/** Wires the "select text -> floating Lưu button -> edit-and-save popup" flow. */
export function wireSelectionSave(root: HTMLElement, container: HTMLElement, deps: SaveVocabDeps): void {
  const popover = document.createElement('button');
  popover.type = 'button';
  popover.className = 'br-save-popover';
  popover.textContent = 'Luu';
  popover.style.display = 'none';
  container.appendChild(popover);

  const modal = buildSaveModal(deps);
  container.appendChild(modal.el);

  let pending: SelectionContext | null = null;

  function hidePopover(): void {
    popover.style.display = 'none';
    pending = null;
  }

  document.addEventListener('selectionchange', () => {
    if (!modal.el.hidden) return; // the edit popup owns the selection UI while it's open
    // Debounce to mouseup-ish timing: selectionchange fires continuously
    // while dragging, so just recompute and reposition each time; cheap.
    const ctx = resolveSelectionContext(root);
    if (!ctx) {
      hidePopover();
      return;
    }
    pending = ctx;
    const selection = window.getSelection();
    const rect = selection?.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hidePopover();
      return;
    }
    const containerRect = container.getBoundingClientRect();
    popover.style.left = `${rect.left - containerRect.left + rect.width / 2}px`;
    popover.style.top = `${rect.top - containerRect.top - 34}px`;
    popover.style.display = 'block';
  });

  popover.addEventListener('mousedown', (e) => {
    // Prevent the click from collapsing the selection before our handler runs.
    e.preventDefault();
  });

  popover.addEventListener('click', () => {
    if (!pending) return;
    const ctx = pending;
    hidePopover();
    modal.open(ctx);
  });
}

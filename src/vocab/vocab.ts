// Vocab management page (decision #11): list, delete, export to Anki CSV.
import { listVocab, deleteVocabEntries } from '../storage/vocab-repo';
import { buildAnkiCsv } from '../core/csv';
import type { VocabEntry } from '../core/types';

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function main(): Promise<void> {
  const tbody = document.getElementById('vocab-tbody');
  const exportBtn = document.getElementById('export-btn') as HTMLButtonElement | null;
  const deleteBtn = document.getElementById('delete-btn') as HTMLButtonElement | null;
  const selectAll = document.getElementById('select-all') as HTMLInputElement | null;
  const emptyState = document.getElementById('empty-state');
  const countLabel = document.getElementById('count-label');
  if (!tbody || !exportBtn || !deleteBtn || !selectAll || !emptyState || !countLabel) {
    throw new Error('vocab.html markup out of sync.');
  }

  let entries: VocabEntry[] = await listVocab();

  function render(): void {
    tbody!.innerHTML = '';
    countLabel!.textContent = `${entries.length} muc`;
    emptyState!.hidden = entries.length > 0;
    for (const entry of entries) {
      const tr = document.createElement('tr');

      const checkTd = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.id = entry.id;
      checkTd.appendChild(checkbox);
      tr.appendChild(checkTd);

      tr.appendChild(cell(entry.term));
      tr.appendChild(cell(entry.translation));
      tr.appendChild(cell(entry.contextText));
      tr.appendChild(cell(entry.sourceTitle));
      tr.appendChild(cell(new Date(entry.createdAt).toLocaleDateString()));
      tbody!.appendChild(tr);
    }
  }

  render();

  selectAll.addEventListener('change', () => {
    tbody!
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = selectAll!.checked;
      });
  });

  deleteBtn.addEventListener('click', async () => {
    const ids = Array.from(tbody!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
      .map((cb) => cb.dataset.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    if (!confirm(`Xoa ${ids.length} muc da chon?`)) return;
    await deleteVocabEntries(ids);
    entries = await listVocab();
    selectAll!.checked = false;
    render();
  });

  exportBtn.addEventListener('click', () => {
    const csv = buildAnkiCsv(entries);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bilingual-reader-vocab.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

main().catch((err: unknown) => {
  console.error('Vocab page failed to initialize', err);
});

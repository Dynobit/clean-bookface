import './local-book.css';
import { exportArchives, type ArchiveKind } from './archive.js';
import { LocalPhotoBudget } from './local-photo.js';
import { LocalBook, LocalExport, selectRecords } from './local-book.js';
import { sampleRecords } from './local-sample.js';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = (tag: string, text = '', cls = '') => {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cls;
  return n;
};
const files = el<HTMLInputElement>('files'),
  search = el<HTMLInputElement>('search'),
  sort = el<HTMLSelectElement>('sort');
let kind = '',
  page = 0,
  urls: string[] = [],
  downloads: string[] = [],
  exporting = false;
let photoBudget = new LocalPhotoBudget();
const exportTask = new LocalExport(exportArchives);
const release = () => {
  photoBudget.cancel();
  urls.forEach(URL.revokeObjectURL);
  urls = [];
};
const dialog = el<HTMLDialogElement>('photo-dialog');
const largePhoto = el<HTMLImageElement>('photo-large');
let photoTrigger: HTMLButtonElement | undefined;
function closePhoto() {
  if (dialog.open) dialog.close();
  largePhoto.removeAttribute('src');
  if (photoTrigger?.isConnected) photoTrigger.focus();
  photoTrigger = undefined;
}
el('photo-close').onclick = closePhoto;
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closePhoto();
});
const cleanup = () => {
  closePhoto();
  exportTask.cancel();
  release();
  downloads.forEach(URL.revokeObjectURL);
  downloads = [];
  exporting = false;
  files.value = '';
};
const labels: Record<ArchiveKind, string> = {
  post: 'Posts',
  photo: 'Photos',
  album: 'Albums',
  message: 'Messages',
  friend: 'Friends',
};
const book = new LocalBook(sampleRecords, (update) =>
  update === 'progress' ? renderStatus() : render(),
);
function renderStatus() {
  const { busy, progress, error } = book.state;
  el('status').textContent = busy
    ? progress
    : error
      ? `Could not open archive: ${error} Your previous book is unchanged.`
      : '';
}
function render() {
  closePhoto();
  release();
  photoBudget = new LocalPhotoBudget();
  const budget = photoBudget;
  const photoJobs: Array<() => Promise<void>> = [];
  const { records, mode, busy, error, warnings, progress } = book.state;
  el('book-title').textContent = mode === 'sample' ? 'Alex’s book' : 'Your book';
  el('book-subtitle').textContent =
    mode === 'sample'
      ? 'A fictional collection. Make yourself at home.'
      : 'Your private collection, for this page only.';
  el('mode').textContent =
    mode === 'sample'
      ? 'THE SAMPLE BOOK · ALL PEOPLE & MEMORIES ARE FICTIONAL'
      : mode === 'empty'
        ? 'AN EMPTY BOOK'
        : 'YOUR TEMPORARY ARCHIVE';
  const filters = el('filters');
  filters.replaceChildren();
  for (const [value, label] of [['', 'All memories'], ...Object.entries(labels)]) {
    const button = node(
      'button',
      `${label}  ${records.filter((r) => !value || r.kind === value).length}`,
    ) as HTMLButtonElement;
    button.setAttribute('aria-pressed', String(kind === value));
    button.onclick = () => {
      kind = value;
      page = 0;
      render();
      el('filters').querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    };
    filters.append(button);
  }
  const selected = selectRecords(records, search.value, kind, sort.value === 'oldest');
  page = Math.max(0, Math.min(page, Math.ceil(selected.length / 12) - 1));
  el('count').textContent = `${selected.length} of ${records.length} memories`;
  el('status').textContent = busy
    ? progress
    : error
      ? `Could not open archive: ${error} Your previous book is unchanged.`
      : '';
  el('cancel').hidden = !busy;
  el<HTMLButtonElement>('export').disabled = !records.length || busy || exporting;
  const warningBox = el('warnings');
  warningBox.replaceChildren();
  if (warnings.length) {
    const details = document.createElement('details');
    details.append(
      node('summary', `${warnings.length} import warnings — review what could not be read`),
    );
    const list = node('ul');
    for (const warning of warnings.slice(0, 100)) list.append(node('li', warning));
    if (warnings.length > 100)
      list.append(node('li', `${warnings.length - 100} more warnings omitted from this view.`));
    details.append(list);
    warningBox.append(details);
  }
  const feed = el('memories');
  feed.replaceChildren();
  for (const record of selected.slice(page * 12, page * 12 + 12)) {
    const card = node('article', '', 'memory');
    const heading = node('div', '', 'memory-heading');
    heading.append(
      node('div', record.kind === 'message' ? '✉' : record.kind === 'album' ? '▤' : 'a', 'avatar'),
    );
    const meta = node('div');
    meta.append(node('h3', record.title || labels[record.kind]));
    meta.append(
      node(
        'p',
        `${record.timestamp === null ? 'Undated' : new Date(record.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })} · ${labels[record.kind]}${record.kind === 'message' ? ' · Private conversation' : ''}`,
      ),
    );
    heading.append(meta);
    card.append(heading, node('p', record.text, 'memory-text'));
    const photos = node('div');
    card.append(photos);
    photoJobs.push(async () => {
      let shown = 0;
      for (const attachment of record.attachments.slice(0, 4)) {
        const admitted = await budget.admit(attachment.bytes, attachment.mimeType);
        if (budget !== photoBudget || !card.isConnected) return;
        if (!admitted) continue;
        const url = URL.createObjectURL(
          new Blob([attachment.bytes], { type: attachment.mimeType }),
        );
        urls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = record.title || 'Archive photo';
        img.loading = 'lazy';
        img.className = 'memory-photo';
        const open = node('button', '', 'photo-open') as HTMLButtonElement;
        open.setAttribute('aria-label', `Open photo: ${record.title || 'Archive photo'}`);
        open.append(img);
        open.onclick = () => {
          closePhoto();
          photoTrigger = open;
          // Reuse the already validated page URL; the dialog adds no unbudgeted image.
          largePhoto.src = url;
          largePhoto.alt = img.alt;
          el('photo-title').textContent = img.alt;
          dialog.showModal();
        };
        photos.append(open);
        shown++;
      }
      if (record.attachments.length > shown && budget === photoBudget && card.isConnected)
        photos.append(
          node(
            'p',
            `${record.attachments.length - shown} attachments have no preview (format, size or page budget). Originals preserved in export.`,
            'hint',
          ),
        );
    });
    card.append(
      node(
        'div',
        mode === 'sample' ? 'Fictional sample · Only on this page' : 'Private archive · Not shared',
        'card-footer',
      ),
    );
    feed.append(card);
  }
  void (async () => {
    for (const job of photoJobs) {
      if (budget !== photoBudget) return;
      await job();
    }
  })();
  if (!selected.length)
    feed.append(
      node(
        'div',
        records.length
          ? 'No memories match. Try another word or category.'
          : 'Your book is clear. Open an archive or return to the sample.',
        'empty',
      ),
    );
  el('page').textContent = selected.length
    ? `Page ${page + 1} of ${Math.ceil(selected.length / 12)}`
    : 'No pages';
  el<HTMLButtonElement>('previous').disabled = page === 0;
  el<HTMLButtonElement>('next').disabled = (page + 1) * 12 >= selected.length;
}
files.onchange = () => {
  const selected = Array.from(files.files ?? []);
  files.value = '';
  if (selected.length) {
    cleanup();
    page = 0;
    void book.open(selected);
  }
};
search.oninput = sort.onchange = () => {
  page = 0;
  render();
};
el('cancel').onclick = () => book.cancel();
el('clear').onclick = () => {
  cleanup();
  search.value = '';
  kind = '';
  page = 0;
  book.clear();
};
el('sample').onclick = () => {
  cleanup();
  search.value = '';
  kind = '';
  page = 0;
  book.reset();
};
el('previous').onclick = () => {
  page--;
  render();
  el('memories').focus();
};
el('next').onclick = () => {
  page++;
  render();
  el('memories').focus();
};
el('export').onclick = async () => {
  exporting = true;
  render();
  const result = await exportTask.run(book.state.records, (blob) => {
    const url = URL.createObjectURL(blob);
    downloads.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'clean-bookface-book.zip';
    link.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      downloads = downloads.filter((x) => x !== url);
    }, 30000);
  });
  if (result === 'cancelled') return;
  if (result === 'failed')
    el('status').textContent = 'Export failed. Keep your originals and try a smaller collection.';
  exporting = false;
  el<HTMLButtonElement>('export').disabled = !book.state.records.length || book.state.busy;
};
window.addEventListener('pagehide', () => {
  cleanup();
  book.clear();
  search.value = '';
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    cleanup();
    search.value = '';
    kind = '';
    page = 0;
    book.clear();
  }
});
render();

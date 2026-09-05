// SPDX-License-Identifier: GPL-3.0-or-later
// Keeping work.
//
// Two places, on purpose. The browser remembers what you were doing, and a file
// keeps it for real -- because browser storage is not a safe place to leave
// something you care about. A private window forgets it at once; "clear site
// data" takes it; iOS throws away everything a site stored if the site has not
// been opened for seven days and was never installed. A gallery that pretends
// otherwise would be a promise the browser has not made.
//
// Cookies are not used here and would be the wrong tool if they were: they are
// sent to the server with every request, which for a static site means handing
// the host what the person is working on, and four kilobytes is not a picture.
// IndexedDB is the opposite -- it never leaves the machine, it holds blobs
// rather than strings, and there is room in it for photographs.

const DB_NAME = 'braille-art';
const DB_VERSION = 1;
const STORE = 'works';

/** The format written to a file. Bumped only when older files must still open. */
export const FILE_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(Object.assign(new Error('no indexeddb'), { i18n: 'works.unavailable' }));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('saved', 'saved');
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    // Blocked site data, private mode with storage off: report it rather than
    // hang, so the panel can say the gallery is not available here.
    request.addEventListener('error', () => reject(
      Object.assign(new Error('indexeddb refused'), { i18n: 'works.unavailable' }),
    ));
  });
}

function run(mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
    transaction.addEventListener('complete', () => db.close());
  }));
}

/** Everything saved, newest first, without the pictures. */
export async function listWorks() {
  const all = await run('readonly', (store) => store.getAll());
  return all
    .map(({ id, name, saved, cols, rows, source, thumb, art, kind }) => ({
      id, name, saved, cols, rows, thumb: thumb ?? null,
      // A style is the same record with the picture and the art left out: it
      // says how to make one, not what was made.
      kind: kind === 'style' ? 'style' : 'work',
      source: source?.kind ?? 'image',
      // What this one work costs, which is not the same question as what the
      // whole site is using: the offline cache is most of that.
      bytes: (source?.blob?.size ?? 0) + (thumb?.size ?? 0) + (art?.length ?? 0),
    }))
    .sort((a, b) => b.saved - a.saved);
}

export const readWork = (id) => run('readonly', (store) => store.get(id));
export const deleteWork = (id) => run('readwrite', (store) => store.delete(id));

/**
 * Save one, under a name.
 *
 * The id carries the time it was saved: it sorts, it reads, and two works saved
 * in the same millisecond are not a case worth code.
 */
export async function saveWork(work) {
  const saved = Date.now();
  const record = { ...work, id: `${saved}`, saved };
  await run('readwrite', (store) => store.put(record));
  return record;
}

/**
 * One work as one file.
 *
 * JSON with the picture inside it as a data URL: a single file that can be
 * mailed, dropped in a repository or kept in a folder, and opened by a version
 * of this app that has never heard of the machine it came from. Base64 costs a
 * third more bytes than the blob does, and that is the whole price of not
 * needing an archive format or a library to read one.
 */
export async function packWork(work) {
  const source = work.source?.blob
    ? {
      kind: work.source.kind,
      type: work.source.blob.type || 'image/png',
      name: work.source.name ?? '',
      data: await asDataUrl(work.source.blob),
    }
    : null;

  return JSON.stringify({
    app: 'braille-art',
    version: FILE_VERSION,
    name: work.name,
    saved: new Date(work.saved ?? Date.now()).toISOString(),
    cols: work.cols,
    rows: work.rows,
    settings: work.settings,
    art: work.art,
    source,
  }, null, 2);
}

/** And back again, refusing anything that is not one of ours. */
export async function unpackWork(text) {
  let read;
  try {
    read = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('not json'), { i18n: 'works.notOurs' });
  }
  if (!read || read.app !== 'braille-art' || !read.settings) {
    throw Object.assign(new Error('not ours'), { i18n: 'works.notOurs' });
  }
  // A file from a later version opens as far as this one understands it, the
  // same way a link from a later version does.
  return {
    name: typeof read.name === 'string' ? read.name : '',
    saved: Date.parse(read.saved) || Date.now(),
    cols: read.cols ?? 0,
    rows: read.rows ?? 0,
    settings: read.settings,
    art: typeof read.art === 'string' ? read.art : '',
    source: read.source?.data
      ? { kind: read.source.kind ?? 'image', name: read.source.name ?? '', blob: await asBlob(read.source.data) }
      : null,
  };
}

const asDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener('load', () => resolve(reader.result));
  reader.addEventListener('error', () => reject(reader.error));
  reader.readAsDataURL(blob);
});

async function asBlob(dataUrl) {
  const at = String(dataUrl).indexOf(',');
  const head = String(dataUrl).slice(0, at);
  const type = head.slice(head.indexOf(':') + 1, head.indexOf(';')) || 'image/png';
  const bytes = atob(String(dataUrl).slice(at + 1));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type });
}

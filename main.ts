// mend: one patch tool for every AI edit format, as SPEC.md lays it out.
// A patch arrives as a unified diff, a set of SEARCH/REPLACE blocks, a V4A
// patch, or JSON edit calls; mend reads it, applies every edit in order to an
// in-memory copy of the tree, and writes the tree back only when no edit
// failed. Node 22, standard library alone, run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ----- failure channels: ExitTwo is a whole-run refusal (exit 2, one line);
// EditError is a single edit failing (exit 1, the patch still runs on). -----

class ExitTwo extends Error {
  readonly text: string;
  constructor(text: string) {
    super(text);
    this.text = text;
  }
}

class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const parseFault = (lineNo: number): ExitTwo => new ExitTwo(`error: parse ${lineNo}`);

// ----- small text helpers -----

const isBlank = (s: string): boolean => s.trim().length === 0;

/** A patch's lines: split at \n, one trailing \r dropped per line, and no
 *  empty piece after a final \n. An empty text has no lines at all. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.substring(0, p.length - 1) : p));
}

function pathSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function requireSafe(p: string): void {
  if (!pathSafe(p)) throw new EditError('unsafe', p);
}

/** Byte order of the UTF-8 encodings, for the changed-path listing. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ----- the tree: originals are read from disk once; edits stage their
// results in `pending`, and a failed edit's staging is rolled back. -----

class Store {
  private baseCache = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.baseCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.baseCache.set(p, v);
    }
    return this.baseCache.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.pending.has(p) ? (this.pending.get(p) as string | null) : this.original(p);
  }

  put(p: string, v: string | null): void {
    this.pending.set(p, v);
  }
}

// ----- a file as lines: its own break (CRLF when the first \n follows a \r),
// whether it ends with that break, and the lines between the breaks. -----

interface FileShape {
  rows: string[];
  brk: string;
  tail: boolean;
}

function dissect(text: string): FileShape {
  if (text === '') return { rows: [], brk: '\n', tail: false };
  const firstNl = text.indexOf('\n');
  const brk = firstNl > 0 && text.charAt(firstNl - 1) === '\r' ? '\r\n' : '\n';
  const rows = text.split(brk);
  const tail = text.endsWith(brk);
  if (tail) rows.pop();
  return { rows, brk, tail };
}

function compose(shape: FileShape): string {
  if (shape.rows.length === 0) return '';
  return shape.rows.join(shape.brk) + (shape.tail ? shape.brk : '');
}

// ----- matching old lines in a file (SPEC section 5): three tiers, the
// first tier with an occurrence wins; --strict keeps only tier 0. -----

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Located {
  tier: number;
  at: number[];
}

function locate(rows: string[], old: string[], strict: boolean, from: number): Located | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = from; i + old.length <= rows.length; i += 1) {
      let ok = true;
      for (let k = 0; k < old.length; k += 1) {
        if (!lineEq(rows[i + k] as string, old[k] as string, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: either a context line (ctxOf says which line
 *  of the old block it is, so the file's own matched line is written) or a
 *  fresh line from the patch. */
interface NewLine {
  text: string;
  ctxOf: number | null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** The lines that replace the match at `pos`: context lines come from the
 *  file itself, and at tier 2 fresh lines are re-indented from the old
 *  block's first-line indent onto the file's. */
function buildSeg(rows: string[], pos: number, old: string[], news: NewLine[], tier: number): string[] {
  const fileLead = leadWs(rows[pos] as string);
  const oldLead = leadWs(old[0] as string);
  return news.map((nl) => {
    if (nl.ctxOf !== null) return rows[pos + nl.ctxOf] as string;
    if (tier !== 2) return nl.text;
    if (nl.text === '' || /^[ \t]+$/.test(nl.text)) return nl.text;
    if (!nl.text.startsWith(oldLead)) return nl.text;
    return fileLead + nl.text.substring(oldLead.length);
  });
}

type EditFn = (store: Store, moves: Array<[string, string]>) => void;

// ----- JSON edits (SPEC section 9) -----

function jsonObjectEdit(v: unknown): EditFn | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const path = rec.path;
  if (typeof path !== 'string') return null;

  if (rec.command === 'create') {
    const ft = rec.file_text;
    if (typeof ft !== 'string') return null;
    return (store) => {
      requireSafe(path);
      if (store.get(path) !== null) throw new EditError('exists', path);
      store.put(path, ft);
    };
  }

  if (rec.command === 'str_replace') {
    const os = rec.old_str;
    const ns = rec.new_str;
    if (typeof os !== 'string' || os === '') return null;
    if (ns !== undefined && typeof ns !== 'string') return null;
    const newStr = typeof ns === 'string' ? ns : '';
    return (store) => {
      requireSafe(path);
      const before = store.get(path);
      if (before === null) throw new EditError('missing', path);
      const nlAt = before.indexOf('\n');
      const crlf = nlAt > 0 && before.charAt(nlAt - 1) === '\r';
      const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = norm(before);
      const needle = norm(os);
      let hits = 0;
      let firstAt = -1;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) {
        if (firstAt < 0) firstAt = k;
        hits += 1;
      }
      if (hits === 0) throw new EditError('no-match', path);
      if (hits > 1) throw new EditError('ambiguous', path);
      const joined = hay.substring(0, firstAt) + norm(newStr) + hay.substring(firstAt + needle.length);
      store.put(path, crlf ? joined.split('\n').join('\r\n') : joined);
    };
  }

  if (rec.command === 'insert') {
    const il = rec.insert_line;
    const ns = rec.new_str;
    if (typeof il !== 'number' || !Number.isInteger(il) || typeof ns !== 'string') return null;
    const addRows = splitPatch(ns);
    return (store) => {
      requireSafe(path);
      const before = store.get(path);
      if (before === null) throw new EditError('missing', path);
      const shape = dissect(before);
      if (il < 0 || il > shape.rows.length) throw new EditError('no-match', path);
      shape.rows.splice(il, 0, ...addRows);
      store.put(path, compose(shape));
    };
  }

  return null;
}

function parseJson(text: string, rows: string[]): EditFn[] {
  const firstIdx = rows.findIndex((r) => !isBlank(r));
  if (firstIdx < 0) throw parseFault(1);
  if ((rows[firstIdx] as string).trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw parseFault(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw parseFault(firstIdx + 1);
    const edits: EditFn[] = [];
    for (const item of parsed) {
      const e = jsonObjectEdit(item);
      if (e === null) throw parseFault(firstIdx + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: EditFn[] = [];
  rows.forEach((row, i) => {
    if (isBlank(row)) return;
    let e: EditFn | null = null;
    try {
      e = jsonObjectEdit(JSON.parse(row));
    } catch {
      e = null;
    }
    if (e === null) throw parseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

// ----- format detection (SPEC section 4) -----

function detectFormat(rows: string[]): string | null {
  const fi = rows.findIndex((r) => !isBlank(r));
  if (fi < 0) return null;
  const first = rows[fi] as string;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const lead = first.trimStart();
  if (lead.startsWith('[') || lead.startsWith('{')) return 'json';
  if (rows.some((r) => r.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const hasDiff = rows.some(
    (r, i) => r.startsWith('diff --git ') || (r.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')),
  );
  return hasDiff ? 'unified' : null;
}

// ----- unified diffs (SPEC section 6) -----

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renFrom: string | null;
  renTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line
 *  is not of that form. */
function gitLinePaths(line: string): [string, string] | null {
  const m = /^a\/(.+) b\/(.+)$/.exec(line.substring('diff --git '.length));
  if (m === null) return null;
  return [m[1] as string, m[2] as string];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to
 *  the first tab, spaces around it removed, a leading a/ or b/ stripped. */
function headerPathOf(line: string): string {
  let t = line.substring(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.substring(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.substring(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;

/** A hunk body read as old lines and replacement lines, plus whether a
 *  backslash line follows the last context or + line (the file then ends
 *  without a line break when the match runs to its end). */
function decodeBody(body: string[]): { old: string[]; news: NewLine[]; noBreak: boolean } {
  const old: string[] = [];
  const news: NewLine[] = [];
  let lastNewIdx = -1;
  body.forEach((raw, idx) => {
    if (raw.startsWith('\\')) return;
    const kind = raw === '' ? ' ' : (raw[0] as string);
    const text = raw === '' ? '' : raw.substring(1);
    if (kind === ' ') {
      old.push(text);
      news.push({ text, ctxOf: old.length - 1 });
      lastNewIdx = idx;
    } else if (kind === '-') {
      old.push(text);
    } else if (kind === '+') {
      news.push({ text, ctxOf: null });
      lastNewIdx = idx;
    }
  });
  const noBreak = lastNewIdx >= 0 && (body[lastNewIdx + 1] ?? '').startsWith('\\');
  return { old, news, noBreak };
}

/** Apply one section's hunks in order to a file's shape. `d` tracks the
 *  running length change, which shifts where later hunks aim. */
function applyHunks(shape: FileShape, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { old, news, noBreak } = decodeBody(h.body);
    if (old.length > 0) {
      const loc = locate(shape.rows, old, strict, 0);
      if (loc === null) throw new EditError('no-match', path);
      const target = h.a - 1 + d;
      let best = loc.at[0] as number;
      for (const p of loc.at) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const seg = buildSeg(shape.rows, best, old, news, loc.tier);
      const reachesEnd = best + old.length === shape.rows.length;
      shape.rows.splice(best, old.length, ...seg);
      if (reachesEnd) shape.tail = !noBreak;
      d += news.length - old.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > shape.rows.length) pos = shape.rows.length;
      const atEnd = pos === shape.rows.length;
      shape.rows.splice(pos, 0, ...news.map((nl) => nl.text));
      if (atEnd) shape.tail = !noBreak;
      d += news.length;
    }
  }
}

function unifiedEdit(sec: Section, strict: boolean): EditFn {
  const oldPath = (sec.minusPath ?? sec.renFrom ?? sec.gitOld) as string;
  const newPath = (sec.plusPath ?? sec.renTo ?? sec.gitNew) as string;
  const creation = sec.isNew || oldPath === '/dev/null';
  const deletion = !creation && (sec.isDel || newPath === '/dev/null');
  return (store, moves) => {
    if (creation) {
      requireSafe(newPath);
      if (store.get(newPath) !== null) throw new EditError('exists', newPath);
      const rowsOut: string[] = [];
      const stream: string[] = [];
      for (const h of sec.hunks) {
        for (const raw of h.body) {
          stream.push(raw);
          if (raw.startsWith('+')) rowsOut.push(raw.substring(1));
        }
      }
      let noBreak = false;
      for (let k = stream.length - 1; k >= 0; k -= 1) {
        if ((stream[k] as string).startsWith('+')) {
          noBreak = (stream[k + 1] ?? '').startsWith('\\');
          break;
        }
      }
      store.put(newPath, rowsOut.length === 0 ? '' : rowsOut.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      requireSafe(oldPath);
      if (store.get(oldPath) === null) throw new EditError('missing', oldPath);
      store.put(oldPath, null);
      return;
    }
    requireSafe(oldPath);
    if (newPath !== oldPath) requireSafe(newPath);
    const content = store.get(oldPath);
    if (content === null) throw new EditError('missing', oldPath);
    if (newPath !== oldPath && store.get(newPath) !== null) throw new EditError('exists', newPath);
    const shape = dissect(content);
    applyHunks(shape, sec.hunks, strict, oldPath);
    const text = compose(shape);
    if (newPath !== oldPath) {
      store.put(newPath, text);
      store.put(oldPath, null);
      moves.push([oldPath, newPath]);
    } else {
      store.put(oldPath, text);
    }
  };
}

function parseUnified(rows: string[], strict: boolean): EditFn[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const open = (): Section => {
    const s: Section = {
      gitOld: null,
      gitNew: null,
      minusPath: null,
      plusPath: null,
      renFrom: null,
      renTo: null,
      isNew: false,
      isDel: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < rows.length) {
    const line = rows[i] as string;
    if (line.startsWith('diff --git ')) {
      const gp = gitLinePaths(line);
      if (gp === null) throw parseFault(i + 1);
      const s = open();
      s.gitOld = gp[0];
      s.gitNew = gp[1];
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw parseFault(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw parseFault(i + 1);
      const a = parseInt(m[1] as string, 10);
      i += 1;
      const body: string[] = [];
      while (i < rows.length) {
        const bl = rows[i] as string;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = rows[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const op = headerPathOf(line);
        const np = headerPathOf(next);
        if (cur !== null && cur.minusPath === null && cur.hunks.length === 0) {
          cur.minusPath = op;
          cur.plusPath = np;
        } else {
          const s = open();
          s.minusPath = op;
          s.plusPath = np;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw parseFault(i + 2);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renFrom = line.substring(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.substring(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ----- SEARCH/REPLACE blocks (SPEC section 7) -----

function parseSearchReplace(rows: string[], strict: boolean): EditFn[] {
  interface Block {
    path: string;
    oldRows: string[];
    newRows: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < rows.length) {
    if ((rows[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = searchAt + 1; j < rows.length; j += 1) {
      if ((rows[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw parseFault(searchAt + 1);
    let rep = -1;
    for (let j = eq + 1; j < rows.length; j += 1) {
      if ((rows[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw parseFault(searchAt + 1);
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const t = (rows[j] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw parseFault(searchAt + 1);
      path = prevPath;
    }
    blocks.push({ path, oldRows: rows.slice(searchAt + 1, eq), newRows: rows.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (store) => {
    requireSafe(b.path);
    if (b.oldRows.length === 0) {
      if (store.get(b.path) !== null) throw new EditError('exists', b.path);
      store.put(b.path, b.newRows.length === 0 ? '' : b.newRows.join('\n') + '\n');
      return;
    }
    const content = store.get(b.path);
    if (content === null) throw new EditError('missing', b.path);
    const shape = dissect(content);
    const loc = locate(shape.rows, b.oldRows, strict, 0);
    if (loc === null) throw new EditError('no-match', b.path);
    if (loc.at.length > 1) throw new EditError('ambiguous', b.path);
    const pos = loc.at[0] as number;
    const seg = buildSeg(
      shape.rows,
      pos,
      b.oldRows,
      b.newRows.map((t) => ({ text: t, ctxOf: null })),
      loc.tier,
    );
    shape.rows.splice(pos, b.oldRows.length, ...seg);
    store.put(b.path, compose(shape));
  });
}

// ----- V4A patches (SPEC section 8) -----

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aHeader(line: string): { kind: string; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.substring(14).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'del', path: line.substring(17).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'upd', path: line.substring(17).trim() };
  return null;
}

function findAnchor(rows: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let k = from; k < rows.length; k += 1) {
      if (lineEq(rows[k] as string, anchor, tier)) return k;
    }
  }
  return -1;
}

/** One Update File section: chunks walk a cursor through the file; an
 *  anchor first moves the cursor past the anchored line, and the chunk's
 *  old lines are then taken at their first occurrence from the cursor. */
function applyV4aUpdate(
  store: Store,
  moves: Array<[string, string]>,
  path: string,
  moveTo: string | null,
  chunks: Chunk[],
  strict: boolean,
): void {
  requireSafe(path);
  if (moveTo !== null) requireSafe(moveTo);
  const content = store.get(path);
  if (content === null) throw new EditError('missing', path);
  if (moveTo !== null && store.get(moveTo) !== null) throw new EditError('exists', moveTo);
  const shape = dissect(content);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const at = findAnchor(shape.rows, chunk.anchor, strict, cursor);
      if (at < 0) throw new EditError('no-match', path);
      cursor = at + 1;
    }
    const { old, news } = decodeBody(chunk.body);
    if (old.length > 0) {
      const loc = locate(shape.rows, old, strict, cursor);
      let positions = loc === null ? [] : loc.at;
      if (chunk.eof) positions = positions.filter((p) => p + old.length === shape.rows.length);
      if (loc === null || positions.length === 0) throw new EditError('no-match', path);
      const pos = positions[0] as number;
      const seg = buildSeg(shape.rows, pos, old, news, loc.tier);
      shape.rows.splice(pos, old.length, ...seg);
      cursor = pos + seg.length;
    } else {
      const pos = chunk.eof ? shape.rows.length : Math.min(cursor, shape.rows.length);
      const seg = news.map((nl) => nl.text);
      shape.rows.splice(pos, 0, ...seg);
      cursor = pos + seg.length;
    }
  }
  const text = compose(shape);
  if (moveTo !== null) {
    store.put(moveTo, text);
    store.put(path, null);
    moves.push([path, moveTo]);
  } else {
    store.put(path, text);
  }
}

function parseV4a(rows: string[], strict: boolean): EditFn[] {
  const firstIdx = rows.findIndex((r) => !isBlank(r));
  if (firstIdx < 0) throw parseFault(1);
  if ((rows[firstIdx] as string).trim() !== '*** Begin Patch') throw parseFault(firstIdx + 1);
  let lastIdx = -1;
  for (let k = rows.length - 1; k >= 0; k -= 1) {
    if (!isBlank(rows[k] as string)) {
      lastIdx = k;
      break;
    }
  }
  if ((rows[lastIdx] as string).trim() !== '*** End Patch') throw parseFault(rows.length + 1);

  const edits: EditFn[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = rows[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const hdr = v4aHeader(line);
    if (hdr === null) throw parseFault(i + 1);
    const hdrLine = i + 1;
    i += 1;
    const bodyStart = i;
    let j = i;
    while (j < lastIdx && v4aHeader(rows[j] as string) === null) j += 1;
    let bodyEnd = j;
    while (bodyEnd > bodyStart && isBlank(rows[bodyEnd - 1] as string)) bodyEnd -= 1;
    const body = rows.slice(bodyStart, bodyEnd);
    i = j;

    if (hdr.kind === 'add') {
      const fileRows: string[] = [];
      body.forEach((raw, k) => {
        if (raw.startsWith('+')) fileRows.push(raw.substring(1));
        else if (raw === '') fileRows.push('');
        else throw parseFault(bodyStart + k + 1);
      });
      const p = hdr.path;
      edits.push((store) => {
        requireSafe(p);
        if (store.get(p) !== null) throw new EditError('exists', p);
        store.put(p, fileRows.length === 0 ? '' : fileRows.join('\n') + '\n');
      });
    } else if (hdr.kind === 'del') {
      if (body.length > 0) throw parseFault(bodyStart + 1);
      const p = hdr.path;
      edits.push((store) => {
        requireSafe(p);
        if (store.get(p) === null) throw new EditError('missing', p);
        store.put(p, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      body.forEach((raw, k) => {
        const absLine = bodyStart + k + 1;
        if (k === 0 && raw.startsWith('*** Move to: ')) {
          moveTo = raw.substring(13).trim();
          return;
        }
        if (raw.trim() === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, body: [], eof: false };
          chunk.eof = true;
          chunks.push(chunk);
          chunk = null;
          return;
        }
        if (raw.startsWith('@@')) {
          if (chunk !== null) chunks.push(chunk);
          const at = raw.substring(2).trim();
          chunk = { anchor: at === '' ? null : at, body: [], eof: false };
          return;
        }
        if (raw === '' || raw.startsWith(' ') || raw.startsWith('-') || raw.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, body: [], eof: false };
          chunk.body.push(raw);
          return;
        }
        throw parseFault(absLine);
      });
      if (chunk !== null) chunks.push(chunk);
      if (chunks.length === 0 && moveTo === null) throw parseFault(hdrLine);
      const p = hdr.path;
      const mv = moveTo;
      edits.push((store, moves) => applyV4aUpdate(store, moves, p, mv, chunks, strict));
    }
  }
  return edits;
}

// ----- the run: parse the command line, read the patch, parse it into
// edits, apply them all, and only then touch the disk. -----

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(argv: string[]): { code: number; lines: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const arg of argv) {
    if (!afterDashDash && arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && arg.length > 1 && arg.startsWith('-')) {
      if (arg.startsWith('--format=') && format === null && FORMAT_NAMES.includes(arg.substring(9))) {
        format = arg.substring(9);
        continue;
      }
      if (arg === '--check' && !checkOnly) {
        checkOnly = true;
        continue;
      }
      if (arg === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, lines: ['error: usage'] };
    }
    positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, lines: ['error: usage'] };

  const patchArg = positional.length === 0 ? '-' : (positional[0] as string);
  let patchText: string | null = null;
  try {
    patchText = readFileSync(patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    patchText = null;
  }
  if (patchText === null) {
    if (patchArg !== '-') return { code: 2, lines: ['error: no-patch'] };
    patchText = '';
  }
  const rows = splitPatch(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(rows) : format;
  if (kind === null) return { code: 2, lines: ['error: format'] };

  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(patchText, rows);
    else if (kind === 'unified') edits = parseUnified(rows, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(rows, strict);
    else edits = parseV4a(rows, strict);
    if (edits.length === 0) throw parseFault(1);
  } catch (e) {
    if (e instanceof ExitTwo) return { code: 2, lines: [e.text] };
    throw e;
  }

  const store = new Store();
  const moves: Array<[string, string]> = [];
  const failures: EditError[] = [];
  for (const edit of edits) {
    const savedPending = new Map(store.pending);
    const savedMoves = moves.length;
    try {
      edit(store, moves);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      store.pending.clear();
      for (const [k, v] of savedPending) store.pending.set(k, v);
      moves.length = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      lines: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  const changedPaths: string[] = [];
  for (const p of store.pending.keys()) {
    if (store.pending.get(p) !== store.original(p)) changedPaths.push(p);
  }
  const suppressed = new Set<string>();
  const linesOut: Array<{ key: string; text: string }> = [];
  for (const [o, n] of moves) {
    if (store.original(o) !== null && store.get(o) === null && store.original(n) === null && store.get(n) !== null) {
      linesOut.push({ key: n, text: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of changedPaths) {
    if (suppressed.has(p)) continue;
    const was = store.original(p);
    const now = store.pending.get(p) as string | null;
    linesOut.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  linesOut.sort((x, y) => byteOrder(x.key, y.key));

  if (!checkOnly) {
    for (const p of changedPaths) {
      const now = store.pending.get(p) as string | null;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = linesOut.length;
  return { code: 0, lines: [...linesOut.map((l) => l.text), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

// ----- hand-over: a trial (MAKEFUN_ENV_URL set) goes to runner.ts; anything
// else is the CLI on this process's arguments. -----

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const runner = await import('./runner.ts');
  await runner.runTrial(envUrl);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.lines.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}

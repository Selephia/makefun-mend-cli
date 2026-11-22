// main.ts is mend, the CLI SPEC.md specifies: it applies an AI-written edit in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits) to a tree of text files, matching lines at
// three tiers, changing every file or none. Node 22, the standard library alone; run as
// `node main.ts [options] [PATCH]`. Sections 1-4, 9 and 10 follow the kit starter's code; sections 5-8
// are written here. The last lines hand a trial over to runner.ts: keep them.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the R output rows. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its line break, its lines, and whether it ends with a line break. */
interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function docText(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** A line under a matching tier: 0 as-is, 1 without trailing spaces/tabs, 2 without leading/trailing. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** The leading spaces and tabs of a line. */
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Every 0-based position where O matches the file's lines at a tier; occurrences may overlap. */
function findOccurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, or null. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const pos = findOccurrences(O, lines, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One body line of a hunk or chunk: 'c' context, 'o' old, 'n' new; bs when a '\' line follows it. */
interface BLine {
  k: 'c' | 'o' | 'n';
  t: string;
  bs: boolean;
}

/**
 * A body's old lines O (context and old, in order) and new entries N (context and new, in order);
 * a context entry carries its index into O, a new entry its text with ctx -1.
 */
function splitBody(body: BLine[]): { O: string[]; N: { text: string; ctx: number }[] } {
  const O: string[] = [];
  const N: { text: string; ctx: number }[] = [];
  for (const b of body) {
    if (b.k === 'c') {
      N.push({ text: '', ctx: O.length });
      O.push(b.t);
    } else if (b.k === 'o') {
      O.push(b.t);
    } else {
      N.push({ text: b.t, ctx: -1 });
    }
  }
  return { O, N };
}

/**
 * lines with lines[at .. at+O.length] replaced by N resolved: a context entry writes the file's own
 * matched line; a new entry writes its text, re-indented at tier 2 (P the leading whitespace of O's
 * first line, F that of the file's first matched line; a non-empty, non-whitespace-only new line
 * starting with P has that P replaced by F). With an empty O there is no re-indentation.
 */
function spliceLines(lines: string[], at: number, O: string[], N: { text: string; ctx: number }[], tier: number): string[] {
  const out = lines.slice(0, at);
  const P = O.length > 0 ? lead(O[0]!) : '';
  const F = at < lines.length ? lead(lines[at]!) : '';
  for (const e of N) {
    if (e.ctx >= 0) {
      out.push(lines[at + e.ctx]!);
    } else {
      let t = e.text;
      if (tier === 2 && O.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  for (let i = at + O.length; i < lines.length; i++) out.push(lines[i]!);
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: BLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path named by a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const s = line.slice(4);
  const tab = s.indexOf('\t');
  return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

/** Strip a leading a/ or b/ from a header path; /dev/null means no file. */
function unprefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a hunk header line; null when it is not of the form `@@ -A[,B] +C[,D] @@`. */
function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** Parse a unified diff into its sections. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  // Header state of the current section.
  let headOld: string | undefined;
  let headNew: string | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let gitOld = '';
  let gitNew = '';
  const finish = (): void => {
    if (cur === null) return;
    cur.oldPath = headOld !== undefined ? unprefix(headOld) : renOld !== undefined ? renOld : unprefix(gitOld);
    cur.newPath = headNew !== undefined ? unprefix(headNew) : renNew !== undefined ? renNew : unprefix(gitNew);
    sections.push(cur);
    cur = null;
  };
  const startSection = (gOld: string, gNew: string): void => {
    finish();
    cur = { oldPath: null, newPath: null, newFile: false, delFile: false, hunks: [] };
    inHeader = true;
    headOld = undefined;
    headNew = undefined;
    renOld = undefined;
    renNew = undefined;
    gitOld = gOld;
    gitNew = gNew;
  };
  /** Read a hunk body starting after the header at index h; returns the hunk and the next index. */
  const readBody = (h: number): { hunk: Hunk; next: number } => {
    const body: BLine[] = [];
    let j = h + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        const k: 'c' | 'o' | 'n' = l === '' || l[0] === ' ' ? 'c' : l[0] === '-' ? 'o' : 'n';
        body.push({ k, t: l === '' ? '' : l.slice(1), bs: false });
        j++;
      } else if (l.startsWith('\\')) {
        if (body.length > 0) body[body.length - 1]!.bs = true;
        j++;
      } else {
        break;
      }
    }
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.k === 'c' && last.t === '') body.pop();
      else break;
    }
    return { hunk: { a: hunkHead(lines[h]!)!, body }, next: j };
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        headOld = headerPath(l);
        headNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (cur !== null && inHeader && l.startsWith('rename from ')) {
      renOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename to ')) {
      renNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('new file mode')) {
      cur.newFile = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('deleted file mode')) {
      cur.delFile = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (hunkHead(l) === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = readBody(i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur === null && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection('', '');
      headOld = headerPath(l);
      headNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (!inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A ---/+++ pair after a section's hunks starts a new section.
      startSection('', '');
      headOld = headerPath(l);
      headNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    // Any other line outside a body is ignored (prose, code fences, header lines).
    i++;
  }
  finish();
  return sections;
}

/** Whether a '\' line follows the hunk's last context or '+' body line. */
function lastCtxPlusBs(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.k === 'c' || b.k === 'n') return b.bs;
  }
  return false;
}

/** Apply a section's hunks in order to a Doc, per section 6. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitBody(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const lines = spliceLines(cur.lines, at, O, N, 0);
      cur = { br: cur.br, lines, final: at === cur.lines.length ? !lastCtxPlusBs(h) : cur.final };
      d += N.length;
      continue;
    }
    const found = findTier(O, cur.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.pos[0]!;
    let best = Math.abs(at - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        at = p;
        best = dist;
      }
    }
    const endsAtEnd = at + O.length === cur.lines.length;
    const lines = spliceLines(cur.lines, at, O, N, found.tier);
    cur = { br: cur.br, lines, final: endsAtEnd ? !lastCtxPlusBs(h) : cur.final };
    d += N.length - O.length;
  }
  return cur;
}

/** One edit per unified section, in order. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const create = oldP === null || s.newFile;
    const del = !create && (newP === null || s.delFile);
    const move = !create && !del && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (create) {
        const p = newP!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const made: string[] = [];
        let lastPlusBs = false;
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.k === 'n') {
              made.push(b.t);
              lastPlusBs = b.bs;
            }
          }
        }
        tree.now.set(p, made.length === 0 ? '' : made.join('\n') + (lastPlusBs ? '' : '\n'));
        return;
      }
      if (del) {
        const p = oldP!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (move) {
        const from = oldP!;
        const to = newP!;
        const before = tree.get(from);
        if (before === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const done = applyHunks(parseDoc(before), s.hunks, strict, from);
        tree.now.set(from, null);
        tree.now.set(to, docText(done));
        tree.moves.push([from, to]);
        return;
      }
      const p = oldP!;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const done = applyHunks(parseDoc(before), s.hunks, strict, p);
      tree.now.set(p, docText(done));
    };
  });
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

/** One edit per SEARCH/REPLACE block, in order. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq === -1) {
        if (t === '=======') eq = j;
      } else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const old = lines.slice(searchLine + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const found = findTier(old, doc.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const { N } = splitBody(nw.map((t) => ({ k: 'n' as const, t, bs: false })));
      const done: Doc = { br: doc.br, lines: spliceLines(doc.lines, at, old, N, found.tier), final: doc.final };
      tree.now.set(p, docText(done));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BLine[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  updateLine: number;
}

/** One edit per V4A section, in order. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: i + 1 };
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m === '') {
          sec.addLines.push('');
          i++;
          continue;
        }
        if (m.startsWith('+')) {
          sec.addLines.push(m.slice(1));
          i++;
          continue;
        }
        if (blank(m)) {
          sec.addLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const sec: VSection = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: i + 1 };
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push(sec);
      continue;
    }
    // Update File section.
    const sec: VSection = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, addLines: [], chunks: [], updateLine: i + 1 };
    i++;
    let chunk: VChunk | null = null;
    const closeChunk = (dropTrailing: boolean): void => {
      if (chunk === null) return;
      if (dropTrailing) {
        while (chunk.body.length > 0) {
          const b = chunk.body[chunk.body.length - 1]!;
          if (b.k === 'c' && b.t === '') chunk.body.pop();
          else break;
        }
      }
      sec.chunks.push(chunk);
      chunk = null;
    };
    let sawMove = false;
    let sawBody = false;
    while (i < last) {
      const m = lines[i]!;
      if (isSectionStart(m)) break;
      if (m.startsWith('*** Move to: ')) {
        if (chunk !== null || sawBody || sawMove) throw new Exit2(`error: parse ${i + 1}`);
        sec.moveTo = m.slice('*** Move to: '.length).trim();
        sawMove = true;
        i++;
        continue;
      }
      if (m === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
        chunk.eof = true;
        closeChunk(false);
        i++;
        continue;
      }
      if (m.startsWith('@@')) {
        closeChunk(false);
        chunk = { anchor: m.slice(2).trim() === '' ? null : m.slice(2).trim(), eof: false, body: [] };
        sawBody = true;
        i++;
        continue;
      }
      if (m === '' || m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
        if (chunk === null) {
          if (m === '') {
            i++;
            continue;
          }
          chunk = { anchor: null, eof: false, body: [] };
          sawBody = true;
        }
        const k: 'c' | 'o' | 'n' = m === '' || m[0] === ' ' ? 'c' : m[0] === '-' ? 'o' : 'n';
        chunk.body.push({ k, t: m === '' ? '' : m.slice(1), bs: false });
        sawBody = true;
        i++;
        continue;
      }
      if (blank(m)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk(true);
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const p = s.path;
    const to = s.moveTo;
    if (s.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (to !== null && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      let doc = parseDoc(before);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
          if (at === null) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const { O, N } = splitBody(ch.body);
        if (O.length === 0) {
          const at = ch.eof ? doc.lines.length : cursor;
          const lines = spliceLines(doc.lines, at, O, N, 0);
          cursor = at + N.length;
          doc = { br: doc.br, lines, final: doc.final };
          continue;
        }
        const found = findTierFrom(O, doc.lines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const at = found.pos[0]!;
        const lines = spliceLines(doc.lines, at, O, N, found.tier);
        cursor = at + N.length;
        doc = { br: doc.br, lines, final: doc.final };
      }
      const text = docText(doc);
      if (to !== null) {
        tree.now.set(p, null);
        tree.now.set(to, text);
        tree.moves.push([p, to]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

/** First line at or after cursor equal to the anchor at the first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    for (let i = cursor; i < lines.length; i++) {
      if (normLine(lines[i]!, tier) === normLine(anchor, tier)) return i;
    }
  }
  return null;
}

/** First tier with an occurrence of O at or after `from` (an EOF chunk takes only one ending at the last line). */
function findTierFrom(O: string[], lines: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    const pos = findOccurrences(O, lines, tier).filter((p) => p >= from && (!eof || p + O.length === lines.length));
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/* ---- Section 1, 2 and 10: invocation, output and atomicity ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.line === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.line === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

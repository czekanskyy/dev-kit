// A small bash command line splitter for guard hooks.
// It is not a full shell parser: it aims to find every simple command a line would run,
// erring on the side of finding too many rather than too few.

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox']);
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'function']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const MAX_DEPTH = 8;

/** Lower-cased basename without a Windows executable extension. */
export function baseName(cmd) {
  const s = String(cmd ?? '').replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * Splits a command line into simple commands.
 * Returns [{argv, raw, envAssignments, heredoc, herestring, redirects, wrappers,
 *           fromXargs, fromFind, pipeline, pipeIndex, depth}]
 * Commands found inside $(...), backticks, <(...), bash -c, eval, find -exec and
 * here-documents fed to a shell are included as separate entries.
 */
export function parseCommandLine(input, opts = {}) {
  const depth = opts.depth ?? 0;
  const state = opts.state ?? { pipeline: 0 };
  const rawCmds = [];
  const ps = opts.dialect === 'powershell';
  lex(String(input ?? ''), 0, false, rawCmds, depth, state, ps);
  const out = [];
  for (const rc of rawCmds) {
    for (const c of finalize(rc, state)) out.push(c);
  }
  return out;
}

// ps: PowerShell (and cmd) quoting: backslash is literal, backtick escapes, '' inside single quotes.
function lex(src, pos, stopAtParen, out, depth, state, ps = false) {
  let i = pos;
  let cmd = newCmd(i);
  let word = null;
  let awaiting = null;
  let parenDepth = 0;
  const pending = [];
  let pipeline = state.pipeline++;
  let pipeIndex = 0;

  function newCmd(start) {
    return { words: [], redirects: [], heredoc: null, herestring: null, start, depth, ps };
  }
  function startWord() {
    if (!word) word = { value: '', start: i, quoted: false };
  }
  function endWord() {
    if (!word) return;
    const w = { value: word.value, raw: src.slice(word.start, i), quoted: word.quoted };
    if (awaiting) {
      cmd.redirects.push({ op: awaiting, target: w.value });
      if (awaiting === '<<<') cmd.herestring = cmd.herestring == null ? w.value : `${cmd.herestring}\n${w.value}`;
      awaiting = null;
    } else {
      cmd.words.push(w);
    }
    word = null;
  }
  function endCmd(sep) {
    endWord();
    if (cmd.words.length || cmd.redirects.length) {
      cmd.raw = src.slice(cmd.start, i).trim();
      cmd.pipeline = pipeline;
      cmd.pipeIndex = pipeIndex;
      cmd.sep = sep;
      out.push(cmd);
      if (sep === '|' || sep === '|&') pipeIndex++;
      else {
        pipeline = state.pipeline++;
        pipeIndex = 0;
      }
    } else if (sep !== '|' && sep !== '|&') {
      pipeline = state.pipeline++;
      pipeIndex = 0;
    }
    cmd = newCmd(i);
  }
  function consumeHeredocs() {
    while (pending.length) {
      const h = pending.shift();
      const lines = [];
      while (i < src.length) {
        let nl = src.indexOf('\n', i);
        if (nl < 0) nl = src.length;
        let line = src.slice(i, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        i = nl + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) break;
        lines.push(line);
      }
      if (i > src.length) i = src.length;
      const body = lines.join('\n');
      h.cmd.heredoc = h.cmd.heredoc == null ? body : `${h.cmd.heredoc}\n${body}`;
    }
  }
  function substitution(startIdx, innerStart) {
    // $( ... ) or <( ... ): parse the inside recursively, return the index after ')'.
    const end = lex(src, innerStart, true, out, depth + 1, state, ps);
    word.value += src.slice(startIdx, Math.min(end + 1, src.length));
    return end + 1;
  }
  function backtick() {
    let j = i + 1;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    const inner = src.slice(i + 1, Math.min(j, src.length));
    lex(inner, 0, false, out, depth + 1, state);
    word.value += src.slice(i, Math.min(j + 1, src.length));
    return j + 1;
  }
  function readDelimiter() {
    while (src[i] === ' ' || src[i] === '\t') i++;
    let d = '';
    while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
      const c = src[i];
      if (c === "'" || c === '"') {
        const j = src.indexOf(c, i + 1);
        const e = j < 0 ? src.length : j;
        d += src.slice(i + 1, e);
        i = e + 1;
        continue;
      }
      if (c === '\\') {
        d += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      d += c;
      i++;
    }
    return d;
  }

  while (i < src.length) {
    const c = src[i];
    if (ps) {
      if (c === '`') {
        if (src[i + 1] === '\n') {
          i += 2;
          continue;
        }
        if (src[i + 1] === '\r' && src[i + 2] === '\n') {
          i += 3;
          continue;
        }
        startWord();
        word.value += src[i + 1] ?? '';
        word.quoted = true;
        i += 2;
        continue;
      }
      if (c === '\\') {
        startWord();
        word.value += c;
        i++;
        continue;
      }
      if (c === "'") {
        startWord();
        word.quoted = true;
        let j = i + 1;
        for (;;) {
          const k = src.indexOf("'", j);
          if (k < 0) {
            word.value += src.slice(j);
            i = src.length;
            break;
          }
          word.value += src.slice(j, k);
          if (src[k + 1] === "'") {
            word.value += "'";
            j = k + 2;
            continue;
          }
          i = k + 1;
          break;
        }
        continue;
      }
      if (c === '"') {
        startWord();
        word.quoted = true;
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i];
          if (d === '`' && i + 1 < src.length) {
            word.value += src[i + 1];
            i += 2;
            continue;
          }
          if (d === '$' && src[i + 1] === '(') {
            i = substitution(i, i + 2);
            continue;
          }
          word.value += d;
          i++;
        }
        i++;
        continue;
      }
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (src[i + 1] === '\r' && src[i + 2] === '\n') {
        i += 3;
        continue;
      }
      startWord();
      word.value += src[i + 1] ?? '';
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      word.quoted = true;
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word.value += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') word.value += src[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' && src[i + 1] === '(') {
          i = substitution(i, i + 2);
          continue;
        }
        if (d === '`') {
          i = backtick();
          continue;
        }
        word.value += d;
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      startWord();
      if (src[i + 1] === "'") {
        word.quoted = true;
        let j = i + 2;
        while (j < src.length && src[j] !== "'") {
          if (src[j] === '\\' && j + 1 < src.length) {
            const e = src[j + 1];
            word.value += { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }[e] ?? `\\${e}`;
            j += 2;
            continue;
          }
          word.value += src[j];
          j++;
        }
        i = j + 1;
        continue;
      }
      if (src[i + 1] === '(') {
        i = substitution(i, i + 2);
        continue;
      }
      if (src[i + 1] === '{') {
        let j = i + 2;
        let d = 1;
        while (j < src.length && d > 0) {
          if (src[j] === '{') d++;
          else if (src[j] === '}') d--;
          j++;
        }
        word.value += src.slice(i, j);
        i = j;
        continue;
      }
      word.value += c;
      i++;
      continue;
    }
    if (c === '`') {
      startWord();
      i = backtick();
      continue;
    }
    if (word === null && c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (word === null && (c === '<' || c === '>') && src[i + 1] === '(') {
      startWord();
      i = substitution(i, i + 2);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endCmd('\n');
      i++;
      consumeHeredocs();
      cmd.start = i;
      continue;
    }
    if (c === ';') {
      endCmd(';');
      i += src[i + 1] === ';' ? 2 : 1;
      cmd.start = i;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') {
        endCmd('&&');
        i += 2;
        cmd.start = i;
        continue;
      }
      if (src[i + 1] === '>') {
        endWord();
        const op = src[i + 2] === '>' ? '&>>' : '&>';
        i += op.length;
        awaiting = op;
        continue;
      }
      endCmd('&');
      i++;
      cmd.start = i;
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        endCmd('||');
        i += 2;
      } else if (src[i + 1] === '&') {
        endCmd('|&');
        i += 2;
      } else {
        endCmd('|');
        i++;
      }
      cmd.start = i;
      continue;
    }
    if (c === '(') {
      if (word === null) {
        endCmd('(');
        parenDepth++;
        i++;
        cmd.start = i;
        continue;
      }
      word.value += c;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) {
        endCmd(')');
        parenDepth--;
        i++;
        cmd.start = i;
        continue;
      }
      if (stopAtParen) {
        endCmd(')');
        return i;
      }
      startWord();
      word.value += c;
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      const fdPrefix = word && !word.quoted && /^\d+$/.test(word.value) && src.slice(word.start, i) === word.value;
      if (fdPrefix) word = null;
      else endWord();
      let op;
      const rest = src.slice(i, i + 3);
      if (rest.startsWith('<<<')) op = '<<<';
      else if (rest.startsWith('<<-')) op = '<<-';
      else if (rest.startsWith('<<')) op = '<<';
      else if (rest.startsWith('<>')) op = '<>';
      else if (rest.startsWith('<&')) op = '<&';
      else if (rest.startsWith('>&')) op = '>&';
      else if (rest.startsWith('>>')) op = '>>';
      else if (rest.startsWith('>|')) op = '>|';
      else op = c;
      i += op.length;
      if (op === '<<' || op === '<<-') {
        const delim = readDelimiter();
        pending.push({ delim, strip: op === '<<-', cmd });
        cmd.redirects.push({ op, target: delim });
        continue;
      }
      awaiting = op;
      continue;
    }
    startWord();
    word.value += c;
    i++;
  }
  endCmd('end');
  return src.length;
}

// ---------------------------------------------------------------------------

function takeAssignments(words, env) {
  while (words.length && !words[0].raw.startsWith('"') && ASSIGN_RE.test(words[0].raw)) {
    const w = words.shift();
    const eq = w.value.indexOf('=');
    env[w.value.slice(0, eq).replace(/\+$/, '')] = w.value.slice(eq + 1);
  }
}

// Returns the number of leading words that make up the wrapper, or 0 when words[0] is not a wrapper.
function wrapperLength(words, env) {
  const name = baseName(words[0].value);
  const v = (k) => words[k]?.value ?? '';
  let k = 1;
  switch (name) {
    case 'sudo':
    case 'doas':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (o === '--') break;
        if (/^-[ugpCUrtDhRT]$/.test(o)) k++;
      }
      break;
    case 'env':
      while (k < words.length) {
        const o = v(k);
        if (o === '--') {
          k++;
          break;
        }
        if (['-u', '-C', '-S', '--unset', '--chdir', '--split-string'].includes(o)) {
          k += 2;
          continue;
        }
        if (o.startsWith('-')) {
          k++;
          continue;
        }
        if (ASSIGN_RE.test(o)) {
          const eq = o.indexOf('=');
          env[o.slice(0, eq).replace(/\+$/, '')] = o.slice(eq + 1);
          k++;
          continue;
        }
        break;
      }
      break;
    case 'timeout':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (o === '-s' || o === '-k' || o === '--signal' || o === '--kill-after') k++;
      }
      k++; // duration
      break;
    case 'nice':
      if (v(k) === '-n' || v(k) === '--adjustment') k += 2;
      else if (/^-(-adjustment=)?-?\d+$/.test(v(k)) || /^-n-?\d+$/.test(v(k))) k++;
      break;
    case 'nohup':
      if (v(k) === '--') k++;
      break;
    case 'time':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (o === '-f' || o === '-o' || o === '--format' || o === '--output') k++;
      }
      break;
    case 'command':
      if (words.slice(1).some((w) => /^-[a-zA-Z]*[vV]/.test(w.value))) return 0;
      while (k < words.length && v(k).startsWith('-')) k++;
      break;
    case 'exec':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (o === '-a') k++;
      }
      break;
    case 'stdbuf':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (/^-[ioe]$/.test(o)) k++;
      }
      break;
    case 'xargs':
      while (k < words.length && v(k).startsWith('-')) {
        const o = v(k);
        k++;
        if (o === '--') break;
        if (/^-[InPLsdEea]$/.test(o)) k++;
        else if (/^--(replace|max-args|max-procs|max-lines|max-chars|delimiter|eof|arg-file)$/.test(o)) k++;
      }
      break;
    default:
      return 0;
  }
  if (k >= words.length) return 0; // nothing left to run: the wrapper is the command
  return k;
}

function finalize(rc, state) {
  const words = rc.words.slice();
  const envAssignments = {};
  const wrappers = [];
  for (let guard = 0; guard < 20 && words.length; guard++) {
    const before = words.length;
    takeAssignments(words, envAssignments);
    while (words.length && !words[0].quoted && KEYWORDS.has(words[0].value)) words.shift();
    if (words.length) {
      const n = wrapperLength(words, envAssignments);
      if (n > 0) {
        wrappers.push(baseName(words[0].value));
        words.splice(0, n);
      }
    }
    if (words.length === before) break;
  }
  const argv = words.map((w) => w.value);
  const cmd = {
    argv,
    raw: rc.raw ?? '',
    envAssignments,
    heredoc: rc.heredoc,
    herestring: rc.herestring,
    redirects: rc.redirects,
    wrappers,
    fromXargs: wrappers.includes('xargs'),
    fromFind: false,
    pipeline: rc.pipeline,
    pipeIndex: rc.pipeIndex,
    depth: rc.depth,
    dialect: rc.ps ? 'powershell' : 'bash',
  };
  const result = [cmd];
  const depth = rc.depth + 1;
  if (depth > MAX_DEPTH || argv.length === 0) return result;
  const sub = (text, dialect = 'bash') => parseCommandLine(text, { depth, state, dialect });
  const b = baseName(argv[0]);

  if (b === 'pwsh' || b === 'powershell') {
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k].toLowerCase();
      if (/^[-/](c|co|com|comm|comma|comman|command)$/.test(a)) {
        result.push(...sub(argv.slice(k + 1).join(' '), 'powershell'));
        break;
      }
      if (/^[-/](e|ec|en|enc|encodedcommand|encoded)$/.test(a) || a.startsWith('-encodedc')) {
        try {
          result.push(...sub(Buffer.from(argv[k + 1] ?? '', 'base64').toString('utf16le'), 'powershell'));
        } catch {
          // undecodable: nothing more to inspect
        }
        break;
      }
      if (/^[-/](file|f)$/.test(a)) break;
    }
  } else if (b === 'cmd') {
    const k = argv.findIndex((a, idx) => idx > 0 && /^\/[ck]$/i.test(a));
    if (k > 0) result.push(...sub(argv.slice(k + 1).join(' '), 'powershell'));
  } else if (SHELLS.has(b)) {
    let script = null;
    let hasPositional = false;
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (a === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        script = argv[k + 1] ?? '';
        break;
      }
      if (a === '-o' || a === '-O' || a === '+O' || a === '+o') {
        k++;
        continue;
      }
      if (a === '--') continue;
      if (!a.startsWith('-') && !a.startsWith('+')) {
        hasPositional = true;
        break;
      }
    }
    if (script !== null) result.push(...sub(script));
    else if (!hasPositional) {
      if (cmd.heredoc) result.push(...sub(cmd.heredoc));
      if (cmd.herestring) result.push(...sub(cmd.herestring));
    }
  } else if (b === 'eval') {
    result.push(...sub(argv.slice(1).join(' ')));
  } else if (b === 'find') {
    for (let k = 1; k < argv.length; k++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(argv[k])) {
        const part = [];
        let j = k + 1;
        while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') part.push(argv[j++]);
        if (part.length) {
          const inner = finalize(
            { words: part.map((p) => ({ value: p, raw: p, quoted: true })), redirects: [], raw: part.join(' '), depth: rc.depth + 1, pipeline: rc.pipeline, pipeIndex: rc.pipeIndex },
            state,
          );
          for (const c of inner) c.fromFind = true;
          result.push(...inner);
        }
        k = j;
      }
    }
  }
  return result;
}

/**
 * Generic option parser. spec.short: short options taking a value; spec.long: long options taking a value.
 * Returns { flags:Set, values:{name:[...]}, pos:[...] }.
 */
export function parseOpts(args, spec = {}) {
  const vs = spec.short ?? '';
  const vl = new Set(spec.long ?? []);
  const flags = new Set();
  const values = {};
  const pos = [];
  const add = (n, v) => {
    flags.add(n);
    if (v !== undefined) (values[n] ??= []).push(v);
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 0) add(a.slice(2, eq), a.slice(eq + 1));
      else {
        const n = a.slice(2);
        if (vl.has(n)) {
          add(n, args[k + 1]);
          k++;
        } else add(n);
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (vs.includes(ch)) {
          const rest = a.slice(j + 1);
          if (rest) add(ch, rest);
          else {
            add(ch, args[k + 1]);
            k++;
          }
          break;
        }
        add(ch);
      }
      continue;
    }
    pos.push(a);
  }
  return { flags, values, pos };
}

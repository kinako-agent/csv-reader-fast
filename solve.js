// A fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// run(input) returns exactly what csv-reader's readCsv returns for {text, header}: {columns, rows, errors},
// following the same broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote;
//     each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends); a quote that never closes is a
//     literal character and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR
//     inside quotes counted), row its record's index in rows (null for the header), in the order met.
//
// Where the reference walks one character at a time and builds each field a character at a time, this reader
// jumps between the few characters that matter (comma, LF, CR, quote) with a single native regexp search
// and copies each run of ordinary characters with a single slice.

const RE_FIELD = /[,\n\r]/g;
const RE_QUOTED = /["\n\r]/g;

const END_COMMA = 0;
const END_BREAK = 1;
const END_EOF = 2;

// Parser state for the call in flight (run is never re-entered).
let T = '';
let N = 0;
let P = 0; // next character to read
let L = 1; // line that character is on
let recLine = 1; // line the current record starts on
let recRow = null; // index in rows the current record takes (null: the header)
let errors = null;

// The field just read: its value, how it ended, and how many characters the last read kept (for quote_junk).
let fVal = '';
let fEnd = END_EOF;
let fAdded = 0;

function pushErr(code) {
  errors.push({ code, line: recLine, row: recRow });
}

// Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is
// dropped (stray_cr). Sets fVal, fEnd and fAdded (the characters kept by this read).
function readUnquoted(init) {
  let segStart = P;
  let parts = null;
  let added = 0;
  for (;;) {
    RE_FIELD.lastIndex = P;
    const m = RE_FIELD.exec(T);
    const idx = m === null ? -1 : m.index;
    const cc = idx === -1 ? 0 : T.charCodeAt(idx);
    const kind = cc === 44 ? 0 : cc === 10 ? 1 : 2;
    if (idx === -1) {
      added += N - segStart;
      fVal = parts === null ? init + T.slice(segStart, N) : init + parts.join('') + T.slice(segStart, N);
      P = N;
      fEnd = END_EOF;
      fAdded = added;
      return;
    }
    if (kind === 2 && T.charCodeAt(idx + 1) !== 10) {
      // A CR not followed by LF is dropped (stray_cr); the run before it is kept.
      if (parts === null) parts = [];
      parts.push(T.slice(segStart, idx));
      added += idx - segStart;
      pushErr('stray_cr');
      P = idx + 1;
      segStart = P;
      continue;
    }
    added += idx - segStart;
    fVal = parts === null ? init + T.slice(segStart, idx) : init + parts.join('') + T.slice(segStart, idx);
    fAdded = added;
    if (kind === 0) {
      P = idx + 1;
      fEnd = END_COMMA;
    } else if (kind === 1) {
      P = idx + 1;
      L += 1;
      fEnd = END_BREAK;
    } else {
      P = idx + 2;
      L += 1;
      fEnd = END_BREAK;
    }
    return;
  }
}

// Reads a quoted field whose opening quote is at P. Sets fVal and fEnd.
function readQuoted() {
  const open = P;
  const openLine = L;
  let p = open + 1;
  let segStart = p;
  let parts = null;
  let closed = false;
  let closeIdx = -1;
  for (;;) {
    RE_QUOTED.lastIndex = p;
    const m = RE_QUOTED.exec(T);
    const idx = m === null ? -1 : m.index;
    const cc = idx === -1 ? 0 : T.charCodeAt(idx);
    const kind = cc === 34 ? 0 : cc === 10 ? 1 : 2;
    if (idx === -1) break;
    if (kind === 0) {
      if (T.charCodeAt(idx + 1) === 34) {
        // A doubled quote is one quote in the value.
        if (parts === null) parts = [];
        parts.push(T.slice(segStart, idx), '"');
        p = idx + 2;
        segStart = p;
        continue;
      }
      closed = true;
      closeIdx = idx;
      break;
    }
    if (kind === 1) {
      // An LF inside quotes stays in the value as it stands; only the line count moves.
      L += 1;
      p = idx + 1;
      continue;
    }
    // A CRLF or a lone CR inside quotes is read as one LF.
    if (parts === null) parts = [];
    parts.push(T.slice(segStart, idx), '\n');
    L += 1;
    p = T.charCodeAt(idx + 1) === 10 ? idx + 2 : idx + 1;
    segStart = p;
  }
  if (!closed) {
    // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
    P = open + 1;
    L = openLine;
    pushErr('unterminated_quote');
    readUnquoted('"');
    return;
  }
  const value = parts === null ? T.slice(segStart, closeIdx) : parts.join('') + T.slice(segStart, closeIdx);
  P = closeIdx + 1;
  if (P >= N) {
    fVal = value;
    fEnd = END_EOF;
    return;
  }
  const c = T.charCodeAt(P);
  if (c === 44) {
    P += 1;
    fVal = value;
    fEnd = END_COMMA;
    return;
  }
  if (c === 10) {
    P += 1;
    L += 1;
    fVal = value;
    fEnd = END_BREAK;
    return;
  }
  if (c === 13 && T.charCodeAt(P + 1) === 10) {
    P += 2;
    L += 1;
    fVal = value;
    fEnd = END_BREAK;
    return;
  }
  // What follows the closing quote is appended as it stands, up to the next comma or line break.
  readUnquoted(value);
  if (fAdded > 0) pushErr('quote_junk');
}

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  T = String(input.text);
  const header = input.header === true;
  N = T.length;
  errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  P = T.charCodeAt(0) === 0xFEFF ? 1 : 0;
  L = 1;

  for (;;) {
    // Lines with no characters are no records.
    while (P < N) {
      const c = T.charCodeAt(P);
      if (c === 10) {
        P += 1;
        L += 1;
      } else if (c === 13 && T.charCodeAt(P + 1) === 10) {
        P += 2;
        L += 1;
      } else {
        break;
      }
    }
    if (P >= N) break;

    recLine = L;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    for (;;) {
      if (T.charCodeAt(P) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted('');
      }
      fields.push(fVal);
      if (fEnd !== END_COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

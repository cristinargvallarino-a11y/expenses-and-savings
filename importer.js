// Lectura de extractos bancarios (CSV o Excel) — funciones puras, sin DOM.
//
// 1. readTable(): texto o filas de Excel → tabla (array de filas).
// 2. detectMapping(): busca la fila de cabecera y qué columna es cada cosa
//    (fecha, concepto, importe o cargo/abono). Si no hay cabecera, lo deduce
//    por el contenido. El saldo se ignora.
// 3. extractRows(): aplica ese mapeo y devuelve movimientos limpios.

const HEADER_PATTERNS = {
  date: /^(f\.?\s*)?(fecha|date|dia|día)\b|fecha.*(operaci|movim|transac|contable)|^f\.?\s*(oper|valor|contable)|started date|completed date|booking date/i,
  dateValue: /valor|value/i,
  description: /concepto|descripci|detalle|movimiento|description|comercio|beneficiario|payee|merchant|referencia|observaciones|asunto|operaci[oó]n$/i,
  amount: /^(importe|amount|cantidad|euros|eur|monto|valor)\b|importe|amount/i,
  debit: /cargo|debe|d[eé]bito|salida|gasto|withdrawal|debit|money out|pagos?$/i,
  credit: /abono|haber|cr[eé]dito|entrada|ingreso|deposit|credit|money in|cobros?$/i,
  balance: /saldo|balance|disponible/i,
  strongIgnore: /^(tipo|type|divisa|currency|moneda|estado|state|product|producto|fee|comisi|categor|subcategor|hora|time)/i,
  ignore: /divisa|currency|moneda|categor|tipo|type|estado|state|product|producto|fee|comisi|tarjeta|card|oficina|n[uú]m|c[oó]digo|code|hora|time/i,
};

function normText(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

// ---------- Lectura ----------

/** Decodifica un archivo de texto en UTF-8 o, si no lo es, en Windows-1252 (habitual en bancos). */
function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch (e) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function isSpreadsheet(buffer) {
  const b = new Uint8Array(buffer.slice(0, 8));
  const zip = b[0] === 0x50 && b[1] === 0x4b; // .xlsx
  const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // .xls antiguo
  return zip || ole;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === delim && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Elige el separador que da un número de columnas más estable en todo el archivo. */
function detectDelimiter(lines) {
  let best = ';';
  let bestScore = -1;
  for (const d of [';', ',', '\t', '|']) {
    const counts = lines.slice(0, 60).map((l) => splitCsvLine(l, d).length);
    const freq = {};
    for (const c of counts) if (c > 1) freq[c] = (freq[c] || 0) + 1;
    const [cols, times] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] || [1, 0];
    const score = times * Math.min(Number(cols), 8);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function csvToRows(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim());
  const delim = detectDelimiter(lines);
  return lines.map((l) => splitCsvLine(l, delim).map((c) => c.trim()));
}

// ---------- Interpretación de valores ----------

const MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Convierte un valor en fecha 'YYYY-MM-DD'. `order` es 'dmy' (por defecto, España)
 * o 'mdy' (formato americano). Devuelve null si no es una fecha.
 */
function parseDate(v, order = 'dmy') {
  if (v instanceof Date && !Number.isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // número de serie de Excel
      const d = new Date(Math.round((v - 25569) * 86400000));
      return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const s = normText(v).toLowerCase();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(\s|t|$)/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return order === 'mdy' ? valid(y, +m[1], +m[2]) : valid(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[\s-]+([a-zé]{3})[a-zé.]*[\s-]+(?:de\s+)?(\d{2,4})/);
  if (m && MONTHS[m[2]]) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2]], +m[1]);
  return null;

  function valid(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
}

/** Convierte "1.234,56 €", "-12,50", "(8.00)", "12,50-" o 1234.5 en número. null si no es un importe. */
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = normText(v).replace(/[  \s]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/(eur|euros|usd|gbp|€|\$|£)/gi, '');
  if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); } else if (/^\+/.test(s)) s = s.slice(1);
  if (/[-−–]$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/'/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // El último separador es el decimal.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commas = (s.match(/,/g) || []).length;
    s = commas > 1 || (decimals === 3 && !/^0,/.test(s)) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1 || (decimals === 3 && !/^0\./.test(s))) s = s.replace(/\./g, ''); // 1.234 → 1234
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// ---------- Detección de columnas ----------

function headerRole(text) {
  const t = normText(text).toLowerCase();
  if (!t || t.length > 40) return null;
  if (HEADER_PATTERNS.balance.test(t)) return 'balance';
  if (HEADER_PATTERNS.date.test(t)) return HEADER_PATTERNS.dateValue.test(t) ? 'dateValue' : 'date';
  if (HEADER_PATTERNS.debit.test(t)) return 'debit';
  if (HEADER_PATTERNS.credit.test(t)) return 'credit';
  if (HEADER_PATTERNS.amount.test(t)) return 'amount';
  if (HEADER_PATTERNS.strongIgnore.test(t)) return 'ignore';
  if (HEADER_PATTERNS.description.test(t)) return 'description';
  if (HEADER_PATTERNS.ignore.test(t)) return 'ignore';
  return null;
}

function columnStats(rows, start, ncols) {
  const stats = [];
  for (let c = 0; c < ncols; c++) {
    let dates = 0, nums = 0, neg = 0, texts = 0, filled = 0, textLen = 0;
    const distinct = new Set();
    const values = [];
    for (let r = start; r < rows.length; r++) {
      const v = rows[r][c];
      if (v === undefined || v === null || normText(v) === '') { values.push(null); continue; }
      filled++;
      if (parseDate(v)) dates++;
      const n = parseAmount(v);
      values.push(n);
      if (n !== null && !parseDate(v)) { nums++; if (n < 0) neg++; }
      if (typeof v === 'string' && /[a-zà-ÿ]{2,}/i.test(v)) { texts++; textLen += v.length; distinct.add(v); }
    }
    stats.push({ dates, nums, neg, texts, filled, avgLen: texts ? textLen / texts : 0, distinct: distinct.size, values });
  }
  return stats;
}

/** ¿La columna b es el saldo acumulado de la columna a? */
function looksLikeBalance(amounts, balances) {
  let hits = 0, tries = 0;
  for (let i = 1; i < amounts.length; i++) {
    const a = amounts[i], b0 = balances[i - 1], b1 = balances[i];
    if (a == null || b0 == null || b1 == null) continue;
    tries++;
    if (Math.abs(b1 - b0 - a) < 0.011 || Math.abs(b0 - b1 - a) < 0.011) hits++;
  }
  return tries >= 2 && hits / tries > 0.6;
}

/**
 * Devuelve { headerRow, headers, date, description: [..], amount, debit, credit, dateOrder }.
 * Los valores son índices de columna (o -1).
 */
function detectMapping(rows) {
  const ncols = Math.max(0, ...rows.slice(0, 200).map((r) => r.length));
  // 1) Cabecera: la fila (de las 40 primeras) con más nombres de columna reconocidos.
  let headerRow = -1, bestScore = 0, roles = [];
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const rr = rows[r].map(headerRole);
    const useful = rr.filter((x) => x && x !== 'ignore' && x !== 'dateValue');
    const hasDate = rr.includes('date') || rr.includes('dateValue');
    const hasMoney = rr.some((x) => x === 'amount' || x === 'debit' || x === 'credit');
    const score = useful.length + (hasDate ? 2 : 0) + (hasMoney ? 2 : 0);
    if (hasDate && hasMoney && score > bestScore) { bestScore = score; headerRow = r; roles = rr; }
  }
  const start = headerRow + 1;
  const stats = columnStats(rows, start, ncols);
  const m = { headerRow, headers: headerRow >= 0 ? rows[headerRow].map(normText) : [], date: -1, description: [], amount: -1, debit: -1, credit: -1, dateOrder: 'dmy' };

  if (headerRow >= 0) {
    m.date = roles.indexOf('date');
    if (m.date < 0) m.date = roles.indexOf('dateValue');
    m.amount = roles.indexOf('amount');
    m.debit = roles.indexOf('debit');
    m.credit = roles.indexOf('credit');
    if (m.debit >= 0 && m.credit < 0) { m.amount = m.amount >= 0 ? m.amount : -1; }
    if (m.amount >= 0 && m.debit >= 0 && m.credit >= 0) m.amount = -1; // cargo + abono manda
    m.description = roles.map((r, i) => (r === 'description' ? i : -1)).filter((i) => i >= 0);
  }

  // 2) Lo que falte se deduce por el contenido.
  const used = () => new Set([m.date, m.amount, m.debit, m.credit, ...m.description]);
  if (m.date < 0) {
    const cand = stats.map((s, i) => ({ i, s })).filter(({ s }) => s.filled && s.dates / s.filled > 0.7);
    if (cand.length) m.date = cand.sort((a, b) => b.s.dates - a.s.dates)[0].i;
  }
  if (m.amount < 0 && m.debit < 0 && m.credit < 0) {
    const numeric = stats.map((s, i) => ({ i, s })).filter(({ i, s }) => !used().has(i) && s.filled && s.nums / s.filled > 0.7 && roles[i] !== 'balance');
    // Descarta columnas que son el saldo de otra.
    const notBalance = numeric.filter(({ i }) => !numeric.some(({ i: j }) => j !== i && looksLikeBalance(stats[j].values, stats[i].values)));
    const pick = (notBalance.length ? notBalance : numeric).sort((a, b) => (b.s.neg > 0) - (a.s.neg > 0) || a.i - b.i)[0];
    if (pick) m.amount = pick.i;
  }
  if (!m.description.length) {
    const cand = stats.map((s, i) => ({ i, s })).filter(({ i, s }) => !used().has(i) && roles[i] !== 'ignore' && roles[i] !== 'balance' && s.texts && s.texts / s.filled > 0.6);
    const best = cand.sort((a, b) => (b.s.distinct * b.s.avgLen) - (a.s.distinct * a.s.avgLen))[0];
    if (best) m.description = [best.i];
  }

  // 3) Orden de la fecha: en España es día/mes; si el segundo número pasa de 12, es mes/día.
  if (m.date >= 0) {
    for (let r = start; r < rows.length; r++) {
      const mm = normText(rows[r][m.date]).match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (mm && +mm[2] > 12) { m.dateOrder = 'mdy'; break; }
    }
  }
  return m;
}

/**
 * Aplica el mapeo. Devuelve { items: [{date, description, amount}], skipped }.
 * amount < 0 = gasto. `invert` da la vuelta al signo (p. ej. tarjetas de crédito
 * que ponen los gastos en positivo).
 */
function extractRows(rows, m, { invert = false } = {}) {
  const items = [];
  let skipped = 0;
  for (let r = m.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const date = m.date >= 0 ? parseDate(row[m.date], m.dateOrder) : null;
    let amount = null;
    if (m.debit >= 0 || m.credit >= 0) {
      const d = m.debit >= 0 ? parseAmount(row[m.debit]) : null;
      const c = m.credit >= 0 ? parseAmount(row[m.credit]) : null;
      if (d || c) amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    } else if (m.amount >= 0) {
      amount = parseAmount(row[m.amount]);
    }
    const description = m.description.map((i) => normText(row[i])).filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i).join(' · ');
    if (!date || amount === null || amount === 0) { if (row.some((c) => normText(c))) skipped++; continue; }
    if (/^(saldo|total|suma)/i.test(description)) { skipped++; continue; }
    items.push({ date, description: description || 'Movimiento', amount: invert ? -amount : amount });
  }
  return { items, skipped };
}

if (typeof module !== 'undefined') {
  module.exports = { decodeText, isSpreadsheet, csvToRows, detectDelimiter, parseDate, parseAmount, detectMapping, extractRows, headerRole };
}

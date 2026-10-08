// Lectura de extractos bancarios (CSV o Excel) — funciones puras, sin DOM.
//
// 1. csvToRows(): texto → tabla (array de filas). Los Excel se leen en app.js.
// 2. detectSections(): busca las tablas de movimientos (una o varias) y qué
//    columna es cada cosa (fecha, concepto, importe o cargo/abono). Si no hay
//    cabecera, lo deduce por el contenido. El saldo se ignora.
// 3. extractAll(): aplica esos mapeos y devuelve movimientos limpios, marcando
//    los traspasos entre cuentas propias.

const HEADER_PATTERNS = {
  date: /^(f\.?\s*)?(fecha|date|dia|día)\b|fecha.*(operaci|movim|transac|contable)|^f\.?\s*(oper|valor|contable)|started date|completed date|booking date/i,
  dateValue: /valor|value/i,
  description: /concepto|descripci|detalle|movimiento|description|comercio|beneficiario|payee|merchant|referencia|observaciones|asunto|operaci[oó]n$/i,
  inOut: /entradas?\s*\/\s*salidas?|money in\s*\/\s*out|paid in\s*\/\s*out|ingresos?\s*\/\s*gastos?/i,
  returns: /inter[eé]s|interest|dividend|rendimiento|rentabilidad|returns?\b/i,
  amount: /^(importe|amount|cantidad|euros|eur|monto|valor)\b|importe|amount/i,
  debit: /cargo|debe|d[eé]bito|salida|gasto|withdrawal|debit|money out|pagos?$/i,
  credit: /abono|haber|cr[eé]dito|entrada|ingreso|deposit|credit|money in|cobros?$/i,
  balance: /saldo|balance|disponible/i,
  category: /^(categor[ií]a|category)$/i,
  strongIgnore: /^(tipo|type|divisa|currency|moneda|estado|state|product|producto|fee|comisi|categor|subcategor|hora|time|impuesto|tax|other tax|otros impuestos|tae|tin|apr|isin|pa[ií]s|country|edad|units|precio|ganancias)/i,
  ignore: /divisa|currency|moneda|categor|tipo|type|estado|state|product|producto|fee|comisi|tarjeta|card|oficina|n[uú]m|c[oó]digo|code|hora|time/i,
};

// Movimientos entre tus propias cuentas: no son gasto ni ingreso real.
const TRANSFER_CATEGORY = /^(cambio|exchange|traspaso|transfer between)/i;
const TRANSFER_DESCRIPTION = /^(recarga|top[- ]?up|conversi[oó]n a|exchanged? to|(a|desde|to|from) (eur|gbp|usd|chf)\b)|cartera flexible|cuenta remunerada|cuenta de inversi[oó]n|investment account|\bhucha\b|\bpocket\b|\bvault\b|traspaso (entre|a) (mis|tus) cuentas/i;
// Secciones de inversión (compras/ventas de acciones o fondos): es dinero que ya
// estaba invertido, no gasto ni ingreso. Los dividendos sí cuentan, aparte.
const INVESTMENT_SECTION = /corretaje|brokerage|unidades que se han vendido|units sold|robo.?advisor|investment|inversi[oó]n/i;

function plain(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** ¿El concepto nombra a la persona titular? (p. ej. "To Ana García" con el nombre "Ana Garcia"). */
function mentionsOwnName(description, ownNames) {
  const d = plain(description);
  return ownNames.some((name) => {
    const words = plain(name).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    return words.length >= 2 && words.every((w) => new RegExp(`\\b${w}\\b`).test(d));
  });
}

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
  if (!t || t.length > 50) return null;
  if (HEADER_PATTERNS.balance.test(t)) return 'balance';
  if (HEADER_PATTERNS.date.test(t)) return HEADER_PATTERNS.dateValue.test(t) ? 'dateValue' : 'date';
  if (HEADER_PATTERNS.inOut.test(t)) return 'amount';
  if (HEADER_PATTERNS.category.test(t)) return 'category';
  if (HEADER_PATTERNS.strongIgnore.test(t)) return 'ignore';
  if (HEADER_PATTERNS.returns.test(t)) return 'returns';
  if (HEADER_PATTERNS.debit.test(t)) return 'debit';
  if (HEADER_PATTERNS.credit.test(t)) return 'credit';
  if (HEADER_PATTERNS.amount.test(t)) return 'amount';
  if (HEADER_PATTERNS.description.test(t)) return 'description';
  if (HEADER_PATTERNS.ignore.test(t)) return 'ignore';
  return null;
}

const MONEY_ROLES = ['amount', 'debit', 'credit', 'returns'];

function columnStats(rows, start, end, ncols) {
  const stats = [];
  for (let c = 0; c < ncols; c++) {
    let dates = 0, nums = 0, neg = 0, texts = 0, filled = 0, textLen = 0, euro = 0;
    const distinct = new Set();
    const values = [];
    for (let r = start; r < end; r++) {
      const v = rows[r][c];
      if (v === undefined || v === null || normText(v) === '') { values.push(null); continue; }
      filled++;
      if (/€|eur/i.test(String(v))) euro++;
      if (parseDate(v)) dates++;
      const n = parseAmount(v);
      values.push(n);
      if (n !== null && !parseDate(v)) { nums++; if (n < 0) neg++; }
      if (typeof v === 'string' && /[a-zà-ÿ]{2,}/i.test(v)) { texts++; textLen += v.length; distinct.add(v); }
    }
    stats.push({ dates, nums, neg, texts, filled, euro, avgLen: texts ? textLen / texts : 0, distinct: distinct.size, values });
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

/** Filas que parecen cabeceras de una tabla de movimientos (fecha + algún importe). */
function findHeaderRows(rows) {
  const found = [];
  for (let r = 0; r < rows.length; r++) {
    const roles = rows[r].map(headerRole);
    const hasDate = roles.includes('date') || roles.includes('dateValue');
    const hasMoney = roles.some((x) => MONEY_ROLES.includes(x));
    if (hasDate && hasMoney) found.push({ row: r, roles });
  }
  return found;
}

/** Título de la sección: la línea suelta más cercana encima de la cabecera (p. ej. "Cuenta personal (EUR)"). */
function sectionTitle(rows, headerRow) {
  for (let r = headerRow - 1; r >= Math.max(0, headerRow - 8); r--) {
    const cells = rows[r].map(normText).filter(Boolean);
    if (cells.length !== 1) continue;
    const t = cells[0];
    if (/^(-{3,}|extracto|transaction statement|estado de transacciones|statement)/i.test(t)) continue;
    return t.replace(/\s*(estado de transacciones|transaction statements?|res[uú]menes)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function buildMapping(rows, headerRow, roles, start, end) {
  const ncols = Math.max(0, ...rows.slice(Math.max(0, headerRow), Math.min(end, start + 300)).map((r) => r.length));
  const stats = columnStats(rows, start, end, ncols);
  const m = {
    headerRow, start, end, title: headerRow >= 0 ? sectionTitle(rows, headerRow) : '',
    headers: headerRow >= 0 ? rows[headerRow].map(normText) : [],
    date: -1, description: [], amount: -1, debit: -1, credit: -1, category: -1, kind: 'movements', dateOrder: 'dmy',
  };

  if (headerRow >= 0) {
    m.date = roles.indexOf('date');
    if (m.date < 0) m.date = roles.indexOf('dateValue');
    m.debit = roles.indexOf('debit');
    m.credit = roles.indexOf('credit');
    m.category = roles.indexOf('category');
    m.description = roles.map((r, i) => (r === 'description' ? i : -1)).filter((i) => i >= 0);
    // Importe: si hay varias columnas candidatas (p. ej. en libras y en euros, o
    // bruto y neto), gana la neta y la que está en euros.
    let cands = roles.map((r, i) => (r === 'amount' ? i : -1)).filter((i) => i >= 0);
    if (!cands.length) {
      cands = roles.map((r, i) => (r === 'returns' ? i : -1)).filter((i) => i >= 0);
      if (cands.length) m.kind = 'returns';
    }
    const score = (i) => (/net|neto|neta/i.test(m.headers[i]) ? 2 : 0) + (/distribuid|retirad|paid/i.test(m.headers[i]) ? 1 : 0) + (stats[i] && stats[i].euro ? 1 : 0);
    let best = -1, bestScore = -1;
    for (const i of cands) if (score(i) >= bestScore) { best = i; bestScore = score(i); }
    m.amount = best;
    if (m.amount >= 0 && m.debit >= 0 && m.credit >= 0) m.amount = -1; // cargo + abono manda
    if (m.amount >= 0) { m.debit = -1; m.credit = -1; }
  }

  // Lo que falte se deduce por el contenido.
  const used = () => new Set([m.date, m.amount, m.debit, m.credit, m.category, ...m.description]);
  if (m.date < 0) {
    const cand = stats.map((s, i) => ({ i, s })).filter(({ s }) => s.filled && s.dates / s.filled > 0.7);
    if (cand.length) m.date = cand.sort((a, b) => b.s.dates - a.s.dates)[0].i;
  }
  if (m.amount < 0 && m.debit < 0 && m.credit < 0) {
    const numeric = stats.map((s, i) => ({ i, s })).filter(({ i, s }) => !used().has(i) && s.filled && s.nums / s.filled > 0.7 && roles[i] !== 'balance');
    const notBalance = numeric.filter(({ i }) => !numeric.some(({ i: j }) => j !== i && looksLikeBalance(stats[j].values, stats[i].values)));
    const pick = (notBalance.length ? notBalance : numeric).sort((a, b) => (b.s.neg > 0) - (a.s.neg > 0) || a.i - b.i)[0];
    if (pick) m.amount = pick.i;
  }
  if (!m.description.length) {
    const cand = stats.map((s, i) => ({ i, s })).filter(({ i, s }) => !used().has(i) && roles[i] !== 'ignore' && roles[i] !== 'balance' && s.texts && s.texts / s.filled > 0.6);
    const best = cand.sort((a, b) => (b.s.distinct * b.s.avgLen) - (a.s.distinct * a.s.avgLen))[0];
    if (best) m.description = [best.i];
  }

  // Orden de la fecha: en España es día/mes; si el segundo número pasa de 12, es mes/día.
  if (m.date >= 0) {
    for (let r = start; r < end; r++) {
      const mm = normText(rows[r][m.date]).match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (mm && +mm[2] > 12) { m.dateOrder = 'mdy'; break; }
    }
  }
  return m;
}

/**
 * Divide el archivo en tablas de movimientos. Un extracto normal tiene una;
 * los consolidados (p. ej. Revolut) traen varias: cuentas en distintas
 * divisas, intereses, dividendos… Cada sección termina en la siguiente
 * cabecera, en una fila "Total" o en una línea "-----".
 */
function detectSections(rows) {
  const headers = findHeaderRows(rows);
  if (!headers.length) return [buildMapping(rows, -1, [], 0, rows.length)];
  return headers.map((h, k) => {
    const limit = k + 1 < headers.length ? headers[k + 1].row : rows.length;
    let end = limit;
    for (let r = h.row + 1; r < limit; r++) {
      if (/^(-{3,}|total\b)/i.test(normText(rows[r][0]))) { end = r; break; }
    }
    return buildMapping(rows, h.row, h.roles, h.row + 1, end);
  });
}

/** Compatibilidad: la primera (o única) tabla del archivo. */
function detectMapping(rows) {
  return detectSections(rows)[0];
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Aplica el mapeo de una sección. Devuelve { items, skipped }. Cada item:
 * { date, description, amount (<0 = gasto), transfer, kind }.
 * `invert` da la vuelta al signo (tarjetas que ponen los gastos en positivo).
 */
function extractRows(rows, m, { invert = false, ownNames = [] } = {}) {
  const investment = m.kind === 'movements' && INVESTMENT_SECTION.test(m.title || '');
  const items = [];
  let skipped = 0;
  const end = m.end ?? rows.length;
  for (let r = m.start ?? m.headerRow + 1; r < end; r++) {
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
    const description = decodeEntities(m.description.map((i) => normText(row[i])).filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i).join(' · '));
    if (!date || amount === null || amount === 0) { if (row.some((c) => normText(c))) skipped++; continue; }
    // Solo las filas que son exactamente un total o un saldo ("Saldo final", "Total:"),
    // no comercios como TotalEnergies o Suma, ni conceptos que empiecen así.
    if (/^(saldo|total|suma)(\s+(final|inicial|anterior|disponible|actual|del periodo|del período|general))?\s*[:.]?$/i.test(description)) { skipped++; continue; }
    const sourceCategory = m.category >= 0 ? normText(row[m.category]) : '';
    let transfer = '';
    if (investment) transfer = 'inversión';
    else if (m.kind === 'movements' && (TRANSFER_CATEGORY.test(sourceCategory) || TRANSFER_DESCRIPTION.test(description) || mentionsOwnName(description, ownNames))) {
      transfer = /inversi|invest/i.test(description) ? 'inversión' : 'traspaso';
    }
    items.push({ date, description: description || 'Movimiento', amount: invert ? -amount : amount, transfer, kind: m.kind, section: m.title || '' });
  }
  return { items, skipped };
}

/**
 * Todas las secciones juntas. Los intereses, rendimientos y dividendos se
 * agrupan en un único ingreso por mes y sección (en vez de decenas de céntimos).
 */
function extractAll(rows, sections, opts = {}) {
  const items = [];
  let skipped = 0;
  for (const m of sections) {
    const res = extractRows(rows, m, opts);
    skipped += res.skipped;
    if (m.kind !== 'returns') { items.push(...res.items); continue; }
    const head = m.headers[m.amount] || '';
    const label = /divid/i.test(head) ? 'Dividendos' : /inter[eé]s|interest/i.test(head) ? 'Intereses' : 'Rendimientos';
    const byMonth = new Map();
    for (const it of res.items) {
      const k = it.date.slice(0, 7);
      const g = byMonth.get(k) || { date: it.date, amount: 0, n: 0 };
      g.amount += it.amount;
      g.n++;
      if (it.date > g.date) g.date = it.date;
      byMonth.set(k, g);
    }
    for (const g of byMonth.values()) {
      const amount = Math.round(g.amount * 100) / 100;
      if (!amount) continue;
      items.push({ date: g.date, description: `${label}${m.title ? ' · ' + m.title : ''} (${g.n} ${g.n === 1 ? 'pago' : 'pagos'})`, amount, transfer: '', kind: 'returns', section: m.title || '' });
    }
  }
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items, skipped };
}

if (typeof module !== 'undefined') {
  module.exports = { mentionsOwnName, decodeText, isSpreadsheet, csvToRows, detectDelimiter, parseDate, parseAmount, detectMapping, detectSections, extractRows, extractAll, headerRole };
}

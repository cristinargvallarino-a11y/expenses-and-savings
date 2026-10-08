// Validación de todo lo que entra en la app desde fuera del código: lo guardado en
// el navegador, una copia restaurada o el archivo de Google Drive. Solo pasan
// datos con la forma esperada (ids, fechas, importes, textos con longitud
// máxima…); el resto se descarta. Así, un archivo manipulado no puede colar
// código ni romper la app.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CAT_ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const CUSTOM_CAT_ID_RE = /^c_[A-Za-z0-9_]{1,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const CURRENCIES = ['EUR', 'USD', 'GBP', 'MXN', 'ARS', 'COP', 'CLP'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ITEMS = 100000;

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Fecha de último cambio. Un dispositivo con el reloj adelantado no puede dejar
 * fechas "del futuro" que ganen siempre al sincronizar: se recortan a ahora + 1 día.
 */
function stamp(v) {
  return num(v, { min: 0, max: Date.now() + 86400000, fallback: num(v, { min: 0 }) ? Date.now() : 0 });
}

function list(v, max = MAX_ITEMS) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

/** Objeto plano sin claves peligrosas (como __proto__), con claves y valores validados. */
function cleanMap(v, keyOk, valueFn, max = 20000) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  let n = 0;
  for (const [k, raw] of Object.entries(v)) {
    if (n >= max) break;
    if (FORBIDDEN_KEYS.has(k) || !keyOk(k)) continue;
    const val = valueFn(raw);
    if (val === undefined) continue;
    out[k] = val;
    n++;
  }
  return out;
}

function cleanKeywords(v) {
  return list(v, 300).filter((k) => typeof k === 'string' && k.trim() && k.length <= 60);
}

function cleanSettings(s, defaults, groups, builtinIds) {
  s = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const out = {
    currency: CURRENCIES.includes(s.currency) ? s.currency : defaults.currency,
    paceMonths: [1, 3, 6, 12].includes(Number(s.paceMonths)) ? Number(s.paceMonths) : defaults.paceMonths,
    manualPace: s.manualPace === '' || s.manualPace == null ? '' : String(num(s.manualPace, { min: -1e9, max: 1e9, fallback: '' })),
    ownNames: str(s.ownNames, 300),
    rules: cleanMap(s.rules, (k) => k.length <= 300, (v) => (typeof v === 'string' && CAT_ID_RE.test(v) ? v : undefined)),
    customCategories: list(s.customCategories, 300).map((c) => {
      if (!c || typeof c !== 'object' || !CUSTOM_CAT_ID_RE.test(c.id)) return null;
      const label = str(c.label, 40).trim();
      if (!label) return null;
      const type = c.type === 'income' ? 'income' : 'expense';
      if (type === 'expense' && !groups[c.group]) return null;
      const out = { id: c.id, label, type, group: type === 'expense' ? c.group : undefined, keywords: cleanKeywords(c.keywords) };
      const updatedAt = stamp(c.updatedAt);
      if (updatedAt) out.updatedAt = updatedAt;
      return out;
    }).filter(Boolean),
    categoryOverrides: cleanMap(s.categoryOverrides, (k) => builtinIds.has(k), (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
      const r = {};
      const label = str(o.label, 40).trim();
      if (label) r.label = label;
      if (typeof o.group === 'string' && groups[o.group]) r.group = o.group;
      if (Array.isArray(o.keywords)) r.keywords = cleanKeywords(o.keywords);
      // Un cambio deshecho ("restaurar original") se guarda vacío con su fecha, para sincronizarlo.
      const updatedAt = stamp(o.updatedAt);
      if (updatedAt) r.updatedAt = updatedAt;
      return Object.keys(r).length ? r : undefined;
    }),
  };
  const updatedAt = stamp(s.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/**
 * Devuelve una copia limpia del estado. `ctx` aporta lo que depende de la app:
 * { defaults, groups, builtinExpenseIds, builtinIncomeIds }.
 */
function sanitizeState(raw, ctx) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const builtinIds = new Set([...ctx.builtinExpenseIds, ...ctx.builtinIncomeIds]);
  const settings = cleanSettings(src.settings, ctx.defaults.settings, ctx.groups, builtinIds);
  const expenseIds = new Set([...ctx.builtinExpenseIds, ...settings.customCategories.filter((c) => c.type === 'expense').map((c) => c.id)]);
  const incomeIds = new Set([...ctx.builtinIncomeIds, ...settings.customCategories.filter((c) => c.type === 'income').map((c) => c.id)]);
  const seen = new Set();

  const transactions = list(src.transactions).map((t) => {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID_RE.test(t.id) || seen.has(t.id)) return null;
    if (t.type !== 'income' && t.type !== 'expense') return null;
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) return null;
    const amount = num(t.amount, { min: 0, max: 1e10, fallback: NaN });
    if (!Number.isFinite(amount)) return null;
    seen.add(t.id);
    // La categoría tiene que existir y ser del mismo tipo que el movimiento.
    const valid = t.type === 'income' ? incomeIds : expenseIds;
    const category = typeof t.category === 'string' && valid.has(t.category) ? t.category : (t.type === 'income' ? 'otros_ing' : 'otros');
    const out = { id: t.id, type: t.type, date: t.date, amount, description: str(t.description, 300), category };
    const updatedAt = stamp(t.updatedAt);
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  }).filter(Boolean);

  const goals = list(src.goals, 1000).map((g) => {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !ID_RE.test(g.id) || seen.has(g.id)) return null;
    seen.add(g.id);
    const out = {
      id: g.id,
      name: str(g.name, 80).trim() || 'Objetivo',
      kind: g.kind === 'inversion' ? 'inversion' : 'ahorro',
      target: num(g.target, { min: 0, max: 1e12, fallback: 0 }),
      saved: num(g.saved, { min: -1e12, max: 1e12, fallback: 0 }),
      monthly: g.monthly === '' || g.monthly == null ? '' : num(g.monthly, { min: 0, max: 1e10, fallback: '' }),
      annualReturn: num(g.annualReturn, { min: -50, max: 50, fallback: 0 }),
      deadline: typeof g.deadline === 'string' && MONTH_RE.test(g.deadline) ? g.deadline : '',
    };
    const history = list(g.history, 5000)
      .filter((h) => h && typeof h === 'object' && typeof h.date === 'string' && DATE_RE.test(h.date) && Number.isFinite(Number(h.amount)))
      .map((h) => ({ date: h.date, amount: Number(h.amount) }));
    if (history.length) out.history = history;
    const updatedAt = stamp(g.updatedAt);
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  }).filter(Boolean);

  const deleted = cleanMap(src.deleted, (k) => ID_RE.test(k), (v) => stamp(v) || undefined, MAX_ITEMS);

  return { settings, transactions, goals, deleted };
}

/** Evita que un texto exportado a CSV se interprete como fórmula al abrirlo en Excel. */
function csvSafe(text) {
  const s = String(text ?? '');
  return /^[=+\-@\t\r＝＋－＠]/.test(s) ? `'${s}` : s;
}

if (typeof module !== 'undefined') {
  module.exports = { sanitizeState, csvSafe };
}

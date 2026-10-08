// Interfaz: estado, renderizado de vistas y gráficos SVG.

// La app no debe mostrarse dentro de otra web (evita que te engañen con clics encubiertos).
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  try { window.top.location = window.location.href; } catch (e) { /* bloqueado: queda oculta */ }
}

const STORAGE_KEY = 'mis-finanzas-v1';

const DEFAULT_STATE = {
  settings: { currency: 'EUR', paceMonths: 3, manualPace: '' },
  transactions: [],
  goals: [],
  deleted: {},
};

let lastStoredRaw = null; // lo último que esta pestaña leyó o escribió en el navegador
let state = loadState();
let viewMonth = localMonth();
let editingTxId = null;
let editingGoalId = null;
let categoryTouched = false;

// ---------- Utilidades ----------

function localDate(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}
function localMonth() { return localDate().slice(0, 7); }

function uid() {
  const rnd = new Uint32Array(2);
  crypto.getRandomValues(rnd);
  return Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36);
}

/** Todo dato que llega de fuera del código pasa por aquí (ver validate.js). */
function cleanState(raw) {
  return sanitizeState(raw, {
    defaults: DEFAULT_STATE,
    groups: GROUPS,
    builtinExpenseIds: BUILTIN_EXPENSE.map((c) => c.id),
    builtinIncomeIds: BUILTIN_INCOME.map((c) => c.id),
  });
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { lastStoredRaw = raw; return cleanState(JSON.parse(raw)); }
  } catch (e) { /* almacenamiento no disponible: empezamos de cero */ }
  return structuredClone(DEFAULT_STATE);
}

// Para sincronizar entre dispositivos, cada movimiento/objetivo lleva la fecha
// de su último cambio (`updatedAt`) y los borrados quedan anotados en
// `state.deleted`. save() lo calcula solo comparando con lo último guardado.
let snapshot = indexState(state);

function withoutTimestamp(r) {
  const { updatedAt, ...rest } = r || {};
  return JSON.stringify(rest);
}

function indexState(s) {
  const st = s.settings || {};
  const { customCategories = [], categoryOverrides = {}, updatedAt, ...scalars } = st;
  return {
    transactions: new Map(s.transactions.map((r) => [r.id, withoutTimestamp(r)])),
    goals: new Map(s.goals.map((r) => [r.id, withoutTimestamp(r)])),
    customCategories: new Map(customCategories.map((c) => [c.id, withoutTimestamp(c)])),
    categoryOverrides: new Map(Object.entries(categoryOverrides).map(([k, o]) => [k, withoutTimestamp(o)])),
    settings: JSON.stringify(scalars),
    deleted: { ...(s.deleted || {}) },
  };
}

/** La fecha más alta que ya conoce este estado (para que las nuevas nunca vayan hacia atrás). */
function latestStamp(s) {
  let max = 0;
  const see = (v) => { if (typeof v === 'number' && v > max) max = v; };
  for (const r of s.transactions) see(r.updatedAt);
  for (const r of s.goals) see(r.updatedAt);
  for (const v of Object.values(s.deleted || {})) see(v);
  const st = s.settings || {};
  see(st.updatedAt);
  for (const c of st.customCategories || []) see(c.updatedAt);
  for (const o of Object.values(st.categoryOverrides || {})) see(o && o.updatedAt);
  return max;
}

function stampChanges() {
  // Si otro dispositivo dejó una fecha algo adelantada, la nueva la supera igualmente.
  const now = Math.max(Date.now(), latestStamp(state) + 1);
  const deleted = { ...snapshot.deleted, ...(state.deleted || {}) };
  const track = (items, previous) => {
    const present = new Set();
    for (const r of items) {
      present.add(r.id);
      if (!r.updatedAt || previous.get(r.id) !== withoutTimestamp(r)) r.updatedAt = now;
      // Algo que está presente (p. ej. al restaurar una copia) vuelve a existir.
      if (deleted[r.id]) { delete deleted[r.id]; r.updatedAt = now; }
    }
    for (const id of previous.keys()) if (!present.has(id)) deleted[id] = now;
  };
  track(state.transactions, snapshot.transactions);
  track(state.goals, snapshot.goals);
  const st = state.settings;
  st.customCategories = st.customCategories || [];
  track(st.customCategories, snapshot.customCategories);
  // Cambios en las categorías de serie: uno a uno; deshacer uno deja una marca vacía con fecha.
  const overrides = { ...(st.categoryOverrides || {}) };
  for (const [k, o] of Object.entries(overrides)) {
    if (!o.updatedAt || snapshot.categoryOverrides.get(k) !== withoutTimestamp(o)) overrides[k] = { ...o, updatedAt: now };
  }
  for (const k of snapshot.categoryOverrides.keys()) if (!(k in overrides)) overrides[k] = { updatedAt: now };
  st.categoryOverrides = overrides;
  const { customCategories, categoryOverrides, updatedAt, ...scalars } = st;
  if (!st.updatedAt || JSON.stringify(scalars) !== snapshot.settings) st.updatedAt = now;
  state.deleted = deleted;
  snapshot = indexState(state);
}

/**
 * Guarda en el navegador. Si otra pestaña o ventana de la app guardó algo
 * mientras tanto, se junta antes de escribir para no borrar lo suyo.
 */
function persistLocal({ overwrite = false } = {}) {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (!overwrite && current && current !== lastStoredRaw) {
      state = cleanState(mergeStates(state, cleanState(JSON.parse(current))));
      snapshot = indexState(state);
    }
    const raw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, raw);
    lastStoredRaw = raw;
  } catch (e) { toast('No se pudo guardar en este navegador. Descarga una copia en Ajustes.'); }
}

function save() {
  stampChanges();
  persistLocal();
  scheduleSync();
}

/**
 * Sustituye el estado entero (datos de la nube, cerrar sesión…) sin marcarlo
 * como cambio local. `overwrite` descarta también lo que haya en otras pestañas.
 */
function replaceState(next, { overwrite = false } = {}) {
  state = cleanState(next);
  snapshot = indexState(state);
  persistLocal({ overwrite });
}

// Otra pestaña o ventana de la app ha guardado: se incorpora aquí al momento.
window.addEventListener('storage', (e) => {
  try {
    if (e.key === STORAGE_KEY && e.newValue) {
      state = cleanState(mergeStates(state, cleanState(JSON.parse(e.newValue))));
      snapshot = indexState(state);
      lastStoredRaw = e.newValue;
      renderAll();
    } else if (e.key === 'mf-connected' && e.oldValue && !e.newValue) {
      // Se cerró la sesión de Google en otra pestaña: aquí también se borran los datos.
      syncSession++;
      replaceState(structuredClone(DEFAULT_STATE), { overwrite: true });
      setSyncStatus('off');
      renderAll();
    }
  } catch (err) { /* datos ilegibles: se ignoran */ }
});

function money(x, opts = {}) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency', currency: state.settings.currency,
    maximumFractionDigits: opts.decimals ?? (Math.abs(x) >= 1000 ? 0 : 2),
    minimumFractionDigits: 0,
  }).format(x);
}
function pct(x) { return x == null ? '—' : `${Math.round(x * 100)}%`; }

function monthName(key, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = key.split('-').map(Number);
  const txt = new Date(y, m - 1, 1).toLocaleDateString('es-ES', opts);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function durationText(months) {
  if (months === 0) return '¡Conseguido!';
  if (!Number.isFinite(months)) return 'No llegas a este ritmo';
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [];
  if (y) parts.push(`${y} ${y === 1 ? 'año' : 'años'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'mes' : 'meses'}`);
  return parts.join(' y ');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function $(sel) { return document.querySelector(sel); }

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Tooltip ----------

const tip = document.getElementById('tooltip');
function showTip(evt, title, rows) {
  tip.replaceChildren();
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = title;
  tip.appendChild(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 't-row';
    if (r.color) { const i = document.createElement('i'); i.style.background = r.color; row.appendChild(i); }
    const b = document.createElement('strong'); b.textContent = r.value; row.appendChild(b);
    const s = document.createElement('span'); s.textContent = r.label; row.appendChild(s);
    tip.appendChild(row);
  }
  tip.style.display = 'block';
  const x = evt.clientX ?? evt.target.getBoundingClientRect().left;
  const y = evt.clientY ?? evt.target.getBoundingClientRect().top;
  const w = tip.offsetWidth;
  tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12)) + 'px';
  tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
}
function hideTip() { tip.style.display = 'none'; }

// ---------- Navegación ----------

function showView(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('#fab').classList.toggle('hidden', name === 'movimientos' || name === 'ajustes');
  hideTip();
  window.scrollTo({ top: 0 });
  renderAll();
}

document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

$('#fab').addEventListener('click', () => {
  showView('movimientos');
  txForm.elements.amount.focus();
});

$('#prev-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, -1); renderResumen(); });
$('#next-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, 1); renderResumen(); });

// ---------- RESUMEN ----------

// Una frase por mes: cambia al moverte entre meses y no se repite en años seguidos.
const QUOTES = [
  'Un euro ahorrado es un euro ganado.',
  'Cuida los céntimos, que los euros se cuidan solos.',
  'No ahorres lo que te sobra: gasta lo que te sobra después de ahorrar.',
  'Poco a poco se llena el cántaro.',
  'Págate a ti primero.',
  'El mejor momento para empezar a ahorrar fue ayer; el segundo mejor, hoy.',
  'Los pequeños gastos son como pequeñas goteras: hunden grandes barcos.',
  'No es cuánto ganas, sino cuánto guardas.',
  'Quien guarda, halla.',
  'El dinero es un buen sirviente y un mal amo.',
  'Compra lo que necesitas, no lo que puedes.',
  'Un presupuesto es decirle a tu dinero adónde ir, en vez de preguntarte adónde fue.',
  'El interés compuesto es la octava maravilla del mundo.',
  'Antes de comprar, espera 24 horas: si aún lo quieres, adelante.',
  'La riqueza es lo que no ves: el coche que no compraste.',
  'Gota a gota se llena la bota.',
  'Invertir en ti siempre da los mejores intereses.',
  'Vive por debajo de tus posibilidades y nunca te faltará.',
  'Más vale pájaro en mano que ciento volando.',
  'Lo barato sale caro… y los caprichos, más.',
  'Un objetivo sin plan es solo un deseo.',
  'Ahorrar no es privarse: es elegir.',
  'Los grandes sueños se pagan a plazos pequeños.',
  'El que no gasta lo que no tiene, siempre tiene.',
];

function quoteForMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return QUOTES[(y * 12 + m - 1) % QUOTES.length];
}

function renderHello() {
  const h = new Date().getHours();
  const greeting = h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  $('#hello').textContent = `${greeting} ✨`;
  $('#quote').textContent = `“${quoteForMonth(viewMonth)}”`;
}

const BACKUP_KEY = 'mf-last-backup';

/**
 * Si los datos solo están en este navegador (sin Google) y no hay una copia
 * reciente, se avisa: Safari borra los datos de las webs que no visitas en 7 días.
 */
function renderBackupNote() {
  const el = $('#backup-note');
  if (!el) return;
  const last = Number(lsGet(BACKUP_KEY)) || 0;
  const show = !isConnected() && state.transactions.length > 0 && Date.now() - last > 30 * 86400000;
  el.classList.toggle('hidden', !show);
  $('#backup-google').classList.toggle('hidden', !cloudOn());
}

function renderResumen() {
  renderHello();
  renderBackupNote();
  $('#month-label').textContent = monthName(viewMonth);
  const s = monthSummary(state.transactions, viewMonth, CATEGORY_BY_ID);
  const prev = monthSummary(state.transactions, addMonths(viewMonth, -1), CATEGORY_BY_ID);

  const delta = (now, before, invert) => {
    if (!before) return '';
    const d = (now - before) / before;
    if (Math.abs(d) < 0.005) return 'Igual que el mes anterior';
    const good = invert ? d < 0 : d > 0;
    return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))}%</span> vs. mes anterior`;
  };

  $('#kpis').innerHTML = `
    <div class="kpi"><div class="label">Ingresos</div><div class="value">${money(s.income)}</div><div class="sub">${delta(s.income, prev.income, false)}</div></div>
    <div class="kpi"><div class="label">Gastos</div><div class="value">${money(s.expense)}</div><div class="sub">${delta(s.expense, prev.expense, true)}</div></div>
    <div class="kpi"><div class="label">Ahorro del mes</div><div class="value ${s.net < 0 ? 'neg' : ''}">${money(s.net)}</div><div class="sub">Ingresos − gastos</div></div>
    <div class="kpi"><div class="label">Tasa de ahorro</div><div class="value">${pct(s.rate)}</div><div class="sub">${s.rate == null ? 'Añade tus ingresos' : s.rate >= 0.2 ? '¡Por encima del 20%!' : 'Objetivo orientativo: 20%'}</div></div>
  `;

  // Barras por grupo
  const groups = Object.entries(GROUPS)
    .map(([id, g]) => ({ id, ...g, amount: s.byGroup[id] || 0 }))
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const max = Math.max(...groups.map((g) => g.amount), 1);
  $('#group-bars').innerHTML = groups.length ? groups.map((g) => `
    <div class="hbar link" data-group="${esc(g.id)}" data-filter="g:${esc(g.id)}" role="button" tabindex="0">
      <div class="name"><i class="dot" style="background:${g.color}"></i><span>${esc(g.label)}</span></div>
      <div class="track"><div class="fill" style="width:${(g.amount / max) * 100}%;background:${g.color}"></div></div>
      <div class="val num">${money(g.amount)}<small>${s.income ? pct(g.amount / s.income) : pct(g.amount / s.expense)}</small></div>
    </div>`).join('') : `<div class="empty">Sin gastos este mes. Añádelos en <b>Movimientos</b>.</div>`;
  document.querySelectorAll('#group-bars .hbar').forEach((row) => {
    const g = groups.find((x) => x.id === row.dataset.group);
    const cats = EXPENSE_CATEGORIES.filter((c) => c.group === g.id && s.byCategory[c.id]);
    row.addEventListener('pointermove', (e) => showTip(e, g.label, cats.map((c) => ({ value: money(s.byCategory[c.id]), label: c.label }))));
    row.addEventListener('pointerleave', hideTip);
  });

  // Viajes
  const year = viewMonth.slice(0, 4);
  const travelCats = EXPENSE_CATEGORIES.filter((c) => c.group === 'viajes');
  const ytd = {};
  for (const t of state.transactions) {
    if (t.type !== 'expense' || !t.date.startsWith(year) || t.date.slice(0, 7) > viewMonth) continue;
    const c = CATEGORY_BY_ID[t.category];
    if (c && c.group === 'viajes') ytd[c.id] = (ytd[c.id] || 0) + t.amount;
  }
  const ytdTotal = Object.values(ytd).reduce((a, b) => a + b, 0);
  const monthTravel = s.byGroup.viajes || 0;
  $('#travel-card').innerHTML = `
    <div class="kpis" style="grid-template-columns:1fr 1fr;margin-bottom:8px">
      <div><div class="muted small">Este mes</div><div class="pace-big" style="font-size:1.5rem">${money(monthTravel)}</div></div>
      <div><div class="muted small">En ${year} (hasta este mes)</div><div class="pace-big" style="font-size:1.5rem">${money(ytdTotal)}</div></div>
    </div>
    ${travelCats.map((c) => `
      <div class="hbar link" data-filter="c:${esc(c.id)}" role="button" tabindex="0">
        <div class="name"><span>${c.id === 'vuelos' ? '🛫' : c.id === 'hoteles' ? '🏨' : '🧳'} ${esc(c.label)}</span></div>
        <div class="track"><div class="fill" style="width:${ytdTotal ? ((ytd[c.id] || 0) / ytdTotal) * 100 : 0}%;background:var(--g-viajes)"></div></div>
        <div class="val num">${money(ytd[c.id] || 0)}<small>${money(s.byCategory[c.id] || 0)} este mes</small></div>
      </div>`).join('')}
  `;

  // 50/30/20
  if (s.income > 0) {
    const needs = s.byGroup.necesarios || 0;
    const wants = s.expense - needs;
    const saved = Math.max(0, s.net);
    const rows = [
      { label: 'Necesidades', value: needs / s.income, ideal: 0.5, over: true, color: 'var(--g-necesarios)' },
      { label: 'Deseos', value: wants / s.income, ideal: 0.3, over: true, color: 'var(--g-social)' },
      { label: 'Ahorro', value: saved / s.income, ideal: 0.2, over: false, color: 'var(--series-income)' },
    ];
    $('#rule-503020').innerHTML = rows.map((r) => {
      const ok = r.over ? r.value <= r.ideal : r.value >= r.ideal;
      return `
        <div class="hbar">
          <div class="name"><span>${r.label}</span></div>
          <div class="track" style="position:relative">
            <div class="fill" style="width:${Math.min(100, r.value * 100)}%;background:${r.color}"></div>
          </div>
          <div class="val num">${pct(r.value)} <small>${ok ? '✓' : '⚠'} ideal ${pct(r.ideal)}</small></div>
        </div>`;
    }).join('') + `<div class="note">${advice503020(needs / s.income, wants / s.income, saved / s.income)}</div>`;
  } else {
    $('#rule-503020').innerHTML = `<div class="empty">Añade tus ingresos del mes para compararlos.</div>`;
  }

  // Top categorías
  const top = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topMax = top.length ? top[0][1] : 1;
  $('#top-categories').innerHTML = top.length ? top.map(([id, amt]) => {
    const c = CATEGORY_BY_ID[id];
    const g = GROUPS[c.group];
    return `
      <div class="hbar link" data-filter="c:${esc(id)}" role="button" tabindex="0">
        <div class="name"><i class="dot" style="background:${g.color}"></i><span>${esc(c.label)}</span></div>
        <div class="track"><div class="fill" style="width:${(amt / topMax) * 100}%;background:${g.color}"></div></div>
        <div class="val num">${money(amt)}</div>
      </div>`;
  }).join('') : `<div class="empty">Nada por aquí todavía.</div>`;

  renderTrend();
}

// Tocar una barra del resumen abre sus movimientos de ese mes.
$('#view-resumen').addEventListener('click', (e) => {
  const row = e.target.closest('[data-filter]');
  if (row) { hideTip(); showMovements(row.dataset.filter, viewMonth); }
});
$('#view-resumen').addEventListener('keydown', (e) => {
  const row = e.target.closest('[data-filter]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showMovements(row.dataset.filter, viewMonth); }
});

function advice503020(needs, wants, saved) {
  if (saved >= 0.2 && needs <= 0.5) return '👏 Vas muy bien: cubres lo necesario y ahorras al menos un 20%.';
  if (needs > 0.5) return `🏠 Lo necesario se lleva el ${pct(needs)} de tus ingresos. Revisa facturas, seguros o suscripciones que se hayan colado.`;
  if (wants > 0.3) return `🎉 Los deseos se llevan el ${pct(wants)}. Recortar ${pct(wants - 0.3)} te llevaría a la regla.`;
  return `💡 Ahorras un ${pct(saved)}. Subirlo hacia el 20% acelera tus objetivos (mira la pestaña Ahorro).`;
}

function renderTrend() {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(viewMonth, -i));
  const data = months.map((m) => monthSummary(state.transactions, m, CATEGORY_BY_ID));
  drawIncomeExpenseBars($('#trend-chart'), data, viewMonth, 'Ingresos y gastos de los últimos 6 meses');
}

/** Barras agrupadas ingresos/gastos por mes, con tooltip. */
function drawIncomeExpenseBars(el, data, highlight, ariaLabel) {
  const W = Math.max(300, el.clientWidth || 640), H = 240, padL = 52, padR = 8, padT = 10, padB = 26;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1));
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(26, slot / 3));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Con 12 meses en el móvil no caben "ene, feb…": se usa la inicial.
  const label = (m) => (slot < 36 ? monthName(m, { month: 'narrow' }) : monthName(m, { month: 'short' }));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel}">`;
  for (const t of ticks) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(${t === 0 ? '--axis' : '--grid'})" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = padL + slot * i + slot / 2;
    svg += barPath(cx - barW - 1, y(d.income), barW, padT + plotH - y(d.income), 'var(--series-income)');
    svg += barPath(cx + 1, y(d.expense), barW, padT + plotH - y(d.expense), 'var(--series-expense)');
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" style="${d.month === highlight ? 'fill:var(--text);font-weight:600' : ''}">${label(d.month)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>`;
  });
  svg += `</svg>`;
  el.innerHTML = svg;
  el.querySelectorAll('.hit').forEach((r) => {
    const d = data[+r.dataset.i];
    r.addEventListener('pointermove', (e) => showTip(e, monthName(d.month), [
      { color: 'var(--series-income)', value: money(d.income), label: 'ingresos' },
      { color: 'var(--series-expense)', value: money(d.expense), label: 'gastos' },
      { value: money(d.net), label: `ahorro (${pct(d.rate)})` },
    ]));
    r.addEventListener('pointerleave', hideTip);
  });
}

// Barra con extremo superior redondeado (4px) anclada a la línea base.
function barPath(x, y, w, h, fill) {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

function compact(v) {
  return new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

// ---------- AÑO ----------

let viewYear = Number(localMonth().slice(0, 4));

$('#prev-year').addEventListener('click', () => { viewYear--; renderAnual(); });
$('#next-year').addEventListener('click', () => { viewYear++; renderAnual(); });

function yearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

function renderAnual() {
  const year = viewYear;
  const current = localMonth();
  $('#year-label').textContent = String(year);
  const months = yearMonths(year);
  const data = months.map((m) => monthSummary(state.transactions, m, CATEGORY_BY_ID));
  // Meses con movimientos (para medias) y meses ya transcurridos (para el acumulado).
  const active = data.filter((d) => d.income || d.expense);
  const elapsed = data.filter((d) => d.month <= current);
  const income = data.reduce((a, d) => a + d.income, 0);
  const expense = data.reduce((a, d) => a + d.expense, 0);
  const net = income - expense;
  const n = Math.max(1, active.length);

  const first = active[0], last = active[active.length - 1];
  $('#year-sub').textContent = active.length
    ? `De ${monthName(first.month, { month: 'long' }).toLowerCase()} a ${monthName(last.month, { month: 'long' }).toLowerCase()}: ${active.length} ${active.length === 1 ? 'mes' : 'meses'} con movimientos.`
    : 'Todavía no hay movimientos este año.';

  // Comparación con el mismo periodo del año anterior
  const prevData = yearMonths(year - 1).map((m) => monthSummary(state.transactions, m, CATEGORY_BY_ID));
  const samePeriod = (arr) => arr.filter((d, i) => data[i].income || data[i].expense);
  const prevExpense = samePeriod(prevData).reduce((a, d) => a + d.expense, 0);
  const prevIncome = samePeriod(prevData).reduce((a, d) => a + d.income, 0);
  const vs = (now, before, invert) => {
    if (!before) return '';
    const d = (now - before) / before;
    const good = invert ? d < 0 : d > 0;
    return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))}%</span> vs. ${year - 1}`;
  };
  $('#year-kpis').innerHTML = `
    <div class="kpi"><div class="label">Ingresos</div><div class="value">${money(income)}</div><div class="sub">${vs(income, prevIncome, false) || `${money(income / n)} de media al mes`}</div></div>
    <div class="kpi"><div class="label">Gastos</div><div class="value">${money(expense)}</div><div class="sub">${vs(expense, prevExpense, true) || `${money(expense / n)} de media al mes`}</div></div>
    <div class="kpi"><div class="label">Ahorro del año</div><div class="value ${net < 0 ? 'neg' : ''}">${money(net)}</div><div class="sub">${money(net / n)} de media al mes</div></div>
    <div class="kpi"><div class="label">Tasa de ahorro</div><div class="value">${pct(income ? net / income : null)}</div><div class="sub">${income ? (net / income >= 0.2 ? '¡Por encima del 20%!' : 'Objetivo orientativo: 20%') : 'Añade tus ingresos'}</div></div>`;

  // Gasto por grupo
  const byGroup = {}, byCategory = {};
  for (const d of data) {
    for (const [g, v] of Object.entries(d.byGroup)) byGroup[g] = (byGroup[g] || 0) + v;
    for (const [c, v] of Object.entries(d.byCategory)) byCategory[c] = (byCategory[c] || 0) + v;
  }
  const groups = Object.entries(GROUPS).map(([id, g]) => ({ id, ...g, amount: byGroup[id] || 0 }))
    .filter((g) => g.amount > 0).sort((a, b) => b.amount - a.amount);
  const gmax = Math.max(...groups.map((g) => g.amount), 1);
  $('#year-groups').innerHTML = groups.length ? groups.map((g) => `
    <div class="hbar">
      <div class="name"><i class="dot" style="background:${g.color}"></i><span>${esc(g.label)}</span></div>
      <div class="track"><div class="fill" style="width:${(g.amount / gmax) * 100}%;background:${g.color}"></div></div>
      <div class="val num">${money(g.amount)}<small>${money(g.amount / n)}/mes</small></div>
    </div>`).join('') : '<div class="empty">Sin gastos este año.</div>';

  // Top categorías
  const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const tmax = top.length ? top[0][1] : 1;
  $('#year-top').innerHTML = top.length ? top.map(([id, amt]) => {
    const c = CATEGORY_BY_ID[id] || CATEGORY_BY_ID.otros;
    const g = GROUPS[c.group];
    return `
      <div class="hbar">
        <div class="name"><i class="dot" style="background:${g.color}"></i><span>${esc(c.label)}</span></div>
        <div class="track"><div class="fill" style="width:${(amt / tmax) * 100}%;background:${g.color}"></div></div>
        <div class="val num">${money(amt)}<small>${pct(amt / expense)}</small></div>
      </div>`;
  }).join('') : '<div class="empty">Nada por aquí todavía.</div>';

  // Lo más destacado
  const hl = [];
  if (active.length) {
    const bestSave = active.reduce((a, d) => (d.net > a.net ? d : a));
    const mostSpent = active.reduce((a, d) => (d.expense > a.expense ? d : a));
    const leastSpent = active.reduce((a, d) => (d.expense < a.expense ? d : a));
    hl.push(['💰', 'Mes en que más ahorraste', `${monthName(bestSave.month, { month: 'long' })}: ${money(bestSave.net)}`]);
    hl.push(['💸', 'Mes con más gasto', `${monthName(mostSpent.month, { month: 'long' })}: ${money(mostSpent.expense)}`]);
    if (active.length > 1) hl.push(['🌱', 'Mes con menos gasto', `${monthName(leastSpent.month, { month: 'long' })}: ${money(leastSpent.expense)}`]);
    if (top.length) {
      const [cid, amt] = top[0];
      hl.push(['🧾', 'Donde más gastas', `${(CATEGORY_BY_ID[cid] || CATEGORY_BY_ID.otros).label}: ${money(amt)} (${pct(amt / expense)} de tus gastos)`]);
    }
    const travel = byGroup.viajes || 0;
    if (travel) {
      const fl = byCategory.vuelos || 0, ho = byCategory.hoteles || 0;
      hl.push(['✈️', 'Viajes en el año', `${money(travel)} · vuelos ${money(fl)}, alojamiento ${money(ho)}`]);
    }
    if (prevExpense) {
      const d = (expense - prevExpense) / prevExpense;
      hl.push([d <= 0 ? '👏' : '⚠️', `Frente al mismo periodo de ${year - 1}`, `Has gastado un ${Math.abs(Math.round(d * 100))}% ${d <= 0 ? 'menos' : 'más'} (${money(Math.abs(expense - prevExpense))})`]);
    }
  }
  $('#year-highlights').innerHTML = hl.length
    ? hl.map(([ico, t, v]) => `<div class="highlight"><div class="ico">${ico}</div><div><div class="t">${t}</div><div class="v">${esc(v)}</div></div></div>`).join('')
    : '<div class="empty">Cuando tengas movimientos verás aquí tus mejores y peores meses.</div>';

  drawIncomeExpenseBars($('#year-chart'), data, current, `Ingresos y gastos de ${year}`);
  drawCumulative($('#year-cum'), first ? elapsed.filter((d) => d.month >= first.month) : []);

  // Tabla
  const rows = data.map((d) => {
    const emptyMonth = !d.income && !d.expense;
    return `<tr class="${emptyMonth ? 'empty-month' : ''}">
      <td>${monthName(d.month, { month: 'long' })}</td>
      <td class="num">${emptyMonth ? '—' : money(d.income)}</td>
      <td class="num">${emptyMonth ? '—' : money(d.expense)}</td>
      <td class="num ${d.net < 0 ? 'neg' : ''}">${emptyMonth ? '—' : money(d.net)}</td>
      <td class="num rate">${emptyMonth ? '—' : pct(d.rate)}</td>
    </tr>`;
  }).join('');
  $('#year-table').innerHTML = `
    <thead><tr><th>Mes</th><th class="r">Ingresos</th><th class="r">Gastos</th><th class="r">Ahorro</th><th class="r rate">Tasa</th></tr></thead>
    <tbody>${rows}
      <tr class="total"><td>Total</td><td class="num">${money(income)}</td><td class="num">${money(expense)}</td><td class="num ${net < 0 ? 'neg' : ''}">${money(net)}</td><td class="num rate">${pct(income ? net / income : null)}</td></tr>
    </tbody>`;
}

/** Línea del ahorro acumulado del año, con punto por mes y tooltip. */
function drawCumulative(el, data) {
  if (!data.length || data.every((d) => !d.income && !d.expense)) { el.innerHTML = '<div class="empty">Sin datos todavía.</div>'; return; }
  let acc = 0;
  const pts = data.map((d) => ({ month: d.month, net: d.net, value: (acc += d.net) }));
  const W = Math.max(280, el.clientWidth || 600), H = 220, padL = 52, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const hi = Math.max(0, ...pts.map((p) => p.value));
  const lo = Math.min(0, ...pts.map((p) => p.value));
  const top = niceMax(Math.max(hi, 1));
  const bottom = lo < 0 ? -niceMax(-lo) : 0;
  const x = (i) => padL + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - bottom) / (top - bottom)) * plotH;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ahorro acumulado">`;
  for (const f of [0, 0.5, 1]) {
    const v = bottom + f * (top - bottom);
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)"/>`;
  svg += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--series-projection)" stroke-width="2"/>`;
  pts.forEach((p, i) => {
    svg += `<circle cx="${x(i)}" cy="${y(p.value)}" r="4" fill="var(--series-projection)" stroke="var(--surface)" stroke-width="2"/>`;
    if (pts.length <= 6 || i % 2 === 0 || i === pts.length - 1) {
      svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${monthName(p.month, { month: pts.length > 6 && plotW < 400 ? 'narrow' : 'short' })}</text>`;
    }
    const w = pts.length === 1 ? plotW : plotW / (pts.length - 1);
    svg += `<rect class="hit" data-i="${i}" x="${x(i) - w / 2}" y="${padT}" width="${w}" height="${plotH}" fill="transparent"/>`;
  });
  const lastP = pts[pts.length - 1];
  svg += `<text x="${x(pts.length - 1)}" y="${y(lastP.value) - 10}" text-anchor="end" style="fill:var(--text);font-weight:600">${money(lastP.value)}</text>`;
  svg += `</svg>`;
  el.innerHTML = svg;
  el.querySelectorAll('.hit').forEach((r) => {
    const p = pts[+r.dataset.i];
    r.addEventListener('pointermove', (e) => showTip(e, monthName(p.month), [
      { color: 'var(--series-projection)', value: money(p.value), label: 'acumulado' },
      { value: money(p.net), label: 'ahorro del mes' },
    ]));
    r.addEventListener('pointerleave', hideTip);
  });
}

// ---------- MOVIMIENTOS ----------

const txForm = $('#tx-form');

function fillCategorySelect(type, selected) {
  const sel = txForm.elements.category;
  if (type === 'income') {
    sel.innerHTML = INCOME_CATEGORIES.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  } else {
    sel.innerHTML = Object.entries(GROUPS).map(([gid, g]) => `
      <optgroup label="${esc(g.label)}">
        ${EXPENSE_CATEGORIES.filter((c) => c.group === gid).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}
      </optgroup>`).join('');
  }
  sel.insertAdjacentHTML('beforeend', '<option value="__new">➕ Nueva categoría…</option>');
  sel.value = selected && CATEGORY_BY_ID[selected] ? selected : (type === 'income' ? 'nomina' : 'otros');
  sel.dataset.prev = sel.value;
}

function currentType() { return txForm.elements.type.value; }

txForm.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
  categoryTouched = false;
  fillCategorySelect(currentType());
  autoClassify();
}));

function autoClassify() {
  if (categoryTouched) return;
  const guess = classify(txForm.elements.description.value, currentType(), state.settings.rules);
  if (guess) {
    txForm.elements.category.value = guess;
    const c = CATEGORY_BY_ID[guess];
    $('#auto-hint').textContent = `· sugerida automáticamente${c.group ? ' (' + GROUPS[c.group].label + ')' : ''}`;
  } else {
    $('#auto-hint').textContent = '';
  }
}
txForm.elements.description.addEventListener('input', autoClassify);
txForm.elements.category.addEventListener('change', (e) => {
  const sel = e.target;
  if (sel.value === '__new') {
    sel.value = sel.dataset.prev || 'otros';
    openCategoryDialog({ type: currentType(), onSave: (cat) => {
      fillCategorySelect(cat.type, cat.id);
      categoryTouched = true;
      $('#auto-hint').textContent = '';
    } });
    return;
  }
  sel.dataset.prev = sel.value;
  categoryTouched = true;
  $('#auto-hint').textContent = '';
});

function resetTxForm() {
  editingTxId = null;
  categoryTouched = false;
  txForm.reset();
  txForm.elements.date.value = localDate();
  fillCategorySelect('expense');
  $('#auto-hint').textContent = '';
  $('#form-title').textContent = 'Añadir movimiento';
  $('#tx-cancel').classList.add('hidden');
}

txForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = txForm.elements;
  const tx = {
    id: editingTxId || uid(),
    type: currentType(),
    date: f.date.value,
    amount: Math.round(parseFloat(f.amount.value) * 100) / 100,
    description: f.description.value.trim().slice(0, 300),
    category: f.category.value,
  };
  if (!(tx.amount > 0) || !tx.date) return;
  if (editingTxId) {
    const before = state.transactions.find((t) => t.id === editingTxId);
    state.transactions = state.transactions.map((t) => (t.id === editingTxId ? tx : t));
    const learned = before && before.category !== tx.category ? learnCategory(tx, before.category) : 0;
    toast(learned
      ? `Actualizado. También he cambiado ${learned} ${learned === 1 ? 'movimiento igual' : 'movimientos iguales'} y lo recordaré.`
      : 'Movimiento actualizado');
  } else {
    state.transactions.push(tx);
    toast(`${tx.type === 'income' ? 'Ingreso' : 'Gasto'} guardado en ${CATEGORY_BY_ID[tx.category].label}`);
  }
  save();
  $('#list-month').value = tx.date.slice(0, 7);
  resetTxForm();
  txForm.elements.date.value = tx.date;
  renderMovimientos();
});

/**
 * Al cambiar la categoría de un movimiento, la app lo recuerda para ese mismo
 * concepto (próximas importaciones y altas) y corrige los iguales que tenían
 * la categoría anterior. Devuelve cuántos otros movimientos ha cambiado.
 */
function learnCategory(tx, previousCategory) {
  const key = ruleKey(tx.description);
  if (!key) return 0;
  state.settings.rules = { ...(state.settings.rules || {}), [key]: tx.category };
  let changed = 0;
  for (const t of state.transactions) {
    if (t.id !== tx.id && t.type === tx.type && ruleKey(t.description) === key && t.category === previousCategory) {
      t.category = tx.category;
      changed++;
    }
  }
  return changed;
}

$('#tx-cancel').addEventListener('click', resetTxForm);
$('#list-month').addEventListener('change', renderMovimientos);
$('#list-filter').addEventListener('change', renderMovimientos);
$('#list-all-months').addEventListener('change', renderMovimientos);
let searchTimer;
$('#list-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderMovimientos, 200); });
$('#list-clear').addEventListener('click', () => {
  $('#list-filter').value = 'all';
  $('#list-search').value = '';
  $('#list-all-months').checked = false;
  renderMovimientos();
});

/** Abre Movimientos filtrado (p. ej. desde una barra del Resumen). filter: 'g:<grupo>' o 'c:<categoría>'. */
function showMovements(filter, month) {
  $('#list-month').value = month;
  $('#list-all-months').checked = false;
  $('#list-search').value = '';
  showView('movimientos');
  $('#list-filter').value = filter;
  renderMovimientos();
}

/** Opciones del filtro: tipo, grupos y categorías (incluidas las propias). */
function fillListFilter() {
  const sel = $('#list-filter');
  const current = sel.value || 'all';
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  sel.innerHTML = `
    <optgroup label="Tipo">${opt('all', 'Todas las categorías')}${opt('expense', 'Solo gastos')}${opt('income', 'Solo ingresos')}</optgroup>
    ${Object.entries(GROUPS).map(([gid, g]) => `
      <optgroup label="${esc(g.label)}">
        ${opt('g:' + gid, `Todo ${g.label}`)}
        ${EXPENSE_CATEGORIES.filter((c) => c.group === gid).map((c) => opt('c:' + c.id, c.label)).join('')}
      </optgroup>`).join('')}
    <optgroup label="Ingresos">${INCOME_CATEGORIES.map((c) => opt('c:' + c.id, c.label)).join('')}</optgroup>`;
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'all';
}

function matchesFilter(t, filter) {
  if (filter === 'all') return true;
  if (filter === 'expense' || filter === 'income') return t.type === filter;
  const c = CATEGORY_BY_ID[t.category] || CATEGORY_BY_ID.otros;
  if (filter.startsWith('g:')) return t.type === 'expense' && c.group === filter.slice(2);
  if (filter.startsWith('c:')) return t.category === filter.slice(2);
  return true;
}

function renderMovimientos() {
  fillListFilter();
  const allMonths = $('#list-all-months').checked;
  $('#list-month').disabled = allMonths;
  const month = $('#list-month').value || localMonth();
  const filter = $('#list-filter').value;
  const query = normalize($('#list-search').value).trim();
  const filtered = filter !== 'all' || query || allMonths;
  $('#list-clear').classList.toggle('hidden', !filtered);
  const list = state.transactions
    .filter((t) => (allMonths || t.date.startsWith(month)) && matchesFilter(t, filter)
      && (!query || normalize(t.description).includes(query)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const el = $('#tx-list');
  const where = allMonths ? 'en ningún mes' : `en ${monthName(month)}`;
  if (!list.length) {
    el.innerHTML = `<div class="empty">No hay movimientos ${filtered ? 'con estos filtros ' : ''}${where}.</div>`;
    return;
  }
  const inc = list.filter((t) => t.type === 'income').reduce((a, t) => a + t.amount, 0);
  const exp = list.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
  const totalBox = filtered ? `<div class="list-total"><span><strong>${list.length}</strong> ${list.length === 1 ? 'movimiento' : 'movimientos'}${allMonths ? ' (todos los meses)' : ''}</span>
    <span>${exp ? `Gastos <strong>${money(exp)}</strong>` : ''}${exp && inc ? ' · ' : ''}${inc ? `Ingresos <strong>${money(inc)}</strong>` : ''}</span></div>` : '';
  el.innerHTML = list.map((t) => {
    const c = CATEGORY_BY_ID[t.category] || CATEGORY_BY_ID.otros;
    const color = t.type === 'income' ? 'var(--series-income)' : GROUPS[c.group].color;
    const groupLabel = t.type === 'income' ? 'Ingreso' : GROUPS[c.group].label;
    return `
      <div class="tx" data-id="${esc(t.id)}">
        <div class="date num">${t.date.slice(8, 10)}/${t.date.slice(5, 7)}${allMonths ? '/' + t.date.slice(2, 4) : ''}</div>
        <div class="desc">
          <div>${esc(t.description)}</div>
          <div class="chip"><i class="dot" style="background:${color}"></i>${esc(groupLabel)} · ${esc(c.label)}</div>
        </div>
        <div class="num ${t.type === 'income' ? 'pos' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount, { decimals: 2 })}</div>
        <div class="actions">
          <button data-act="edit" aria-label="Editar" title="Editar">✏️</button>
          <button data-act="del" aria-label="Borrar" title="Borrar">🗑️</button>
        </div>
      </div>`;
  }).join('');
  el.insertAdjacentHTML('afterbegin', totalBox);
  if (!filtered) el.insertAdjacentHTML('beforeend', `<div class="row gap wrap top-gap small muted">${list.length} movimientos · Ingresos ${money(inc)} · Gastos ${money(exp)}</div>`);
}

$('#tx-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.tx').dataset.id;
  const t = state.transactions.find((x) => x.id === id);
  if (btn.dataset.act === 'del') {
    if (!confirm(`¿Borrar "${t.description}"?`)) return;
    state.transactions = state.transactions.filter((x) => x.id !== id);
    save();
    renderMovimientos();
    toast('Movimiento borrado');
  } else {
    editingTxId = id;
    categoryTouched = true;
    txForm.querySelector(`input[name="type"][value="${t.type}"]`).checked = true;
    fillCategorySelect(t.type, t.category);
    txForm.elements.date.value = t.date;
    txForm.elements.amount.value = t.amount;
    txForm.elements.description.value = t.description;
    $('#form-title').textContent = 'Editar movimiento';
    $('#tx-cancel').classList.remove('hidden');
    txForm.scrollIntoView({ behavior: 'smooth' });
  }
});

$('#copy-fixed').addEventListener('click', () => {
  const month = $('#list-month').value || localMonth();
  const prev = addMonths(month, -1);
  const fixed = state.transactions.filter((t) => t.type === 'expense' && t.date.startsWith(prev)
    && CATEGORY_BY_ID[t.category]?.group === 'necesarios'
    && ['vivienda', 'facturas', 'seguros'].includes(t.category));
  const already = new Set(state.transactions.filter((t) => t.date.startsWith(month)).map((t) => t.description + t.amount));
  const toCopy = fixed.filter((t) => !already.has(t.description + t.amount));
  if (!toCopy.length) { toast('No hay gastos fijos (vivienda, facturas, seguros) nuevos que copiar'); return; }
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  for (const t of toCopy) {
    const day = String(Math.min(Number(t.date.slice(8, 10)), lastDay)).padStart(2, '0');
    state.transactions.push({ ...t, id: uid(), date: `${month}-${day}` });
  }
  save();
  renderMovimientos();
  toast(`${toCopy.length} gastos fijos copiados de ${monthName(prev, { month: 'long' })}`);
});

// ---------- Importar extractos del banco (CSV o Excel) ----------

const IMPORT_MAPS_KEY = 'mf-import-maps';
// { name, rows, sections, signature, toggles: { índice → incluir sí/no } }
let importJob = null;

$('#csv-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const rows = isSpreadsheet(buffer) ? await spreadsheetRows(buffer) : csvToRows(decodeText(buffer));
    if (!rows.length) { toast('El archivo está vacío'); return; }
    const sections = detectSections(rows);
    const signature = sections.length === 1 ? sections[0].headers.join('|') : '';
    const saved = signature && loadImportMaps()[signature];
    if (saved) Object.assign(sections[0], saved);
    importJob = { name: file.name, rows, sections, signature, toggles: {} };
    $('#import-invert').checked = Boolean(saved && saved.invert);
    $('#import-names').value = state.settings.ownNames || '';
    $('#import-adv').open = false;
    renderImportPreview();
    $('#import-card').classList.remove('hidden');
    $('#import-card').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    toast('No he podido leer ese archivo. Prueba a descargarlo en CSV.');
  }
});

/**
 * Lee la hoja con más filas de un Excel (.xlsx o .xls) en un proceso aparte
 * (xlsx-worker.js), aislado de la página y de tus datos.
 */
function spreadsheetRows(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('xlsx-worker.js');
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('El Excel tarda demasiado en leerse')); }, 20000);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      const msg = e.data || {};
      if (!msg.ok || !Array.isArray(msg.rows)) { reject(new Error(msg.error || 'No se pudo leer el Excel')); return; }
      resolve(msg.rows.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== '')));
    };
    worker.onerror = (err) => { clearTimeout(timer); worker.terminate(); reject(err); };
    worker.postMessage(buffer, [buffer]);
  });
}

function loadImportMaps() {
  try { return JSON.parse(localStorage.getItem(IMPORT_MAPS_KEY)) || {}; } catch (e) { return {}; }
}

function ownNames() {
  return String(state.settings.ownNames || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
}

function txKey(t) {
  return `${t.date}|${Math.abs(t.amount).toFixed(2)}|${normalize(t.description).trim()}`;
}

function autoCategory(description, type) {
  return classify(description, type, state.settings.rules) || (type === 'income' ? 'otros_ing' : 'otros');
}

/** Movimientos del archivo listos para importar, con su casilla marcada o no. */
function importItems() {
  const { items, skipped } = extractAll(importJob.rows, importJob.sections, { invert: $('#import-invert').checked, ownNames: ownNames() });
  // Duplicados: solo frente a lo que ya tienes (dos cafés iguales el mismo día son dos cafés).
  const existing = new Map();
  for (const t of state.transactions) existing.set(txKey(t), (existing.get(txKey(t)) || 0) + 1);
  const list = [];
  let duplicates = 0;
  items.forEach((it) => {
    const k = txKey(it);
    if (existing.get(k)) { existing.set(k, existing.get(k) - 1); duplicates++; return; }
    const type = it.amount < 0 ? 'expense' : 'income';
    // Un rendimiento negativo (comisiones mayores que intereses) es un gasto normal, no un ingreso.
    const category = it.kind === 'returns' && type === 'income' ? 'rendimientos' : autoCategory(it.description, type);
    const idx = list.length;
    const include = idx in importJob.toggles ? importJob.toggles[idx] : !it.transfer;
    list.push({ idx, include, transfer: it.transfer, section: it.section, type, date: it.date, amount: Math.round(Math.abs(it.amount) * 100) / 100, description: String(it.description).slice(0, 300), category });
  });
  return { list, skipped, duplicates };
}

function renderImportMapping() {
  const single = importJob.sections.length === 1;
  $('#import-adv').classList.toggle('hidden', !single);
  const multi = $('#import-sections');
  multi.classList.toggle('hidden', single);
  if (!single) {
    const names = [...new Set(importJob.sections.map((m) => m.title).filter(Boolean))];
    multi.innerHTML = `Extracto con varias secciones: ${names.map(esc).join(', ')}. He tomado los importes en euros.`;
    return;
  }
  const { rows } = importJob;
  const mapping = importJob.sections[0];
  const ncols = Math.max(...rows.slice(0, 200).map((r) => r.length));
  const sample = rows[mapping.headerRow + 1] || [];
  const colName = (i) => {
    const h = mapping.headers[i];
    const v = sample[i];
    const ex = (v instanceof Date ? v.toLocaleDateString('es-ES') : String(v ?? '')).trim().slice(0, 18);
    return h ? `${h}${ex ? ' (' + ex + ')' : ''}` : `Columna ${i + 1}${ex ? ': ' + ex : ''}`;
  };
  const options = (sel) => ['<option value="-1">—</option>']
    .concat(Array.from({ length: ncols }, (_, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(colName(i))}</option>`))
    .join('');
  const map = $('#import-mapping');
  map.querySelector('[data-map="date"]').innerHTML = options(mapping.date);
  map.querySelector('[data-map="description"]').innerHTML = options(mapping.description[0] ?? -1);
  map.querySelector('[data-map="amount"]').innerHTML = options(mapping.amount);
  map.querySelector('[data-map="debit"]').innerHTML = options(mapping.debit);
  map.querySelector('[data-map="credit"]').innerHTML = options(mapping.credit);
  map.querySelector('[data-map="dateOrder"]').value = mapping.dateOrder;
}

function renderImportPreview() {
  renderImportMapping();
  $('#import-file').textContent = importJob.name;
  const { list, skipped, duplicates } = importItems();
  const chosen = list.filter((t) => t.include);
  const exp = chosen.filter((t) => t.type === 'expense');
  const inc = chosen.filter((t) => t.type === 'income');
  const transfers = list.filter((t) => t.transfer);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [`<strong>${plural(chosen.length, 'movimiento', 'movimientos')} para importar</strong>: ${plural(exp.length, 'gasto', 'gastos')} (${money(exp.reduce((a, t) => a + t.amount, 0))}) y ${plural(inc.length, 'ingreso', 'ingresos')} (${money(inc.reduce((a, t) => a + t.amount, 0))}).`];
  if (transfers.length) parts.push(`${plural(transfers.length, 'movimiento es un traspaso', 'movimientos son traspasos')} entre tus cuentas o inversiones (cambio de divisa, ahorro, recargas…): no son gasto ni ingreso y van sin marcar.`);
  if (duplicates) parts.push(`${duplicates} ya los tenías y no se repetirán.`);
  if (skipped) parts.push(`${skipped} filas sin fecha o importe se ignoran.`);
  if (!list.length && !duplicates) {
    parts.push('⚠️ No sale ningún movimiento: revisa qué columna es la fecha y cuál el importe.');
    $('#import-adv').open = true;
  }
  $('#import-summary').innerHTML = parts.join(' ');
  $('#import-transfers-row').classList.toggle('hidden', !transfers.length);
  $('#import-transfers').checked = transfers.length > 0 && transfers.every((t) => t.include);
  $('#import-confirm').disabled = !chosen.length;
  $('#import-confirm').textContent = chosen.length ? `Importar ${chosen.length}` : 'Importar';

  $('#import-table').innerHTML = `
    <thead><tr><th></th><th>Fecha</th><th>Concepto y categoría</th><th class="r">Importe</th></tr></thead>
    <tbody>${list.map((t) => {
      const c = CATEGORY_BY_ID[t.category];
      const color = t.type === 'income' ? 'var(--series-income)' : GROUPS[c.group].color;
      return `<tr class="${t.include ? '' : 'off'}">
        <td><input type="checkbox" data-idx="${t.idx}" ${t.include ? 'checked' : ''} aria-label="Importar este movimiento"></td>
        <td class="num">${t.date.slice(8, 10)}/${t.date.slice(5, 7)}/${t.date.slice(2, 4)}</td>
        <td class="desc"><div>${esc(t.description)}</div>${t.transfer
          ? `<span class="badge">↔ ${t.transfer}</span>`
          : `<span class="chip"><i class="dot" style="background:${color}"></i>${esc(c.label)}</span>`}</td>
        <td class="num r ${t.type === 'income' ? 'pos' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount, { decimals: 2 })}</td>
      </tr>`;
    }).join('')}</tbody>`;
}

$('#import-table').addEventListener('change', (e) => {
  const idx = e.target.dataset.idx;
  if (idx === undefined || !importJob) return;
  importJob.toggles[idx] = e.target.checked;
  renderImportPreview();
});

$('#import-transfers').addEventListener('change', (e) => {
  if (!importJob) return;
  for (const t of importItems().list) if (t.transfer) importJob.toggles[t.idx] = e.target.checked;
  renderImportPreview();
});

let namesTimer;
$('#import-names').addEventListener('input', (e) => {
  clearTimeout(namesTimer);
  namesTimer = setTimeout(() => {
    state.settings.ownNames = e.target.value.trim();
    save();
    if (importJob) renderImportPreview();
  }, 400);
});

$('#import-mapping').addEventListener('change', (e) => {
  const key = e.target.dataset.map;
  if (!key || !importJob) return;
  const mapping = importJob.sections[0];
  const v = key === 'dateOrder' ? e.target.value : Number(e.target.value);
  if (key === 'description') mapping.description = v >= 0 ? [v] : [];
  else mapping[key] = v;
  // Importe único o cargo/abono: elegir uno desactiva el otro.
  if (key === 'amount' && v >= 0) { mapping.debit = -1; mapping.credit = -1; }
  if ((key === 'debit' || key === 'credit') && v >= 0) mapping.amount = -1;
  importJob.toggles = {};
  renderImportPreview();
});
$('#import-invert').addEventListener('change', () => { if (importJob) { importJob.toggles = {}; renderImportPreview(); } });

$('#import-cancel').addEventListener('click', () => {
  importJob = null;
  $('#import-card').classList.add('hidden');
});

$('#import-confirm').addEventListener('click', () => {
  if (!importJob) return;
  const chosen = importItems().list.filter((t) => t.include);
  if (!chosen.length) return;
  // El navegador guarda unos 5 MB por web: mejor avisar que dejar de guardar sin querer.
  if (JSON.stringify(state).length + JSON.stringify(chosen).length > 4500000) {
    toast('Son demasiados movimientos para guardarlos en este navegador. Importa un periodo más corto.');
    return;
  }
  state.transactions.push(...chosen.map((t) => ({
    id: uid(), type: t.type, date: t.date, amount: t.amount, description: t.description, category: t.category,
  })));
  save();
  if (importJob.signature) {
    // Recuerda las columnas de este banco para la próxima vez.
    const maps = loadImportMaps();
    const { date, description, amount, debit, credit, dateOrder } = importJob.sections[0];
    maps[importJob.signature] = { date, description, amount, debit, credit, dateOrder, invert: $('#import-invert').checked };
    try { localStorage.setItem(IMPORT_MAPS_KEY, JSON.stringify(maps)); } catch (e) { /* sin almacenamiento */ }
  }
  const latest = chosen.map((t) => t.date).sort().pop();
  $('#list-month').value = latest.slice(0, 7);
  importJob = null;
  $('#import-card').classList.add('hidden');
  renderMovimientos();
  $('#tx-list').scrollIntoView({ behavior: 'smooth' });
  toast(`${chosen.length} movimientos importados y clasificados`);
});

// ---------- AHORRO ----------

function currentPace() {
  return savingsPace(state.transactions, {
    paceMonths: Number(state.settings.paceMonths),
    manualPace: state.settings.manualPace,
  }, new Date(localDate() + 'T12:00:00Z'));
}

/** Aportación mensual efectiva de cada objetivo: la fijada, o el reparto del ritmo sobrante. */
function goalAllocations(pace) {
  const fixed = state.goals.filter((g) => g.monthly !== '' && g.monthly != null && !(g.saved >= g.target));
  const auto = state.goals.filter((g) => (g.monthly === '' || g.monthly == null) && !(g.saved >= g.target));
  const fixedSum = fixed.reduce((a, g) => a + Number(g.monthly), 0);
  const remainder = Math.max(0, pace - fixedSum);
  const share = auto.length ? remainder / auto.length : 0;
  const map = {};
  for (const g of state.goals) {
    if (g.saved >= g.target) map[g.id] = { monthly: 0, auto: false };
    else if (g.monthly === '' || g.monthly == null) map[g.id] = { monthly: share, auto: true };
    else map[g.id] = { monthly: Number(g.monthly), auto: false };
  }
  return { map, fixedSum, autoCount: auto.length };
}

function renderAhorro() {
  const p = currentPace();
  const { map, fixedSum, autoCount } = goalAllocations(p.pace);
  const sourceText = {
    manual: 'Lo has fijado a mano en Ajustes.',
    history: `Media de ${p.months.map((m) => monthName(m, { month: 'short', year: '2-digit' })).join(', ')} (ingresos − gastos).`,
    current: 'Calculado con el mes en curso (aún no hay meses cerrados).',
    none: 'Aún no hay datos: añade ingresos y gastos, o fija un ritmo manual en Ajustes.',
  }[p.source];
  const totalSaved = state.goals.reduce((a, g) => a + Number(g.saved || 0), 0);
  $('#pace-box').innerHTML = `
    <div class="row gap wrap" style="justify-content:space-between">
      <div>
        <div class="muted small">Ahorras de media</div>
        <div class="pace-big ${p.pace < 0 ? 'neg' : ''}">${money(p.pace)}<span class="muted" style="font-size:1rem;font-weight:400"> / mes</span></div>
        <div class="muted small">${sourceText}</div>
      </div>
      <div>
        <div class="muted small">Acumulado en objetivos</div>
        <div class="pace-big">${money(totalSaved)}</div>
        <div class="muted small">≈ ${money(p.pace * 12)} al año a este ritmo</div>
      </div>
    </div>
    ${p.pace < 0 ? `<div class="note">⚠️ Estás gastando más de lo que ingresas. Con este ritmo no avanzarás hacia tus objetivos.</div>` : ''}
    ${fixedSum > p.pace && p.pace >= 0 ? `<div class="note">⚠️ Tus aportaciones fijas (${money(fixedSum)}/mes) superan tu ritmo real de ahorro (${money(p.pace)}/mes).</div>` : ''}
    ${autoCount > 1 ? `<div class="note">ℹ️ Los ${autoCount} objetivos sin aportación fija se reparten a partes iguales lo que te sobra de tu ritmo.</div>` : ''}
  `;

  const list = $('#goals-list');
  if (!state.goals.length) {
    list.innerHTML = `<div class="empty">Crea tu primer objetivo: un fondo de emergencia, la entrada de un piso, un viaje…</div>`;
  } else {
    list.innerHTML = state.goals.map((g) => goalCard(g, map[g.id])).join('');
  }

  renderWhatIf(map);
  renderProjection(map);
}

function goalCard(g, alloc) {
  const saved = Number(g.saved) || 0;
  const target = Number(g.target);
  const n = monthsToGoal(saved, target, alloc.monthly, g.annualReturn);
  const eta = Number.isFinite(n) ? monthName(addMonths(localMonth(), n)) : '—';
  let deadlineHtml = '';
  if (g.deadline && saved < target) {
    const left = monthsUntil(g.deadline, new Date(localDate() + 'T12:00:00Z'));
    const need = requiredMonthly(saved, target, left, g.annualReturn);
    const ok = n <= left;
    deadlineHtml = `<div class="status ${ok ? 'ok' : 'ko'}">${ok ? '✓ Llegas a tiempo' : '⚠ No llegas'} para ${monthName(g.deadline)}
      · necesitas ${money(need)}/mes${ok ? '' : ` (${money(need - alloc.monthly)} más)`}</div>`;
  }
  const progress = Math.min(1, saved / target);
  return `
    <div class="goal" data-id="${esc(g.id)}">
      <div class="goal-head">
        <div><span class="goal-title">${esc(g.name)}</span><span class="badge">${g.kind === 'inversion' ? '📈 Inversión' : '🐷 Ahorro'}</span>
          ${Number(g.annualReturn) ? `<span class="badge">${Number(g.annualReturn)}% anual</span>` : ''}</div>
        <div class="row gap">
          <button class="btn small" data-act="add">+ Aportar</button>
          <button class="btn small ghost" data-act="edit" aria-label="Editar">✏️</button>
          <button class="btn small ghost" data-act="del" aria-label="Borrar">🗑️</button>
        </div>
      </div>
      <div class="progress"><div style="width:${progress * 100}%"></div></div>
      <div class="row gap wrap small" style="justify-content:space-between">
        <span><strong>${money(saved)}</strong> de ${money(target)}</span><span class="muted">${pct(progress)}</span>
      </div>
      <div class="goal-stats">
        <div class="stat"><div class="label">Aportación mensual</div><div class="value">${money(alloc.monthly)}${alloc.auto ? ' <span class="muted small">(tu ritmo)</span>' : ''}</div></div>
        <div class="stat"><div class="label">Te falta</div><div class="value">${money(Math.max(0, target - saved))}</div></div>
        <div class="stat"><div class="label">Tiempo estimado</div><div class="value">${durationText(n)}</div></div>
        <div class="stat"><div class="label">Llegarías en</div><div class="value">${n === 0 ? '—' : eta}</div></div>
      </div>
      ${deadlineHtml}
    </div>`;
}

$('#new-goal').addEventListener('click', () => openGoalForm());
$('#goal-cancel').addEventListener('click', () => { $('#goal-form').classList.add('hidden'); editingGoalId = null; });

function openGoalForm(goal) {
  const f = $('#goal-form');
  f.reset();
  editingGoalId = goal ? goal.id : null;
  if (goal) {
    for (const k of ['name', 'kind', 'target', 'saved', 'monthly', 'annualReturn', 'deadline']) f.elements[k].value = goal[k] ?? '';
  }
  f.classList.remove('hidden');
  f.elements.name.focus();
}

$('#goal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const goal = {
    id: editingGoalId || uid(),
    name: f.name.value.trim().slice(0, 80),
    kind: f.kind.value,
    target: Number(f.target.value),
    saved: Number(f.saved.value) || 0,
    monthly: f.monthly.value === '' ? '' : Number(f.monthly.value),
    annualReturn: Number(f.annualReturn.value) || 0,
    deadline: f.deadline.value || '',
  };
  const previous = editingGoalId && state.goals.find((g) => g.id === editingGoalId);
  if (previous && previous.history) goal.history = previous.history;
  if (editingGoalId) state.goals = state.goals.map((g) => (g.id === editingGoalId ? goal : g));
  else state.goals.push(goal);
  editingGoalId = null;
  save();
  e.target.classList.add('hidden');
  renderAhorro();
  toast('Objetivo guardado');
});

$('#goals-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.goal').dataset.id;
  const g = state.goals.find((x) => x.id === id);
  if (btn.dataset.act === 'del') {
    if (!confirm(`¿Borrar el objetivo "${g.name}"?`)) return;
    state.goals = state.goals.filter((x) => x.id !== id);
  } else if (btn.dataset.act === 'edit') {
    openGoalForm(g);
    return;
  } else {
    const v = prompt(`¿Cuánto aportas a "${g.name}"? (usa negativo para retirar)`);
    if (v === null) return;
    const amt = parseAmount(v) || 0;
    if (!amt) return;
    g.saved = Math.round((Number(g.saved) + amt) * 100) / 100;
    g.history = [...(g.history || []), { date: localDate(), amount: amt }];
    toast(`${money(amt)} ${amt > 0 ? 'añadidos a' : 'retirados de'} ${g.name}`);
  }
  save();
  renderAhorro();
});

const whatif = $('#whatif');
whatif.addEventListener('input', () => renderWhatIf(goalAllocations(currentPace().pace).map));

function renderWhatIf(map) {
  const extra = Number(whatif.value);
  $('#whatif-label').textContent = `+${money(extra)}/mes`;
  const goals = state.goals.filter((g) => Number(g.saved) < Number(g.target));
  if (!goals.length) {
    $('#whatif-results').innerHTML = `<div class="empty">Añade un objetivo para simular.</div>`;
    return;
  }
  // El extra se reparte igual entre los objetivos pendientes.
  const each = extra / goals.length;
  $('#whatif-results').innerHTML = goals.map((g) => {
    const now = monthsToGoal(Number(g.saved), Number(g.target), map[g.id].monthly, g.annualReturn);
    const later = monthsToGoal(Number(g.saved), Number(g.target), map[g.id].monthly + each, g.annualReturn);
    const gain = Number.isFinite(now) && Number.isFinite(later) ? now - later : null;
    return `
      <div class="whatif-row">
        <strong>${esc(g.name)}</strong>
        <span>${durationText(now)} → <strong>${durationText(later)}</strong>
          ${gain ? `<span class="pos"> (${durationText(gain)} antes)</span>` : !Number.isFinite(now) && Number.isFinite(later) ? '<span class="pos"> (¡ahora sí llegas!)</span>' : ''}</span>
      </div>`;
  }).join('');
}

$('#projection-goal').addEventListener('change', () => renderProjection(goalAllocations(currentPace().pace).map));

function renderProjection(map) {
  const card = $('#projection-card');
  if (!state.goals.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const sel = $('#projection-goal');
  const prevVal = sel.value;
  sel.innerHTML = state.goals.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  sel.value = state.goals.some((g) => g.id === prevVal) ? prevVal : state.goals[0].id;
  const g = state.goals.find((x) => x.id === sel.value);
  const saved = Number(g.saved), target = Number(g.target), monthly = map[g.id].monthly;
  const n = monthsToGoal(saved, target, monthly, g.annualReturn);
  const horizon = Math.max(12, Math.min(Number.isFinite(n) ? Math.ceil(n * 1.15) : 120, 600));
  const series = projectSeries(saved, monthly, g.annualReturn, horizon);
  const contributed = series.map((_, i) => saved + monthly * i);

  const el = $('#projection-chart');
  const W = Math.max(300, el.clientWidth || 640), H = 260, padL = 56, padR = 12, padT = 16, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = niceMax(Math.max(target, ...series, 1));
  const minV = Math.min(0, ...series);
  const x = (i) => padL + (i / horizon) * plotW;
  const y = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
  const start = localMonth();

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Proyección de ${esc(g.name)}">`;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const v = minV + f * (maxV - minV);
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(${f === 0 ? '--axis' : '--grid'})"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  const yearStep = horizon > 120 ? 60 : horizon > 48 ? 12 : horizon > 24 ? 6 : 3;
  const labelStep = yearStep * Math.ceil((horizon / yearStep) / Math.max(2, Math.floor(plotW / 70)));
  for (let i = 0; i <= horizon; i += labelStep) {
    svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${monthName(addMonths(start, i), { month: 'short', year: '2-digit' })}</text>`;
  }
  // Objetivo
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(target)}" y2="${y(target)}" stroke="var(--text-2)" stroke-width="1"/>`;
  svg += `<text x="${padL + 6}" y="${y(target) - 6}" style="fill:var(--text-2)">Objetivo ${money(target)}</text>`;
  const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  if (Number(g.annualReturn)) {
    svg += `<path d="${line(contributed)}" fill="none" stroke="var(--muted)" stroke-width="2"/>`;
  }
  svg += `<path d="${line(series)}" fill="none" stroke="var(--series-projection)" stroke-width="2"/>`;
  if (Number.isFinite(n) && n > 0 && n <= horizon) {
    svg += `<circle cx="${x(n)}" cy="${y(series[n])}" r="5" fill="var(--series-projection)" stroke="var(--surface)" stroke-width="2"/>`;
    svg += `<text x="${x(n)}" y="${y(series[n]) + 18}" text-anchor="middle" style="fill:var(--text);font-weight:600">${monthName(addMonths(start, n), { month: 'short', year: 'numeric' })}</text>`;
  }
  svg += `<line id="xhair" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" stroke="var(--axis)" visibility="hidden"/>`;
  svg += `<rect id="proj-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
  svg += `</svg>`;
  const legend = `<div class="legend" style="margin-bottom:6px">
      <span class="key"><i style="background:var(--series-projection)"></i>Saldo proyectado${Number(g.annualReturn) ? ` (con ${Number(g.annualReturn)}% anual)` : ''}</span>
      ${Number(g.annualReturn) ? '<span class="key"><i style="background:var(--muted)"></i>Solo lo que aportas</span>' : ''}
      <span class="key muted">Aportando ${money(monthly)}/mes</span></div>`;
  el.innerHTML = legend + svg;

  const svgEl = el.querySelector('svg');
  const hit = el.querySelector('#proj-hit');
  const xhair = el.querySelector('#xhair');
  hit.addEventListener('pointermove', (e) => {
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(horizon, Math.round(((loc.x - padL) / plotW) * horizon)));
    xhair.setAttribute('x1', x(i)); xhair.setAttribute('x2', x(i));
    xhair.setAttribute('visibility', 'visible');
    const rows = [{ color: 'var(--series-projection)', value: money(series[i]), label: 'saldo' }];
    if (Number(g.annualReturn)) rows.push({ color: 'var(--muted)', value: money(contributed[i]), label: 'aportado' });
    showTip(e, monthName(addMonths(start, i)), rows);
  });
  hit.addEventListener('pointerleave', () => { xhair.setAttribute('visibility', 'hidden'); hideTip(); });
}

// ---------- CATEGORÍAS PROPIAS ----------

const catDialog = $('#cat-dialog');
const catForm = $('#cat-form');
let catDialogCtx = null; // { editing, onSave }

function usageCount(id) {
  return state.transactions.filter((t) => t.category === id).length;
}

function renderCategoryList() {
  const pill = (c) => {
    const n = usageCount(c.id);
    const count = n ? ` <span class="count">${n}</span>` : '';
    return `<span class="cat-pill ${c.custom || c.edited ? 'custom' : ''}">${esc(c.label)}${count}
      <button type="button" data-cat-edit="${esc(c.id)}" aria-label="Editar ${esc(c.label)}">✏️</button>
      ${c.custom ? `<button type="button" data-cat-del="${esc(c.id)}" aria-label="Borrar ${esc(c.label)}">🗑️</button>` : ''}</span>`;
  };
  const groups = Object.entries(GROUPS).map(([gid, g]) => `
    <div class="cat-group">
      <h3><i class="dot" style="background:${g.color}"></i>${esc(g.label)}</h3>
      <div class="cat-pills">${EXPENSE_CATEGORIES.filter((c) => c.group === gid).map(pill).join('')}</div>
    </div>`).join('');
  $('#cat-list').innerHTML = groups + `
    <div class="cat-group">
      <h3><i class="dot" style="background:var(--series-income)"></i>Ingresos</h3>
      <div class="cat-pills">${INCOME_CATEGORIES.map(pill).join('')}</div>
    </div>`;
}

function openCategoryDialog({ type = 'expense', editing = null, onSave = null } = {}) {
  catDialogCtx = { editing, onSave };
  catForm.reset();
  const kind = editing ? editing.type : type;
  catForm.querySelector(`input[name="type"][value="${kind}"]`).checked = true;
  // El tipo no se cambia al editar: los movimientos ya son gastos o ingresos.
  catForm.querySelectorAll('input[name="type"]').forEach((r) => { r.disabled = Boolean(editing); });
  $('#cat-type').classList.toggle('hidden', Boolean(editing));
  catForm.elements.group.innerHTML = Object.entries(GROUPS)
    .map(([gid, g]) => `<option value="${esc(gid)}">${esc(g.label)}</option>`).join('');
  catForm.elements.group.value = editing ? editing.group : 'otros';
  catForm.elements.label.value = editing ? editing.label : '';
  catForm.elements.keywords.value = editing ? (editing.keywords || []).map((k) => k.trim()).join(', ') : '';
  $('#cat-title').textContent = editing ? 'Editar categoría' : 'Nueva categoría';
  $('#cat-reset').classList.toggle('hidden', !(editing && editing.edited));
  syncCategoryTypeField();
  if (typeof catDialog.showModal === 'function') catDialog.showModal();
  else catDialog.setAttribute('open', '');
  catForm.elements.label.focus();
}

function closeCategoryDialog() {
  if (typeof catDialog.close === 'function') catDialog.close();
  else catDialog.removeAttribute('open');
  catDialogCtx = null;
}

function syncCategoryTypeField() {
  $('#cat-group-field').classList.toggle('hidden', catForm.elements.type.value === 'income');
}

catForm.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', syncCategoryTypeField));
$('#cat-cancel').addEventListener('click', closeCategoryDialog);
$('#new-cat').addEventListener('click', () => openCategoryDialog());

/** Lee las palabras clave del formulario conservando el formato de las de serie (p. ej. "bar " = palabra completa). */
function parseKeywords(text, original = []) {
  const byTrim = new Map(original.map((k) => [k.trim().toLowerCase(), k]));
  const words = text.split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
  // Palabras muy cortas solo cuentan como palabra completa ("bus" no debe casar con "abuso").
  return [...new Set(words)].map((k) => byTrim.get(k) || (k.length <= 3 ? k + ' ' : k));
}

/**
 * Cada palabra clave pertenece a una sola categoría: si otra del mismo tipo la
 * tenía, se la quita. Devuelve los nombres de las categorías afectadas.
 */
function claimKeywords(catId, type, keywords) {
  const mine = new Set(keywords.map((k) => k.trim()));
  const affected = [];
  const pool = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  for (const c of pool) {
    if (c.id === catId) continue;
    const kept = c.keywords.filter((k) => !mine.has(k.trim()));
    if (kept.length === c.keywords.length) continue;
    affected.push(c.label);
    if (c.custom) {
      state.settings.customCategories = state.settings.customCategories.map((x) => (x.id === c.id ? { ...x, keywords: kept } : x));
    } else {
      const overrides = { ...(state.settings.categoryOverrides || {}) };
      overrides[c.id] = { ...(overrides[c.id] || {}), keywords: kept };
      state.settings.categoryOverrides = overrides;
    }
  }
  return affected;
}

/**
 * Aplica un cambio de categorías y ofrece reclasificar los movimientos que
 * estaban clasificados automáticamente y ahora encajan en otra. Los que
 * cambiaste a mano no se tocan.
 */
function changeCategories(mutate) {
  const before = new Map(state.transactions.map((t) => [t.id, autoCategory(t.description, t.type)]));
  const result = mutate();
  refreshCategories();
  const moves = state.transactions.filter((t) => t.category === before.get(t.id) && autoCategory(t.description, t.type) !== t.category);
  if (moves.length) {
    const names = [...new Set(moves.map((t) => t.description))];
    const sample = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
    const msg = `Con este cambio, ${moves.length === 1 ? '1 movimiento encaja' : moves.length + ' movimientos encajan'} en otra categoría (${sample}). ¿Los reclasifico?`;
    if (confirm(msg)) for (const t of moves) t.category = autoCategory(t.description, t.type);
  }
  save();
  renderAll();
  return result;
}

catForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = catForm.elements;
  const { editing, onSave } = catDialogCtx || {};
  const type = editing ? editing.type : f.type.value;
  const label = f.label.value.trim().slice(0, 40);
  if (!label) return;
  const clash = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]
    .find((c) => c.label.toLowerCase() === label.toLowerCase() && (!editing || c.id !== editing.id));
  if (clash) { toast(`Ya existe una categoría "${clash.label}"`); return; }
  const original = editing && !editing.custom ? builtinCategory(editing.id) : null;
  const keywords = parseKeywords(f.keywords.value, original ? original.keywords : (editing ? editing.keywords : []));
  const group = type === 'income' ? undefined : f.group.value;
  const id = editing ? editing.id : 'c_' + uid();
  closeCategoryDialog();

  const affected = changeCategories(() => {
    if (original) {
      // Categoría de serie: se guarda solo lo que cambia respecto al original.
      const overrides = { ...(state.settings.categoryOverrides || {}) };
      const o = {};
      if (label !== original.label) o.label = label;
      if (group && group !== original.group) o.group = group;
      if (keywords.join('|') !== original.keywords.join('|')) o.keywords = keywords;
      if (Object.keys(o).length) overrides[id] = o; else delete overrides[id];
      state.settings.categoryOverrides = overrides;
    } else {
      const list = (state.settings.customCategories || []).filter((c) => c.id !== id);
      state.settings.customCategories = [...list, { id, label, type, group, keywords }];
    }
    refreshCategories();
    return claimKeywords(id, type, keywords);
  });

  const moved = affected.length ? `; esas palabras ya no están en ${affected.join(', ')}` : '';
  toast(editing ? `Categoría actualizada${moved}` : `Categoría "${label}" creada${moved}`);
  if (onSave) onSave(CATEGORY_BY_ID[id]);
});

$('#cat-reset').addEventListener('click', () => {
  const { editing } = catDialogCtx || {};
  if (!editing || editing.custom) return;
  closeCategoryDialog();
  changeCategories(() => {
    const overrides = { ...(state.settings.categoryOverrides || {}) };
    delete overrides[editing.id];
    state.settings.categoryOverrides = overrides;
  });
  toast(`"${CATEGORY_BY_ID[editing.id].label}" vuelve a ser como al principio`);
});

$('#cat-list').addEventListener('click', (e) => {
  const editId = e.target.closest('[data-cat-edit]')?.dataset.catEdit;
  const delId = e.target.closest('[data-cat-del]')?.dataset.catDel;
  const custom = state.settings.customCategories || [];
  if (editId) {
    const cat = CATEGORY_BY_ID[editId];
    if (cat) openCategoryDialog({ editing: { ...cat, type: INCOME_CATEGORIES.includes(cat) ? 'income' : 'expense' } });
    return;
  }
  if (!delId) return;
  const cat = custom.find((c) => c.id === delId);
  if (!cat) return;
  const n = usageCount(delId);
  const fallback = cat.type === 'income' ? 'otros_ing' : 'otros';
  const msg = n
    ? `¿Borrar "${cat.label}"? ${n === 1 ? 'Su movimiento pasará' : `Sus ${n} movimientos pasarán`} a "${CATEGORY_BY_ID[fallback].label}".`
    : `¿Borrar la categoría "${cat.label}"?`;
  if (!confirm(msg)) return;
  for (const t of state.transactions) if (t.category === delId) t.category = fallback;
  const rules = { ...(state.settings.rules || {}) };
  for (const [k, v] of Object.entries(rules)) if (v === delId) delete rules[k];
  state.settings.rules = rules;
  state.settings.customCategories = custom.filter((c) => c.id !== delId);
  save();
  renderAll();
  toast('Categoría borrada');
});

// ---------- AJUSTES ----------

function renderAjustes() {
  $('#set-currency').value = state.settings.currency;
  $('#set-pace-months').value = String(state.settings.paceMonths);
  $('#set-manual-pace').value = state.settings.manualPace;
}
$('#set-currency').addEventListener('change', (e) => { state.settings.currency = e.target.value; save(); toast('Moneda actualizada'); });
$('#set-pace-months').addEventListener('change', (e) => { state.settings.paceMonths = Number(e.target.value); save(); toast('Guardado'); });
$('#set-manual-pace').addEventListener('change', (e) => { state.settings.manualPace = e.target.value; save(); toast('Guardado'); });

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#export-json').addEventListener('click', () => {
  download(`mis-finanzas-${localDate()}.json`, JSON.stringify(state, null, 2), 'application/json');
  lsSet(BACKUP_KEY, String(Date.now()));
  renderBackupNote();
});
$('#export-csv').addEventListener('click', () => {
  const rows = [['fecha', 'tipo', 'grupo', 'categoria', 'descripcion', 'importe']];
  for (const t of [...state.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    const c = CATEGORY_BY_ID[t.category] || CATEGORY_BY_ID.otros;
    const group = t.type === 'income' ? '' : (GROUPS[c.group] || GROUPS.otros).label;
    rows.push([t.date, t.type === 'income' ? 'ingreso' : 'gasto', group, csvSafe(c.label), csvSafe(t.description), String(t.amount).replace('.', ',')]);
  }
  download('movimientos.csv', '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
});
$('#import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.transactions) || !Array.isArray(data.goals)) throw new Error('formato');
    if (!confirm('Esto reemplazará tus datos actuales por los de la copia. ¿Continuar?')) return;
    state = { ...cleanState(data), deleted: state.deleted };
    save();
    renderAll();
    toast('Copia restaurada');
  } catch (err) {
    toast('Ese archivo no parece una copia válida');
  } finally {
    e.target.value = '';
  }
});
$('#wipe').addEventListener('click', () => {
  if (!confirm('¿Seguro que quieres borrar TODOS tus datos? No se puede deshacer.')) return;
  state = { ...structuredClone(DEFAULT_STATE), deleted: state.deleted };
  lsDel(IMPORT_MAPS_KEY);
  if (isConnected()) lsSet(ROTATE_KEY, '1');
  save();
  renderAll();
  toast(isConnected() ? 'Datos borrados (también en Google Drive al sincronizar)' : 'Datos borrados');
});
$('#load-demo').addEventListener('click', () => {
  if (state.transactions.length && !confirm('Se añadirán datos de ejemplo a los tuyos. ¿Continuar?')) return;
  const demo = demoData();
  state.transactions.push(...demo.transactions);
  state.goals.push(...demo.goals);
  save();
  renderAll();
  toast('Datos de ejemplo cargados');
});

function demoData() {
  const tx = [];
  const add = (month, day, type, amount, description) => {
    const category = autoCategory(description, type);
    tx.push({ id: uid(), type, date: `${month}-${String(day).padStart(2, '0')}`, amount, description, category });
  };
  for (let i = 5; i >= 0; i--) {
    const m = addMonths(localMonth(), -i);
    const r = (base, spread) => Math.round((base + (Math.random() - 0.5) * spread) * 100) / 100;
    add(m, 1, 'income', 2350, 'Nómina');
    add(m, 1, 'expense', 850, 'Alquiler piso');
    add(m, 3, 'expense', r(62, 20), 'Iberdrola luz');
    add(m, 4, 'expense', 35, 'Digi fibra y móvil');
    add(m, 5, 'expense', r(95, 30), 'Mercadona');
    add(m, 12, 'expense', r(80, 30), 'Lidl compra semanal');
    add(m, 20, 'expense', r(70, 30), 'Mercadona');
    add(m, 2, 'expense', 21.8, 'Abono transporte metro');
    add(m, 6, 'expense', 12.99, 'Netflix');
    add(m, 6, 'expense', 34.9, 'Gimnasio');
    add(m, 9, 'expense', r(45, 30), 'Cena con amigos');
    add(m, 16, 'expense', r(28, 20), 'Cañas y tapas');
    add(m, 23, 'expense', r(18, 10), 'Cine');
    if (i % 2 === 0) add(m, 14, 'expense', r(60, 50), 'Zara');
    if (i === 3) { add(m, 10, 'expense', 142, 'Ryanair Madrid - Roma'); add(m, 11, 'expense', 310, 'Booking hotel Roma'); add(m, 18, 'expense', 85, 'Excursión Vaticano tour'); }
    if (i === 1) { add(m, 7, 'expense', 96, 'Vueling Barcelona'); add(m, 8, 'expense', 180, 'Airbnb Barcelona'); }
    if (i === 2) add(m, 25, 'income', 300, 'Freelance proyecto web');
  }
  return {
    transactions: tx,
    goals: [
      { id: uid(), name: 'Fondo de emergencia', kind: 'ahorro', target: 6000, saved: 2400, monthly: 200, annualReturn: 2, deadline: '' },
      { id: uid(), name: 'Viaje a Japón', kind: 'ahorro', target: 3500, saved: 600, monthly: '', annualReturn: 0, deadline: addMonths(localMonth(), 14) },
      { id: uid(), name: 'Cartera indexada', kind: 'inversion', target: 30000, saved: 5000, monthly: '', annualReturn: 6, deadline: '' },
    ],
  };
}

// ---------- NUBE (Google Drive) ----------

const OWNER_KEY = 'mf-owner';
const CONNECTED_KEY = 'mf-connected';
const SILENT_AT_KEY = 'mf-silent-at';
const PENDING_KEY = 'mf-pending';   // hay cambios locales que aún no se han subido a Drive
const ROTATE_KEY = 'mf-rotate';     // tras "Borrar todo": sustituir el archivo de Drive por uno nuevo
let verifiedToken = null;           // token cuya cuenta ya se ha comprobado en esta sesión
let syncSession = 0;                // cambia al cerrar sesión: una sincronización en vuelo se descarta
let syncDone = Promise.resolve();   // se resuelve cuando termina la sincronización en curso
let syncStatus = 'off';
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let driveFileId = null;
let lastSyncAt = null;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } }

function cloudOn() { return typeof Cloud !== 'undefined' && Cloud && Cloud.enabled(); }
function isConnected() { return lsGet(CONNECTED_KEY) === '1'; }

const SYNC_LABELS = {
  off: '☁️ Guardar en Google',
  syncing: '⟳ Sincronizando…',
  ok: '✓ Sincronizado',
  offline: '○ Sin conexión',
  reconnect: '⚠️ Reconectar',
  error: '⚠️ Reintentar',
};

function setSyncStatus(status) {
  syncStatus = status;
  if (status === 'ok') lastSyncAt = new Date();
  const pill = $('#sync-pill');
  pill.textContent = SYNC_LABELS[status];
  pill.dataset.status = status;
  pill.title = status === 'ok' && lastSyncAt ? `Última sincronización: ${lastSyncAt.toLocaleTimeString('es-ES')}` : '';
  renderAccount();
}

function renderAccount() {
  const box = $('#account-box');
  if (!box) return;
  const owner = lsGet(OWNER_KEY);
  if (!isConnected()) {
    box.innerHTML = `
      <p>Entra con tu cuenta de Google para guardar tus datos en tu Google Drive y verlos en todos tus dispositivos.
      Se guardan en una carpeta oculta de tu Drive que solo esta app puede usar; nadie más los ve.</p>
      <button class="btn primary" data-cloud="signin">Entrar con Google</button>
      ${state.transactions.length || state.goals.length ? '<p class="muted small">Los datos que ya tienes en este dispositivo se subirán a tu cuenta.</p>' : ''}`;
    return;
  }
  const statusText = {
    ok: `Sincronizado${lastSyncAt ? ' a las ' + lastSyncAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''}.`,
    syncing: 'Sincronizando…',
    offline: 'Sin conexión: los cambios se guardan aquí y se subirán al volver la conexión.',
    reconnect: 'La sesión de Google ha caducado. Tus cambios están a salvo en este dispositivo; reconecta para subirlos.',
    error: 'No se pudo sincronizar. Vuelve a intentarlo en un momento.',
    off: '',
  }[syncStatus];
  box.innerHTML = `
    <p>Conectada como <strong>${esc(owner || '')}</strong></p>
    <p class="muted small">${statusText}</p>
    <div class="row gap wrap">
      ${syncStatus === 'reconnect'
        ? '<button class="btn primary" data-cloud="reconnect">Reconectar con Google</button>'
        : '<button class="btn" data-cloud="sync">Sincronizar ahora</button>'}
      <button class="btn ghost" data-cloud="signout">Cerrar sesión</button>
    </div>
    <p class="muted small">¿Dispositivo compartido? Cierra sesión aquí al terminar y también en tu cuenta de Google del navegador; si no, quien lo use después podría abrir tus datos.</p>`;
}

function startSignIn(reconnect) {
  persistLocal();
  Cloud.signIn(reconnect ? { hint: lsGet(OWNER_KEY) || '' } : {});
}

function onCloudAction(action) {
  if (action === 'signin' || action === 'off') startSignIn(false);
  else if (action === 'reconnect') startSignIn(true);
  else if (action === 'sync' || action === 'error' || action === 'offline' || action === 'ok') syncNow();
  else if (action === 'signout') signOut();
}

$('#sync-pill').addEventListener('click', () => onCloudAction(syncStatus === 'reconnect' ? 'reconnect' : syncStatus));
$('#account-box').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cloud]');
  if (btn) onCloudAction(btn.dataset.cloud);
});

function scheduleSync() {
  if (!cloudOn() || !isConnected()) return;
  lsSet(PENDING_KEY, '1');
  if (!Cloud.token()) { setSyncStatus('reconnect'); return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1200);
}

async function syncNow() {
  if (!cloudOn() || !isConnected()) return;
  if (!Cloud.token()) { setSyncStatus('reconnect'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const session = syncSession;
  let release;
  syncDone = new Promise((r) => { release = r; });
  clearTimeout(syncTimer);
  setSyncStatus('syncing');
  const stillValid = () => session === syncSession;
  try {
    // Nunca se sube nada sin comprobar antes de quién es la cuenta de este token.
    if (!(await ensureAccount(session)) || !stillValid()) return;
    const remote = await Cloud.download();
    if (!stillValid()) return;
    // Lo que viene de Drive se valida igual que una copia restaurada.
    const remotes = remote.datas.filter(Boolean).map((d) => cleanState(d));
    // Normalmente hay un archivo; si hubiera varios, se juntan todos.
    let merged = state;
    for (const r of remotes) merged = mergeStates(merged, r);
    const localChanged = canonicalState(merged) !== canonicalState(state);
    replaceState(merged);
    if (localChanged) renderAll();
    if (remote.ids.length && (lsGet(ROTATE_KEY) || remote.ids.length > 1)) {
      // Tras "Borrar todo" (o si había varios archivos): uno nuevo, y se eliminan
      // TODOS los anteriores con sus versiones antiguas. Si algo falla, se reintenta.
      const newId = await Cloud.upload(null, state);
      driveFileId = newId;
      for (const id of remote.ids) if (id !== newId) await Cloud.remove(id);
    } else if (!remote.datas[0] || canonicalState(state) !== canonicalState(remote.datas[0])) {
      // Se compara con el archivo tal cual estaba: si al validarlo se corrigió algo
      // (p. ej. una fecha del futuro), se sube ya corregido para que no vuelva a cambiar.
      driveFileId = await Cloud.upload(remote.ids[0] || null, state);
    }
    if (!stillValid()) return;
    lsDel(ROTATE_KEY);
    if (!syncAgain) lsDel(PENDING_KEY);
    setSyncStatus('ok');
  } catch (e) {
    if (stillValid()) handleSyncError(e);
  } finally {
    syncing = false;
    release();
    const again = syncAgain && stillValid();
    syncAgain = false;
    if (again) syncNow();
  }
}

function handleSyncError(e) {
  if (e instanceof Cloud.AuthError) setSyncStatus('reconnect');
  else if (!navigator.onLine || e instanceof TypeError) setSyncStatus('offline');
  else { setSyncStatus('error'); console.error(e); }
}

/**
 * Comprueba a qué cuenta de Google pertenece el token actual antes de usarlo.
 * Si es otra cuenta distinta de la dueña de los datos de este dispositivo, pide
 * confirmación y no mezcla datos. Devuelve false si no se debe sincronizar.
 */
async function ensureAccount(session = syncSession) {
  const token = Cloud.token();
  if (!token) return false;
  if (verifiedToken === token) return true;
  const email = await Cloud.userEmail();
  if (session !== syncSession) return false;
  if (typeof email !== 'string' || !email) throw new Error('Cuenta de Google desconocida');
  const owner = lsGet(OWNER_KEY);
  if (owner && owner !== email) {
    const ok = confirm(`Los datos de este dispositivo son de ${owner} y has entrado como ${email}.\n\n`
      + `Si continúas, aquí se cargarán los datos de ${email}. Los de ${owner} siguen en su Google Drive `
      + '(salvo cambios que no se llegaran a sincronizar).');
    if (!ok) { Cloud.signOut(); verifiedToken = null; setSyncStatus('reconnect'); return false; }
    replaceState(structuredClone(DEFAULT_STATE), { overwrite: true });
    lsDel(PENDING_KEY);
    lsDel(ROTATE_KEY);
    renderAll();
  }
  lsSet(OWNER_KEY, email);
  lsSet(CONNECTED_KEY, '1');
  verifiedToken = token;
  return true;
}

async function onSignedIn() {
  const firstTime = !isConnected();
  // La primera vez se marca como conectada para que syncNow funcione; la cuenta se comprueba dentro.
  if (firstTime) lsSet(CONNECTED_KEY, '1');
  await syncNow();
  if (firstTime && syncStatus !== 'ok' && !lsGet(OWNER_KEY)) lsDel(CONNECTED_KEY);
  if (firstTime && syncStatus === 'ok') toast(`Conectada a Google como ${lsGet(OWNER_KEY)}`);
}

async function signOut() {
  if (!confirm('Se cerrará la sesión y se borrarán los datos de ESTE dispositivo. Seguirán guardados en tu Google Drive. ¿Continuar?')) return;
  toast('Cerrando sesión…');
  await syncDone;                      // si ya había una sincronización en marcha, se espera
  if (Cloud.token() && lsGet(PENDING_KEY)) { await syncNow(); await syncDone; }
  if (lsGet(PENDING_KEY) && !confirm('Hay cambios que todavía no se han subido a Google (lo último que apuntaste o un "Borrar todo"). '
    + 'Si cierras sesión ahora, se perderán. Para no perderlos, pulsa Cancelar y luego "Reconectar con Google".\n\n¿Cerrar sesión igualmente?')) return;
  syncSession++;                       // cualquier sincronización que quede en vuelo ya no escribe nada
  clearTimeout(syncTimer);
  Cloud.signOut();
  verifiedToken = null;
  for (const k of [OWNER_KEY, CONNECTED_KEY, PENDING_KEY, ROTATE_KEY, SILENT_AT_KEY, IMPORT_MAPS_KEY]) lsDel(k);
  replaceState(structuredClone(DEFAULT_STATE), { overwrite: true });
  setSyncStatus('off');
  renderAll();
  toast('Sesión cerrada. Si el dispositivo es compartido, cierra también tu sesión de Google en el navegador.');
}

async function initCloud() {
  if (!cloudOn()) return;
  $('#sync-pill').classList.remove('hidden');
  $('#account-card').classList.remove('hidden');
  const back = Cloud.handleRedirect();
  if (back && back.error && !['interaction_required', 'login_required', 'consent_required'].includes(back.error)) {
    toast(back.error === 'access_denied' ? 'Has cancelado el acceso a Google' : 'No se pudo conectar con Google');
  }
  if (Cloud.token()) {
    try { await onSignedIn(); } catch (e) { handleSyncError(e); }
    return;
  }
  if (!isConnected()) { setSyncStatus('off'); return; }
  // Sesión caducada: se intenta renovar sin pedir nada (como mucho una vez por minuto).
  const lastTry = Number(lsGet(SILENT_AT_KEY)) || 0;
  if (!back && navigator.onLine && Date.now() - lastTry > 60000) {
    lsSet(SILENT_AT_KEY, String(Date.now()));
    Cloud.signIn({ silent: true, hint: lsGet(OWNER_KEY) || '' });
    return;
  }
  setSyncStatus(navigator.onLine ? 'reconnect' : 'offline');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cloudOn() && isConnected()) syncNow();
});
window.addEventListener('online', () => { if (cloudOn() && isConnected()) syncNow(); });

// ---------- Arranque ----------

function refreshCategories() {
  setCustomCategories(state.settings.customCategories || [], state.settings.categoryOverrides || {});
}

function renderAll() {
  refreshCategories();
  // El desplegable del formulario recoge las categorías nuevas o borradas.
  fillCategorySelect(currentType(), txForm.elements.category.value);
  const active = document.querySelector('.view.active').id;
  if (active === 'view-resumen') renderResumen();
  if (active === 'view-anual') renderAnual();
  if (active === 'view-movimientos') renderMovimientos();
  if (active === 'view-ahorro') renderAhorro();
  if (active === 'view-ajustes') { renderAjustes(); renderCategoryList(); renderAccount(); }
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 150); });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Pide al navegador que no borre los datos de la app por falta de espacio o de uso.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
$('#backup-download').addEventListener('click', () => $('#export-json').click());
$('#backup-google').addEventListener('click', () => onCloudAction('signin'));

refreshCategories();
$('#list-month').value = localMonth();
resetTxForm();
renderAll();
initCloud();

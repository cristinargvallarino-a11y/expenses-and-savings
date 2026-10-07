// Interfaz: estado, renderizado de vistas y gráficos SVG.

const STORAGE_KEY = 'mis-finanzas-v1';

const DEFAULT_STATE = {
  settings: { currency: 'EUR', paceMonths: 3, manualPace: '' },
  transactions: [],
  goals: [],
};

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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed, settings: { ...DEFAULT_STATE.settings, ...parsed.settings } };
    }
  } catch (e) { /* almacenamiento no disponible: empezamos de cero */ }
  return structuredClone(DEFAULT_STATE);
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { toast('No se pudo guardar en este navegador. Descarga una copia en Ajustes.'); }
}

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

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
    hideTip();
    renderAll();
  });
});

$('#prev-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, -1); renderResumen(); });
$('#next-month').addEventListener('click', () => { viewMonth = addMonths(viewMonth, 1); renderResumen(); });

// ---------- RESUMEN ----------

function renderResumen() {
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
    <div class="hbar" data-group="${g.id}">
      <div class="name"><i class="dot" style="background:${g.color}"></i><span>${g.label}</span></div>
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
      <div class="hbar">
        <div class="name"><span>${c.id === 'vuelos' ? '🛫' : c.id === 'hoteles' ? '🏨' : '🧳'} ${c.label}</span></div>
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
      <div class="hbar">
        <div class="name"><i class="dot" style="background:${g.color}"></i><span>${c.label}</span></div>
        <div class="track"><div class="fill" style="width:${(amt / topMax) * 100}%;background:${g.color}"></div></div>
        <div class="val num">${money(amt)}</div>
      </div>`;
  }).join('') : `<div class="empty">Nada por aquí todavía.</div>`;

  renderTrend();
}

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
  const el = $('#trend-chart');
  const W = Math.max(300, el.clientWidth || 640), H = 240, padL = 52, padR = 8, padT = 10, padB = 26;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1));
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / months.length;
  const barW = Math.min(26, slot / 3);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ingresos y gastos de los últimos 6 meses">`;
  for (const t of ticks) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="var(${t === 0 ? '--axis' : '--grid'})" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = padL + slot * i + slot / 2;
    svg += barPath(cx - barW - 1, y(d.income), barW, padT + plotH - y(d.income), 'var(--series-income)');
    svg += barPath(cx + 1, y(d.expense), barW, padT + plotH - y(d.expense), 'var(--series-expense)');
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" style="${d.month === viewMonth ? 'fill:var(--text);font-weight:600' : ''}">${monthName(d.month, { month: 'short' })}</text>`;
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

// ---------- MOVIMIENTOS ----------

const txForm = $('#tx-form');

function fillCategorySelect(type, selected) {
  const sel = txForm.elements.category;
  if (type === 'income') {
    sel.innerHTML = INCOME_CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  } else {
    sel.innerHTML = Object.entries(GROUPS).map(([gid, g]) => `
      <optgroup label="${g.label}">
        ${EXPENSE_CATEGORIES.filter((c) => c.group === gid).map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}
      </optgroup>`).join('');
  }
  sel.value = selected || (type === 'income' ? 'nomina' : 'otros');
}

function currentType() { return txForm.elements.type.value; }

txForm.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
  categoryTouched = false;
  fillCategorySelect(currentType());
  autoClassify();
}));

function autoClassify() {
  if (categoryTouched) return;
  const guess = classify(txForm.elements.description.value, currentType());
  if (guess) {
    txForm.elements.category.value = guess;
    const c = CATEGORY_BY_ID[guess];
    $('#auto-hint').textContent = `· sugerida automáticamente${c.group ? ' (' + GROUPS[c.group].label + ')' : ''}`;
  } else {
    $('#auto-hint').textContent = '';
  }
}
txForm.elements.description.addEventListener('input', autoClassify);
txForm.elements.category.addEventListener('change', () => { categoryTouched = true; $('#auto-hint').textContent = ''; });

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
    description: f.description.value.trim(),
    category: f.category.value,
  };
  if (!(tx.amount > 0) || !tx.date) return;
  if (editingTxId) {
    state.transactions = state.transactions.map((t) => (t.id === editingTxId ? tx : t));
    toast('Movimiento actualizado');
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

$('#tx-cancel').addEventListener('click', resetTxForm);
$('#list-month').addEventListener('change', renderMovimientos);
$('#list-filter').addEventListener('change', renderMovimientos);

function renderMovimientos() {
  const month = $('#list-month').value || localMonth();
  const filter = $('#list-filter').value;
  const list = state.transactions
    .filter((t) => t.date.startsWith(month) && (filter === 'all' || t.type === filter))
    .sort((a, b) => b.date.localeCompare(a.date));
  const el = $('#tx-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">No hay movimientos en ${monthName(month)}.</div>`;
    return;
  }
  el.innerHTML = list.map((t) => {
    const c = CATEGORY_BY_ID[t.category] || CATEGORY_BY_ID.otros;
    const color = t.type === 'income' ? 'var(--series-income)' : GROUPS[c.group].color;
    const groupLabel = t.type === 'income' ? 'Ingreso' : GROUPS[c.group].label;
    return `
      <div class="tx" data-id="${t.id}">
        <div class="date num">${t.date.slice(8, 10)}/${t.date.slice(5, 7)}</div>
        <div class="desc">
          <div>${esc(t.description)}</div>
          <div class="chip"><i class="dot" style="background:${color}"></i>${groupLabel} · ${c.label}</div>
        </div>
        <div class="num ${t.type === 'income' ? 'pos' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount, { decimals: 2 })}</div>
        <div class="actions">
          <button data-act="edit" aria-label="Editar" title="Editar">✏️</button>
          <button data-act="del" aria-label="Borrar" title="Borrar">🗑️</button>
        </div>
      </div>`;
  }).join('');
  const inc = list.filter((t) => t.type === 'income').reduce((a, t) => a + t.amount, 0);
  const exp = list.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
  el.insertAdjacentHTML('beforeend', `<div class="row gap wrap top-gap small muted">${list.length} movimientos · Ingresos ${money(inc)} · Gastos ${money(exp)}</div>`);
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

// Importación CSV de extractos bancarios.
$('#csv-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const added = parseBankCsv(text);
  e.target.value = '';
  if (!added.length) { toast('No he encontrado movimientos en ese archivo'); return; }
  state.transactions.push(...added);
  save();
  $('#list-month').value = added[0].date.slice(0, 7);
  renderMovimientos();
  toast(`${added.length} movimientos importados y clasificados`);
});

function parseBankCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = [';', '\t', ','].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const out = [];
  for (const line of lines) {
    const cells = splitCsvLine(line, delim);
    let date = null, amount = null, desc = '';
    for (const raw of cells) {
      const c = raw.trim();
      if (!date) {
        let m = c.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
        if (m) { const yy = m[3].length === 2 ? '20' + m[3] : m[3]; date = `${yy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; continue; }
        m = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) { date = `${m[1]}-${m[2]}-${m[3]}`; continue; }
      }
      if (amount === null && /^[-+]?[\d.,\s]+(€|EUR)?$/i.test(c) && /\d/.test(c)) {
        amount = parseAmount(c);
        continue;
      }
      if (c.length > desc.length && /[a-zA-ZÀ-ÿ]/.test(c)) desc = c;
    }
    if (!date || amount === null || !amount || !desc) continue;
    const type = amount < 0 ? 'expense' : 'income';
    const category = classify(desc, type) || (type === 'income' ? 'otros_ing' : 'otros');
    out.push({ id: uid(), type, date, amount: Math.abs(amount), description: desc, category });
  }
  return out;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseAmount(s) {
  let c = s.replace(/[€\sEUR]/gi, '');
  if (c.includes(',') && c.lastIndexOf(',') > c.lastIndexOf('.')) c = c.replace(/\./g, '').replace(',', '.');
  else c = c.replace(/,/g, '');
  return parseFloat(c);
}

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
    <div class="goal" data-id="${g.id}">
      <div class="goal-head">
        <div><span class="goal-title">${esc(g.name)}</span><span class="badge">${g.kind === 'inversion' ? '📈 Inversión' : '🐷 Ahorro'}</span>
          ${Number(g.annualReturn) ? `<span class="badge">${g.annualReturn}% anual</span>` : ''}</div>
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
    name: f.name.value.trim(),
    kind: f.kind.value,
    target: Number(f.target.value),
    saved: Number(f.saved.value) || 0,
    monthly: f.monthly.value === '' ? '' : Number(f.monthly.value),
    annualReturn: Number(f.annualReturn.value) || 0,
    deadline: f.deadline.value || '',
  };
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
    const amt = parseAmount(v);
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
  sel.innerHTML = state.goals.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
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
      <span class="key"><i style="background:var(--series-projection)"></i>Saldo proyectado${Number(g.annualReturn) ? ` (con ${g.annualReturn}% anual)` : ''}</span>
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

$('#export-json').addEventListener('click', () => download(`mis-finanzas-${localDate()}.json`, JSON.stringify(state, null, 2), 'application/json'));
$('#export-csv').addEventListener('click', () => {
  const rows = [['fecha', 'tipo', 'grupo', 'categoria', 'descripcion', 'importe']];
  for (const t of [...state.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    const c = CATEGORY_BY_ID[t.category] || CATEGORY_BY_ID.otros;
    rows.push([t.date, t.type === 'income' ? 'ingreso' : 'gasto', t.type === 'income' ? '' : GROUPS[c.group].label, c.label, t.description, String(t.amount).replace('.', ',')]);
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
    state = { ...DEFAULT_STATE, ...data, settings: { ...DEFAULT_STATE.settings, ...data.settings } };
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
  state = structuredClone(DEFAULT_STATE);
  save();
  renderAll();
  toast('Datos borrados');
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
    const category = classify(description, type) || (type === 'income' ? 'otros_ing' : 'otros');
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

// ---------- Arranque ----------

function renderAll() {
  const active = document.querySelector('.view.active').id;
  if (active === 'view-resumen') renderResumen();
  if (active === 'view-movimientos') renderMovimientos();
  if (active === 'view-ahorro') renderAhorro();
  if (active === 'view-ajustes') renderAjustes();
}

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 150); });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

$('#list-month').value = localMonth();
resetTxForm();
renderAll();

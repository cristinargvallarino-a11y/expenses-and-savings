// Cálculos puros (sin DOM): resúmenes mensuales, ritmo de ahorro y objetivos.

const MAX_MONTHS = 1200; // 100 años: a partir de aquí lo consideramos "inalcanzable".

function monthKey(date) {
  return String(date).slice(0, 7);
}

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function monthSummary(transactions, month, categoryById) {
  const byGroup = {};
  const byCategory = {};
  let income = 0;
  let expense = 0;
  for (const t of transactions) {
    if (monthKey(t.date) !== month) continue;
    if (t.type === 'income') {
      income += t.amount;
    } else {
      expense += t.amount;
      const cat = categoryById[t.category] || categoryById.otros;
      byGroup[cat.group] = (byGroup[cat.group] || 0) + t.amount;
      byCategory[cat.id] = (byCategory[cat.id] || 0) + t.amount;
    }
  }
  const net = income - expense;
  return {
    month,
    income: round2(income),
    expense: round2(expense),
    net: round2(net),
    rate: income > 0 ? net / income : null,
    byGroup,
    byCategory,
  };
}

/**
 * Ritmo de ahorro mensual = media de (ingresos − gastos) de los últimos N meses
 * cerrados que tengan movimientos. Si aún no hay ningún mes cerrado con datos,
 * usa el mes en curso.
 */
function savingsPace(transactions, { paceMonths = 3, manualPace = null } = {}, today = new Date()) {
  if (manualPace !== null && manualPace !== '' && !Number.isNaN(Number(manualPace))) {
    return { pace: Number(manualPace), source: 'manual', months: [] };
  }
  const current = today.toISOString().slice(0, 7);
  const totals = {};
  for (const t of transactions) {
    const k = monthKey(t.date);
    totals[k] = totals[k] || { income: 0, expense: 0 };
    totals[k][t.type === 'income' ? 'income' : 'expense'] += t.amount;
  }
  const closed = Object.keys(totals).filter((k) => k < current).sort().reverse();
  let months = closed.slice(0, paceMonths);
  let source = 'history';
  if (months.length === 0 && totals[current]) {
    months = [current];
    source = 'current';
  }
  if (months.length === 0) return { pace: 0, source: 'none', months: [] };
  const sum = months.reduce((acc, k) => acc + totals[k].income - totals[k].expense, 0);
  return { pace: round2(sum / months.length), source, months: months.slice().reverse() };
}

function monthlyRate(annualReturnPct) {
  return Math.pow(1 + (Number(annualReturnPct) || 0) / 100, 1 / 12) - 1;
}

/** Saldo mes a mes, empezando en el mes 0 (= hoy). */
function projectSeries(current, monthly, annualReturnPct, months) {
  const r = monthlyRate(annualReturnPct);
  const out = [current];
  let v = current;
  for (let i = 1; i <= months; i++) {
    v = v * (1 + r) + monthly;
    out.push(v);
  }
  return out;
}

/** Meses hasta alcanzar el objetivo (0 si ya está). Infinity si no se llega nunca. */
function monthsToGoal(current, target, monthly, annualReturnPct) {
  if (current >= target) return 0;
  const r = monthlyRate(annualReturnPct);
  let v = current;
  for (let i = 1; i <= MAX_MONTHS; i++) {
    v = v * (1 + r) + monthly;
    if (v >= target) return i;
    if (monthly <= 0 && r <= 0) return Infinity;
  }
  return Infinity;
}

/** Aportación mensual necesaria para llegar a `target` en `months` meses. */
function requiredMonthly(current, target, months, annualReturnPct) {
  if (current >= target) return 0;
  if (months <= 0) return target - current;
  const r = monthlyRate(annualReturnPct);
  const grown = current * Math.pow(1 + r, months);
  if (r === 0) return (target - current) / months;
  const factor = (Math.pow(1 + r, months) - 1) / r;
  return Math.max(0, (target - grown) / factor);
}

/** Meses completos entre el mes actual y una fecha límite 'YYYY-MM'. */
function monthsUntil(deadline, today = new Date()) {
  const [y, m] = deadline.split('-').map(Number);
  return (y - today.getUTCFullYear()) * 12 + (m - 1 - today.getUTCMonth());
}

if (typeof module !== 'undefined') {
  module.exports = {
    monthKey, addMonths, monthSummary, savingsPace, projectSeries,
    monthsToGoal, requiredMonthly, monthsUntil, monthlyRate,
  };
}

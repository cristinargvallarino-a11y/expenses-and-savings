// Pruebas de la app en un navegador real (Chromium vía Playwright).
// Uso:  node tests/run.js            (todas)
//       node tests/run.js seguridad  (solo las que contienen esa palabra)
// No usan datos reales: los extractos de banco se generan aquí mismo.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./harness');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'finanzas-tests-'));
const XSS = '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const file = (name, content, enc = 'utf8') => { const p = path.join(TMP, name); fs.writeFileSync(p, Buffer.from(content, enc === 'latin1' ? 'latin1' : 'utf8')); return p; };
const pwned = (p) => p.evaluate(() => window.__pwned || 0);
const clean = (p) => { assert.deepStrictEqual(p.csp, [], 'CSP: ' + p.csp.join(' | ')); assert.deepStrictEqual(p.errs, [], 'errores: ' + p.errs.join(' | ')); };

// ---------- Extractos de ejemplo (inventados) ----------
const BANKS = {
  'ing.csv': ['Número de cuenta:;ES00 0000 0000 0000\nTitular:;Ana Ejemplo\n\nF. VALOR;CATEGORÍA;SUBCATEGORÍA;DESCRIPCIÓN;COMENTARIO;IMAGEN;IMPORTE (€);SALDO (€)\n05/10/2026;Alimentación;Super;Pago en MERCADONA VALENCIA;;;-45,30;1.954,70\n03/10/2026;Viajes;Avión;Pago en RYANAIR;;;-142,00;2.000,00\n01/10/2026;Nómina;Nómina;Nomina recibida EMPRESA SL;;;2.350,00;2.142,00\n', 3],
  'santander.csv': ['Fecha Operación;Fecha Valor;Concepto;Importe;Divisa;Saldo;Divisa\n06/10/2026;06/10/2026;Compra Tarjeta Booking.com Hotel Roma;-310,00;EUR;1.200,50;EUR\n04/10/2026;04/10/2026;Bizum de María cena;25,00;EUR;1.510,50;EUR\n02/10/2026;02/10/2026;Recibo Iberdrola Clientes;-62,14;EUR;1.485,50;EUR\n', 3, 'latin1'],
  'caixa.csv': ['Concepto;Fecha;Importe;Saldo\nGLOVO PEDIDO;8/10/2026;-18,40EUR;980,60EUR\nALQUILER PISO OCTUBRE;1/10/2026;-850,00EUR;999,00EUR\n', 2],
  'cargoabono.csv': ['Fecha;Concepto;Cargo;Abono;Saldo\n09/10/2026;Vueling Barcelona;96,00;;1.000,00\n10/10/2026;Devolución Amazon;;23,50;1.023,50\n', 2],
  'sinheader.csv': ['05/10/2026;MERCADONA VALENCIA;-45,30;1.234,56\n06/10/2026;CENA CON AMIGOS;-60,00;1.174,56\n07/10/2026;NOMINA;1.500,00;2.674,56\n', 3],
  'resumenes.csv': ['Fecha;Concepto;Importe\n01/10/2026;TOTALENERGIES EXPRESS MADRID;-60,00\n02/10/2026;Suma Supermercats;-12,30\n03/10/2026;Saldo final;1000,00\n04/10/2026;Total cargos;700,00\n05/10/2026;Saldo al 31/03;900,00\n', 2],
};
const REVOLUT = `"Cuentas corrientes Resúmenes",,,,,,,,
"Cuenta personal (EUR)",,,,,,,,
"Extracto de transacción",,,,,,,,
Fecha,Descripción,Categoría,"Entradas/salidas de dinero",Saldo,"Impuestos retenidos","Otros impuestos",Comisiones,
"1 sept 2026",Volaroil,Comercio,"-72,00€","208,45€","0,00€","0,00€","0,00€",
"2 sept 2026","Conversión a GBP",Cambio,"-0,95€","207,50€","0,00€","0,00€","0,00€",
"2 sept 2026",Mercadona,Comercio,"-25,73€","181,77€","0,00€","0,00€","0,00€",
"3 sept 2026",Uber,Comercio,"-12,40€","169,37€","0,00€","0,00€","0,00€",
"5 sept 2026","A EUR Cuenta Remunerada",Otras,"-100,00€","69,37€","0,00€","0,00€","0,00€",
"28 sept 2026","Pago de EMPRESA EJEMPLO, S.A.",Recargar,"1.683,29€","1.752,66€","0,00€","0,00€","0,00€",
"29 sept 2026","To Ana Ejemplo",Otras,"-50,00€","1.702,66€","0,00€","0,00€","0,00€",
Total,,,"1.410,21€",,"0,00€","0,00€","0,00€",
---------,,,,,,,,
"Cuenta personal (GBP)",,,,,,,,
"Extracto de transacción",,,,,,,,
Fecha,Descripción,Categoría,"Entradas/salidas de dinero","Entradas/salidas de dinero",Saldo,Saldo,Comisiones,Comisiones
"7 oct 2026",Booking.com,Comercio,"-44,34£","-52,34€","454,80£","536,83€","0,00£","0,00€"
---------,,,,,,,,
"Ahorros  (EUR)",,,,,,,,
"Extracto de transacciones (recibo de solo intereses)",,,,,,,,
Fecha,Descripción,TAE,TIN,"Gross interest","Impuestos retenidos","Other taxes",Fees,"Net interest"
13/9/26,"Interés neto",1.15%,1.15%,"0,01€","0,00€","0,00€","0,00€","0,01€"
16/9/26,"Interés neto",1.15%,1.15%,"0,02€","0,00€","0,00€","0,00€","0,02€"
`;

function xlsxFile() {
  const XLSX = require(path.join(H.ROOT, 'lib/xlsx.full.min.js'));
  const ws = XLSX.utils.aoa_to_sheet([
    ['Últimos movimientos'], ['Cuenta', 'ES00 0000'], [],
    ['F.Valor', 'Fecha', 'Concepto', 'Movimiento', 'Importe', 'Divisa', 'Disponible', 'Divisa', 'Observaciones'],
    [new Date(2026, 9, 8), new Date(2026, 9, 8), 'MERCADONA', 'Pago con tarjeta', -38.75, 'EUR', 1520.3, 'EUR', ''],
    [new Date(2026, 9, 6), new Date(2026, 9, 6), 'IBERIA', 'Pago con tarjeta', -210, 'EUR', 1559.05, 'EUR', 'Vuelo Lisboa'],
    [new Date(2026, 9, 1), new Date(2026, 9, 1), 'NOMINA EMPRESA', 'Transferencia', 2100, 'EUR', 1769.05, 'EUR', ''],
  ], { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
  const p = path.join(TMP, 'bbva.xlsx');
  fs.writeFileSync(p, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return p;
}

async function importFile(p, f) {
  await p.click('[data-view=movimientos]');
  await p.setInputFiles('#csv-input', f);
  await p.waitForSelector('#import-card:not(.hidden)');
}

// ================= FUNCIONAMIENTO =================

test('funcionamiento: pantallas, datos de ejemplo y móvil sin errores', async ({ b, app }) => {
  for (const [vp, scheme] of [[{ width: 1200, height: 900 }, 'light'], [{ width: 390, height: 844 }, 'dark']]) {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: vp, colorScheme: scheme });
    const p = await H.open(ctx, app);
    await p.click('[data-view=ajustes]'); await p.click('#load-demo');
    await H.visitAll(p);
    const q1 = await p.evaluate(() => { showView('resumen'); return document.querySelector('#quote').textContent; });
    await p.click('#prev-month');
    assert.notStrictEqual(q1, await p.textContent('#quote'), 'frase distinta por mes');
    assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'sin desbordes');
    clean(p); await ctx.close();
  }
});

test('funcionamiento: añadir, autoclasificar, editar y borrar', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await p.click('[data-view=movimientos]');
  await p.fill('#tx-form [name=description]', 'Ryanair Madrid-Roma');
  assert.strictEqual(await p.inputValue('#tx-form [name=category]'), 'vuelos');
  await p.fill('#tx-form [name=amount]', '99'); await p.click('#tx-submit');
  await p.click('#tx-list .tx >> nth=0 >> [data-act=edit]');
  await p.fill('#tx-form [name=amount]', '120'); await p.click('#tx-submit');
  assert.strictEqual((await H.stored(p)).transactions[0].amount, 120);
  await p.click('#tx-list .tx >> nth=0 >> [data-act=del]');
  assert.strictEqual((await H.stored(p)).transactions.length, 0);
  clean(p); await ctx.close();
});

test('funcionamiento: objetivos, aportar y editar conserva el historial', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  p.answer = (m) => (m.includes('¿Cuánto aportas') ? true : true);
  await p.click('[data-view=ahorro]'); await p.click('#new-goal');
  await p.fill('#goal-form [name=name]', 'Viaje a Japón'); await p.fill('#goal-form [name=target]', '3000');
  await p.click('#goal-form button[type=submit]');
  p.removeAllListeners('dialog'); p.on('dialog', (d) => d.accept('150'));
  await p.click('.goal [data-act=add]');
  await p.click('.goal [data-act=edit]'); await p.fill('#goal-form [name=name]', 'Japón'); await p.click('#goal-form button[type=submit]');
  const g = (await H.stored(p)).goals[0];
  assert.strictEqual(g.saved, 150); assert.strictEqual(g.history.length, 1); assert.strictEqual(g.name, 'Japón');
  clean(p); await ctx.close();
});

// ================= IMPORTAR =================

test('importar: bancos españoles (CSV, codificaciones, cargo/abono, sin cabecera, resúmenes)', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  let total = 0;
  for (const [name, [content, n, enc]] of Object.entries(BANKS)) {
    await importFile(p, file(name, content, enc));
    assert.strictEqual(await p.textContent('#import-confirm'), `Importar ${n}`, name + ': ' + await p.textContent('#import-summary'));
    await p.click('#import-confirm'); total += n;
  }
  const s = await H.stored(p);
  assert.strictEqual(s.transactions.length, total);
  assert.ok(s.transactions.some((t) => t.description.includes('María')), 'tildes en latin1');
  assert.strictEqual(s.transactions.find((t) => t.description.includes('Booking')).category, 'hoteles');
  await importFile(p, file('ing2.csv', BANKS['ing.csv'][0]));
  assert.ok(await p.isDisabled('#import-confirm'), 'duplicados');
  clean(p); await ctx.close();
});

test('importar: Excel en proceso aislado', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await importFile(p, xlsxFile());
  assert.strictEqual(await p.textContent('#import-confirm'), 'Importar 3');
  await p.click('#import-confirm');
  assert.strictEqual((await H.stored(p)).transactions.find((t) => t.description.includes('IBERIA')).date, '2026-10-06');
  clean(p); await ctx.close();
});

test('importar: extracto consolidado tipo Revolut (secciones, divisas, traspasos, intereses)', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await importFile(p, file('revolut.csv', REVOLUT));
  await p.fill('#import-names', 'Ana Ejemplo'); await p.waitForTimeout(600);
  await p.click('#import-confirm');
  const t = (await H.stored(p)).transactions;
  const d = t.map((x) => x.description);
  assert.ok(!d.includes('Conversión a GBP') && !d.includes('A EUR Cuenta Remunerada') && !d.includes('To Ana Ejemplo'), 'traspasos fuera');
  assert.strictEqual(t.find((x) => x.description === 'Booking.com').amount, 52.34, 'importe en euros');
  assert.strictEqual(t.find((x) => /EMPRESA/.test(x.description)).category, 'nomina');
  assert.ok(t.some((x) => x.category === 'rendimientos' && /Intereses/.test(x.description)), 'intereses agrupados');
  clean(p); await ctx.close();
});

// ================= CATEGORÍAS Y FILTROS =================

test('categorías: crear propia, editar de serie (Uber a Caprichos), restaurar y borrar', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await H.addTx(p, 'Uber centro', '9'); await H.addTx(p, 'Kiwoko pienso', '30');
  await p.click('[data-view=ajustes]'); await p.click('#new-cat');
  await p.fill('#cat-form [name=label]', 'Mascotas'); await p.selectOption('#cat-form [name=group]', 'necesarios');
  await p.fill('#cat-form [name=keywords]', 'kiwoko'); await p.click('#cat-form button[type=submit]');
  let s = await H.stored(p);
  const mascotas = s.settings.customCategories[0];
  assert.strictEqual(s.transactions.find((t) => /Kiwoko/.test(t.description)).category, mascotas.id);
  await p.click('[data-cat-edit="caprichos"]');
  await p.fill('#cat-form [name=keywords]', (await p.inputValue('#cat-form [name=keywords]')) + ', uber, taxi');
  await p.click('#cat-form button[type=submit]');
  s = await H.stored(p);
  assert.strictEqual(s.transactions.find((t) => /Uber/.test(t.description)).category, 'caprichos');
  await p.click('[data-cat-del="' + mascotas.id + '"]');
  assert.strictEqual((await H.stored(p)).transactions.find((t) => /Kiwoko/.test(t.description)).category, 'otros');
  await p.click('[data-cat-edit="caprichos"]'); await p.click('#cat-reset');
  assert.ok(!(await H.stored(p)).settings.categoryOverrides.caprichos?.keywords, 'restaurado');
  clean(p); await ctx.close();
});

test('filtros: categoría, grupo, búsqueda y desde el resumen', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await p.click('[data-view=ajustes]'); await p.click('#load-demo');
  await p.click('[data-view=movimientos]');
  await p.selectOption('#list-filter', 'c:supermercado');
  assert.ok((await p.$$('#tx-list .tx')).length > 0);
  await p.selectOption('#list-filter', 'all'); await p.fill('#list-search', 'netflix'); await p.check('#list-all-months'); await p.waitForTimeout(300);
  assert.strictEqual((await p.$$('#tx-list .tx')).length, 6);
  await p.click('[data-view=resumen]'); await p.click('#group-bars .hbar[data-filter="g:necesarios"]');
  assert.strictEqual(await p.inputValue('#list-filter'), 'g:necesarios');
  clean(p); await ctx.close();
});

// ================= SINCRONIZACIÓN =================

test('sincronización: dos dispositivos, renovación silenciosa, otro usuario, cerrar sesión', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  const A = await H.open(await H.context(b, app, cloud), app);
  await H.addTx(A, 'Gasto de A'); await A.click('#sync-pill'); await H.synced(A);
  const B = await H.open(await H.context(b, app, cloud), app);
  await B.click('[data-view=ajustes]'); await B.click('[data-cloud=signin]'); await H.synced(B);
  assert.strictEqual((await H.stored(B)).transactions[0].description, 'Gasto de A');
  await H.addTx(B, 'Gasto de B'); await B.waitForTimeout(1800); await H.synced(B);
  await A.reload(); await H.synced(A);
  assert.strictEqual((await H.stored(A)).transactions.length, 2);
  await A.evaluate(() => localStorage.setItem('mf-google-token', JSON.stringify({ token: 'x', exp: 1 })));
  cloud.log.length = 0; await A.reload(); await H.synced(A);
  assert.ok(cloud.log.includes('auth none'), 'renovación silenciosa');
  const C = await H.open(await H.context(b, app, { ...cloud, user: 'luis', drives: cloud.drives }), app);
  await C.click('#sync-pill'); await H.synced(C);
  assert.strictEqual((await H.stored(C)).transactions.length, 0, 'luis no ve datos de ana');
  await B.click('[data-view=ajustes]'); await B.click('[data-cloud=signout]');
  await B.waitForFunction(() => document.querySelector('#sync-pill').dataset.status === 'off');
  assert.strictEqual((await H.stored(B)).transactions.length, 0);
  clean(A); clean(B); clean(C);
});

// ================= SEGURIDAD =================

test('seguridad: nombre de categoría con código no se ejecuta y se limita a 40 caracteres', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await p.click('[data-view=ajustes]'); await p.click('#new-cat');
  await p.evaluate((x) => { const i = document.querySelector('#cat-form [name=label]'); i.removeAttribute('maxlength'); i.value = x; }, XSS);
  await p.selectOption('#cat-form [name=group]', 'viajes'); await p.click('#cat-form button[type=submit]');
  await H.visitAll(p); await p.reload(); await H.visitAll(p);
  assert.strictEqual(await pwned(p), 0);
  assert.ok((await H.stored(p)).settings.customCategories[0].label.length <= 40);
  clean(p); await ctx.close();
});

test('seguridad: copia manipulada se valida (ids, tipos, __proto__, grupos heredados)', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  const evil = {
    settings: { currency: 'EUR"><x>', rules: JSON.parse('{"__proto__":{"polluted":"yes"},"a":"constructor","ok":"supermercado"}'),
      customCategories: [{ id: 'c_x" onmouseover="x', label: 'a', type: 'expense', group: 'viajes' }, { id: 'c_ok', label: XSS, type: 'expense', group: 'viajes' }, { id: 'c_c', label: 'c', type: 'expense', group: 'constructor' }],
      categoryOverrides: { vuelos: { label: XSS }, vivienda: { group: '__proto__' } } },
    transactions: [
      { id: '"><img src=x onerror="window.__pwned=1">', type: 'expense', date: '2026-10-01', amount: 1, description: 'x', category: 'otros' },
      { id: 'good1', type: 'expense', date: '2026-10-02', amount: 12.5, description: XSS, category: 'c_ok' },
      { id: 'bad2', type: 'hack', date: '2026-10-02', amount: 1, description: 'x', category: 'otros' },
      { id: 'good2', type: 'expense', date: '2026-10-03', amount: 3, description: 'y', category: 'nomina' },
    ],
    goals: [{ id: 'g1', name: XSS, target: 100, saved: 10, annualReturn: '5" onmouseover="x', monthly: '', deadline: '"><x' }],
  };
  await p.click('[data-view=ajustes]'); await p.setInputFiles('#import-json', file('evil.json', JSON.stringify(evil)));
  await p.waitForTimeout(300); await H.visitAll(p);
  const s = await H.stored(p);
  assert.strictEqual(await pwned(p), 0);
  assert.strictEqual(await p.evaluate(() => ({}).polluted), undefined);
  assert.deepStrictEqual(s.transactions.map((t) => t.id).sort(), ['good1', 'good2']);
  assert.strictEqual(s.transactions.find((t) => t.id === 'good2').category, 'otros');
  assert.deepStrictEqual(s.settings.customCategories.map((c) => c.id), ['c_ok']);
  assert.deepStrictEqual(s.settings.rules, { ok: 'supermercado' });
  assert.strictEqual(s.settings.currency, 'EUR');
  clean(p); await ctx.close();
});

test('seguridad: CSP bloquea código inyectado y envíos a otras webs; CSV sin fórmulas; sin Google Fonts', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  await p.evaluate(() => { const d = document.createElement('div'); d.innerHTML = '<img src=x onerror="window.__pwned=99">'; document.body.appendChild(d); });
  await p.waitForTimeout(300);
  assert.strictEqual(await pwned(p), 0); assert.ok(p.csp.length > 0);
  assert.strictEqual(await p.evaluate(async () => { try { await fetch('https://example.com/x'); return 'sent'; } catch (e) { return 'blocked'; } }), 'blocked');
  p.csp.length = 0;
  await p.evaluate(() => { state.transactions.push({ id: 'f1', type: 'expense', date: '2026-10-05', amount: 9, description: '=HYPERLINK("http://ev.il")', category: 'otros' }); save(); });
  await p.click('[data-view=ajustes]');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#export-csv')]);
  assert.ok(fs.readFileSync(await dl.path(), 'utf8').includes(`"'=HYPERLINK`));
  const fonts = await p.evaluate(async () => { await document.fonts.ready; return [document.fonts.check('600 16px Fraunces'), performance.getEntriesByType('resource').filter((r) => /googleapis|gstatic/.test(r.name)).length]; });
  assert.ok(fonts[0]); assert.strictEqual(fonts[1], 0);
  clean(p); await ctx.close();
});

test('seguridad: Drive manipulado, cuenta equivocada, pendientes al cerrar sesión, Borrar todo', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  cloud.drives.ana = [{ id: 'f0', content: JSON.stringify({ settings: { customCategories: [{ id: 'c_z', label: XSS, type: 'expense', group: 'viajes' }] }, transactions: [{ id: 'x"><img src=x onerror="window.__pwned=7">', type: 'expense', date: '2026-10-01', amount: 1, description: 'x', category: 'otros' }, { id: 'ok1', type: 'expense', date: '2026-10-01', amount: 5, description: XSS, category: 'c_z' }], goals: [], deleted: {} }) }];
  const p = await H.open(await H.context(b, app, cloud), app);
  await p.click('#sync-pill'); await H.synced(p); await H.visitAll(p);
  assert.strictEqual(await pwned(p), 0);
  assert.deepStrictEqual((await H.stored(p)).transactions.map((t) => t.id), ['ok1']);
  // Otra cuenta y falla la comprobación del email: no se sube nada a esa cuenta
  await p.evaluate(() => { localStorage.removeItem('mf-google-token'); localStorage.setItem('mf-silent-at', String(Date.now())); });
  cloud.user = 'luis'; cloud.failUserinfo = true; cloud.log.length = 0;
  await p.reload(); await p.click('#sync-pill'); await p.waitForTimeout(1500);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(1500);
  assert.ok(!(cloud.drives.luis || []).length && !cloud.log.some((l) => /POST \/upload|PATCH/.test(l)));
  // Vuelve ana; cambio sin subir con la sesión caducada: avisa al cerrar sesión
  cloud.user = 'ana'; cloud.failUserinfo = false;
  await p.evaluate(() => localStorage.removeItem('mf-google-token')); await p.reload(); await p.click('#sync-pill'); await H.synced(p);
  await p.evaluate(() => localStorage.setItem('mf-google-token', JSON.stringify({ token: 'tok:ana', exp: 1 })));
  await H.addTx(p, 'Pendiente');
  await p.click('[data-view=ajustes]');
  p.answer = (m) => !/todavía no se han subido/.test(m);
  await p.click('[data-cloud=signout]'); await p.waitForTimeout(800);
  assert.ok(p.dialogs.some((m) => /todavía no se han subido/.test(m)));
  assert.ok((await H.stored(p)).transactions.some((t) => t.description === 'Pendiente'));
  // Borrar todo: archivo nuevo y el anterior eliminado
  p.answer = () => true;
  await p.evaluate(() => localStorage.removeItem('mf-google-token')); await p.reload(); await p.click('#sync-pill'); await H.synced(p);
  const before = cloud.drives.ana.map((f) => f.id);
  await p.click('[data-view=ajustes]'); await p.click('#wipe'); await p.waitForTimeout(2500);
  assert.strictEqual(cloud.drives.ana.length, 1); assert.ok(!before.includes(cloud.drives.ana[0].id));
  assert.strictEqual(JSON.parse(cloud.drives.ana[0].content).transactions.length, 0);
  // Cerrar sesión no deja nada
  await p.click('[data-cloud=signout]'); await p.waitForFunction(() => document.querySelector('#sync-pill').dataset.status === 'off');
  assert.deepStrictEqual(await p.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'mis-finanzas-v1')), []);
  assert.deepStrictEqual(p.csp, []);
});

// ================= INTEGRIDAD DE DATOS =================

test('integridad: dos pestañas no se pisan (altas y bajas)', async ({ b, app }) => {
  const ctx = await H.context(b, app); const t1 = await H.open(ctx, app); const t2 = await H.open(ctx, app);
  await H.addTx(t1, 'Pestaña 1'); await t2.waitForTimeout(300);
  await H.addTx(t2, 'Pestaña 2'); await t1.waitForTimeout(300);
  assert.deepStrictEqual((await H.stored(t1)).transactions.map((t) => t.description).sort(), ['Pestaña 1', 'Pestaña 2']);
  await t1.click('[data-view=resumen]'); await t1.click('[data-view=movimientos]');
  await t1.click('#tx-list .tx >> nth=0 >> [data-act=del]'); await t2.waitForTimeout(300);
  await H.addTx(t2, 'Otra'); assert.strictEqual((await H.stored(t2)).transactions.length, 2);
  clean(t1); clean(t2); await ctx.close();
});

test('integridad: inicio de sesión fallido en otra pestaña no borra datos', async ({ b, app }) => {
  const cloud = { ...H.fakeCloud('ana'), failUserinfo: true };
  const ctx = await H.context(b, app, cloud); const t1 = await H.open(ctx, app); const t2 = await H.open(ctx, app);
  await H.addTx(t1, 'Solo aquí'); await t2.waitForTimeout(300);
  await t2.click('#sync-pill'); await t2.waitForTimeout(2000);
  await t1.reload();
  assert.strictEqual((await H.stored(t1)).transactions.length, 1);
  await ctx.close();
});

test('integridad: cambio de cuenta en otra pestaña no lleva datos a la cuenta nueva', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  const ctx = await H.context(b, app, cloud); const t1 = await H.open(ctx, app);
  await H.addTx(t1, 'Dato de Ana'); await t1.click('#sync-pill'); await H.synced(t1);
  const t2 = await H.open(ctx, app); await H.synced(t2);
  await t2.evaluate(() => { localStorage.removeItem('mf-google-token'); localStorage.setItem('mf-silent-at', String(Date.now())); });
  cloud.user = 'luis'; await t2.reload(); await t2.click('#sync-pill'); await H.synced(t2);
  await t1.waitForTimeout(1500); await t1.waitForLoadState();
  await H.addTx(t1, 'Algo nuevo').catch(() => {}); await t1.waitForTimeout(2500);
  await t2.evaluate(() => syncNow()); await t2.waitForTimeout(1500);
  const luis = (cloud.drives.luis || []).flatMap((f) => JSON.parse(f.content).transactions.map((t) => t.description));
  assert.ok(!luis.includes('Dato de Ana'), luis.join(','));
  await ctx.close();
});

test('integridad: cerrar sesión durante una sincronización lenta no devuelve datos', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  const p = await H.open(await H.context(b, app, cloud), app);
  await H.addTx(p, 'Privado'); await p.click('#sync-pill'); await H.synced(p);
  cloud.delayMs = 2500;
  await p.click('[data-view=ajustes]');
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForTimeout(200);
  await p.click('[data-cloud=signout]');
  await p.waitForFunction(() => document.querySelector('#sync-pill').dataset.status === 'off', null, { timeout: 15000 });
  await p.waitForTimeout(3000);
  assert.strictEqual((await H.stored(p)).transactions.length, 0);
});

test('integridad: Borrar todo interrumpido se completa al reintentar; reglas no vuelven', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  const p = await H.open(await H.context(b, app, cloud), app);
  await H.addTx(p, 'Bizum a Maria deuda'); await p.evaluate(() => { state.settings.rules['bizum a maria deuda'] = 'bizum'; save(); });
  await p.click('#sync-pill'); await H.synced(p);
  const original = cloud.drives.ana[0].id;
  cloud.failDelete = 1;
  await p.click('[data-view=ajustes]'); await p.click('#wipe'); await p.waitForTimeout(2500);
  assert.ok(cloud.drives.ana.some((f) => f.id === original));
  await p.evaluate(() => syncNow()); await H.synced(p); await p.waitForTimeout(300);
  assert.strictEqual(cloud.drives.ana.length, 1); assert.ok(!cloud.drives.ana.some((f) => f.id === original));
  const remote = JSON.parse(cloud.drives.ana[0].content);
  assert.strictEqual(remote.transactions.length, 0);
  assert.deepStrictEqual(remote.settings.rules, {}, 'las reglas aprendidas no vuelven');
});

test('integridad: reloj adelantado en otro dispositivo; ajustes de dos dispositivos; pendientes durante sync', async ({ b, app }) => {
  const cloud = H.fakeCloud('ana');
  cloud.drives.ana = [{ id: 'f0', content: JSON.stringify({ settings: {}, transactions: [], goals: [], deleted: { gasto1: Date.now() + 365 * 86400000 } }) }];
  const A = await H.open(await H.context(b, app, cloud), app);
  await A.click('#sync-pill'); await H.synced(A);
  await A.click('[data-view=ajustes]');
  await A.setInputFiles('#import-json', file('restore.json', JSON.stringify({ settings: {}, goals: [], transactions: [{ id: 'gasto1', type: 'expense', date: '2026-10-01', amount: 42, description: 'Restaurado', category: 'otros' }] })));
  await A.waitForTimeout(2500); await A.evaluate(() => syncNow()); await H.synced(A); await A.waitForTimeout(300);
  assert.ok((await H.stored(A)).transactions.some((t) => t.id === 'gasto1'), 'restaurado sobrevive');
  const B = await H.open(await H.context(b, app, cloud), app);
  await B.click('#sync-pill'); await H.synced(B);
  await A.evaluate(() => { state.settings.customCategories.push({ id: 'c_m', label: 'Mascotas', type: 'expense', group: 'necesarios', keywords: [] }); state.settings.rules['acciona'] = 'caprichos'; stampChanges(); persistLocal(); });
  await B.evaluate(() => { state.settings.ownNames = 'Ana Ejemplo'; save(); }); await B.waitForTimeout(1800); await H.synced(B);
  await A.evaluate(() => syncNow()); await H.synced(A); await A.waitForTimeout(300);
  await B.evaluate(() => syncNow()); await H.synced(B); await B.waitForTimeout(300);
  for (const p of [A, B]) {
    const s = (await H.stored(p)).settings;
    assert.strictEqual(s.ownNames, 'Ana Ejemplo'); assert.ok(s.customCategories.some((c) => c.id === 'c_m')); assert.strictEqual(s.rules.acciona, 'caprichos');
  }
  cloud.delayMs = 1500;
  await A.evaluate(() => syncNow()); await A.waitForTimeout(300);
  await A.evaluate(() => { state.transactions.push({ id: 'durante1', type: 'expense', date: '2026-10-01', amount: 3, description: 'Durante', category: 'otros' }); save(); clearTimeout(syncTimer); });
  await H.synced(A); await A.waitForTimeout(300);
  assert.ok(await A.evaluate(() => localStorage.getItem('mf-pending')), 'sigue pendiente');
});

test('integridad: aviso de copia de seguridad sin Google', async ({ b, app }) => {
  const ctx = await H.context(b, app); const p = await H.open(ctx, app);
  assert.ok(await p.isHidden('#backup-note'));
  await H.addTx(p, 'Algo'); await p.click('[data-view=resumen]');
  assert.ok(await p.isVisible('#backup-note'));
  await Promise.all([p.waitForEvent('download'), p.click('#backup-download')]);
  await p.click('[data-view=resumen]');
  assert.ok(await p.isHidden('#backup-note'));
  clean(p); await ctx.close();
});

// ---------- Ejecución ----------
(async () => {
  const filter = process.argv[2];
  const { srv, url } = await H.serve();
  const b = await H.pw.chromium.launch();
  let failed = 0;
  for (const t of tests.filter((x) => !filter || x.name.includes(filter))) {
    const t0 = Date.now();
    try {
      await t.fn({ b, app: url });
      console.log(`✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      failed++;
      console.log(`✗ ${t.name}\n    ${String(e.message).split('\n').join('\n    ')}`);
    }
  }
  await b.close(); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? `\n${failed} prueba(s) fallida(s)` : '\nTodas las pruebas superadas');
  process.exit(failed ? 1 : 0);
})();

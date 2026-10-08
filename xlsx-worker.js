// Lee archivos Excel en un proceso aparte (Web Worker). La librería SheetJS
// 0.18.5 tiene fallos conocidos con archivos manipulados (CVE-2023-30533,
// CVE-2024-22363); aquí no pueden afectar a la app ni a tus datos: el worker no
// tiene acceso a la página ni al almacenamiento, y solo devuelve las celdas.
self.onmessage = (e) => {
  try {
    importScripts('lib/xlsx.full.min.js');
    const wb = XLSX.read(e.data, { type: 'array', cellDates: true });
    let best = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      if (rows.length > best.length) best = rows;
    }
    // Solo valores simples: texto, números, fechas y booleanos.
    const clean = best.slice(0, 50000).map((row) => (Array.isArray(row) ? row.slice(0, 200) : []).map((c) =>
      (c instanceof Date || typeof c === 'number' || typeof c === 'boolean') ? c : String(c ?? '').slice(0, 1000)));
    self.postMessage({ ok: true, rows: clean });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};

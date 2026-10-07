// Sincronización con Google Drive (carpeta oculta de la app, "appDataFolder").
//
// - Inicio de sesión por redirección (OAuth 2.0 para apps JavaScript): funciona
//   también en la app añadida a la pantalla de inicio del iPhone, donde las
//   ventanas emergentes no son fiables.
// - Los datos se guardan en un único JSON dentro de la carpeta oculta de la app
//   en el Drive del usuario: solo esta app puede leerlo o escribirlo.
// - mergeStates() junta los datos de dos dispositivos registro a registro.

/**
 * Junta dos estados. Por cada movimiento/objetivo gana la versión con
 * `updatedAt` más reciente; un registro borrado (en `deleted`, id → fecha)
 * desaparece salvo que se haya modificado después de borrarlo.
 */
function mergeStates(a, b) {
  a = a || {};
  b = b || {};
  const deleted = { ...(a.deleted || {}) };
  for (const [id, ts] of Object.entries(b.deleted || {})) {
    deleted[id] = Math.max(deleted[id] || 0, ts);
  }
  const mergeList = (la = [], lb = []) => {
    const byId = new Map();
    for (const r of [...la, ...lb]) {
      const prev = byId.get(r.id);
      if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(r.id, r);
    }
    return [...byId.values()].filter((r) => !(deleted[r.id] >= (r.updatedAt || 0)));
  };
  const settingsA = a.settings || {};
  const settingsB = b.settings || {};
  const settings = (settingsB.updatedAt || 0) > (settingsA.updatedAt || 0) ? settingsB : settingsA;
  return {
    settings,
    transactions: mergeList(a.transactions, b.transactions),
    goals: mergeList(a.goals, b.goals),
    deleted,
  };
}

/** Representación estable de un estado para saber si dos estados son iguales. */
function canonicalState(s) {
  const sortById = (list = []) => [...list].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const sortKeys = (o) => Object.fromEntries(Object.entries(o || {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  return JSON.stringify({
    settings: sortKeys(s.settings),
    transactions: sortById(s.transactions).map(sortKeys),
    goals: sortById(s.goals).map(sortKeys),
    deleted: sortKeys(s.deleted),
  });
}

const Cloud = (() => {
  if (typeof window === 'undefined') return null;

  const cfg = window.APP_CONFIG || {};
  const TOKEN_KEY = 'mf-google-token';
  const OAUTH_STATE_KEY = 'mf-oauth-state';
  const SCOPES = 'openid email https://www.googleapis.com/auth/drive.appdata';
  const FILE_NAME = 'mis-finanzas.json';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  class AuthError extends Error {}

  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* sin almacenamiento */ } }
  function del(key) { try { localStorage.removeItem(key); } catch (e) { /* sin almacenamiento */ } }

  function enabled() { return Boolean(cfg.googleClientId); }

  function redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  /** Lleva a la página de Google. `silent` intenta entrar sin pedir nada. */
  function signIn({ silent = false, hint = '' } = {}) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    set(OAUTH_STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state,
    });
    if (silent) params.set('prompt', 'none');
    else params.set('prompt', 'select_account');
    if (hint) params.set('login_hint', hint);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  }

  /**
   * Si venimos de la página de Google, recoge el token de la URL y la limpia.
   * Devuelve null si no venimos de Google, o { ok } / { error }.
   */
  function handleRedirect() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    const p = new URLSearchParams(hash);
    history.replaceState(null, '', location.pathname + location.search);
    const expected = get(OAUTH_STATE_KEY);
    del(OAUTH_STATE_KEY);
    if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
    if (p.get('error')) return { error: p.get('error') };
    const expiresIn = Number(p.get('expires_in')) || 3600;
    set(TOKEN_KEY, JSON.stringify({ token: p.get('access_token'), exp: Date.now() + (expiresIn - 60) * 1000 }));
    return { ok: true };
  }

  function token() {
    try {
      const t = JSON.parse(get(TOKEN_KEY));
      if (t && t.token && t.exp > Date.now()) return t.token;
    } catch (e) { /* token ilegible */ }
    return null;
  }

  async function api(url, opts = {}) {
    const t = token();
    if (!t) throw new AuthError('no_token');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    if (res.status === 401) {
      del(TOKEN_KEY);
      throw new AuthError('expired');
    }
    if (!res.ok) throw new Error(`Google respondió ${res.status}`);
    return res;
  }

  async function userEmail() {
    const res = await api('https://www.googleapis.com/oauth2/v3/userinfo');
    const info = await res.json();
    return info.email;
  }

  async function findFileId() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id)&orderBy=modifiedTime desc`);
    const { files } = await res.json();
    return files && files.length ? files[0].id : null;
  }

  /** Descarga los datos guardados en Drive. { id, data } (data null si aún no hay). */
  async function download() {
    const id = await findFileId();
    if (!id) return { id: null, data: null };
    const res = await api(`${DRIVE}/files/${id}?alt=media`);
    const text = await res.text();
    try { return { id, data: JSON.parse(text) }; }
    catch (e) { return { id, data: null }; }
  }

  async function upload(id, data) {
    const body = JSON.stringify(data);
    if (id) {
      await api(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      });
      return id;
    }
    const boundary = 'mf' + Date.now();
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
    });
    return (await res.json()).id;
  }

  function signOut() {
    const t = token();
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => {});
    del(TOKEN_KEY);
  }

  return { enabled, signIn, handleRedirect, token, userEmail, download, upload, signOut, AuthError };
})();

if (typeof module !== 'undefined') {
  module.exports = { mergeStates, canonicalState };
}

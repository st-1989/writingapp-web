/* 英作文ドリル Web 版の本体。
 *
 * 1. GitHub のリポジトリから app.py・index.html・data/ を読み込む（前回から変わったファイルだけ）。
 * 2. ブラウザの中の Python（Pyodide）に置いて app.py を import する。
 * 3. index.html を表示し、画面が呼ぶ fetch("/api/...") を app.py の Handler に渡す。
 * 4. app.py が data/ を書き換えたら、変わったファイルを GitHub の API で commit する。
 *
 * 電波がないときは、前回読み込んだ内容で動き、書き込みは送れるまで端末の中に溜めておく。
 * 衝突の扱いは PC 版と同じ: 記録（.jsonl）は行を合わせ、それ以外の JSON はこの端末の変更を優先する。
 */
"use strict";
// 画面（index.html）の変数と名前がぶつからないよう、全体を関数の中に閉じ込める
(() => {

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const REPO_ROOT = "/repo";                 // Pyodide の中でリポジトリを置く場所
const PUSH_DELAY_MS = 1500;                // 最後の書き込みからこの時間待って送る
const PULL_INTERVAL_MS = 5 * 60 * 1000;    // この間隔で他の端末の記録を取り込む
const origFetch = window.fetch.bind(window);

/* ------------------------------------------------------------------ 設定 */

function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem("writingapp.config") || "null");
    if (c && c.repo && c.token) return c;
  } catch (e) { /* 壊れていれば設定し直す */ }
  return null;
}
function saveConfig(c) { localStorage.setItem("writingapp.config", JSON.stringify(c)); }
let cfg = loadConfig();

/* ------------------------------------------------------ 端末の中の保存（IndexedDB） */

const store = (() => {
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("writingapp", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const req = fn(d.transaction("kv", mode).objectStore("kv"));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
  return {
    get: k => run("readonly", s => s.get(k)),
    set: (k, v) => run("readwrite", s => s.put(v, k)),
  };
})();

// snapshot: 最後に GitHub と一致していた内容 {branch, files: {path: {sha, text}}}
// pending : まだ送れていないこの端末の変更 {path: {text}}（text が null なら削除）
let snapshot = {branch: "", files: {}};
let pending = {};
const saveSnapshot = () => store.set(storeKey("snapshot"), snapshot);
const savePending = () => store.set(storeKey("pending"), pending);
const storeKey = name => `${cfg.repo}|${name}`;

/* ------------------------------------------------------------ GitHub の API */

const wanted = p => p === "app.py" || p === "index.html"
  || (p.startsWith("data/") && /\.(json|jsonl)$/.test(p));

function apiBase() { return (cfg.apiBase || "https://api.github.com").replace(/\/$/, ""); }
const encPath = p => p.split("/").map(encodeURIComponent).join("/");

async function gh(path, opts = {}) {
  return origFetch(apiBase() + path, {
    ...opts, cache: "no-store",
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? {"Content-Type": "application/json"} : {}),
    },
  });
}
async function ghJson(path, opts) {
  const r = await gh(path, opts);
  if (!r.ok) {
    let msg = "";
    try { msg = (await r.json()).message || ""; } catch (e) { /* 本文なし */ }
    const err = new Error(`GitHub ${r.status}: ${msg}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
async function blobText(sha) {
  const j = await ghJson(`/repos/${cfg.repo}/git/blobs/${sha}`);
  return b64ToText(j.content);
}

/* リモートの最新の内容を読む。変わったファイルだけ取りに行く。変わったパスの一覧を返す。 */
async function pull() {
  if (!snapshot.branch) {
    snapshot.branch = (await ghJson(`/repos/${cfg.repo}`)).default_branch;
  }
  const tree = await ghJson(
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(snapshot.branch)}?recursive=1`);
  const files = {};
  const jobs = [];
  for (const e of tree.tree) {
    if (e.type !== "blob" || !wanted(e.path)) continue;
    const prev = snapshot.files[e.path];
    if (prev && prev.sha === e.sha) { files[e.path] = prev; continue; }
    jobs.push(blobText(e.sha).then(text => { files[e.path] = {sha: e.sha, text}; }));
  }
  await Promise.all(jobs);
  const changed = new Set();
  for (const p of new Set([...Object.keys(files), ...Object.keys(snapshot.files)])) {
    if ((files[p] || {}).sha !== (snapshot.files[p] || {}).sha) changed.add(p);
  }
  snapshot = {branch: snapshot.branch, files};
  await saveSnapshot();
  return [...changed];
}

/* 記録ファイルは行の和をとる（同じ行は1つ）。時刻順に並べる。 */
function mergeJsonl(remoteText, localText) {
  const seen = new Set();
  const rows = [];
  for (const line of (remoteText + "\n" + localText).split("\n")) {
    const t = line.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    let ts = "";
    try { ts = JSON.parse(t).timestamp || ""; } catch (e) { /* 壊れた行も残す */ }
    rows.push({ts, t, i: rows.length});
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.i - b.i));
  return rows.map(r => r.t + "\n").join("");
}

async function latestRemote(path) {
  const r = await gh(`/repos/${cfg.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(snapshot.branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  return {sha: j.sha, text: await blobText(j.sha)};
}

async function putFile(path, text, sha) {
  return gh(`/repos/${cfg.repo}/contents/${encPath(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `記録を同期（${cfg.device}）`, branch: snapshot.branch,
      content: textToB64(text), ...(sha ? {sha} : {}),
    }),
  });
}
async function deleteFile(path, sha) {
  return gh(`/repos/${cfg.repo}/contents/${encPath(path)}`, {
    method: "DELETE",
    body: JSON.stringify({message: `記録を同期（${cfg.device}）`, branch: snapshot.branch, sha}),
  });
}

/* ------------------------------------------------------------ 送信と取り込み */

const sync = {ok: null, time: "", message: ""};
// fetch がネットワークの段階で失敗すると TypeError になる（GitHub の応答が返ったときは別のエラー）
const isOffline = e => navigator.onLine === false || e instanceof TypeError;
function setSync(ok, message) {
  sync.ok = ok;
  sync.message = message || "";
  sync.time = new Date().toTimeString().slice(0, 8);
}
function syncStatus() {
  const n = Object.keys(pending).length;
  const message = sync.message || (n ? `未送信のファイルが ${n} 件あります` : "");
  return {enabled: true, device: cfg.device, ok: n && sync.ok !== false ? null : sync.ok,
          time: sync.time, message};
}

let flushing = null, flushAgain = false, flushTimer = null;
function flushSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, PUSH_DELAY_MS);
}

async function flush() {
  if (flushing) { flushAgain = true; return flushing; }
  flushing = (async () => {
    try {
      for (const path of Object.keys(pending)) {
        const ch = pending[path];
        const remote = snapshot.files[path];
        if (ch.text === null) {                                   // 削除
          if (remote) {
            let r = await deleteFile(path, remote.sha);
            if (r.status === 409 || r.status === 422) {
              const latest = await latestRemote(path);
              r = latest ? await deleteFile(path, latest.sha) : {ok: true};
            }
            if (!r.ok && r.status !== 404) throw new Error(`削除に失敗（${r.status}）`);
          }
          delete snapshot.files[path];
          if (pending[path] === ch) delete pending[path];
          continue;
        }
        let text = path.endsWith(".jsonl") && remote ? mergeJsonl(remote.text, ch.text) : ch.text;
        let r = await putFile(path, text, remote && remote.sha);
        if (r.status === 409 || r.status === 422) {               // 他の端末が先に変えていた
          const latest = await latestRemote(path);
          if (latest && path.endsWith(".jsonl")) text = mergeJsonl(latest.text, ch.text);
          r = await putFile(path, text, latest && latest.sha);
        }
        if (!r.ok) {
          let msg = "";
          try { msg = (await r.json()).message || ""; } catch (e) { /* 本文なし */ }
          throw new Error(`送信に失敗（${r.status} ${msg}）`);
        }
        const j = await r.json();
        snapshot.files[path] = {sha: j.content.sha, text};
        if (pending[path] === ch) {
          delete pending[path];
          if (text !== ch.text) writeFs(path, text);              // 他の端末の行を取り込んだ
        }
      }
      setSync(true);
    } catch (e) {
      setSync(false, isOffline(e)
        ? "オフラインです。記録はこの端末に残り、つながったら送ります"
        : String(e.message || e));
    } finally {
      await saveSnapshot();
      await savePending();
      flushing = null;
      if (flushAgain) { flushAgain = false; flushSoon(); }
    }
  })();
  return flushing;
}

/* 取り込み: 他の端末の変更を Pyodide のファイルに反映する（この端末の未送信分は残す）。 */
let lastPull = 0;
async function pullAndApply() {
  try {
    await flush();
    const changed = await pull();
    for (const p of changed) {
      if (pending[p]) continue;
      if (snapshot.files[p]) writeFs(p, snapshot.files[p].text);
      else removeFs(p);
    }
    lastPull = Date.now();
    if (!Object.keys(pending).length) setSync(true);
  } catch (e) {
    setSync(false, isOffline(e)
      ? "オフラインです。前回読み込んだ内容で動いています" : String(e.message || e));
  }
}

/* ------------------------------------------------------------ Pyodide の中のファイル */

let py = null;
const fsPath = p => `${REPO_ROOT}/${p}`;
function writeFs(path, text) {
  const full = fsPath(path);
  py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
  py.FS.writeFile(full, text, {encoding: "utf8"});
}
function removeFs(path) {
  try { py.FS.unlink(fsPath(path)); } catch (e) { /* もとから無い */ }
}
function listFs(dir, out = []) {
  for (const name of py.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const full = `${dir}/${name}`;
    if (py.FS.isDir(py.FS.stat(full).mode)) listFs(full, out);
    else out.push(full.slice(REPO_ROOT.length + 1));
  }
  return out;
}
const currentText = p => (p in pending ? pending[p].text : (snapshot.files[p] || {}).text);

/* app.py が書き換えた data/ のファイルを見つけて、送る予定に入れる。 */
function collectChanges() {
  let any = false;
  const seen = new Set();
  for (const p of listFs(fsPath("data"))) {
    if (!wanted(p) || p === "data/log.csv") continue;
    seen.add(p);
    const text = py.FS.readFile(fsPath(p), {encoding: "utf8"});
    if (text !== currentText(p)) { pending[p] = {text}; any = true; }
  }
  for (const p of Object.keys(snapshot.files)) {
    if (p.startsWith("data/") && !seen.has(p) && currentText(p) !== null) {
      pending[p] = {text: null}; any = true;
    }
  }
  if (any) { savePending(); flushSoon(); }
}

const PY_BRIDGE = `
import io, json, os, sys
os.environ.update({"WRITINGAPP_DEVICE": DEVICE, "WRITINGAPP_NO_LLM": "1",
                   "WRITINGAPP_SYNC": "0", "WRITINGAPP_OPEN_BROWSER": "0"})
sys.path.insert(0, REPO_ROOT)
os.chdir(REPO_ROOT)
import app

def handle(method, path, body):
    h = object.__new__(app.Handler)
    h.path = path
    raw = body.encode("utf-8")
    h.headers = {"Content-Length": str(len(raw))}
    h.rfile = io.BytesIO(raw)
    out = {}
    def _json(obj, status=200):
        out["status"] = status
        out["body"] = json.dumps(obj, ensure_ascii=False)
    h._json = _json
    try:
        (h.do_GET if method == "GET" else h.do_POST)()
    except Exception as e:
        if "status" not in out:
            return 500, json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
    if "status" not in out:
        return 404, json.dumps({"error": "この端末では使えない機能です"}, ensure_ascii=False)
    return out["status"], out["body"]
`;

async function startPython() {
  if (!window.loadPyodide) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PYODIDE_URL + "pyodide.js";
      s.onload = res;
      s.onerror = () => rej(new Error("Python（Pyodide）を読み込めませんでした"));
      document.head.appendChild(s);
    });
  }
  return loadPyodide({indexURL: PYODIDE_URL});
}

/* 画面の fetch("/api/...") を app.py に渡す */
let pyHandle = null;
function installApi() {
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      return origFetch(input, init);
    }
    const method = (init.method || "GET").toUpperCase();
    const json = (obj, status = 200) => new Response(JSON.stringify(obj),
      {status, headers: {"Content-Type": "application/json; charset=utf-8"}});
    if (url.pathname === "/api/sync") {
      if (method === "POST") await pullAndApply();
      return json(syncStatus());
    }
    const body = typeof init.body === "string" ? init.body : "";
    const res = pyHandle(method, url.pathname + url.search, body);
    const [status, text] = res.toJs();
    res.destroy();
    if (method !== "GET") collectChanges();
    return new Response(text, {status, headers: {"Content-Type": "application/json; charset=utf-8"}});
  };
}

/* ------------------------------------------------------------ 起動 */

const $ = id => document.getElementById(id);
function show(id) {
  for (const x of ["loading", "setup"]) $(x).classList.toggle("hidden", x !== id);
}
function loadingMsg(t) { $("loadingMsg").textContent = t; }
function fail(msg) {
  $("loadErr").textContent = msg;
  for (const x of ["loadErr", "retryBtn", "resetBtn"]) $(x).classList.remove("hidden");
  document.querySelector(".spin").classList.add("hidden");
}

async function boot() {
  show("loading");
  try {
    const pyReady = startPython();
    snapshot = (await store.get(storeKey("snapshot"))) || {branch: "", files: {}};
    pending = (await store.get(storeKey("pending"))) || {};
    loadingMsg("GitHub から最新のデータを読み込んでいます…");
    try {
      await pull();
      setSync(true);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        throw new Error(`GitHub に入れませんでした（${e.message}）。リポジトリ名とトークンを確かめてください`);
      }
      if (!snapshot.files["app.py"]) {
        throw new Error("最初の1回は、インターネットにつないだ状態で開いてください。\n" + (e.message || e));
      }
      setSync(false, "オフラインです。前回読み込んだ内容で動いています");
    }
    lastPull = Date.now();
    if (!snapshot.files["app.py"] && !pending["app.py"]) {
      throw new Error("リポジトリに app.py が見つかりません");
    }

    loadingMsg("Python を準備しています…（初回は数十秒かかります）");
    py = await pyReady;
    py.FS.mkdirTree(REPO_ROOT);
    for (const p of new Set([...Object.keys(snapshot.files), ...Object.keys(pending)])) {
      const t = currentText(p);
      if (t !== null && t !== undefined) writeFs(p, t);
    }
    py.globals.set("DEVICE", cfg.device);
    py.globals.set("REPO_ROOT", REPO_ROOT);
    py.runPython(PY_BRIDGE);
    pyHandle = py.globals.get("handle");
    installApi();

    let html = currentText("index.html");
    html = html.replace(/(href|src)="\/assets\//g, '$1="assets/')
      .replace("<head>", '<head>\n<link rel="manifest" href="manifest.webmanifest">'
        + '<meta name="apple-mobile-web-app-capable" content="yes">'
        + '<meta name="apple-mobile-web-app-title" content="英作文ドリル">');
    document.open();
    document.write(html);
    document.close();

    // document.open で前のリスナーは消えるので、表示のあとに付ける
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
      else if (Date.now() - lastPull > 60 * 1000) pullAndApply();
    });
    window.addEventListener("online", () => pullAndApply());
    setInterval(pullAndApply, PULL_INTERVAL_MS);
    if (Object.keys(pending).length) flushSoon();
  } catch (e) {
    console.error(e);
    fail(String(e.message || e));
  }
}

function openSetup(err) {
  show("setup");
  $("repo").value = (cfg && cfg.repo) || "";
  $("token").value = "";
  $("device").value = (cfg && cfg.device) || (/android/i.test(navigator.userAgent) ? "android-web" : "ipad");
  $("setupErr").textContent = err || "";
  $("setupErr").classList.toggle("hidden", !err);
}

$("setup").addEventListener("submit", async ev => {
  ev.preventDefault();
  const repo = $("repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const token = $("token").value.trim() || (cfg && cfg.token) || "";
  const device = $("device").value.trim() || "ipad";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return openSetup("リポジトリは「ユーザー名/リポジトリ名」の形で入れてください");
  if (!token) return openSetup("アクセストークンを入れてください");
  if (!/^[A-Za-z0-9_-]+$/.test(device)) return openSetup("端末名は英数字・-・_ だけにしてください");
  $("setupBtn").disabled = true;
  const prev = cfg;
  cfg = {...(prev || {}), repo, token, device};
  try {
    await ghJson(`/repos/${repo}`);
  } catch (e) {
    cfg = prev;
    $("setupBtn").disabled = false;
    return openSetup(`リポジトリに接続できませんでした（${e.message}）`);
  }
  saveConfig(cfg);
  location.replace(location.pathname);
});
$("retryBtn").onclick = () => location.reload();
$("resetBtn").onclick = () => openSetup();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => { /* なくても動く */ });
}

if (!cfg || location.hash === "#setup") openSetup();
else boot();
})();

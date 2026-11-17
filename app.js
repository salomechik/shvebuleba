import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where, onSnapshot,
  writeBatch, addDoc, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import * as C from './calc.js';

// ───────── კონფიგურაცია ─────────
const firebaseConfig = {
  apiKey: 'AIzaSyDV4L_6WkUU_P6BOnCdJvhdBv5DfzbvxQY',
  authDomain: 'alisperi-shvebuleba.firebaseapp.com',
  projectId: 'alisperi-shvebuleba',
  storageBucket: 'alisperi-shvebuleba.firebasestorage.app',
  messagingSenderId: '485911632117',
  appId: '1:485911632117:web:78a64abd6e29376466cdbc',
};
const DOMAIN = 'alisperi.local';   // username → username@alisperi.local (ნამდვილი ელფოსტა არ არის)
const START_YEAR = 2027;           // აღრიცხვა იწყება 2027 წლის იანვრიდან
const DEFAULT_VACATION = 24;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// მეორე Auth — ადმინი ამით უქმნის ანგარიშებს სხვებს, ისე რომ თავად არ გამოვიდეს სისტემიდან
let secAuth = null;
function getSecAuth() {
  if (!secAuth) secAuth = initializeAuth(initializeApp(firebaseConfig, 'secondary'), { persistence: inMemoryPersistence });
  return secAuth;
}
async function createLogin(email, password) {
  const a = getSecAuth();
  const cred = await createUserWithEmailAndPassword(a, email, password);
  const uid = cred.user.uid;
  await signOut(a);
  return uid;
}

// ───────── მდგომარეობა ─────────
const S = {
  settings: null, user: null, map: null, me: null,
  employees: [], requests: [], unsub: [], settingUp: false,
  tab: 'requests', year: null, showOff: false,
  form: { type: 'vacation', sel: new Set(), month: null, comment: '' },
  teamMonth: null, holYear: null,
};
const app = document.getElementById('app');
const thisYear = () => Math.max(START_YEAR, new Date().getFullYear());
S.year = thisYear(); S.holYear = thisYear();
function years() { const out = []; for (let y = START_YEAR; y <= Math.max(START_YEAR + 1, new Date().getFullYear() + 1); y++) out.push(y); return out; }
function startMonth() {
  const t = C.todayIso();
  if (t < `${START_YEAR}-01-01`) return { y: START_YEAR, m: 1 };
  const { y, m } = C.parseIso(t); return { y, m };
}
S.form.month = startMonth(); S.teamMonth = startMonth();

// ───────── დამხმარე ─────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
}
function errText(e) {
  const c = e?.code || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'მომხმარებელი ან პაროლი არასწორია.';
  if (c.includes('too-many-requests')) return 'ძალიან ბევრი მცდელობა. სცადეთ რამდენიმე წუთში.';
  if (c.includes('weak-password')) return 'პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს.';
  if (c.includes('email-already-in-use')) return 'ეს username უკვე დაკავებულია.';
  if (c.includes('network')) return 'ინტერნეტთან კავშირი ვერ მოხერხდა.';
  if (c.includes('permission-denied')) return 'წვდომა არ გაქვთ.';
  console.error(e);
  return 'შეცდომა: ' + (e?.message || e);
}
function holidaysFor(y) { return S.settings?.holidays?.[y] || C.defaultHolidays(y); }
const hCache = new Map();
function hMap(y) {
  const list = holidaysFor(y); const key = y + JSON.stringify(list);
  if (!hCache.has(key)) hCache.set(key, C.holidayMap(list));
  return hCache.get(key);
}
function hName(d) { return hMap(+d.slice(0, 4)).get(d); }
function quotaFor(emp, type, y) {
  const o = emp?.quotas?.[y]?.[type];
  if (typeof o === 'number') return o;
  return type === 'vacation' ? (S.settings?.vacationDays ?? DEFAULT_VACATION) : (S.settings?.dayoffDays ?? 0);
}
function reqsOf(empId) { return S.requests.filter(r => r.empId === empId); }
function bal(emp, type, y) { return C.balance(reqsOf(emp.id), type, y, quotaFor(emp, type, y), hMap(y)); }
function workdays(r) { return C.countWorkdays(r.dates || [], hMap(+r.year)); }
const STATUS = { pending: 'მოლოდინში', approved: 'დადასტურდა', rejected: 'უარყოფილია', cancelled: 'გაუქმდა' };
function sortReqs(list) { return [...list].sort((a, b) => (b.dates?.[0] || '').localeCompare(a.dates?.[0] || '')); }
function yearSelect(id, val, list = years()) {
  return `<select id="${id}" style="width:auto">${list.map(y => `<option ${y === val ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
}
// ───────── Telegram შეტყობინებები ─────────
const SITE_URL = 'https://salomechik.github.io/shvebuleba/';
async function tgSend(token, chatId, text) {
  // form-urlencoded, რომ ბრაუზერმა preflight არ გააგზავნოს (Telegram მას არ უჭერს მხარს)
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    body: new URLSearchParams({ chat_id: String(chatId), text, disable_web_page_preview: 'true' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'Telegram error');
}
async function notifyAdmins(text) {
  try {
    const s = await getDoc(doc(db, 'settings', 'telegram'));
    const t = s.exists() ? s.data() : null;
    if (!t?.token || !t.chats?.length) return;
    await Promise.allSettled(t.chats.map(c => tgSend(t.token, c.id, text)));
  } catch (e) { console.warn('Telegram:', e); }
}
function stopAll() { S.unsub.forEach(u => u()); S.unsub = []; }

// ───────── კალენდარი (მონიშვნით) ─────────
// opts: { month:{y,m}, sel:Set, state(d)->{cls,title}, onChange(), minYM }
let drag = null;
window.addEventListener('pointermove', e => {
  if (!drag || e.pointerType === 'touch') return;
  const c = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.cal-d[data-d]');
  if (c && drag.host.contains(c)) drag.apply(c.dataset.d);
});
['pointerup', 'pointercancel'].forEach(ev => window.addEventListener(ev, () => { drag = null; }));

function calendar(host, opts) {
  const v = opts.month;
  const minYM = opts.minYM || { y: START_YEAR, m: 1 };
  const maxY = Math.max(...years());
  function build() {
    const { y, m } = v;
    const first = C.weekday(C.iso(y, m, 1));
    let h = `<div class="cal"><div class="cal-head">
      <button class="cal-nav" data-nav="-1" aria-label="წინა თვე">◀</button>
      <b>${C.MONTHS[m - 1]} ${y}</b>
      <button class="cal-nav" data-nav="1" aria-label="შემდეგი თვე">▶</button></div><div class="cal-grid">`;
    h += C.WEEKDAYS.map(w => `<div class="cal-wd">${w}</div>`).join('');
    for (let i = 0; i < first; i++) h += '<div class="cal-d empty"></div>';
    for (let d = 1; d <= C.daysInMonth(y, m); d++) h += `<div class="cal-d" data-d="${C.iso(y, m, d)}">${d}</div>`;
    h += `</div><div class="hol-tip"></div>
      <div class="legend"><span><i style="background:var(--red)"></i>მონიშნული</span>
      <span><i style="background:var(--ink)"></i>დადასტურებული</span>
      <span><i style="border:1.5px dashed var(--red)"></i>მოლოდინში</span>
      <span><i style="background:var(--off)"></i>დასვენება / უქმე</span></div></div>`;
    host.innerHTML = h;
    const prev = $('[data-nav="-1"]', host), next = $('[data-nav="1"]', host);
    prev.disabled = y * 12 + m <= minYM.y * 12 + minYM.m;
    next.disabled = y * 12 + m >= maxY * 12 + 12;
    [prev, next].forEach(b => { if (b.disabled) b.style.opacity = .3; });
    prev.onclick = () => { if (!prev.disabled) { shift(-1); } };
    next.onclick = () => { if (!next.disabled) { shift(1); } };
    const tip = $('.hol-tip', host);
    const grid = $('.cal-grid', host);
    grid.addEventListener('pointerover', e => {
      const c = e.target.closest('.cal-d[data-d]'); if (!c) return;
      tip.textContent = opts.state(c.dataset.d).title || '';
    });
    grid.addEventListener('pointerdown', e => {
      const c = e.target.closest('.cal-d[data-d]'); if (!c) return;
      const d = c.dataset.d; const st = opts.state(d);
      tip.textContent = st.title || '';
      if (st.cls) return;
      const mode = opts.sel.has(d) ? 'del' : 'add';
      const apply = x => {
        if (opts.state(x).cls) return;
        if (mode === 'add') opts.sel.add(x); else opts.sel.delete(x);
        paint(); opts.onChange();
      };
      apply(d);
      drag = { host, apply };
    });
    paint();
  }
  function shift(n) { let mm = v.m + n, yy = v.y; if (mm < 1) { mm = 12; yy--; } if (mm > 12) { mm = 1; yy++; } v.y = yy; v.m = mm; build(); }
  function paint() {
    const today = C.todayIso();
    $$('.cal-d[data-d]', host).forEach(c => {
      const d = c.dataset.d; const st = opts.state(d);
      c.className = 'cal-d' + (st.cls ? ' ' + st.cls : '') + (opts.sel.has(d) ? ' sel' : '') + (d === today ? ' today' : '');
      c.title = st.title || '';
    });
  }
  build();
  return { paint };
}

// დღის მდგომარეობა კონკრეტული თანამშრომლისთვის
function dayState(empId, d, allowPast = false, ignoreId = null) {
  if (d < `${START_YEAR}-01-01`) return { cls: 'off', title: 'აღრიცხვა იწყება ' + START_YEAR + ' წლიდან' };
  const hn = hName(d);
  if (hn) return { cls: 'off hol', title: `${C.fmtDate(d)} — ${hn} (უქმე დღე)` };
  if (C.weekday(d) >= 5) return { cls: 'off', title: `${C.fmtDate(d)} — დასვენების დღე` };
  for (const r of reqsOf(empId)) {
    if (r.id === ignoreId || !(r.dates || []).includes(d)) continue;
    if (r.status === 'approved') return { cls: 'appr', title: `${C.fmtDate(d)} — ${C.TYPES[r.type]}, დადასტურებული` };
    if (r.status === 'pending') return { cls: 'pend', title: `${C.fmtDate(d)} — ${C.TYPES[r.type]}, მოლოდინში` };
  }
  if (!allowPast && d < C.todayIso()) return { cls: 'past', title: 'წარსული დღე' };
  return { cls: '', title: '' };
}

// ───────── ჩატვირთვა ─────────
onAuthStateChanged(auth, async user => {
  if (S.settingUp) return;
  stopAll();
  S.user = user; S.map = null; S.me = null; S.requests = []; S.employees = [];
  document.getElementById('who').classList.add('hidden');
  try {
    const cfg = await getDoc(doc(db, 'settings', 'config'));
    S.settings = cfg.exists() ? cfg.data() : null;
    if (!S.settings) { if (user) await signOut(auth); return renderSetup(); }
    if (!user) return renderLogin();
    const m = await getDoc(doc(db, 'uidmap', user.uid));
    if (!m.exists()) { await signOut(auth); return renderLogin('ეს ანგარიში გამორთულია. მიმართეთ ადმინისტრატორს.'); }
    S.map = m.data();
    startListeners();
  } catch (e) { app.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});

function startListeners() {
  const isAdmin = S.map.role === 'admin';
  let ready = { settings: false, me: false, reqs: false, emps: !isAdmin };
  const go = () => { if (Object.values(ready).every(Boolean)) render(); };
  S.unsub.push(onSnapshot(doc(db, 'settings', 'config'), s => { S.settings = s.data() || S.settings; ready.settings = true; go(); }));
  S.unsub.push(onSnapshot(doc(db, 'employees', S.map.empId), s => {
    S.me = { id: s.id, ...s.data() }; ready.me = true;
    const w = document.getElementById('who');
    document.getElementById('whoName').textContent = S.me.name + (isAdmin ? ' · ადმინი' : '');
    w.classList.remove('hidden'); go();
  }, e => app.innerHTML = `<p class="err">${esc(errText(e))}</p>`));
  const rq = isAdmin ? collection(db, 'requests') : query(collection(db, 'requests'), where('empId', '==', S.map.empId));
  S.unsub.push(onSnapshot(rq, s => { S.requests = s.docs.map(d => ({ id: d.id, ...d.data() })); ready.reqs = true; go(); },
    e => app.innerHTML = `<p class="err">${esc(errText(e))}</p>`));
  if (isAdmin) S.unsub.push(onSnapshot(collection(db, 'employees'), s => {
    S.employees = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'ka'));
    ready.emps = true; go();
  }));
}
document.getElementById('logout').onclick = () => signOut(auth);

// ───────── პირველი გაშვება: ადმინის შექმნა ─────────
function renderSetup() {
  app.innerHTML = `<div class="login"><div class="card">
    <h2>პირველი გაშვება</h2>
    <p class="muted small">შექმენით ადმინისტრატორის ანგარიში. ეს გვერდი მხოლოდ ერთხელ გამოჩნდება.</p>
    <label class="f">სახელი და გვარი<input type="text" id="sName" autocomplete="name"></label>
    <label class="f">Username (ლათინურად)<input type="text" id="sUser" autocapitalize="off" autocomplete="username"></label>
    <label class="f">პაროლი (მინ. 6 სიმბოლო)<input type="password" id="sPw" autocomplete="new-password"></label>
    <label class="f">გაიმეორეთ პაროლი<input type="password" id="sPw2" autocomplete="new-password"></label>
    <label class="row small"><input type="checkbox" id="sTrack" checked> ადმინის შვებულებებიც აღირიცხოს</label>
    <div class="err" id="sErr"></div>
    <button class="btn" id="sGo" style="width:100%">შექმნა</button></div></div>`;
  $('#sGo').onclick = async () => {
    const name = $('#sName').value.trim(), u = $('#sUser').value.trim().toLowerCase(), pw = $('#sPw').value;
    const err = $('#sErr'); err.textContent = '';
    if (!name) return err.textContent = 'ჩაწერეთ სახელი.';
    if (!/^[a-z0-9._-]{3,30}$/.test(u)) return err.textContent = 'Username: 3–30 ლათინური ასო, ციფრი, წერტილი ან ტირე.';
    if (pw.length < 6) return err.textContent = 'პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს.';
    if (pw !== $('#sPw2').value) return err.textContent = 'პაროლები არ ემთხვევა.';
    $('#sGo').disabled = true; S.settingUp = true;
    try {
      const email = `${u}@${DOMAIN}`;
      let cred;
      try { cred = await createUserWithEmailAndPassword(auth, email, pw); }
      catch (x) { if (String(x?.code).includes('email-already-in-use')) cred = await signInWithEmailAndPassword(auth, email, pw); else throw x; }
      const uid = cred.user.uid;
      const empRef = doc(collection(db, 'employees'));
      const b = writeBatch(db);
      b.set(doc(db, 'uidmap', uid), { empId: empRef.id, role: 'admin' });
      b.set(empRef, { name, username: u, uid, role: 'admin', active: true, track: $('#sTrack').checked, createdAt: serverTimestamp() });
      b.set(doc(db, 'logins', u), { email });
      b.set(doc(db, 'settings', 'config'), { vacationDays: DEFAULT_VACATION, dayoffDays: 0, startYear: START_YEAR, createdAt: serverTimestamp() });
      await b.commit();
      S.settingUp = false;
      location.reload();
    } catch (e) { S.settingUp = false; $('#sGo').disabled = false; err.textContent = errText(e); }
  };
}

// ───────── შესვლა ─────────
function renderLogin(msg = '') {
  app.innerHTML = `<form class="login" id="lf"><div class="card">
    <h2>შესვლა</h2>
    <label class="f">Username<input type="text" id="lUser" autocapitalize="off" autocomplete="username" required></label>
    <label class="f">პაროლი<input type="password" id="lPw" autocomplete="current-password" required></label>
    <div class="err" id="lErr">${esc(msg)}</div>
    <button class="btn" style="width:100%">შესვლა</button>
    <p class="muted small">პაროლი თუ დაგავიწყდათ, მიმართეთ ადმინისტრატორს.</p></div></form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const u = $('#lUser').value.trim().toLowerCase(), pw = $('#lPw').value;
    const err = $('#lErr'); err.textContent = '';
    try {
      const l = await getDoc(doc(db, 'logins', u));
      if (!l.exists()) return err.textContent = 'მომხმარებელი ან პაროლი არასწორია.';
      await signInWithEmailAndPassword(auth, l.data().email, pw);
    } catch (e2) { err.textContent = errText(e2); }
  };
}

// ───────── მთავარი ─────────
function render() {
  if (S.map.role !== 'admin') return renderMine(app, S.me);
  const pend = S.requests.filter(r => r.status === 'pending').length;
  const tabs = [['requests', `მოთხოვნები${pend ? ` <span class="cnt">${pend}</span>` : ''}`], ['team', 'კალენდარი'], ['emps', 'თანამშრომლები'], ['settings', 'პარამეტრები']];
  if (S.me.track) tabs.splice(1, 0, ['mine', 'ჩემი შვებულება']);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'requests';
  app.innerHTML = `<nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</nav><div id="pane"></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  const pane = $('#pane');
  ({ requests: renderRequests, mine: p => renderMine(p, S.me), team: renderTeam, emps: renderEmps, settings: renderSettings })[S.tab](pane);
}

// ───────── თანამშრომლის გვერდი ─────────
function balCard(emp, type, y) {
  const b = bal(emp, type, y);
  if (b.quota <= 0 && type === 'dayoff') return `<div class="card bal"><span class="lbl">დეი ოფი · ${y}</span><span class="muted">რაოდენობა ჯერ არ არის განსაზღვრული.</span></div>`;
  const pu = b.quota ? Math.min(100, b.used / b.quota * 100) : 0, pp = b.quota ? Math.min(100 - pu, b.pending / b.quota * 100) : 0;
  return `<div class="card bal"><span class="lbl">${C.TYPES[type]} · ${y}</span>
    <span class="big">${b.left}<small>დარჩენილი დღე</small></span>
    <div class="bar"><i class="u" style="width:${pu}%"></i><i class="p" style="width:${pp}%"></i></div>
    <span class="small muted">სულ ${b.quota} · გამოყენებული ${b.used}${b.pending ? ` · მოლოდინში ${b.pending}` : ''}</span></div>`;
}

function reqRow(r, { admin = false, showName = false } = {}) {
  const n = workdays(r);
  return `<div class="req"><div>
      <div class="t">${showName ? esc(r.name) + ' · ' : ''}${C.TYPES[r.type]} · ${n} სამუშაო დღე</div>
      <div class="small">${esc(C.fmtRanges(r.dates || []))}, ${r.year}</div>
      ${r.comment ? `<div class="small muted">„${esc(r.comment)}“</div>` : ''}
      ${r.adminNote ? `<div class="small muted">ადმინი: ${esc(r.adminNote)}</div>` : ''}
    </div><div class="row">
      <span class="pill ${r.status}">${STATUS[r.status]}</span>
      ${!admin && r.status === 'pending' ? `<button class="btn ghost sm" data-cancel="${r.id}">გაუქმება</button>` : ''}
      ${admin && r.status === 'approved' ? `<button class="btn ghost sm" data-acancel="${r.id}">გაუქმება</button>` : ''}
    </div></div>`;
}

function renderMine(host, emp) {
  const y = S.year;
  const mine = sortReqs(reqsOf(emp.id));
  const F = S.form;
  host.innerHTML = `<div class="stack">
    <div class="row spread"><h2>გამარჯობა, ${esc(emp.name)}</h2>${yearSelect('ySel', y)}</div>
    <div class="grid2">${balCard(emp, 'vacation', y)}${balCard(emp, 'dayoff', y)}</div>
    <div class="card stack">
      <h3>ახალი მოთხოვნა</h3>
      <div class="seg" id="typeSeg"><button data-t="vacation" class="${F.type === 'vacation' ? 'on' : ''}">შვებულება</button><button data-t="dayoff" class="${F.type === 'dayoff' ? 'on' : ''}">დეი ოფი</button></div>
      <p class="small muted">მონიშნეთ სასურველი დღეები. მაუსით შეგიძლიათ რამდენიმე დღეზე ერთად გადაატაროთ. შაბათ-კვირა და უქმე დღეები არ მოინიშნება.</p>
      <div id="cal"></div>
      <div class="note" id="sum"></div>
      <label class="f">კომენტარი (არასავალდებულო)<textarea id="cmt" rows="2">${esc(F.comment)}</textarea></label>
      <div class="err" id="fErr"></div>
      <div class="row"><button class="btn" id="send">მოთხოვნის გაგზავნა</button><button class="btn ghost" id="clr">გასუფთავება</button></div>
    </div>
    <div class="card stack"><h3>ჩემი მოთხოვნები</h3>
      ${mine.length ? mine.map(r => reqRow(r)).join('') : '<p class="muted">მოთხოვნები ჯერ არ არის.</p>'}</div>
    ${S.map.role === 'admin' ? '' : pwCard()}
  </div>`;
  $('#ySel', host).onchange = e => { S.year = +e.target.value; renderMine(host, emp); };
  $$('#typeSeg button', host).forEach(b => b.onclick = () => { F.type = b.dataset.t; renderMine(host, emp); });
  $('#cmt', host).oninput = e => F.comment = e.target.value;
  const sum = $('#sum', host), send = $('#send', host);
  function upd() {
    const g = C.groupByYear(F.sel);
    const ys = Object.keys(g);
    if (!ys.length) { sum.textContent = 'დღეები არ არის მონიშნული.'; send.disabled = true; return; }
    let ok = true;
    const parts = ys.map(yy => {
      const n = g[yy].length; const b = bal(emp, F.type, +yy);
      if (n > b.free) ok = false;
      return `${yy}: ${C.fmtRanges(g[yy])} — <b>${n} სამუშაო დღე</b>, ${n > b.free ? `<span class="err">ნაშთი არ ყოფნის (თავისუფალია ${Math.max(0, b.free)})</span>` : `დაგრჩებათ ${b.free - n}`}`;
    });
    sum.innerHTML = `${C.TYPES[F.type]}: ` + parts.join('<br>');
    send.disabled = !ok;
  }
  const cal = calendar($('#cal', host), { month: F.month, sel: F.sel, state: d => dayState(emp.id, d), onChange: upd });
  upd();
  $('#clr', host).onclick = () => { F.sel.clear(); cal.paint(); upd(); };
  send.onclick = async () => {
    send.disabled = true;
    try {
      const g = C.groupByYear(F.sel);
      const lines = [];
      for (const yy of Object.keys(g)) {
        await addDoc(collection(db, 'requests'), {
          empId: emp.id, uid: S.user.uid, name: emp.name, type: F.type, dates: g[yy], year: +yy,
          status: 'pending', comment: F.comment.trim(), createdAt: serverTimestamp(),
        });
        lines.push(`${C.fmtRanges(g[yy])}, ${yy} (${g[yy].length} სამუშაო დღე)`);
      }
      notifyAdmins(`🗓 ახალი მოთხოვნა\n${emp.name} — ${C.TYPES[F.type]}\n${lines.join('\n')}`
        + (F.comment.trim() ? `\nკომენტარი: ${F.comment.trim()}` : '') + `\n\nდასადასტურებლად: ${SITE_URL}`);
      F.sel.clear(); F.comment = '';
      toast('მოთხოვნა გაიგზავნა. დაელოდეთ დადასტურებას.');
    } catch (e) { $('#fErr', host).textContent = errText(e); send.disabled = false; }
  };
  $$('[data-cancel]', host).forEach(b => b.onclick = async () => {
    if (!confirm('გავაუქმო ეს მოთხოვნა?')) return;
    try { await updateDoc(doc(db, 'requests', b.dataset.cancel), { status: 'cancelled', decidedAt: serverTimestamp() }); }
    catch (e) { toast(errText(e)); }
  });
  bindPw(host);
}

function pwCard() {
  return `<details class="card"><summary style="cursor:pointer;font-weight:600">პაროლის შეცვლა</summary>
    <div class="stack" style="margin-top:14px">
      <label class="f">ძველი პაროლი<input type="password" id="pOld" autocomplete="current-password"></label>
      <label class="f">ახალი პაროლი (მინ. 6 სიმბოლო)<input type="password" id="pNew" autocomplete="new-password"></label>
      <div class="err" id="pErr"></div><button class="btn dark" id="pGo">შეცვლა</button></div></details>`;
}
function bindPw(host) {
  const b = $('#pGo', host); if (!b) return;
  b.onclick = async () => {
    const err = $('#pErr', host); err.textContent = '';
    const nw = $('#pNew', host).value;
    if (nw.length < 6) return err.textContent = 'ახალი პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს.';
    try {
      await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, $('#pOld', host).value));
      await updatePassword(S.user, nw);
      $('#pOld', host).value = ''; $('#pNew', host).value = '';
      toast('პაროლი შეიცვალა.');
    } catch (e) { err.textContent = errText(e); }
  };
}

// ───────── ადმინი: მოთხოვნები ─────────
function renderRequests(host) {
  const pend = S.requests.filter(r => r.status === 'pending').sort((a, b) => (a.dates?.[0] || '').localeCompare(b.dates?.[0] || ''));
  const done = S.requests.filter(r => r.status !== 'pending')
    .sort((a, b) => (b.decidedAt?.seconds || 0) - (a.decidedAt?.seconds || 0)).slice(0, 30);
  const empById = id => S.employees.find(e => e.id === id);
  host.innerHTML = `<div class="stack">
    <h2>დასადასტურებელი</h2>
    ${pend.length ? pend.map(r => {
      const emp = empById(r.empId); const n = workdays(r);
      const b = emp ? bal(emp, r.type, +r.year) : null;
      return `<div class="req"><div>
        <div class="t">${esc(r.name)} · ${C.TYPES[r.type]} · ${n} სამუშაო დღე</div>
        <div class="small">${esc(C.fmtRanges(r.dates || []))}, ${r.year}</div>
        ${r.comment ? `<div class="small muted">„${esc(r.comment)}“</div>` : ''}
        ${b ? `<div class="small muted">ამჟამად დარჩენილი: ${b.left} · დადასტურების შემდეგ: <b class="${b.left - n < 0 ? 'err' : ''}">${b.left - n}</b></div>` : ''}
      </div><div class="row">
        <button class="btn sm" data-ok="${r.id}">დადასტურება</button>
        <button class="btn ghost sm" data-no="${r.id}">უარყოფა</button></div></div>`;
    }).join('') : '<p class="muted">ახალი მოთხოვნა არ არის.</p>'}
    <h2 style="margin-top:28px">ბოლო გადაწყვეტილებები</h2>
    ${done.length ? done.map(r => reqRow(r, { admin: true, showName: true })).join('') : '<p class="muted">ჯერ არაფერია.</p>'}
  </div>`;
  bindAdminReqActions(host);
}

function bindAdminReqActions(host) {
  $$('[data-ok]', host).forEach(b => b.onclick = async () => {
    const r = S.requests.find(x => x.id === b.dataset.ok); const emp = S.employees.find(e => e.id === r.empId);
    const n = workdays(r);
    if (emp) {
      const bl = bal(emp, r.type, +r.year);
      if (n > bl.left && !confirm(`${r.name}-ს ნაშთი არ ყოფნის (დარჩენილია ${bl.left}, მოთხოვნილია ${n}). მაინც დავადასტურო?`)) return;
      const taken = new Set(reqsOf(r.empId).filter(x => x.status === 'approved').flatMap(x => x.dates || []));
      if ((r.dates || []).some(d => taken.has(d)) && !confirm('ზოგი დღე უკვე დადასტურებულია სხვა ჩანაწერით. მაინც დავადასტურო?')) return;
    }
    try { await updateDoc(doc(db, 'requests', r.id), { status: 'approved', decidedAt: serverTimestamp(), decidedBy: S.me.name }); toast('დადასტურდა.'); }
    catch (e) { toast(errText(e)); }
  });
  $$('[data-no]', host).forEach(b => b.onclick = async () => {
    const note = prompt('უარის მიზეზი (არასავალდებულო):', '');
    if (note === null) return;
    try { await updateDoc(doc(db, 'requests', b.dataset.no), { status: 'rejected', adminNote: note.trim(), decidedAt: serverTimestamp(), decidedBy: S.me.name }); toast('უარყოფილია.'); }
    catch (e) { toast(errText(e)); }
  });
  $$('[data-acancel]', host).forEach(b => b.onclick = async () => {
    if (!confirm('გავაუქმო დადასტურებული ჩანაწერი? დღეები ნაშთს დაუბრუნდება.')) return;
    try { await updateDoc(doc(db, 'requests', b.dataset.acancel), { status: 'cancelled', decidedAt: serverTimestamp(), decidedBy: S.me.name }); toast('გაუქმდა.'); }
    catch (e) { toast(errText(e)); }
  });
}

// ───────── ადმინი: გუნდის კალენდარი ─────────
function renderTeam(host) {
  const v = S.teamMonth; const { y, m } = v;
  const act = new Set(S.employees.filter(e => e.active && (e.role !== 'admin' || e.track)).map(e => e.id));
  const byDay = new Map();
  for (const r of S.requests) {
    if (!act.has(r.empId) || (r.status !== 'approved' && r.status !== 'pending')) continue;
    for (const d of r.dates || []) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
  }
  const first = C.weekday(C.iso(y, m, 1));
  let cells = C.WEEKDAYS.map(w => `<div class="cal-wd">${w}</div>`).join('');
  for (let i = 0; i < first; i++) cells += '<div></div>';
  for (let d = 1; d <= C.daysInMonth(y, m); d++) {
    const s = C.iso(y, m, d); const hn = hName(s); const off = hn || C.weekday(s) >= 5;
    const list = (byDay.get(s) || []).sort((a, b) => a.name.localeCompare(b.name, 'ka'));
    cells += `<div class="c ${off ? 'off' : ''}" title="${esc(hn || '')}"><span class="n">${d}</span>
      ${list.map(r => `<span class="${r.status === 'approved' ? 'who-a' : 'who-p'}" title="${esc(r.name)} — ${C.TYPES[r.type]}">${esc(r.name.split(' ')[0])}${r.type === 'dayoff' ? ' (დ/ო)' : ''}</span>`).join('')}</div>`;
  }
  host.innerHTML = `<div class="stack"><div class="cal-head">
      <button class="cal-nav" id="tp" aria-label="წინა თვე">◀</button><h2>${C.MONTHS[m - 1]} ${y}</h2><button class="cal-nav" id="tn" aria-label="შემდეგი თვე">▶</button></div>
    <div class="tcal">${cells}</div>
    <div class="legend"><span><i style="background:var(--ink)"></i>დადასტურებული</span><span><i style="border:1.5px dashed var(--red)"></i>მოლოდინში</span><span>(დ/ო) — დეი ოფი</span></div></div>`;
  $('#tp', host).onclick = () => { v.m--; if (v.m < 1) { v.m = 12; v.y--; } renderTeam(host); };
  $('#tn', host).onclick = () => { v.m++; if (v.m > 12) { v.m = 1; v.y++; } renderTeam(host); };
}

// ───────── ადმინი: თანამშრომლები ─────────
function renderEmps(host) {
  const y = S.year;
  const list = S.employees.filter(e => (S.showOff || e.active) && (e.role !== 'admin' || e.track || S.showOff));
  const offCount = S.employees.filter(e => !e.active).length;
  host.innerHTML = `<div class="stack">
    <div class="row spread"><h2>თანამშრომლები</h2><div class="row">${yearSelect('ySel', y)}<button class="btn" id="add">+ დამატება</button></div></div>
    <div class="tbl-wrap"><table><thead><tr><th>სახელი</th><th>Username</th><th>შვებ. დარჩ.</th><th>გამოყ. / სულ</th><th>დეი ოფი დარჩ.</th><th>გამოყ. / სულ</th><th>მოლოდ.</th><th></th></tr></thead><tbody>
    ${list.map(e => {
      const v = bal(e, 'vacation', y), d = bal(e, 'dayoff', y);
      return `<tr><td>${esc(e.name)} ${e.role === 'admin' ? '<span class="pill offk">ადმინი</span>' : ''} ${!e.active ? '<span class="pill offk">გამორთული</span>' : ''}</td>
        <td class="muted">${esc(e.username)}</td>
        <td class="num"><b>${v.left}</b></td><td class="num muted">${v.used} / ${v.quota}</td>
        <td class="num"><b>${d.left}</b></td><td class="num muted">${d.used} / ${d.quota}</td>
        <td class="num">${v.pending + d.pending || ''}</td>
        <td><button class="btn ghost sm" data-edit="${e.id}">მართვა</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">თანამშრომლები ჯერ არ არის დამატებული.</td></tr>'}
    </tbody></table></div>
    ${offCount ? `<label class="row small muted"><input type="checkbox" id="showOff" ${S.showOff ? 'checked' : ''}> გამორთულების ჩვენება (${offCount})</label>` : ''}
  </div>`;
  $('#ySel', host).onchange = e => { S.year = +e.target.value; renderEmps(host); };
  $('#add', host).onclick = addEmpModal;
  const so = $('#showOff', host); if (so) so.onchange = e => { S.showOff = e.target.checked; renderEmps(host); };
  $$('[data-edit]', host).forEach(b => b.onclick = () => editEmpModal(b.dataset.edit));
}

function modal(html) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="card">${html}</div>`;
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  return m;
}

function addEmpModal() {
  const m = modal(`<h2>ახალი თანამშრომელი</h2>
    <label class="f">სახელი და გვარი<input type="text" id="aName"></label>
    <label class="f">Username (ლათინურად, მაგ. nino.b)<input type="text" id="aUser" autocapitalize="off"></label>
    <label class="f">დროებითი პაროლი (მინ. 6 სიმბოლო)<input type="text" id="aPw"></label>
    <p class="small muted">Username და პაროლი გადაეცით თანამშრომელს. შესვლის შემდეგ პაროლს თავად შეცვლის.</p>
    <div class="err" id="aErr"></div>
    <div class="row"><button class="btn" id="aGo">დამატება</button><button class="btn ghost" id="aX">გაუქმება</button></div>`);
  $('#aX', m).onclick = () => m.remove();
  $('#aGo', m).onclick = async () => {
    const name = $('#aName', m).value.trim(), u = $('#aUser', m).value.trim().toLowerCase(), pw = $('#aPw', m).value;
    const err = $('#aErr', m); err.textContent = '';
    if (!name) return err.textContent = 'ჩაწერეთ სახელი.';
    if (!/^[a-z0-9._-]{3,30}$/.test(u)) return err.textContent = 'Username: 3–30 ლათინური ასო, ციფრი, წერტილი ან ტირე.';
    if (pw.length < 6) return err.textContent = 'პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს.';
    $('#aGo', m).disabled = true;
    try {
      if ((await getDoc(doc(db, 'logins', u))).exists()) throw { code: 'email-already-in-use' };
      const email = `${u}@${DOMAIN}`;
      const uid = await createLogin(email, pw);
      const empRef = doc(collection(db, 'employees'));
      const b = writeBatch(db);
      b.set(empRef, { name, username: u, uid, role: 'employee', active: true, createdAt: serverTimestamp() });
      b.set(doc(db, 'uidmap', uid), { empId: empRef.id, role: 'employee' });
      b.set(doc(db, 'logins', u), { email });
      await b.commit();
      m.remove(); toast(`${name} დაემატა. Username: ${u}`);
    } catch (e) { err.textContent = errText(e); $('#aGo', m).disabled = false; }
  };
}

function editEmpModal(id) {
  const e = S.employees.find(x => x.id === id); if (!e) return;
  const y = S.year;
  const qv = e.quotas?.[y]?.vacation, qd = e.quotas?.[y]?.dayoff;
  const isSelf = e.id === S.me.id;
  const rec = { type: 'vacation', sel: new Set(), month: startMonth() };
  const m = modal(`<div class="row spread"><h2>${esc(e.name)}</h2><button class="btn ghost sm" id="eX">დახურვა</button></div>
    <label class="f">სახელი და გვარი<input type="text" id="eName" value="${esc(e.name)}"></label>
    ${e.role === 'admin' ? `<label class="row small"><input type="checkbox" id="eTrack" ${e.track ? 'checked' : ''}> ადმინის შვებულებებიც აღირიცხოს</label>` : ''}
    <div class="note small">${y} წლის რაოდენობა. ცარიელი ველი ნიშნავს საერთო პარამეტრს (შვებულება ${S.settings.vacationDays ?? DEFAULT_VACATION}, დეი ოფი ${S.settings.dayoffDays ?? 0}).</div>
    <div class="grid2" style="gap:10px">
      <label class="f">შვებულება ${y}<input type="number" min="0" id="eQv" value="${qv ?? ''}" placeholder="${S.settings.vacationDays ?? DEFAULT_VACATION}"></label>
      <label class="f">დეი ოფი ${y}<input type="number" min="0" id="eQd" value="${qd ?? ''}" placeholder="${S.settings.dayoffDays ?? 0}"></label>
    </div>
    <div class="err" id="eErr"></div>
    <button class="btn" id="eSave">შენახვა</button>
    <hr style="border:0;border-top:1px solid var(--line)">
    <details><summary style="cursor:pointer;font-weight:600">ჩანაწერის დამატება (პირდაპირ დადასტურებული)</summary>
      <div class="stack" style="margin-top:12px">
        <div class="seg" id="rSeg"><button data-t="vacation" class="on">შვებულება</button><button data-t="dayoff">დეი ოფი</button></div>
        <div id="rCal"></div><div class="note small" id="rSum"></div>
        <label class="f">შენიშვნა<input type="text" id="rNote"></label>
        <button class="btn dark" id="rGo">ჩაწერა</button></div></details>
    <details><summary style="cursor:pointer;font-weight:600">ჩანაწერები</summary><div class="stack" style="margin-top:12px" id="eReqs"></div></details>
    ${isSelf ? '' : `<details><summary style="cursor:pointer;font-weight:600">ახალი პაროლის მინიჭება</summary>
      <div class="stack" style="margin-top:12px"><label class="f">ახალი პაროლი (მინ. 6 სიმბოლო)<input type="text" id="ePw"></label>
      <button class="btn dark" id="ePwGo">მინიჭება</button></div></details>
    <div class="row">
      ${e.active ? `<button class="btn ghost" id="eRole">${e.role === 'admin' ? 'ადმინობის მოხსნა' : 'ადმინად დანიშვნა'}</button>` : ''}
      <button class="btn ghost" id="eAct">${e.active ? 'თანამშრომლის გამორთვა' : 'თანამშრომლის ჩართვა'}</button></div>`}`);
  $('#eX', m).onclick = () => m.remove();
  const reqsBox = $('#eReqs', m);
  const drawReqs = () => {
    const l = sortReqs(reqsOf(e.id));
    reqsBox.innerHTML = l.length ? l.map(r => reqRow(r, { admin: true })).join('') : '<p class="muted">ჩანაწერები არ არის.</p>';
    bindAdminReqActions(reqsBox);
  };
  drawReqs();
  // რაოდენობა/სახელი
  $('#eSave', m).onclick = async () => {
    const err = $('#eErr', m); err.textContent = '';
    const name = $('#eName', m).value.trim(); if (!name) return err.textContent = 'ჩაწერეთ სახელი.';
    const upd = { name };
    for (const [k, inp] of [['vacation', '#eQv'], ['dayoff', '#eQd']]) {
      const v = $(inp, m).value.trim();
      upd[`quotas.${y}.${k}`] = v === '' ? deleteField() : Math.max(0, Math.floor(+v));
    }
    const tr = $('#eTrack', m); if (tr) upd.track = tr.checked;
    try { await updateDoc(doc(db, 'employees', e.id), upd); toast('შენახულია.'); m.remove(); }
    catch (x) { err.textContent = errText(x); }
  };
  // ჩანაწერის დამატება
  const rSum = $('#rSum', m);
  const rUpd = () => {
    const g = C.groupByYear(rec.sel);
    rSum.textContent = Object.keys(g).length ? Object.entries(g).map(([yy, ds]) => `${yy}: ${C.fmtRanges(ds)} — ${ds.length} სამუშაო დღე`).join('; ') : 'დღეები არ არის მონიშნული.';
  };
  const rCal = calendar($('#rCal', m), { month: rec.month, sel: rec.sel, state: d => dayState(e.id, d, true), onChange: rUpd });
  rUpd();
  $$('#rSeg button', m).forEach(b => b.onclick = () => { rec.type = b.dataset.t; $$('#rSeg button', m).forEach(x => x.classList.toggle('on', x === b)); });
  $('#rGo', m).onclick = async () => {
    const g = C.groupByYear(rec.sel); if (!Object.keys(g).length) return toast('მონიშნეთ დღეები.');
    try {
      for (const [yy, ds] of Object.entries(g)) {
        await addDoc(collection(db, 'requests'), {
          empId: e.id, uid: e.uid, name: e.name, type: rec.type, dates: ds, year: +yy, status: 'approved',
          comment: '', adminNote: $('#rNote', m).value.trim(), createdBy: S.me.name, decidedBy: S.me.name,
          createdAt: serverTimestamp(), decidedAt: serverTimestamp(),
        });
      }
      rec.sel.clear(); rCal.paint(); rUpd(); $('#rNote', m).value = '';
      toast('ჩაიწერა.'); setTimeout(drawReqs, 400);
    } catch (x) { toast(errText(x)); }
  };
  if (isSelf) return;
  // ახალი პაროლი: იქმნება ახალი შესვლის ანგარიში, ძველი ითიშება
  $('#ePwGo', m).onclick = async () => {
    const pw = $('#ePw', m).value; if (pw.length < 6) return toast('პაროლი მინიმუმ 6 სიმბოლო უნდა იყოს.');
    if (!confirm(`${e.name}-ს მიენიჭოს ახალი პაროლი? ძველი პაროლი აღარ იმუშავებს.`)) return;
    try {
      const email = `${e.username}.r${Date.now().toString(36)}@${DOMAIN}`;
      const uid = await createLogin(email, pw);
      const b = writeBatch(db);
      if (e.uid) b.delete(doc(db, 'uidmap', e.uid));
      if (e.active) b.set(doc(db, 'uidmap', uid), { empId: e.id, role: e.role });
      b.update(doc(db, 'employees', e.id), { uid });
      b.set(doc(db, 'logins', e.username), { email });
      await b.commit();
      toast('ახალი პაროლი მიენიჭა.'); m.remove();
    } catch (x) { toast(errText(x)); }
  };
  const roleBtn = $('#eRole', m);
  if (roleBtn) roleBtn.onclick = async () => {
    const toAdmin = e.role !== 'admin';
    if (!confirm(toAdmin
      ? `დავნიშნო ${e.name} ადმინად? ნახავს ყველას მონაცემებს და შეძლებს მოთხოვნების დადასტურებას.`
      : `მოვუხსნა ${e.name}-ს ადმინობა? დარჩება ჩვეულებრივ თანამშრომლად.`)) return;
    try {
      const role = toAdmin ? 'admin' : 'employee';
      const b = writeBatch(db);
      b.update(doc(db, 'employees', e.id), toAdmin ? { role, track: true } : { role });
      b.set(doc(db, 'uidmap', e.uid), { empId: e.id, role });
      await b.commit(); toast(toAdmin ? 'დაინიშნა ადმინად. ცვლილება ძალაშია შემდეგი შესვლიდან.' : 'ადმინობა მოეხსნა.'); m.remove();
    } catch (x) { toast(errText(x)); }
  };
  $('#eAct', m).onclick = async () => {
    const on = !e.active;
    if (!confirm(on ? `ჩავრთო ${e.name}?` : `გამოვრთო ${e.name}? ვეღარ შევა სისტემაში. ჩანაწერები შეინახება.`)) return;
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'employees', e.id), { active: on });
      if (on) b.set(doc(db, 'uidmap', e.uid), { empId: e.id, role: e.role }); else b.delete(doc(db, 'uidmap', e.uid));
      await b.commit(); toast(on ? 'ჩაირთო.' : 'გამოირთო.'); m.remove();
    } catch (x) { toast(errText(x)); }
  };
}

// ───────── ადმინი: პარამეტრები ─────────
function renderSettings(host) {
  const hy = S.holYear;
  const custom = !!S.settings.holidays?.[hy];
  const list = [...holidaysFor(hy)];
  host.innerHTML = `<div class="stack">
    <div class="card stack"><h3>წლიური რაოდენობა (ყველასთვის)</h3>
      <p class="small muted">კონკრეტულ თანამშრომელს განსხვავებული რაოდენობა შეგიძლიათ მიუთითოთ „თანამშრომლები“ → „მართვა“.</p>
      <div class="grid2" style="gap:10px">
        <label class="f">შვებულება (სამუშაო დღე)<input type="number" min="0" id="gV" value="${S.settings.vacationDays ?? DEFAULT_VACATION}"></label>
        <label class="f">დეი ოფი (დღე)<input type="number" min="0" id="gD" value="${S.settings.dayoffDays ?? 0}"></label>
      </div><div><button class="btn" id="gSave">შენახვა</button></div></div>
    <div class="card stack"><div class="row spread"><h3>უქმე დღეები</h3>${yearSelect('hY', hy)}</div>
      <p class="small muted">${custom ? 'ამ წლის სია შეცვლილია ხელით.' : 'სია შედგენილია შრომის კოდექსის მიხედვით, ავტომატურად.'} სამთავრობო დადგენილებით დამატებული დასვენების დღე აქ ჩაამატეთ.</p>
      <div class="tbl-wrap"><table><tbody>${list.map((h, i) => `<tr><td>${C.fmtDate(h.date)}</td><td class="muted">${C.WEEKDAYS[C.weekday(h.date)]}</td><td>${esc(h.name)}</td><td><button class="btn ghost sm" data-hdel="${i}">წაშლა</button></td></tr>`).join('')}</tbody></table></div>
      <div class="row"><input type="date" id="hD" min="${hy}-01-01" max="${hy}-12-31" style="width:auto"><input type="text" id="hN" placeholder="დასახელება" style="flex:1;min-width:160px"><button class="btn dark" id="hAdd">დამატება</button></div>
      ${custom ? '<div><button class="btn ghost sm" id="hReset">კოდექსის სიაზე დაბრუნება</button></div>' : ''}
    </div>
    <div class="card stack" id="tgCard"><h3>Telegram შეტყობინებები</h3><p class="muted small">იტვირთება…</p></div>
    ${pwCard()}
  </div>`;
  renderTelegram($('#tgCard', host));
  $('#gSave', host).onclick = async () => {
    const v = Math.max(0, Math.floor(+$('#gV', host).value || 0)), d = Math.max(0, Math.floor(+$('#gD', host).value || 0));
    try { await updateDoc(doc(db, 'settings', 'config'), { vacationDays: v, dayoffDays: d }); toast('შენახულია.'); } catch (e) { toast(errText(e)); }
  };
  $('#hY', host).onchange = e => { S.holYear = +e.target.value; renderSettings(host); };
  const saveH = async l => {
    try { await updateDoc(doc(db, 'settings', 'config'), { [`holidays.${hy}`]: l === null ? deleteField() : [...l].sort((a, b) => a.date.localeCompare(b.date)) }); }
    catch (e) { toast(errText(e)); }
  };
  $$('[data-hdel]', host).forEach(b => b.onclick = () => {
    const h = list[+b.dataset.hdel];
    if (confirm(`წავშალო „${h.name}“ (${C.fmtDate(h.date)})?`)) saveH(list.filter((_, i) => i !== +b.dataset.hdel));
  });
  $('#hAdd', host).onclick = () => {
    const d = $('#hD', host).value, n = $('#hN', host).value.trim();
    if (!d || !d.startsWith(String(hy))) return toast(`აირჩიეთ ${hy} წლის თარიღი.`);
    if (!n) return toast('ჩაწერეთ დასახელება.');
    if (list.some(h => h.date === d)) return toast('ეს დღე უკვე სიაშია.');
    saveH([...list, { date: d, name: n }]);
  };
  const r = $('#hReset', host); if (r) r.onclick = () => { if (confirm('დავაბრუნო კოდექსის სია?')) saveH(null); };
  bindPw(host);
}

// ───────── ადმინი: Telegram-ის პარამეტრები ─────────
S.tg = null; // { token, chats:[{id,name}], found:[{id,name}] }
async function renderTelegram(box) {
  if (!S.tg) {
    try { const s = await getDoc(doc(db, 'settings', 'telegram')); S.tg = { token: '', chats: [], ...(s.exists() ? s.data() : {}), found: [] }; }
    catch (e) { box.innerHTML = `<h3>Telegram შეტყობინებები</h3><p class="err">${esc(errText(e))}</p>`; return; }
  }
  if (!box.isConnected) return;
  const T = S.tg;
  const all = [...T.chats];
  for (const f of T.found) if (!all.some(c => String(c.id) === String(f.id))) all.push(f);
  box.innerHTML = `<h3>Telegram შეტყობინებები</h3>
    <p class="small muted">ახალი მოთხოვნისას შეტყობინება მოვა მონიშნულ ადამიანებს Telegram-ში.</p>
    <label class="f">ბოტის ტოკენი (BotFather-იდან)<input type="password" id="tgTok" value="${esc(T.token)}" placeholder="123456789:AA…" autocomplete="off"></label>
    <div class="note small">ყოველმა მიმღებმა Telegram-ში უნდა გახსნას ბოტი და დააჭიროს <b>Start</b>. შემდეგ აქ დააჭირეთ „მიმღებების მოძებნა“.</div>
    <div class="row"><button class="btn ghost sm" id="tgFind">მიმღებების მოძებნა</button></div>
    <div id="tgList">${all.length ? all.map(c => `<label class="row small" style="padding:6px 0"><input type="checkbox" data-tgc="${esc(c.id)}" data-name="${esc(c.name)}" ${T.chats.some(x => String(x.id) === String(c.id)) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') : '<p class="small muted">მიმღებები ჯერ არ არის.</p>'}</div>
    <div class="err" id="tgErr"></div>
    <div class="row"><button class="btn" id="tgSave">შენახვა</button><button class="btn ghost" id="tgTest">სატესტო შეტყობინება</button></div>`;
  const tok = () => $('#tgTok', box).value.trim();
  const err = $('#tgErr', box);
  $('#tgTok', box).oninput = e => { T.token = e.target.value.trim(); };
  $('#tgFind', box).onclick = async () => {
    err.textContent = '';
    if (!tok()) { err.textContent = 'ჯერ ჩაწერეთ ტოკენი.'; return; }
    try {
      const j = await (await fetch(`https://api.telegram.org/bot${tok()}/getUpdates`)).json();
      if (!j.ok) throw new Error(j.description);
      const m = new Map();
      for (const u of j.result || []) {
        const c = (u.message || u.my_chat_member || {}).chat;
        if (c && c.type === 'private') m.set(String(c.id), [c.first_name, c.last_name].filter(Boolean).join(' ') + (c.username ? ` (@${c.username})` : ''));
      }
      T.found = [...m].map(([id, name]) => ({ id, name }));
      await renderTelegram(box);
      if (!T.found.length) $('#tgErr', box).textContent = 'ვერავინ მოიძებნა. ბოტში დააჭირეთ Start (ან მისწერეთ ნებისმიერი ტექსტი) და სცადეთ ხელახლა.';
    } catch (e) { err.textContent = 'ტოკენი არასწორია ან კავშირი ვერ დამყარდა.'; }
  };
  const picked = () => $$('[data-tgc]', box).filter(i => i.checked).map(i => ({ id: i.dataset.tgc, name: i.dataset.name }));
  $('#tgSave', box).onclick = async () => {
    try {
      const data = { token: tok(), chats: picked() };
      await setDoc(doc(db, 'settings', 'telegram'), data);
      Object.assign(T, data); toast('შენახულია.');
    } catch (e) { err.textContent = errText(e); }
  };
  $('#tgTest', box).onclick = async () => {
    err.textContent = '';
    const cs = picked();
    if (!tok() || !cs.length) { err.textContent = 'ჩაწერეთ ტოკენი და მონიშნეთ მიმღები.'; return; }
    const res = await Promise.allSettled(cs.map(c => tgSend(tok(), c.id, '✅ სატესტო შეტყობინება — ალისფერი აფრები, შვებულებების აღრიცხვა')));
    const bad = res.filter(x => x.status === 'rejected').length;
    if (bad) err.textContent = `${bad} მიმღებთან ვერ გაიგზავნა.`; else toast('გაიგზავნა. შეამოწმეთ Telegram.');
  };
}

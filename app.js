// ============ Förseningsvakten — app ============
import { stopFinder, nearbyStops } from "./sl.js";
import { evaluate, estimateTaxi, CAP_2026 } from "./engine.js";

/* ---------- DOM helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtClock = (ms) => (ms ? new Date(ms).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : "–");
const kr = (n) => (n == null ? "–" : n.toLocaleString("sv-SE") + " kr");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// SL-linjebrickor i rätt färg
function badges(lineObjs = [], big = false) {
  if (!lineObjs || !lineObjs.length) return "";
  const chips = lineObjs.slice(0, 4).map((l) =>
    `<span class="line-badge${big ? " lg" : ""}" style="background:${l.color || "#5a6472"}" role="img" aria-label="Linje ${esc(l.designation)}" title="Linje ${esc(l.designation)}">${esc(l.designation)}</span>`).join("");
  return `<span class="line-badges">${chips}</span>`;
}
// Hela resan som en tidslinje, ben för ben
function journeyHTML(legs) {
  if (!legs || !legs.length) return "";
  const isLate = (est, planned) => planned && est && est - planned >= 90000;
  const time = (est, planned) => `<span class="jtime${isLate(est, planned) ? " late" : ""}">${fmtClock(est)}</span>`;
  const durMin = (s) => (s ? Math.max(1, Math.round(s / 60)) : null);
  let h = '<div class="journey">';
  legs.forEach((leg) => {
    const c = leg.walk ? "var(--faint)" : (leg.color || "#5a6472");
    h += `<div class="jstop">${time(leg.depMs, leg.depPlannedMs)}<span class="jdot" style="background:${c}"></span><span class="jname">${esc(leg.fromName)}</span></div>`;
    const d = durMin(leg.durationSec);
    h += `<div class="jconn"><span></span><span class="jrail" style="background:${c}"></span><span class="jinfo">${
      leg.walk
        ? `<span class="jwalk">Gå${d ? " " + d + " min" : ""}</span>`
        : `${badges([{ designation: leg.designation, color: leg.color }])}<span class="jtowards">mot ${esc(leg.towards || "—")}${d ? " · " + d + " min" : ""}</span>`
    }</span></div>`;
  });
  const last = legs[legs.length - 1];
  const lc = last.walk ? "var(--faint)" : (last.color || "#5a6472");
  h += `<div class="jstop">${time(last.arrMs, last.arrPlannedMs)}<span class="jdot" style="background:${lc}"></span><span class="jname strong">${esc(last.toName)}</span></div>`;
  return h + "</div>";
}
function toast(msg, action) {
  const t = $("#toast"); t.innerHTML = "";
  const s = document.createElement("span"); s.textContent = msg; t.appendChild(s);
  if (action) {
    const b = document.createElement("button"); b.className = "toast-action"; b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.fn(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), action ? 5000 : 2400);
}

/* ---------- State ---------- */
const KEY = "fv:state";
const defaults = {
  // home är numera reservhållplatsen — utgångspunkten är alltid nuvarande
  // position (se resolveOrigin). lastOrigin minns senast upplösta hållplats
  // så en omstart utan platsåtkomst inte gör appen blind.
  home: null, lastOrigin: null, dests: [],
  settings: { from: "07:00", to: "23:00", notify: true, threshold: 20, worthwhile: false, theme: "system", cap: CAP_2026 },
  claims: [], configured: false,
};
let state = load();
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...defaults, ...saved, settings: { ...defaults.settings, ...(saved.settings || {}) } };
  } catch { return structuredClone(defaults); }
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

/* ---------- Runtime ---------- */
const results = new Map();      // destId -> evaluation
const notifyStreak = new Map(); // destId -> consecutive eligible polls
let lastPollAt = 0, nextPollAt = 0, polling = false;

/* ---------- Utgångspunkt: alltid nuvarande position ---------- */
// Resorna utgår från närmaste hållplats till där du ÄR, inte från en fast
// hemhållplats. Positionen hämtas inför varje poll; hemhållplatsen finns kvar
// som reserv när platsen inte kan hämtas (nekad, timeout, ingen täckning).
let currentOrigin = null;

const getPosition = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error("unsupported"));
  // Grov precision räcker: hållplatser ligger hundratals meter isär, och
  // wifi-position är både snabbare och snällare mot batteriet än GPS.
  navigator.geolocation.getCurrentPosition(resolve, reject,
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 });
});

async function resolveOrigin() {
  try {
    const pos = await getPosition();
    const [near] = await nearbyStops(pos.coords.latitude, pos.coords.longitude, 1);
    if (near) {
      // Byter utgångspunkten hållplats är gamla svar svar på fel fråga — en
      // "berättigad" från förra hållplatsen får inte stå kvar som om den
      // gällde härifrån. Pollen som just ringt hit fyller på direkt igen.
      if (currentOrigin?.id !== near.id) { results.clear(); notifyStreak.clear(); }
      currentOrigin = near;
      state.lastOrigin = near; save();
      return near;
    }
  } catch { /* nekad, timeout eller offline — reserven nedan */ }
  return currentOrigin || state.lastOrigin || state.home;
}

const originNow = () => currentOrigin || state.lastOrigin || state.home;

/* ---------- Theme ---------- */
function applyTheme() {
  const t = state.settings.theme;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $$("#theme-seg button").forEach((b) => {
    const on = b.dataset.theme === t;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/* ---------- Search combo (återanvänds) ---------- */
function attachSearch(input, list, onPick) {
  let ctrl, active = -1, items = [];
  const close = () => { list.hidden = true; active = -1; };
  const render = () => {
    list.innerHTML = items.map((s, i) =>
      `<li data-i="${i}" class="${i === active ? "active" : ""}"><span class="r-name">${esc(s.name)}</span><span class="r-sub">${esc(s.locality || "")}</span></li>`).join("");
    list.hidden = !items.length;
  };
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { items = []; return close(); }
    ctrl?.abort(); ctrl = new AbortController();
    try { items = await stopFinder(q, ctrl.signal); active = -1; render(); }
    catch (e) { if (e.name !== "AbortError") { items = []; close(); } }
  }, 220);
  input.addEventListener("input", run);
  // Klick utanför lämnade listan hängande — mousedown på en träff hinner före
  // (preventDefault behåller fokus), så fördröjningen stör inte valet.
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { pick(items[active]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    e.preventDefault(); pick(items[+li.dataset.i]);
  });
  function pick(s) { input.value = ""; items = []; close(); onPick(s); }
  return { close, showItems: (arr) => { items = arr; active = -1; render(); } };
}

// Hämta position och visa närmaste hållplatser i träfflistan
function useMyLocation(combo, btn) {
  if (!navigator.geolocation) return toast("Platstjänst stöds inte i din webbläsare");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Hämtar plats…";
  const done = () => { btn.disabled = false; btn.textContent = label; };
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const near = await nearbyStops(pos.coords.latitude, pos.coords.longitude, 6);
      if (!near.length) toast("Hittade inga hållplatser nära dig");
      else { combo.showItems(near); toast("Närmaste hållplatser — välj din"); }
    } catch { toast("Kunde inte hämta hållplatser"); }
    finally { done(); }
  }, (err) => {
    done();
    toast(err.code === 1 ? "Platsåtkomst nekad — tillåt i webbläsaren" : "Kunde inte hämta din plats");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ================= ONBOARDING ================= */
const ob = { step: 0, home: null, dests: [] };
const SUGGEST = ["T-Centralen", "Odenplan", "Slussen", "Stockholm City", "Fridhemsplan", "Gullmarsplan"];

async function startOnboarding() {
  $("#onboarding").hidden = false; $("#app").hidden = true;
  showStep(0);
  const homeCombo = attachSearch($("#ob-home"), $("#ob-home-results"), (s) => {
    ob.home = s;
    $("#ob-home-picked").hidden = false;
    $("#ob-home-picked").textContent = `${s.name}${s.locality ? " · " + s.locality : ""}`;
    $('.ob-step[data-step="0"] [data-next]').disabled = false;
  });
  $("#ob-loc").onclick = () => useMyLocation(homeCombo, $("#ob-loc"));
  attachSearch($("#ob-dest"), $("#ob-dest-results"), (s) => addObDest(s));
  renderSuggest();
  // Föreslå den närmaste hållplatsen baserat på din nuvarande plats
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async (pos) => {
      if (ob.home) return; // användaren har redan valt manuellt
      try {
        const near = await nearbyStops(pos.coords.latitude, pos.coords.longitude, 6);
        if (near[0] && !ob.home) {
          ob.home = near[0];
          $("#ob-home").value = near[0].name;
          $("#ob-home-picked").hidden = false;
          $("#ob-home-picked").textContent = `Närmast dig: ${near[0].name} · ${near[0].locality} — ändra om du vill`;
          $('.ob-step[data-step="0"] [data-next]').disabled = false;
        }
      } catch {}
    }, () => { /* nekad/otillgänglig — sök manuellt eller använd knappen */ },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
  }
}
function renderSuggest() {
  $("#ob-dest-suggest").innerHTML = SUGGEST
    .filter((q) => !ob.dests.some((d) => d.name === q))
    .map((q) => `<button class="chip pickable" data-q="${q}"><span class="add">+</span>${q}</button>`).join("");
  $$("#ob-dest-suggest .chip").forEach((c) => c.onclick = async () => {
    c.disabled = true;
    try { const r = await stopFinder(c.dataset.q); if (r[0]) addObDest(r[0]); } catch {}
  });
}
function addObDest(s) {
  if (ob.dests.some((d) => d.id === s.id)) return;
  ob.dests.push(s); renderObDests(); renderSuggest();
  $('.ob-step[data-step="1"] [data-next]').disabled = ob.dests.length === 0;
}
function renderObDests() {
  $("#ob-dest-list").innerHTML = ob.dests.map((d, i) =>
    `<span class="chip">${esc(d.name)}<button class="x" data-i="${i}" aria-label="Ta bort ${esc(d.name)}">✕</button></span>`).join("");
  $$("#ob-dest-list .x").forEach((b) => b.onclick = () => {
    ob.dests.splice(+b.dataset.i, 1); renderObDests(); renderSuggest();
    $('.ob-step[data-step="1"] [data-next]').disabled = ob.dests.length === 0;
  });
}
function showStep(n) {
  ob.step = n;
  $$(".ob-step").forEach((s) => s.hidden = +s.dataset.step !== n);
  $$(".ob-progress span").forEach((s) => s.classList.toggle("on", +s.dataset.step <= n));
}
function wireOnboarding() {
  $$("[data-next]").forEach((b) => b.onclick = () => showStep(ob.step + 1));
  $$("[data-back]").forEach((b) => b.onclick = () => showStep(ob.step - 1));
  $("#ob-finish").onclick = async () => {
    state.home = ob.home;
    state.dests = ob.dests;
    state.settings.from = $("#ob-from").value; state.settings.to = $("#ob-to").value;
    state.settings.notify = $("#ob-notify").checked;
    state.configured = true; save();
    if (state.settings.notify) { try { await Notification.requestPermission(); } catch {} }
    $("#onboarding").hidden = true; $("#app").hidden = false;
    bootApp();
  };
}

/* ================= APP ================= */
function bootApp() {
  applyTheme();
  bindSettings();
  const setHomeCombo = attachSearch($("#set-home"), $("#set-home-results"), (s) => { state.home = s; save(); renderHome(); renderSettings(); poll(true); });
  $("#set-loc").onclick = () => useMyLocation(setHomeCombo, $("#set-loc"));
  renderHome(); renderSettings(); renderWallet();
  poll(true);
  startCountdown();
}

function renderHome() {
  renderOrigin();
  renderDestCards();
  renderHero();
}

// Etiketten skiljer på levande position, senast kända och reserv — "Från din
// plats" som ljuger är värre än ett ärligt "Senast kända plats".
function renderOrigin() {
  const o = originNow();
  $("#home-stop").textContent = o?.name || "—";
  $("#origin-label").textContent = currentOrigin ? "Från din plats"
    : state.lastOrigin ? "Senast kända plats" : "Reservhållplats";
}

// Tidigast anländande resan som ännu inte avgått, vald mot AKTUELL tid (inte polltid).
// Pollen cachar flera resor; mellan pollarna väljs nästa framtida ur cachen, så en redan
// avgången "nästa" resa aldrig visas.
function nextJourney(res) {
  if (!res || !res.journeys || !res.journeys.length) return null;
  const now = Date.now();
  const future = res.journeys.filter((j) => j.depEstMs == null || j.depEstMs >= now);
  return future[0] || null; // res.journeys är redan sorterad på tidigast ankomst
}

function statusMeta(res) {
  if (!res || res.status === "unknown") return { cls: "ok", label: "–", meta: "Ingen data" };
  if (res.status === "eligible") return { cls: "elig", label: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5zm2.2-.5h9.6l-1-3a.5.5 0 0 0-.5-.4H8.7a.5.5 0 0 0-.5.4l-1 3zM6.5 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`, meta: `Berättigad · +${res.deltaMin} min` };
  if (res.status === "delayed") return { cls: "delay", label: `+${res.deltaMin}`, meta: `Försenad · ~${res.deltaMin} min` };
  return { cls: "ok", label: "✓", meta: "I tid" };
}

function renderDestCards() {
  const ul = $("#dest-cards");
  if (!state.dests.length) {
    ul.innerHTML = `<li class="empty" style="padding:30px 10px">Inga destinationer än.<br><span class="muted tiny">Lägg till en nedan så börjar vi bevaka.</span></li>`;
    return;
  }
  let needsPoll = false;
  ul.innerHTML = state.dests.map((d) => {
    const res = results.get(d.id);
    if (!res) {
      return `<li class="dcard skeleton" data-id="${esc(d.id)}">
        <div class="sk box"></div>
        <div class="body"><div class="sk l1"></div><div class="sk l2"></div></div>
      </li>`;
    }
    const m = statusMeta(res);
    const elig = res.status === "eligible" ? "is-eligible" : "";
    const nj = nextJourney(res);
    // be om färsk data när pollens bästa resa avgått för länge sedan (eller allt cachat gått)
    const best = res.journeys?.[0];
    const bestGone = best && best.depEstMs != null && best.depEstMs < Date.now() - 20000;
    if (res.status !== "unknown" && res.journeys?.length && (!nj || bestGone)) needsPoll = true;
    const statusText = res.status === "eligible"
      ? `Taxi ~${kr(res.taxi.fare)} · ersätts av SL`
      : nj ? `${m.meta} · framme ${fmtClock(nj.arrEstMs)}`
           : m.meta;
    return `<li class="dcard ${elig}" data-id="${esc(d.id)}">
      <div class="stat ${m.cls}">${m.label}</div>
      <div class="body">
        <div class="name-row"><span class="name">${esc(d.name)}</span>${badges(res.lineObjs)}</div>
        <div class="meta">${statusText}</div>
      </div>
      <button class="remove" data-remove="${esc(d.id)}" aria-label="Ta bort ${esc(d.name)}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </li>`;
  }).join("");
  $$("#dest-cards .dcard").forEach((c) => c.onclick = (e) => {
    if (e.target.closest("[data-remove]")) return;
    const res = results.get(c.dataset.id);
    const d = state.dests.find((x) => x.id === c.dataset.id);
    openStatusSheet(d, res); // visar hela resan; berättigade får taxi-knapp i arket
  });
  $$("#dest-cards [data-remove]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.remove;
    const idx = state.dests.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const [removed] = state.dests.splice(idx, 1);
    const prevRes = results.get(id); results.delete(id);
    // Städa notis-spärrarna: läggs destinationen till igen senare ska den
    // bedömas som ny, inte ärva en gammal 25-minutersspärr.
    notifyStreak.delete(id);
    localStorage.removeItem(`fv:notified:${id}`);
    save(); renderDestCards(); renderHero();
    toast(`${removed.name} borttagen`, { label: "Ångra", fn: () => {
      state.dests.splice(Math.min(idx, state.dests.length), 0, removed);
      if (prevRes) results.set(id, prevRes);
      save(); renderDestCards(); renderHero();
    }});
  });
  if (needsPoll && !polling) poll();
}

function renderHero() {
  const hero = $("#hero"), body = $("#hero-body");
  const eligible = state.dests.map((d) => ({ d, res: results.get(d.id) })).filter((x) => x.res?.status === "eligible");
  const dot = $("#brand-dot");
  if (eligible.length) {
    const { d, res } = eligible.sort((a, b) => b.res.deltaMin - a.res.deltaMin)[0];
    hero.className = "hero eligible";
    dot.className = "dot"; // grön puls
    body.innerHTML = `
      <div class="hero-eyebrow"><span class="tx">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5zm2.2-.5h9.6l-1-3a.5.5 0 0 0-.5-.4H8.7a.5.5 0 0 0-.5.4l-1 3zM6.5 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
      </span> Gratis taxi tillgänglig</div>
      <h3>Ta taxi till ${esc(d.name)} ${badges(res.lineObjs, true)}</h3>
      <div class="sub">${esc(res.lines[0] || "SL")} är ~${res.deltaMin} min försenad just nu. Du har rätt till ersättning från SL.</div>
      <div class="estimate">
        <div><span class="k">Taxi (est.)</span><span class="v">${kr(res.taxi.fare)}</span></div>
        <div><span class="k">SL ersätter</span><span class="v">≤ ${kr(res.taxi.cap)}</span></div>
        <div><span class="k">Din kostnad</span><span class="v">${res.taxi.covered ? "0 kr" : kr(res.taxi.fare - res.taxi.cap)}</span></div>
      </div>
      <div class="hero-actions">
        <button class="btn primary" data-book>Visa resväg</button>
        <button class="btn ghost" data-claim>Spara bevis</button>
      </div>
      ${eligible.length > 1 ? `<div class="hero-more">+${eligible.length - 1} till berättigad just nu</div>` : ""}`;
    body.querySelector("[data-book]").onclick = () => bookTaxi(d);
    body.querySelector("[data-claim]").onclick = () => openClaimSheet(d, res);
  } else {
    const anyDelay = state.dests.some((d) => results.get(d.id)?.status === "delayed");
    hero.className = "hero calm";
    dot.className = anyDelay ? "dot warn" : "dot";
    const icon = anyDelay
      ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>`
      : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
    body.innerHTML = `
      <div class="calm-line">
        <div class="calm-check ${anyDelay ? "warn" : ""}">${icon}</div>
        <div>
          <div class="t">${anyDelay ? "Vissa förseningar" : "Allt rullar på"}</div>
          <div class="s">${anyDelay ? `Ännu inte över ${state.settings.threshold} min — vi bevakar.` : "Ingen ersättningsbar försening just nu."}</div>
        </div>
      </div>`;
  }
}

/* ---------- Polling ---------- */
async function poll(force = false) {
  if (polling) return;
  if (!state.dests.length) { renderHero(); return; }
  polling = true;
  $("#refresh")?.classList.add("spin");
  // Positionen hämtas inför varje poll, så utgångspunkten följer med dig.
  const origin = await resolveOrigin();
  renderOrigin();
  const { threshold, cap } = state.settings;
  let ok = 0;
  if (origin) {
    await Promise.allSettled(state.dests.map(async (d) => {
      try {
        const res = await evaluate({ home: origin, dest: d, threshold, cap });
        results.set(d.id, res);
        handleNotify(d, res);
        ok++;
      } catch (e) { /* behåll förra resultatet */ }
    }));
  }
  renderDestCards();
  renderHero();
  $("#net-banner").hidden = !(navigator.onLine === false || (ok === 0 && state.dests.length > 0));
  lastPollAt = Date.now(); nextPollAt = lastPollAt + 60000;
  $("#updated").textContent = fmtClock(lastPollAt);
  $("#refresh")?.classList.remove("spin");
  polling = false;
}
function startCountdown() {
  let tick = 0;
  setInterval(() => {
    if (polling) return;
    if (nextPollAt && Date.now() >= nextPollAt) { poll(); return; }
    if (++tick % 10 === 0) renderDestCards(); // välj om "nästa resa" mot klockan var 10:e sek
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    renderDestCards(); // välj om nästa resa direkt vid återkomst till appen
    if (Date.now() - lastPollAt > 45000) poll();
  });
  window.addEventListener("online", () => poll(true));
  window.addEventListener("offline", () => { $("#net-banner").hidden = false; });
}

/* ---------- Notiser ---------- */
function isActiveNow() {
  const { from, to } = state.settings;
  const now = new Date(); const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(":").map(Number), [th, tm] = to.split(":").map(Number);
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}
function handleNotify(d, res) {
  const eligible = res.status === "eligible" && (!state.settings.worthwhile || res.taxi.covered);
  const streak = eligible ? (notifyStreak.get(d.id) || 0) + 1 : 0;
  notifyStreak.set(d.id, streak);
  if (!eligible || streak < 2) return;                 // hysteres: minst 2 pollar i rad
  if (!state.settings.notify || !isActiveNow()) return;
  const last = Number(localStorage.getItem(`fv:notified:${d.id}`)) || 0;
  if (Date.now() - last < 25 * 60000) return;          // max 1 notis/25 min
  localStorage.setItem(`fv:notified:${d.id}`, String(Date.now()));
  fireNotification(
    `🚕 Gratis taxi till ${d.name}`,
    `${res.lines[0] || "SL"} ~${res.deltaMin} min sen. Taxi ~${kr(res.taxi.fare)}, ersätts av SL.`,
    `fv:${d.id}`
  );
}
async function fireNotification(title, body, tag = "fv") {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) reg.showNotification(title, { body, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag, renotify: true });
    else new Notification(title, { body, icon: "icons/icon-192.png" });
  } catch { try { new Notification(title, { body }); } catch {} }
}

/* ---------- Taxi ---------- */
function bookTaxi(d) {
  // Taxin ska hämta där du är, inte vid en gammal hemhållplats.
  const o = originNow()?.coord, t = d.coord;
  const url = o && t
    ? `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${t.lat},${t.lon}&travelmode=driving`
    : `https://www.google.com/maps/search/?api=1&query=taxi`;
  window.open(url, "_blank", "noopener");
  toast("Spara taxikvittot — du behöver det för ersättningen");
}

/* ================= SHEETS ================= */
function openSheet(html) {
  $("#sheet-content").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  $("#sheet .sheet").setAttribute("aria-label", $("#sheet h3")?.textContent || "Dialog");
  requestAnimationFrame(() => $("#sheet .sheet")?.focus());
}
function closeSheet() { $("#sheet").hidden = true; document.body.style.overflow = ""; }
$("#sheet [data-close]").onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

function openStatusSheet(d, res) {
  const nj = nextJourney(res);
  const legs = (nj && nj.legs) || res?.legs;
  const hasData = res && res.status !== "unknown" && legs && legs.length;
  let sub = "Ingen realtidsdata just nu — försök igen om en stund.";
  let chip = "";
  if (hasData) {
    const transit = legs.filter((l) => !l.walk);
    const byten = Math.max(0, transit.length - 1);
    const depMs = legs[0].depMs, arrMs = legs[legs.length - 1].arrMs;
    const durMin = depMs && arrMs ? Math.round((arrMs - depMs) / 60000) : null;
    sub = `Avgår ${fmtClock(depMs)}${durMin ? " · " + durMin + " min" : ""}${byten ? ` · ${byten} byte${byten > 1 ? "n" : ""}` : " · direkt"}`;
    const cls = res.status === "eligible" ? "elig" : res.status === "delayed" ? "delay" : "ok";
    const txt = res.status === "eligible" ? `Berättigad · +${res.deltaMin} min` : res.status === "delayed" ? `+${res.deltaMin} min` : "I tid";
    chip = `<span class="jstatus ${cls}">${txt}</span>`;
  }
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="jhead"><h3>${esc(d.name)}</h3>${chip}</div>
    <div class="sheet-sub">${sub}</div>
    ${journeyHTML(legs)}
    ${hasData && res.status !== "eligible" ? `<div class="sheet-hint"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5zm2.2-.5h9.6l-1-3a.5.5 0 0 0-.5-.4H8.7a.5.5 0 0 0-.5.4l-1 3zM6.5 15a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm11 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg><span>Rätt till en ersatt taxi om resan blir över ${state.settings.threshold} min försenad.</span></div>` : ""}
    <div class="sheet-actions">
      ${res?.status === "eligible" ? `<button class="btn primary" data-claim2>Ta taxi &amp; spara bevis</button>` : ""}
      <button class="btn ghost" data-close2>Stäng</button>
    </div>`);
  $("#sheet [data-close2]").onclick = closeSheet;
  const claimBtn = $("#sheet [data-claim2]");
  if (claimBtn) claimBtn.onclick = () => openClaimSheet(d, res);
}

function openClaimSheet(d, res) {
  const ev = res.evidence;
  const already = state.claims.some((c) => c.destId === d.id && Date.now() - c.createdAt < 3 * 3600e3);
  openSheet(`
    <div class="sheet-handle"></div>
    <h3>Bevis till ansökan</h3>
    <div class="sheet-sub">Allt SL behöver för din ersättning — samlat automatiskt.</div>
    <div class="evidence">
      <div class="row"><span class="k">Resa</span><span class="v">${esc(ev.homeName)} → ${esc(ev.destName)}</span></div>
      <div class="row"><span class="k">Tidtabell framme</span><span class="v">${fmtClock(ev.scheduledArrivalMs)}</span></div>
      <div class="row"><span class="k">Beräknad framme</span><span class="v">${fmtClock(ev.estimatedArrivalMs)}</span></div>
      <div class="row"><span class="k">Försening</span><span class="v">+${ev.delayMin} min</span></div>
      <div class="row"><span class="k">Linje</span><span class="v">${badges(ev.lineObjs) || esc(ev.lines[0] || "SL")}</span></div>
      ${ev.deviation ? `<div class="row"><span class="k">Störning</span><span class="v small">${esc(ev.deviation.header)}</span></div>` : ""}
      <div class="row"><span class="k">Taxi (uppskattat)</span><span class="v">${kr(ev.taxi.fare)}</span></div>
    </div>
    <div class="sheet-note">Du måste ha giltig SL-biljett och faktiskt genomföra resan. Spara taxikvittot i original. Ansök hos SL inom 3 månader.</div>
    <div class="sheet-actions">
      <button class="btn primary" data-save ${already ? "disabled" : ""}>${already ? "Redan sparat i plånboken" : "Spara i plånboken"}</button>
      <button class="btn ghost" data-sl>Öppna SL:s ansökan</button>
      <button class="btn ghost" data-book2>Visa resväg</button>
    </div>`);
  $("#sheet [data-save]").onclick = () => { saveClaim(d, res); closeSheet(); goto("wallet"); toast("Sparat i plånboken"); };
  $("#sheet [data-sl]").onclick = () => window.open("https://sl.se/kundservice/forseningsersattning", "_blank", "noopener");
  $("#sheet [data-book2]").onclick = () => bookTaxi(d);
}

function saveClaim(d, res) {
  const ev = res.evidence;
  state.claims.unshift({
    id: `${d.id}-${Date.now()}`, destId: d.id,
    routeName: `${ev.homeName} → ${ev.destName}`,
    homeName: ev.homeName, destName: ev.destName,
    createdAt: ev.capturedAt, deadlineMs: ev.capturedAt + 90 * 24 * 3600e3,
    delayMin: ev.delayMin, taxi: ev.taxi, deviation: ev.deviation,
    lines: ev.lines, lineObjs: ev.lineObjs, scheduledArrivalMs: ev.scheduledArrivalMs, estimatedArrivalMs: ev.estimatedArrivalMs,
    status: "todo",
  });
  save(); renderWallet();
}

/* ================= WALLET ================= */
function renderWallet() {
  const list = $("#claims"), empty = $("#claims-empty");
  const paid = state.claims.filter((c) => c.status === "paid").reduce((s, c) => s + (c.taxi?.fare || 0), 0);
  const pending = state.claims.filter((c) => c.status !== "paid").length;
  $("#wallet-summary").innerHTML = `
    <div class="card"><div class="k">Återfått</div><div class="v">${kr(paid)}</div></div>
    <div class="card"><div class="k">Att hantera</div><div class="v">${pending}</div></div>`;
  empty.hidden = state.claims.length > 0;
  list.hidden = state.claims.length === 0;
  const badge = { todo: ["todo", "Att skicka"], sent: ["sent", "Inskickad"], paid: ["paid", "Utbetald"] };
  list.innerHTML = state.claims.map((c) => {
    const days = Math.ceil((c.deadlineMs - Date.now()) / (24 * 3600e3));
    const [bc, bl] = badge[c.status];
    const next = c.status === "todo" ? ["sent", "Markera inskickad"] : c.status === "sent" ? ["paid", "Markera utbetald"] : null;
    return `<li class="claim" data-id="${c.id}">
      <div class="top">
        <div><div class="route">${badges(c.lineObjs)}${esc(c.destName)}</div><div class="when">${new Date(c.createdAt).toLocaleDateString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · +${c.delayMin} min · ${kr(c.taxi?.fare)}</div></div>
        <span class="badge ${bc}">${bl}</span>
      </div>
      ${c.status !== "paid" ? `<div class="deadline${days <= 14 ? " urgent" : ""}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>${days} dagar kvar att ansöka</div>` : ""}
      <div class="actions">
        ${next ? `<button class="btn ghost" data-adv="${next[0]}">${next[1]}</button>` : ""}
        <button class="btn ghost" data-open-sl>SL-ansökan</button>
        <button class="btn ghost icon-only" data-del aria-label="Ta bort">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div>
    </li>`;
  }).join("");
  $$("#claims .claim").forEach((li) => {
    const id = li.dataset.id;
    li.querySelector("[data-adv]")?.addEventListener("click", () => {
      const c = state.claims.find((x) => x.id === id); c.status = li.querySelector("[data-adv]").dataset.adv; save(); renderWallet();
    });
    li.querySelector("[data-open-sl]").addEventListener("click", () => window.open("https://sl.se/kundservice/forseningsersattning", "_blank", "noopener"));
    li.querySelector("[data-del]").addEventListener("click", () => { state.claims = state.claims.filter((x) => x.id !== id); save(); renderWallet(); });
  });
}

/* ================= SETTINGS ================= */
function renderSettings() {
  $("#set-home-current").textContent = state.home ? `Reserv: ${state.home.name}${state.home.locality ? " · " + state.home.locality : ""}` : "";
  $("#set-threshold").value = state.settings.threshold;
  $("#set-threshold-val").textContent = state.settings.threshold + " min";
  $("#set-from").value = state.settings.from; $("#set-to").value = state.settings.to;
  $("#set-notify").checked = state.settings.notify;
  $("#set-worthwhile").checked = state.settings.worthwhile;
  $("#cap-label").textContent = state.settings.cap.toLocaleString("sv-SE");
}
function bindSettings() {
  $("#set-threshold").oninput = (e) => { state.settings.threshold = +e.target.value; $("#set-threshold-val").textContent = e.target.value + " min"; save(); };
  $("#set-threshold").onchange = () => poll(true);
  $("#set-from").onchange = (e) => { state.settings.from = e.target.value; save(); };
  $("#set-to").onchange = (e) => { state.settings.to = e.target.value; save(); };
  $("#set-notify").onchange = async (e) => { state.settings.notify = e.target.checked; save(); if (e.target.checked) { try { await Notification.requestPermission(); } catch {} } };
  $("#set-worthwhile").onchange = (e) => { state.settings.worthwhile = e.target.checked; save(); };
  $$("#theme-seg button").forEach((b) => b.onclick = () => { state.settings.theme = b.dataset.theme; save(); applyTheme(); });
  $("#reset").onclick = () => {
    if (!confirm("Nollställ appen och radera all lokal data?")) return;
    localStorage.clear(); location.reload();
  };
}

/* ================= NAV / ADD DEST ================= */
function goto(view) {
  $$(".view").forEach((v) => v.hidden = v.dataset.view !== view);
  $$(".tabbar button").forEach((b) => {
    const on = b.dataset.goto === view;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  if (view === "wallet") renderWallet();
  if (view === "settings") renderSettings();
}
$$(".tabbar button").forEach((b) => b.onclick = () => goto(b.dataset.goto));
$("#refresh").onclick = () => poll(true);
$("#add-dest").onclick = () => openAddDest();

function openAddDest() {
  openSheet(`
    <div class="sheet-handle"></div>
    <h3>Lägg till destination</h3>
    <div class="sheet-sub">Sök en hållplats eller ett område du åker till.</div>
    <div class="field"><div class="combo"><input id="add-search" type="text" autocomplete="off" placeholder="Sök hållplats…" /><ul id="add-results" class="results" hidden></ul></div></div>
    <div class="sheet-actions"><button class="btn ghost" data-close3>Stäng</button></div>`);
  const input = $("#add-search");
  attachSearch(input, $("#add-results"), (s) => {
    if (!state.dests.some((d) => d.id === s.id)) { state.dests.push(s); save(); renderDestCards(); poll(true); toast(`${s.name} tillagd`); }
    closeSheet();
  });
  $("#sheet [data-close3]").onclick = closeSheet;
  setTimeout(() => input.focus(), 60);
}

/* ================= BOOT ================= */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
wireOnboarding();
if (state.configured && state.home) { $("#onboarding").hidden = true; $("#app").hidden = false; bootApp(); }
else startOnboarding();

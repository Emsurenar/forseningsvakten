// ============ SL API-klient (Trafiklab, nyckelfri, öppen CORS) ============
const JP = "https://journeyplanner.integration.sl.se/v2";
const DEV = "https://deviations.integration.sl.se/v1";

const ms = (iso) => (iso ? Date.parse(iso) : null);

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return res.json();
}

// --- Hållplatssökning -> [{id, name, disassembledName, coord:[lat,lon]}] ---
export async function stopFinder(q, signal) {
  const query = (q || "").trim();
  if (query.length < 2) return [];
  const url = `${JP}/stop-finder?name_sf=${encodeURIComponent(query)}&type_sf=any&any_obj_filter_sf=2`;
  const data = await getJSON(url, signal);
  return (data.locations || [])
    .filter((l) => l.type === "stop" && l.id)
    .slice(0, 7)
    .map((l) => ({
      id: l.id,
      name: l.disassembledName || l.name,
      full: l.name,
      locality: l.parent?.name || l.properties?.mainLocality || "",
      coord: l.coord ? { lat: l.coord[0], lon: l.coord[1] } : null,
    }));
}

// SL:s officiella linjefärger — det som får appen att kännas "på riktigt" för en stockholmare
export function lineColor({ mode, designation } = {}) {
  const d = parseInt(designation, 10);
  if (mode === "METRO") {
    if ([10, 11].includes(d)) return "#007db8"; // blå linjen
    if ([13, 14].includes(d)) return "#d71d24"; // röda linjen
    if ([17, 18, 19].includes(d)) return "#148541"; // gröna linjen
    return "#5a6472";
  }
  if (mode === "TRAIN") return "#e3006b";  // pendeltåg
  if (mode === "TRAM") return "#8659a5";   // spårväg/lokalbana
  if (mode === "SHIP") return "#00a0c6";   // sjötrafik
  if (mode === "BUS") return "#14638f";    // buss
  return "#5a6472";
}

// map SL:s produktnamn -> deviations transport_mode
export function modeForProductName(name = "") {
  const n = name.toLowerCase();
  if (n.includes("tunnelbana")) return "METRO";
  if (n.includes("pendel") || n.includes("tåg")) return "TRAIN";
  if (n.includes("spårväg") || n.includes("tram") || n.includes("lokalbana")) return "TRAM";
  if (n.includes("båt") || n.includes("färja") || n.includes("ship") || n.includes("ferry")) return "SHIP";
  return "BUS";
}

function isTransitLeg(leg) {
  const p = leg.transportation?.product;
  if (!p) return false;
  // gångben (Fussweg) har hög produktklass / saknar linjebeteckning
  if (p.class >= 96) return false;
  return !!leg.transportation?.disassembledName;
}

// --- Reseförslag hem -> destination, normaliserat med realtid ---
export async function trips(originId, destId, n = 3, signal) {
  n = Math.max(1, Math.min(3, n)); // JP v2 tillåter 1–3
  const url =
    `${JP}/trips?type_origin=any&name_origin=${encodeURIComponent(originId)}` +
    `&type_destination=any&name_destination=${encodeURIComponent(destId)}` +
    `&calc_number_of_trips=${n}`;
  const data = await getJSON(url, signal);
  const journeys = (data.journeys || [])
    .map((j) => {
      const legs = j.legs || [];
      if (!legs.length) return null;
      const first = legs[0].origin || {};
      const last = legs[legs.length - 1].destination || {};
      const transit = legs.filter(isTransitLeg);
      const lines = transit.map((l) => {
        const t = l.transportation;
        const mode = modeForProductName(t.product?.name);
        return {
          designation: t.disassembledName,
          productName: t.product?.name || "",
          mode,
          color: lineColor({ mode, designation: t.disassembledName }),
        };
      });
      const monitored = legs.some((l) =>
        (l.origin?.departureTimeEstimated && l.origin.departureTimeEstimated !== l.origin.departureTimePlanned) ||
        (l.destination?.arrivalTimeEstimated && l.destination.arrivalTimeEstimated !== l.destination.arrivalTimePlanned) ||
        (Array.isArray(l.realtimeStatus) && l.realtimeStatus.includes("MONITORED"))
      );
      const depP = ms(first.departureTimePlanned);
      const depE = ms(first.departureTimeEstimated) ?? depP;
      const arrP = ms(last.arrivalTimePlanned);
      const arrE = ms(last.arrivalTimeEstimated) ?? arrP;
      return {
        depPlannedMs: depP, depEstMs: depE,
        arrPlannedMs: arrP, arrEstMs: arrE,
        durationPlannedSec: j.tripDuration ?? null,
        durationRtSec: j.tripRtDuration ?? j.tripDuration ?? null,
        interchanges: j.interchanges ?? 0,
        lines, monitored,
      };
    })
    .filter(Boolean)
    .filter((j) => j.arrEstMs) // måste ha ankomsttid
    .sort((a, b) => a.arrEstMs - b.arrEstMs);
  return journeys;
}

// --- Störningar, normaliserade ---
// Dedup av *pågående* anrop: destinationer i samma pollcykel som delar mode-set
// delar ett enda nätverksanrop (respekterar SL:s fair-use ~1 anrop/min). TTL 45 s.
const _devCache = new Map(); // key -> { t, p }
export function deviations({ modes = [], sites = [] } = {}, signal) {
  const modeList = [...new Set(modes)].sort();
  const siteList = [...new Set(sites)].filter(Boolean).map(String).sort();
  const cacheKey = modeList.join(",") + "|" + siteList.join(",");
  const hit = _devCache.get(cacheKey);
  if (hit && Date.now() - hit.t < 45000) return hit.p;

  const p = (async () => {
    const params = new URLSearchParams();
    params.set("future", "false");
    modeList.forEach((m) => params.append("transport_mode", m));
    siteList.forEach((s) => params.append("site", s));
    const data = await getJSON(`${DEV}/messages?${params.toString()}`, signal);
    const now = Date.now();
    return (Array.isArray(data) ? data : [])
      .map((d) => {
        const v = (d.message_variants || []).find((x) => x.language === "sv") || d.message_variants?.[0] || {};
        return {
          id: d.deviation_case_id,
          header: v.header || v.scope_alias || "Störning",
          details: v.details || "",
          importance: d.priority?.importance_level ?? 0,
          influence: d.priority?.influence_level ?? 0,
          urgency: d.priority?.urgency_level ?? 0,
          from: ms(d.publish?.from),
          upto: ms(d.publish?.upto),
          lines: (d.scope?.lines || []).map((l) => ({
            designation: String(l.designation),
            mode: l.transport_mode,
            name: l.name,
          })),
        };
      })
      .filter((d) => (!d.from || d.from <= now) && (!d.upto || d.upto >= now));
  })();

  _devCache.set(cacheKey, { t: Date.now(), p });
  p.catch(() => { if (_devCache.get(cacheKey)?.p === p) _devCache.delete(cacheKey); }); // släpp cache vid fel
  return p;
}

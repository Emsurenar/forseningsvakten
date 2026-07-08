// ============ Berättigande-motor ============
import { trips, deviations } from "./sl.js";

const CAP_2026 = 1480; // 2,5 % av prisbasbeloppet 59 200 kr
const SOFT_MIN = 8; // band där vi visar "försenad" men inte berättigad
const DETOUR = 1.4; // fågelväg -> ungefärlig vägsträcka för taxi
const TAXI_BASE = 55, TAXI_PER_KM = 15;

function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function estimateTaxi(homeCoord, destCoord, cap = CAP_2026) {
  const straight = haversineKm(homeCoord, destCoord);
  if (straight == null) return { km: null, fare: null, cap, covered: true };
  const km = straight * DETOUR;
  const fare = Math.round((TAXI_BASE + TAXI_PER_KM * km) / 10) * 10;
  return { km: Math.round(km * 10) / 10, fare, cap, covered: fare <= cap };
}

// Utvärdera en resa hem -> destination. Returnerar status + bevis.
export async function evaluate({ home, dest, threshold = 20, cap = CAP_2026, signal }) {
  const journeys = await trips(home.id, dest.id, 3, signal);
  if (!journeys.length) return { status: "unknown", journeys: [] };

  // Föredra resor som faktiskt startar vid hemhållplatsen. SL kan annars returnera
  // resor från andra närliggande hållplatser (utan gångben dit), vilket blir missvisande.
  const norm = (s) => (s || "").toLowerCase().trim();
  const sameStop = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a)); };
  const fromHome = journeys.filter((j) => j.legs?.[0] && sameStop(j.legs[0].fromName, home.name));
  const best = (fromHome.length ? fromHome : journeys)[0]; // tidigast anländande som startar hemifrån
  const now = Date.now();

  // Försening = estimerad ankomst vs tidtabellsenlig ankomst för samma resa.
  // Väntetids-fritt (jämför en resa mot sin egen tidtabell), så en normal väntan
  // på nästa avgång inte felaktigt räknas som försening. Samma mått som SL:s
  // "beräknad ankomst" vs "tidtabell". Störningar korsvalideras separat nedan.
  const realtimeDelayMin = best.arrPlannedMs && best.arrEstMs
    ? Math.max(0, (best.arrEstMs - best.arrPlannedMs) / 60000) : 0;
  const deltaMin = Math.round(realtimeDelayMin);

  // Störningar på de linjer den valda resan faktiskt använder
  const modes = [...new Set(best.lines.map((l) => l.mode))];
  let matched = [];
  try {
    const devs = await deviations({ modes }, signal);
    const lineKeys = new Set(best.lines.map((l) => `${l.mode}:${l.designation}`));
    matched = devs
      .filter((d) => d.lines.some((l) => lineKeys.has(`${l.mode}:${l.designation}`)))
      .sort((a, b) => b.influence - a.influence || b.importance - a.importance);
  } catch { /* störnings-API ej kritiskt */ }

  const backed = best.monitored || matched.length > 0;
  let status = "ok";
  if (deltaMin >= threshold && backed) status = "eligible";
  else if (deltaMin >= SOFT_MIN) status = "delayed";

  const taxi = estimateTaxi(home.coord, dest.coord, cap);

  // deduplicerade, strukturerade linjer (med SL-färg) för brickor
  const seen = new Set(); const lineObjs = [];
  for (const l of best.lines) { const k = `${l.mode}:${l.designation}`; if (!seen.has(k)) { seen.add(k); lineObjs.push(l); } }

  const evidence = {
    homeName: home.name, destName: dest.name,
    capturedAt: now,
    scheduledArrivalMs: best.arrPlannedMs,
    estimatedArrivalMs: best.arrEstMs,
    normalDurationMin: best.durationPlannedSec ? Math.round(best.durationPlannedSec / 60) : null,
    delayMin: deltaMin,
    lines: [...new Set(lineObjs.map((l) => `${l.productName} ${l.designation}`.trim()))],
    lineObjs,
    deviation: matched[0] ? { header: matched[0].header, details: matched[0].details } : null,
    taxi,
  };

  return {
    status, deltaMin,
    nextDepartureMs: best.depEstMs,
    arrEstMs: best.arrEstMs, arrPlannedMs: best.arrPlannedMs,
    monitored: best.monitored,
    lines: evidence.lines, lineObjs, legs: best.legs,
    taxi, matched, evidence, journeys,
  };
}

export { CAP_2026 };

# Förseningsvakten 🚕

En minimalistisk PWA som säger till när du har rätt till en **ersatt taxiresa** vid SL-förseningar. Bygger på SL:s villkor: om du riskerar att bli **mer än 20 min försenad** till din slutdestination får du ta taxi/egen bil och få ersättning av SL (upp till 2,5 % av prisbasbeloppet ≈ **1 480 kr 2026**).

Ingen backend, inga konton, ingen server – allt körs i webbläsaren och sparas lokalt.

## Kör lokalt

```bash
cd "Egna projekt/SL"
python3 -m http.server 4173
# öppna http://localhost:4173
```

Push-notiser och service worker kräver `localhost` eller HTTPS (secure context). `file://` fungerar inte.

## Så funkar det

1. **Onboarding** – ange hemhållplats (sök, eller **"Använd min plats"** som via geolocation listar de närmaste hållplatserna av SL:s alla 6 500+), välj destinationsområden och aktiva tider.
2. **Bevakning** – var 60:e sekund frågar appen SL:s reseplanerare hem → varje destination och jämför **beräknad framkomst mot tidtabell**.
3. **Berättigande** – om förseningen är ≥ din gräns (standard 20 min) *och* den bekräftas av realtid eller en aktiv störning, blir destinationen "berättigad".
4. **Notis + bevis** – du får en push, och ett bevispaket (rutt, tider, försening, störningstext, taxikalkyl) samlas för din SL-ansökan. Plånboken påminner om 3-månadersgränsen.
5. **Resedetalj** – tryck på en destination för att se hela resan som en tidslinje (varje ben med SL:s linjefärg, riktning, tider, byten och gångsträckor).

### Algoritmen (engine.js)
- **Försening `Δ`** = estimerad ankomst − tidtabellsenlig ankomst för den *tidigast anländande* resan. Måttet är **väntetids-fritt** (en resa jämförs mot sin egen tidtabell), så en normal väntan på nästa avgång aldrig felaktigt räknas som försening. Samma mått som SL:s "beräknad ankomst" vs "tidtabell".
- **Grindar mot falsklarm**: kräver realtidsstöd (`MONITORED`) eller en matchande aktiv störning, samt hysteres (≥ 2 pollar i rad) innan notis; max 1 notis/25 min per destination.
- **Ekonomifilter**: uppskattar taxikostnaden och jämför mot taket; kan sättas att bara larma när taxin täcks helt.
- **Fair-use**: destinationer som delar trafikslag i samma pollcykel delar ett enda störnings-anrop.
- *Känd avgränsning:* en helt inställd tur där ersättningsturen råkar gå i tid underskattas (kräver en tidtabellsreferens utan realtid, t.ex. GTFS) — planerat till v2.

## SL:s API (Trafiklab, nyckelfria, öppen CORS)
- **Journey Planner v2** – `journeyplanner.integration.sl.se/v2/{stop-finder,trips}` (planerad vs. estimerad ankomst, `realtimeStatus`). `calc_number_of_trips` = 1–3.
- **Deviations** – `deviations.integration.sl.se/v1/messages` (störningar med drabbade linjer; max ~1 anrop/min).

## Design
Byggd för ändamålet, inte en generisk mall:
- **SL:s riktiga linjefärger** på linjebrickorna (röd/grön/blå linje, pendeltågsrosa, buss, spårväg) — samma visuella språk som SL-skyltar, så en stockholmare känner igen sig direkt.
- Systemnativ typografi (SF Pro på Apple), noggrann 4px-rytm, lager och fokusringar.
- Genomtänkta tillstånd: skelett-laddning, offline/fel-banner, ångra vid borttagning, tomma vyer.
- Komplett ljust/mörkt tema. Installbar som app (PWA) med egen ikon.

## Filer
| Fil | Ansvar |
|---|---|
| `index.html` / `styles.css` | Struktur + designsystem (ljust/mörkt) |
| `sl.js` | SL API-klient |
| `engine.js` | Berättigande-motor + taxikalkyl |
| `app.js` | UI, state, polling, notiser, plånbok |
| `sw.js` / `manifest.webmanifest` | PWA (offline + installerbar) |

## Deploy
Lägg filerna på valfri statisk host med HTTPS (t.ex. Netlify, Vercel, GitHub Pages). Vid uppdatering: höj `CACHE`-versionen i `sw.js`.

## Viktigt (juridik)
Verktyget drivs inte av SL. Ersättning betalas ut av SL enligt deras villkor. Du måste ha **giltig biljett** och **faktiskt genomföra resan**; spara taxikvittot i original och ansök inom 3 månader. Ansök direkt hos SL – bolaget har nekat ersättning via mellanhänder.

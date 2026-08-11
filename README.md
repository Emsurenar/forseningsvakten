# Förseningsvakten

Förseningsvakten säger till när en SL-försening ger dig rätt till en taxiresa som SL betalar. Enligt SL:s villkor får du ta taxi eller egen bil om du riskerar att bli mer än 20 minuter försenad till din slutdestination, och sedan få ersättning i efterhand (2,5 % av prisbasbeloppet, vilket är 1 480 kr under 2026).

Appen kör helt i webbläsaren. Ingen server och inga konton – all data sparas lokalt på enheten.

Live: https://emsurenar.github.io/forseningsvakten/

## Kör lokalt

Servera mappen över localhost eller HTTPS. Det krävs för service worker och notiser; `file://` fungerar inte.

```bash
python3 -m http.server 4173
```

Öppna sedan http://localhost:4173.

## Så fungerar det

Appen utgår alltid från din nuvarande position: inför varje kontroll hämtas platsen och närmaste hållplats blir resans start. En reservhållplats (väljs vid start) används när platsen inte kan hämtas. Var 60:e sekund frågar appen SL:s reseplanerare om resan därifrån till varje destination du valt och jämför beräknad ankomst mot tidtabell.

Blir förseningen större än din gräns (20 minuter som standard), och bekräftas den av realtidsdata eller en aktiv störning, markeras destinationen som berättigad. Du får en notis och appen samlar ett underlag för ansökan: rutt, tider, försening, störningstext och en uppskattad taxikostnad. Plånboken håller reda på ärendena och påminner om tremånadersgränsen.

Tryck på en destination för att se hela resan, delsträcka för delsträcka, med linje, riktning, tider och byten.

## Så beräknas förseningen

Förseningen är estimerad ankomst minus tidtabellsenlig ankomst för den tidigast anländande resan. Eftersom en resa jämförs mot sin egen tidtabell räknas inte en vanlig väntan på nästa avgång som försening.

För att undvika falsklarm krävs realtidsdata eller en matchande störning, och förseningen måste hålla i sig två avläsningar i rad innan en notis skickas. En känd begränsning är att en helt inställd avgång, där ersättningsturen råkar gå i tid, underskattas; det skulle kräva en tidtabellsreferens utan realtid (GTFS).

## SL:s API

Öppna, nyckelfria API:er från Trafiklab:

- Journey Planner v2 (`journeyplanner.integration.sl.se/v2`) – hållplatssök och reseförslag med realtid
- Deviations (`deviations.integration.sl.se/v1`) – störningar
- Transport (`transport.integration.sl.se/v1/sites`) – hållplatser med koordinater, för att hitta närmaste

## Struktur

| Fil | Innehåll |
|---|---|
| `index.html`, `styles.css` | Struktur och stil |
| `sl.js` | Klient mot SL:s API:er |
| `engine.js` | Berättigandelogik och taxiuppskattning |
| `app.js` | Gränssnitt, tillstånd, polling, notiser, plånbok |
| `sw.js`, `manifest.webmanifest` | Service worker och PWA-manifest |

## Deploy

Rena statiska filer som kan ligga på valfri host med HTTPS. Höj `CACHE`-versionen i `sw.js` vid varje uppdatering så att klienter hämtar de nya filerna.

## Juridik

Verktyget drivs inte av SL, och ersättningen betalas ut av SL enligt deras villkor. Du måste ha giltig biljett och faktiskt genomföra resan. Spara originalkvittot och ansök inom tre månader, direkt hos SL – ersättning via mellanhänder har nekats.

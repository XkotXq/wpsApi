// Does a real "Rozmiar szpuli: ..." line from CIP resolve to a real drum in
// the catalog?
//
// This is the step between "CIP knows which reel the cable ships on" and
// "Zamówienie szpul" offering it: CIP keeps the drum as free text inside one
// of its opRequest* fields, and the only way it becomes a selectable item is
// extractSpoolSizeSegments + splitLengthLabel + matchDrumCatalog, all pure
// string work over the catalog's own "Drum" rows.
//
// Worth its own script because the alternative is a live CIP token and a
// production order that happens to have the shape you want to check, every
// time somebody touches that matching.
//
//   node scripts/check-drum-match.mjs
//
// Needs only the database (for the catalog), never CIP.

import { config } from "dotenv";

// Same env precedence as scripts/migrate.mjs: .env, then .env.local on top.
config({ path: ".env" });
config({ path: ".env.local", override: true });

// Dynamic imports, for the reason migrate.mjs gives: a static import is
// hoisted above the config() calls and would open a pool with no
// DATABASE_URL.
const { extractSpoolSizeSegments } = await import("../src/cip.js");
const { splitLengthLabel, matchDrumCatalog } = await import("../src/routes/cipOrders.js");
const { drumCatalogEntries } = await import("../src/smCatalog.js");
const { pool } = await import("../src/db.js");

// Real text, as it arrives from CIP. The first is the one reported on
// 2026-10-06 as not producing a spool; the rest cover the shapes the
// matching is supposed to handle (a length-labelled split run, a code with
// no leading "W", a plain single drum).
const CASES = [
  {
    name: "pełne wymagania procesowe, szpula na końcu",
    field: "opRequestSh",
    text:
      "Użyj tymczasowej karty procesowej na linii SH / Użyj 2*1.6*1.7 Coated FRP / " +
      "Zwróć uwagę na napięcie FRP na pay offie / Użyj nici według karty procesowej / " +
      "Metoda blokowania wody: Water blocking yarn i Water blocking tape / Czarne importowane HDPE / " +
      "Grubość ścianki oblewu: nom. 2.0mm / Średnica kabla: 8.8±0.5 mm / Biały nadruk ink-jet / " +
      "Dokumenty z nadrukami i wymaganiami pakowania są w załącznikach / " +
      "Rozmiar szpuli: W1250B II 1250*800*740",
    expect: ["Wooden drum W1250B II"],
  },
  {
    name: "dwie szpule z etykietami długości",
    field: "opRequestSh",
    text: "Rozmiar szpuli: 4km: 1250B 1250*650*740 ; 2km: 1120B II 1120*650*740",
    // "1250B" resolves to "Wooden drum W1250B" by the missing-leading-W
    // rule, not to the "special barrel" entry - that one's own code is
    // "580". Confirmed against the real catalog.
    expect: ["Wooden drum W1250B", "Wooden drum W1120B II"],
  },
  {
    name: "pojedyncza szpula, kod bez wiodącego W",
    field: "opRequestSc",
    text: "Rozmiar szpuli: 600A 600X400X340",
    expect: ["Wooden drum W600A"],
  },
];

let failures = 0;

function report(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "BŁĄD"} ${label}${detail ? ` - ${detail}` : ""}`);
}

const drums = await drumCatalogEntries();
console.log(`Szpul w katalogu: ${drums.length}\n`);
if (drums.length === 0) {
  console.log("Katalog nie ma kategorii 'Drum' - nic nie da się dopasować.");
  await pool.end();
  process.exit(1);
}

for (const testCase of CASES) {
  const segments = extractSpoolSizeSegments({ [testCase.field]: testCase.text });
  report(
    segments.length === testCase.expect.length,
    `${testCase.name}: segmentów`,
    `${segments.length}, oczekiwano ${testCase.expect.length}`
  );

  segments.forEach((segment, i) => {
    const { label, rest } = splitLengthLabel(segment);
    const drum = matchDrumCatalog(rest, drums);
    const wanted = testCase.expect[i];
    if (!drum) {
      report(false, `  segment "${segment}"`, "nic nie dopasowano");
      return;
    }
    // The matched name carries the order's own dimensions appended, so the
    // check is on the catalog name it starts with.
    report(
      drum.name.startsWith(wanted),
      `  segment "${segment}"`,
      `→ ${drum.itemCode} ${drum.name}${label ? ` [${label}]` : ""}`
    );
  });
  console.log("");
}

await pool.end();
console.log(failures === 0 ? "Wszystko dopasowane." : `${failures} niepowodzeń.`);
process.exit(failures === 0 ? 0 : 1);

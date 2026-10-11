// Asserts how "Postęp produkcji" reads the planners' pasted list and how it
// turns a CIP row into "how much in total / how much left to make"
// (src/productionProgress.js).
//
//   node scripts/check-production-progress.mjs
//
// Needs neither the database nor CIP: both halves are pure functions, and
// the row shapes below are real ones, captured live from
// /cppms/orderProcessCount/page/search on 2026-10-08 (order
// 260010303024501 and order 20260401). That is the whole point of this
// script - the alternative is a live CIP token and a production order that
// happens to be half-finished, every time somebody touches this.

import {
  groupBomMaterials,
  groupBomMaterialsByProcess,
  daySharesForLine,
  frpRollsForDay,
  isFrpName,
  presentMaterialKeys,
  parseErpNumber,
  parsePastedProgressList,
  perKmConsumption,
  presentProcessKeys,
  processForLine,
  rowProcesses,
  rowProgress,
} from "../src/productionProgress.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// ─── The pasted list ────────────────────────────────────────────────────────
// Exactly as it was handed over: the line unindented, its positions indented
// under it, and trailing spaces on the line rows.
const PASTED = `ST01
    CF-260010303028101-544182
    CF-260010303025401-544327
    CF-260010303040401-553193
    CF-260010309025101-520495
ST02
    CF-260010309032401-546085
    CF-260010303025401-544327
    CF-260010303025501-544075
ST03
    CF-260010309034001-544258
    CF-260010303024501-544069
    CF-260010303024501-544070
    CF-260010303024501-544071
    CF-260010303024501-544072
    CF-260010303024501-544073
    CF-260010303024501-544062
    CF-260010309034801-547217
ST04
    CF-260010309034501-545121
    CF-260010303029001-545119
    CF-260010303025401-544328
    CF-260010309034101-544261
    CF-260010309034201-544259
    CF-260010303033201-550030
    CF-260010303041801-553268
    CF-260010303041901-553267
ST05
    CF-260010303025401-544328
    CF-260010303025501-544075
ST06
    CF-260010309034801-547217`;

console.log("Lista wklejona przez planistów:");
const entries = parsePastedProgressList(PASTED);
check("every position is read", entries.length === 26, `${entries.length} pozycji`);
check("every position lands on a line", entries.every((e) => e.line), `${entries.filter((e) => !e.line).length} bez linii`);
check("the lines are the six pasted", new Set(entries.map((e) => e.line)).size === 6, [...new Set(entries.map((e) => e.line))].join(","));

const st03 = entries.filter((e) => e.line === "ST03");
check("a position belongs to the line above it, not the one below", st03.length === 8, `ST03: ${st03.length}`);
check("the order number is the middle segment", st03[1]?.orderNumber === "260010303024501", st03[1]?.orderNumber);
check("the position is the last segment", st03[1]?.position === "544069", st03[1]?.position);

// The dedup that keeps a 26-position paste down to 16 CIP searches.
const distinct = new Set(entries.map((e) => e.orderNumber));
check("one order is counted once however often it is listed", distinct.size === 16, `${distinct.size} zleceń`);

// The same list out of Excel: line and position in two tab-separated
// columns, every row carrying its own line, no indentation anywhere.
const TAB_PASTED = ["ST01\tCF-260010303028101-544182", "ST01\tCF-260010303025401-544327", "ST02\tCF-260010309032401-546085"].join("\n");
const tabbed = parsePastedProgressList(TAB_PASTED);
check("a two-column (Excel) paste reads the same way", tabbed.length === 3 && tabbed[2].line === "ST02", JSON.stringify(tabbed.map((e) => e.line)));

// Indentation lost in transit (a textarea, a mail client) must not move a
// position onto the wrong line - the line header is still on its own row.
const FLAT = "ST01\nCF-260010303028101-544182\nST02\nCF-260010309032401-546085";
const flat = parsePastedProgressList(FLAT);
check("a paste that lost its indentation still groups correctly", flat.length === 2 && flat[0].line === "ST01" && flat[1].line === "ST02", JSON.stringify(flat.map((e) => e.line)));

check("junk with no position in it yields nothing", parsePastedProgressList("Dzień dobry,\nproszę o listę.").length === 0);
check("a bare order number is not a job number", parseErpNumber("260010303024501") === null);
check("the letter prefix is not assumed to be CF", parseErpNumber("XY-260010303024501-544069")?.orderNumber === "260010303024501");

// ─── Pasting order numbers instead of job numbers ───────────────────────────
// The list is also kept as plain order numbers, which is the form these
// people always have to hand. One of those stands for every line of the
// order, so it carries no erpNumber of its own.
console.log("\nLista wklejona numerami zamówień:");

const byOrderNumber = parsePastedProgressList("ST01\n    260010303028101\n    260010303025401\nST02\n    20260401");
check("a bare order number is read as an entry", byOrderNumber.length === 3, `${byOrderNumber.length}`);
check("it carries no job number", byOrderNumber.every((e) => e.erpNumber === null));
check("it still lands on its line", byOrderNumber.map((e) => e.line).join(",") === "ST01,ST01,ST02", byOrderNumber.map((e) => e.line).join(","));
check("an 8-digit order number is accepted too", byOrderNumber[2]?.orderNumber === "20260401", byOrderNumber[2]?.orderNumber);

// Both forms in one paste, which is what a half-updated list looks like.
const mixed = parsePastedProgressList("ST03\n    CF-260010303024501-544069\n    260010309034801");
check("both forms work in one paste", mixed.length === 2, String(mixed.length));
check("the job number keeps its own position", mixed[0].erpNumber === "CF-260010303024501-544069" && mixed[0].position === "544069");
check("the order number does not invent one", mixed[1].erpNumber === null && mixed[1].orderNumber === "260010309034801");

// A row carrying a job number must not also be read as a bare order number:
// its own middle segment matches that pattern too.
const noDoubleRead = parsePastedProgressList("ST01\tCF-260010303028101-544182");
check("a job number is not counted twice", noDoubleRead.length === 1, JSON.stringify(noDoubleRead));
check("and its line is still read off the same row", noDoubleRead[0].line === "ST01", String(noDoubleRead[0].line));

// Six digits is a position, not an order - a stray one must not be looked
// up as if it were an order number.
check("a bare six-digit number is not taken for an order", parsePastedProgressList("ST01\n    544182").length === 0, JSON.stringify(parsePastedProgressList("ST01\n    544182")));

// Two columns of order numbers, straight out of the grid/Excel.
const twoColOrders = parsePastedProgressList("ST01\t260010303028101\nST02\t260010309034801");
check("the two-column form works with order numbers", twoColOrders.length === 2 && twoColOrders[1].line === "ST02", JSON.stringify(twoColOrders.map((e) => e.line)));

// ─── Progress out of a CIP row ──────────────────────────────────────────────
// Real rows, trimmed to the fields this reads. Note layersFinishedLength
// equals totalLength in every one of them, finished or not - which is
// exactly why it must not be read as "produced".
const row = (totalLength, notFinished, { stage = "shProcess" } = {}) => ({
  totalLength,
  [stage]: {
    orderProcessLayers: [
      {
        processLayers: "1",
        layersFinishedLength: totalLength.toFixed(4),
        layersNotFinishedLength: notFinished.toFixed(4),
      },
    ],
  },
});

console.log("\nPostęp z wiersza CIP:");

// CF-260010303024501-544067, opStatus 5.
const done = rowProgress(row(44, 0));
check("a finished line reads as made in full", done.producedLength === 44 && done.remainingLength === 0, JSON.stringify(done));
check("and as 100%", done.percent === 100, String(done.percent));

// CF-260010303024501-544066, opStatus 4 - the one row that was genuinely
// part-made, and so the only real proof of the arithmetic.
const partial = rowProgress(row(44, 4));
check("a part-made line reports what is left", partial.remainingLength === 4, JSON.stringify(partial));
check("and what is already made", partial.producedLength === 40);
check("and the percentage to one decimal", partial.percent === 90.9, String(partial.percent));

// CF-260010303024501-544073, opStatus 4, nothing started.
const fresh = rowProgress(row(12, 12));
check("an unstarted line reads as nothing made", fresh.producedLength === 0 && fresh.remainingLength === 12, JSON.stringify(fresh));
check("and as 0%, not 100%", fresh.percent === 0, String(fresh.percent));

// The trap this whole module exists to avoid.
check(
  "layersFinishedLength is never mistaken for the amount produced",
  rowProgress(row(60, 60)).producedLength === 0,
  "60/60 musi znaczyć 0 zrobione"
);

// Stranding is counted in core km (a 12 km row reports 72), so a row
// carrying only that stage must not be reported as made - let alone as 600%.
const strandedOnly = rowProgress(row(12, 0, { stage: "scProcess" }));
check("a row without the sheathing stage reports unknown, not zero left", strandedOnly.remainingLength === null, JSON.stringify(strandedOnly));
check("and no percentage at all", strandedOnly.percent === null, String(strandedOnly.percent));

// Two sheath layers: the one furthest behind decides, and the figure stays
// inside the cable's own length instead of summing to more than it.
const twoLayers = rowProgress({
  totalLength: 40,
  shProcess: {
    orderProcessLayers: [
      { layersFinishedLength: "40.0000", layersNotFinishedLength: "0.0000" },
      { layersFinishedLength: "40.0000", layersNotFinishedLength: "10.0000" },
    ],
  },
});
check("with several layers the one furthest behind decides", twoLayers.remainingLength === 10, JSON.stringify(twoLayers));
check("and the result never exceeds the run itself", twoLayers.producedLength === 30);

// CF-260010309034801-547217, live: 997.5 km with 665.7 left. Subtracting
// those two in binary floating point gives 331.79999999999995, which is not
// a length to put on a screen.
const longRun = rowProgress(row(997.5, 665.7));
check("a decimal run does not produce a float artefact", longRun.producedLength === 331.8, String(longRun.producedLength));

// CIP occasionally reports more outstanding than the row is long; clamped so
// a screen never shows a negative amount produced.
check("more left than the run is long is clamped", rowProgress(row(10, 25)).producedLength === 0, JSON.stringify(rowProgress(row(10, 25))));

// ─── Every process stage on a row ───────────────────────────────────────────
// A real row: CF-260010303024501-544073, a 12 km run. Four of CIP's fifteen
// stages carry figures, the other eleven are null - and SC is in its own
// unit (72 = the run times the six elements it strands).
console.log("\nEtapy procesu na wierszu:");

const layerStage = (planned, remaining) => ({
  yesNoTest: "1",
  orderProcessLayers: [
    {
      processLayers: "1",
      layersFinishedLength: planned.toFixed(4),
      layersNotFinishedLength: remaining.toFixed(4),
      defectiveLengthSum: "0.0000",
      actualFinishedTime: remaining === 0 ? "2026-10-02 15:19:38" : null,
    },
  ],
});

const realRow = {
  totalLength: 12,
  scProcess: layerStage(72, 0),
  szProcess: layerStage(12, 12),
  shProcess: layerStage(12, 12),
  // DP reports flat, with no layers at all - and the same naming trap.
  dpProcess: { finishedLength: "12.0000", notFinishedLength: "12.0000", defectiveLengthSum: "0.0000" },
  clProcess: null,
  rlProcess: null,
  uuProcess: null,
};

const processes = rowProcesses(realRow);
check("only the stages with figures are returned", Object.keys(processes).join(",") === "sc,sz,sh,dp", Object.keys(processes).join(","));
check("a stage is measured against its own planned amount, not the run", processes.sc.percent === 100, `${processes.sc.percent}% przy planie ${processes.sc.planned}`);
check("so stranding does not read as 600% of a 12 km run", processes.sc.planned === 72 && processes.sc.remaining === 0);
check("an unstarted stage reads 0%, not 100%", processes.sh.percent === 0, String(processes.sh.percent));
check("it reports what is left and what that is out of", processes.sh.remaining === 12 && processes.sh.planned === 12);
check("the flat shape (DP) is read the same way", processes.dp.percent === 0 && processes.dp.remaining === 12, JSON.stringify(processes.dp));
check("a finished stage keeps when it finished", processes.sc.finishedAt === "2026-10-02 15:19:38", String(processes.sc.finishedAt));

// Whether a stage is counted in the cable own kilometres, so a caller
// knows when it may write "km" next to the figure. SC must never be: it
// plans the run times the elements it strands.
check("a stage planning the run length is in cable km", processes.sh.inRunKm === true);
check("and so are the other two that match it", processes.sz.inRunKm === true && processes.dp.inRunKm === true);
check("stranding is not, so its figure is never labelled km", processes.sc.inRunKm === false, String(processes.sc.planned));

// A stage CIP sends as an object but with nothing in it is no more a
// completion state than a null one.
check("a present but empty stage counts as no data", rowProcesses({ shProcess: layerStage(0, 0) }).sh === undefined);
check("a null stage counts as no data", rowProcesses({ shProcess: null }).sh === undefined);

// Which columns a whole result should show.
const keysShown = presentProcessKeys([
  { processes: rowProcesses(realRow) },
  { processes: rowProcesses({ shProcess: layerStage(40, 10), uuProcess: layerStage(16, 0) }) },
  { processes: {} },
]);
check("the columns are the union over every position", keysShown.join(",") === "sc,sz,sh,uu,dp", keysShown.join(","));
check("a stage null on every position is left out", !keysShown.includes("cl") && !keysShown.includes("tb"), keysShown.join(","));
check("and they come back in CIP's own order, not first-seen order", keysShown.indexOf("sz") < keysShown.indexOf("sh"), keysShown.join(","));
check("nothing at all yields no columns", presentProcessKeys([{ processes: {} }]).length === 0);

// ─── What counts as FRP ─────────────────────────────────────────────────────
// Real names, both sides: the first group is from the live catalog (the
// three odd ones are the "GLYCL"/"PL-MAT" rows that a category check would
// miss), the second from a real BOM of order 260010303024501.
console.log("\nRozpoznawanie FRP po nazwie:");

for (const name of [
  "FRP/Ф1.6mm",
  "FRP 2.5mm/VIP",
  "2.2mmFRP/suppleness-FRP",
  "Coated FRP 1.8*1.9-H-M (High Module)",
  "FRP 3.4mm/VIP",
  "GFRP/0.7*0.75mm",
  "FRP with steel wire reinforced Φ0.45mm×1.5mm",
]) {
  check(`"${name}" is FRP`, isFrpName(name));
}

for (const name of [
  "Wooden drum W900B 900*500*740",
  "General tube filling gel",
  "YOFC G652D Fiber - White",
  "PBTP for micro cable tube",
  "PBTP Masterbatch Red/micro cable",
  "Glass Yarn/600tex",
  "",
]) {
  check(`"${name || "(puste)"}" is not FRP`, !isFrpName(name));
}

// ─── Sorting a BOM into material groups ─────────────────────────────────────
// Real catalog rows, chosen because each one would be sorted wrongly by the
// other group's rule. The two groups match on different signals on purpose
// (see MATERIAL_GROUPS) and this is what pins that.
console.log("\nGrupy materiałów z BOM:");

const bom = [
  { itemNo: "993916000000119", name: "FRP/Ф1.6mm", category: "FRP" },
  // FRP filed under another category - found by name, missed by category.
  { itemNo: "993916000000999", name: "FRP with steel wire reinforced Φ0.45mm×1.5mm", category: "PL-MAT" },
  { itemNo: "993901000000009", name: "HDPE Black/SCG", category: "PE" },
  { itemNo: "993901000000053", name: "PE Masterbatch/Green RAL6018/Anti-UV", category: "PE" },
  // The same job as PE, on a flame-retardant build - twice as many of these
  // in the catalog as there are PE ones, so the group has to take both.
  { itemNo: "993902000000001", name: "LSZH flame retardant jacket material/FZD-8001 black", category: "LSZH" },
  // "PE" in the name, nothing to do with PE - found by neither rule.
  { itemNo: "993907000000001", name: "TPEE Masterbatch/Blue", category: "TPEE Masterbatch" },
  { itemNo: "993907000000002", name: "TPEE/Natural", category: "TPEE" },
  // Colourant *for* PE, its own category - not PE itself.
  { itemNo: "993907000000003", name: "PE Materbatch/Black", category: "PE Materbatch" },
  { itemNo: "110200100000109", name: "YOFC G652D Fiber - White", category: "Fiber" },
];

const grouped = groupBomMaterials(bom);
check("FRP is found by name, whatever its category", grouped.frp.map((m) => m.itemNo).join(",") === "993916000000119,993916000000999", grouped.frp.map((m) => m.itemNo).join(","));
check(
  "the jacket group is found by category, PE and LSZH alike",
  grouped.jacket.map((m) => m.itemNo).join(",") === "993901000000009,993901000000053,993902000000001",
  grouped.jacket.map((m) => m.itemNo).join(",")
);
check("TPEE is not a jacket compound, even though its name contains PE", !grouped.jacket.some((m) => /TPEE/.test(m.name)), JSON.stringify(grouped.jacket.map((m) => m.name)));
check('"PE Materbatch" is a colourant, not a jacket compound', !grouped.jacket.some((m) => m.category === "PE Materbatch"));
check("fibre is in neither group", !grouped.frp.concat(grouped.jacket).some((m) => /Fiber/.test(m.name)));
check("a position needing none of a kind gets an empty array, not a missing key", JSON.stringify(groupBomMaterials([])) === '{"frp":[],"jacket":[]}', JSON.stringify(groupBomMaterials([])));

// The groups are not exclusive - nothing downstream may assume they are.
const both = groupBomMaterials([{ itemNo: "1", name: "Coated FRP sheath", category: "PE" }]);
check("a material can belong to two groups at once", both.frp.length === 1 && both.jacket.length === 1);

const materialKeysShown = presentMaterialKeys([
  { materials: { frp: [{ itemNo: "1" }], jacket: [] } },
  { materials: { frp: [{ itemNo: "2" }], jacket: [] } },
]);
check("a group nothing in the paste needs is not a column", materialKeysShown.join(",") === "frp", materialKeysShown.join(","));
check(
  "a group even one position needs is a column",
  presentMaterialKeys([{ materials: { frp: [], jacket: [{ itemNo: "1" }] } }]).join(",") === "jacket"
);
check("and the columns keep their defined order", presentMaterialKeys([{ materials: { jacket: [{}], frp: [{}] } }]).join(",") === "frp,jacket");

// ─── A day's run: what it takes of each FRP, and how many rolls ─────────────
// A line gets through 55 km of cable a day and works its positions in the
// order they were pasted; a roll holds 48.8 km of FRP and cannot be shared
// between two machines running at the same time.
console.log("\nFRP na zmianę:");

const dayStage = (remaining, inRunKm = true) => ({ remaining, planned: 200, percent: 0, inRunKm });
const onLine = (line, remaining, itemNo, name, perKm = 1.017, inRunKm = true) => ({
  line,
  lineProcess: "sz",
  processes: { sz: dayStage(remaining, inRunKm) },
  materials: { frp: [{ itemNo, name, unit: "KM", perKm }], jacket: [] },
});

// Their own example: 35 km left on one position, 45 km on the next.
const st01 = [onLine("ST01", 35, "A", "FRP 1.6xb"), onLine("ST01", 45, "A", "FRP 1.6xb")];
const shares = daySharesForLine(st01);
check(
  "the day is spent in queue order, finishing one position before starting the next",
  shares.map((s) => s.km).join("+") === "35+20",
  shares.map((s) => s.km).join("+")
);
check("and it adds up to the day, never to more", shares.reduce((a, s) => a + s.km, 0) === 55);

const oneLine = frpRollsForDay(st01);
check("a day of 55 km takes 55.935 km of FRP", oneLine[0].needed === 55.935, String(oneLine[0].needed));
check("which is two rolls of 48.8, not one", oneLine[0].rolls === 2, String(oneLine[0].rolls));

// Two lines on the same FRP cannot share a roll, so rolls add up per line.
const manyLines = frpRollsForDay([
  ...st01,
  onLine("ST02", 90, "A", "FRP 1.6xb"),
  onLine("ST04", 70, "B", "FRP 2.5/VIP"),
]);
const shared = manyLines.find((r) => r.itemNo === "A");
check("rolls are counted per line and never pooled", shared.rolls === 4, String(shared.rolls));
check(
  "and each line keeps its own share",
  shared.lines.map((l) => l.line + ":" + l.rolls).join(",") === "ST01:2,ST02:2",
  JSON.stringify(shared.lines)
);
check("a second FRP is counted on its own", manyLines.find((r) => r.itemNo === "B").rolls === 2);
check("the biggest demand comes first", manyLines[0].itemNo === "A");

// Less than a roll still needs a roll.
const small = frpRollsForDay([onLine("ST01", 10, "A", "FRP 1.6xb")]);
check("ten kilometres is one roll, not a fraction of one", small[0].rolls === 1 && small[0].needed === 10.17, JSON.stringify(small[0]));

// Stranding is not counted in cable km, so a daily capacity in km cannot be
// handed out against its figures at all.
check(
  "a stage that is not in cable km gets no share of the day",
  daySharesForLine([
    { line: "SC01", lineProcess: "sc", processes: { sc: dayStage(40, false) }, materials: { frp: [], jacket: [] } },
  ]).length === 0
);
check("a line with nothing left takes nothing", frpRollsForDay([onLine("ST01", 0, "A", "FRP")]).length === 0);
check(
  "a line whose stage is unknown is skipped",
  frpRollsForDay([{ line: "FL01", lineProcess: null, processes: {}, materials: { frp: [], jacket: [] } }]).length === 0
);
check("nothing in, nothing out", frpRollsForDay([]).length === 0);

// ─── Consumption per kilometre of cable ─────────────────────────────────────
// Real BOM figures. The three FRP rows are the ones where CIP's own `qty`
// (1.017) agrees; the gel is the one that proves `qty` cannot be used
// directly, since its base is twice the run.
console.log("\nZużycie na kilometr:");

check("FRP on a 997.5 km run", perKmConsumption(1014.4575, 997.5) === 1.017, String(perKmConsumption(1014.4575, 997.5)));
check("the same FRP figure on a 168 km run", perKmConsumption(170.856, 168) === 1.017);
check("and on a 36 km one", perKmConsumption(36.612, 36) === 1.017);
check(
  "gel comes out per cable km, not per CIP's own unit",
  perKmConsumption(1112.830092, 198) === 5.6204,
  `${perKmConsumption(1112.830092, 198)} (CIP qty tam to 2.810177)`
);
check("no run length, no figure", perKmConsumption(100, 0) === null && perKmConsumption(100, null) === null);
check("nothing required, no figure", perKmConsumption(null, 198) === null && perKmConsumption(0, 198) === null);

// ─── Which stage a production line runs ─────────────────────────────────────
// Not derivable from anything CIP sends - given by the people who run the
// lines (2026-10-09) and written down server-side so two clients cannot
// disagree about it.
console.log("\nEtap przypisany do linii:");

check("every ST line strands", ["ST01", "ST07", "ST13"].every((l) => processForLine(l) === "sz"));
check("SH lines sheathe", processForLine("SH02") === "sh", String(processForLine("SH02")));
check("so do FC lines", processForLine("FC03") === "sh", String(processForLine("FC03")));
check("an SC line is the SC stage", processForLine("SC01") === "sc", String(processForLine("SC01")));
check("case and stray spaces do not matter", processForLine("  st07  ") === "sz");
check("a line the naming says nothing about is unknown, not guessed", processForLine("FL01") === null);
check("and so is no line at all", processForLine("") === null && processForLine(null) === null);

// ─── Materials sorted into the stage that consumes them ─────────────────────
// CIP's BOM names the stage on the material itself. Field shape captured
// live from /cppms/historical/bom/search/erpNumber on 2026-10-09: alongside
// itemCode/unit/qty/requiredQuantity it carries `process` ("SC"), `layer`
// and `operationCode` ("SC58").
console.log("\nMateriały przypisane do etapów:");

const stageBom = [
  { itemNo: "993916000000119", name: "FRP/Ф1.6mm", category: "FRP", process: "SC", unit: "KM" },
  { itemNo: "993403000000001", name: "General tube filling gel", category: "Jelly", process: "SC", unit: "KG" },
  { itemNo: "993901000000009", name: "HDPE Black/SCG", category: "PE", process: "SH", unit: "KG" },
  { itemNo: "993902000000001", name: "LSZH jacket material", category: "LSZH", process: "SH", unit: "KG" },
  // Lower-case from CIP would still have to land in the same stage.
  { itemNo: "993916000000306", name: "FRP 2.5mm/VIP", category: "FRP", process: "sz", unit: "KM" },
  // No stage named, and a stage that is not one of CIP's own - both left out
  // rather than parked under some arbitrary column.
  { itemNo: "993916000000219", name: "FRP 1.8mm/VIP", category: "FRP", process: "", unit: "KM" },
  { itemNo: "993901000000266", name: "HDPE /UV 1008h", category: "PE", process: "XX", unit: "KG" },
];

const byStage = groupBomMaterialsByProcess(stageBom);
check("stages are keyed by CIP's own process code", Object.keys(byStage).sort().join(",") === "sc,sh,sz", Object.keys(byStage).join(","));
check("FRP lands in the stage that strands it", byStage.sc.frp.map((m) => m.itemNo).join(",") === "993916000000119", byStage.sc.frp.map((m) => m.itemNo).join(","));
check("the jacket lands in the sheathing stage, PE and LSZH alike", byStage.sh.jacket.length === 2, String(byStage.sh.jacket.length));
check("and not in the stranding one", byStage.sc.jacket.length === 0);
check("a lower-case process code still matches", byStage.sz.frp.length === 1);
check("a material with no stage is left out", !JSON.stringify(byStage).includes("993916000000219"));
check("a stage CIP does not define is left out", !JSON.stringify(byStage).includes("993901000000266"));
check(
  "a material of no interesting group leaves its stage's arrays empty rather than absent",
  Array.isArray(byStage.sc.frp) && Array.isArray(byStage.sc.jacket)
);
check("a stage nothing belongs to gets no entry at all", byStage.dp === undefined);
check("nothing in, nothing out", JSON.stringify(groupBomMaterialsByProcess([])) === "{}");

console.log(failed ? `\n${failed} nieudanych sprawdzeń` : "\nWszystkie sprawdzenia przeszły");
process.exit(failed ? 1 : 0);

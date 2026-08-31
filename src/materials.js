// Field config per material. drumNumber is deliberately not listed here —
// it's resolved through drums.js (find/create/rename a stable drums.id)
// instead of being written as a plain column by the generic loop in
// items.js. `aliases` lets a field accept older/alternate body keys
// without the frontend having to change what it sends.
//
// frp.catalog wires frp_current.frp_item_number up to frp_catalog for a
// read-time join (type/mmc/label/name are derived from the catalog, not
// stored per item) — see items.js. A future material with its own
// catalog table can reuse the same mechanism by setting `catalog` too.

export const MATERIALS = {
  frp: {
    currentTable: "frp_current",
    stockTable: "frp_stock",
    required: ["frpItemNumber", "length", "drumNumber", "location"],
    fields: {
      frpItemNumber: { column: "frp_item_number", type: "text", default: "", aliases: ["frpNumber", "itemNumber"] },
      length: { column: "length", type: "text", default: "" },
      location: { column: "location", type: "text", default: "" },
      reservedForOrder: { column: "reserved_for_order", type: "bool", default: false },
      remark: { column: "remark", type: "text", default: "" },
    },
    catalog: { table: "frp_catalog", catalogKeyColumn: "item_number", itemKeyColumn: "frp_item_number" },
  },
  coatedFrp: {
    currentTable: "coated_frp_current",
    stockTable: "coated_frp_stock",
    required: ["diameter", "length", "drumNumber", "location"],
    fields: {
      diameter: { column: "diameter", type: "text", default: "" },
      type: { column: "type", type: "enum", values: ["XB", "Z"], default: "XB" },
      length: { column: "length", type: "text", default: "" },
      location: { column: "location", type: "text", default: "" },
      reservedForOrder: { column: "reserved_for_order", type: "bool", default: false },
      remark: { column: "remark", type: "text", default: "" },
    },
    catalog: null,
  },
  filler: {
    currentTable: "filler_current",
    stockTable: "filler_stock",
    required: ["color", "diameter", "length", "drumNumber", "location"],
    fields: {
      color: { column: "color", type: "enum", values: ["GRAY", "WHITE", "BLACK"], default: "GRAY" },
      diameter: { column: "diameter", type: "text", default: "" },
      length: { column: "length", type: "text", default: "" },
      location: { column: "location", type: "enum", values: ["PRZED", "ZA"], default: "PRZED" },
      // DB column is named flameproof (the semantically correct name —
      // see schema.sql); the API/frontend field stays isincendiary so the
      // existing UI needs no changes.
      isincendiary: { column: "flameproof", type: "bool", default: false },
      reservedForOrder: { column: "reserved_for_order", type: "bool", default: false },
      remark: { column: "remark", type: "text", default: "" },
    },
    catalog: null,
  },
};

export const MATERIAL_KEYS = Object.keys(MATERIALS);

export function getMaterial(key) {
  const material = MATERIALS[key];
  if (!material) return null;
  return { key, ...material };
}

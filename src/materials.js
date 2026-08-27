// Field config per material's *_current table. id/drum_id/drum_number/
// position/created_at/updated_at are handled separately in items.js
// (shared across all three materials) — only the material-specific
// columns live here.

export const MATERIALS = {
  frp: {
    table: "frp_current",
    stockTable: "frp_stock",
    required: ["frpItemNumber", "drumNumber", "length", "location"],
    fields: {
      frpItemNumber: { column: "frp_item_number", type: "text", default: "" },
      length: { column: "length", type: "text", default: "" },
      location: { column: "location", type: "text", default: "" },
      remark: { column: "remark", type: "text", default: "" },
      reservedForOrder: { column: "reserved_for_order", type: "bool", default: false },
    },
  },
  coatedFrp: {
    table: "coated_frp_current",
    stockTable: "coated_frp_stock",
    required: ["diameter", "drumNumber", "length", "location"],
    fields: {
      diameter: { column: "diameter", type: "text", default: "" },
      length: { column: "length", type: "text", default: "" },
      type: { column: "type", type: "enum", values: ["XB", "Z"], default: "XB" },
      location: { column: "location", type: "text", default: "" },
      remark: { column: "remark", type: "text", default: "" },
    },
  },
  filler: {
    table: "filler_current",
    stockTable: "filler_stock",
    required: ["diameter", "drumNumber", "length"],
    fields: {
      diameter: { column: "diameter", type: "text", default: "" },
      length: { column: "length", type: "text", default: "" },
      color: { column: "color", type: "enum", values: ["GRAY", "WHITE", "BLACK"], default: "GRAY" },
      flameproof: { column: "flameproof", type: "bool", default: false },
      location: { column: "location", type: "enum", values: ["PRZED", "ZA"], default: "PRZED" },
      remark: { column: "remark", type: "text", default: "" },
    },
  },
};

export const MATERIAL_KEYS = Object.keys(MATERIALS);

export function getMaterial(key) {
  return MATERIALS[key];
}

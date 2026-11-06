import { code128Svg } from "./code128.mjs";
import { approvalCurrent } from "./pos-approval.mjs";

export const POS_WARNING = "PROVISIONAL. Quickfuel barcode and import requirements are not confirmed. This is not a Quickfuel-compatible file, not a product barcode, and not an activated offer.";

export function approvalBanner(draft) {
  if (approvalCurrent(draft)) {
    return "INTERNALLY APPROVED by Neil or Joshua. Quickfuel POS support is still unconfirmed. The claim link is not published and the offer is not activated.";
  }
  return "DRAFT / UNAPPROVED. Neil or Joshua may approve. This is not a Quickfuel confirmation and not an activated offer.";
}

const MELBOURNE = "Australia/Melbourne";

export function validityText(draft) {
  return `Valid from 00:00:00 ${MELBOURNE} on ${draft.start} inclusive through 23:59:59 ${MELBOURNE} on ${draft.end} inclusive.`;
}

export function oneLine(value) {
  return String(value ?? "").replace(/\r\n|\r|\n/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

export function csvCell(value) {
  let text = oneLine(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  if (/[",]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function requestEmail(draft) {
  const sites = (draft.sites || []).map((site) => oneLine(site.name) + " (" + oneLine(site.id) + ")").join("; ") || "Unassigned";
  return [
    "REVIEW ONLY. This text has not been sent.",
    approvalBanner(draft),
    "No recipient or sender address is recorded. Do not treat this as an email draft in a mailbox.",
    "",
    "Subject: POS setup request, confirmation required before use",
    "",
    "Please configure the point-of-sale entry described below and reply to confirm whether your system can support it.",
    "Do not treat this request as confirmation. The offer stays pending until that confirmation is recorded.",
    "",
    "Offer: " + oneLine(draft.offer),
    "Conditions: " + oneLine(draft.conditions),
    validityText(draft),
    "Eligible sites: " + sites,
    "POS redemption requested: " + draft.posRedemption + ". This is a request for the point-of-sale system. A static barcode does not enforce single use.",
    "Barcode type: Code 128, code set B. Provisional internal value, not a GTIN, EAN, or UPC allocation.",
    "Barcode value: " + oneLine(draft.codeValue),
    "Distribution: shareable claim link. The public claim link is not published.",
    "Claim cap: " + oneLine(draft.claimCap),
    "Internal approval: " + (approvalCurrent(draft) ? "approved" : "unapproved"),
    "Confirmation status: pending",
    POS_WARNING,
  ].join("\n");
}

export function setupInstructions(draft) {
  const sites = (draft.sites || []).map((site) => oneLine(site.name) + " (" + oneLine(site.id) + ")").join("\n") || "Unassigned (head office)";
  return [
    "POS setup package",
    approvalBanner(draft),
    POS_WARNING,
    "",
    "Confirmation status: pending",
    "Distribution: shareable claim link. Publication waits for recorded Quickfuel confirmation and an explicit activation. A saved or approved draft does not publish it.",
    "Claim cap: " + oneLine(draft.claimCap),
    "Internal approval: " + (approvalCurrent(draft) ? "approved by Neil or Joshua" : "unapproved"),
    "This package does not activate a web voucher and does not change web single-use redemption.",
    "",
    "Offer",
    oneLine(draft.offer),
    "",
    "Conditions",
    oneLine(draft.conditions),
    "",
    validityText(draft),
    "",
    "Eligible sites",
    sites,
    "",
    "POS redemption requested: " + draft.posRedemption,
    "A single-use request asks the point-of-sale provider to enforce one redemption. This barcode file cannot enforce that by itself.",
    "Reusable means the request does not ask the provider for single use. Web vouchers, if any are enabled separately, stay single-use.",
    "",
    "Barcode",
    "Type: Code 128 (code set B), with a checksum and a 10-module quiet zone on each side.",
    "Value: " + oneLine(draft.codeValue),
    "This value is an internal Express Help reference. It is not a GS1 product allocation.",
    "",
    "Files",
    "barcode.svg is the artwork.",
    "config.json is the saved draft.",
    "provisional.csv is a labelled export for review. It is not a Quickfuel import schema.",
    "request-email.txt is review-only wording. It was not sent.",
  ].join("\n");
}

export function provisionalCsv(draft) {
  const headers = ["warning", "approval_banner", "confirmation_status", "offer", "conditions", "valid_from", "valid_through", "timezone", "site_ids", "site_names", "pos_redemption_request", "distribution", "claim_cap", "code_type", "code_value", "compatibility", "claim_published"];
  const row = [
    POS_WARNING,
    approvalBanner(draft),
    "pending",
    draft.offer,
    draft.conditions,
    draft.start,
    draft.end,
    MELBOURNE,
    (draft.sites || []).map((site) => site.id).join(" "),
    (draft.sites || []).map((site) => site.name).join(" "),
    draft.posRedemption,
    draft.distribution || "",
    draft.claimCap,
    "code128",
    draft.codeValue,
    "unconfirmed",
    "no",
  ];
  return headers.join(",") + "\n" + row.map(csvCell).join(",") + "\n";
}

export function configJson(draft) {
  return JSON.stringify({
    warning: POS_WARNING,
    approvalBanner: approvalBanner(draft),
    approvalStatus: approvalCurrent(draft) ? "approved" : (draft.approvalStatus || "draft"),
    confirmationStatus: "pending",
    distribution: draft.distribution || "",
    claimCap: draft.claimCap || 0,
    claimPublished: false,
    offer: draft.offer,
    conditions: draft.conditions,
    start: draft.start,
    end: draft.end,
    timezone: MELBOURNE,
    validity: validityText(draft),
    sites: draft.sites || [],
    posRedemption: draft.posRedemption,
    posRedemptionMeaning: "Request for the point-of-sale provider. Not enforced by this barcode and not a web voucher setting.",
    codeType: "code128",
    codeValue: draft.codeValue,
    compatibility: "unconfirmed",
    webVoucher: "unchanged",
  }, null, 2);
}

export function packageFiles(draft) {
  const svg = code128Svg(draft.codeValue);
  if (svg.error) return svg;
  return {
    files: [
      { name: "barcode.svg", data: svg },
      { name: "config.json", data: configJson(draft) },
      { name: "provisional.csv", data: provisionalCsv(draft) },
      { name: "setup-instructions.txt", data: setupInstructions(draft) },
      { name: "request-email.txt", data: requestEmail(draft) },
    ],
  };
}

export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    if (!/^[a-z0-9.-]+$/.test(file.name)) throw new Error("Unsafe package filename");
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    const localFull = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt32LE(offset, 42);
    locals.push(localFull);
    centrals.push(Buffer.concat([central, name]));
    offset += localFull.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc;
}

export function safeDownloadName(id) {
  if (!/^p[a-f0-9]{8}$/.test(id)) return "pos-setup.zip";
  return "pos-setup-" + id + ".zip";
}

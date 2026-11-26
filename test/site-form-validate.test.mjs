import { test } from "node:test";
import assert from "node:assert/strict";

/** Client site-form checks match the server ABN, phone, email and coordinate rules. */
const v = await import("../public/admin/site-form-validate.mjs");
const sd = await import("../netlify/lib/site-details.mjs");

const VALID_ABN = "51824753556";
const BAD_ABN = "99702180390";
const ABN_MSG = "That ABN is not valid. It needs 11 digits that pass the ABN check.";

test("client and server agree on the 1111 placeholder, a valid ABN, and the checksum failure Joshua hit", () => {
  assert.equal(v.normaliseAbn("1111"), sd.normaliseAbn("1111"));
  assert.equal(v.normaliseAbn("1111"), v.PLACEHOLDER_ABN);
  assert.equal(v.normaliseAbn(VALID_ABN), sd.normaliseAbn(VALID_ABN));
  assert.equal(v.normaliseAbn(BAD_ABN), null);
  assert.equal(sd.normaliseAbn(BAD_ABN), null);
  assert.equal(v.normaliseAbn("11111"), null);
  assert.equal(v.validateSiteForm({ name: "Synthetic Site", siteType: "unattended", abn: "1111" }).fields.abn, undefined);
  assert.equal(v.validateSiteForm({ name: "Synthetic Site", siteType: "unattended", abn: BAD_ABN }).fields.abn, ABN_MSG);
  assert.equal(v.validateCompanyForm({ abn: BAD_ABN }).fields.abn, ABN_MSG);
  assert.equal(v.validateCompanyForm({ abn: "1111" }).fields.abn, undefined);
  assert.equal(v.ABN_ERROR, ABN_MSG);
});

test("validateSiteForm reports name, phone, email and coordinates under the right fields", () => {
  const empty = v.validateSiteForm({ name: "  ", siteType: "", phone: "abc", contactEmail: "not-an-email", lat: "-37.8" });
  assert.equal(empty.fields.name, v.NAME_ERROR);
  assert.equal(empty.fields.siteType, v.TYPE_REQUIRED);
  assert.equal(empty.fields.phone, v.PHONE_ERROR);
  assert.equal(empty.fields.contactEmail, v.EMAIL_ERROR);
  assert.equal(empty.fields.lat, v.COORDS_ERROR);
  assert.equal(empty.fields.lng, v.COORDS_ERROR);
  const ok = v.validateSiteForm({ name: "Synthetic Moe", siteType: "unattended", phone: "03 9113 7191", contactEmail: "", lat: "-38.1736", lng: "146.2588", abn: "1111" });
  assert.deepEqual(ok.fields, {});
  const hidden = v.validateSiteForm({ name: "Synthetic Moe", siteType: "unattended", hideContactEmail: true, contactEmail: "not-an-email" });
  assert.equal(hidden.fields.contactEmail, undefined);
});

test("issuesFromApiError puts field messages inline and leaves 403-style notes in the summary", () => {
  const mapped = v.issuesFromApiError({ message: ABN_MSG, fields: { abn: ABN_MSG } });
  assert.equal(mapped.fields.abn, ABN_MSG);
  assert.equal(mapped.summary, "");
  const fromText = v.issuesFromApiError({ message: ABN_MSG });
  assert.equal(fromText.fields.abn, ABN_MSG);
  assert.equal(fromText.summary, "");
  const preview = v.issuesFromApiError({ message: "This is a preview for review. Nothing can be saved here.", status: 403 });
  assert.deepEqual(preview.fields, {});
  assert.match(preview.summary, /Nothing can be saved here/);
  const clash = v.issuesFromApiError({ message: "A site with that name already exists." });
  assert.equal(clash.fields.name, "A site with that name already exists.");
  assert.equal(clash.summary, "");
  assert.deepEqual(v.fieldsFromMessages([ABN_MSG]), sd.fieldsFromSiteErrors([ABN_MSG]));
});

test("operating model values are accepted or rejected the same way on the client", () => {
  assert.equal(v.normaliseOperatingModel("VIVA"), "viva");
  assert.equal(v.normaliseOperatingModel("LOC CA"), "loc_ca");
  assert.equal(v.normaliseOperatingModel(""), "");
  assert.equal(v.normaliseOperatingModel("nope"), null);
  assert.equal(v.validateSiteForm({ name: "Synthetic Site", siteType: "unattended", operatingModel: "viva" }).fields.operatingModel, undefined);
  assert.equal(v.validateSiteForm({ name: "Synthetic Site", siteType: "unattended", operatingModel: "nope" }).fields.operatingModel, v.OPERATING_MODEL_ERROR);
});

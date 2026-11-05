/** A copy is a new draft. It never carries entries, winners, codes, or an active offer. */
export function competitionSnapshot(comp) {
  return {
    name: comp.name || "",
    sites: [...(comp.sites || [])],
    siteId: comp.siteId || "",
    prize: comp.prize || "",
    start: comp.start || "",
    end: comp.end || "",
    schedule: { type: comp.schedule?.type === "single" ? "single" : "weekly", count: comp.schedule?.count || 8 },
    fields: (comp.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })),
    eligibility: { ...(comp.eligibility || {}) },
    terms: comp.terms || "",
    termsUrl: comp.termsUrl || "",
    heading: comp.heading || "",
    body: comp.body || "",
    colors: { ...(comp.colors || {}) },
    heroUrl: comp.heroUrl || "",
    heroData: comp.heroData || "",
    logoData: comp.logoData || "",
    submitLabel: comp.submitLabel || "Enter",
    thankYou: comp.thankYou || "",
    voucher: { enabled: false },
  };
}

export function pageSnapshot(page) {
  return {
    name: page.name || "",
    title: page.title || "",
    heading: page.heading || "",
    body: page.body || "",
    heroUrl: page.heroUrl || "",
    heroData: page.heroData || "",
    buttonLabel: page.buttonLabel || "",
    buttonUrl: page.buttonUrl || "",
    colors: { ...(page.colors || {}) },
    fields: (page.fields || []).map((f) => ({ ...f, options: [...(f.options || [])] })),
    submitLabel: page.submitLabel || "Send",
    thankYou: page.thankYou || "",
    siteId: page.siteId || "",
  };
}

/** Review-only prize notice. Nothing in here sends mail. */
export function winnerNotice(comp, winner) {
  const contact = String(winner?.contact || "").trim();
  const name = String(winner?.name || "").trim();
  const lines = [
    name ? "Hello " + name + "," : "Hello,",
    "",
    "This draft is about " + (comp?.name || "a competition") + ".",
    comp?.prize ? "Recorded prize: " + comp.prize : "Prize text is whatever was saved on the competition.",
    "",
    "Prepared for review inside Liberty. This message has not been sent.",
  ];
  return {
    delivery: "review-only",
    sent: false,
    to: contact || null,
    recipientKnown: !!contact,
    recipientNote: contact ? "" : "No contact was recorded on the winning entry.",
    subject: "Prize notice: " + (comp?.name || "competition"),
    text: lines.join("\n"),
  };
}

const COLLECTION = new Set(["pending", "collected", "unclaimed"]);

export function updateCollection(winner, { status, notes, actor }) {
  if (!COLLECTION.has(status)) return { error: "Status must be pending, collected, or unclaimed" };
  const event = {
    at: new Date().toISOString(),
    status,
    notes: String(notes || "").slice(0, 500),
    actor: String(actor || ""),
  };
  return {
    winner: {
      ...winner,
      collection: { status, at: event.at, notes: event.notes, actor: event.actor },
      collectionLog: [...(winner.collectionLog || []), event],
    },
  };
}

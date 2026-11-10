const screens = [
  { id: "home", href: "/showcase", label: "Overview", title: "Express Help", body: "A view-only tour of the tools used for QR codes, pages, competitions, POS setup, asset labels, the visitor log, and sites." },
  { id: "qr", href: "/showcase/qr", label: "QR codes", title: "QR codes", body: "Each code has a name, a destination, and example scan artwork. Creating and pausing a code is not available in this tour." },
  { id: "links", href: "/showcase/links", label: "Short links", title: "Short links", body: "A short link can sit beside a QR code. Clicks in this tour are example numbers, not live traffic." },
  { id: "analytics", href: "/showcase/analytics", label: "Analytics", title: "Scan analytics", body: "Location, browser, and daily totals below are example numbers. They are not live scan counts." },
  { id: "pages", href: "/showcase/pages", label: "Pages", title: "Pages", body: "A page can collect a public response. This tour shows an example page and does not store a response." },
  { id: "competitions", href: "/showcase/competitions", label: "Competitions", title: "Competitions", body: "Draws and entries stay in the private admin. This screen shows an example competition only." },
  { id: "pos", href: "/showcase/pos", label: "POS setup", title: "POS setup", body: "The voucher builder prepares an example offer. Approval, sending, and download do nothing here." },
  { id: "assets", href: "/showcase/assets", label: "Asset barcodes", title: "Asset barcodes", body: "Equipment labels use Code 39. The sample below is artwork for the tour, not a live asset." },
  { id: "visitors", href: "/showcase/visitors", label: "Visitor log", title: "Visitor log", body: "Sign-in and sign-out stay on the public visitor forms. This list is example data, with no photo and no contact number." },
  { id: "sites", href: "/showcase/sites", label: "Sites", title: "Sites", body: "Sites group codes, pages, and POS drafts. These rows are examples and are not imported locations." },
  { id: "domains", href: "/showcase/domains", label: "Domains", title: "Custom domains", body: "The public site name is shown as an example. This tour does not change DNS." },
];

const nav = document.getElementById("nav");
const screen = document.getElementById("screen");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => "&#" + ch.charCodeAt(0) + ";");
}
function current() {
  const path = location.pathname.replace(/\/+$/, "") || "/showcase";
  return screens.find((item) => item.href === path) || screens[0];
}
function disabled(label) {
  return '<button type="button" disabled>' + esc(label) + "</button>";
}
function table(headers, rows) {
  const head = headers.map((cell) => "<th>" + esc(cell) + "</th>").join("");
  const body = rows.map((row) => "<tr>" + row.map((cell) => "<td>" + esc(cell) + "</td>").join("") + "</tr>").join("");
  return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
}
function metric(label, value) {
  return '<div class="card"><div class="muted">' + esc(label) + '</div><div class="metric">' + esc(value) + "</div></div>";
}
function bar(label, width) {
  return '<div><div class="muted">' + esc(label) + '</div><div class="bar"><span style="width:' + width + '%"></span></div></div>';
}

function bodyFor(item) {
  if (item.id === "home") {
    return '<div class="grid">' + screens.slice(1).map((tool) => '<a class="card" href="' + tool.href + '"><h2>' + esc(tool.label) + "</h2><p class='muted'>" + esc(tool.body) + "</p></a>").join("") + "</div>";
  }
  if (item.id === "qr") {
    return '<div class="split"><div class="card"><h2>Example offer</h2>' + table(["Field", "Example"], [["Name", "Example offer"], ["State", "Example active"], ["Scans", "128"]]) + '<div class="actions">' + disabled("Create QR code") + disabled("Pause") + "</div></div><div class='card'><h2>Example artwork</h2><div class='qr' role='img' aria-label='Example QR artwork'></div><p class='muted'>Decorative example. It does not open a destination.</p></div></div>";
  }
  if (item.id === "links") {
    return '<div class="card">' + table(["Name", "Example clicks"], [["Example offer", "24"], ["Example page", "11"]]) + '<div class="actions">' + disabled("Create short link") + "</div></div>";
  }
  if (item.id === "analytics") {
    return '<div class="metrics">' + metric("Example scans", "128") + metric("Example clicks", "24") + metric("Example page views", "40") + "</div>" + '<div class="split" style="margin-top:12px"><div class="card"><h2>By location</h2><div class="bars">' + bar("Australia", 78) + bar("New Zealand", 22) + "</div>" + table(["Country", "Example engagements"], [["Australia", "18"], ["New Zealand", "4"]]) + '<div class="actions">' + disabled("Download CSV") + "</div></div><div class='card'><h2>By browser</h2>" + table(["Browser", "Example engagements"], [["Safari", "14"], ["Chrome", "8"]]) + "</div></div>";
  }
  if (item.id === "pages") {
    return '<div class="card">' + table(["Page", "Example views", "State"], [["Example arrival page", "40", "Example published"]]) + '<div class="actions">' + disabled("New page") + disabled("Publish") + "</div></div>";
  }
  if (item.id === "competitions") {
    return '<div class="card">' + table(["Competition", "Example entries", "State"], [["Example weekly draw", "12", "Example open"]]) + '<p class="muted">Entrant names and contact details are not shown.</p><div class="actions">' + disabled("Draw") + disabled("Export") + "</div></div>";
  }
  if (item.id === "pos") {
    return '<div class="card"><h2>Example fuel offer</h2>' + table(["Field", "Example"], [["Offer", "Example fuel offer"], ["Barcode", "EXAMPLE"], ["State", "Example draft"]]) + '<div class="actions">' + disabled("Request approval") + disabled("Approve") + disabled("Send") + disabled("Download") + "</div></div>";
  }
  if (item.id === "assets") {
    return '<div class="card"><h2>EXAMPLE-1</h2><p class="muted">Example Code 39 label. Quiet zone and wide bars follow the same idea as the admin tool.</p><div class="qr" role="img" aria-label="Example barcode artwork"></div><div class="actions">' + disabled("Download SVG") + disabled("Print") + "</div></div>";
  }
  if (item.id === "visitors") {
    return '<div class="card">' + table(["Site", "Name", "Example status"], [["Example site", "Example visitor", "On site"], ["Example site", "Example colleague", "Signed out"]]) + '<p class="muted">No identification photo is included.</p><div class="actions">' + disabled("View photo") + disabled("Export") + disabled("Delete") + "</div></div>";
  }
  if (item.id === "sites") {
    return '<div class="card">' + table(["Site", "Example region"], [["Example North", "Example region"], ["Example South", "Example region"]]) + '<div class="actions">' + disabled("Import") + disabled("Add site") + "</div></div>";
  }
  return '<div class="card"><h2>expresshelp.site</h2><p>Primary name for this example. Extra hostnames are attached outside Express Help.</p><div class="actions">' + disabled("Save") + "</div></div>";
}

function render() {
  const item = current();
  document.title = item.title + " · Express Help tour";
  nav.innerHTML = screens.map((entry) => '<a href="' + entry.href + '"' + (entry.id === item.id ? ' aria-current="page"' : "") + ">" + esc(entry.label) + "</a>").join("");
  screen.innerHTML = '<p class="kicker">Example data</p><h1>' + esc(item.title) + "</h1><p class='lead'>" + esc(item.body) + "</p>" + bodyFor(item);
}
render();

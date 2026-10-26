const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const file = path.join(__dirname, "..", "sciencedirect-academic-md.user.js");
const source = fs.readFileSync(file, "utf8");
const ctx = {
  URL,
  location: { href: "https://www.sciencedirect.com/leapspace/conversation/synthetic-id", pathname: "/not-the-site" },
  document: { body: null, addEventListener() {} },
  window: { __LS_MD_EXPORT_TEST__: true },
  setInterval() { return 0; }
};
vm.runInNewContext(source, ctx, { filename: file, timeout: 12000 });
const api = ctx.window.__LS_MD_EXPORT_API__;
assert.ok(api);

function fakeRef(n, doi, opts = {}) {
  return {
    number: String(n),
    title: opts.title || "Synthetic reference (not a real publication)",
    authors: "Example, A.; Sample, B.",
    year: "2026",
    journal: "Test Journal",
    links: [
      { label: "DOI", url: "https://doi.org/" + doi },
      ...(opts.publisher ? [{ label: "Publisher", url: opts.publisher }] : []),
      { label: "Scopus", url: "https://www.scopus.com/pages/publications/123456789" }
    ],
    abstract: opts.abstract ?? "Synthetic abstract for software testing."
  };
}

test("metadata points to user's actual public GitHub repository", () => {
  assert.match(source, /@namespace\s+https:\/\/github\.com\/myh333777\/leapspace-md-export/);
  assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/myh333777\/leapspace-md-export\/main\//);
  assert.doesNotMatch(source, /github\.com\/mayinghui\/leapspace-md-export/);
});

test("ScienceDirect indirect DOI redirect becomes canonical DOI URL", () => {
  const url = api.safeUrl("/leapspace/redirect?doi=10.1016%2Fj.iref.2025.104869");
  assert.equal(url, "https://doi.org/10.1016/j.iref.2025.104869");
});

test("Chinese DOI links remain valid even when not in Crossref", () => {
  const url = api.safeUrl("/leapspace/redirect?doi=10.16418%2Fj.issn.1000-3045.20220629001");
  assert.equal(url, "https://doi.org/10.16418/j.issn.1000-3045.20220629001");
});

test("Scopus tracking query is removed without destroying paper ID", () => {
  const url = api.safeUrl("https://www.scopus.com/pages/publications/105029297212?adobe_mc=private&foo=bar");
  assert.equal(url, "https://www.scopus.com/pages/publications/105029297212?foo=bar");
  assert.equal(api.safeUrl("javascript:alert(1)"), "");
});

test("prefers trusted publisher PII URL but also keeps DOI and Scopus", () => {
  const r = fakeRef(1, "10.1016/j.iref.2025.104869", {
    publisher: "https://www.sciencedirect.com/science/article/pii/S1059056025010329"
  });
  const result = api.academicReference(r, 1, true, true);
  assert.match(result, /Synthetic reference \(not a real publication\)\]\(https:\/\/www\.sciencedirect\.com\/science\/article\/pii\/S1059056025010329\)/);
  assert.match(result, /\[DOI\]\(https:\/\/doi\.org\/10\.1016\/j\.iref\.2025\.104869\)/);
  assert.match(result, /Scopus（可能需要机构登录）/);
  assert.match(result, /id="ref-1" name="ref-1"/);
});

test("single bibliography remains linked across turns with duplicated DOI", () => {
  const r1 = fakeRef(1, "10.1016/j.iref.2025.104869");
  const r2 = { ...r1, number: "2" };
  const turns = [
    { question: "Synthetic question one", answer: "Reference @@LSE_CITE_1_1@@", cites: ["1"], refs: [r1], id: "t1" },
    { question: "Synthetic question two", answer: "Reference @@LSE_CITE_2_2@@", cites: ["2"], refs: [r2], id: "t2" }
  ];
  const value = api.buildMarkdown(turns, true, true, true, false);
  assert.equal(value.refs, 1);
  assert.equal(value.unresolved, 0);
  assert.equal(value.citationOccurrences, 2);
  assert.equal((value.markdown.match(/name="ref-1"/g) || []).length, 1);
  assert.equal((value.markdown.match(/#ref-1/g) || []).length, 2);
  assert.match(value.markdown, /Synthetic abstract for software testing/);
});

test("duplicate abstract label is removed without changing actual abstract", () => {
  const r = fakeRef(1, "10.1257/aer.20191330", {
    abstract: "**摘要注释 · 英文原文**\n\nThis is the real synthetic abstract."
  });
  const result = api.academicReference(r, 1, true, true);
  assert.equal((result.match(/摘要注释 · 英文原文/g) || []).length, 1);
  assert.match(result, /This is the real synthetic abstract/);
});

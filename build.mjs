// Builds dist/index.html from data/site.yaml.
//
// Open-source entries are completed from the GitHub API and the npm registry
// at build time, then cached in data/.cache.json so a build still succeeds
// when those are unreachable. Pass --no-fetch to skip the network entirely.

import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, kind: "map", box: root }];
  // A key with no value yet: the next line decides whether it holds a map or a list.
  let slot = null;

  for (const original of text.split(/\r?\n/)) {
    const hash = original.indexOf(" #");
    const raw = hash >= 0 ? original.slice(0, hash) : original;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();

    if (slot && indent <= slot.indent) {
      slot.owner[slot.key] = {};
      slot = null;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();

    if (slot && indent > slot.indent && !line.startsWith("- ")) {
      const obj = {};
      slot.owner[slot.key] = obj;
      stack.push({ indent: slot.indent, kind: "map", box: obj });
      slot = null;
    }

    const parent = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      const body = line.slice(2);
      if (parent.kind !== "seq") {
        if (!slot) throw new Error(`List item with no list to join: ${line}`);
        const list = [];
        slot.owner[slot.key] = list;
        stack.push({ indent: slot.indent, kind: "seq", box: list });
        slot = null;
      }
      const list = stack[stack.length - 1].box;
      const kv = body.match(/^([^:]+):\s*(.*)$/);
      if (kv) {
        const obj = {};
        if (kv[2] === "") slot = { owner: obj, key: kv[1].trim(), indent };
        else obj[kv[1].trim()] = yamlValue(kv[2]);
        list.push(obj);
        stack.push({ indent, kind: "map", box: obj });
      } else if (body === "") {
        const obj = {};
        list.push(obj);
        stack.push({ indent, kind: "map", box: obj });
      } else {
        list.push(yamlValue(body));
      }
      continue;
    }

    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) throw new Error(`Cannot read YAML line: ${line}`);
    if (kv[2] === "") {
      slot = { owner: parent.box, key: kv[1].trim(), indent };
      continue;
    }
    parent.box[kv[1].trim()] = yamlValue(kv[2]);
  }
  return root;
}

function yamlValue(raw) {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => yamlValue(s))
      .filter((s) => s !== null && s !== "");
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "ti2a-site", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchRepo(repo) {
  const [owner, name] = repo.split("/");
  const data = await getJSON(`https://api.github.com/repos/${owner}/${name}`);
  return {
    title: data.name,
    description: data.description || "",
    language: data.language || "",
    stars: data.stargazers_count ?? 0,
    forks: data.forks_count ?? 0,
    license: data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : "",
    url: data.html_url,
    pushed: (data.pushed_at || "").slice(0, 10),
    archived: data.archived,
    fork: data.fork,
    topics: data.topics || [],
  };
}

async function fetchNpm(name) {
  const data = await getJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const version = data["dist-tags"]?.latest;
  if (!version) return null;
  return { name, version, url: `https://www.npmjs.com/package/${name}` };
}

async function resolveOpenSource(site, cache) {
  const entries = site.opensource_repos || [];
  const out = [];
  for (const entry of entries) {
    const cached = cache.repos?.[entry.repo] || {};
    let live = {};
    if (!args.has("--no-fetch")) {
      try {
        live = await fetchRepo(entry.repo);
      } catch (err) {
        console.warn(`  github unavailable for ${entry.repo}: ${err.message}`);
      }
    }
    const merged = { ...cached, ...stripEmpty(live) };

    let npm = cached.npm || null;
    if (entry.npm && !args.has("--no-fetch")) {
      try {
        npm = (await fetchNpm(entry.npm)) || npm;
      } catch (err) {
        console.warn(`  npm unavailable for ${entry.npm}: ${err.message}`);
      }
    }
    if (entry.npm && !npm) npm = { name: entry.npm, version: "", url: `https://www.npmjs.com/package/${entry.npm}` };

    out.push({
      ...merged,
      repo: entry.repo,
      title: entry.title || merged.title || entry.repo.split("/")[1],
      description: entry.description || merged.description || "",
      url: merged.url || `https://github.com/${entry.repo}`,
      site: entry.site || "",
      npm,
    });
    cache.repos[entry.repo] = { ...merged, npm };
  }
  return out;
}

function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v !== undefined));
}

const STRINGS = {
  ru: {
    htmlLang: "ru",
    navWork: "Под заказ",
    navSource: "Open-source",
    navAbout: "О студии",
    navContact: "Контакт",
    workHeading: "Под заказ",
    workNote: "Коммерческие проекты. Имена и скриншоты - только с согласия заказчика, иначе кейс обезличен.",
    sourceHeading: "Open-source",
    sourceNote: "Публичные репозитории. Звёзды, язык и описание подтягиваются с GitHub при каждой сборке.",
    aboutHeading: "О студии",
    stackLabel: "Стек",
    resultLabel: "Что сделано",
    starsLabel: "звёзд на GitHub",
    updatedLabel: "обновлено",
    demoLabel: "Открыть",
    codeLabel: "Код",
    npmLabel: "npm",
    status: { shipped: "сдано", ongoing: "в работе", paused: "пауза" },
    langSwitch: "EN",
    otherHref: "./index.en.html",
  },
  en: {
    htmlLang: "en",
    navWork: "Client work",
    navSource: "Open source",
    navAbout: "Studio",
    navContact: "Contact",
    workHeading: "Client work",
    workNote: "Commercial projects. Names and screenshots appear only with the client's permission; otherwise the case is anonymised.",
    sourceHeading: "Open source",
    sourceNote: "Public repositories. Stars, language and description are read from GitHub on every build.",
    aboutHeading: "Studio",
    stackLabel: "Stack",
    resultLabel: "Outcome",
    starsLabel: "stars on GitHub",
    updatedLabel: "updated",
    demoLabel: "Open",
    codeLabel: "Code",
    npmLabel: "npm",
    status: { shipped: "shipped", ongoing: "in progress", paused: "paused" },
    langSwitch: "RU",
    otherHref: "./",
  },
};

function rowClient(item, t, num) {
  const copy = item[t.htmlLang];
  const tags = (item.tags || []).map(esc).join(" · ");
  const client = item.client ? `<span class="client"> — ${esc(item.client)}</span>` : "";
  const link = item.url ? `<a href="${esc(item.url)}">${esc(item.url.replace(/^https?:\/\//, ""))}</a>` : "";
  return `
      <li class="row" id="${esc(item.id)}">
        <span class="row-num" aria-hidden="true">${String(num).padStart(2, "0")}</span>
        <div class="row-main">
          <h3>${esc(item.title)}${client}</h3>
          <p class="summary">${esc(copy.summary)}</p>
          ${copy.result ? `<p class="result"><span>${esc(t.resultLabel)}</span>${esc(copy.result)}</p>` : ""}
          ${tags ? `<p class="tags">${tags}</p>` : ""}
        </div>
        <div class="row-meta">
          <span class="status status-${esc(item.status || "shipped")}">${esc(t.status[item.status] || "")}</span>
          <span class="year">${esc(item.year || "")}</span>
          ${link}
        </div>
      </li>`;
}

function rowRepo(item, t, num) {
  const meta = [item.language, item.license, item.pushed ? `${t.updatedLabel} ${item.pushed}` : ""]
    .filter(Boolean)
    .map((bit) => `<span>${esc(bit)}</span>`)
    .join("");
  const stars =
    item.stars > 0
      ? `<span class="stars"><span aria-hidden="true">★</span> ${item.stars}<span class="sr">${esc(t.starsLabel)}</span></span>`
      : "";
  const npm = item.npm ? `<a href="${esc(item.npm.url)}">${esc(t.npmLabel)}${item.npm.version ? " " + esc(item.npm.version) : ""}</a>` : "";
  const demo = item.site ? `<a href="${esc(item.site)}">${esc(t.demoLabel)}</a>` : "";
  return `
      <li class="row">
        <span class="row-num" aria-hidden="true">${String(num).padStart(2, "0")}</span>
        <div class="row-main">
          <h3><a href="${esc(item.url)}">${esc(item.title)}</a></h3>
          <p class="summary">${esc(item.description)}</p>
          <p class="row-links"><a href="${esc(item.url)}">${esc(t.codeLabel)}</a>${npm}${demo}</p>
        </div>
        <div class="row-meta">${stars}${meta}</div>
      </li>`;
}

function page(site, repos, lang) {
  const t = STRINGS[lang];
  const hero = site.hero[lang];
  const about = site.about[lang];
  const contact = site.contact[lang];
  const clients = (site.client || []).map((item, i) => rowClient(item, t, i + 1)).join("\n");
  const source = repos.map((item, i) => rowRepo(item, t, i + 1)).join("\n");
  const stack = (site.stack || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const links = (site.contact.links || [])
    .map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`)
    .join("");

  const base = site.meta.url.replace(/\/$/, "");
  const canonical = lang === "ru" ? base + "/" : `${base}/index.en.html`;
  const ogTitle = `${site.meta.brand} — ${hero.kicker}`;
  const ogImage = new URL("og-image.png", base + "/").href;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.meta.brand,
    url: canonical,
    logo: ogImage,
    email: site.meta.email,
    location: { "@type": "Place", name: site.meta.location },
    sameAs: (site.contact.links || [])
      .filter((l) => l.href.startsWith("http"))
      .map((l) => l.href),
  };

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${esc(ogTitle)}</title>
  <meta name="description" content="${esc(hero.lead)}">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="alternate" hreflang="ru" href="${esc(base + "/")}">
  <link rel="alternate" hreflang="en" href="${esc(base + "/index.en.html")}">
  <link rel="alternate" hreflang="x-default" href="${esc(base + "/")}">
  <link rel="icon" href="./favicon.svg" type="image/svg+xml">
  <link rel="preload" href="./styles.css" as="style">
  <link rel="stylesheet" href="./styles.css">
  <meta property="og:site_name" content="${esc(site.meta.brand)}">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(hero.lead)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="${lang === "ru" ? "ru_RU" : "en_US"}">
  <meta property="og:locale:alternate" content="${lang === "ru" ? "en_US" : "ru_RU"}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(hero.lead)}">
  <meta name="twitter:image" content="${esc(ogImage)}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <a class="skip" href="#work">${esc(t.navWork)}</a>
  <header class="top">
    <a class="brand" href="#top">${esc(site.meta.brand)}</a>
    <nav>
      <a href="#work">${esc(t.navWork)}</a>
      <a href="#source">${esc(t.navSource)}</a>
      <a href="#about">${esc(t.navAbout)}</a>
      <a href="#contact">${esc(t.navContact)}</a>
      <a class="lang" href="${t.otherHref}" hreflang="${lang === "ru" ? "en" : "ru"}">${esc(t.langSwitch)}</a>
    </nav>
  </header>

  <main id="top">
    <section class="hero">
      <p class="kicker">${esc(hero.kicker)}</p>
      <h1>${esc(hero.title)}</h1>
      <p class="lead">${esc(hero.lead)}</p>
    </section>

    <section id="work">
      <div class="section-head">
        <h2>${esc(t.workHeading)}</h2>
        <p>${esc(t.workNote)}</p>
      </div>
      <ol class="rows">${clients}</ol>
    </section>

    <section id="source">
      <div class="section-head">
        <h2>${esc(t.sourceHeading)}</h2>
        <p>${esc(t.sourceNote)}</p>
      </div>
      <ol class="rows">${source}</ol>
    </section>

    <section id="about">
      <h2>${esc(about.heading)}</h2>
      <div class="about">
        <p>${esc(about.body)}</p>
        <div class="stack-box">
          <span class="stack-label">${esc(t.stackLabel)}</span>
          <ul class="stack">${stack}</ul>
        </div>
      </div>
    </section>

    <section id="contact">
      <h2>${esc(contact.heading)}</h2>
      <p class="contact-note">${esc(contact.note)}</p>
      <ul class="contact">${links}</ul>
    </section>
  </main>

  <footer>
    <span>${esc(site.meta.brand)}</span>
    <span>${esc(site.meta.location)}</span>
  </footer>
</body>
</html>
`;
}

async function build() {
  const site = parseYaml(readFileSync(join(root, "data", "site.yaml"), "utf8"));
  const cachePath = join(root, "data", ".cache.json");
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : { repos: {} };
  cache.repos ||= {};

  console.log("resolving open source…");
  const repos = await resolveOpenSource(site, cache);
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");

  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), page(site, repos, "ru"));
  writeFileSync(join(dist, "index.en.html"), page(site, repos, "en"));
  writeFileSync(join(dist, "styles.css"), readFileSync(join(root, "styles.css")));
  writeFileSync(join(dist, "favicon.svg"), readFileSync(join(root, "favicon.svg")));
  writeFileSync(join(dist, "og-image.png"), readFileSync(join(root, "og-image.png")));
  writeFileSync(join(dist, "CNAME"), site.meta.domain + "\n");

  const base = site.meta.url.replace(/\/$/, "");
  const now = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dist, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`,
  );
  writeFileSync(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${base}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <xhtml:link rel="alternate" hreflang="ru" href="${base}/"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}/index.en.html"/>
  </url>
  <url>
    <loc>${base}/index.en.html</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <xhtml:link rel="alternate" hreflang="ru" href="${base}/"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}/index.en.html"/>
  </url>
</urlset>
`,
  );
  console.log(`built ${repos.length} repositories, ${site.client.length} client cases → dist/`);
}

await build();

if (args.has("--watch")) {
  console.log("watching data/site.yaml, styles.css");
  for (const file of ["data/site.yaml", "styles.css"]) {
    watch(join(root, file), () => {
      build().catch((err) => console.error(err.message));
    });
  }
}

import express from "express";
import fetch from "node-fetch";
import { CookieJar } from "tough-cookie";
import fetchCookie from "fetch-cookie";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";

import { processTorrent } from "./torrentprocessor.js";



const app = express();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the HTML UI
app.use(express.json());  
app.use(express.static(path.join(__dirname, "public")));


const BASE_URL = "https://audiobookbay.lu";

// ---------- helpers (same logic as before, trimmed for clarity) ----------
function normalize(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/\+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","by",
  "his","her","their","your","my","our"
]);

function keywordsFromQuery(q) {
  return normalize(q)
    .split(" ")
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

function matchStats(title, keywords) {
  const t = ` ${normalize(title)} `;
  const hits = keywords.filter(w => t.includes(` ${w} `));
  return {
    hitCount: hits.length,
    coverage: hits.length / keywords.length
  };
}

function titleToFilename(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

async function getSafePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 1;

  while (true) {
    try {
      await fs.promises.access(candidate);
      candidate = path.join(dir, `${base} (${i++})${ext}`);
    } catch {
      return candidate;
    }
  }
}


app.post("/process", async (req, res) => {
  const log = [];
  try {
    log.push("🚀 Starting processing…");
    await processTorrent();
    log.push("✅ Processing complete.");
    res.json({ log });
  } catch (err) {
    log.push("❌ Error: " + err.message);
    res.json({ log });
  }
});


// ---------- main endpoint ----------
app.post("/search", async (req, res) => {
  const { sessionId, query } = req.body;
  const log = [];

  try {
    const jar = new CookieJar();
    const fetchWithCookies = fetchCookie(fetch, jar);

    await jar.setCookie(`PHPSESSID=${sessionId}`, BASE_URL);
    log.push("✅ Session cookie set");

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    const searchRes = await fetchWithCookies(searchUrl);
    const searchHtml = await searchRes.text();

    const $ = cheerio.load(searchHtml);
    const keywords = keywordsFromQuery(query);

    let match = null;
    $(".postTitle").each((_, el) => {
      const a = $(el).find("a").first();
      const title = a.text().trim();
      const href = a.attr("href");
      if (!title || !href) return;

      const { hitCount, coverage } = matchStats(title, keywords);
      if (coverage < 0.8 || hitCount < 2) return;

      match = { title, href };
    });

    if (!match) {
      log.push("❌ No high-certainty match found");
      return res.json({ log });
    }

    log.push(`📘 Selected: ${match.title}`);

    const bookRes = await fetchWithCookies(BASE_URL + match.href);
    const bookHtml = await bookRes.text();
    const $$ = cheerio.load(bookHtml);

    let torrentHref = null;
    $$("a").each((_, el) => {
      if ($$(el).text().trim() === "Torrent Free Downloads") {
        torrentHref = $$(el).attr("href");
      }
    });

    if (!torrentHref) {
      log.push("❌ Torrent link not found");
      return res.json({ log });
    }

    const fullTorrentUrl = BASE_URL + torrentHref;
    log.push("⬇️ Downloading torrent…");

    const outDir = "./dwnld";
    await fs.promises.mkdir(outDir, { recursive: true });

    const filename = `${titleToFilename(match.title)}.torrent`;
    const outPath = await getSafePath(outDir, filename);

    const torrentRes = await fetchWithCookies(fullTorrentUrl);
    await pipeline(torrentRes.body, fs.createWriteStream(outPath));

    log.push(`✅ Saved to ${outPath}`);
    res.json({ log });

  } catch (err) {
    log.push("🔥 Error: " + err.message);
    res.json({ log });
  }
});

app.listen(3000, () =>
  console.log("🌐 UI available at http://localhost:3000")
);

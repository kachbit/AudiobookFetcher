import fs from "fs";
import path from "path";
import WebTorrent from "webtorrent";
import cliProgress from "cli-progress";
import prettyBytes from "pretty-bytes";

const TORRENT_DIR = path.resolve("./dwnld");
const OUT_DIR = path.resolve("./processed");

// Audio extensions we care about (for reporting)
const AUDIO_EXTS = new Set([
  ".mp3", ".m4b", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav", ".aiff", ".alac"
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeName(name) {
  return String(name ?? "unknown")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function listTorrentFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".torrent"))
    .map((e) => path.join(dir, e.name));
}

function collectAudioFiles(torrent) {
  const audios = [];
  for (const f of torrent.files) {
    const ext = path.extname(f.name).toLowerCase();
    if (AUDIO_EXTS.has(ext)) audios.push(f.path);
  }
  return audios;
}

async function downloadOneTorrent(client, torrentPath) {
  const torrentBase = path.basename(torrentPath, ".torrent");
  const destFolder = path.join(OUT_DIR, safeName(torrentBase));

  await ensureDir(destFolder);

  const bar = new cliProgress.SingleBar(
    {
      format:
        "{name} |{bar}| {percentage}% | {downloaded}/{total} | {speed}/s | peers:{peers} | ETA:{eta}s",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );

  return new Promise((resolve, reject) => {
    let started = false;

    const torrent = client.add(torrentPath, { path: destFolder });

    torrent.on("error", reject);

    torrent.on("ready", () => {
      // Start the bar once we know total length
      const total = torrent.length || 0;
      bar.start(100, 0, {
        name: safeName(torrent.name || torrentBase),
        downloaded: prettyBytes(0),
        total: prettyBytes(total),
        speed: prettyBytes(0),
        peers: 0,
        eta: 0,
      });
      started = true;
    });

    const timer = setInterval(() => {
      if (!started) return;

      const pct = Math.floor(torrent.progress * 100);
      const downloaded = torrent.downloaded || 0;
      const total = torrent.length || 0;

      bar.update(pct, {
        name: safeName(torrent.name || torrentBase),
        downloaded: prettyBytes(downloaded),
        total: prettyBytes(total),
        speed: prettyBytes(torrent.downloadSpeed || 0),
        peers: torrent.numPeers || 0,
        eta: torrent.timeRemaining ? Math.ceil(torrent.timeRemaining / 1000) : 0,
      });
    }, 400);

    torrent.on("done", async () => {
      clearInterval(timer);
      if (started) {
        bar.update(100);
        bar.stop();
      }

      // Small pause to let FS settle on some systems
      await sleep(150);

      const audioFiles = collectAudioFiles(torrent);

      resolve({
        torrentName: torrent.name || torrentBase,
        outFolder: destFolder,
        audioFiles,
        totalBytes: torrent.length || 0,
      });
    });
  });
}

export async function processTorrent() {
  await ensureDir(TORRENT_DIR);
  await ensureDir(OUT_DIR);

  const torrents = await listTorrentFiles(TORRENT_DIR);

  if (torrents.length === 0) {
    console.log(`No .torrent files found in: ${TORRENT_DIR}`);
    process.exit(0);
  }

  console.log(`Found ${torrents.length} torrent(s) in ${TORRENT_DIR}`);
  console.log(`Output folder: ${OUT_DIR}\n`);

  const client = new WebTorrent({ maxConns: 80 });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nStopping…");
    client.destroy(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (let i = 0; i < torrents.length; i++) {
    const tPath = torrents[i];
    console.log(`\n[${i + 1}/${torrents.length}] Downloading: ${path.basename(tPath)}`);

    try {
      const result = await downloadOneTorrent(client, tPath);

      console.log(`✅ Done: ${result.torrentName}`);
      console.log(`📁 Saved to: ${result.outFolder}`);

      if (result.audioFiles.length === 0) {
        console.log("⚠️  No audio files detected (maybe it’s zipped, or a different format).");
      } else {
        console.log(`🎧 Audio files (${result.audioFiles.length}):`);
        // Print up to 12 files to avoid spam
        for (const f of result.audioFiles.slice(0, 12)) {
          console.log(`   - ${f}`);
        }
        if (result.audioFiles.length > 12) console.log(`   … +${result.audioFiles.length - 12} more`);
      }
    } catch (err) {
      console.log(`❌ Failed: ${path.basename(tPath)} — ${err.message}`);
    }
  }

  client.destroy(() => {
    console.log("\nAll done.");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  processTorrent().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

const fs = require('fs-extra');
const path = require('path');

const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const SCREENSHOTS_DIR = path.join(WORKSPACE_DIR, 'screenshots');
const RUNS_DIR = path.join(WORKSPACE_DIR, 'runs');
const TRASH_DIR = path.join(WORKSPACE_DIR, '_trash');

function parseArgs(argv) {
  const out = { keepDays: 7, mode: 'post_run' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keepDays') out.keepDays = Number(argv[++i]);
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--purgeTrash') out.purgeTrash = true;
    else if (a === '--dryRun') out.dryRun = true;
  }
  if (!Number.isFinite(out.keepDays) || out.keepDays < 0) out.keepDays = 7;
  return out;
}

function isInside(p, parent) {
  const rel = path.relative(parent, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isGeneratedScreenshotFile(filePath) {
  const base = path.basename(filePath);
  // Only known generated patterns (safe allow-list)
  return (
    /^full_page_\d+\.png$/i.test(base) ||
    /^donor_full_\d+\.png$/i.test(base) ||
    /^donor_full_v6_\d+\.png$/i.test(base) ||
    /^donor_full_v5\.png$/i.test(base) ||
    /^donor_full_v6\.png$/i.test(base)
  );
}

async function moveToTrash(files, trashSubdir, dryRun) {
  if (files.length === 0) return { moved: 0 };
  const destDir = path.join(TRASH_DIR, trashSubdir);
  if (!dryRun) await fs.ensureDir(destDir);
  let moved = 0;
  for (const f of files) {
    try {
      const dest = path.join(destDir, path.basename(f));
      if (!dryRun) await fs.move(f, dest, { overwrite: true });
      moved++;
    } catch (e) {
      // ignore (locked, missing)
    }
  }
  return { moved };
}

async function removeOldTrash(keepDays, dryRun) {
  if (!(await fs.pathExists(TRASH_DIR))) return { removedDirs: 0 };
  const entries = await fs.readdir(TRASH_DIR);
  const now = Date.now();
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let removedDirs = 0;
  for (const name of entries) {
    const p = path.join(TRASH_DIR, name);
    try {
      const st = await fs.stat(p);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs < cutoff) {
        if (!dryRun) await fs.remove(p);
        removedDirs++;
      }
    } catch (_) {
      // ignore
    }
  }
  return { removedDirs };
}

async function cleanupWorkspace({ mode = 'post_run', keepDays = 7, purgeTrash = false, dryRun = false } = {}) {
  await fs.ensureDir(TRASH_DIR);

  // Never touch latest folder; it is the active, current run output.
  const latestDir = path.join(SCREENSHOTS_DIR, 'latest');

  const movedSummary = { screenshots: 0, legacySectionsDir: 0, runsLatest: 0 };

  // 0) Pre-run: move previous runs/latest into trash to keep workspace clean
  // This mirrors screenshots/latest behavior but for run logs/artifacts.
  if (mode === 'pre_run') {
    const runsLatestDir = path.join(RUNS_DIR, 'latest');
    if (await fs.pathExists(runsLatestDir)) {
      try {
        const entries = await fs.readdir(runsLatestDir).catch(() => []);
        if (entries.length > 0) {
          const dest = path.join(TRASH_DIR, `runs_${Date.now()}`);
          if (!dryRun) {
            await fs.ensureDir(TRASH_DIR);
            await fs.move(runsLatestDir, dest, { overwrite: true });
          }
          movedSummary.runsLatest = 1;
        }
      } catch (_) {
        // ignore
      }
    }
  }

  // 1) Move old generated screenshot files under screenshots/ (excluding screenshots/latest)
  if (await fs.pathExists(SCREENSHOTS_DIR)) {
    const entries = await fs.readdir(SCREENSHOTS_DIR);
    const candidates = [];
    for (const name of entries) {
      const p = path.join(SCREENSHOTS_DIR, name);
      if (p === latestDir) continue;
      const st = await fs.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isFile() && isGeneratedScreenshotFile(p)) candidates.push(p);
    }
    const res = await moveToTrash(candidates, `screenshots_${Date.now()}`, dryRun);
    movedSummary.screenshots = res.moved;
  }

  // 2) Move legacy screenshots/sections directory as a whole (safe, known path)
  const legacySectionsDir = path.join(SCREENSHOTS_DIR, 'sections');
  if (await fs.pathExists(legacySectionsDir)) {
    const dest = path.join(TRASH_DIR, `legacy_sections_${Date.now()}`);
    if (!dryRun) {
      await fs.move(legacySectionsDir, dest, { overwrite: true });
    }
    movedSummary.legacySectionsDir = 1;
  }

  // 3) Optional: purge old trash
  const trashRes = purgeTrash ? await removeOldTrash(keepDays, dryRun) : { removedDirs: 0 };

  return {
    ok: true,
    mode,
    dryRun,
    movedSummary,
    trash: { keepDays, removedDirs: trashRes.removedDirs },
    notes: [
      'Cleanup only moves known generated files/directories to workspace/_trash.',
      'It never deletes theme files or source code.',
      'Use --purgeTrash to delete old trash directories by age.',
    ],
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  cleanupWorkspace(args)
    .then((r) => {
      console.log('✅ cleanup-workspace done:', JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error('❌ cleanup-workspace failed:', e?.message || e);
      process.exit(1);
    });
}

module.exports = { cleanupWorkspace };


import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GENERATED_OUTPUT_PREFIXES = [
  'android/app/src/main/assets/public/',
  'dist/',
];

function runGit(rootDir, args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function parsePorcelainZ(raw) {
  const tokens = raw.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    // In porcelain v1 -z, renames/copies include a second NUL-terminated original path.
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      i += 1;
    }
    const normalized = filePath.split(path.sep).join('/');
    if (
      normalized === 'node_modules' ||
      GENERATED_OUTPUT_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
    ) {
      continue;
    }
    entries.push({ status, path: normalized });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function collectBuildProvenance(rootDir) {
  try {
    const branch = runGit(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'unknown';
    const baseCommit = runGit(rootDir, ['rev-parse', 'HEAD']).trim() || 'unknown';
    const porcelainRaw = runGit(rootDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude)android/app/src/main/assets/public',
      ':(exclude)dist',
    ]);
    const dirtyEntries = parsePorcelainZ(porcelainRaw);
    if (dirtyEntries.length === 0) {
      return {
        branch,
        baseCommit,
        workingTreeState: 'clean',
        dirtySourceFileCount: 0,
        sourceFingerprint: 'clean:matches-git-base-commit',
      };
    }

    const fingerprintHash = createHash('sha256');
    fingerprintHash.update(`base:${baseCommit}\n`);
    for (const entry of dirtyEntries) {
      const fullPath = path.join(rootDir, entry.path);
      if (fs.existsSync(fullPath)) {
        const stat = fs.lstatSync(fullPath);
        if (stat.isFile()) {
          const contentHash = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
          fingerprintHash.update(`${entry.status}\0${entry.path}\0file:${stat.size}:${contentHash}\n`);
        } else if (stat.isSymbolicLink()) {
          fingerprintHash.update(`${entry.status}\0${entry.path}\0symlink:${fs.readlinkSync(fullPath)}\n`);
        } else {
          fingerprintHash.update(`${entry.status}\0${entry.path}\0other\n`);
        }
      } else {
        fingerprintHash.update(`${entry.status}\0${entry.path}\0deleted\n`);
      }
    }

    return {
      branch,
      baseCommit,
      workingTreeState: 'dirty',
      dirtySourceFileCount: dirtyEntries.length,
      sourceFingerprint: `sha256:${fingerprintHash.digest('hex')}`,
    };
  } catch {
    return {
      branch: 'unknown',
      baseCommit: 'unknown',
      workingTreeState: 'unknown',
      dirtySourceFileCount: 0,
      sourceFingerprint: 'unavailable:no-git-metadata',
    };
  }
}

export function formatAssetManifest({
  files,
  outDir,
  provenance,
  excludedCount,
  generatedAt = new Date().toISOString(),
}) {
  const lines = [
    '================================================================================',
    'KHALID PHARMACY — PRODUCTION WEB & CAPACITOR ANDROID ASSET MANIFEST',
    `Generated: ${generatedAt}`,
    `Target Branch: ${provenance.branch}`,
    `Git Base Commit: ${provenance.baseCommit}`,
    `Working Tree State: ${provenance.workingTreeState}`,
    `Dirty Source File Count: ${provenance.dirtySourceFileCount}`,
    `Source Fingerprint: ${provenance.sourceFingerprint}`,
    'Target Repository: HassanKapos/Khalid-Pharmacy-1',
    `Shipped Asset Count: ${files.length}`,
    `Excluded Non-Runtime Assets: ${excludedCount}`,
    '================================================================================',
  ];

  for (const rel of files) {
    const full = path.join(outDir, rel);
    const buf = fs.readFileSync(full);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    lines.push(`File: ${rel}`);
    lines.push(`  Size (bytes): ${buf.length}`);
    lines.push(`  SHA-256:      ${sha256}`);
    lines.push('--------------------------------------------------------------------------------');
  }

  return lines.join('\n') + '\n';
}

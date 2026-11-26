import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  copyFileSync,
  statSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const temp = join(root, '.tmp-web-ocr');
const output = join(root, 'public', 'tesseract');
const backupOutput = join(temp, 'backup-tesseract');
const stagedOutput = join(temp, 'staged-tesseract');
const workDir = join(temp, 'work');
const TESSERACT_VERSION = '6.0.1';
const TESSERACT_CORE_VERSION = '6.1.2';
const LANGUAGE_URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';

const requiredRelativeAssets = [
  'tesseract.esm.min.js', 'worker.min.js',
  'core/tesseract-core.wasm.js', 'core/tesseract-core-simd.wasm.js',
  'core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js',
  'core/tesseract-core.wasm', 'core/tesseract-core-simd.wasm',
  'core/tesseract-core-lstm.wasm', 'core/tesseract-core-simd-lstm.wasm',
  'lang/eng.traineddata.gz'
];

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function minAssetBytes(relativeOrPath) {
  return relativeOrPath.endsWith('.traineddata.gz') || relativeOrPath.endsWith('.wasm')
    ? 1000000
    : 1000;
}

function requireFile(path, minBytes = 1) {
  if (!existsSync(path) || statSync(path).size < minBytes) {
    throw new Error(`Required OCR runtime asset missing or too small: ${path}`);
  }
}

function verifyAssetMagic(filePath) {
  const buf = readFileSync(filePath);
  if (filePath.endsWith('.traineddata.gz')) {
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new Error(`Invalid gzip header in OCR language data: ${filePath}`);
    }
  } else if (filePath.endsWith('.wasm')) {
    if (buf.length < 4 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
      throw new Error(`Invalid WebAssembly magic bytes in OCR core: ${filePath}`);
    }
  }
}

function areAssetsValid(dir) {
  if (!existsSync(dir)) return false;
  return requiredRelativeAssets.every((relative) => {
    const file = join(dir, relative);
    if (!existsSync(file) || statSync(file).size <= minAssetBytes(relative)) return false;
    try {
      verifyAssetMagic(file);
      return true;
    } catch {
      return false;
    }
  });
}

function cleanupManagedTempPaths({ includeBackup = false } = {}) {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stagedOutput, { recursive: true, force: true });
  if (includeBackup) {
    rmSync(backupOutput, { recursive: true, force: true });
  }
  if (existsSync(temp)) {
    for (const entry of readdirSync(temp)) {
      if (entry.startsWith('displaced-output-')) {
        rmSync(join(temp, entry), { recursive: true, force: true });
      }
    }
    if (readdirSync(temp).length === 0) {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

function restoreBackupToOutput() {
  if (!areAssetsValid(backupOutput)) return false;
  mkdirSync(dirname(output), { recursive: true });
  let displacedCorruptPath = null;
  if (existsSync(output)) {
    mkdirSync(temp, { recursive: true });
    displacedCorruptPath = join(temp, `displaced-output-${Date.now()}`);
    renameSync(output, displacedCorruptPath);
  }
  try {
    renameSync(backupOutput, output);
  } catch (restoreErr) {
    if (displacedCorruptPath && !existsSync(output) && existsSync(displacedCorruptPath)) {
      renameSync(displacedCorruptPath, output);
    }
    throw restoreErr;
  }
  if (!areAssetsValid(output)) {
    throw new Error('Restored OCR backup failed post-restore integrity verification');
  }
  if (displacedCorruptPath && existsSync(displacedCorruptPath)) {
    rmSync(displacedCorruptPath, { recursive: true, force: true });
  }
  return true;
}

// 1. Crash-recovery gate BEFORE any cleanup:
// Never delete backup-tesseract before checking whether it holds the only valid OCR set.
const outputValidAtStart = areAssetsValid(output);
const backupValidAtStart = areAssetsValid(backupOutput);

if (!outputValidAtStart && backupValidAtStart) {
  restoreBackupToOutput();
  // Output is now verified valid; safe to clean managed staging/backup paths.
  cleanupManagedTempPaths({ includeBackup: true });
  console.log('Recovered verified local OCR assets from backup; download skipped.');
  process.exit(0);
}

if (outputValidAtStart) {
  // Production output is verified valid; clean any stale managed backup/staging only after verification.
  const hadBackup = existsSync(backupOutput);
  cleanupManagedTempPaths({ includeBackup: true });
  console.log(
    hadBackup
      ? 'Verified existing local OCR assets (stale backup cleaned); download skipped.'
      : 'Verified existing local OCR assets; download skipped.'
  );
  process.exit(0);
}

// 2. Clean only staging/work subpaths; never delete backupOutput while output is invalid.
cleanupManagedTempPaths({ includeBackup: false });
mkdirSync(workDir, { recursive: true });
mkdirSync(join(stagedOutput, 'core'), { recursive: true });
mkdirSync(join(stagedOutput, 'lang'), { recursive: true });

try {
  run('npm', ['pack', `tesseract.js@${TESSERACT_VERSION}`, '--pack-destination', workDir]);
  const apiTarball = join(workDir, `tesseract.js-${TESSERACT_VERSION}.tgz`);
  requireFile(apiTarball, 1000);
  const apiDir = join(workDir, 'api');
  mkdirSync(apiDir, { recursive: true });
  run('tar', ['-xzf', apiTarball, '-C', apiDir]);
  const apiPackagePath = join(apiDir, 'package', 'package.json');
  const apiPackage = JSON.parse(readFileSync(apiPackagePath, 'utf8'));
  const coreRange = apiPackage.dependencies?.['tesseract.js-core'];
  if (!coreRange) throw new Error('Pinned Tesseract.js package does not declare tesseract.js-core');

  const requiredCoreMajor = Number(coreRange.match(/[0-9]+/)?.[0]);
  if (!Number.isFinite(requiredCoreMajor) || Number(TESSERACT_CORE_VERSION.split('.')[0]) !== requiredCoreMajor) {
    throw new Error(`Pinned core ${TESSERACT_CORE_VERSION} is outside Tesseract.js dependency range ${coreRange}`);
  }
  run('npm', ['pack', `tesseract.js-core@${TESSERACT_CORE_VERSION}`, '--pack-destination', workDir]);
  const packedCoreName = readdirSync(workDir).find((name) => name === `tesseract.js-core-${TESSERACT_CORE_VERSION}.tgz`);
  if (!packedCoreName) throw new Error('npm pack did not produce a Tesseract core tarball');
  const packedCore = join(workDir, packedCoreName);
  requireFile(packedCore, 1000);
  const coreDir = join(workDir, 'core');
  mkdirSync(coreDir, { recursive: true });
  run('tar', ['-xzf', packedCore, '-C', coreDir]);

  const apiDist = join(apiDir, 'package', 'dist');
  copyFileSync(join(apiDist, 'tesseract.esm.min.js'), join(stagedOutput, 'tesseract.esm.min.js'));
  copyFileSync(join(apiDist, 'worker.min.js'), join(stagedOutput, 'worker.min.js'));

  const coreDist = join(coreDir, 'package');
  const coreNames = [
    'tesseract-core.wasm.js',
    'tesseract-core-simd.wasm.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core.wasm',
    'tesseract-core-simd.wasm',
    'tesseract-core-lstm.wasm',
    'tesseract-core-simd-lstm.wasm'
  ];
  for (const name of coreNames) copyFileSync(join(coreDist, name), join(stagedOutput, 'core', name));

  run('curl', ['--fail', '--location', '--retry', '3', '--retry-delay', '2', LANGUAGE_URL, '--output', join(stagedOutput, 'lang', 'eng.traineddata.gz')]);

  for (const relative of requiredRelativeAssets) {
    const file = join(stagedOutput, relative);
    requireFile(file, minAssetBytes(relative) + 1);
    verifyAssetMagic(file);
  }
  if (!areAssetsValid(stagedOutput)) {
    throw new Error('Staged OCR asset set failed integrity validation before swap');
  }

  // 3. Crash-safe atomic swap: preserve previous output in backupOutput until new output is verified.
  mkdirSync(dirname(output), { recursive: true });
  let movedPreviousToBackup = false;
  if (existsSync(output)) {
    if (existsSync(backupOutput) && !areAssetsValid(backupOutput)) {
      rmSync(backupOutput, { recursive: true, force: true });
    }
    if (!existsSync(backupOutput)) {
      renameSync(output, backupOutput);
      movedPreviousToBackup = true;
    } else {
      renameSync(output, join(workDir, `displaced-invalid-${Date.now()}`));
    }
  }

  try {
    renameSync(stagedOutput, output);
    if (!areAssetsValid(output)) {
      throw new Error('Swapped OCR output failed post-swap integrity check');
    }
  } catch (swapError) {
    if (existsSync(output) && !areAssetsValid(output)) {
      rmSync(output, { recursive: true, force: true });
    }
    if (movedPreviousToBackup && !existsSync(output) && existsSync(backupOutput)) {
      renameSync(backupOutput, output);
    }
    throw swapError;
  }

  // Output is verified valid; safe to remove managed staging and backup paths.
  cleanupManagedTempPaths({ includeBackup: true });
  console.log(`Prepared ${requiredRelativeAssets.length} verified local OCR assets in ${resolve(output)}`);
  console.log(`Tesseract.js ${TESSERACT_VERSION}; core ${TESSERACT_CORE_VERSION} (dependency range ${coreRange}); language eng`);
} catch (error) {
  // Never delete existing public/tesseract assets; restore valid backup if output is missing/invalid.
  if (!areAssetsValid(output) && areAssetsValid(backupOutput)) {
    try {
      restoreBackupToOutput();
    } catch {
      // Preserve backupOutput on disk for next run's startup crash recovery.
    }
  }
  console.error('[web-ocr-assets] Preparation failed (existing assets preserved):', error?.message || error);
  process.exitCode = 1;
} finally {
  cleanupManagedTempPaths({ includeBackup: areAssetsValid(output) });
}

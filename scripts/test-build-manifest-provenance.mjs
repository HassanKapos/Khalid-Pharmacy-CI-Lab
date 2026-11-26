import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectBuildProvenance, formatAssetManifest } from './build-manifest-provenance.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khalid-manifest-prov-'));
const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khalid-manifest-nongit-'));
let passed = 0;

try {
  git(repoDir, ['init', '-b', 'fix/provenance-test']);
  git(repoDir, ['config', 'user.name', 'Test Runner']);
  git(repoDir, ['config', 'user.email', 'test@local']);

  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'android/app/src/main/assets/public'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'dist/index.html'), '<html>v1</html>\n', 'utf8');
  git(repoDir, ['add', 'src/app.ts']);
  git(repoDir, ['commit', '-m', 'baseline']);
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']);

  // Test 1: Clean repository reports clean state and matches Git base commit
  const cleanProv = collectBuildProvenance(repoDir);
  assert.equal(cleanProv.branch, 'fix/provenance-test');
  assert.equal(cleanProv.baseCommit, baseSha);
  assert.equal(cleanProv.workingTreeState, 'clean');
  assert.equal(cleanProv.dirtySourceFileCount, 0);
  assert.equal(cleanProv.sourceFingerprint, 'clean:matches-git-base-commit');

  const cleanManifest = formatAssetManifest({
    files: ['index.html'],
    outDir: path.join(repoDir, 'dist'),
    provenance: cleanProv,
    excludedCount: 2,
    generatedAt: '2026-11-23T00:00:00.000Z',
  });
  assert.ok(cleanManifest.includes(`Git Base Commit: ${baseSha}`));
  assert.ok(cleanManifest.includes('Working Tree State: clean'));
  assert.ok(cleanManifest.includes('Source Fingerprint: clean:matches-git-base-commit'));
  passed++;
  console.log('PASS [PROV-01]: Clean working tree reports clean state matching Git Base Commit');

  // Test 2: Dirty tracked source file reports dirty state with stable SHA-256 fingerprint
  fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v = 2;\n', 'utf8');
  const dirty1 = collectBuildProvenance(repoDir);
  const dirty1Repeat = collectBuildProvenance(repoDir);
  assert.equal(dirty1.branch, 'fix/provenance-test');
  assert.equal(dirty1.baseCommit, baseSha);
  assert.equal(dirty1.workingTreeState, 'dirty');
  assert.equal(dirty1.dirtySourceFileCount, 1);
  assert.match(dirty1.sourceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(dirty1.sourceFingerprint, dirty1Repeat.sourceFingerprint, 'Dirty fingerprint must be deterministic');
  passed++;
  console.log('PASS [PROV-02]: Dirty tracked source reports dirty state with deterministic SHA-256 fingerprint');

  // Test 3: Generated output writes in dist/ and android/app/src/main/assets/public/ do not alter source fingerprint
  fs.writeFileSync(path.join(repoDir, 'dist/extra.js'), 'console.log(1);\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'android/app/src/main/assets/public/index.html'), '<html>synced</html>\n', 'utf8');
  const dirtyAfterOutput = collectBuildProvenance(repoDir);
  assert.equal(dirtyAfterOutput.workingTreeState, 'dirty');
  assert.equal(dirtyAfterOutput.dirtySourceFileCount, 1);
  assert.equal(dirtyAfterOutput.sourceFingerprint, dirty1.sourceFingerprint);
  passed++;
  console.log('PASS [PROV-03]: Generated output directories do not perturb source dirty state or fingerprint');

  // Test 4: Further source edits change the dirty fingerprint
  fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v = 3;\n', 'utf8');
  const dirty2 = collectBuildProvenance(repoDir);
  assert.equal(dirty2.workingTreeState, 'dirty');
  assert.notEqual(dirty2.sourceFingerprint, dirty1.sourceFingerprint);
  passed++;
  console.log('PASS [PROV-04]: Distinct dirty source edits produce distinct SHA-256 fingerprints');

  // Test 5: Untracked source file is detected and increments dirty count
  fs.writeFileSync(path.join(repoDir, 'src/extra.ts'), 'export const extra = true;\n', 'utf8');
  const dirty3 = collectBuildProvenance(repoDir);
  assert.equal(dirty3.workingTreeState, 'dirty');
  assert.equal(dirty3.dirtySourceFileCount, 2);
  assert.notEqual(dirty3.sourceFingerprint, dirty2.sourceFingerprint);
  passed++;
  console.log('PASS [PROV-05]: Untracked source files mark working tree dirty and update fingerprint');

  // Test 6: Reverting source changes returns to clean state
  fs.rmSync(path.join(repoDir, 'src/extra.ts'));
  git(repoDir, ['checkout', '--', 'src/app.ts']);
  const cleanAgain = collectBuildProvenance(repoDir);
  assert.equal(cleanAgain.workingTreeState, 'clean');
  assert.equal(cleanAgain.dirtySourceFileCount, 0);
  assert.equal(cleanAgain.sourceFingerprint, 'clean:matches-git-base-commit');
  passed++;
  console.log('PASS [PROV-06]: Restoring source files returns manifest provenance to clean state');

  // Test 7: Non-Git directory never falsely claims clean
  const nonGitProv = collectBuildProvenance(nonGitDir);
  assert.equal(nonGitProv.workingTreeState, 'unknown');
  assert.equal(nonGitProv.baseCommit, 'unknown');
  assert.equal(nonGitProv.sourceFingerprint, 'unavailable:no-git-metadata');
  passed++;
  console.log('PASS [PROV-07]: Non-Git directory safely reports unknown state instead of clean');

  console.log(`BUILD MANIFEST PROVENANCE TESTS PASSED: ${passed}/7`);
} finally {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(nonGitDir, { recursive: true, force: true });
}

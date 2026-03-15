#!/usr/bin/env bun
/**
 * Release automation for obsidian-gcal-sync.
 *
 * Flow:
 *   1. Check clean git state
 *   2. Read current version from manifest.json
 *   3. Prompt for bump type: patch / minor / major / canary
 *   4. Update manifest.json, manifest-beta.json, versions.json, package.json
 *   5. Commit + tag + push  →  GitHub Actions builds & publishes the release
 */

import config from './config.json';

// ── Version helpers ────────────────────────────────────────────────────────────

type BumpType = 'patch' | 'minor' | 'major' | 'canary';

function bumpVersion(current: string, type: BumpType): string {
  if (type === 'canary') {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `${current}-canary.${ts}`;
  }

  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

// ── Shell helpers ──────────────────────────────────────────────────────────────

async function run(cmd: string, opts?: { silent?: boolean }): Promise<string> {
  const proc = Bun.spawn(['sh', '-c', cmd], {
    stdout: 'pipe',
    stderr: opts?.silent ? 'pipe' : 'inherit',
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Command failed: ${cmd}`);
  return out.trim();
}

async function isClean(): Promise<boolean> {
  const status = await run('git status --porcelain', { silent: true });
  return status === '';
}

// ── Interactive prompt ─────────────────────────────────────────────────────────

function ask(question: string): string {
  const result = prompt(question);
  if (result === null) {
    console.error('Aborted.');
    process.exit(1);
  }
  return result.trim();
}

function confirm(message: string): void {
  const answer = ask(`${message} (y/N)`).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.error('Aborted.');
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Clean state check
  if (!(await isClean())) {
    console.error('Error: uncommitted changes. Commit or stash first.');
    process.exit(1);
  }

  await run(`git checkout ${config.devBranch}`);

  // 2. Read current version
  const manifestFile = Bun.file('./manifest.json');
  const manifest = await manifestFile.json();
  const current: string = manifest.version;

  // 3. Prompt for bump type
  const options: BumpType[] = ['patch', 'minor', 'major', 'canary'];
  const previews = options.map((t) => `${t} → ${bumpVersion(current, t)}`);

  console.log(`\nCurrent version: ${current}`);
  console.log('Select bump type:');
  previews.forEach((p, i) => console.log(`  ${i + 1}) ${p}`));

  const choice = parseInt(ask('\nEnter choice (1-4)'), 10);
  if (isNaN(choice) || choice < 1 || choice > 4) {
    console.error('Invalid choice.');
    process.exit(1);
  }

  const bumpType = options[choice - 1];
  const newVersion = bumpVersion(current, bumpType);
  const isCanary = bumpType === 'canary';

  confirm(`\nBump "${current}" → "${newVersion}"?`);

  // 4. Update files
  const betaManifestFile = Bun.file('./manifest-beta.json');
  const betaManifest = await betaManifestFile.json();
  betaManifest.version = newVersion;
  await Bun.write(betaManifestFile, JSON.stringify(betaManifest, null, 2) + '\n');

  if (!isCanary) {
    // Stable: update all version files
    manifest.version = newVersion;
    await Bun.write(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

    const versionsFile = Bun.file('./versions.json');
    const versionsJson = await versionsFile.json();
    versionsJson[newVersion] = manifest.minAppVersion;
    await Bun.write(versionsFile, JSON.stringify(versionsJson, null, 2) + '\n');

    const packageFile = Bun.file('./package.json');
    const packageJson = await packageFile.json();
    packageJson.version = newVersion;
    await Bun.write(packageFile, JSON.stringify(packageJson, null, 2) + '\n');
  }

  // 5. Commit + tag + push
  await run('git add manifest.json manifest-beta.json versions.json package.json');
  await run(`git commit -m "[auto] bump version to \`${newVersion}\`"`);
  await run(`git tag -a ${newVersion} -m "release version ${newVersion}"`);
  await run(`git push origin ${config.devBranch}`);
  await run(`git push origin ${newVersion}`);

  console.log(`\n✓ Done — GitHub Actions will build and publish the release.`);
  console.log(`  ${config.github}/releases/tag/${newVersion}`);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

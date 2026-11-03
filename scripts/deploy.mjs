#!/usr/bin/env node
// Publishes the game to GitHub Pages: builds dist/, commits it as the gh-pages branch and pushes that
// branch. Your working tree and current branch are not touched (the commit is made from a temporary
// index). GitHub serves the branch at https://<owner>.github.io/<repo>/; the installed Quest app loads
// the game from there and picks up a new deploy the next time it starts.
// Usage: node scripts/deploy.mjs [--remote origin] [--no-push]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'gh-pages';

const git = (args, env, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (args) => { try { return git(args); } catch { return null; } };

/** https://<owner>.github.io/<repo>/ for a GitHub remote URL (https or ssh), else null. */
export function pagesUrl(remoteUrl) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl ?? '');
  if (!m) return null;
  return m[2].toLowerCase() === `${m[1].toLowerCase()}.github.io` ? `https://${m[1].toLowerCase()}.github.io/` : `https://${m[1].toLowerCase()}.github.io/${m[2]}/`;
}

function main() {
  const { values: opts } = parseArgs({
    options: {
      remote: { type: 'string', default: 'origin' },
      'no-push': { type: 'boolean', default: false },
    },
  });
  const remoteUrl = tryGit(['remote', 'get-url', opts.remote]);
  if (!remoteUrl && !opts['no-push']) throw new Error(`no git remote "${opts.remote}"; add one with: git remote add ${opts.remote} https://github.com/<you>/<repo>.git`);

  const out = path.join(ROOT, 'dist');
  const { files, version } = build(out);
  console.log(`Built dist/: ${files.length} files, version ${version}`);

  // Continue the published history when there is one, so every deploy is one commit on gh-pages.
  if (remoteUrl) tryGit(['fetch', '--quiet', opts.remote, `+refs/heads/${BRANCH}:refs/remotes/${opts.remote}/${BRANCH}`]);
  const parent = tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${opts.remote}/${BRANCH}`])
    ?? tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]);

  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'banana-deploy-')), 'index');
  let tree;
  try {
    const env = { GIT_INDEX_FILE: index };
    git(['--git-dir', path.join(ROOT, '.git'), '--work-tree', '.', 'add', '--all', '--force', '.'], env, out);
    tree = git(['write-tree'], env);
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }

  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`${BRANCH} already has this build.`);
  } else {
    const source = tryGit(['rev-parse', '--short', 'HEAD']);
    const dirty = tryGit(['status', '--porcelain']) ? ' with uncommitted changes' : '';
    const message = `Deploy build ${version}${source ? ` from ${source}` : ''}${dirty}`;
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    git(['update-ref', `refs/heads/${BRANCH}`, commit]);
    console.log(`${BRANCH} -> ${commit.slice(0, 7)}: ${message}`);
  }

  if (opts['no-push']) {
    console.log(`Not pushed (--no-push). Push later with: git push ${opts.remote} ${BRANCH}`);
    return;
  }
  execFileSync('git', ['push', opts.remote, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`], { cwd: ROOT, stdio: 'inherit' });
  const url = pagesUrl(remoteUrl);
  console.log(`Pushed. GitHub Pages serves it in a minute or two${url ? ` at ${url}` : ''}.`);
  console.log('First deploy: in the repository on GitHub, Settings > Pages > Source must be "Deploy from a branch", branch gh-pages, folder / (root).');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`deploy: ${(err.stderr || err.message).toString().trim()}`);
    process.exit(1);
  }
}

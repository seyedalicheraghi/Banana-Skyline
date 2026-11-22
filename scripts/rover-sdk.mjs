#!/usr/bin/env node
// Starts the FrodoBots Earth Rovers SDK (port 8000) for the Rover Cockpit. The SDK lives outside this
// project: ../earth-rovers-sdk by default (ROVER_SDK_DIR), with its own Python virtual environment (.venv).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dotenvValue, slugForm } from './sdk-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.env.ROVER_SDK_DIR || path.join(HERE, '..', '..', 'earth-rovers-sdk'));
const python = path.join(DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function fail(lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

if (!fs.existsSync(python)) fail([`No Earth Rovers SDK with a .venv in ${DIR}.`, 'Clone https://github.com/frodobots-org/earth-rovers-sdk there and install requirements.txt into .venv.']);
const envFile = path.join(DIR, '.env');
const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const set = name => new RegExp(`^\\s*${name}\\s*=\\s*"?[^"\\s#]`, 'm').test(env); // a value, not blank or commented out
if (!set('SDK_API_TOKEN') || !set('BOT_SLUG') || /PASTE_YOUR_|3x4mpl3t0k4n|weld-arm-ultron/.test(env)) {
  fail([`Fill in SDK_API_TOKEN and BOT_SLUG in ${envFile} first.`, 'The token is at https://my.frodobots.com/owner/settings (SDK access token).']);
}
if (set('MISSION_SLUG')) {
  fail([`${envFile} sets MISSION_SLUG: the SDK then waits for a mission before it shows video or drives.`,
    'The Rover Cockpit drives your own rover without missions: delete that line (or put # in front of it).']);
}

// FrodoBots finds the rover by its slug (lowercase, words joined by dashes, like weld-arm-ultron); its display
// name with spaces or capitals gets 404 "Bot unavailable for SDK". Pass the slug form instead: the SDK keeps an
// environment value over its .env (load_dotenv without override), so the file stays as written.
const childEnv = { ...process.env };
const slug = slugForm(dotenvValue(env, 'BOT_SLUG'));
if (!process.env.BOT_SLUG && slug) {
  childEnv.BOT_SLUG = slug;
  console.log(`BOT_SLUG in ${envFile} has spaces or capitals; using its slug form "${slug}".`);
}

console.log(`Earth Rovers SDK: http://localhost:8000/ (${DIR}). Leave this window open while you drive.`);
const child = spawn(python, ['-m', 'hypercorn', 'main:app', '--bind', '127.0.0.1:8000'], { cwd: DIR, stdio: 'inherit', env: childEnv });
child.on('exit', code => process.exit(code ?? 1));

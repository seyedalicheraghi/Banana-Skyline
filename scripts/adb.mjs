// Finds adb (Android Platform Tools) for the scripts that talk to a Quest over USB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', exe),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe),
  ];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const winget = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const dir of fs.readdirSync(winget)) {
        if (dir.startsWith('Google.PlatformTools')) candidates.push(path.join(winget, dir, 'platform-tools', exe));
      }
    } catch { /* winget not used */ }
    candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', exe));
  } else {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe));
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe));
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return exe; // hope it is on PATH
}

'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { zip, tarGz } = require('./wrappers/archives');

const TEMPLATES = path.join(__dirname, 'wrappers');
const ICONS = path.join(__dirname, '..', 'agy-daddy-host', 'assets', 'icons');
const APP = 'Agy-Daddy Launcher.app/Contents';

function asset(name, source, mode = 0o644) {
  return { name, data: fs.readFileSync(source), mode };
}

function template(name, source, { executable = false, tag, windows = false } = {}) {
  const entry = asset(name, path.join(TEMPLATES, source), executable ? 0o755 : 0o644);
  let text = entry.data.toString('utf8').replace(/\r\n/g, '\n');
  if (tag) text = text.replace('@@INSTALL_TAG@@', tag);
  if (windows) text = text.replace(/\n/g, '\r\n');
  return { ...entry, data: Buffer.from(text) };
}

function installer(name, windows = false) {
  const data = fs.readFileSync(path.join(__dirname, windows ? 'install.ps1' : 'install.sh'), 'utf8');
  const text = data.replace(/\r\n/g, '\n');
  return {
    name,
    mode: windows ? 0o644 : 0o755,
    data: Buffer.from(windows ? text.replace(/\n/g, '\r\n') : text)
  };
}

function icon(name, source) {
  return asset(name, path.join(ICONS, source));
}

function buildWrappers(outDir, tag, macosTray) {
  const tray = 'Agy-Daddy Tray.app/Contents';
  const nativeTray = macosTray ? [
    ['Info.plist', 0o644],
    ['MacOS/AgyDaddyTray', 0o755],
    ['Resources/swift-hash.txt', 0o644],
    ['_CodeSignature/CodeResources', 0o644]
  ].map(([name, mode]) => asset(`${APP}/Resources/${tray}/${name}`, path.join(macosTray, 'Contents', name), mode)) : [];

  const archives = [
    ['agy-daddy-launcher-macos.zip', zip([
      template(`${APP}/Info.plist`, 'macos/Info.plist'),
      template(`${APP}/MacOS/agy-daddy-launcher`, 'macos/agy-daddy-launcher', { executable: true }),
      template(`${APP}/Resources/launch.sh`, 'launch.sh', { executable: true, tag }),
      installer(`${APP}/Resources/install.sh`),
      icon(`${APP}/Resources/AgyDaddyLauncher.icns`, 'AgyDaddyLauncher.icns'),
      ...nativeTray,
      template('Install & Launch.command', 'macos/Install & Launch.command', { executable: true }),
      template('README.txt', 'macos/README.txt')
    ])],
    ['agy-daddy-launcher-windows.zip', zip([
      ...['Agy-Daddy-Launcher.cmd', 'Agy-Daddy-Launcher.vbs', 'install-and-launch.ps1',
        'Create-Desktop-Shortcut.ps1', 'README.txt'].map((name) =>
        template(name, `windows/${name}`, { tag, windows: true })
      ),
      installer('install.ps1', true),
      icon('agy-daddy-launcher.ico', 'agy-daddy-launcher.ico')
    ])],
    ['agy-daddy-launcher-linux.tar.gz', tarGz([
      template('agy-daddy-launcher.sh', 'launch.sh', { executable: true, tag }),
      template('install-desktop-entry.sh', 'linux/install-desktop-entry.sh', { executable: true }),
      template('agy-daddy-launcher.desktop', 'linux/agy-daddy-launcher.desktop'),
      installer('install.sh'),
      icon('icon-256.png', 'icon-256.png'),
      template('README.txt', 'linux/README.txt')
    ])]
  ];

  fs.mkdirSync(outDir, { recursive: true });
  const checksums = [];
  for (const [name, data] of archives) {
    fs.writeFileSync(path.join(outDir, name), data);
    checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
  fs.writeFileSync(path.join(outDir, 'agy-daddy-wrappers-sha256sums.txt'), checksums.join('\n') + '\n');
}

try {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string', default: path.join(__dirname, '..', '.release-artifacts', 'wrappers') },
      'macos-tray': { type: 'string' },
      tag: { type: 'string', default: 'latest' }
    }
  });
  if (!['latest', 'next'].includes(values.tag)) throw new Error('--tag must be latest or next');
  const outDir = path.resolve(values['out-dir']);
  buildWrappers(outDir, values.tag, values['macos-tray']);
  console.log(`Built Agy-Daddy wrappers in ${outDir}`);
} catch (error) {
  console.error(`Wrapper build failed: ${error.message}`);
  process.exitCode = 1;
}

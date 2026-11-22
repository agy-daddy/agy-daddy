'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src', 'renderer');
const distDir = path.join(rootDir, 'dist');
const outFile = path.join(distDir, 'host-renderer.js');

function buildHostRenderer() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8').trim();
  const lightDomCssPath = path.join(srcDir, 'lightdom-styles.css');
  const lightDomCss = fs.existsSync(lightDomCssPath)
    ? fs.readFileSync(lightDomCssPath, 'utf8').trim()
    : '';
  const themeSrc = fs.existsSync(path.join(srcDir, 'theme.js'))
    ? fs.readFileSync(path.join(srcDir, 'theme.js'), 'utf8').trim()
    : '';
  const runtime = fs.readFileSync(path.join(srcDir, 'host-runtime.js'), 'utf8').trim();

  const header = `'use strict';\n// Agy-Daddy Host Renderer Bundle v${pkg.version}\nconst __AGY_HOST_CSS__ = ${JSON.stringify(css)};\nconst __AGY_LIGHTDOM_CSS__ = ${JSON.stringify(lightDomCss)};\n`;
  const bundle = [header, themeSrc, runtime].filter(Boolean).join('\n\n') + '\n';

  // 构建前严格语法编译验证
  new vm.Script(bundle, { filename: 'host-renderer.js' });

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(outFile, bundle, 'utf8');
  return { outFile, bytes: Buffer.byteLength(bundle, 'utf8') };
}

if (require.main === module) {
  const res = buildHostRenderer();
  console.log(`[构建成功] 底座渲染层构建完成: ${res.outFile} (${res.bytes} 字节)`);
}

module.exports = { buildHostRenderer };

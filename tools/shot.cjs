/**
 * Screenshot harness for the desktop UI.
 *
 * Loads the built renderer in an Electron window and captures it. There is no
 * preload, so the UI falls back to its mock bridge - enough to check layout,
 * theme and the design system without a live engine behind it.
 *
 *   electron tools/shot.cjs out.png [width] [height] [light|dark] [click...]
 *
 * Each trailing argument is a label to click before capturing, matched against
 * a button's text, title or aria-label.
 */
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const [outFile, width = '1280', height = '860', theme = 'light', ...clicks] = process.argv.slice(2);

function clickScript(label) {
  return `(() => {
    const wanted = ${JSON.stringify(String(label).toLowerCase())};
    const nodes = Array.from(document.querySelectorAll('button, [role="button"]'));
    const text = (node) => [
      (node.textContent || '').trim(),
      node.getAttribute('title') || '',
      node.getAttribute('aria-label') || '',
    ].map((value) => value.trim().toLowerCase());
    const hit = nodes.find((node) => text(node).some((value) => value === wanted))
      || nodes.find((node) => text(node).some((value) => value.includes(wanted)));
    if (hit) hit.click();
    return Boolean(hit);
  })()`;
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';

  const win = new BrowserWindow({
    width: Number(width),
    height: Number(height),
    show: false,
    frame: false,
    backgroundColor: theme === 'dark' ? '#222226' : '#fafafa',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const index = path.join(__dirname, '..', 'apps', 'desktop', 'dist', 'renderer', 'index.html');
  await win.loadFile(index);
  // Let React mount and the mock bridge resolve.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  for (const label of clicks) {
    const matched = await win.webContents.executeJavaScript(clickScript(label));
    if (!matched) console.warn('no element matched:', label);
    // Long enough for a directory listing and the collapse transition.
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  const image = await win.webContents.capturePage();
  fs.writeFileSync(outFile, image.toPNG());
  console.log('wrote', outFile);
  app.quit();
});

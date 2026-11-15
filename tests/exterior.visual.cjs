// Optional visual smoke check: node tests/exterior.visual.cjs [output-directory]
// Uses the bundled browser runtime, with no debug hooks in the shipped HTML.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const dependencies = process.env.NODE_PATH || path.resolve(path.dirname(process.execPath), '../node_modules');
const { chromium } = require(path.join(dependencies, 'playwright'));
const sharp = require(path.join(dependencies, 'sharp'));

async function main() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '..', '.artifacts', 'exteriors'));
  fs.mkdirSync(output, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const instrumented = html.replace(/\}\)\(\);\s*<\/script>/, 'window.inspectGame = source => eval(source);})();</script>');
  assert.notEqual(html, instrumented);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/index.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: instrumented }));
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href);
    await page.addStyleTag({ content: '.app{max-width:none;width:1042px;padding:20px 36px}.game-frame{width:970px}canvas{width:960px!important;height:540px!important}' });
    await page.evaluate(() => window.inspectGame("reset();createLevel(707,false);enemies=[];atmosphere.phase=.5;atmosphere.time=14;atmosphere.day=.7;clock=20;$('overlay').classList.add('hidden');$('toast').classList.remove('visible');"));
    const tiles = [];
    for (let i = 0; i < 8; i++) {
      const setting = await page.evaluate(i => window.inspectGame(`lastExteriorSetting=EXTERIOR_SETTINGS[${i}];selectLevelSetting(707,false);({id:levelSetting.id,name:levelSetting.name})`), i);
      // Exercise every material at both ends of the world, in all sky phases.
      for (const camera of [0, 3220, 5640]) {
        for (const day of [0, .5, 1]) {
          await page.evaluate(({ camera, day }) => window.inspectGame(`camera=${camera};atmosphere.day=${day};draw()`), { camera, day });
        }
      }
      await page.evaluate(() => window.inspectGame('camera=140;atmosphere.day=.7;player.x=230;player.y=FLOOR-player.h;draw()'));
      const screenshot = await page.locator('#game').screenshot({ path: path.join(output, `${setting.id}.png`) });
      const label = Buffer.from(`<svg width="960" height="42"><rect width="960" height="42" fill="#0b141e"/><text x="18" y="28" fill="#d6e7dc" font-family="Arial" font-size="19">${String(i + 1).padStart(2, '0')} / ${setting.name}</text></svg>`);
      const fullTile = await sharp({ create: { width: 960, height: 582, channels: 4, background: '#0b141e' } }).composite([{ input: label, top: 0, left: 0 }, { input: screenshot, top: 42, left: 0 }]).png().toBuffer();
      const tile = await sharp(fullTile).resize(720, 437).png().toBuffer();
      tiles.push({ input: tile, left: i % 2 * 720, top: Math.floor(i / 2) * 437 });
    }
    await sharp({ create: { width: 1440, height: 1748, channels: 4, background: '#0b141e' } }).composite(tiles).png().toFile(path.join(output, 'all-settings.png'));
    assert.deepEqual(errors, []);
    // The actual controls keep the preview's setting, then rotate on restart.
    await page.reload();
    const preview = await page.locator('#settingLabel').textContent();
    await page.locator('#play').click();
    assert.equal(await page.locator('#settingLabel').textContent(), preview);
    await page.locator('#restart').click();
    assert.notEqual(await page.locator('#settingLabel').textContent(), preview);
    assert.equal(await page.locator('#skyPhase').textContent(), 'ПОДЗЕМНЫЙ');
    await page.evaluate(() => window.inspectGame("createLevel(707,false);spawn();$('toast').classList.remove('visible');"));
    for (const camera of [0, 900, 2400, 3000, 4100, 5640]) {
      await page.evaluate(camera => window.inspectGame(`camera=${camera};player.x=${camera}+160;player.y=Math.min(...platforms.filter(p=>p.type!=='ceiling'&&p.x<player.x+player.w&&p.x+p.w>player.x).map(p=>p.y))-player.h;draw()`), camera);
      await page.locator('#game').screenshot({ path: path.join(output, `underground-${camera}.png`) });
    }
    // Sky phases and existing celestial events cannot paint into the black passage.
    await page.evaluate(() => window.inspectGame('camera=0;player.x=80;player.y=FLOOR-player.h;draw()'));
    assert.deepEqual(await page.evaluate(() => window.inspectGame('Array.from(ctx.getImageData(470*renderScale,280*renderScale,1,1).data)')), [0, 0, 0, 255]);
    await page.evaluate(() => window.inspectGame("globalThis.skySnapshot=JSON.stringify(atmosphere);updateAtmosphere(30);draw()"));
    assert.equal(await page.evaluate(() => window.inspectGame('JSON.stringify(atmosphere)===skySnapshot')), true);
    await page.locator('#restart').click();
    assert.notEqual(await page.locator('#skyPhase').textContent(), 'ПОДЗЕМНЫЙ');
    for (const width of [768, 540, 390]) {
      await page.setViewportSize({ width, height: 844 });
      // Canvas resizing clears its bitmap; let ResizeObserver settle before drawing.
      await page.waitForTimeout(100);
      for (let i = 0; i < 8; i++) {
        await page.evaluate(i => window.inspectGame(`lastExteriorSetting=EXTERIOR_SETTINGS[${i}];createLevel(707,false);draw()`), i);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `setting ${i} at ${width}px`);
      }
      await page.evaluate(() => window.inspectGame("levelNumber=2;createLevel(707,false);spawn();$('toast').classList.remove('visible');draw()"));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `underground at ${width}px`);
      await page.screenshot({ path: path.join(output, `underground-mobile-${width}.png`), fullPage: true });
      await page.evaluate(() => window.inspectGame('levelNumber=3;createLevel(707,false);spawn()'));
    }
    await page.evaluate(() => window.inspectGame("$('toast').classList.remove('visible');draw()"));
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`8 exteriors, underground corridor, black background, stage controls and mobile layout passed. Preview: ${path.join(output, 'all-settings.png')}`);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

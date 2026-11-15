const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const dependencies = process.env.NODE_PATH || path.resolve(path.dirname(process.execPath), '../node_modules');
const { chromium } = require(path.join(dependencies, 'playwright'));

const root = path.join(__dirname, '..');
const publishedEntry = path.join(root, '.artifacts', 'github-publish', 'index.html');
const entries = process.env.GAME_HTML
  ? [path.resolve(process.env.GAME_HTML)]
  : [path.join(root, 'index.html'), ...(fs.existsSync(publishedEntry) ? [publishedEntry] : [])];

for (const entry of entries) {
  test(`winning and clicking Next level alternates stages in ${path.relative(path.join(__dirname, '..'), entry)}`, async () => {
    const html = fs.readFileSync(entry, 'utf8');
    const instrumented = html.replace(/\}\)\(\);\s*<\/script>/, 'window.inspectGame = source => eval(source);})();</script>');
    assert.notEqual(html, instrumented);
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
      const url = pathToFileURL(entry).href;
      await page.route(url, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: instrumented }));
      await page.goto(url);
      await page.locator('#play').click();
      for (let stage = 1; stage <= 4; stage++) {
        const expected = stage % 2 === 0 ? 'underground' : 'exterior';
        const actual = await page.evaluate(() => window.inspectGame('({number:typeof levelNumber==="undefined"?null:levelNumber,type:typeof levelType==="undefined"?null:levelType})'));
        assert.deepEqual(actual, { number: stage, type: expected });
        if (expected === 'underground') {
          assert.equal(await page.locator('#skyPhase').textContent(), 'ПОДЗЕМНЫЙ');
          assert.ok(await page.evaluate(() => window.inspectGame('platforms.some(p=>p.type==="ceiling")')));
        }
        // Finish through normal movement, enemies, checkpoint and the real win trigger.
        const result = await page.evaluate(() => window.inspectGame(`(()=>{
          input.right=true;input.jump=true;input.run=false;
          let next=0,frames=0;
          while(state==='playing'&&frames++<120*45){
            if(next<levelJumps.length&&player.grounded&&player.x>=levelJumps[next].x){jumpBuffer=.14;next++}
            update(1/120);
          }
          draw();return {state,lives,checkpointTaken};
        })()`));
        assert.equal(result.state, 'won');
        assert.ok(result.lives >= 3);
        assert.equal(result.checkpointTaken, true);
        assert.match(await page.locator('#play').textContent(), /СЛЕДУЮЩИЙ УРОВЕНЬ/);
        if (stage < 4) await page.locator('#play').click();
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

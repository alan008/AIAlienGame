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
  test(`resurrection keeps the stage and victory advances it in ${path.relative(path.join(__dirname, '..'), entry)}`, async () => {
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
        const layoutSource = 'JSON.stringify([levelNumber,levelType,levelSeed,levelSetting,settingBag,scenery,platforms,blocks,coins,enemies,levelJumps,caveLights,caveEggs])';
        const originalLayout = await page.evaluate(source => window.inspectGame(source), layoutSource);
        // Lose every life through the real falling/death flow, then click the visible button.
        for (let life = 0; life < 3; life++) {
          await page.evaluate(() => window.inspectGame('player.y=H+100;player.vy=0;player.grounded=false;update(1/120);update(1.2);draw()'));
        }
        assert.equal(await page.evaluate(() => window.inspectGame('state')), 'gameover');
        assert.match(await page.locator('#play').textContent(), /ВОСКРЕСНУТЬ/);
        await page.locator('#play').click();
        assert.equal(await page.evaluate(source => window.inspectGame(source), layoutSource), originalLayout);
        assert.deepEqual(await page.evaluate(() => window.inspectGame('({state,lives,timeLeft,x:player.x,checkpointTaken})')), { state: 'playing', lives: 3, timeLeft: 180, x: 80, checkpointTaken: false });
        // Finish through normal movement, enemies, checkpoint and the real win trigger.
        const result = await page.evaluate(() => window.inspectGame(`(()=>{
          input.right=true;input.jump=true;input.run=false;
          let deaths=0;const originalDie=die;die=()=>{if(state==='playing')deaths++;originalDie()};
          let next=0,frames=0;const passedEggs=new Set();
          while(state==='playing'&&frames++<120*75){
            let wait=false;
            for(const egg of caveEggs)if(!passedEggs.has(egg)&&player.x>=egg.x-130&&player.x<egg.x+55){
              if(egg.timer<1.5||caveAcid.some(drop=>Math.abs(drop.x-egg.x)<45))wait=true;else passedEggs.add(egg);
            }
            input.right=!wait;
            if(next<levelJumps.length&&player.grounded&&player.x>=levelJumps[next].x){jumpBuffer=.14;next++}
            update(1/120);
          }
          die=originalDie;draw();return {state,lives,checkpointTaken,deaths};
        })()`));
        assert.equal(result.state, 'won');
        assert.ok(result.lives >= 3);
        assert.equal(result.checkpointTaken, true);
        assert.equal(result.deaths, 0);
        assert.match(await page.locator('#play').textContent(), /СЛЕДУЮЩИЙ УРОВЕНЬ/);
        if (stage < 4) await page.locator('#play').click();
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

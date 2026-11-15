// Real Canvas pixel checks: light direction, facing, silhouettes and rock occlusion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dependencies = process.env.NODE_PATH || path.resolve(path.dirname(process.execPath), '../node_modules');
const { chromium } = require(path.join(dependencies, 'playwright'));

async function main() {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '..', '.artifacts', 'lighting'));
  fs.mkdirSync(output, { recursive: true });
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const instrumented = html.replace(/\}\)\(\);\s*<\/script>/, 'window.inspectGame = source => eval(source);})();</script>');
  assert.notEqual(html, instrumented);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
    await page.route('**/index.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: instrumented }));
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href);
    const checks = await page.evaluate(() => window.inspectGame(`(()=>{
      reset();levelNumber=2;createLevel(707,false);spawn();clock=2;
      const fixtureLayout=JSON.stringify(caveLights),route=JSON.stringify([platforms,levelJumps,enemies,coins]);
      createLevel(707,false);
      if(JSON.stringify(caveLights)!==fixtureLayout||JSON.stringify([platforms,levelJumps,enemies,coins])!==route)throw new Error('Lighting changed a seeded map');
      if(caveLights.length<16)throw new Error('Too few wall fixtures');
      for(let seed=0;seed<100;seed++){
        createLevel(seed,false);
        for(const light of caveLights){
          if(platforms.some(p=>overlap({x:light.x-12,y:light.y-22,w:24,h:44},p)))throw new Error('Fixture inside a rock, seed '+seed);
          if(!platforms.some(p=>p.type==='ceiling'&&light.x>=p.x&&light.x<p.x+p.w&&light.mountY===p.h))throw new Error('Unattached fixture');
        }
      }
      createLevel(707,false);
      checkpoint=3220;spawn(1.8);
      if(JSON.stringify(caveLights)!==fixtureLayout)throw new Error('Respawn moved the fixtures');
      const results=[];
      renderScale=2;canvas.width=W*2;canvas.height=H*2;atmosphere.time=clock;atmosphere.land=0;
      for(const kind of ['player','adult','larva'])for(const face of [-1,1]){
        platforms=[];
        player={...player,x:450,y:380,face,vx:0,grounded:true,invincible:0,step:0,muzzleFlash:0};
        const body=kind==='player'?player:{x:450,y:380,w:kind==='larva'?28:32,h:kind==='larva'?22:30,type:kind,alive:true,squash:0,hitFlash:0,vx:face*46,direction:face,grounded:true};
        const paint=kind==='player'?drawPlayer:()=>drawEnemy(body),cx=body.x+body.w/2,cy=body.y+body.h*.45;
        const light={x:cx-110,y:cy,mountY:180,radius:330,power:1,phase:0,color:[255,190,110]};
        const capture=()=>{
          ctx.setTransform(2,0,0,2,0,0);ctx.clearRect(0,0,W,H);drawLitSprite(body,paint);
          return ctx.getImageData((body.x-40)*2,(body.y-32)*2,256,224).data;
        };
        levelType='underground';caveLights=[];const dark=capture();
        caveLights=[light];const left=capture();
        caveLights=[{...light,x:cx+110}];const right=capture();
        caveLights=[{...light,x:cx-260}];const far=capture();
        caveLights=[light];platforms=[{x:body.x-60,y:body.y-60,w:20,h:140,type:'caveRock'}];const blocked=capture();
        const gains=[0,0,0,0],counts=[0,0];
        let silhouetteDifference=0,blockedDifference=0,farGain=0;
        for(let i=0;i<dark.length;i+=4){
          silhouetteDifference=Math.max(silhouetteDifference,Math.abs(dark[i+3]-left[i+3]),Math.abs(dark[i+3]-right[i+3]));
          if(dark[i+3]<230)continue;
          const side=(i/4%256)/2-40<body.w/2?0:1;
          counts[side]++;
          const luminance=(pixels)=>pixels[i]*.2126+pixels[i+1]*.7152+pixels[i+2]*.0722;
          gains[side]+=luminance(left)-luminance(dark);gains[2+side]+=luminance(right)-luminance(dark);
          farGain+=luminance(far)-luminance(dark);
          for(let channel=0;channel<3;channel++)blockedDifference=Math.max(blockedDifference,Math.abs(blocked[i+channel]-dark[i+channel]));
        }
        if(farGain>=(gains[0]+gains[1])*.45)throw new Error('Light does not fade with distance');
        results.push({kind,face,leftGains:[gains[0]/counts[0],gains[1]/counts[1]],rightGains:[gains[2]/counts[0],gains[3]/counts[1]],silhouetteDifference,blockedDifference});
      }
      return results;
    })()`));
    for (const result of checks) {
      const name = `${result.kind}, facing ${result.face}`;
      assert.ok(result.leftGains[0] > result.leftGains[1] * 1.4, `${name}: left light must brighten the left side: ${JSON.stringify(result)}`);
      assert.ok(result.rightGains[1] > result.rightGains[0] * 1.4, `${name}: right light must brighten the right side: ${JSON.stringify(result)}`);
      assert.ok(result.silhouetteDifference <= 1, `${name}: lighting changed transparency outside the sprite: ${JSON.stringify(result)}`);
      assert.equal(result.blockedDifference, 0, `${name}: light passed through a solid rock`);
    }
    await page.evaluate(() => window.inspectGame("platforms=[];levelNumber=2;createLevel(707,false);checkpoint=80;spawn();clock=20;$('overlay').classList.add('hidden');$('toast').classList.remove('visible');"));
    for (const camera of [0, 900, 3000, 4100, 5640]) {
      await page.evaluate(camera => window.inspectGame(`camera=${camera};player.x=${camera}+160;player.y=Math.min(...platforms.filter(p=>p.type!=='ceiling'&&p.x<player.x+player.w&&p.x+p.w>player.x).map(p=>p.y))-player.h;draw()`), camera);
      await page.locator('#game').screenshot({ path: path.join(output, `cave-${camera}.png`) });
    }
    const timing = await page.evaluate(() => window.inspectGame('(()=>{const started=performance.now();for(let i=0;i<120;i++){clock+=1/60;draw()}return (performance.now()-started)/120})()'));
    console.log('Directional sprite checks:', JSON.stringify(checks));
    console.log(`Average cave render: ${timing.toFixed(2)} ms; previews: ${output}`);
    await page.evaluate(() => window.inspectGame('levelNumber=3;createLevel(707,false);draw()'));
    assert.equal(await page.evaluate(() => window.inspectGame('caveLights.length')), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

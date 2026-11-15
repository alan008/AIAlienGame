const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Run the actual standalone game with a minimal DOM. Expose its closure only in
// this test copy: the HTML does not need production debug hooks or dependencies.
function game() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = new Map();
  const nodes = new Map();
  const context2d = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      return () => {};
    },
  });
  function node(id, action) {
    const classes = new Set();
    const events = new Map();
    return {
      id,
      dataset: action ? { action } : {},
      style: {},
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
        contains(value) { return classes.has(value); },
      },
      addEventListener(type, callback) { events.set(type, callback); },
      dispatch(type, event) { events.get(type)?.(event); },
      getContext() { return context2d; },
      getBoundingClientRect() { return { width: 960, height: 540 }; },
      setAttribute() {},
      setPointerCapture() {},
      blur() {},
    };
  }
  const touch = ['left', 'right', 'jump', 'shoot'].map(action => node(action, action));
  const document = {
    hidden: false,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id));
      return nodes.get(id);
    },
    querySelectorAll() { return touch; },
    addEventListener() {},
  };
  const sandbox = {
    document,
    window: {
      devicePixelRatio: 1,
      addEventListener(type, callback) { listeners.set(type, callback); },
    },
    HTMLButtonElement: class {},
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    setTimeout() {},
    console,
  };
  vm.createContext(sandbox);
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.inspectGame = source => eval(source);\n})();');
  assert.notEqual(instrumented, source, 'game closure is instrumented');
  vm.runInContext(instrumented, sandbox, { filename: 'index.html' });
  const run = sandbox.inspectGame;
  run("reset(); platforms=[]; enemies=[]; particles=[]; acidParticles=[]; bullets=[]; player.x=100; player.y=100; player.vx=0; player.vy=0; player.face=1; player.grounded=true; Math.random=()=>.5;");
  return {
    run,
    key(type, code) {
      listeners.get(type)?.({ code, target: {}, repeat: false, preventDefault() {} });
    },
    pointer(type, action, pointerId) {
      touch.find(button => button.dataset.action === action).dispatch(type, { pointerId, preventDefault() {} });
    },
    blur() { listeners.get('blur')?.(); },
  };
}

test('first seven hits cannot kill even with the luckiest roll; eighth can', () => {
  const { run } = game();
  run('addEnemy(200,0,500); Math.random=()=>0;');
  for (let hit = 1; hit <= 7; hit++) {
    run('hitEnemy(enemies[0],200,440,1)');
    assert.equal(run('enemies[0].alive'), true);
    assert.equal(run('enemies[0].hits'), hit);
    assert.equal(run('score'), 0, 'nonlethal shots must not farm points');
  }
  assert.ok(run('acidParticles.length') > 0, 'surviving hits emit acid');
  run('hitEnemy(enemies[0],200,440,1)');
  assert.equal(run('enemies[0].hits'), 8);
  assert.equal(run('enemies[0].alive'), false);
  assert.ok(run('score') > 0);
});

test('eligible shots use exactly a five-percent threshold', () => {
  const { run } = game();
  run('addEnemy(200,0,500); enemies[0].hits=7; Math.random=()=>.05; hitEnemy(enemies[0],200,440,1);');
  assert.equal(run('enemies[0].alive'), true, 'roll at threshold survives');
  run('Math.random=()=>.049999; hitEnemy(enemies[0],200,440,1);');
  assert.equal(run('enemies[0].alive'), false, 'roll below threshold kills');
  let deaths = 0;
  for (let bucket = 0; bucket < 20; bucket++) {
    run(`enemies=[]; addEnemy(200,0,500); enemies[0].hits=20; Math.random=()=>${(bucket + .5) / 20}; hitEnemy(enemies[0],200,440,1);`);
    if (!run('enemies[0].alive')) deaths++;
  }
  assert.equal(deaths, 1, 'one of twenty equal random intervals kills');
});

test('shots fly horizontally in the facing direction, including left', () => {
  for (const direction of [-1, 1]) {
    const { run } = game();
    run(`player.x=400; player.face=${direction}; shoot(); globalThis.start={x:bullets[0].x,y:bullets[0].y}; updateBullets(.1);`);
    assert.equal(run('bullets.length'), 1);
    assert.equal(run('bullets[0].y'), run('start.y'));
    assert.equal(Math.sign(run('bullets[0].x-start.x')), direction);
  }
});

test('a fast shot hits only the nearest living alien regardless of array order', () => {
  for (const direction of [-1, 1]) {
    const { run } = game();
    run(direction === 1
      ? 'addEnemy(300,0,600); addEnemy(180,0,600);'
      : 'player.x=400; player.face=-1; addEnemy(150,0,600); addEnemy(300,0,600);');
    run('enemies.forEach(e=>e.y=100); shoot(); updateBullets(.35);');
    assert.equal(run('enemies[0].hits'), 0);
    assert.equal(run('enemies[1].hits'), 1);
    assert.equal(run('bullets.length'), 0);
  }
});

test('walls block bullets in either direction, even over a long step', () => {
  for (const direction of [-1, 1]) {
    const { run } = game();
    run(direction === 1
      ? 'addEnemy(300,0,600); addPlatform(210,80,4,80);'
      : 'player.x=400; player.face=-1; addEnemy(150,0,600); addPlatform(290,80,4,80);');
    run('enemies[0].y=100; shoot(); updateBullets(.4);');
    assert.equal(run('enemies[0].hits'), 0);
    assert.equal(run('bullets.length'), 0);
  }
});

test('the first alien is hittable before a wall; dead aliens do not absorb shots', () => {
  const { run } = game();
  run('addEnemy(250,0,600); addEnemy(170,0,600); enemies.forEach(e=>e.y=100); enemies[1].alive=false; addPlatform(310,80,10,80); shoot(); updateBullets(.4);');
  assert.equal(run('enemies[0].hits'), 1);
  assert.equal(run('enemies[1].hits'), 0);
  assert.equal(run('bullets.length'), 0);
});

test('an adjacent wall cannot be bypassed by the protruding muzzle', () => {
  for (const direction of [-1, 1]) {
    const { run } = game();
    run(direction === 1
      ? 'addPlatform(player.x+player.w,80,4,80); addEnemy(200,0,600);'
      : 'player.x=400; player.face=-1; addPlatform(player.x-4,80,4,80); addEnemy(250,0,600);');
    run('enemies[0].y=100; shoot(); updateBullets(.3);');
    assert.equal(run('enemies[0].hits'), 0);
    assert.equal(run('bullets.length'), 0);
  }
});

test('aliens above or below the horizontal shot are missed', () => {
  const { run } = game();
  run('addEnemy(180,0,600); enemies[0].y=180; shoot(); updateBullets(.3);');
  assert.equal(run('enemies[0].hits'), 0);
});

test('holding fire respects cooldown and releases cleanly', () => {
  const { run, key } = game();
  key('keydown', 'KeyF');
  run('update(1/120)');
  assert.equal(run('bullets.length'), 1);
  run('shoot()');
  assert.equal(run('bullets.length'), 1, 'cannot spam within the cooldown');
  run('for(let i=0;i<24;i++) update(1/120)');
  assert.equal(run('bullets.length'), 2, 'holding fire creates another shot');
  key('keyup', 'KeyF');
  run('for(let i=0;i<24;i++) update(1/120)');
  assert.equal(run('bullets.length'), 2, 'release stops shooting');
});

test('touch can move and shoot together; cancellation clears only its own pointer', () => {
  const { run, pointer } = game();
  pointer('pointerdown', 'right', 1);
  pointer('pointerdown', 'shoot', 2);
  assert.equal(run('input.right && input.shoot'), true);
  run('update(1/120)');
  assert.equal(run('bullets.length'), 1);
  pointer('pointercancel', 'shoot', 2);
  assert.equal(run('input.shoot'), false);
  assert.equal(run('input.right'), true);
  pointer('pointerup', 'right', 1);
  assert.equal(run('input.right'), false);
});

test('pause prevents firing and freezes projectiles, then resumes without held fire', () => {
  const { run, key } = game();
  key('keydown', 'KeyF');
  run('update(1/120); pause(); globalThis.pausedShot=JSON.stringify(bullets);');
  assert.equal(run('input.shoot'), false);
  run('shoot(); update(.5)');
  assert.equal(run('JSON.stringify(bullets)'), run('pausedShot'));
  run('pause(); update(1/120)');
  assert.equal(run('bullets.length'), 1);
  assert.equal(run('input.shoot'), false);
});

test('blur pauses and clears all shooting inputs', () => {
  const { run, key, blur } = game();
  key('keydown', 'KeyF');
  blur();
  assert.equal(run('state'), 'paused');
  assert.equal(run('input.shoot'), false);
  assert.equal(run('held.size'), 0);
});

test('reset discards projectiles, acid and all enemy hit history', () => {
  const { run } = game();
  run('addEnemy(200,0,600); hitEnemy(enemies[0],200,440,1); shoot(); reset();');
  assert.equal(run('bullets.length'), 0);
  assert.equal(run('acidParticles.length'), 0);
  assert.equal(run('enemies.every(e=>e.hits===0 && e.alive)'), true);
  assert.equal(run('player.shotCooldown'), 0);
});

test('death and respawn cannot carry a shot into the next life', () => {
  const { run } = game();
  run('shoot(); die(); spawn(1.8);');
  assert.equal(run('bullets.length'), 0);
  assert.equal(run('input.shoot'), false);
  assert.equal(run('player.shotCooldown'), 0);
});

test('expired shots and acid particles are removed', () => {
  const { run } = game();
  run('shoot(); acidBurst(100,100,1); for(let i=0;i<600;i++){updateBullets(1/120);updateCombatFX(1/120)}');
  assert.equal(run('bullets.length'), 0);
  assert.equal(run('acidParticles.length'), 0);
});

test('one in four red cubes releases a larva instead of purging adults', () => {
  let releases = 0;
  for (let bucket = 0; bucket < 4; bucket++) {
    const { run } = game();
    run(`addEnemy(350,300,550); globalThis.cube=addBlock(200,250,'purge'); Math.random=()=>${(bucket + .5) / 4}; hitBlock(cube);`);
    const larva = run("enemies.some(e=>e.type==='larva')");
    if (larva) releases++;
    assert.equal(run('enemies[0].alive'), larva, 'a failed purge leaves the adults alive');
    assert.equal(run('cube.destroyed && cube.used && !platforms.includes(cube)'), true);
    if (larva) {
      assert.equal(run('score'), 0, 'a larva release does not earn a purge bonus');
      assert.equal(run('purgeFX.time'), 0, 'a larva release does not trigger screen purge effects');
      assert.ok(run('enemies[1].x>=cube.x && enemies[1].x+enemies[1].w<=cube.x+40'));
      assert.ok(run('enemies[1].vy<0 && enemies[1].vx!==0'), 'the larva is thrown out upwards and sideways');
    }
    const count = run('enemies.length');
    run('hitBlock(cube)');
    assert.equal(run('enemies.length'), count, 'a destroyed cube cannot release another larva');
  }
  assert.equal(releases, 1);
  const { run } = game();
  run("Math.random=()=>.25; hitBlock(addBlock(200,250,'purge'));");
  assert.equal(run("enemies.some(e=>e.type==='larva')"), false, 'the exact .25 boundary purges normally');
});

test('each grounded hop reverses direction with exactly a one-in-four chance', () => {
  let reversals = 0;
  for (let bucket = 0; bucket < 4; bucket++) {
    const { run } = game();
    run(`globalThis.larva=releaseLarva({x:500,y:300}); addPlatform(0,460,900,100); Object.assign(larva,{x:500,y:438,vx:0,vy:0,direction:1,grounded:true,jumpWait:0}); Math.random=()=>${(bucket + .5) / 4}; updateLarva(larva,1/120);`);
    if (run('larva.direction') === -1) reversals++;
    assert.equal(run('Math.sign(larva.vx)'), run('larva.direction'));
    assert.ok(run('larva.y<438 && Math.abs(larva.vx)>0'));
    run('globalThis.airDirection=larva.direction; Math.random=()=>0; updateLarva(larva,1/120);');
    assert.equal(run('larva.direction'), run('airDirection'), 'no repeated direction rolls in midair');
  }
  assert.equal(reversals, 1);
});

test('larvae jump as high as a full Ripley jump and travel sideways', () => {
  const { run } = game();
  run(`addPlatform(0,460,2000,100); globalThis.larva=releaseLarva({x:800,y:300});
    Object.assign(larva,{x:800,y:438,vx:0,vy:0,direction:1,grounded:true,jumpWait:0});
    Object.assign(player,{x:100,y:428,grounded:true,coyote:.11,invincible:99}); input.jump=true; jumpBuffer=.14;
    globalThis.playerRise=0; globalThis.larvaRise=0;
    for(let i=0;i<49;i++){update(1/120); playerRise=Math.max(playerRise,428-player.y); larvaRise=Math.max(larvaRise,438-larva.y);}`);
  assert.ok(run('playerRise') > 115);
  assert.ok(Math.abs(run('playerRise-larvaRise')) < .001);
  assert.ok(run('larva.x') > 850);
  assert.equal(run('larva.alive'), true);
});

test('larvae pause on landing, do not walk, and hop again after crouching', () => {
  const { run } = game();
  run(`addPlatform(0,460,1500,100); globalThis.larva=releaseLarva({x:500,y:300});
    Object.assign(larva,{x:500,y:437,vx:150,vy:200}); updateLarva(larva,1/120); globalThis.landingX=larva.x;`);
  assert.equal(run('larva.grounded'), true);
  assert.equal(run('larva.y+larva.h'), 460);
  run('for(let i=0;i<8;i++)updateLarva(larva,1/120);');
  assert.equal(run('larva.x'), run('landingX'));
  run('for(let i=0;i<12;i++)updateLarva(larva,1/120);');
  assert.equal(run('larva.grounded'), false);
  assert.ok(run('larva.y') < 438);
});

test('larvae land on raised platforms and bounce against solid walls', () => {
  const { run } = game();
  run(`globalThis.larva=releaseLarva({x:500,y:300}); addPlatform(400,300,300,20);
    Object.assign(larva,{x:500,y:277,vx:150,vy:200,direction:1}); updateLarva(larva,1/120);`);
  assert.equal(run('larva.grounded'), true);
  assert.equal(run('larva.y+larva.h'), 300);
  run('platforms=[]; addPlatform(530,0,40,460); Object.assign(larva,{x:501,y:200,vx:150,vy:0,direction:1,grounded:false}); updateLarva(larva,1/60);');
  assert.equal(run('larva.direction'), -1);
  assert.equal(run('larva.x+larva.w<=530'), true);
});

test('landing on a larva hurts Ripley and never crushes the larva', () => {
  const { run } = game();
  run(`addPlatform(0,460,1000,100); globalThis.larva=releaseLarva({x:500,y:300});
    Object.assign(larva,{x:500,y:438,vx:0,vy:0,grounded:true,jumpWait:.14});
    Object.assign(player,{x:500,y:406,vy:100,grounded:false,invincible:0}); update(1/120);`);
  assert.equal(run('larva.alive'), true);
  assert.equal(run('larva.hits'), 0);
  assert.equal(run('state'), 'dying');
  assert.equal(run('lives'), 2);
});

test('a larva dies on the fifth bullet regardless of the adult random roll', () => {
  for (const roll of [0, .999]) {
    const { run } = game();
    run(`globalThis.larva=releaseLarva({x:200,y:100}); Math.random=()=>${roll}; acidParticles=[];`);
    for (let hit = 1; hit <= 5; hit++) {
      run('player.shotCooldown=0; shoot(); updateBullets(.2);');
      assert.equal(run('larva.hits'), hit);
      assert.equal(run('larva.alive'), hit < 5);
      assert.equal(run('score'), hit < 5 ? 0 : 400);
    }
    run('hitEnemy(larva,200,112,1)');
    assert.equal(run('larva.hits'), 5, 'dead larvae do not absorb further hits');
    assert.equal(run('score'), 400);
    assert.ok(run('acidRipples.length') > 0);
  }
});

test('a larva death produces a larger blue spray than an adult death', () => {
  const { run } = game();
  run('addEnemy(200,0,500); enemies[0].hits=7; Math.random=()=>0; hitEnemy(enemies[0],200,440,1);');
  const adultSpray = run('acidParticles.length');
  run('acidParticles=[]; globalThis.larva=releaseLarva({x:300,y:300}); acidParticles=[]; larva.hits=4; hitEnemy(larva,300,312,1);');
  assert.ok(run('acidParticles.length') > adultSpray * 2);
  assert.equal(run('acidParticles.every(p=>p.blue)'), true);
  assert.ok(run('acidParticles.some(p=>p.ribbon)'));
  assert.equal(run('acidRipples.length'), 1);
});

test('successful purges remove visible larvae with blue death effects', () => {
  const { run } = game();
  run("globalThis.larva=releaseLarva({x:300,y:300}); acidParticles=[]; Math.random=()=>.5; hitBlock(addBlock(200,250,'purge'));");
  assert.equal(run('larva.alive'), false);
  assert.equal(run('acidRipples.length'), 1);
  assert.ok(run('acidParticles.length') >= 112);
});

test('pause freezes larvae and blue effects; reset clears them', () => {
  const { run } = game();
  run(`globalThis.larva=releaseLarva({x:300,y:300}); larvaDeathFX(larva); pause();
    globalThis.frozen=JSON.stringify([larva,acidParticles,acidRipples]); update(.5);`);
  assert.equal(run('JSON.stringify([larva,acidParticles,acidRipples])'), run('frozen'));
  run('pause(); updateCombatFX(2);');
  assert.equal(run('acidParticles.length+acidRipples.length'), 0);
  run('reset()');
  assert.equal(run("enemies.some(e=>e.type==='larva')"), false);
  assert.equal(run('acidRipples.length'), 0);
});

test('larvae falling into gaps are removed without a kill reward', () => {
  const { run } = game();
  run('globalThis.larva=releaseLarva({x:300,y:300}); for(let i=0;i<300;i++)updateLarva(larva,1/120);');
  assert.equal(run('larva.alive'), false);
  assert.equal(run('score'), 0);
});

test('1000 seeded maps have a collision-free route from spawn and checkpoint', () => {
  const { run } = game();
  const stats = run(`(()=>{
    const totals={maps:0,fallbacks:0,gaps:0,obstacles:0,enemies:0,ledges:0,redCubes:0,coins:0,maxAttempts:0};
    for(let seed=0;seed<1000;seed++){
      createLevel(seed,false);
      if(!validateLevelRoute().ok||!validateLevelRoute(3220).ok)throw new Error('Unreachable map '+seed);
      if(levelProof.fallback)totals.fallbacks++;
      totals.maps++;totals.maxAttempts=Math.max(totals.maxAttempts,levelProof.attempts);
      totals.gaps+=platforms.filter(p=>p.type==='ground').length-1;
      totals.obstacles+=platforms.filter(p=>p.type==='pipe'||p.type==='step').length;
      totals.ledges+=platforms.filter(p=>p.type==='ledge').length;
      totals.enemies+=enemies.length;totals.redCubes+=blocks.filter(b=>b.type==='purge').length;totals.coins+=coins.length;
      const ground=platforms.filter(p=>p.type==='ground').sort((a,b)=>a.x-b.x);
      for(let i=1;i<ground.length;i++)if(ground[i].x-ground[i-1].x-ground[i-1].w>120)throw new Error('Oversized gap '+seed);
      for(const x of [80,3220,6120]){
        if(!ground.some(p=>p.x<=x&&p.x+p.w>=x+26))throw new Error('Unsafe spawn or finish '+seed);
        if(enemies.some(e=>x+100>e.left&&x-100<e.right))throw new Error('Enemy beside spawn or finish '+seed);
      }
      if(enemies.some(e=>!ground.some(p=>e.left>=p.x&&e.right<=p.x+p.w)))throw new Error('Enemy over a gap '+seed);
      if(platforms.some(p=>(p.type==='pipe'||p.type==='step')&&p.h>80))throw new Error('Oversized obstacle '+seed);
    }
    return totals;
  })()`);
  console.log('Generated level statistics:', JSON.stringify(stats));
  assert.equal(stats.maps, 1000);
  assert.equal(stats.fallbacks, 0, 'normal seeds must not need the emergency flat layout');
  assert.ok(stats.gaps / stats.maps >= 4 && stats.gaps / stats.maps <= 9);
  assert.ok(stats.obstacles / stats.maps >= 3 && stats.obstacles / stats.maps <= 6);
  assert.ok(stats.enemies / stats.maps >= 7 && stats.enemies / stats.maps <= 14);
  assert.ok(stats.ledges / stats.maps >= 10 && stats.ledges / stats.maps <= 16);
  assert.ok(stats.redCubes / stats.maps >= 8 && stats.redCubes / stats.maps <= 12);
});

test('seeded generation is reproducible and different seeds produce different layouts', () => {
  const { run } = game();
  const layout = () => run('JSON.stringify([platforms,coins,enemies,levelJumps])');
  run('createLevel(12345,false)');
  const first = layout();
  run('Math.random=()=>.999; createLevel(12345,false)');
  assert.equal(layout(), first, 'combat randomness cannot change a seeded layout');
  run('createLevel(54321,false)');
  assert.notEqual(layout(), first);
  for (const seed of [0, 1, 0xffffffff, 0x80000000]) {
    run(`createLevel(${seed},false)`);
    assert.equal(run('validateLevelRoute().ok'), true);
  }
});

test('1000 underground maps have solid boundaries, grounded obstacles and verified routes', () => {
  const { run } = game();
  const stats = JSON.parse(run(`(()=>{
    levelNumber=2;
    const totals={maps:0,fallbacks:0,rocks:0,enemies:0};
    let original='';
    for(let seed=0;seed<1000;seed++){
      createLevel(seed,false);
      if(levelType!=='underground'||!validateLevelRoute().ok||!validateLevelRoute(3220).ok)throw new Error('Unreachable cave '+seed);
      if(levelProof.fallback)totals.fallbacks++;
      for(const type of ['ground','ceiling']){
        const parts=platforms.filter(p=>p.type===type).sort((a,b)=>a.x-b.x);
        let edge=0;
        for(const p of parts){
          if(p.x!==edge||(type==='ground'?p.y+p.h<H:p.y!==0))throw new Error('Open cave boundary '+seed);
          edge=p.x+p.w;
        }
        if(edge!==WORLD)throw new Error('Incomplete cave '+seed);
      }
      const ground=platforms.filter(p=>p.type==='ground');
      if(new Set(ground.map(p=>p.y)).size<2)throw new Error('Flat cave '+seed);
      for(const p of ground){
        const roof=platforms.find(r=>r.type==='ceiling'&&r.x===p.x);
        if(p.y-roof.h<250||p.y-roof.h>270)throw new Error('Wrong tunnel height '+seed);
      }
      for(const p of platforms){
        if(!['ground','ceiling','caveRock'].includes(p.type))throw new Error('Floating obstacle '+seed);
        if(p.type==='caveRock'&&(!ground.some(g=>g.x<=p.x&&g.x+g.w>=p.x+p.w&&g.y===p.baseY)||p.y+p.h!==H))throw new Error('Unsupported rock '+seed);
      }
      for(const e of enemies)if(!ground.some(g=>e.left>=g.x&&e.right<=g.x+g.w&&e.y+e.h===g.y))throw new Error('Floating enemy '+seed);
      for(const x of [80,3220,6120])if(floorAt(x)!==FLOOR||enemies.some(e=>x+100>e.left&&x-100<e.right))throw new Error('Unsafe chamber '+seed);
      if(coins.some(c=>platforms.some(p=>overlap({x:c.x-10,y:c.y-10,w:20,h:20},p))))throw new Error('Cell inside rock '+seed);
      if(seed===7)original=JSON.stringify([platforms,coins,enemies,levelJumps]);
      totals.maps++;totals.rocks+=platforms.filter(p=>p.type==='caveRock').length;totals.enemies+=enemies.length;
    }
    Math.random=()=>.999;createLevel(7,false);
    if(JSON.stringify([platforms,coins,enemies,levelJumps])!==original)throw new Error('Cave seed is not reproducible');
    return JSON.stringify(totals);
  })()`));
  console.log('Underground level statistics:', JSON.stringify(stats));
  assert.equal(stats.maps, 1000);
  assert.equal(stats.fallbacks, 0);
  assert.ok(stats.rocks / stats.maps > 5);
  assert.ok(stats.enemies / stats.maps > 2);
});

test('underground freezes the sky and draws a plain black background', () => {
  const { run } = game();
  run("spawnSkyEvent('satellite');spawnSkyEvent('comet');createLevel(5);globalThis.skyBefore=JSON.stringify(atmosphere);updateAtmosphere(120);");
  assert.equal(run('levelType'), 'underground');
  assert.equal(run('JSON.stringify(atmosphere)'), run('skyBefore'));
  assert.equal(run("$('skyPhase').textContent"), 'ПОДЗЕМНЫЙ');
  run("globalThis.fills=[];ctx.fillRect=(...rect)=>fills.push([ctx.fillStyle,...rect]);drawDistantSky=()=>{throw new Error('Sky drawn inside cave')};drawBackground();");
  assert.equal(run('JSON.stringify(fills)'), JSON.stringify([['#000', 0, 0, 960, 540]]));
  run('createLevel(5);updateAtmosphere(.1);');
  assert.equal(run('levelType'), 'exterior');
  assert.notEqual(run('JSON.stringify(atmosphere)'), run('skyBefore'));
  assert.notEqual(run("$('skyPhase').textContent"), 'ПОДЗЕМНЫЙ');
});

test('cave ceilings collide, and checkpoint respawn preserves the underground stage', () => {
  const { run } = game();
  run("createLevel(42);spawn();player.x=100;player.y=202;player.vy=-590;moveRipley(player,{left:false,right:false,jump:true,run:false},1/120);");
  assert.equal(run('player.y'), 200);
  assert.equal(run('player.vy'), 0);
  run("globalThis.caveBefore=JSON.stringify([platforms,levelNumber,levelSetting,settingBag]);die();checkpoint=3220;checkpointTaken=true;spawn(1.8);state='playing';pause();pause();");
  assert.equal(run('JSON.stringify([platforms,levelNumber,levelSetting,settingBag])'), run('caveBefore'));
  assert.equal(run('player.x'), 3220);
  assert.equal(run('player.y+player.h'), run('floorAt(3220)'));
});

test('cave eggs are three times rarer than lamps and leave safe waiting positions', () => {
  const { run } = game();
  assert.equal(run(`(()=>{
    levelNumber=2;
    for(let seed=0;seed<100;seed++){
      createLevel(seed,false);
      if(caveEggs.length!==Math.round(caveLights.length/3))throw new Error('Wrong egg density '+seed);
      for(const egg of caveEggs){
        if(!platforms.some(p=>p.type==='ceiling'&&egg.x-22>p.x&&egg.x+22<p.x+p.w&&egg.y===p.h))throw new Error('Unattached egg');
        if(platforms.some(p=>p.type==='caveRock'&&egg.x+30>p.x&&egg.x-30<p.x+p.w))throw new Error('Drop over an obstacle');
        if(enemies.some(e=>egg.x-75<e.right&&egg.x+45>e.left))throw new Error('Unsafe waiting position');
        if([80,3220,6120].some(x=>Math.abs(x-egg.x)<200))throw new Error('Egg beside spawn or airlock');
      }
    }
    createLevel(17,false);const original=JSON.stringify(caveEggs);
    Math.random=()=>.999;createLevel(17,false);
    if(JSON.stringify(caveEggs)!==original)throw new Error('Egg layout is not seeded');
    levelNumber=3;createLevel(17,false);
    return caveEggs.length===0&&caveAcid.length===0;
  })()`), true);
});

test('eggs release single large clots with randomized dry intervals', () => {
  const { run } = game();
  run('levelNumber=2;createLevel(77,false);spawn();for(const egg of caveEggs)egg.timer=99;globalThis.egg=caveEggs[0];egg.timer=.001;updateCaveHazards(1/120);');
  assert.equal(run('caveAcid.length'), 1);
  assert.ok(run('caveAcid[0].r') >= 10);
  assert.ok(run('egg.timer') >= 6.5 && run('egg.timer') <= 11);
  run('updateCaveHazards(.2);');
  assert.equal(run('caveAcid.length'), 1);
  assert.equal(run(`(()=>{
    platforms=[];addPlatform(0,FLOOR,WORLD,80,'ground');player.x=80;caveEggs=[{x:300,y:200,h:59,timer:.001}];caveAcid=[];
    let maxActive=0,dryFrames=0,longestDry=0;const intervals=[];
    for(let frame=0;frame<120*45;frame++){
      const before=caveEggs[0].timer;updateCaveHazards(1/120);
      if(caveEggs[0].timer>before)intervals.push(caveEggs[0].timer);
      maxActive=Math.max(maxActive,caveAcid.length);
      if(!caveAcid.length&&caveEggs[0].timer>1.5){dryFrames++;longestDry=Math.max(longestDry,dryFrames)}else dryFrames=0;
    }
    return maxActive===1&&longestDry>120&&intervals.length>3&&new Set(intervals.map(t=>t.toFixed(2))).size>2;
  })()`), true, 'every drop must leave a real dry crossing window');
});

test('cave acid lands on the first floor surface and becomes a lasting puddle', () => {
  const { run } = game();
  run("levelType='underground';caveEggs=[];platforms=[];addPlatform(0,FLOOR,WORLD,80,'ground');releaseCaveAcid({x:300,y:200,h:59});for(let i=0;i<90;i++)updateCaveHazards(1/120);");
  assert.equal(run('caveAcid[0].settled'), true);
  assert.equal(run('caveAcid[0].y'), 460);
  assert.ok(run('caveAcid[0].life') > 3);
  assert.ok(run('caveAcid[0].radius') >= 23);
  run("caveAcid=[];addPlatform(280,390,80,150,'caveRock');releaseCaveAcid({x:300,y:200,h:59});for(let i=0;i<90;i++)updateCaveHazards(1/120);");
  assert.equal(run('caveAcid[0].y'), 390);
});

test('falling acid uses swept collisions and costs at most one life per hit', () => {
  const { run } = game();
  run("levelType='underground';caveEggs=[];platforms=[];addPlatform(0,FLOOR,WORLD,80,'ground');player.x=300;player.y=370;caveAcid=Array.from({length:3},()=>({x:313,y:250,vy:1000,r:11,settled:false,life:3.4}));updateCaveHazards(.15);");
  assert.equal(run('state'), 'dying');
  assert.equal(run('lives'), 2);
});

test('puddles hurt on the floor and during absorption; jumping and invincibility protect Ripley', () => {
  const { run } = game();
  run("levelType='underground';caveEggs=[];player.x=300;player.y=350;caveAcid=[{x:313,y:460,r:11,radius:26,settled:true,life:3.4}];updateCaveHazards(.01);");
  assert.equal(run('lives'), 3);
  run('player.y=428;player.invincible=1;updateCaveHazards(.01);');
  assert.equal(run('lives'), 3);
  run('player.invincible=0;caveAcid[0].life=.6;updateCaveHazards(.01);');
  assert.equal(run('state'), 'dying');
  assert.equal(run('lives'), 2);
});

test('acid puddle collision shrinks with absorption and disappears completely', () => {
  const { run } = game();
  run("levelType='underground';caveEggs=[];caveAcid=[{x:313,y:460,r:11,radius:26,settled:true,life:3.4}];globalThis.fullPuddle=caveAcidBounds(caveAcid[0]);caveAcid[0].life=.3;globalThis.fadingPuddle=caveAcidBounds(caveAcid[0]);");
  assert.ok(run('fadingPuddle.w') < run('fullPuddle.w'));
  assert.ok(run('fadingPuddle.h') < run('fullPuddle.h'));
  run('player.x=300;player.y=428;caveAcid[0].life=.001;updateCaveHazards(.01);');
  assert.equal(run('caveAcid.length'), 0);
  assert.equal(run('lives'), 3);
});

test('pause freezes eggs and acid; checkpoint respawn clears acid and grants a dry start', () => {
  const { run } = game();
  run('levelNumber=2;createLevel(23,false);spawn();releaseCaveAcid(caveEggs[0]);globalThis.eggPositions=JSON.stringify(caveEggs.map(e=>[e.x,e.y]));pause();globalThis.frozenAcid=JSON.stringify([caveEggs,caveAcid]);updateCaveHazards(10);');
  assert.equal(run('JSON.stringify([caveEggs,caveAcid])'), run('frozenAcid'));
  run('pause();updateCaveHazards(.1);');
  assert.notEqual(run('JSON.stringify([caveEggs,caveAcid])'), run('frozenAcid'));
  run('checkpoint=3220;spawn(1.8);');
  assert.equal(run('caveAcid.length'), 0);
  assert.equal(run('caveEggs.every(egg=>egg.timer>=3)'), true);
  assert.equal(run('JSON.stringify(caveEggs.map(e=>[e.x,e.y]))'), run('eggPositions'));
});

test('the real game reaches the finish with enemies, timed acid crossings and no Shift', () => {
  const { run } = game();
  const result = run(`(()=>{
    let completed=0,waitingFrames=0,deaths=0;
    const originalDie=die;die=()=>{if(state==='playing')deaths++;originalDie()};
    for(let seed=0;seed<80;seed++){
      reset();createLevel(seed*7919,false);spawn();input.right=true;input.jump=true;input.run=false;
      let next=0,frames=0;const passedEggs=new Set();
      while(state==='playing'&&frames++<120*75){
        let wait=false;
        for(const egg of caveEggs)if(!passedEggs.has(egg)&&player.x>=egg.x-130&&player.x<egg.x+55){
          if(egg.timer<1.5||caveAcid.some(drop=>Math.abs(drop.x-egg.x)<45))wait=true;else passedEggs.add(egg);
        }
        input.right=!wait;
        if(wait)waitingFrames++;
        if(next<levelJumps.length&&player.grounded&&player.x>=levelJumps[next].x){jumpBuffer=.14;next++}
        update(1/120);
      }
      if(state!=='won'||lives<3||deaths)throw new Error('Live route failed for seed '+seed*7919+' at '+player.x+' ('+state+', deaths: '+deaths+')');
      completed++;
    }
    die=originalDie;return JSON.stringify({completed,waitingFrames,deaths});
  })()`);
  assert.equal(JSON.parse(result).completed, 80);
  assert.ok(JSON.parse(result).waitingFrames > 120, 'live routes must actually wait for acid to clear');
  assert.equal(JSON.parse(result).deaths, 0);
});

test('validator rejects a wide gap, a tall wall, and a blocked jumping arc', () => {
  const { run } = game();
  run("enemies=[];blocks=[];platforms=[];levelJumps=[{x:350}];addPlatform(0,FLOOR,400,100,'ground');addPlatform(800,FLOOR,WORLD-800,100,'ground');");
  assert.equal(run('validateLevelRoute().ok'), false);
  run("platforms=[];levelJumps=[{x:350}];addPlatform(0,FLOOR,WORLD,100,'ground');addPlatform(450,200,80,260,'pipe');");
  assert.equal(run('validateLevelRoute().ok'), false);
  run("platforms=[];levelJumps=[{x:350}];addPlatform(0,FLOOR,WORLD,100,'ground');addPlatform(360,340,200,40,'ledge');");
  assert.equal(run('validateLevelRoute().ok'), false);
});

test('respawning preserves terrain, while starting a new mission regenerates it', () => {
  const { run } = game();
  run('Math.random=()=>.125;reset();globalThis.originalTerrain=JSON.stringify(platforms);checkpoint=3220;checkpointTaken=true;spawn(1.8);');
  assert.equal(run('JSON.stringify(platforms)'), run('originalTerrain'));
  assert.equal(run('player.x'), 3220);
  run('Math.random=()=>.875;reset()');
  assert.notEqual(run('JSON.stringify(platforms)'), run('originalTerrain'));
  assert.equal(run('checkpointTaken'), false);
});

test('continuous fire gradually overheats after about four seconds', () => {
  const { run, key } = game();
  run("addPlatform(0,FLOOR,WORLD,100,'ground');player.y=FLOOR-player.h;player.grounded=true;");
  key('keydown', 'KeyF');
  run('for(let i=0;i<120;i++)update(1/120);');
  assert.ok(run('player.weaponHeat') > 20 && run('player.weaponHeat') < 40);
  assert.equal(run('player.overheated'), false);
  run('globalThis.firingFrames=120;while(!player.overheated&&firingFrames<1000){update(1/120);firingFrames++}');
  assert.equal(run('player.weaponHeat'), 100);
  assert.equal(run('player.overheated'), true);
  assert.ok(run('firingFrames/120') >= 3.8 && run('firingFrames/120') <= 4.2);
});

test('only accepted shots add heat; cooldown and overheat cannot be bypassed', () => {
  const { run } = game();
  run('shoot();');
  assert.equal(run('player.weaponHeat'), 4);
  run('for(let i=0;i<50;i++)shoot();');
  assert.equal(run('player.weaponHeat'), 4);
  assert.equal(run('bullets.length'), 1);
  run('for(let i=0;i<24;i++){player.shotCooldown=0;shoot()}');
  assert.equal(run('player.weaponHeat'), 100);
  assert.equal(run('bullets.length'), 25);
  run('player.shotCooldown=0;for(let i=0;i<20;i++)shoot();');
  assert.equal(run('bullets.length'), 25);
  assert.equal(run('player.weaponHeat'), 100);
});

test('overheat locks fire until sixty percent and recovers in about 1.33 seconds', () => {
  const { run } = game();
  run('player.weaponHeat=100;player.overheated=true;updateWeaponHeat(1.32);shoot();');
  assert.equal(run('player.overheated'), true);
  assert.ok(run('player.weaponHeat') > 60);
  assert.equal(run('bullets.length'), 0);
  run('updateWeaponHeat(.02);');
  assert.equal(run('player.overheated'), false);
  assert.equal(run('player.weaponHeat'), 60);
  run('shoot();');
  assert.equal(run('bullets.length'), 1);
  assert.equal(run('player.weaponHeat'), 64);
});

test('held keyboard fire resumes automatically after cooling', () => {
  const { run, key } = game();
  run("addPlatform(0,FLOOR,WORLD,100,'ground');player.y=FLOOR-player.h;player.grounded=true;player.weaponHeat=100;player.overheated=true;");
  key('keydown', 'KeyF');
  run('for(let i=0;i<159;i++)update(1/120);');
  assert.equal(run('bullets.length'), 0);
  assert.equal(run('player.overheated'), true);
  run('update(1/120);');
  assert.equal(run('player.overheated'), false);
  assert.equal(run('bullets.length'), 1);
  assert.equal(run('player.weaponHeat'), 64);
});

test('touch fire respects overheat and releasing the trigger cools to zero', () => {
  const { run, pointer } = game();
  run("addPlatform(0,FLOOR,WORLD,100,'ground');player.y=FLOOR-player.h;player.grounded=true;player.weaponHeat=100;player.overheated=true;");
  pointer('pointerdown', 'shoot', 1);
  run('for(let i=0;i<160;i++)update(1/120);');
  assert.equal(run('bullets.length'), 1);
  assert.equal(run('player.weaponHeat'), 64);
  pointer('pointerup', 'shoot', 1);
  run('updateWeaponHeat(1);');
  assert.equal(run('player.weaponHeat'), 39);
  run('updateWeaponHeat(2);');
  assert.equal(run('player.weaponHeat'), 0);
});

test('pause freezes overheating; respawn and restart restore a cold weapon', () => {
  const { run } = game();
  run('player.weaponHeat=100;player.overheated=true;pause();updateWeaponHeat(10);update(1);');
  assert.equal(run('player.weaponHeat'), 100);
  assert.equal(run('player.overheated'), true);
  run('pause();updateWeaponHeat(.5);');
  assert.equal(run('player.weaponHeat'), 85);
  run('die();spawn(1.8);');
  assert.equal(run('player.weaponHeat'), 0);
  assert.equal(run('player.overheated'), false);
  run('player.weaponHeat=100;player.overheated=true;reset();');
  assert.equal(run('player.weaponHeat'), 0);
  assert.equal(run('player.overheated'), false);
});

test('heat indicator shows fill, percentage, and the cooling lock', () => {
  const { run } = game();
  run('player.weaponHeat=100;player.overheated=true;updateWeaponHUD();');
  assert.equal(run("$('heatValue').textContent"), '100%');
  assert.equal(run("$('heatStatus').textContent"), 'ОСТЫВАЕТ');
  assert.equal(run("$('heatFill').style.transform"), 'scaleY(1)');
  assert.equal(run("$('weaponHeat').classList.contains('overheated')"), true);
  run('updateWeaponHeat(4/3);updateWeaponHUD();');
  assert.equal(run("$('heatValue').textContent"), '60%');
  assert.equal(run("$('heatStatus').textContent"), 'ГОРЯЧО', 'the existing warm indicator starts at sixty percent');
  assert.equal(run("$('weaponHeat').classList.contains('overheated')"), false);
  run('updateWeaponHeat(3);updateWeaponHUD();');
  assert.equal(run("$('heatStatus').textContent"), 'ГОТОВ');
  assert.equal(run("$('heatFill').style.transform"), 'scaleY(0)');
});

test('every second stage is underground and outdoor stages exhaust all eight exteriors', () => {
  const { run } = game();
  const cycles = JSON.parse(run(`(()=>{
    settingStarted=false;settingBag=[];levelSetting=EXTERIOR_SETTINGS[0];
    const ids=[];
    for(let i=0;i<128;i++){
      const bagBefore=JSON.stringify(settingBag);
      selectLevelSetting(123);
      if(levelNumber!==i+1)throw new Error('Wrong stage number');
      if(i%2){
        if(levelType!=='underground'||levelSetting!==UNDERGROUND_SETTING)throw new Error('Missing underground stage');
        if(JSON.stringify(settingBag)!==bagBefore)throw new Error('Cave consumed an exterior');
      }else{
        if(levelType!=='exterior')throw new Error('Missing outdoor stage');
        ids.push(levelSetting.id);
      }
    }
    return JSON.stringify(ids);
  })()`));
  for (let i = 0; i < cycles.length; i += 8) {
    assert.equal(new Set(cycles.slice(i, i + 8)).size, 8);
  }
  for (let i = 1; i < cycles.length; i++) assert.notEqual(cycles[i], cycles[i - 1]);
});

test('starting keeps the preview exterior; restart and a completed mission advance it', () => {
  const { run } = game();
  run("state='ready';globalThis.previewExterior=levelSetting.id;reset();");
  assert.equal(run('levelSetting.id'), run('previewExterior'));
  run('reset()');
  assert.notEqual(run('levelSetting.id'), run('previewExterior'));
  run("globalThis.previousExterior=levelSetting.id;state='won';reset();");
  assert.notEqual(run('levelSetting.id'), run('previousExterior'));
  assert.equal(run("$('settingLabel').textContent"), run('levelSetting.name'));
  assert.ok(run("$('worldLabel').textContent.includes(levelSetting.name)"));
});

test('death, checkpoint respawn and pause preserve the exterior and its remaining rotation', () => {
  const { run } = game();
  const art = () => run('JSON.stringify([levelSetting,scenery,settingBag])');
  const before = art();
  run('die();checkpoint=3220;checkpointTaken=true;spawn(1.8);');
  assert.equal(art(), before);
  run("state='playing';pause();pause();");
  assert.equal(art(), before);
});

test('new exteriors leave the celestial clock, live events and next-event queue untouched', () => {
  const { run } = game();
  run("spawnSkyEvent('satellite');spawnSkyEvent('asteroid');updateAtmosphere(.4);");
  const atmosphereBefore = run('JSON.stringify(atmosphere)');
  const positions = run('JSON.stringify(atmosphere.events.map(e=>eventPosition(e,e.age)))');
  run('for(let i=0;i<8;i++)createLevel(7919);');
  assert.equal(run('JSON.stringify(atmosphere)'), atmosphereBefore);
  assert.equal(run('JSON.stringify(atmosphere.events.map(e=>eventPosition(e,e.age)))'), positions);
});

test('all eight exteriors share exactly the same collision geometry and seeded route', () => {
  const { run } = game();
  const count = run(`(()=>{
    settingStarted=false;settingBag=[];levelSetting=EXTERIOR_SETTINGS[0];
    const seen=new Set();let original='';
    for(let i=0;i<16;i++){
      createLevel(707);
      if(levelType==='underground')continue;
      seen.add(levelSetting.id);
      const route=JSON.stringify([platforms,blocks,coins,enemies,levelJumps]);
      if(i===0)original=route;
      if(route!==original)throw new Error('An exterior changed collision geometry');
      if(!validateLevelRoute().ok||!validateLevelRoute(3220).ok)throw new Error('Exterior broke route');
    }
    return seen.size;
  })()`);
  assert.equal(count, 8);
});

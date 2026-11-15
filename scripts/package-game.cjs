const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, '.artifacts', 'github-publish');
fs.mkdirSync(path.join(output, 'tests'), { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(output, 'index.html'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(output, 'README.md'));
for(const name of ['game.test.cjs','mission-transition.test.cjs','exterior.visual.cjs','cave-lighting.visual.cjs']){
 fs.copyFileSync(path.join(root, 'tests', name), path.join(output, 'tests', name));
}
console.log(`Updated index.html and tests: ${output}`);

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, '.artifacts', 'github-publish');
fs.mkdirSync(path.join(output, 'tests'), { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(output, 'index.html'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(output, 'README.md'));
fs.copyFileSync(path.join(root, 'tests', 'game.test.cjs'), path.join(output, 'tests', 'game.test.cjs'));
fs.copyFileSync(path.join(root, 'tests', 'mission-transition.test.cjs'), path.join(output, 'tests', 'mission-transition.test.cjs'));
console.log(`Updated index.html and tests: ${output}`);

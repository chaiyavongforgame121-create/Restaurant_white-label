const fs = require('fs');
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const text = src[0].text;
const parsed = JSON.parse(text);
fs.writeFileSync(process.argv[3], parsed.types, 'utf8');
console.log('Wrote', parsed.types.length, 'chars to', process.argv[3]);

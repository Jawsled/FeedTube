const fs = require('fs');
const code = fs.readFileSync('C:/Users/pttx/FeedTube/.output/chrome-mv3/background.js', 'utf8');
// Find all occurrences of "dr(" in the file - that's biliCookieHeader
let pos = 0;
const positions = [];
while ((pos = code.indexOf('dr(', pos + 1)) !== -1) {
  positions.push(pos);
}
console.log('dr( occurrences:', positions.length);
for (const p of positions.slice(0, 10)) {
  console.log(' at', p, ':', code.substring(p - 50, p + 100));
}

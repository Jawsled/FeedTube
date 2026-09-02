import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run(
  'CREATE TABLE subscriptions (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, service_id INTEGER NOT NULL, url TEXT, name TEXT, avatar_url TEXT, subscriber_count INTEGER, description TEXT)',
);
db.run(
  "INSERT INTO subscriptions (service_id,url,name) VALUES (0,'https://www.youtube.com/channel/UC1234567890123456789012','Test'),(1,'https://soundcloud.com/x','SC')",
);
const res = db.exec('SELECT url, name, avatar_url FROM subscriptions');
console.log('rows:', JSON.stringify(res[0].values));

const bytes = db.export();
const dir = mkdtempSync(join(tmpdir(), 'feedtube-db-'));
writeFileSync(join(dir, 'newpipe.db'), bytes);
console.log('sqlite magic:', String.fromCharCode(...bytes.slice(0, 15)));
console.log('wrote sample db to', join(dir, 'newpipe.db'));

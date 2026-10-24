// Copies the client app, the game, the shared core and their images into www/ (what Capacitor packs into the app).
// The 3D models are big: they stay online and load on first play (cached by the service worker).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../..'), www = path.join(__dirname, '../www');
fs.rmSync(www, { recursive: true, force: true }); fs.mkdirSync(www, { recursive: true });
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(www, to), { recursive: true, filter: s => !/[\\/](test|models)([\\/]|$)/.test(s) });
copy('client', 'client'); copy('core', 'core');
if (fs.existsSync(path.join(root, 'sw.js'))) fs.copyFileSync(path.join(root, 'sw.js'), path.join(www, 'sw.js'));
fs.copyFileSync(path.join(__dirname, '../src/reminders.js'), path.join(www, 'client/native-reminders.js'));
fs.copyFileSync(path.join(__dirname, '../src/health.js'), path.join(www, 'client/native-health.js'));
fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=client/index.html">');
console.log('www ready');

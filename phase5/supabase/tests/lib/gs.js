// Loads the Apps Script snapshot (tests/.gs) with its node mock and fixture, once per process.
const path = require('path');
const F = require(path.join(__dirname, '../.gs/tests/fixture.js'));
if (!global.__wbGsLoaded) { F.load(); global.__wbGsLoaded = true; }
module.exports = F;

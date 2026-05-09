const fs = require('fs');
const path = require('path');

const binPath = path.resolve(__dirname, '..', 'out', 'server.js');

try {
  fs.chmodSync(binPath, 0o755);
} catch {
  // npm creates platform shims for bin entries; chmod is a best-effort Unix nicety.
}

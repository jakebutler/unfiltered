'use strict';
// Same source for both architectures. No app imports or request/env/config/auth reads.
console.info('{"component":"research-platform-matrix","kind":"native","event":"entry","schema":1}');
const http = module.require('node:http');
const server = http.createServer(function (_request, response) {
  console.info('{"component":"research-platform-matrix","kind":"native","event":"invoked","schema":1}');
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end('{"schema":1,"diagnostic":"native-node22","status":"ok"}\n');
});
server.listen(3000);
console.info('{"component":"research-platform-matrix","kind":"native","event":"listen-called","schema":1}');
module.exports = server;

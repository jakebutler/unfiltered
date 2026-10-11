'use strict';
// Temporary protected diagnostic. Fixed output; no request/env/config/auth reads.
module.exports = function (_request, response) {
  console.info('{"component":"research-platform-matrix","kind":"ordinary-x64","event":"invoked","schema":1}');
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end('{"schema":1,"diagnostic":"ordinary-node22-x64","status":"ok"}\n');
};

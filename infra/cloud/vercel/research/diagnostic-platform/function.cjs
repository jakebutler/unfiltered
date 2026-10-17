'use strict';
// Temporary protected platform diagnostic. No request, environment or auth reads.
module.exports = function (_request, response) {
  console.info('{"component":"research-platform-diagnostic","event":"invoked","schema":1}');
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end('{"schema":1,"diagnostic":"standard-node22","status":"ok"}\n');
};

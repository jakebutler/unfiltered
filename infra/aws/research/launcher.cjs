const { boundedFile } = require('./bounded-file.cjs');
const { join } = require('node:path');
async function main() {
  try {
    const manifest=JSON.parse(boundedFile(join(__dirname,'deployment-manifest.json'),16384,false));
    const runtime=JSON.parse(boundedFile('/run/secrets/research-runtime.json',32768,true));
    const binding=JSON.parse(boundedFile('/run/secrets/research-binding.json',16384,false));
    return await require('./server.cjs').startAwsResearchApplication(manifest,runtime,JSON.parse(boundedFile(join(__dirname,'ffmpeg-manifest.json'),16384,false)),__dirname,binding);
  }
  catch { console.error('AWS research startup failed; traffic remains unavailable'); process.exitCode=1; }
}
module.exports={main}; if(require.main===module)void main();

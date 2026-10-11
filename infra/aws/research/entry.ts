import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { awsResearchConfig } from './config';
import { createAwsResearchServer, loadResearchAssets } from './application';
import { ec2RoleCredentials } from './credentials';
import { S3PrivateBucketPort } from '../../../packages/research-capture/src/s3-bucket';
import { BucketPrivateObjectStore } from '../../../packages/research-capture/src/bucket-store';
import { convexHostedAuthority, leaseIdentity, newLeaseOwner } from '../../../apps/research-server/src/hosted-admission';
import { checkLauncher } from './startup-gate.mjs';
import { assembleAwsProviders } from './providers';
import { signGateway } from '../../../packages/research-capture/src/proof';
// Programmatic factory exports support bounded local integration of this exact
// bundle. The supported launcher still enforces mount/admission/Linux/S3 gates.
export { awsResearchConfig, createAwsResearchServer, loadResearchAssets, assembleAwsProviders };
/** Only explicit launcher inputs; no dotenv or provider credential discovery. */
export async function startAwsResearchApplication(manifest:unknown,runtime:unknown,binaryManifest:unknown,directory:string,binding:unknown,gateDirectory='/run/research-gate'){
  checkLauncher(manifest,runtime,binding,gateDirectory);
  const s=awsResearchConfig(manifest,runtime,binaryManifest,join(directory,'bin/ffmpeg')), binary=readFileSync(realpathSync(join(directory,'bin/ffmpeg'))), license=readFileSync(realpathSync(join(directory,'bin/FFMPEG-LICENSE.txt')));
  const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
  if(process.platform!=='linux'||process.arch!=='x64'||binary.length!==s.binary.bytes||sha(binary)!==s.binary.sha256||sha(license)!==s.binary.licenseSha256)throw new Error('Pinned licensed FFmpeg unavailable');
  const port=await S3PrivateBucketPort.open(s.runtime.s3,ec2RoleCredentials(`${s.manifest.stackId}-research-runtime`));
  try{
    const authority=convexHostedAuthority(s.config.deployment,s.config.gatewaySecret,s.config.allocationId);
    const cleanupAuthority=s.config.cleanupAllocationId?convexHostedAuthority(s.config.deployment,s.config.gatewaySecret,s.config.cleanupAllocationId):authority;
    const {speech,analysisRuntime,interviewRuntime,readinessFacts}=assembleAwsProviders(s,authority);
    const app=createAwsResearchServer(s.config,s.binding,loadResearchAssets(join(directory,'site-assets')),{store:new BucketPrivateObjectStore(port),hostedAuthority:authority,cleanupAuthority,analysisRuntime,readinessFacts},speech,interviewRuntime);
    let stopping=false,running:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const sweep=async()=>{try{const lease=await cleanupAuthority.acquire({kind:'cleanup',...newLeaseOwner()});if(!lease)return;const input=leaseIdentity(lease),proof=await signGateway(s.config.gatewaySecret,'cleanup-tick',input),body=JSON.stringify(input);const response=await app.handle(new Request(`${s.config.publicOrigin}/api/research/internal/cleanup`,{method:'POST',headers:{Host:new URL(s.config.publicOrigin).host,Origin:s.config.publicOrigin,'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Research-Cleanup-At':String(proof.at),'X-Research-Cleanup-Proof':proof.signature},body}));await response.body?.cancel();}catch{/* Unknown work remains in durable leases. */}finally{running=undefined;if(!stopping)timer=setTimeout(start,30000);}};
    const start=()=>{if(!stopping)running=sweep();};
    await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(8080,'0.0.0.0',()=>{app.server.off('error',reject);resolve();});});start();
    const close=async()=>{stopping=true;clearTimeout(timer);await app.close();await running;port.close();};process.once('SIGTERM',()=>void close());return{...app,close};
  }catch(error){port.close();throw error;}
}

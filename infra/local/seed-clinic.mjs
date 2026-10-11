/** Seed a NEW isolated fictional clinic. Bootstrap credentials are used only here. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import { getNativeQuestionnaireDefinition } from '../../.qualification-build/packages/clinic-content/src/native-questionnaire.js';
import { verifyComponent } from '../../.qualification-build/packages/clinical-core/src/fhir.js';
const directory=new URL('.',import.meta.url);
const configPath=new URL('.clinic-config.json',directory),usersPath=new URL('.clinic-users.json',directory),envPath=new URL('.clinic.env',directory);
if(!process.argv.includes('--allow-synthetic-writes')) throw new Error('synthetic-write-flag-required');
const repairing=process.argv.includes('--repair-existing-synthetic-config');
if([configPath,usersPath,envPath].some(existsSync)&&!repairing) throw new Error('clinic-already-seeded-preserve-existing-configuration');
const env=Object.fromEntries(readFileSync(new URL('.env',directory),'utf8').split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
// Match MEDPLUM_BASE_URL in compose so native FHIR continuation links stay
// inside the exact configured origin; do not weaken pagination authorization.
const base='http://localhost:8103/';
const secret=()=>randomBytes(32).toString('base64url');
async function request(token,path,body,method=body?'POST':'GET',headers={}){
 const r=await fetch(new URL(path,base),{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/fhir+json','X-Medplum':'extended',...(token?{Authorization:`Bearer ${token}`} :{}),...headers},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
 if(!r.ok)throw new Error(`seed-http-${r.status}`);return r.json();
}
async function token(client){return (await request(undefined,'oauth2/token',new URLSearchParams({grant_type:'client_credentials',client_id:client.id,client_secret:client.secret}).toString(),'POST',{'Content-Type':'application/x-www-form-urlencoded'})).access_token;}
const bootstrap=await token({id:env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_ID,secret:env.MEDPLUM_DEFAULT_SUPER_ADMIN_CLIENT_SECRET});
if(repairing){
 const config=JSON.parse(readFileSync(configPath,'utf8'));
 const project=await request(bootstrap,`fhir/R4/Project/${config.projectId}`);
 if(!project.name?.startsWith('Corvo Clinic synthetic app '))throw new Error('not-synthetic-clinic-project');
 const admin=config.staff.find(s=>s.role==='administrative');
 const resource=await request(bootstrap,`fhir/R4/${admin.policy}`);
 resource.resource=resource.resource.map(rule=>rule.resourceType==='Task'?{...rule,criteria:`Task?_compartment=${config.patients['first-intake'].reference}&code=urn:corvo:clinical:work-kind|administrative`}:rule);
 await request(bootstrap,`fhir/R4/${admin.policy}`,resource,'PUT');
 config.mentalHealth='phq4';writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'repaired-existing-synthetic-config',projectId:config.projectId,mentalHealth:config.mentalHealth}));process.exit(0);
}
const project=await request(bootstrap,'fhir/R4/Project',{resourceType:'Project',name:`Corvo Clinic synthetic app ${new Date().toISOString()}`,features:[]});
const setup=await request(bootstrap,`admin/projects/${project.id}/client`,{name:'Temporary clinic seed setup'});
const setupToken=await token(setup);
const ref=r=>`${r.resourceType}/${r.id}`;
const create=resource=>request(setupToken,`fhir/R4/${resource.resourceType}`,resource);
const definition=await getNativeQuestionnaireDefinition();
const questionnaire=await request(setupToken,'fhir/R4/Questionnaire',definition.questionnaire,'POST',{'If-None-Exist':new URLSearchParams({url:definition.binding.canonical,version:definition.binding.version}).toString()});
const questionnaireReference=`${ref(questionnaire)}/_history/${questionnaire.meta?.versionId}`;
const questionnaireReadback=await request(setupToken,`fhir/R4/${questionnaireReference}`);
if(!questionnaire.meta?.versionId||!verifyComponent(definition.questionnaire,questionnaireReadback)||questionnaireReadback.id!==questionnaire.id||questionnaireReadback.meta.versionId!==questionnaire.meta.versionId)throw new Error('native-questionnaire-readback-mismatch');
const patient=await create({resourceType:'Patient',active:true,name:[{given:['Alex'],family:'Rivera (synthetic)'}]});
const unrelated=await create({resourceType:'Patient',active:true,name:[{given:['Jordan'],family:'Chen (synthetic unrelated)'}]});
const careTeams={};for(const responsibility of ['medical','nutrition','administrative']) careTeams[responsibility]=ref(await create({resourceType:'CareTeam',status:'active',name:`Corvo ${responsibility} care team`,subject:{reference:ref(patient)}}));
async function policy(name,rules){return request(bootstrap,'fhir/R4/AccessPolicy',{resourceType:'AccessPolicy',meta:{project:project.id},name,resource:rules});}
const clinicalRules=p=>[{resourceType:'Questionnaire',criteria:`Questionnaire?_id=${questionnaire.id}`,readonly:true},{resourceType:'Practitioner',criteria:'Practitioner?_id=%profile.id',readonly:true},{resourceType:'Patient',criteria:`Patient?_id=${p.id}`,readonly:true},...['CareTeam','QuestionnaireResponse','DocumentReference','Task','Provenance'].map(resourceType=>({resourceType,criteria:`${resourceType}?_compartment=${ref(p)}`,readonly:true})),{resourceType:'Binary',readonly:true}];
const clinical=await policy('Assigned clinic clinical read only',clinicalRules(patient));
const other=await policy('Unassigned clinic own-patient read only',clinicalRules(unrelated));
const admin=await policy('Clinic administrative logistics only',[{resourceType:'Practitioner',criteria:'Practitioner?_id=%profile.id',readonly:true},{resourceType:'Task',criteria:`Task?_compartment=${ref(patient)}&code=urn:corvo:clinical:work-kind|administrative`,readonly:true}]);
const users=[],staff=[];
for(const spec of [{key:'medical',name:'Dr. Morgan Lee',role:'physician',policy:clinical},{key:'dietitian',name:'Sam Patel, RD',role:'registered-dietitian',policy:clinical},{key:'administrative',name:'Taylor Brooks',role:'administrative',policy:admin},{key:'unassigned',name:'Dr. Quinn Parker',role:'physician',policy:other}]){
 const email=`${spec.key}.${project.id.slice(0,8)}@example.invalid`,password=secret();
 const membership=await request(bootstrap,`admin/projects/${project.id}/invite`,{resourceType:'Practitioner',firstName:spec.name,lastName:'Synthetic',email,password,scope:'project',sendEmail:false,membership:{admin:false,accessPolicy:{reference:ref(spec.policy)}}});
 const assigned=spec.key==='unassigned'?unrelated:patient;
 staff.push({membershipId:membership.id,profile:membership.profile.reference,policy:ref(spec.policy),name:spec.name,role:spec.role,patients:[ref(assigned)],careTeams:spec.key==='unassigned'?[]:Object.values(careTeams)});
 users.push({name:spec.name,role:spec.role,email,password});
}
for(const reference of Object.values(careTeams)){
 const resource=await request(setupToken,`fhir/R4/${reference}`);
 await request(setupToken,`fhir/R4/${reference}`,{...resource,participant:staff.filter(s=>s.patients.includes(ref(patient))).map(s=>({member:{reference:s.profile},role:[{text:s.role}]}))},'PUT');
}
const runtimePolicy=await policy('Clinic server clinical persistence only',[...['Patient','CareTeam','QuestionnaireResponse','DocumentReference','Binary','Task','Provenance'].map(resourceType=>({resourceType,interaction:['create','read','search','update','history','vread']})),{resourceType:'Questionnaire',criteria:`Questionnaire?_id=${questionnaire.id}`,interaction:['read','search','history','vread']}]);
const runtime=await request(bootstrap,`admin/projects/${project.id}/client`,{name:'Corvo clinic scoped runtime',accessPolicy:{reference:ref(runtimePolicy)}});
const scenarios=['first-intake','pre-visit','non-visit','post-visit','billing','scheduling','refill'];
const patients=Object.fromEntries(scenarios.map(scenario=>[scenario,{reference:ref(patient),displayName:'Alex Rivera',description:'Fictional adult patient for Corvo Clinic testing. Use synthetic information only.',careTeams,context:scenario==='post-visit'?'No clinician-authored plan is available in this fixture. Collect updates and questions without inferring treatment directions.':scenario==='pre-visit'?'Synthetic telehealth appointment: October 16, 2026 at 10:00 AM America/Los_Angeles.':undefined}]));
const config={origin:'http://127.0.0.1:5173',medplumBaseUrl:base,projectId:project.id,clientId:runtime.id,clientSecret:runtime.secret,cookieSecret:secret(),nativeQuestionnaire:{...definition.binding,reference:questionnaireReference},patients,staff,mentalHealth:'phq4'};
writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});writeFileSync(usersPath,JSON.stringify(users,null,2)+'\n',{flag:'wx',mode:0o600});writeFileSync(envPath,`CLINIC_CONFIG_PATH=${configPath.pathname}\n`,{flag:'wx',mode:0o600});
await request(bootstrap,`fhir/R4/ClientApplication/${setup.id}`,{...setup,secret:secret()},'PUT');
console.log(JSON.stringify({status:'seeded',projectId:project.id,patient:ref(patient),staffCount:staff.length,files:['.clinic-config.json','.clinic-users.json','.clinic.env'],secrets:'written-private-not-printed'}));

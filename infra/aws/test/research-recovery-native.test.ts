import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { afterEach,expect,it,vi } from 'vitest';
import schema from '../../../convex/schema';
const modules=import.meta.glob('../../../convex/**/*.ts');
const identity='a'.repeat(64),reference=makeFunctionReference<'mutation'>('researchRecovery:quarantine');
afterEach(()=>vi.unstubAllEnvs());
it('rejects unset recovery identity and quarantines restored credentials without refunding counters or work',async()=>{
 const t=convexTest(schema,modules);
 await expect(t.mutation(reference,{identity,table:'researchOperators',cursor:null})).rejects.toThrow('sealed AWS');
 vi.stubEnv('RESEARCH_AWS_RECOVERY_IDENTITY',identity);
 const fixture=await t.run(async ctx=>{
  const userId=await ctx.db.insert('users',{email:'synthetic-recovery@example.test'});
  const operatorId=await ctx.db.insert('researchOperators',{role:'operator',userId,name:'Old operator',active:true});
  const sessionId=await ctx.db.insert('authSessions',{userId,expirationTime:Date.now()+600000});
  const allocationId=await ctx.db.insert('researchGatewayAllocations',{allocationId:'old-fixture-quota',expiresAt:Date.now()+600000,requestLimit:10,readByteLimit:1000,storageOperationLimit:10,requestsConsumed:8,readBytesConsumed:900,storageOperationsConsumed:9,createdAt:Date.now()});
  const slotId=await ctx.db.insert('researchGatewaySlots',{slot:0,kind:'upload',requestId:'unknown-upload',owner:'old-owner',generation:7,expiresAt:Date.now()+60000,bodyDeadlineAt:Date.now()+30000,workStarted:true,allocationId:'old-fixture-quota'});
  return{operatorId,sessionId,allocationId,slotId};
 });
 for(const table of['researchOperators','authSessions','researchGatewayAllocations','researchGatewaySlots'])expect((await t.mutation(reference,{identity,table,cursor:null})).done).toBe(true);
 await t.run(async ctx=>{
  expect((await ctx.db.get(fixture.operatorId))?.active).toBe(false);expect(await ctx.db.get(fixture.sessionId)).toBe(null);
  expect(await ctx.db.get(fixture.allocationId)).toMatchObject({expiresAt:0,requestsConsumed:8,readBytesConsumed:900,storageOperationsConsumed:9});
  expect(await ctx.db.get(fixture.slotId)).toMatchObject({expiresAt:0,workStarted:true,generation:7});
 });
});
it('paginates restored operator quarantine across more than one bounded batch',async()=>{
 vi.stubEnv('RESEARCH_AWS_RECOVERY_IDENTITY',identity);const t=convexTest(schema,modules);
 await t.run(async ctx=>{const userId=await ctx.db.insert('users',{});for(let i=0;i<30;i++)await ctx.db.insert('researchOperators',{role:'operator',userId,name:'Synthetic'+i,active:true});});
 const first=await t.mutation(reference,{identity,table:'researchOperators',cursor:null});expect(first.count).toBe(25);expect(first.done).toBe(false);
 const second=await t.mutation(reference,{identity,table:'researchOperators',cursor:first.cursor});expect(second.count).toBe(5);expect(second.done).toBe(true);
});

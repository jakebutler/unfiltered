import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
/** Administrative sealed-restore quarantine only; never callable with a browser
 * token. Each phase is resumable; the app must remain stopped until all phases
 * and every returned permanent object fence have an accepted receipt. */
export const quarantine = internalMutation({
  args: { identity:v.string(), table:v.union(v.literal('researchOperators'),v.literal('authSessions'),v.literal('authRefreshTokens'),v.literal('authVerificationCodes'),v.literal('authVerifiers'),v.literal('researchInvitations'),v.literal('researchShares'),v.literal('researchViewerSessions'),v.literal('researchSessions'),v.literal('researchCaptures'),v.literal('researchMedia'),v.literal('researchSources'),v.literal('researchDomBatches'),v.literal('researchReports'),v.literal('researchAnalyses'),v.literal('researchInterviewPolicy'),v.literal('researchSpeechPolicy'),v.literal('researchSpeechGrants'),v.literal('researchGatewayAllocations'),v.literal('researchGatewaySlots')),cursor:v.union(v.string(),v.null()) },
  returns:v.object({cursor:v.string(),done:v.boolean(),count:v.number(),fenceKeys:v.array(v.string())}),
  handler:async(ctx,args)=>{
    if(!/^[a-f0-9]{64}$/.test(args.identity)||process.env.RESEARCH_AWS_RECOVERY_IDENTITY!==args.identity)throw new Error('Explicit sealed AWS recovery identity required');
    const page=await ctx.db.query(args.table).withIndex('by_creation_time').paginate({cursor:args.cursor,numItems:25,maximumRowsRead:25});
    const fenceKeys:string[]=[];const now=Date.now();
    for(const row of page.page){
      // The discriminated table selector is administrative, never caller authority.
      // Narrow patches are checked by the native schema at commit.
      switch(args.table){
        case 'researchOperators':await ctx.db.patch(row._id,{active:false});break;
        case 'authSessions':case 'authRefreshTokens':case 'authVerificationCodes':case 'authVerifiers':case 'researchSources':case 'researchDomBatches':await ctx.db.delete(row._id);break;
        case 'researchInvitations':await ctx.db.patch(row._id,{revokedAt:now});break;
        case 'researchShares':await ctx.db.patch(row._id,{revokedAt:now,grants:[]});break;
        case 'researchViewerSessions':await ctx.db.patch(row._id,{authorized:false,expiresAt:0});break;
        case 'researchSessions':await ctx.db.patch(row._id,{consent:null,withdrawnAt:now,retentionState:'purged',finalReview:undefined,currentPrompt:undefined,pendingInterview:undefined,followUps:undefined});break;
        case 'researchCaptures':await ctx.db.patch(row._id,{state:'purged',domChallengeHash:null,deadline:0});break;
        case 'researchMedia':{
          const media=row as import('./_generated/dataModel').Doc<'researchMedia'>;
          for(const key of[media.objectKey,...media.retiredKeys])if(/^research\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(key))fenceKeys.push(key);else if(key!=='pending')throw new Error('Invalid restored object key');
          await ctx.db.patch(row._id,{state:'delete-pending',leaseUntil:0,availableAt:null,cleanupUntil:0,cleanupNextAt:now});break;
        }
        case 'researchReports':await ctx.db.patch(row._id,{state:'invalidated',evidence:[],findings:[],excerpts:[],grants:[]});break;
        case 'researchAnalyses':{const analysis=row as import('./_generated/dataModel').Doc<'researchAnalyses'>;await ctx.db.patch(row._id,{state:'invalidated',evidence:[],findings:[],excerpts:[],studyContext:'',reservation:{...analysis.reservation,expiresAt:0}});break;}
        case 'researchInterviewPolicy':case 'researchSpeechPolicy':case 'researchSpeechGrants':await ctx.db.patch(row._id,{enabled:false});break;
        case 'researchGatewayAllocations':await ctx.db.patch(row._id,{expiresAt:0});break;
        // Preserve workStarted and counters: absence/expiry does not prove an
        // old operation settled or authorize reuse/refunding its allowance.
        case 'researchGatewaySlots':await ctx.db.patch(row._id,{expiresAt:0});break;
      }
    }
    return{cursor:page.continueCursor,done:page.isDone,count:page.page.length,fenceKeys:[...new Set(fenceKeys)]};
  },
});

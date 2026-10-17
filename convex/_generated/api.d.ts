/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as bootstrap from "../bootstrap.js";
import type * as capture from "../capture.js";
import type * as captureGateway from "../captureGateway.js";
import type * as captureLifecycle from "../captureLifecycle.js";
import type * as captureValidators from "../captureValidators.js";
import type * as cleanupDue from "../cleanupDue.js";
import type * as crons from "../crons.js";
import type * as currentResearchPrompt from "../currentResearchPrompt.js";
import type * as finalReview from "../finalReview.js";
import type * as gatewayLeaseValidators from "../gatewayLeaseValidators.js";
import type * as http from "../http.js";
import type * as interviewValidators from "../interviewValidators.js";
import type * as invitations from "../invitations.js";
import type * as lifecycle from "../lifecycle.js";
import type * as lifecycleQualification from "../lifecycleQualification.js";
import type * as participant from "../participant.js";
import type * as reportAccess from "../reportAccess.js";
import type * as reportValidators from "../reportValidators.js";
import type * as research from "../research.js";
import type * as researchAnalysis from "../researchAnalysis.js";
import type * as researchGatewayLeases from "../researchGatewayLeases.js";
import type * as researchInterview from "../researchInterview.js";
import type * as researchInterviewFixture from "../researchInterviewFixture.js";
import type * as researchPortal from "../researchPortal.js";
import type * as researchReportLifecycle from "../researchReportLifecycle.js";
import type * as researchReports from "../researchReports.js";
import type * as researchSpeech from "../researchSpeech.js";
import type * as researchSpeechFixture from "../researchSpeechFixture.js";
import type * as researchSpeechGrants from "../researchSpeechGrants.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  bootstrap: typeof bootstrap;
  capture: typeof capture;
  captureGateway: typeof captureGateway;
  captureLifecycle: typeof captureLifecycle;
  captureValidators: typeof captureValidators;
  cleanupDue: typeof cleanupDue;
  crons: typeof crons;
  currentResearchPrompt: typeof currentResearchPrompt;
  finalReview: typeof finalReview;
  gatewayLeaseValidators: typeof gatewayLeaseValidators;
  http: typeof http;
  interviewValidators: typeof interviewValidators;
  invitations: typeof invitations;
  lifecycle: typeof lifecycle;
  lifecycleQualification: typeof lifecycleQualification;
  participant: typeof participant;
  reportAccess: typeof reportAccess;
  reportValidators: typeof reportValidators;
  research: typeof research;
  researchAnalysis: typeof researchAnalysis;
  researchGatewayLeases: typeof researchGatewayLeases;
  researchInterview: typeof researchInterview;
  researchInterviewFixture: typeof researchInterviewFixture;
  researchPortal: typeof researchPortal;
  researchReportLifecycle: typeof researchReportLifecycle;
  researchReports: typeof researchReports;
  researchSpeech: typeof researchSpeech;
  researchSpeechFixture: typeof researchSpeechFixture;
  researchSpeechGrants: typeof researchSpeechGrants;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

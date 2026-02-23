/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as classifyEngagement from "../classifyEngagement.js";
import type * as decide from "../decide.js";
import type * as engagements from "../engagements.js";
import type * as experimentRuns from "../experimentRuns.js";
import type * as findings from "../findings.js";
import type * as friction from "../friction.js";
import type * as lib_security from "../lib/security.js";
import type * as mouse from "../mouse.js";
import type * as posthog from "../posthog.js";
import type * as sessions from "../sessions.js";
import type * as signals from "../signals.js";
import type * as studies from "../studies.js";
import type * as telemetry from "../telemetry.js";
import type * as transcripts from "../transcripts.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  classifyEngagement: typeof classifyEngagement;
  decide: typeof decide;
  engagements: typeof engagements;
  experimentRuns: typeof experimentRuns;
  findings: typeof findings;
  friction: typeof friction;
  "lib/security": typeof lib_security;
  mouse: typeof mouse;
  posthog: typeof posthog;
  sessions: typeof sessions;
  signals: typeof signals;
  studies: typeof studies;
  telemetry: typeof telemetry;
  transcripts: typeof transcripts;
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

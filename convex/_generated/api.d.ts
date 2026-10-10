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
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as lifecycle from "../lifecycle.js";
import type * as lifecycleQualification from "../lifecycleQualification.js";
import type * as participant from "../participant.js";
import type * as research from "../research.js";
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
  crons: typeof crons;
  http: typeof http;
  invitations: typeof invitations;
  lifecycle: typeof lifecycle;
  lifecycleQualification: typeof lifecycleQualification;
  participant: typeof participant;
  research: typeof research;
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

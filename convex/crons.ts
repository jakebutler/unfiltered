import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('Research lifecycle backfill', { minutes: 1 }, internal.lifecycle.backfill, {});
crons.interval('Research invitation expiry recovery', { minutes: 1 }, internal.lifecycle.sweepInvitations, {});
crons.interval('Research source retention recovery', { minutes: 1 }, internal.lifecycle.sweepRetention, {});
crons.interval('Research capture and upload recovery', { minutes: 1 }, internal.captureLifecycle.sweep, {});
export default crons;

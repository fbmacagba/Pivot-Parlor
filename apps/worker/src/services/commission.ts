// WS-4: money is INTEGER pence everywhere; this is the single commission
// rounding path. The implementation lives in @repo/utils so the booking
// worker (the other money writer) uses the identical code — import from here
// (main worker) or from @repo/utils (booking worker), never reimplement.
//
// The old pounds-based calculateCommission and the unused revenue-summary
// helpers (duplicates of the pence versions in db/queries.ts) were removed in
// WS-4.
export { calculateCommissionPence, type CommissionBreakdownPence } from "@repo/utils";

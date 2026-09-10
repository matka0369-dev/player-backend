import { BetType } from '@prisma/client';

/**
 * The payout card every new Admin starts from. An Admin may edit its own
 * DEFAULT card; whatever it holds at the moment an Agent is created is what
 * that Agent inherits as its GIVEN card.
 *
 * Multipliers are simulation payout tiers against a virtual-token stake.
 * Nothing here denotes currency — see ARCHITECTURE.md safety boundaries.
 */
export const DEFAULT_RATES: Record<BetType, number> = {
  SINGLE: 9,
  JODI: 90,
  SINGLE_PANA: 140,
  DOUBLE_PANA: 280,
  TRIPLE_PANA: 600,
  HALF_SANGAM: 1400,
  FULL_SANGAM: 10000,
};

export const BET_TYPES = Object.keys(DEFAULT_RATES) as BetType[];

/** Human labels, so every portal renders the same wording. */
export const BET_TYPE_LABEL: Record<BetType, string> = {
  SINGLE: 'Single',
  JODI: 'Jodi',
  SINGLE_PANA: 'Single Pana',
  DOUBLE_PANA: 'Double Pana',
  TRIPLE_PANA: 'Triple Pana',
  HALF_SANGAM: 'Half Sangam',
  FULL_SANGAM: 'Full Sangam',
};

/**
 * Profit/loss shares are expressed in tenths, so a 9:1 Admin:Agent split is
 * stored as agentShare = 1. Kept as a named constant because "10" appears in
 * validation, allocation, and the UI, and a bare literal in three places is
 * how those three drift apart.
 */
export const PROFIT_SHARE_TOTAL = 10;

/** Agent slice applied when an Admin hasn't configured its own default. */
export const DEFAULT_AGENT_SHARE = 1;

/** A multiplier below this is meaningless; the ceiling is a sanity bound. */
export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 100_000;

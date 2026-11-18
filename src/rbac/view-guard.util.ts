import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { PERMISSIONS } from './permissions.constants';

/**
 * An Agent's employee reads the Agent's prediction and ledger data only if it
 * holds prediction:view (2026-11-18; before this, any staff account saw all of
 * it). The owner Agent and the other tiers are unaffected.
 */
export function assertMayViewPredictionData(requester: AuthenticatedUser): void {
  if (requester.accountType === 'AGENT_STAFF' && !requester.permissions.includes(PERMISSIONS.PREDICTION_VIEW)) {
    throw new ForbiddenException(`Missing required permission: ${PERMISSIONS.PREDICTION_VIEW}`);
  }
}

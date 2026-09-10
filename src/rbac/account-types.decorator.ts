import { SetMetadata } from '@nestjs/common';
import { AccountType } from '../auth/auth.types';

export const ACCOUNT_TYPES_KEY = 'allowedAccountTypes';

// Coarse scope check ("only these account tiers may call this route at
// all"). Finer rules — e.g. which account type a given tier is allowed to
// create — live in the relevant service, not here.
export const RequireAccountTypes = (...types: AccountType[]) => SetMetadata(ACCOUNT_TYPES_KEY, types);

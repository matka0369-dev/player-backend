import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  isEmail,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { PROFIT_SHARE_TOTAL } from '../../rates/rates.constants';
import { RateEntryDto } from '../../rates/dto/update-rates.dto';

// E.164's own length bound (max 15 digits) with an optional leading '+' —
// loose about everything else, since this only has to reject obvious
// garbage, not validate a specific country's numbering plan.
const PHONE_RE = /^\+?[0-9]{7,15}$/;

/**
 * The `email` field (DB column, DTOs, and every TS type down to the
 * frontend all still call it that — renaming it everywhere it's read would
 * be pure churn for a field whose only job is "how does someone sign in")
 * now accepts a phone number too. Kept as one column rather than splitting
 * into email/phone: it was already the sole login identifier alongside
 * username (see AuthService.login's `OR: [{ email }, { username }]`), and
 * that lookup doesn't care what shape the string is.
 */
@ValidatorConstraint({ name: 'isEmailOrPhone', async: false })
export class IsEmailOrPhone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && (isEmail(value) || PHONE_RE.test(value));
  }
  defaultMessage(): string {
    return 'email must be a valid email address or phone number';
  }
}

// Note: 'PLATFORM_ADMIN' is deliberately not a valid value here — the only
// Platform Admin account is created by the seed script, never via API.
// ADMIN_STAFF/AGENT_STAFF are internal delegate accounts — see
// UsersService.create for who may actually create one and with which roles.
const CREATABLE_ACCOUNT_TYPES = ['ADMIN', 'AGENT', 'PLAYER', 'ADMIN_STAFF', 'AGENT_STAFF'] as const;
export type CreatableAccountType = (typeof CREATABLE_ACCOUNT_TYPES)[number];

export class CreateUserDto {
  @IsString()
  @Validate(IsEmailOrPhone)
  email!: string;

  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsIn(CREATABLE_ACCOUNT_TYPES)
  accountType!: CreatableAccountType;

  // Deliberately no `agentId` field. A Player's agent is never a value the
  // caller supplies — it's fixed to whoever is creating it (see
  // UsersService.create: only a native Agent can create a PLAYER at all,
  // and always for itself). Accepting one here would just be a slower way
  // to reintroduce the "Admin assigns a Player to an Agent" capability that
  // was removed on purpose.

  // Only meaningful when accountType is 'ADMIN_STAFF' or 'AGENT_STAFF' —
  // roles are how a Worker (staff) account gets any authority at all, since
  // it has none of its own; a native Admin or Agent never holds one.
  // Optional so a staff account can still be created with no capabilities
  // on purpose, but the UI defaults to granting one where applicable — a
  // role-less Worker can't do anything until someone comes back and
  // assigns it one, which is easy to forget.
  @IsOptional()
  @IsUUID(undefined, { each: true })
  roleIds?: string[];

  // Only meaningful when accountType = 'AGENT'. The Agent's slice of the
  // profit/loss split, in tenths (see PROFIT_SHARE_TOTAL) — omit to inherit
  // the creating Admin's configured default. A simulation accounting split;
  // it never denotes money owed between people.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PROFIT_SHARE_TOTAL)
  agentShare?: number;

  // Meaningful when accountType = 'AGENT' or 'PLAYER'. Omit to inherit the
  // default for that tier as-is — an Agent's creating Admin's current
  // DEFAULT card, or a Player's Agent's current GIVING card, read live
  // rather than snapshotted (the existing behavior for both). When present,
  // it must cover every bet type — a full replacement card, not a partial
  // tweak — since a half-specified payout table is worse than none:
  // UsersService.create rejects anything short of the complete set. For a
  // Player it's additionally capped by its creating Agent's current GIVING
  // card (RatesService.seedPlayerCardFrom) — a Player can never be priced
  // better than the Agent itself gives out.
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RateEntryDto)
  rates?: RateEntryDto[];

  // Starting token balance. Requires the token:administer permission and is
  // written as an audited ADMIN_GRANT ledger entry in the same transaction as
  // the account itself. Closed-loop: tokens originate here and nowhere else,
  // and can never be purchased, redeemed, or converted to value.
  @IsOptional()
  @IsInt()
  @Min(1)
  openingBalance?: number;
}

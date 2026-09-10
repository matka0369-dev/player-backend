import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

// HH:mm, 24-hour, read in the Game's own `timezone` — the recurring daily
// clock time this Game opens/closes at. No seconds: minute resolution is all
// the domain needs, and it keeps the UI a plain <input type="time">.
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Asks the platform's own tz database rather than checking against a
 * hardcoded list: an unknown zone must fail here, at the edge, because both
 * the round generator (Go) and any `AT TIME ZONE` in SQL would otherwise
 * fail much later, on a game that already looks saved.
 */
@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
  defaultMessage(): string {
    return 'timezone must be a valid IANA zone name, e.g. Asia/Kolkata';
  }
}

export class CreateGameDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @Matches(TIME_OF_DAY, { message: 'openTime must be HH:mm (24-hour)' })
  openTime!: string;

  @Matches(TIME_OF_DAY, { message: 'closeTime must be HH:mm (24-hour)' })
  closeTime!: string;

  // The zone openTime/closeTime are read in, and the zone this game's
  // rounds are dated by. Omit to take the platform default — see
  // DEFAULT_GAME_TIMEZONE in games.service.ts.
  @IsOptional()
  @IsString()
  @Validate(IsIanaTimeZone)
  timezone?: string;

  // Recurring weekly off days, 0=Sunday..6=Saturday. Omit for a game that
  // runs every day; one-off exceptions are added afterward as holidays.
  @IsOptional()
  @IsArray()
  @IsIn([0, 1, 2, 3, 4, 5, 6], { each: true })
  @Type(() => Number)
  weeklyOffDays?: number[];

  @IsInt()
  @Min(1)
  minStake!: number;

  @IsInt()
  @Min(1)
  @Max(10_000_000)
  maxStake!: number;
}

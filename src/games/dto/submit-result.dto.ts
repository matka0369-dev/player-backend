import { IsDateString, IsOptional, Matches } from 'class-validator';

export class SubmitResultDto {
  // Which day's round this result belongs to. Explicit rather than "today",
  // because a result is routinely entered for a game whose round has already
  // closed, and an operator correcting yesterday shouldn't have to race the
  // clock.
  @IsDateString({ strict: true })
  date!: string;

  // Structural check only — the non-decreasing rule ('0' sorts as ten) is
  // domain logic and lives in result-derivation.isValidPana, which the
  // service applies. Keeping the regex to "three digits" avoids two
  // half-correct copies of the ordering rule.
  @IsOptional()
  @Matches(/^[0-9]{3}$/, { message: 'openPana must be exactly three digits' })
  openPana?: string;

  @IsOptional()
  @Matches(/^[0-9]{3}$/, { message: 'closePana must be exactly three digits' })
  closePana?: string;
}

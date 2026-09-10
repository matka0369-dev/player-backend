import { IsDateString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Replacing a result that was already published and paid out.
 *
 * Separate from SubmitResultDto rather than a flag on it, because the two
 * mean opposite things about intent: submitting is "this round has no result
 * for this side yet", correcting is "the result it has is wrong and everything
 * derived from it must be undone". Collapsing them would make the destructive
 * path reachable by omitting a field.
 */
export class CorrectResultDto {
  @IsDateString({ strict: true })
  date!: string;

  // Omit a side to keep the pana it already has. At least one must differ
  // from what is currently recorded — the service rejects a no-op, since a
  // correction that changes nothing would still un-pay and re-pay everyone.
  @IsOptional()
  @Matches(/^[0-9]{3}$/, { message: 'openPana must be exactly three digits' })
  openPana?: string;

  @IsOptional()
  @Matches(/^[0-9]{3}$/, { message: 'closePana must be exactly three digits' })
  closePana?: string;

  // Free text, stored on the audit row. Not required — an operator fixing a
  // typo at speed shouldn't be blocked on prose — but it is the only place
  // the *why* is ever captured.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

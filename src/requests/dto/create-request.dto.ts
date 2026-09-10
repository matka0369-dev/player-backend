import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_GRANT } from '../../ledger/ledger.service';

const KINDS = ['TOP_UP', 'SURRENDER'] as const;

export class CreateTokenRequestDto {
  @IsIn(KINDS)
  kind!: (typeof KINDS)[number];

  @IsInt()
  @Min(1)
  @Max(MAX_GRANT)
  amount!: number;

  /**
   * The Player's own words. Deliberately plain text with no companion
   * attachment or reference field: a request describes what the Player wants
   * to happen to tokens inside the system, and is never evidence of an
   * external event. See ARCHITECTURE.md "Hard safety boundaries".
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveTokenRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resolutionNote?: string;
}

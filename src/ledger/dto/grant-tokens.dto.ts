import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MAX_GRANT } from '../ledger.service';

export class GrantTokensDto {
  @IsInt()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export { MAX_GRANT };

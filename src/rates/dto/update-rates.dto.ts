import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { BetType } from '@prisma/client';
import { BET_TYPES, MAX_MULTIPLIER, MIN_MULTIPLIER } from '../rates.constants';

export class RateEntryDto {
  @IsIn(BET_TYPES)
  betType!: BetType;

  @IsInt()
  @Min(MIN_MULTIPLIER)
  @Max(MAX_MULTIPLIER)
  multiplier!: number;
}

export class UpdateRatesDto {
  // A partial card is allowed — only the bet types present are touched, so
  // editing one row doesn't require echoing the whole card back.
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RateEntryDto)
  entries!: RateEntryDto[];
}

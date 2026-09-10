import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, Validate } from 'class-validator';
import { IsIanaTimeZone } from './create-game.dto';

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const GAME_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export class UpdateGameDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Matches(TIME_OF_DAY, { message: 'openTime must be HH:mm (24-hour)' })
  openTime?: string;

  @IsOptional()
  @Matches(TIME_OF_DAY, { message: 'closeTime must be HH:mm (24-hour)' })
  closeTime?: string;

  // Only affects Rounds generated after the change — instants already
  // resolved onto existing rounds are never rewritten, same rule the clock
  // times follow.
  @IsOptional()
  @IsString()
  @Validate(IsIanaTimeZone)
  timezone?: string;

  @IsOptional()
  @IsArray()
  @IsIn([0, 1, 2, 3, 4, 5, 6], { each: true })
  @Type(() => Number)
  weeklyOffDays?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  minStake?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  maxStake?: number;

  // ARCHIVED is the one status a Platform Admin can only move a game into,
  // never out of — see GamesService.update. DRAFT/ACTIVE toggling is
  // otherwise the switch that puts a newly configured game in front of
  // Admins to enable.
  @IsOptional()
  @IsIn(GAME_STATUSES)
  status?: (typeof GAME_STATUSES)[number];
}

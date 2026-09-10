import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateHolidayDto {
  // YYYY-MM-DD — a specific one-off date this Game doesn't run, alongside
  // the recurring weeklyOffDays on the Game itself.
  @IsDateString({ strict: true })
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

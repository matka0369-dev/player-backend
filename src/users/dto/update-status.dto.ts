import { IsBoolean } from 'class-validator';

export class UpdateStatusDto {
  @IsBoolean()
  isActive!: boolean;
}

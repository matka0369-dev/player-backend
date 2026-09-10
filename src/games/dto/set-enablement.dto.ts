import { IsBoolean } from 'class-validator';

export class SetEnablementDto {
  @IsBoolean()
  enabled!: boolean;
}

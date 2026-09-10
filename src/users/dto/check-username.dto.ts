import { IsString, MinLength } from 'class-validator';

export class CheckUsernameDto {
  @IsString()
  @MinLength(3)
  username!: string;
}

import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  // Email address or username — both are unique, and Players are issued a
  // username rather than an email address to remember. Deliberately not
  // @IsEmail: rejecting a username here would defeat the point.
  @IsString()
  @MinLength(3)
  identifier!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

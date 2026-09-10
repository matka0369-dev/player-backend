import { ArrayNotEmpty, IsArray, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissionKeys!: string[];
}

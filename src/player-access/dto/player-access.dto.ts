import { IsOptional, IsString, Matches } from 'class-validator';

// Loose on formatting (people type spaces and dashes) — the service strips to
// digits and enforces the real rule, a country code plus subscriber number.
const PHONE_INPUT_RE = /^\+?[0-9 \-()]{10,24}$/;

// Each field is optional (left out = unchanged) and nullable (null = clear).
export class SetContactsDto {
  @IsOptional()
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'support must be a phone number with country code' })
  support?: string | null;

  @IsOptional()
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'tokens must be a phone number with country code' })
  tokens?: string | null;
}

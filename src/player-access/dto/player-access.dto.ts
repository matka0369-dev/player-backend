import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Loose on formatting (people type spaces and dashes) — the service strips to
// digits and enforces the real rule, a country code plus subscriber number.
const PHONE_INPUT_RE = /^\+?[0-9 \-()]{10,24}$/;

export class SetWhatsappDto {
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'whatsappNumber must be a phone number with country code' })
  whatsappNumber!: string;
}

export class InvitePlayerDto {
  @IsString()
  @Matches(PHONE_INPUT_RE, { message: 'phone must be a phone number with country code' })
  phone!: string;

  // Players never type this — it only has to be unique and readable in the
  // Agent's own table — so it's optional and derived from the phone number.
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9_.-]+$/, { message: 'username may only use letters, digits, _ . -' })
  username?: string;
}

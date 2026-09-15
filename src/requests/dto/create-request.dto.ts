import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { MAX_GRANT } from '../../ledger/ledger.service';
import { parseImageDataUrl } from '../image-data-url.util';

const KINDS = ['TOP_UP', 'SURRENDER'] as const;

@ValidatorConstraint({ name: 'isImageDataUrl', async: false })
class IsImageDataUrl implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && parseImageDataUrl(value) !== null;
  }
  defaultMessage(): string {
    return 'image must be a PNG, JPEG, or WebP data URL of 2MB or less';
  }
}

export class CreateTokenRequestDto {
  @IsIn(KINDS)
  kind!: (typeof KINDS)[number];

  @IsInt()
  @Min(1)
  @Max(MAX_GRANT)
  amount!: number;

  /**
   * The Player's own words. Free text — never a transaction reference. See
   * ARCHITECTURE.md "Hard safety boundaries".
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * One optional image, shown only to the Player who attached it and
   * whichever reviewer already has this request in scope — see
   * ARCHITECTURE.md "Hard safety boundaries" (2026-09-15 revision). A data
   * URL (`data:image/png;base64,...`) rather than a multipart upload, since
   * that's the one write endpoint this API already speaks — never parsed,
   * OCR'd, or read as proof of anything that happened outside this ledger.
   */
  @IsOptional()
  @Validate(IsImageDataUrl)
  image?: string;
}

export class ResolveTokenRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resolutionNote?: string;
}

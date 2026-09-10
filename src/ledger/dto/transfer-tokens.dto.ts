import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class TransferTokensDto {
  // Signed on purpose: positive hands tokens down to the Player, negative
  // claws them back. One endpoint for both directions, because they're the
  // same movement with the legs swapped — see LedgerService.transfer.
  // Deliberately no @Min: zero is rejected in the service alongside the
  // magnitude bound, so the "non-zero whole number" rule lives in one place.
  @IsInt()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

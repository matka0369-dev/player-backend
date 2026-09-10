import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  // UsersModule applies opening balances inside its own creation txn.
  exports: [LedgerService],
})
export class LedgerModule {}

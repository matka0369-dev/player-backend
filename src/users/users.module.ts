import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { RatesModule } from '../rates/rates.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [AuthModule, RbacModule, RatesModule, LedgerModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

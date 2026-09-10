import { Module } from '@nestjs/common';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [RatesController],
  providers: [RatesService],
  // UsersModule seeds cards during account creation, inside its own txn.
  exports: [RatesService],
})
export class RatesModule {}

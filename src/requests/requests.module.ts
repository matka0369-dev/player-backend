import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, RbacModule],
  controllers: [RequestsController],
  providers: [RequestsService],
})
export class RequestsModule {}

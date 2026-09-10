import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { ResultsService } from './results.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  // LedgerModule for the payout writes settlement performs.
  imports: [AuthModule, RbacModule, LedgerModule],
  controllers: [GamesController],
  providers: [GamesService, ResultsService],
})
export class GamesModule {}

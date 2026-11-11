import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { UsersModule } from '../users/users.module';
import { PlayerAccessController } from './player-access.controller';
import { PlayerAccessService } from './player-access.service';

@Module({
  imports: [AuthModule, RbacModule, UsersModule],
  controllers: [PlayerAccessController],
  providers: [PlayerAccessService],
})
export class PlayerAccessModule {}

import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}

import { Module } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { AccountTypesGuard } from './account-types.guard';

@Module({
  providers: [PermissionsGuard, AccountTypesGuard],
  exports: [PermissionsGuard, AccountTypesGuard],
})
export class RbacModule {}

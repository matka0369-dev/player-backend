import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from './permissions.constants';

export const PERMISSIONS_KEY = 'requiredPermissions';

// Route requires the caller to hold ALL listed permissions (PLATFORM_ADMIN
// bypasses this check entirely — see PermissionsGuard).
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

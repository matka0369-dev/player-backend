import { Request } from 'express';
import { PermissionKey } from '../rbac/permissions.constants';

export type AccountType = 'PLATFORM_ADMIN' | 'ADMIN' | 'AGENT' | 'PLAYER' | 'ADMIN_STAFF' | 'AGENT_STAFF';

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  accountType: AccountType;
  agentId: string | null;
  // Who created this account. For ADMIN_STAFF/AGENT_STAFF this is the
  // Admin/Agent whose subtree they act within — see resolveScopeOwnerId in
  // users.service.ts. Null only for the bootstrap Platform Admin.
  createdById: string | null;
  permissions: PermissionKey[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

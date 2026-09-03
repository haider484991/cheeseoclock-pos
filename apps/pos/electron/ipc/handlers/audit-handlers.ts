import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { requireSettingsManage } from '../guards.js';
import { auditChainService } from '../../services/audit-chain-service.js';

export function registerAuditHandlers(ctx: HandlerContext): void {
  /** Walk the whole audit trail and report whether every link still holds. */
  defineHandler('audit:verifyChain', ctx, () => {
    requireSettingsManage();
    return ok(auditChainService.verify(ctx.db));
  });
}

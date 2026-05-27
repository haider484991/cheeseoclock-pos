import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import { listFloorSections, listTables } from '../../db/repositories/table-repo.js';

function requireSession(): void {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
}

export function registerTablesHandlers(ctx: HandlerContext): void {
  defineHandler('tables:listSections', ctx, () => {
    requireSession();
    return ok(listFloorSections(ctx.db));
  });

  defineHandler('tables:list', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listTables(ctx.db, payload?.sectionId));
  });
}

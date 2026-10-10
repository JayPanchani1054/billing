/**
 * attachments module routes (dataplus): files attached to vouchers, ledgers and stock items.
 * Access is checked per owner in the service (vouchers.view / masters.view to see, attachments.add /
 * attachments.remove to change); every change is audited on the owner.
 */
import { ATTACHMENT_ENTITY_TYPES, MAX_ATTACHMENT_BYTES } from '../../../shared/attachments.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { addAttachment, attachmentRegister, countAttachments, listAttachments, readAttachment, removeAttachment } from './service.ts';

const ENTITY = v.enum(ATTACHMENT_ENTITY_TYPES);

export const attachmentsRoutes = {
  'attachments.list': companyRoute({
    access: 'authenticated',
    input: v.object({ entityType: ENTITY, entityId: v.id() }),
    handler: (ctx, input) => listAttachments(ctx, input),
  }),
  'attachments.counts': companyRoute({
    access: 'authenticated',
    transactional: false,
    input: v.object({ entityType: ENTITY, ids: v.array(v.id(), { max: 5000 }) }),
    handler: (ctx, input) => countAttachments(ctx, input),
  }),
  // Own transaction: a stored file whose row could not be written is deleted again.
  'attachments.add': companyRoute({
    access: 'attachments.add',
    transactional: false,
    input: v.object({
      entityType: ENTITY,
      entityId: v.id(),
      fileName: v.string({ min: 1, max: 1000 }),
      // A little above the limit so the service can answer with the real size in its message.
      bytes: v.bytes({ max: MAX_ATTACHMENT_BYTES + 1024 * 1024 }),
      note: v.string({ max: 500 }).nullable().optional(),
    }),
    handler: (ctx, input) => addAttachment(ctx, input),
  }),
  'attachments.read': companyRoute({
    access: 'authenticated',
    transactional: false,
    input: v.object({ id: v.id() }),
    handler: (ctx, { id }) => readAttachment(ctx, id),
  }),
  // Own transaction: the stored file is deleted only after the removal committed.
  'attachments.remove': companyRoute({
    access: 'attachments.remove',
    transactional: false,
    input: v.object({ id: v.id() }),
    handler: (ctx, { id }) => removeAttachment(ctx, id),
  }),
  'attachments.register': companyRoute({
    access: 'authenticated',
    transactional: false,
    input: v.object({
      entityType: ENTITY.optional(),
      search: v.string({ max: 100 }).optional(),
      from: v.date().optional(),
      to: v.date().optional(),
      limit: v.int({ min: 1, max: 5000 }).optional(),
      offset: v.int({ min: 0 }).optional(),
    }),
    handler: (ctx, input) => attachmentRegister(ctx, input),
  }),
} satisfies RouteMap;

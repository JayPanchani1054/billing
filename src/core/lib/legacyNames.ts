/**
 * Formats written by builds before the rename. Data made by those builds — backup files, encrypted
 * envelopes, audit anchors — keeps these names forever, so the core still READS them. Nothing new is
 * ever written with them. Every legacy token of the core lives here (the XML data import's legacy
 * vouchers.meta values are defined next to the interchange format and re-exported below).
 */

/** File extension of backups made before the rename (still listed, verified and restored). */
export const LEGACY_BACKUP_EXTENSION = '.bahibak';
/** 8-byte magic at the start of such a backup container. */
export const LEGACY_BACKUP_MAGIC = 'BAHIBAK1';
/** manifest.format of such a backup. */
export const LEGACY_BACKUP_FORMAT = 'bahi-backup';
/** 8-byte magic of the AES-256-GCM envelope (encrypted backup payloads, crypto.ts) written before the rename. */
export const LEGACY_ENC_MAGIC = 'BAHIENC1';
/** Domain-separation prefix of audit-anchor MACs (auditAnchor.ts) recorded before the rename. */
export const LEGACY_ANCHOR_MAC_PREFIX = 'bahi-audit-anchor-v1';

export { LEGACY_IMPORT_META_KEY, LEGACY_IMPORT_SOURCE } from '../modules/data/xmlFormat.ts';

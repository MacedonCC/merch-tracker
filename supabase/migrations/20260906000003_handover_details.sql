-- ---------------------------------------------------------------
-- migration-009: record who handed an order over, and any note
--
-- Both nullable: only ever set together, by the handover modal, at
-- the same time as distributed_at. Undoing a handover
-- (TrackerSection.tsx's undoHandover) clears all three together so a
-- reversed handover doesn't leave a stale "by AB" behind.
-- ---------------------------------------------------------------

alter table orders
  add column if not exists handed_over_by text,
  add column if not exists handover_note text;

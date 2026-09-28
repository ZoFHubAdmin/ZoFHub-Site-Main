// lib/cms-store-errors.mjs — one error type for every storage adapter.
//
// The service layer turns these into HTTP statuses, so each adapter must map
// its own failures onto the SAME small vocabulary:
//
//   conflict      a unique constraint (slug, username, provider game, pattern)  → 409
//   fk            a foreign key refused the write or the delete                → 409
//   invalid       a CHECK constraint refused the value                         → 400
//   precondition  an atomic operation found a target in the wrong state        → 409
//   unavailable   the database could not be reached                            → 503

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const STORE_HTTP = Object.freeze({ conflict: 409, fk: 409, invalid: 400, precondition: 409, unavailable: 503 });

/** Map a Postgres / PostgREST error onto a StoreError. */
export function fromPg(err, fallback = 'unavailable') {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || 'database error');
  if (code === '23505') return new StoreError('conflict', friendlyUnique(msg));
  // 23503 = foreign_key_violation (insert/update naming a missing row, or a
  // NO ACTION delete); 23001 = restrict_violation, which is what an ON DELETE
  // RESTRICT key raises — measured against Postgres 17 in
  // test/control-plane-db.test.mjs. Both mean "in use" to the caller.
  if (code === '23001') return new StoreError('fk', 'this record is still in use and cannot be removed');
  if (code === '23503') return new StoreError('fk', /still referenced|is still referenced/.test(msg)
    ? 'this record is still in use and cannot be removed' : 'a referenced record does not exist');
  if (code === '23514' || code === '22P02' || code === '22001') return new StoreError('invalid', 'a value was rejected by the database');
  if (code === 'P0001') return new StoreError('precondition', msg.slice(0, 200));
  return new StoreError(fallback, 'database request failed');
}

function friendlyUnique(msg) {
  if (/slug/.test(msg)) return 'that slug is already used';
  if (/username/.test(msg)) return 'that username is taken';
  if (/external/.test(msg)) return 'this provider game is already in the catalog';
  if (/pattern/.test(msg)) return 'that destination is already listed';
  return 'that record already exists';
}

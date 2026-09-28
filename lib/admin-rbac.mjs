// lib/admin-rbac.mjs — who may do what inside /api/admin.
// ---------------------------------------------------------------------------
// Before this file, admin authorisation was a single boolean. requireAdmin()
// answered "is this an admin?" and every route that got `true` could do
// everything every other route could do.
//
// That is not a theoretical problem here, because TWO DIFFERENT PRINCIPALS
// already reach those routes:
//
//   • the SESSION admin — a person who logged in at /admin with a password,
//     holding a short-lived cookie with CSRF protection and an idle timeout;
//
//   • the BEARER token — ADMIN_SECRET, a static string in the environment,
//     documented as an "independent machine token for monitors/CLI". It never
//     expires, has no CSRF protection, is not tied to a person, and is the kind
//     of credential that ends up in a shell history, a cron file or a CI log.
//
// Those two deserve different power, and until now they had identical power: a
// leaked monitoring token could clear the cache, revoke every admin session, or
// flip catalog visibility — none of which a monitor has any reason to do.
//
// ── WHAT THIS MODULE IS, AND IS NOT ────────────────────────────────────────
// It is a PERMISSION layer: the roles, and the permissions each role holds.
// Enforcement lives in server.js (`requirePerm`), in the same inline style as
// the requireAdmin/requireAdminCsrf guards it sits beside — so every route
// reads top-to-bottom as authenticate, authorise, act.
//
// It is NOT the account store. Staff accounts live in public.admin_users
// (db/control-plane.sql, lib/staff-service.mjs) and carry one of the STAFF
// roles below; the environment-configured owner (ADMIN_USERNAME /
// ADMIN_PASSWORD_HASH) is the break-glass `owner` and is deliberately not a row
// there. `roleForPrincipal` is still the single place a principal becomes a
// role — nothing else in the codebase reads a role directly.
//
// Pure and dependency-free: every function takes plain values and returns plain
// values, so the whole model is testable without a server or a database.

/**
 * Every permission the admin surface distinguishes.
 *
 * Deliberately coarse. A permission per route would be unmaintainable and would
 * drift the moment a route was added; these are grouped by BLAST RADIUS, which
 * is the property that actually decides whether a given principal should hold
 * one.
 */
export const PERMISSIONS = Object.freeze({
  // ── The original seven. Route guards and tests name these; kept verbatim. ──
  'telemetry.read':  'Read operational metrics — dashboard, system, analytics, proxy health',
  'catalog.read':    'Read the game catalog and its quality reports',
  'catalog.write':   'Change catalog state — game visibility, forced refresh',
  'moderation.write': 'Act on user-submitted content — recommendations, feedback',
  'security.read':   'Read the audit log, login attempts and security events',
  'security.write':  'Act on sessions and credentials — revoke, logout-all',
  'config.write':    'Change running configuration — cache purge, routing toggles',

  // ── Content lifecycle (the game CMS) ──────────────────────────────────────
  // Split along separation of duties: the person who writes a game record is
  // not, by default, the person who approves it, and neither is the person who
  // makes it public.
  'games.read':      'Browse the content database — every game in every lifecycle state',
  'games.create':    'Create draft games',
  'games.update':    'Edit game metadata, media and category, and submit drafts for review',
  'games.review':    'Approve or reject games that are awaiting review',
  'games.publish':   'Publish and unpublish games, and change the embed of a live game',
  'games.archive':   'Archive games and restore them from the archive',
  'games.delete':    'Permanently delete an archived game (needs re-authentication)',
  'games.bulk':      'Apply one change to many games at once',
  'games.import':    'Run catalog imports from approved providers',
  'taxonomy.manage': 'Create, edit, reorder and hide categories and tags',
  'providers.manage': 'Approve, restrict, suspend or revoke game providers and their origins',

  // ── Staff administration ──────────────────────────────────────────────────
  'users.read':      'View staff accounts, their status and their activity',
  'users.manage':    'Create staff accounts, suspend and restore them, reset passwords, revoke sessions',
  'users.roles':     'Change the role of a staff account',
  'users.delete':    'Delete (anonymise) a staff account',

  // ── Platform configuration ────────────────────────────────────────────────
  'settings.manage': 'Change typed site settings — announcements, feature flags, maintenance mode',
  'ads.manage':      'Enable or disable advertising providers and placements',
  'audit.export':    'Export the audit trail as a file',

  // ── Proxy governance ──────────────────────────────────────────────────────
  'proxy.read':      'View proxy engines, approved destinations, policy and live sessions',
  'proxy.manage':    'Enable or disable proxy engines and change who may use the proxy',
  'proxy.targets':   'Propose, approve and revoke proxy destinations',
  'proxy.policy':    'Change proxy resource limits',
  'proxy.sessions':  'Terminate live proxy sessions',
  'proxy.use':       'Use the proxy while its access mode is restricted to staff',
});

export const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS));

/**
 * The roles, in descending order of power.
 *
 * `owner` holds the wildcard rather than an enumerated list on purpose: a new
 * permission added above must not silently fail closed for the one principal
 * that is definitionally allowed to do everything. Every OTHER role enumerates,
 * so a new permission fails closed for them — which is the correct default and
 * the opposite of what a wildcard would give.
 */
export const ROLES = Object.freeze({
  owner: {
    label: 'Owner',
    describe: 'The environment-configured break-glass admin. Full control; cannot be changed from the console.',
    permissions: '*',
    rank: 100,
  },
  super_admin: {
    label: 'Super admin',
    describe: 'Full control, including staff roles and permanent deletion. Only the owner can grant it.',
    permissions: '*',
    rank: 90,
  },
  admin: {
    label: 'Admin',
    describe: "Runs the platform day to day. Cannot change roles, delete accounts or games, or revoke other people's sessions.",
    permissions: Object.freeze([
      'telemetry.read', 'catalog.read', 'catalog.write', 'moderation.write',
      'security.read', 'config.write',
      'games.read', 'games.create', 'games.update', 'games.review', 'games.publish',
      'games.archive', 'games.bulk', 'games.import', 'taxonomy.manage', 'providers.manage',
      'users.read', 'users.manage',
      'settings.manage', 'ads.manage', 'audit.export',
      'proxy.read', 'proxy.manage', 'proxy.targets', 'proxy.policy', 'proxy.sessions', 'proxy.use',
    ]),
    rank: 70,
  },
  content_manager: {
    label: 'Content manager',
    describe: 'Writes and edits game records and submits them for review. Cannot publish.',
    permissions: Object.freeze([
      'catalog.read', 'games.read', 'games.create', 'games.update', 'proxy.use',
    ]),
    rank: 40,
  },
  moderator: {
    label: 'Moderator',
    describe: 'Reviews submitted games and community content. Cannot publish or configure.',
    permissions: Object.freeze([
      'catalog.read', 'games.read', 'games.review', 'moderation.write', 'proxy.use',
    ]),
    rank: 40,
  },
  analyst: {
    label: 'Analyst',
    describe: 'Read-only access to metrics, the catalog and proxy health.',
    permissions: Object.freeze(['telemetry.read', 'catalog.read', 'games.read', 'proxy.read']),
    rank: 40,
  },
  support: {
    label: 'Support',
    describe: 'Answers feedback and moderates community posts.',
    permissions: Object.freeze(['telemetry.read', 'catalog.read', 'games.read', 'moderation.write']),
    rank: 40,
  },
  operator: {
    label: 'Operator',
    describe: 'Service-token role for day-to-day automation. Cannot touch sessions or running config.',
    permissions: Object.freeze([
      'telemetry.read', 'catalog.read', 'catalog.write',
      'moderation.write', 'security.read', 'games.read',
    ]),
    rank: 30,
  },
  viewer: {
    label: 'Viewer',
    describe: 'Read-only. The correct role for an uptime monitor or a dashboard.',
    permissions: Object.freeze(['telemetry.read', 'catalog.read', 'games.read']),
    rank: 20,
  },
  none: {
    label: 'No access',
    describe: 'Authenticated but unauthorised — holds nothing.',
    permissions: Object.freeze([]),
    rank: 0,
  },
});

/** The roles a staff ACCOUNT may hold (public.admin_users.role). */
export const STAFF_ROLES = Object.freeze(['super_admin', 'admin', 'content_manager', 'moderator', 'analyst', 'support']);

/** Roles a static service token may run as. Never admin or above: a token in a
 *  cron file is not a person and cannot re-authenticate. */
export const SERVICE_ROLES = Object.freeze(['operator', 'viewer', 'content_manager', 'moderator', 'analyst', 'support']);

export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

/**
 * The role the static bearer token runs as.
 *
 * DEFAULTS TO `operator`, NOT `owner`. README documents ADMIN_SECRET as
 * unlocking "the catalog, analytics, security and feedback endpoints", so
 * `operator` preserves everything a monitor or CLI is documented to do while
 * removing the two capabilities it has no reason to hold: revoking sessions
 * (security.write) and purging running config (config.write).
 *
 * Set ADMIN_SERVICE_ROLE=viewer for a pure monitor — that is the hardened
 * choice and costs nothing if the token is only ever used to read.
 */
export function serviceRole(env = process.env) {
  const raw = String(env.ADMIN_SERVICE_ROLE || '').trim().toLowerCase();
  // An unrecognised value is a typo, and a typo must not silently escalate.
  // Falling back to the documented default is safe; falling back to `owner`
  // would mean ADMIN_SERVICE_ROLE=vewer quietly granted everything. The
  // accepted set is an allowlist, so `admin` and `super_admin` fall back too.
  return SERVICE_ROLES.includes(raw) ? raw : 'operator';
}

/**
 * Which role does this authenticated principal run as?
 *
 * @param {{username?: string, via?: string, role?: string}|null} principal
 *        req.admin, as set by adminGate (session) or requireAdmin (bearer).
 */
export function roleForPrincipal(principal, env = process.env) {
  if (!principal) return 'none';
  // A staff account carries its role from public.admin_users. An explicit role
  // the model does not know FAILS CLOSED to `none`. It used to fall through to
  // `owner`, which was harmless while nothing set a role and would be a full
  // privilege escalation now that the database does. `owner` itself can never
  // be claimed this way: it belongs to the environment-configured account only.
  if (principal.role !== undefined && principal.role !== null) {
    return typeof principal.role === 'string' && Object.hasOwn(ROLES, principal.role)
      && principal.role !== 'owner' ? principal.role : 'none';
  }
  if (principal.userId) return 'none';                 // an account row with no role
  if (principal.via === 'bearer') return serviceRole(env);
  // A cookie session is the interactive admin: one person, password, CSRF,
  // idle timeout. That is the owner.
  return 'owner';
}

/** Every permission a role holds, expanded. */
export function permissionsFor(role) {
  const def = ROLES[role];
  if (!def) return [];
  return def.permissions === '*' ? [...PERMISSION_IDS] : [...def.permissions];
}

/**
 * May `principal` perform `permission`?
 *
 * Unknown permissions return FALSE rather than throwing. A typo in a route's
 * requirePerm(req, res, 'catalog.wrote') must fail closed — an exception would
 * be caught by the error handler and could surface as a 500 that an operator
 * "fixes" by removing the check.
 */
export function can(principal, permission, env = process.env) {
  if (!PERMISSION_IDS.includes(permission)) return false;
  const role = roleForPrincipal(principal, env);
  const def = ROLES[role];
  if (!def) return false;
  return def.permissions === '*' || def.permissions.includes(permission);
}

/**
 * What the admin UI needs to know about itself.
 *
 * Returned by /api/admin/me so the console can hide controls the current
 * principal cannot use. This is a USABILITY measure, never the enforcement —
 * every permission is checked again on the server, because a hidden button is
 * not an access control.
 */
export function principalSummary(principal, env = process.env) {
  const role = roleForPrincipal(principal, env);
  return {
    username: principal?.username || null,
    via: principal?.via || 'session',
    role,
    roleLabel: ROLES[role]?.label || role,
    permissions: permissionsFor(role),
  };
}

/** Numeric power of a role; unknown roles are powerless. */
export const rankOf = (role) => ROLES[role]?.rank ?? 0;

/**
 * May `actor` create, change or act on an account holding `targetRole`?
 *
 * Strict inequality — you can only act on someone BELOW you — with one
 * exception: the owner may act on anyone, because the owner is the only
 * principal that can mint or remove a super admin. Two super admins therefore
 * cannot demote, suspend or delete each other; that dispute goes to the owner.
 * Acting on YOURSELF is refused by the caller, which knows the target's id.
 */
export function canActOnRole(actor, targetRole, env = process.env) {
  if (!STAFF_ROLES.includes(targetRole)) return false;
  const mine = roleForPrincipal(actor, env);
  if (mine === 'owner') return true;
  return rankOf(mine) > rankOf(targetRole);
}

/** The staff roles `actor` may assign. */
export function assignableRoles(actor, env = process.env) {
  return STAFF_ROLES.filter((r) => canActOnRole(actor, r, env));
}

export default {
  PERMISSIONS, PERMISSION_IDS, ROLES, ROLE_IDS, STAFF_ROLES, SERVICE_ROLES,
  serviceRole, roleForPrincipal, permissionsFor, can, principalSummary,
  rankOf, canActOnRole, assignableRoles,
};

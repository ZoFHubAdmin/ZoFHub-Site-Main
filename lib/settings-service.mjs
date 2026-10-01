// lib/settings-service.mjs — read and change the typed settings.
//
// Values are cached in memory and reloaded after every write, so a request
// path that consults a setting (maintenance mode on every page view, a feature
// flag on every API call) costs nothing. Writes are validated against the
// registry, permission-checked per key, and audited with before/after.

import { can } from './admin-rbac.mjs';
import { SETTINGS, SETTING_KEYS, resolveSettings, publicSettings } from './settings-registry.mjs';
import { ServiceError } from './cms-service.mjs';
import { redact } from './audit-redact.mjs';

export function createSettingsService({ store, audit = () => {}, onChange = () => {} } = {}) {
  let values = resolveSettings([]).values;
  let problems = [];
  let loadedFrom = 'defaults';

  const svc = {
    async load() {
      if (!store) return values;
      try {
        const r = resolveSettings(await store.listSettings());
        values = r.values; problems = r.problems; loadedFrom = store.kind;
      } catch (e) {
        problems = [`settings could not be read (${e.message}); running on defaults`];
      }
      return values;
    },
    get: (key) => values[key],
    all: () => structuredClone(values),
    public: () => publicSettings(values),
    status: () => ({ loadedFrom, problems }),

    /** Everything the console needs to render the settings form. */
    describe(actor) {
      return SETTING_KEYS.map((k) => ({
        key: k, value: values[k], default: SETTINGS[k].default, describe: SETTINGS[k].describe,
        public: !!SETTINGS[k].public, reauth: !!SETTINGS[k].reauth,
        editable: can(actor, SETTINGS[k].perm), perm: SETTINGS[k].perm,
      }));
    },

    async set(actor, key, value, { reauthenticated = false } = {}) {
      if (!Object.hasOwn(SETTINGS, key)) throw new ServiceError(404, 'no such setting');
      const def = SETTINGS[key];
      if (!can(actor, def.perm)) throw new ServiceError(403, 'forbidden', { needed: def.perm });
      const [clean, err] = def.validate(value);
      if (err) throw new ServiceError(400, `${key}: ${err}`);
      if (def.reauth && !reauthenticated) throw new ServiceError(401, 'confirm your password to change this setting', { reauth: true });
      if (!store) throw new ServiceError(503, 'settings need the database');
      const before = values[key];
      await store.putSetting(key, clean, String(actor?.username || 'unknown'));
      await svc.load();
      try {
        audit({ actor, action: 'settings.update', resourceType: 'setting', resourceId: key, target: `setting:${key}`,
          outcome: 'success', detail: redact({ from: before, to: clean }) });
      } catch { /* never fail the write on the audit sink */ }
      onChange(key, clean);
      return values[key];
    },
  };
  return svc;
}

export default { createSettingsService };

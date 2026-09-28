'use strict';

function createResourceState() {
  return {
    presented: { activities: new Set(), experiences: new Set() },
    signatures: { activities: new Map(), experiences: new Map() },
    dismissed: { activities: new Set(), experiences: new Set() },
  };
}

const idOf = (descriptor) => String(descriptor?.id || '');
const signatureOf = (descriptor) => JSON.stringify(descriptor);

async function reconcileKind(plugin, kind, descriptors, keepIds, state, client, log, pulse) {
  const presented = state.presented[kind];
  const signatures = state.signatures[kind];
  const dismissed = state.dismissed[kind];
  const owned = plugin.ownedIds?.[kind] || [];
  const methodPrefix = kind === 'activities' ? 'LiveActivity' : 'NotchExperience';
  const methodKind = kind === 'activities' ? 'activity' : 'experience';
  const descriptorById = new Map(descriptors.map((descriptor) => [idOf(descriptor), descriptor]).filter(([id]) => id));
  const retained = new Set([...keepIds, ...descriptorById.keys()].filter(Boolean));
  const reconcileIds = new Set([...owned, ...presented, ...descriptorById.keys()]);

  for (const id of reconcileIds) {
    if (!retained.has(id)) {
      if (dismissed.has(id) && !presented.has(id)) continue;
      try {
        await client[`dismiss${methodPrefix}`](id);
        presented.delete(id);
        signatures.delete(id);
        dismissed.add(id);
        log(`${plugin.id}: dismissed ${methodKind} ${id}`);
      } catch (error) {
        log(`${plugin.id}: dismiss ${methodKind} ${id} failed: ${error?.message || error}`);
      }
      continue;
    }

    dismissed.delete(id);
    const descriptor = descriptorById.get(id);
    if (!descriptor) continue;
    const signature = signatureOf(descriptor);
    const needsPresent = !presented.has(id) || (kind === 'activities' && pulse);
    const changed = signatures.get(id) !== signature;
    if (!needsPresent && !changed) continue;

    try {
      if (needsPresent) await client[`present${methodPrefix}`](descriptor);
      else await client[`update${methodPrefix}`](descriptor);
      presented.add(id);
      signatures.set(id, signature);
      log(`${plugin.id}: ${needsPresent ? 'presented' : 'updated'} ${methodKind} ${id}`);
    } catch (error) {
      presented.delete(id);
      signatures.delete(id);
      log(`${plugin.id}: present/update ${methodKind} ${id} failed: ${error?.message || error}`);
    }
  }
}

async function reconcileResources(plugin, built, state, client, log = () => {}) {
  const explicitPolicy = Object.prototype.hasOwnProperty.call(built, 'keepPresented');
  const keep = explicitPolicy
    ? built.keepPresented || { activities: [], experiences: [] }
    : built.retract
      ? { activities: [], experiences: [] }
      : { activities: [], experiences: plugin.persistentIds?.experiences || [] };
  const activities = built.retract ? [] : (built.liveActivity ? [built.liveActivity] : []);
  const experiences = built.retract ? [] : (built.experiences || []);
  await reconcileKind(plugin, 'activities', activities, keep.activities || [], state, client, log, built.pulse === true);
  await reconcileKind(plugin, 'experiences', experiences, keep.experiences || [], state, client, log, false);
  return state;
}

module.exports = { createResourceState, reconcileResources };

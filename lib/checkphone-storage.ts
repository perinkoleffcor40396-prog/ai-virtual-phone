import Dexie from "dexie";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId, type CheckPhoneManifest, type CheckPhoneSnapshot } from "./checkphone-config";
import { kvGet, kvKeysWithPrefix, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";
import { formatPromptTimestamp } from "./prompt-time";

type CheckPhoneManifestRow = CheckPhoneManifest;
type CheckPhoneSnapshotRow = CheckPhoneSnapshot;
export type CheckPhoneProjectionEntry = {
  id: string;
  appId: CheckPhoneAppId;
  timestamp: string;
  content: string;
};

const CHECKPHONE_EVENT_PREFIX = "ai_phone_checkphone_events_";
const XIAOHONGSHU_EVENT_PREFIX = "ai_phone_xiaohongshu_events_";
const XIAOHONGSHU_READ_THREADS_PREFIX = "checkphone:xiaohongshu:readThreads:";
const XIAOHONGSHU_STATE_KEY = "ai_phone_xiaohongshu_state_v1";
const CHECKPHONE_STORAGE_CLEANUP_KEY = "ai_phone_checkphone_xiaohongshu_cleanup_v1";
const MAX_CHECKPHONE_EVENTS_PER_CHARACTER = 120;

registerDynamicPrefix(CHECKPHONE_EVENT_PREFIX);

class CheckPhoneDatabase extends Dexie {
  manifests!: Dexie.Table<CheckPhoneManifestRow, string>;
  snapshots!: Dexie.Table<CheckPhoneSnapshotRow, string>;

  constructor() {
    super("AiPhoneCheckPhoneDB");
    this.version(1).stores({
      manifests: "characterId, updatedAt",
    });
    this.version(2).stores({
      manifests: "characterId, updatedAt",
      snapshots: "id, characterId, appId, updatedAt, [characterId+appId]",
    });
  }
}

const db = new CheckPhoneDatabase();
const manifestCache = new Map<string, CheckPhoneManifest>();
const snapshotCache = new Map<string, CheckPhoneSnapshot>();
let hydrated = false;

function projectionStorageKey(characterId: string): string {
  return `${CHECKPHONE_EVENT_PREFIX}${characterId}`;
}

function cleanEventText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadProjectionEventsByKey(key: string): CheckPhoneProjectionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CheckPhoneProjectionEntry =>
        entry
        && typeof entry.id === "string"
        && typeof entry.appId === "string"
        && entry.appId in CHECKPHONE_APP_SPECS
        && typeof entry.timestamp === "string"
        && typeof entry.content === "string"
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

function saveProjectionEventsByKey(key: string, entries: CheckPhoneProjectionEntry[]): void {
  if (typeof window === "undefined") return;
  const compacted = [...entries]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_CHECKPHONE_EVENTS_PER_CHARACTER);
  kvSet(key, JSON.stringify(compacted));
}

function recordCheckPhoneSnapshotEvent(snapshot: CheckPhoneSnapshot): void {
  const characterId = cleanEventText(snapshot.characterId, 160);
  if (!characterId) return;
  const spec = CHECKPHONE_APP_SPECS[snapshot.appId];
  if (!spec) return;

  const timestamp = snapshot.updatedAt || snapshot.generatedAt || new Date().toISOString();
  const formattedTime = formatPromptTimestamp(timestamp);
  const label = cleanEventText(spec.shortLabel || spec.label, 40) || snapshot.appId;
  const entry: CheckPhoneProjectionEntry = {
    id: `checkphone_${snapshot.appId}_${Date.parse(timestamp) || Date.now()}`,
    appId: snapshot.appId,
    timestamp,
    content: `${formattedTime ? `[查手机 ${formattedTime}]` : "[查手机]"} {{user}}偷窥了{{char}}的手机的${label}APP。`,
  };

  const key = projectionStorageKey(characterId);
  const current = loadProjectionEventsByKey(key);
  saveProjectionEventsByKey(key, [entry, ...current.filter(item => item.id !== entry.id)]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeTextKey(...parts: unknown[]): string {
  return parts
    .map((part) => String(part ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join("::");
}

function getCheckPhoneMergeKey(item: Record<string, unknown>, fallbackIndex: number): string {
  const hasMessages = Array.isArray(item.messages);
  const stablePersonKey = mergeTextKey(item.name, item.sender, item.senderName, item.authorName, item.authorLabel);
  if (hasMessages && stablePersonKey) return stablePersonKey;

  const timestamp = mergeTextKey(item.createdAt, item.timeLabel, item.updatedLabel, item.shotAtLabel, item.lastPlayedAt);
  const titleKey = mergeTextKey(item.name, item.sender, item.senderName, item.authorName, item.authorLabel, item.title, item.shopName, item.subject, item.urlLabel);
  if (timestamp && titleKey) return mergeTextKey(titleKey, timestamp);

  if (stablePersonKey && ("tagLabel" in item || "relationLabel" in item || "note" in item || "accentLabel" in item)) {
    return stablePersonKey;
  }

  const contentKey = mergeTextKey(
    item.communityName,
    item.postTitle,
    item.body,
    item.caption,
    item.text,
    item.transcript,
  );
  if (timestamp && contentKey) return mergeTextKey(contentKey, timestamp);
  if (contentKey) return contentKey;

  const id = mergeTextKey(item.id);
  return id || `#${fallbackIndex}`;
}

function mergeCheckPhoneValues(previous: unknown, next: unknown): unknown {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return mergeCheckPhoneArrays(previous, next);
  }

  if (isPlainRecord(previous) && isPlainRecord(next)) {
    const merged: Record<string, unknown> = { ...previous, ...next };
    for (const [key, value] of Object.entries(next)) {
      merged[key] = key in previous ? mergeCheckPhoneValues(previous[key], value) : value;
    }
    return merged;
  }

  return next ?? previous;
}

const CHECKPHONE_MERGED_ARRAY_LIMIT = 40;

function mergeCheckPhoneArrays(previous: unknown[], next: unknown[]): unknown[] {
  if (!previous.some(isPlainRecord) || !next.some(isPlainRecord)) {
    return next.length > 0 ? next : previous;
  }

  const mergedByKey = new Map<string, unknown>();
  const order: string[] = [];
  const append = (item: unknown, index: number, preferNext: boolean) => {
    if (!isPlainRecord(item)) return;
    const key = getCheckPhoneMergeKey(item, index);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, item);
      order.push(key);
      return;
    }
    mergedByKey.set(key, preferNext ? mergeCheckPhoneValues(existing, item) : mergeCheckPhoneValues(item, existing));
  };

  next.forEach((item, index) => append(item, index, true));
  previous.forEach((item, index) => append(item, index, false));
  return order.map((key) => mergedByKey.get(key)).filter(Boolean).slice(0, CHECKPHONE_MERGED_ARRAY_LIMIT);
}

function mergeCheckPhoneSnapshotPayload(previous: CheckPhoneSnapshot | undefined, next: CheckPhoneSnapshot): CheckPhoneSnapshot {
  if (!previous || previous.characterId !== next.characterId || previous.appId !== next.appId) return next;
  return {
    ...next,
    payload: mergeCheckPhoneValues(previous.payload, next.payload),
  };
}

export async function hydrateCheckPhoneStorage(): Promise<void> {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const [rows, snapshots] = await Promise.all([
      db.manifests.toArray(),
      db.snapshots.toArray(),
    ]);
    for (const row of rows) {
      manifestCache.set(row.characterId, row);
    }
    for (const row of snapshots) {
      snapshotCache.set(row.id, row);
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] hydrate error:", error);
  }
}

function removeXiaohongshuFromLayoutValue(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    let changed = false;
    const removeId = (item: unknown): boolean => {
      if (typeof item === "string") return item === "xiaohongshu";
      if (!item || typeof item !== "object") return false;
      return (item as { id?: unknown }).id === "xiaohongshu";
    };
    if (Array.isArray(value)) {
      const next = value.filter(item => !removeId(item));
      changed = next.length !== value.length;
      return changed ? JSON.stringify(next) : null;
    }
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (key.startsWith("page") && Array.isArray(item)) {
        const next = item.filter(entry => !removeId(entry));
        if (next.length !== item.length) {
          record[key] = next;
          changed = true;
        }
      } else if (key === "icons" && Array.isArray(item)) {
        const next = item.filter(entry => !removeId(entry));
        if (next.length !== item.length) {
          record[key] = next;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(record) : null;
  } catch {
    return null;
  }
}

/** 删除已移除的小红书留下的全部本地数据；可重复运行。调用方必须在 KV/Dexie 水合后调用。 */
export async function cleanupRemovedXiaohongshuData(): Promise<void> {
  if (typeof window === "undefined") return;
  if (kvGet(CHECKPHONE_STORAGE_CLEANUP_KEY) === "1") return;

  for (const key of [XIAOHONGSHU_STATE_KEY, ...kvKeysWithPrefix(XIAOHONGSHU_EVENT_PREFIX), ...kvKeysWithPrefix(XIAOHONGSHU_READ_THREADS_PREFIX)]) {
    kvRemove(key);
  }
  const legacyLocalStorageKeys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && (key === XIAOHONGSHU_STATE_KEY || key.startsWith(XIAOHONGSHU_EVENT_PREFIX) || key.startsWith(XIAOHONGSHU_READ_THREADS_PREFIX))) {
      legacyLocalStorageKeys.push(key);
    }
  }
  legacyLocalStorageKeys.forEach(key => localStorage.removeItem(key));

  for (const key of kvKeysWithPrefix(CHECKPHONE_EVENT_PREFIX)) {
    const raw = kvGet(key);
    if (!raw) continue;
    try {
      const entries = JSON.parse(raw) as unknown;
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter(entry => (
        !entry || typeof entry !== "object" || (entry as { appId?: unknown }).appId !== "xiaohongshu"
      ));
      if (filtered.length === 0) kvRemove(key);
      else if (filtered.length !== entries.length) kvSet(key, JSON.stringify(filtered));
    } catch {
      // 保留无法识别的查手机记录，避免误删其他应用数据。
    }
  }

  const removedSnapshots = await db.snapshots.where("appId").equals("xiaohongshu").toArray();
  await db.snapshots.where("appId").equals("xiaohongshu").delete();
  removedSnapshots.forEach(row => snapshotCache.delete(row.id));
  for (const row of await db.manifests.toArray()) {
    const next = {
      ...row,
      dockAppIds: row.dockAppIds.filter(id => id !== "xiaohongshu"),
      fixedAppIds: row.fixedAppIds.filter(id => id !== "xiaohongshu"),
      optionalAppIds: row.optionalAppIds.filter(id => id !== "xiaohongshu"),
      topAppIds: row.topAppIds.filter(id => id !== "xiaohongshu"),
      allAppIds: row.allAppIds.filter(id => id !== "xiaohongshu"),
    };
    if (JSON.stringify(next) !== JSON.stringify(row)) {
      manifestCache.set(row.characterId, next);
      await db.manifests.put(next);
    }
  }

  for (const key of ["ai_phone_icon_layout_v2", "ai_phone_icon_layout_v1", "ai_phone_dock_layout_v1", "ai_phone_desktop_folders_v1"]) {
    const raw = kvGet(key);
    if (!raw) continue;
    const next = removeXiaohongshuFromLayoutValue(raw);
    if (next) kvSet(key, next);
  }
  kvSet(CHECKPHONE_STORAGE_CLEANUP_KEY, "1");
}

export function readPhoneManifestCache(characterId: string): CheckPhoneManifest | null {
  return manifestCache.get(characterId) ?? null;
}

export async function loadPhoneManifest(characterId: string): Promise<CheckPhoneManifest | null> {
  const cached = manifestCache.get(characterId);
  if (cached) return cached;
  try {
    const row = await db.manifests.get(characterId);
    if (row) {
      manifestCache.set(characterId, row);
      return row;
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] load manifest error:", error);
  }
  return null;
}

export async function savePhoneManifest(manifest: CheckPhoneManifest): Promise<void> {
  manifestCache.set(manifest.characterId, manifest);
  try {
    await db.manifests.put(manifest);
  } catch (error) {
    console.warn("[CheckPhoneStorage] save manifest error:", error);
  }
}

export async function clearPhoneManifest(characterId: string): Promise<void> {
  manifestCache.delete(characterId);
  try {
    await db.manifests.delete(characterId);
  } catch (error) {
    console.warn("[CheckPhoneStorage] clear manifest error:", error);
  }
}

function snapshotKey(characterId: string, appId: CheckPhoneAppId): string {
  return `${characterId}:${appId}`;
}

export function readPhoneSnapshotCache<AppPayload = unknown>(
  characterId: string,
  appId: CheckPhoneAppId,
): CheckPhoneSnapshot<AppPayload> | null {
  return (snapshotCache.get(snapshotKey(characterId, appId)) as CheckPhoneSnapshot<AppPayload> | undefined) ?? null;
}

export async function loadPhoneSnapshot<AppPayload = unknown>(
  characterId: string,
  appId: CheckPhoneAppId,
): Promise<CheckPhoneSnapshot<AppPayload> | null> {
  const key = snapshotKey(characterId, appId);
  const cached = snapshotCache.get(key);
  if (cached) return cached as CheckPhoneSnapshot<AppPayload>;
  try {
    const row = await db.snapshots.get(key);
    if (row) {
      snapshotCache.set(key, row);
      return row as CheckPhoneSnapshot<AppPayload>;
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] load snapshot error:", error);
  }
  return null;
}

export async function savePhoneSnapshot<AppPayload = unknown>(snapshot: CheckPhoneSnapshot<AppPayload>): Promise<CheckPhoneSnapshot<AppPayload>> {
  const key = snapshotKey(snapshot.characterId, snapshot.appId);
  let previous = snapshotCache.get(key);
  if (!previous) {
    try {
      previous = await db.snapshots.get(key);
    } catch (error) {
      console.warn("[CheckPhoneStorage] load previous snapshot before save error:", error);
    }
  }

  const mergedSnapshot = mergeCheckPhoneSnapshotPayload(previous, snapshot as CheckPhoneSnapshot) as CheckPhoneSnapshot<AppPayload>;
  snapshotCache.set(key, mergedSnapshot as CheckPhoneSnapshot);
  try {
    await db.snapshots.put(mergedSnapshot as CheckPhoneSnapshot);
  } catch (error) {
    console.warn("[CheckPhoneStorage] save snapshot error:", error);
  }
  recordCheckPhoneSnapshotEvent(mergedSnapshot as CheckPhoneSnapshot);
  return mergedSnapshot;
}

export async function clearPhoneSnapshot(characterId: string, appId: CheckPhoneAppId): Promise<void> {
  const key = snapshotKey(characterId, appId);
  snapshotCache.delete(key);
  try {
    await db.snapshots.delete(key);
  } catch (error) {
    console.warn("[CheckPhoneStorage] clear snapshot error:", error);
  }
}

/** 清除某角色查手机（查岗）写入短期记忆的全部记录。 */
export function clearCheckPhoneProjectionEntries(characterId: string): void {
  if (typeof window === "undefined") return;
  kvRemove(projectionStorageKey(characterId));
}

/** 删除某角色查手机记录中的一条。 */
export function removeCheckPhoneProjectionEntry(characterId: string, entryId: string): void {
  if (typeof window === "undefined") return;
  const key = projectionStorageKey(characterId);
  const remaining = loadProjectionEventsByKey(key).filter(entry => entry.id !== entryId);
  if (remaining.length === 0) {
    kvRemove(key);
    return;
  }
  saveProjectionEventsByKey(key, remaining);
}

export function loadCheckPhoneProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): CheckPhoneProjectionEntry[] {
  const entries = loadProjectionEventsByKey(projectionStorageKey(characterId));
  if (!options?.afterTimestamp) return entries;
  return entries.filter(entry => entry.timestamp > options.afterTimestamp!);
}

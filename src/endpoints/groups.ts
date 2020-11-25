import httpStatus from "http-status-codes";
import App, { TContext } from "../app";
import { aquireLock, releaseLock } from "../db";
import { getInstanceKey, TInstance } from "./instances";

/**
 * Purely informative, yet a typesafe DB schema.
 */
export type DBSchema = {
  // DATA

  "instance:GID:ID": TInstance;
  "group:GID": TGroup;
  // timestamp
  last_gc: number;

  // INDEXES (list of IDs)

  "group:GID:instances": string[];
  groups: string[];

  // WRITE LOCKS

  // timestamp
  "mutex:groups": number;
  // timestamp
  "mutex:group:GID": number;
};

export type TGroup = {
  // gid
  group: string;
  // timestamp
  createdAt: number;
  // timestamp
  lastUpdatedAt: number;
};

export type TGetResponse = Array<
  TGroup & {
    // number
    instances: string;
  }
>;
export type TGetGroupResponse = TInstance[];

export default (app: App) => {
  const { router } = app;

  // GET /
  router.get("/", async (ctx) => {
    await disposeExpired(ctx);

    const { db } = ctx.state;
    const gids = await getList(ctx);

    ctx.state.logger.debug(`Listing ${gids.length} groups`);

    const fetchGroups = gids.map(
      // fetch all the groups and count their indexes
      async (gid): Promise<TGetResponse | null> => {
        const groupKey = getGroupKey(gid);
        const indexKey = getGroupIndexKey(gid);
        const [groupJSON, indexJSON] = await Promise.all([
          db.get(groupKey),
          db.get(indexKey),
        ]);
        if (!groupJSON || !indexJSON) {
          return null;
        }
        const group = JSON.parse(groupJSON);
        const index = JSON.parse(indexJSON);

        return { ...group, instances: index.length.toString() };
      }
    );

    const results = await Promise.all(fetchGroups);
    // return non empty results
    ctx.body = results.filter((group) => group);
  });

  // GET /:group
  router.get("/:group", async (ctx) => {
    await disposeExpired(ctx);

    const { db, logger } = ctx.state;
    const gid = ctx.params.group;
    const indexJSON = await db.get(getGroupIndexKey(gid));

    if (!indexJSON) {
      ctx.status = httpStatus.NOT_FOUND;
      logger.info(`Group "${gid}" doesnt exist`);
    } else {
      const ids: string[] = JSON.parse(indexJSON);
      logger.debug(`Fetching ${ids.length} instances`);
      const fetchInstances = ids
        .map((id) => getInstanceKey(gid, id))
        .map((key) => db.get(key));
      const instances = await Promise.all(fetchInstances);
      // no need to parse json here
      ctx.body = `[${instances.join(",")}]`;
      ctx.type = "json";
    }
  });
};

/**
 * Safely adds a new group.
 *
 * Requires an aquired lock for the group `gid`.
 *
 * Alters:
 * - group entry
 * - group index
 * - groups list index
 *
 * @param ctx Context
 * @param gid Group ID
 * @param id Instance ID
 */
export async function addGroup(ctx: TContext, gid: string, id: string) {
  const { db, logger } = ctx.state;
  const key = getGroupKey(gid);
  const indexKey = getGroupIndexKey(gid);
  const group = {
    group: gid,
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
  const index = [id];

  logger.info(`Adding group "${gid}"`);

  // aquire the write lock
  await aquireListIndexLock(ctx);

  await Promise.all([
    // save the group
    db.set(key, JSON.stringify(group)),
    // save the index
    db.set(indexKey, JSON.stringify(index)),
    // update the groups list
    alterListIndex(ctx, [gid]),
  ]);

  // release the write lock
  await releaseListIndexLock(ctx);
}

/**
 * Safely removes a group.
 *
 * Requires an aquired lock for the group `gid`.
 */
export async function removeGroup(ctx: TContext, gid: string) {
  const { db, logger } = ctx.state;
  const key = getGroupKey(gid);
  const indexKey = getGroupIndexKey(gid);

  logger.info(`Removing group "${gid}"`);

  // aquire the write lock
  await aquireListIndexLock(ctx);

  await Promise.all([
    // remove the group
    db.del(key),
    // remove the index
    db.del(indexKey),
    // update the groups list
    alterListIndex(ctx, null, [gid]),
  ]);

  // release the write lock
  await releaseListIndexLock(ctx);
}

/**
 * Modifies the list of all the groups.
 *
 * Requires an aquired lock for the list of all the groups.
 *
 * @param ctx Context
 * @param add GIDs to add
 * @param remove GIDs to remove
 */
export async function alterListIndex(
  ctx: TContext,
  add: string[] | null,
  remove?: string[] | null
) {
  const { db } = ctx.state;
  const key = listIndexKey();
  // fetch the current index
  let gids = await getList(ctx);

  // alter an existing index
  if (gids.length) {
    if (add?.length) {
      gids.push(...add);
    }
    if (remove?.length) {
      gids = gids.filter((gid) => !remove.includes(gid));
    }
  }
  // create a new index
  else if (add?.length) {
    // copy
    gids = [...add];
    // new index
    await db.set(key, JSON.stringify(add));
  }

  // save
  await db.set(key, JSON.stringify(gids));
}

/**
 * GCs expired instances and empty groups.
 *
 * Uses its own logic for removal to:
 * - batch the requests
 * - custom lock handling
 *
 * TODO global GC lock
 */
async function disposeExpired(ctx: TContext) {
  const { state } = ctx;
  const { config, db, logger } = state;

  if (!(await shouldGC(ctx))) {
    return;
  }

  logger.info("GC start");
  // @ts-ignore TODO types
  const app = ctx.app as App;
  app.gcCounter++;

  const now = Date.now();
  const gidsToRemove: string[] = [];
  // update the timestamp again
  await db.set("last_gc", Date.now());
  // aquire the write lock
  await aquireListIndexLock(ctx);

  // get all the GIDs
  const gids = await getList(ctx);
  await Promise.all(
    // for every group
    gids.map(async (gid) => {
      const indexKey = getGroupIndexKey(gid);
      // get the group's lock
      await aquireGroupLock(ctx, gid);
      // fetch IDs from a group index
      let ids: string[] = JSON.parse((await db.get(indexKey)) || "[]");
      await Promise.all(
        // for every instance
        ids.map(async (id) => {
          const key = getInstanceKey(gid, id);
          const instance: TInstance = JSON.parse((await db.get(key)) || "null");
          // check the timeout
          if (!instance || instance.updatedAt + config.instanceTimeout > now) {
            // alive
            return;
          }
          logger.info(`Removing instance "${id}" in group "${gid}"`);
          // remove from the DB
          await db.del(key);
          // remove from the local index
          ids = ids.filter((item) => item != id);
        })
      );
      // mark the group for removal
      if (!ids.length) {
        logger.info(`Removing group "${gid}"`);
        gidsToRemove.push(gid);
      }
      // update the group's index
      else {
        logger.info(`Updating group "${gid}"`);
        await db.set(indexKey, JSON.stringify(ids));
      }
    })
  );

  // remove empty groups and update the list index
  if (gidsToRemove.length) {
    const tasks = [
      ...gidsToRemove.map((gid) => db.del(getGroupKey(gid))),
      ...gidsToRemove.map((gid) => db.del(getGroupIndexKey(gid))),
      alterListIndex(ctx, null, gidsToRemove),
    ];
    // TODO type error (promises with mixed results)
    // @ts-ignore
    await Promise.all(tasks);
  }

  // update the timestamp again
  await db.set("last_gc", Date.now());
  state.lastInstancesDispose = Date.now();

  // release all the locks
  await Promise.all([
    releaseListIndexLock(ctx),
    ...gids.map((gid) => releaseGroupLock(ctx, gid)),
  ]);

  logger.info("GC end");
}

async function shouldGC(ctx: TContext): Promise<boolean> {
  const { state } = ctx;
  const { config, db } = state;
  const now = Date.now();

  // check against the local last GC time
  if (state.lastInstancesDispose + config.gcInterval > now) {
    return false;
  }

  // sync the local GC time
  const lastGC = parseInt((await db.get("last_gc")) || "0", 10);

  state.lastInstancesDispose = lastGC;
  if (state.lastInstancesDispose + config.gcInterval > now) {
    return false;
  }

  return true;
}

/**
 * Get a DB key of the group `gid`.
 *
 * @param gid Group ID
 */
export function getGroupKey(gid: string): string {
  return "group:" + gid;
}

/**
 * Get a DB key of the index for the group `gid`.
 *
 * @param gid Group ID
 */
export function getGroupIndexKey(gid: string): string {
  return `group:${gid}:instances`;
}

/**
 * Get a DB key of the index for the list of all the groups.
 */
export function listIndexKey(): string {
  return `groups`;
}

// MUTEXES

/**
 * Aquires a write lock for the list of all the groups.
 */
export async function aquireListIndexLock(ctx: TContext) {
  await aquireLock(ctx, listIndexKey());
  ctx.state.logger.debug(`List index lock aquired`);
}

/**
 * Releases a write lock for the list of all the groups.
 */
export async function releaseListIndexLock(ctx: TContext) {
  await releaseLock(ctx, listIndexKey());
  ctx.state.logger.debug(`List index lock released`);
}

/**
 * Aquires a write lock for the group GID.
 */
export async function aquireGroupLock(ctx: TContext, gid: string) {
  await aquireLock(ctx, getGroupIndexKey(gid));
  ctx.state.logger.debug(`Group lock "${gid}" aquired`);
}

/**
 * Releases a write lock for the group GID.
 */
export async function releaseGroupLock(ctx: TContext, gid: string) {
  await releaseLock(ctx, getGroupIndexKey(gid));
  ctx.state.logger.debug(`Group lock "${gid}" release`);
}

/**
 * Get a list of all registered groups (as GIDs)
 *
 * @param ctx Context
 */
export async function getList(ctx: TContext): Promise<string[]> {
  const { db } = ctx.state;

  const gidsJSON = (await db.get(listIndexKey())) || "[]";
  return JSON.parse(gidsJSON);
}

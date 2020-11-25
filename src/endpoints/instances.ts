import httpStatus from "http-status-codes";
import koaBody from "koa-body";
import App, { TContext } from "../app";
import {
  addGroup,
  aquireGroupLock,
  getGroupIndexKey,
  getGroupKey,
  releaseGroupLock,
  removeGroup,
  TGroup
} from "./groups";

export type TInstance = {
  id: string;
  // gid
  group: string;
  // timestamp
  createdAt: number;
  // timestamp
  updatedAt: number;
  meta: object;
};

export type TPostRequest = object;
export type TPostResponse = TInstance;

export default (app: App) => {
  const { router } = app;

  // POST /:group/:id
  router.post("/:group/:id", koaBody(), async (ctx) => {
    const { group: gid, id } = ctx.params;
    const { db } = ctx.state;
    // TODO missing type from koa-body
    // @ts-ignore
    const payload = ctx.request.body as TPostRequest;
    const key = getInstanceKey(gid, id);
    const groupKey = getGroupKey(gid);

    await aquireGroupLock(ctx, gid);
    const [groupJSON, instanceJSON] = await Promise.all([
      db.get(groupKey),
      db.get(key),
    ]);

    const tasks: Promise<any>[] = [];

    // create or update the instance
    let instance: TInstance;
    if (!instanceJSON) {
      tasks.push(addInstance(ctx, gid, id, payload));
    } else {
      instance = JSON.parse(instanceJSON);
      instance.updatedAt = Date.now();
      tasks.push(db.set(key, JSON.stringify(instance)));
    }

    let group: TGroup;
    // create a new group
    if (!groupJSON) {
      tasks.push(addGroup(ctx, gid, id));
    }
    // update the group's timestamp
    else {
      group = JSON.parse(groupJSON);
      group.lastUpdatedAt = Date.now();
      tasks.push(db.set(groupKey, JSON.stringify(group)));
    }

    // save
    await Promise.all(tasks);
    await releaseGroupLock(ctx, gid);

    // echo the payload
    ctx.body = payload;
  });

  // DELETE /:group/:id
  router.delete("/:group/:id", async (ctx) => {
    const { group: gid, id } = ctx.params;
    const { db } = ctx.state;

    const exists = await db.exists(getGroupKey(gid));

    if (!exists) {
      ctx.status = httpStatus.NOT_FOUND;
    } else {
      await removeInstance(ctx, gid, id);
      ctx.status = httpStatus.NO_CONTENT;
    }
  });
};

/**
 * Adds a new instance.
 *
 * Requires an aquired lock for the group `gid`.
 *
 * Alters:
 * - instance entry
 * - group index
 *
 * Will NOT update he group object.
 *
 * @param ctx Context
 * @param id Instance ID
 * @param gid Group ID
 */
export async function addInstance(
  ctx: TContext,
  gid: string,
  id: string,
  payload: object
) {
  const { db, logger } = ctx.state;
  const key = getInstanceKey(gid, id);
  const now = Date.now();
  let ids: string[];
  const instance: TInstance = {
    id,
    group: gid,
    createdAt: now,
    updatedAt: now,
    meta: payload,
  };

  logger.info(`Adding instance "${id}" in group "${gid}"`);

  // update the index
  const indexKey = getGroupIndexKey(gid);
  const indexJSON = await db.get(indexKey);
  if (indexJSON) {
    // append the new ID to an existing index
    ids = JSON.parse(indexJSON);
    ids.push(id);
  } else {
    // new index
    ids = [id];
  }

  // save
  await Promise.all([
    db.set(key, JSON.stringify(instance)),
    db.set(indexKey, JSON.stringify(ids)),
  ]);
}

/**
 * Removes an instance.
 *
 * Requires an aquired lock for the group `gid`.
 *
 * Alters:
 * - instance entry
 * - group index
 * - group entry (if the last instance)
 * - groups list index (if the last instance)
 *
 * Will remove the group if the last instance.
 *
 * @param ctx Context
 * @param id Instance ID
 * @param gid Group ID
 */
export async function removeInstance(ctx: TContext, gid: string, id: string) {
  const { db, logger } = ctx.state;
  const key = getInstanceKey(gid, id);

  logger.info(`Removing instance "${id}" in group "${gid}"`);

  // delete the instance
  const tasks: Promise<any>[] = [db.del(key)];

  // update the index
  const indexKey = getGroupIndexKey(gid);
  const indexJSON = await db.get(indexKey);
  if (indexJSON) {
    // remove the ID from an existing index
    let ids: string[] = JSON.parse(indexJSON);
    ids = ids.filter((item) => item != id);
    if (!ids.length) {
      tasks.push(removeGroup(ctx, gid));
    }
  }

  // save
  await Promise.all(tasks);
}

/**
 * Get a DB key of the instance `id` in the group `gid`.
 *
 * @param gid Group ID
 * @param id Instance ID
 */
export function getInstanceKey(gid: string, id: string): string {
  return `instance:${gid}:${id}`;
}

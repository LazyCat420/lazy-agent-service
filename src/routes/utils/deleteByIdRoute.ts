import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import type { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import logger from "../../utils/logger.ts";

interface NamedDocument {
  name?: string;
}

export interface DeleteByIdRouteOptions {
  /** Mongo collection name. */
  collection: string;
  /** 404 body message, e.g. "Rule not found". */
  notFoundError: string;
  /** Log prefix, e.g. "Rule". */
  logLabel: string;
}

/**
 * Shared `DELETE /:id` handler for the rule and skill collections: both answer
 * `{ success: true }`, both 404 with their own label, both log the deleted name.
 */
export function createDeleteByIdHandler(options: DeleteByIdRouteOptions) {
  const { collection, notFoundError, logLabel } = options;

  return asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { db } = req;

        const result = await db
          .collection<NamedDocument>(collection)
          .findOneAndDelete({ _id: new ObjectId(req.params.id as string) });

        if (!result) {
          return res.status(404).json({ error: notFoundError });
        }

        logger.info(`${logLabel} deleted: ${result.name} (${req.params.id})`);
        res.json({ success: true });
      } catch (error: unknown) {
        next(error);
      }
    },
  );
}

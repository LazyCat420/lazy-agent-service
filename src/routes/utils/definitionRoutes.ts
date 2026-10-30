import { Router, type Request, type Response } from "express";
import type { DefinitionBase } from "../../services/orchestrator/definitionRegistry.ts";

/**
 * Shared list/get router for the taxonomy-backed definition registries
 * (multi-agent topologies, thought structures). Each registry supplies its
 * own definition table, id lookup, route param name and error label.
 */
export interface DefinitionRouterOptions<TDefinition extends DefinitionBase> {
  definitions: readonly TDefinition[];
  getById: (id: string) => TDefinition | undefined;
  /** Express route param holding the definition id, e.g. "topologyId". */
  paramName: string;
  /** Label used in the 400 and 404 error bodies, e.g. "Topology". */
  label: string;
}

export function createDefinitionRouter<TDefinition extends DefinitionBase>(
  options: DefinitionRouterOptions<TDefinition>,
): Router {
  const { definitions, getById, paramName, label } = options;
  const router: Router = Router();

  router.get("/", (_request: Request, response: Response) => {
    response.json(definitions);
  });

  router.get(`/:${paramName}`, (request: Request, response: Response) => {
    const definitionId = request.params[paramName];
    if (typeof definitionId !== "string" || !definitionId) {
      return response.status(400).json({ error: `${paramName} is required` });
    }

    const definition = getById(definitionId);
    if (!definition) {
      return response
        .status(404)
        .json({ error: `${label} "${definitionId}" not found` });
    }

    response.json(definition);
  });

  return router;
}

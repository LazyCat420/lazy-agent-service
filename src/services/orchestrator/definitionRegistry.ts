// ─────────────────────────────────────────────────────────────
// definitionRegistry — generic builder shared by the taxonomy-backed
// metadata registries (multi-agent topologies, thought structures).
//
// Each registry supplies its own definition table; this module owns the
// common definition shape, the id-uniqueness validation and the id lookup
// so the registries only differ by their taxonomy constant and data.
// ─────────────────────────────────────────────────────────────

export interface DefinitionAlignmentEntry {
  component: string;
  status: "aligned" | "simplified" | "extended";
  detail: string;
}

export interface DefinitionConfigOption {
  name: string;
  type: "number" | "string" | "boolean";
  defaultValue: string;
  description: string;
}

export interface DefinitionBase {
  id: string;
  displayName: string;
  abbreviation: string;
  description: string;
  paperTitle: string | null;
  paperAuthors: string | null;
  paperYear: number | null;
  paperUrl: string | null;
  implementationFile: string;
  categoryLabel: string;
  phases: string[];
  configOptions: DefinitionConfigOption[];
  alignment: DefinitionAlignmentEntry[];
  flowDescription: string;
}

export interface DefinitionRegistry<TDefinition extends DefinitionBase> {
  /** The supplied definition table, in declaration order. */
  readonly definitions: TDefinition[];
  /** Id → definition lookup built once at construction. */
  readonly byId: ReadonlyMap<string, TDefinition>;
  getById(id: string): TDefinition | undefined;
}

/**
 * Build a definition registry from a taxonomy-backed table.
 *
 * Throws at construction when two definitions share an id, so a taxonomy
 * drift surfaces immediately instead of silently shadowing an entry.
 */
export function createDefinitionRegistry<TDefinition extends DefinitionBase>(
  definitions: TDefinition[],
): DefinitionRegistry<TDefinition> {
  const byId = new Map<string, TDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate definition id "${definition.id}" in definition registry`);
    }
    byId.set(definition.id, definition);
  }
  return {
    definitions,
    byId,
    getById: (id: string) => byId.get(id),
  };
}

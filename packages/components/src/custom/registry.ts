import { type ComponentDefinition, defineComponent } from "../define.js";
import { BUILT_IN_COMPONENTS, builtInRegistry, createComponentRegistry } from "../registry.js";
import { compileComponentProgram } from "./compile.js";

/** The data needed to compile a pinned project component in a renderer. */
export type RenderComponentDefinition = Pick<
  ComponentDefinition,
  "id" | "version" | "title" | "description" | "props"
> & { program: string };

export function createProjectComponentRegistry(definitions: readonly RenderComponentDefinition[]) {
  if (definitions.length === 0) return builtInRegistry;
  return createComponentRegistry([
    ...BUILT_IN_COMPONENTS,
    ...definitions.map(({ program, ...definition }) =>
      defineComponent({
        ...definition,
        evaluate: compileComponentProgram(program, definition.props),
      }),
    ),
  ]);
}
